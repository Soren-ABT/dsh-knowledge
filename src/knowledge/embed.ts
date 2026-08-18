/**
 * Embedding providers. `openai` targets any OpenAI-compatible `/embeddings`
 * endpoint; `ollama` targets a local Ollama server; `local` runs an embedding
 * model through transformers.js in a DEDICATED WORKER THREAD (Cherry Studio's
 * "in its own worker" model): the ~600MB model and every inference tensor live
 * off the main process, so a large import batch can never freeze the host.
 * Every provider returns one L2-normalized vector per input text.
 * @module dsh-knowledge/knowledge/embed
 */

import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { applyGlobalProxy, httpFetch, NETWORK_HINT } from './net.js'
import type { EmbeddingProvider } from './types.js'

// Route every global fetch (including transformers.js model downloads) through
// the system proxy when HTTP(S)_PROXY is configured. Safe no-op otherwise.
applyGlobalProxy()

/** Default in-process model — the ONNX repo Cherry Studio ships. */
export const DEFAULT_LOCAL_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'

let cacheDirOverride: string | undefined
let hfEndpointOverride: string | undefined

/**
 * Override the local-model cache root from deployment config. An empty or
 * unset value falls back to DSH's shared home resolution (`$DSH_HOME` → `~/.dsh`).
 */
export function setLocalModelCacheDir(dir: string | undefined): void {
  cacheDirOverride = dir !== undefined && dir.trim() !== ''
    ? resolve(expandHomePath(dir.trim()))
    : undefined
}

/**
 * Override the Hugging Face endpoint from deployment/runtime config — the
 * mirror switch for networks that cannot reach huggingface.co directly
 * (e.g. `https://hf-mirror.com`). An empty value falls back to the
 * `HF_ENDPOINT` environment variable, then to the official hub.
 */
export function setHfEndpoint(url: string | undefined): void {
  hfEndpointOverride = url !== undefined && url.trim() !== ''
    ? url.trim().replace(/\/+$/, '')
    : undefined
}

function expandHomePath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** Persistent cache directory for downloaded local models (mirrors DSH's `resolveDshHome`). */
export function localModelCacheDir(): string {
  if (cacheDirOverride !== undefined) return cacheDirOverride
  const envHome = typeof process !== 'undefined' ? process.env.DSH_HOME : undefined
  const home = envHome !== undefined && envHome.trim() !== ''
    ? resolve(expandHomePath(envHome.trim()))
    : join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-knowledge', 'local-models')
}

/** Embed many texts into normalized vectors. Throws when the provider is `none` or the call fails. */
export async function embedTexts(
  provider: EmbeddingProvider,
  baseUrl: string,
  model: string,
  apiKey: string,
  texts: readonly string[],
): Promise<number[][]> {
  if (texts.length === 0) return []
  if (provider === 'none') throw new Error('embedding provider is "none" — configure an endpoint or a local model, or keep lexical search')
  if (provider === 'local') return embedLocal(model.trim() === '' ? DEFAULT_LOCAL_MODEL : model, texts)
  if (baseUrl.trim() === '') throw new Error('embedding base URL is empty')
  if (model.trim() === '') throw new Error('embedding model is empty')
  if (provider === 'openai') return embedOpenAI(baseUrl, model, apiKey, texts)
  if (provider === 'ollama') return embedOllama(baseUrl, model, apiKey, texts)
  throw new Error(`unknown embedding provider ${String(provider)}`)
}

// ── local (dedicated worker thread running transformers.js) ─────────────────

export interface LocalModelStatus {
  model: string
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0–100 download progress while `downloading`. */
  progress: number
  message: string
}

type Pooling = 'last_token' | 'cls' | 'mean'

/**
 * Per-model pooling strategy, mirroring Cherry Studio's `pooling.ts`: the
 * model family decides how the token embeddings are collapsed into one vector.
 * - Qwen3-Embedding → last-token pooling
 * - BGE (small/base, zh/en) → CLS token pooling
 * - GTE / E5 → mean pooling (transformers.js default)
 * Unknown ids fall back to mean pooling, which is the safest general choice.
 */
export function poolingFor(modelId: string): Pooling {
  const id = modelId.toLowerCase()
  if (id.includes('qwen3')) return 'last_token'
  if (id.includes('bge') || id.includes('bce')) return 'cls'
  if (id.includes('e5')) return 'mean'
  if (id.includes('gte')) return 'mean'
  return 'mean'
}

/** Current load/download state for an in-process model (for the settings panel). */
const localModelStatus = new Map<string, LocalModelStatus>()

export function getLocalModelStatus(modelId: string): LocalModelStatus {
  return localModelStatus.get(modelId) ?? { model: modelId, status: 'idle', progress: 0, message: '' }
}

/** Surface a background download/load failure so the settings poller can show it (never swallow). */
export function markLocalModelError(modelId: string, message: string): void {
  localModelStatus.set(modelId, { model: modelId, status: 'error', progress: 0, message })
}

/** Whether a model's cached weights are already on disk (a real `.onnx` weight file). */
export async function isLocalModelDownloaded(modelId: string): Promise<boolean> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(join(localModelCacheDir(), modelId, 'onnx'))
    return entries.some(name => name.endsWith('.onnx'))
  } catch {
    return false
  }
}

interface WorkerResponse {
  id?: number
  ok?: boolean
  vectors?: number[][]
  error?: string
  type?: 'progress'
  modelId?: string
  status?: LocalModelStatus['status']
  progress?: number
  message?: string
}

// A single lazy worker owns every local model (Cherry: one worker per kind,
// serialized requests, idle release, crash-then-respawn). `unref()` keeps the
// worker from holding the host process open on shutdown.
const LOCAL_WORKER_IDLE_TIMEOUT_MS = 60_000
const LOCAL_WORKER_REQUEST_TIMEOUT_MS = 30 * 60_000

let localWorker: Worker | null = null
let localWorkerIdleTimer: ReturnType<typeof setTimeout> | null = null
let localRequestSeq = 0
const localPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function localWorkerPath(): string {
  return fileURLToPath(new URL('./embed-worker.mjs', import.meta.url))
}

function clearIdleTimer(): void {
  if (localWorkerIdleTimer !== null) {
    clearTimeout(localWorkerIdleTimer)
    localWorkerIdleTimer = null
  }
}

function failAllPending(error: Error): void {
  for (const { reject } of localPending.values()) reject(error)
  localPending.clear()
}

function ensureLocalWorker(): Worker {
  if (localWorker !== null) return localWorker
  const worker = new Worker(localWorkerPath())
  worker.unref()
  worker.on('message', (message: WorkerResponse): void => {
    if (message.type === 'progress' && message.modelId !== undefined) {
      localModelStatus.set(message.modelId, {
        model: message.modelId,
        status: message.status ?? 'idle',
        progress: message.progress ?? 0,
        message: message.message ?? '',
      })
      return
    }
    if (message.id === undefined) return
    const pending = localPending.get(message.id)
    if (pending === undefined) return
    localPending.delete(message.id)
    if (message.ok === true) pending.resolve(message.vectors ?? null)
    else pending.reject(new Error(message.error ?? 'local model worker failed'))
  })
  const onWorkerFailure = (error: Error): void => {
    // Ignore a superseded worker's late error/exit — a newer worker may be live.
    if (localWorker !== worker) return
    failAllPending(error)
    localWorker = null
    clearIdleTimer()
  }
  worker.on('error', (error) => onWorkerFailure(error instanceof Error ? error : new Error(String(error))))
  worker.on('exit', () => onWorkerFailure(new Error('local model worker exited')))
  localWorker = worker
  return worker
}

function armIdleTimer(): void {
  clearIdleTimer()
  localWorkerIdleTimer = setTimeout(() => {
    localWorkerIdleTimer = null
    // Release a loaded model (up to 600MB+) after inactivity, mirroring
    // Cherry's idle-release timer; the next request respawns the worker.
    const worker = localWorker
    localWorker = null
    failAllPending(new Error('local model worker released after idle'))
    void worker?.terminate()
  }, LOCAL_WORKER_IDLE_TIMEOUT_MS)
  localWorkerIdleTimer.unref?.()
}

function postToWorker(message: unknown): void {
  const worker = ensureLocalWorker()
  armIdleTimer()
  worker.postMessage(message)
}

function callWorker(
  type: 'embed' | 'load',
  payload: { modelId: string; texts?: string[]; pooling?: Pooling },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++localRequestSeq
    const timer = setTimeout(() => {
      localPending.delete(id)
      reject(new Error('local model worker request timed out'))
    }, LOCAL_WORKER_REQUEST_TIMEOUT_MS)
    timer.unref?.()
    localPending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    postToWorker({
      id,
      type,
      modelId: payload.modelId,
      cacheDir: localModelCacheDir(),
      hfEndpoint: hfEndpointOverride
        ?? (typeof process !== 'undefined' && process.env.HF_ENDPOINT !== undefined ? process.env.HF_ENDPOINT : undefined),
      texts: payload.texts,
      pooling: payload.pooling,
    })
  })
}

async function embedLocal(modelId: string, texts: readonly string[]): Promise<number[][]> {
  const vectors = await callWorker('embed', { modelId, texts: [...texts], pooling: poolingFor(modelId) })
  return vectors as number[][]
}

/** Download + load a local model in the worker (no inference; progress reports via /local-model-status). */
export async function loadLocalModel(modelId: string): Promise<void> {
  await callWorker('load', { modelId })
}

/** Cancel an in-flight download; the next progress tick throws and aborts the load. */
export async function cancelLocalModel(modelId: string): Promise<void> {
  postToWorker({ type: 'cancel', modelId })
  localModelStatus.set(modelId, { model: modelId, status: 'idle', progress: 0, message: '' })
  await rm(join(localModelCacheDir(), modelId), { recursive: true, force: true }).catch(() => {})
}

/** Drop a loaded extractor (frees its ~600MB in the worker) and delete its cached weights from disk. */
export async function removeLocalModel(modelId: string): Promise<void> {
  if (localModelStatus.get(modelId)?.status === 'downloading') {
    throw new Error('模型正在下载，完成后才能删除')
  }
  postToWorker({ type: 'release', modelId })
  localModelStatus.delete(modelId)
  await rm(join(localModelCacheDir(), modelId), { recursive: true, force: true })
}

/** Terminate the worker (plugin teardown). Idempotent. */
export function disposeLocalModelWorker(): void {
  clearIdleTimer()
  const worker = localWorker
  localWorker = null
  failAllPending(new Error('local model worker disposed'))
  if (worker !== null) {
    try {
      worker.postMessage({ type: 'shutdown' })
    } catch {
      // worker already dead — nothing to do
    }
    void worker.terminate()
  }
}

// ── remote providers ─────────────────────────────────────────────────────────

async function embedOpenAI(
  baseUrl: string,
  model: string,
  apiKey: string,
  texts: readonly string[],
): Promise<number[][]> {
  const url = `${trimBase(baseUrl)}/embeddings`
  const response = await httpFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: texts }),
    timeoutMs: 60000,
  })
  if (!response.ok) {
    throw new Error(`embedding request failed: HTTP ${response.status} ${await response.text()}`)
  }
  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
  const vectors = (json.data ?? []).map(entry => entry.embedding)
  if (vectors.length !== texts.length || vectors.some(v => v === undefined || v.length === 0)) {
    throw new Error('embedding response did not return one vector per input')
  }
  return (vectors as number[][]).map(normalize)
}

async function embedOllama(
  baseUrl: string,
  model: string,
  _apiKey: string,
  texts: readonly string[],
): Promise<number[][]> {
  const base = trimBase(baseUrl)
  // Modern Ollama: POST /api/embed { model, input: [..] } -> { embeddings: [[..]] }
  const response = await httpFetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    timeoutMs: 60000,
  })
  if (response.ok) {
    const json = (await response.json()) as { embeddings?: number[][] }
    if (json.embeddings?.length === texts.length) return json.embeddings.map(normalize)
  }
  // Legacy Ollama: one prompt at a time -> { embedding: [..] }
  const vectors: number[][] = []
  for (const text of texts) {
    const legacy = await httpFetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      timeoutMs: 60000,
    })
    if (!legacy.ok) throw new Error(`ollama embedding failed: HTTP ${legacy.status} ${await legacy.text()}`)
    const json = (await legacy.json()) as { embedding?: number[] }
    if (json.embedding === undefined || json.embedding.length === 0) {
      throw new Error('ollama embedding response missing a vector')
    }
    vectors.push(normalize(json.embedding))
  }
  return vectors
}

/** L2-normalize a vector in place. */
export function normalize(vector: number[]): number[] {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  if (length === 0) return vector
  return vector.map(value => value / length)
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
