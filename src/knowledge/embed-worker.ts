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
    | ((text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>)
    | ((query: string, texts: string[], options?: Record<string, unknown>) => Promise<Array<{ score: number }>>)
  >
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
  | { type: 'shutdown' }

type Pooling = 'last_token' | 'cls' | 'mean'
type ModelTask = 'feature-extraction' | 'reranking'

interface Runner {
  /** Embedding runner (feature-extraction tasks). */
  embed?: (texts: string[], pooling: Pooling) => Promise<number[][]>
  /** Cross-encoder relevance scoring (reranking tasks). */
  rerank?: (query: string, texts: string[]) => Promise<number[]>
}

let transformers: TransformersModule | null = null
/** Task-qualified runners: `${task}:${modelId}` → promise. */
const runners = new Map<string, Promise<Runner>>()
const cancelledModels = new Set<string>()
let inferenceChain: Promise<unknown> = Promise.resolve()

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

  // 1. Download through the repo id (progress reported); discard the pipeline
  //    so it does not pin ~600MB — inference reloads from disk below.
  if (!(await isDownloaded(modelId, cacheDir))) {
    post({ type: 'progress', modelId, status: 'downloading', progress: 0, message: '' })
    try {
      await tf.pipeline(task, modelId, {
        dtype: 'q8',
        progress_callback: (info: { status?: string; progress?: number }): void => {
          if (cancelledModels.has(modelId)) throw new Error('download cancelled')
          if (info.status === 'progress' && typeof info.progress === 'number') {
            post({ type: 'progress', modelId, status: 'downloading', progress: info.progress, message: '' })
          }
        },
      })
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
      throw error
    }
  }

  // 2. Load from the absolute cache directory: an absolute path is not a valid
  //    HF repo id, so transformers.js treats it as a local model and never
  //    touches the network.
  post({ type: 'progress', modelId, status: 'ready', progress: 100, message: '' })
  const pipeline = await tf.pipeline(task, join(cacheDir, modelId), { dtype: 'q8' }) as
    | ((text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>)
    | ((query: string, texts: string[], options?: Record<string, unknown>) => Promise<Array<{ score: number }>>)
  if (task === 'reranking') {
    const rerank = pipeline as (query: string, texts: string[], options?: Record<string, unknown>) => Promise<Array<{ score: number }>>
    return {
      rerank: async (query: string, texts: string[]): Promise<number[]> => {
        if (texts.length === 0) return []
        const output = await rerank(query, texts)
        return output.map(entry => entry.score ?? 0)
      },
    }
  }
  const embed = pipeline as (text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>
  return {
    embed: async (texts: string[], pooling: Pooling): Promise<number[][]> => {
      const output = await embed(texts, { pooling, normalize: true })
      return output.tolist() as number[][]
    },
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

function dropRunners(modelId: string): void {
  cancelledModels.delete(modelId)
  runners.delete(`feature-extraction:${modelId}`)
  runners.delete(`reranking:${modelId}`)
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
  if (message.type === 'release') {
    // Drop the loaded runner so the ~600MB model can be garbage-collected,
    // then ack so the main process can delete the files without hitting a
    // file lock (onnxruntime may still hold handles until the runner is
    // released and collected).
    dropRunners(message.modelId)
    post({ type: 'released', modelId: message.modelId })
    return
  }
  const { id, type, modelId, cacheDir, hfEndpoint } = message
  const task = message.task ?? 'feature-extraction'
  void getRunner(task, modelId, cacheDir, hfEndpoint)
    .then(async (runner) => {
      if (type === 'load') {
        post({ id, ok: true })
        return
      }
      if (type === 'rerank') {
        const run = inferenceChain.then(() => runner.rerank!(message.query ?? '', message.texts ?? []))
        inferenceChain = run.then(() => undefined, () => undefined)
        post({ id, ok: true, scores: await run })
        return
      }
      const run = inferenceChain.then(() => runner.embed!(message.texts ?? [], message.pooling ?? 'mean'))
      inferenceChain = run.then(() => undefined, () => undefined)
      post({ id, ok: true, vectors: await run })
    })
    .catch((error: unknown) => {
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    })
})
