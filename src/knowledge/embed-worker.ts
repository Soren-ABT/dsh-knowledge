/**
 * Local model inference process — Cherry Studio's isolated-runtime model:
 * transformers.js / onnxruntime run off the main process, so the ~600MB
 * embedding model (and any local reranker) plus every inference intermediate
 * tensor lives outside the host process and can never freeze it.
 *
 * Wire protocol (versioned IPC over a worker port or child-process IPC):
 *   main → process: { protocolVersion, id, operation, modelId, cacheDir, ... }
 *   process → main: { protocolVersion, id, operation, ok, vectors? | error }
 *                    { type: 'progress', modelId, status, progress, message }
 *
 * Inference is serialized inside the process (Cherry's inference queue has
 * concurrency 1 for the same reason: transformers.js gives no concurrency
 * guarantee for parallel runs on one pipeline instance).
 * @module dsh-knowledge/knowledge/embed-process
 */

import { parentPort } from 'node:worker_threads'
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { applyGlobalProxy, NETWORK_HINT } from './net.js'
import {
  LOCAL_EMBED_PROTOCOL_VERSION,
  isLocalEmbedRequest,
  type LocalEmbedRequest,
  type LocalEmbedOperation,
} from './embed-protocol.js'

// The child has its own global dispatcher, so route model downloads through
// the system proxy here.
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
  if (parentPort !== null) parentPort.postMessage(message)
  else process.send?.(message)
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
    const root = join(cacheDir, modelId)
    const [config, entries, tokenizer] = await Promise.all([
      stat(join(root, 'config.json')),
      readdir(join(root, 'onnx')),
      Promise.any([
        stat(join(root, 'tokenizer.json')),
        stat(join(root, 'tokenizer_config.json')),
        stat(join(root, 'vocab.txt')),
        stat(join(root, 'spiece.model')),
      ]),
    ])
    if (config.size <= 0 || tokenizer.size <= 0) return false
    for (const name of entries) {
      if (name.endsWith('.onnx') && (await stat(join(root, 'onnx', name))).size > 0) return true
    }
    return false
  } catch {
    return false
  }
}

async function createRunner(
  task: ModelTask,
  modelId: string,
  cacheDir: string,
  hfEndpoint: string | undefined,
  forceDownload = false,
): Promise<Runner> {
  let loadStartedAt = Date.now()
  post({ type: 'progress', modelId, status: 'idle', progress: 0, message: '', runtimeState: 'loading', loadStartedAt })
  const tf = await loadTransformers()
  applyEndpoint(tf, hfEndpoint)
  tf.env.cacheDir = cacheDir

  // Throttle progress messages: transformers.js can fire per-chunk callbacks
  // for large model files; flooding the main process with postMessage during
  // a 585MB download would starve its HTTP/UI work.
  let lastProgressAt = 0

  // 1. Download through the repo id (progress reported); discard the pipeline
  //    so it does not pin ~600MB — inference reloads from disk below.
  if (forceDownload || !(await isDownloaded(modelId, cacheDir))) {
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
        const downloadedModel = await tf.AutoModel.from_pretrained(modelId, { dtype: 'q8', progress_callback: progressCallback })
        try { await tf.AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCallback }) }
        finally { await downloadedModel.dispose?.() }
      } else {
        const downloadedPipeline = await tf.pipeline(task, modelId, {
          dtype: 'q8',
          progress_callback: progressCallback,
        })
        await downloadedPipeline.dispose?.()
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
  //    touches the network. `ready` is emitted only after this load succeeds.
  loadStartedAt = Date.now()
  post({ type: 'progress', modelId, status: 'idle', progress: 0, message: '', runtimeState: 'loading', loadStartedAt })
  if (task === 'reranking') {
    const model = await tf.AutoModel.from_pretrained(join(cacheDir, modelId), { dtype: 'q8' })
    const tokenizer = await tf.AutoTokenizer.from_pretrained(join(cacheDir, modelId))
    post({ type: 'progress', modelId, status: 'ready', progress: 100, message: '', runtimeState: 'loaded', loadStartedAt, loadDurationMs: Date.now() - loadStartedAt })
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
          const inputs = await tokenizer(batch.map(() => query), {
            text_pair: batch,
            padding: true,
            truncation: true,
          })
          const outputs = await model(inputs)
          const logits = outputs.logits
          if (logits === undefined || logits.data === undefined) {
            throw new Error('rerank model returned no logits')
          }
          if (logits.data.length !== batch.length || (logits.dims !== undefined && logits.dims.at(-1) !== 1)) {
            throw new Error(`rerank model must return one logit per pair (expected ${batch.length}, received ${logits.data.length})`)
          }
          for (let j = 0; j < batch.length; j += 1) {
            const logit = Number(logits.data[j])
            if (!Number.isFinite(logit)) throw new Error('rerank model returned a non-finite logit')
            scores.push(sigmoid(logit))
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
  post({ type: 'progress', modelId, status: 'ready', progress: 100, message: '', runtimeState: 'loaded', loadStartedAt, loadDurationMs: Date.now() - loadStartedAt })
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

function getRunner(task: ModelTask, modelId: string, cacheDir: string, hfEndpoint: string | undefined, forceDownload = false): Promise<Runner> {
  const key = `${task}:${modelId}`
  const cached = runners.get(key)
  if (cached !== undefined) return cached
  const pending = createRunner(task, modelId, cacheDir, hfEndpoint, forceDownload)
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

function handleMessage(message: unknown): void {
  if (!isLocalEmbedRequest(message)) return
  const { id, operation, modelId, cacheDir, hfEndpoint } = message
  void enqueueOperation(async () => {
    if (operation === 'shutdown') {
      await disposeAllRunners()
      return { protocolVersion: LOCAL_EMBED_PROTOCOL_VERSION, id, operation, ok: true as const }
    }
    if (operation === 'release') {
      await disposeRunnersFor(modelId)
      return { protocolVersion: LOCAL_EMBED_PROTOCOL_VERSION, id, operation, ok: true as const }
    }
    // `download` intentionally follows the same load path: transformers.js
    // downloads missing artifacts and then verifies that the local pipeline
    // can actually be opened before the manager marks it ready.
    const runner = await getRunner('feature-extraction', modelId, cacheDir, hfEndpoint, operation === 'download')
    if (operation === 'download' || operation === 'load') {
      return { protocolVersion: LOCAL_EMBED_PROTOCOL_VERSION, id, operation, ok: true as const }
    }
    const vectors = await runner.embed!(message.texts ?? [], message.pooling ?? 'mean')
    return { protocolVersion: LOCAL_EMBED_PROTOCOL_VERSION, id, operation, ok: true as const, vectors }
  })
    .then(response => {
      post(response)
      if (operation === 'shutdown') setImmediate(() => process.exit(0))
    })
    .catch((error: unknown) => {
      post({
        protocolVersion: LOCAL_EMBED_PROTOCOL_VERSION,
        id,
        operation: operation as LocalEmbedOperation,
        ok: false as const,
        error: {
          code: 'runtime_error' as const,
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      })
    })
}

if (parentPort !== null) parentPort.on('message', handleMessage)
else process.on('message', handleMessage)
