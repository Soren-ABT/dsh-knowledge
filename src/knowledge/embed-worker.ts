/**
 * Local embedding inference worker — Cherry Studio's "in its own worker"
 * model: transformers.js / onnxruntime run off the main process, so the
 * ~600MB model plus every inference intermediate tensor lives in this
 * worker's heap and can never freeze the host process (the freeze that once
 * required deleting the local model files to recover).
 *
 * Wire protocol (JSON messages over parentPort):
 *   main → worker:  { id, type: 'embed'|'load', modelId, cacheDir, hfEndpoint?, texts?, pooling? }
 *                    { type: 'cancel'|'release', modelId }
 *                    { type: 'shutdown' }
 *   worker → main:  { id, ok: true, vectors? } | { id, ok: false, error }
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
    (text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>
  >
}

interface EmbedRequest {
  id: number
  type: 'embed' | 'load'
  modelId: string
  cacheDir: string
  hfEndpoint?: string
  texts?: string[]
  pooling?: 'last_token' | 'cls' | 'mean'
}

type WorkerMessage = EmbedRequest
  | { type: 'cancel'; modelId: string }
  | { type: 'release'; modelId: string }
  | { type: 'shutdown' }

type Pooling = 'last_token' | 'cls' | 'mean'
type Extractor = (texts: string[], pooling: Pooling) => Promise<number[][]>

let transformers: TransformersModule | null = null
const extractors = new Map<string, Promise<Extractor>>()
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

async function createExtractor(
  modelId: string,
  cacheDir: string,
  hfEndpoint: string | undefined,
): Promise<Extractor> {
  const tf = await loadTransformers()
  applyEndpoint(tf, hfEndpoint)
  tf.env.cacheDir = cacheDir

  // 1. Download through the repo id (progress reported); discard the pipeline
  //    so it does not pin ~600MB — inference reloads from disk below.
  if (!(await isDownloaded(modelId, cacheDir))) {
    post({ type: 'progress', modelId, status: 'downloading', progress: 0, message: '' })
    try {
      await tf.pipeline('feature-extraction', modelId, {
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
  const pipeline = await tf.pipeline('feature-extraction', join(cacheDir, modelId), { dtype: 'q8' })
  return async (texts: string[], pooling: Pooling): Promise<number[][]> => {
    const output = await pipeline(texts, { pooling, normalize: true })
    return output.tolist() as number[][]
  }
}

function getExtractor(modelId: string, cacheDir: string, hfEndpoint: string | undefined): Promise<Extractor> {
  const cached = extractors.get(modelId)
  if (cached !== undefined) return cached
  const pending = createExtractor(modelId, cacheDir, hfEndpoint)
  extractors.set(modelId, pending)
  return pending
}

parentPort?.on('message', (message: WorkerMessage): void => {
  if (message.type === 'shutdown') {
    process.exit(0)
    return
  }
  if (message.type === 'cancel') {
    // Interrupt an in-flight download (its progress callback throws); a
    // loaded extractor stays usable until the files are removed.
    cancelledModels.add(message.modelId)
    return
  }
  if (message.type === 'release') {
    // Drop the loaded extractor so the ~600MB model can be garbage-collected.
    cancelledModels.delete(message.modelId)
    extractors.delete(message.modelId)
    return
  }
  const { id, type, modelId, cacheDir, hfEndpoint } = message
  void getExtractor(modelId, cacheDir, hfEndpoint)
    .then(async (extractor) => {
      if (type === 'load') {
        post({ id, ok: true })
        return
      }
      const run = inferenceChain.then(() => extractor(message.texts ?? [], message.pooling ?? 'mean'))
      inferenceChain = run.then(() => undefined, () => undefined)
      post({ id, ok: true, vectors: await run })
    })
    .catch((error: unknown) => {
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    })
})
