/**
 * Local model inference worker — Cherry Studio's "in its own worker" model:
 * transformers.js / onnxruntime run off the main process, so the ~600MB
 * embedding model (and any local reranker) plus every inference intermediate
 * tensor lives in this worker's heap and can never freeze the host process.
 *
 * Wire protocol (JSON messages over parentPort):
 *   main → worker:  { id, type: 'embed'|'load'|'rerank', modelId, cacheDir, hfEndpoint?, texts?, query?, pooling?, task? }
 *                    { type: 'cancel'|'release', modelId }
 *                    { type: 'shutdown' }
 *   worker → main:  { id, ok: true, vectors? | scores? } | { id, ok: false, error }
 *                    { type: 'progress', modelId, status, progress, message }
 *
 * Inference is serialized inside the worker (Cherry's inference queue has
 * concurrency 1 for the same reason: transformers.js gives no concurrency
 * guarantee for parallel runs on one pipeline instance).
 * @module dsh-knowledge/knowledge/embed-worker
 */

import { parentPort } from 'node:worker_threads'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { applyGlobalProxy, NETWORK_HINT } from './net.js'

// The worker is a fresh thread: the main process's global undici dispatcher
// does not carry over, so route model downloads through the system proxy here.
applyGlobalProxy()

interface TransformersModule {
  env: { allowLocalModels: boolean; cacheDir?: string; remoteHost?: string }
  pipeline(
    task: string,
    modelId: string,
    options?: Record<string, unknown>,
  ): Promise<
    | (((text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>) & { dispose?(): Promise<void> })
    | (((query: string, texts: string[], options?: Record<string, unknown>) => Promise<Array<{ score: number }>>) & { dispose?(): Promise<void> })
  >
  AutoModel: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<{
      (inputs: Record<string, unknown>): Promise<{ logits?: { data?: ArrayLike<number>; dims?: number[] } }>
      dispose?(): Promise<void>
    }>
  }
  AutoTokenizer: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<
      (texts: unknown, options?: Record<string, unknown>) => Promise<Record<string, unknown>>
    >
  }
}

/** bge-reranker scores = sigmoid(logits); the reference pipeline does the same. */
function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

interface EmbedRequest {
  id: number
  type: 'embed' | 'load' | 'rerank'
  modelId: string
  cacheDir: string
  hfEndpoint?: string
  texts?: string[]
  query?: string
  pooling?: 'last_token' | 'cls' | 'mean'
  task?: ModelTask
}

type WorkerMessage = EmbedRequest
  | { type: 'cancel'; modelId: string }
  | { type: 'release'; modelId: string }
  | { type: 'release-models' }
  | { type: 'shutdown' }

type Pooling = 'last_token' | 'cls' | 'mean'
type ModelTask = 'feature-extraction' | 'reranking'

interface Runner {
  /** Embedding runner (feature-extraction tasks). */
  embed?: (texts: string[], pooling: Pooling) => Promise<number[][]>
  /** Cross-encoder relevance scoring (reranking tasks). */
  rerank?: (query: string, texts: string[]) => Promise<number[]>
  /** Release the ONNX sessions this runner holds (frees ~600MB native memory
   *  immediately). The worker itself stays alive, so the onnxruntime binding
   *  is never dlopen'ed twice in one process — the Linux respawn failure
   *  ("Module did not self-register") cannot happen. */
  dispose?(): Promise<void>
}

let transformers: TransformersModule | null = null
/** Task-qualified runners: `${task}:${modelId}` → promise. */
const runners = new Map<string, Promise<Runner>>()
const cancelledModels = new Set<string>()
let operationChain: Promise<unknown> = Promise.resolve()

/** Serialize model loads, inference, and disposal. In particular, a request
 *  posted immediately after `release-models` must not create a new runner
 *  while the old runner's asynchronous `dispose()` is still in flight. */
function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationChain.then(operation)
  operationChain = run.then(() => undefined, () => undefined)
  return run
}

function post(message: unknown): void {
  parentPort?.postMessage(message)
}

async function loadTransformers(): Promise<TransformersModule> {
  if (transformers !== null) return transformers
  transformers = (await import('@huggingface/transformers')) as unknown as TransformersModule
  return transformers
}

function applyEndpoint(tf: TransformersModule, hfEndpoint: string | undefined): void {
  if (hfEndpoint !== undefined && hfEndpoint.trim() !== '') {
    tf.env.remoteHost = hfEndpoint.trim().replace(/\/+$/, '')
  }
}

async function isDownloaded(modelId: string, cacheDir: string): Promise<boolean> {
  try {
    const entries = await readdir(join(cacheDir, modelId, 'onnx'))
    return entries.some(name => name.endsWith('.onnx'))
  } catch {
    return false
  }
}

async function createRunner(
  task: ModelTask,
  modelId: string,
  cacheDir: string,
  hfEndpoint: string | undefined,
): Promise<Runner> {
  const tf = await loadTransformers()
  applyEndpoint(tf, hfEndpoint)
  tf.env.cacheDir = cacheDir

  // Throttle progress messages: transformers.js can fire per-chunk callbacks
  // for large model files; flooding the main process with postMessage during
  // a 585MB download would starve its HTTP/UI work.
  let lastProgressAt = 0

  // 1. Download through the repo id (progress reported); discard the pipeline
  //    so it does not pin ~600MB — inference reloads from disk below.
  if (!(await isDownloaded(modelId, cacheDir))) {
    post({ type: 'progress', modelId, status: 'downloading', progress: 0, message: '' })
    const progressCallback = (info: { status?: string; progress?: number }): void => {
      // Cancellation is checked on EVERY callback (never throttled) so
      // an abort interrupts the download promptly.
      if (cancelledModels.has(modelId)) throw new Error('download cancelled')
      if (info.status === 'progress' && typeof info.progress === 'number') {
        const now = Date.now()
        if (now - lastProgressAt >= 250) {
          lastProgressAt = now
          post({ type: 'progress', modelId, status: 'downloading', progress: info.progress, message: '' })
        }
      }
    }
    try {
      if (task === 'reranking') {
        // transformers.js < v4 has no `reranking` pipeline (3.7.0 throws
        // "Unsupported pipeline"). Download through the primitive loaders
        // instead — AutoModel/AutoTokenizer exist in every version — then
        // run the cross-encoder manually below.
        await tf.AutoModel.from_pretrained(modelId, { dtype: 'q8', progress_callback: progressCallback })
        await tf.AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCallback })
      } else {
        await tf.pipeline(task, modelId, {
          dtype: 'q8',
          progress_callback: progressCallback,
        })
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const cancelled = cancelledModels.has(modelId)
      post({
        type: 'progress',
        modelId,
        status: cancelled ? 'idle' : 'error',
        progress: 0,
        message: cancelled ? '' : `${raw} · ${NETWORK_HINT}`,
      })
      // Acknowledge a cancellation only once the download has actually
      // aborted (file handles released), so the main process can remove the
      // half-written weights without a Windows lock and without leaving a
      // corrupt directory that `isDownloaded` would mistake for a real model.
      if (cancelled) post({ type: 'cancelled', modelId })
      throw error
    }
  }

  // 2. Load from the absolute cache directory: an absolute path is not a valid
  //    HF repo id, so transformers.js treats it as a local model and never
  //    touches the network.
  post({ type: 'progress', modelId, status: 'ready', progress: 100, message: '' })
  if (task === 'reranking') {
    const model = await tf.AutoModel.from_pretrained(join(cacheDir, modelId), { dtype: 'q8' })
    const tokenizer = await tf.AutoTokenizer.from_pretrained(join(cacheDir, modelId))
    return {
      // Cross-encoder relevance scoring, hand-rolled for transformers.js
      // versions without the `reranking` pipeline: tokenize [query, doc]
      // pairs, run the model, sigmoid the logits (the reference pipeline's
      // exact math). Batched so a large pool never allocates one giant tensor.
      rerank: async (query: string, texts: string[]): Promise<number[]> => {
        if (texts.length === 0) return []
        const scores: number[] = []
        const BATCH = 16
        for (let i = 0; i < texts.length; i += BATCH) {
          const batch = texts.slice(i, i + BATCH)
          const inputs = await tokenizer(batch.map(doc => [query, doc]), { padding: true, truncation: true })
          const outputs = await model(inputs)
          const logits = outputs.logits
          if (logits === undefined || logits.data === undefined) {
            throw new Error('rerank model returned no logits')
          }
          for (let j = 0; j < batch.length; j += 1) {
            scores.push(sigmoid(logits.data[j] ?? 0))
          }
        }
        return scores
      },
      // Free the cross-encoder's ONNX sessions (onnxruntime native memory);
      // the worker itself stays alive, so the binding is never reloaded.
      dispose: async (): Promise<void> => { await model.dispose?.() },
    }
  }
  const pipeline = await tf.pipeline(task, join(cacheDir, modelId), { dtype: 'q8' }) as
    | (((text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>) & { dispose?(): Promise<void> })
    | (((query: string, texts: string[], options?: Record<string, unknown>) => Promise<Array<{ score: number }>>) & { dispose?(): Promise<void> })
  const embed = pipeline as (text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>
  return {
    embed: async (texts: string[], pooling: Pooling): Promise<number[][]> => {
      const output = await embed(texts, { pooling, normalize: true })
      return output.tolist() as number[][]
    },
    // Free the pipeline's ONNX sessions (~600MB native memory) immediately;
    // the worker stays alive, so a later request just reloads from disk.
    dispose: async (): Promise<void> => { await pipeline.dispose?.() },
  }
}

function getRunner(task: ModelTask, modelId: string, cacheDir: string, hfEndpoint: string | undefined): Promise<Runner> {
  const key = `${task}:${modelId}`
  const cached = runners.get(key)
  if (cached !== undefined) return cached
  const pending = createRunner(task, modelId, cacheDir, hfEndpoint)
  runners.set(key, pending)
  // A failed load (network down, cancelled download, corrupt cache) must not
  // poison the map: drop it so the next request retries instead of reusing a
  // rejected promise forever.
  pending.catch(() => {
    if (runners.get(key) === pending) runners.delete(key)
  })
  return pending
}

/** Dispose every loaded runner: pipeline.dispose() frees the ONNX sessions
 *  (onnxruntime native memory) immediately, and dropping the map lets the JS
 *  side be collected. The worker stays alive — never dlopen the binding again.
 *  (No forced GC: --expose-gc is not allowed in worker execArgv; V8's natural
 *  heap-pressure major GC reclaims the JS-side model objects after a few
 *  unload/reload cycles — verified under stress.) */
async function disposeAllRunners(): Promise<void> {
  const pending = [...runners.values()]
  runners.clear()
  cancelledModels.clear()
  for (const runner of pending) {
    try {
      await runner.then(r => r.dispose?.())
    } catch {
      // A failed dispose leaks memory but must never wedge the worker.
    }
  }
}

/** Dispose only the runners of one model (file-lock-safe deletion path). */
async function disposeRunnersFor(modelId: string): Promise<void> {
  const keys = [`feature-extraction:${modelId}`, `reranking:${modelId}`]
  const pending = keys
    .map(key => runners.get(key))
    .filter((p): p is Promise<Runner> => p !== undefined)
  for (const key of keys) runners.delete(key)
  cancelledModels.delete(modelId)
  for (const runner of pending) {
    try {
      await runner.then(r => r.dispose?.())
    } catch {
      // A failed dispose leaks memory but must never wedge the worker.
    }
  }
}

parentPort?.on('message', (message: WorkerMessage): void => {
  if (message.type === 'shutdown') {
    process.exit(0)
    return
  }
  if (message.type === 'cancel') {
    // Interrupt an in-flight download (its progress callback throws); a
    // loaded runner stays usable until the files are removed. The marker
    // auto-expires so a later re-download of the same model is not blocked
    // forever by the old cancellation.
    cancelledModels.add(message.modelId)
    setTimeout(() => {
      cancelledModels.delete(message.modelId)
    }, 30_000).unref?.()
    return
  }
  if (message.type === 'release-models') {
    // Idle release: unload the loaded MODELS (frees ~600MB), keep the worker
    // alive. A respawn would re-dlopen onnxruntime's native binding, which on
    // Linux fails with "Module did not self-register" — so the worker is
    // never terminated on idle; the next request reloads from disk (~1s).
    void enqueueOperation(disposeAllRunners)
      .finally(() => post({ type: 'released', modelId: '' }))
    return
  }
  if (message.type === 'release') {
    // Drop the loaded runner so the ~600MB model can be garbage-collected,
    // then ack so the main process can delete the files without hitting a
    // file lock (onnxruntime may still hold handles until the runner is
    // released and collected).
    void enqueueOperation(() => disposeRunnersFor(message.modelId))
      .finally(() => post({ type: 'released', modelId: message.modelId }))
    return
  }
  const { id, type, modelId, cacheDir, hfEndpoint } = message
  const task = message.task ?? 'feature-extraction'
  void enqueueOperation(async () => {
    const runner = await getRunner(task, modelId, cacheDir, hfEndpoint)
    if (type === 'load') {
      return { id, ok: true }
    }
    if (type === 'rerank') {
      return { id, ok: true, scores: await runner.rerank!(message.query ?? '', message.texts ?? []) }
    }
    return { id, ok: true, vectors: await runner.embed!(message.texts ?? [], message.pooling ?? 'mean') }
  })
    .then(post)
    .catch((error: unknown) => {
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    })
})
