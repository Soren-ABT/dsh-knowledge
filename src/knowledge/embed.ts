/**
 * Embedding providers. `openai` targets any OpenAI-compatible `/embeddings`
 * endpoint; `ollama` targets a local Ollama server; `local` runs an embedding
 * model through transformers.js in a DEDICATED CHILD PROCESS: the ~600MB
 * model and every inference tensor live off the main process, so a large
 * import batch can never freeze the host and native failures are recoverable.
 * Every provider returns one L2-normalized vector per input text.
 * @module dsh-knowledge/knowledge/embed
 */

import { createHash } from 'node:crypto'
import { LOCAL_MODEL_RUNTIME } from './local-model-runtime.js'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyGlobalProxy, httpFetch, NETWORK_HINT } from './net.js'
import {
  LOCAL_EMBED_PROTOCOL_VERSION,
  isLocalEmbedProgress,
  isLocalEmbedResponse,
  type LocalEmbedOperation,
  type LocalEmbedResponse,
} from './embed-protocol.js'
import { loadLocalReranker, rerankInLocalProcess } from './local-rerank.js'
import { ensureWellFormed } from './text-safety.js'
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

/** The effective HF endpoint override (mirror), or undefined (tests/telemetry). */
export function getHfEndpoint(): string | undefined {
  return hfEndpointOverride
}

export function expandHomePath(input: string): string {
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
  signal?: AbortSignal,
): Promise<number[][]> {
  throwIfAborted(signal)
  if (texts.length === 0) return []
  if (provider === 'none') throw new Error('embedding provider is "none" — configure an endpoint or a local model, or keep lexical search')
  const safeTexts = texts.map(ensureWellFormed)
  if (provider === 'local') {
    // The owning search can stop waiting immediately while the isolated child
    // finishes its current job; only a hard fault terminates that child.
    return await withAbortSignal(embedLocal(model.trim() === '' ? DEFAULT_LOCAL_MODEL : model, safeTexts), signal)
  }
  if (model.trim() === '') throw new Error('embedding model is empty')
  if (provider === 'openai') {
    if (baseUrl.trim() === '') throw new Error('embedding base URL is empty')
    return embedOpenAI(baseUrl, model, apiKey, safeTexts, signal)
  }
  // Ollama defaults an empty base URL to the well-known local endpoint, so a
  // base with an unset URL still embeds against http://127.0.0.1:11434.
  if (provider === 'ollama') return embedOllama(baseUrl, model, apiKey, safeTexts, signal)
  throw new Error(`unknown embedding provider ${String(provider)}`)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The operation was aborted', 'AbortError')
}

async function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      if (signal.reason instanceof Error) reject(signal.reason)
      else reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// ── local (isolated child process running transformers.js) ──────────────────

export interface LocalModelStatus {
  model: string
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0–100 download progress while `downloading`. */
  progress: number
  message: string
}

/** Persistent evidence that a local embedding model was opened in the
 * isolated runtime and produced a validated vector. */
export interface LocalEmbeddingReadiness {
  readonly schemaVersion: 1
  readonly modelId: string
  readonly fingerprint: string
  readonly dimensions: number
  readonly validatedAt: number
  readonly runtime: typeof LOCAL_MODEL_RUNTIME & { readonly node: string }
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

/** Current load/download state for an isolated local model (for the settings panel). */
const localModelStatus = new Map<string, LocalModelStatus>()
const EMBEDDING_READY_FILE = '.dsh-embedding-ready.json'

export function getLocalModelStatus(modelId: string): LocalModelStatus {
  return localModelStatus.get(modelId) ?? { model: modelId, status: 'idle', progress: 0, message: '' }
}

/** Surface a background download/load failure so the settings poller can show it (never swallow). */
export function markLocalModelError(modelId: string, message: string): void {
  localModelStatus.set(modelId, { model: modelId, status: 'error', progress: 0, message })
}

/** Whether a model's cached weights are already on disk (a real `.onnx` weight file). */
export async function isLocalModelDownloaded(modelId: string): Promise<boolean> {
  try {
    const modelRoot = join(localModelCacheDir(), modelId)
    const [config, onnxEntries, tokenizer] = await Promise.all([
      stat(join(modelRoot, 'config.json')),
      readdir(join(modelRoot, 'onnx')),
      Promise.any([
        stat(join(modelRoot, 'tokenizer.json')),
        stat(join(modelRoot, 'tokenizer_config.json')),
        stat(join(modelRoot, 'vocab.txt')),
        stat(join(modelRoot, 'spiece.model')),
      ]),
    ])
    if (config.size <= 0 || tokenizer.size <= 0) return false
    for (const name of onnxEntries) {
      if (!name.endsWith('.onnx')) continue
      if ((await stat(join(modelRoot, 'onnx', name))).size > 0) return true
    }
    return false
  } catch {
    return false
  }
}

function embeddingReadinessPath(modelId: string): string {
  return join(localModelCacheDir(), modelId, EMBEDDING_READY_FILE)
}

async function localModelFingerprint(modelId: string): Promise<string | undefined> {
  const root = join(localModelCacheDir(), modelId)
  const files: Array<{ path: string; size: number; mtimeMs: number }> = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === EMBEDDING_READY_FILE) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const metadata = await stat(path)
        files.push({
          path: path.slice(root.length + 1).replaceAll('\\', '/'),
          size: metadata.size,
          mtimeMs: Math.trunc(metadata.mtimeMs),
        })
      }
    }
  }
  try {
    await walk(root)
    files.sort((a, b) => a.path.localeCompare(b.path))
    return createHash('sha256').update(JSON.stringify(files)).digest('hex')
  } catch {
    return undefined
  }
}

export async function getLocalEmbeddingReadiness(modelId: string): Promise<LocalEmbeddingReadiness | undefined> {
  try {
    const record = JSON.parse(await readFile(embeddingReadinessPath(modelId), 'utf8')) as Partial<LocalEmbeddingReadiness>
    const dimensions = record.dimensions
    if (record.schemaVersion !== 1 || record.modelId !== modelId || !Number.isInteger(dimensions) || dimensions === undefined || dimensions <= 0
      || typeof record.fingerprint !== 'string' || typeof record.validatedAt !== 'number' || typeof record.runtime?.node !== 'string'
      || record.runtime.transformers !== LOCAL_MODEL_RUNTIME.transformers || record.runtime.onnxruntime !== LOCAL_MODEL_RUNTIME.onnxruntime) return undefined
    const fingerprint = await localModelFingerprint(modelId)
    return fingerprint !== undefined && fingerprint === record.fingerprint ? record as LocalEmbeddingReadiness : undefined
  } catch {
    return undefined
  }
}

async function writeLocalEmbeddingReadiness(modelId: string, dimensions: number): Promise<void> {
  const fingerprint = await localModelFingerprint(modelId)
  if (fingerprint === undefined || dimensions <= 0) return
  const record: LocalEmbeddingReadiness = {
    schemaVersion: 1,
    modelId,
    fingerprint,
    dimensions,
    validatedAt: Date.now(),
    runtime: { node: process.versions.node, ...LOCAL_MODEL_RUNTIME },
  }
  const destination = embeddingReadinessPath(modelId)
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8')
  await rename(temporary, destination)
}

// Embeddings run in a disposable child process rather than a worker thread.
// That gives a crashed or wedged native ONNX binding a genuinely fresh process
// on every recovery, while local reranking keeps its own independent child.
let localWorkerIdleTimeoutMs = 60_000
const LOCAL_WORKER_REQUEST_TIMEOUT_MS = 30 * 60_000
const LOCAL_RELEASE_ACK_TIMEOUT_MS = 3000
const LOCAL_PROCESS_MAX_PENDING = 16

/** Configure the local-model process idle release timeout (0 = never release). */
export function setLocalWorkerIdleTimeoutMs(ms: number): void {
  localWorkerIdleTimeoutMs = Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 60_000
  clearIdleTimer()
  if (localWorkerIdleTimeoutMs > 0 && localWorker !== null) armIdleTimer()
}

let localWorker: ChildProcess | null = null
let localWorkerIdleTimer: ReturnType<typeof setTimeout> | null = null
let localRequestSeq = 0
/** Re-arms the in-flight request's budget when the child reports progress, for
 *  operations whose duration is legitimately unbounded (download, first load). */
let reArmActiveRequest: (() => void) | undefined
let localActiveModelId: string | null = null
const localPending = new Map<number, {
  operation: LocalEmbedOperation
  expectedCount?: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}>()

function localWorkerPath(): string {
  return fileURLToPath(new URL('./embed-process.mjs', import.meta.url))
}

function stagingCacheDir(): string {
  return join(localModelCacheDir(), '.staging')
}

function stagingModelPath(modelId: string): string {
  return join(stagingCacheDir(), modelId)
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

function ensureLocalWorker(): ChildProcess {
  if (localWorker !== null) return localWorker
  const worker = fork(localWorkerPath(), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    // Test runners and `--input-type` cannot be forwarded to a child that
    // executes an ESM file. The process needs no debugger inheritance either.
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type') && !arg.startsWith('--inspect')),
  })
  worker.unref()
  worker.on('message', (message: unknown): void => {
    if (isLocalEmbedProgress(message)) {
      localModelStatus.set(message.modelId, {
        model: message.modelId,
        status: message.status,
        progress: message.progress,
        message: message.message,
      })
      // A download/load can run for minutes (585MB model); each progress
      // report is proof the worker is alive, so keep the idle-release timer
      // from firing mid-download (it would terminate the worker and kill the
      // request) and re-arm the request budget too, so a slow-but-progressing
      // transfer is never killed for taking long.
      armIdleTimer()
      reArmActiveRequest?.()
      return
    }
    if (!isLocalEmbedResponse(message)) {
      const id = message !== null && typeof message === 'object' ? (message as { id?: unknown }).id : undefined
      if (typeof id !== 'number') return
      const pending = localPending.get(id)
      if (pending !== undefined) {
        localPending.delete(id)
        pending.reject(new Error('local embedding process returned an invalid response envelope'))
        void terminateLocalWorker(new Error('local embedding process returned an invalid response envelope'))
      }
      return
    }
    const pending = localPending.get(message.id)
    if (pending === undefined) return
    localPending.delete(message.id)
    if (message.operation !== pending.operation) {
      pending.reject(new Error('local embedding process returned an invalid response operation'))
      void terminateLocalWorker(new Error('local embedding process returned an invalid response operation'))
      return
    }
    if (message.ok === false) {
      const failure = new Error(`${message.error.code}: ${message.error.message}`)
      // A failure the child reports about ITSELF is process-local state — an
      // ONNX session that failed to initialize cannot heal inside the same
      // process (a native binding that did not register stays unregistered, and
      // the child is deliberately kept alive across idle releases). Retrying in
      // the same child therefore cannot help, so replace it: that is what makes
      // embedLocal's "one clean restart" a real restart. A failed `download` is a
      // transport problem and keeps its child (and its resumable staging cache).
      if (pending.operation === 'load' || pending.operation === 'embed') {
        void terminateLocalWorker(failure)
      }
      pending.reject(failure)
      return
    }
    try {
      if (pending.operation === 'embed') {
        pending.resolve(validateEmbeddingResponse(message, pending.expectedCount ?? 0))
      } else {
        pending.resolve(undefined)
      }
    } catch (error) {
      const invalid = error instanceof Error ? error : new Error(String(error))
      pending.reject(invalid)
      void terminateLocalWorker(invalid)
    }
  })
  const onWorkerFailure = (error: Error): void => {
    // Ignore a superseded worker's late error/exit — a newer worker may be live.
    if (localWorker !== worker) return
    failAllPending(error)
    localWorker = null
    clearIdleTimer()
  }
  worker.on('error', (error) => onWorkerFailure(error instanceof Error ? error : new Error(String(error))))
  worker.on('exit', (code, signal) => onWorkerFailure(new Error(`local embedding process exited (${code ?? 'null'}${signal === null ? '' : `, ${signal}`})`)))
  localWorker = worker
  return worker
}

function validateEmbeddingResponse(response: LocalEmbedResponse, expectedCount: number): number[][] {
  const vectors = response.ok === true ? response.vectors : undefined
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error('local embedding process returned an invalid vector count')
  }
  let dimension: number | undefined
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value))) {
      throw new Error('local embedding process returned an invalid vector')
    }
    if (dimension === undefined) dimension = vector.length
    else if (vector.length !== dimension) throw new Error('local embedding process returned inconsistent vector dimensions')
  }
  return vectors
}

function armIdleTimer(): void {
  clearIdleTimer()
  if (localWorkerIdleTimeoutMs <= 0) return
  localWorkerIdleTimer = setTimeout(() => {
    localWorkerIdleTimer = null
    // Never release while a request is in flight: the worker may be in the
    // middle of a long download/load/inference (>60s). Only release when
    // nothing is pending, mirroring Cherry's idle-release timer.
    if (localPending.size > 0) {
      armIdleTimer()
      return
    }
    if (localWorker === null || localActiveModelId === null) return
    // Release native sessions while retaining the isolated process. A later
    // hard failure can still terminate the process and start from a clean
    // ONNX runtime, without ever touching the host process.
    void callWorker('release', { modelId: localActiveModelId }).catch(() => {})
  }, localWorkerIdleTimeoutMs)
  localWorkerIdleTimer.unref?.()
}

function postToWorker(message: unknown): void {
  const worker = ensureLocalWorker()
  armIdleTimer()
  if (worker.connected !== true || worker.send(message as never) !== true) {
    throw new Error('local embedding process is not available')
  }
}

function callWorker(
  operation: LocalEmbedOperation,
  payload: { modelId: string; texts?: string[]; pooling?: Pooling; cacheDir?: string },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (localPending.size >= LOCAL_PROCESS_MAX_PENDING) {
      reject(new Error('local embedding process is busy'))
      return
    }
    const id = ++localRequestSeq
    // A download or a first load legitimately runs for many minutes (585MB at
    // ~650KB/s is roughly 16 minutes). Their progress IS the liveness proof, so
    // those operations re-arm this budget on every progress event: it bounds a
    // STALL rather than the total transfer. Everything else keeps a flat
    // per-request ceiling.
    const progressAware = operation === 'download' || operation === 'load'
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    const armRequestTimer = (): void => {
      requestTimer = setTimeout(() => {
        localPending.delete(id)
        // An expired active inference could be holding a native session in an
        // unknown state. Destroy only the child, never the DSH host process.
        void terminateLocalWorker(new Error('local embedding process timed out'))
        reject(new Error('local embedding process timed out'))
      }, LOCAL_WORKER_REQUEST_TIMEOUT_MS)
      requestTimer.unref?.()
    }
    const clearRequestTimer = (): void => {
      clearTimeout(requestTimer)
      if (progressAware && reArmActiveRequest === armRequestTimer) reArmActiveRequest = undefined
    }
    if (progressAware) reArmActiveRequest = armRequestTimer
    armRequestTimer()
    localPending.set(id, {
      operation,
      expectedCount: payload.texts?.length,
      resolve: (value) => { clearRequestTimer(); resolve(value) },
      reject: (error) => { clearRequestTimer(); reject(error) },
    })
    localActiveModelId = payload.modelId
    try {
      postToWorker({
      protocolVersion: LOCAL_EMBED_PROTOCOL_VERSION,
      id,
      operation,
      modelId: payload.modelId,
      cacheDir: payload.cacheDir ?? localModelCacheDir(),
      hfEndpoint: hfEndpointOverride
        ?? (typeof process !== 'undefined' && process.env.HF_ENDPOINT !== undefined ? process.env.HF_ENDPOINT : undefined),
      texts: payload.texts,
      pooling: payload.pooling,
      })
    } catch (error) {
      localPending.delete(id)
      clearRequestTimer()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function embedLocal(modelId: string, texts: readonly string[]): Promise<number[][]> {
  try {
    const vectors = await callWorker('embed', { modelId, texts: [...texts], pooling: poolingFor(modelId) }) as number[][]
    void writeLocalEmbeddingReadiness(modelId, vectors[0]?.length ?? 0).catch(() => {})
    return vectors
  } catch (error) {
    // One clean child restart is safe for a crashed/failed native session.
    // Do not retry malformed input or a repeatedly failing model indefinitely.
    if (!isRecoverableLocalProcessError(error)) throw error
    const vectors = await callWorker('embed', { modelId, texts: [...texts], pooling: poolingFor(modelId) }) as number[][]
    void writeLocalEmbeddingReadiness(modelId, vectors[0]?.length ?? 0).catch(() => {})
    return vectors
  }
}

/**
 * Local cross-encoder rerank (bge-reranker family): scores each candidate
 * text against the query, index-aligned. It deliberately uses the separate
 * rerank child process so its lifecycle can never disturb embeddings.
 */
export async function rerankLocal(modelId: string, query: string, texts: readonly string[]): Promise<number[]> {
  return await rerankInLocalProcess(
    modelId,
    localModelCacheDir(),
    hfEndpointOverride ?? process.env.HF_ENDPOINT,
    query,
    texts,
    60_000,
  )
}

/** Download + load a local model in an isolated process (no inference). */
export async function loadLocalModel(modelId: string, task: 'feature-extraction' | 'reranking' = 'feature-extraction'): Promise<void> {
  if (task === 'reranking') {
    await loadLocalReranker(modelId, localModelCacheDir(), hfEndpointOverride ?? process.env.HF_ENDPOINT)
    return
  }
  // A previous completed model is loaded and probed in the child on first
  // use. New downloads are isolated in `.staging`, so cancellation or a
  // network fault can never turn a formerly usable model into a partial one.
  if (await isLocalModelDownloaded(modelId)) {
    await callWorker('load', { modelId })
    const probe = await callWorker('embed', { modelId, texts: ['dsh local embedding readiness probe'], pooling: poolingFor(modelId) }) as number[][]
    await writeLocalEmbeddingReadiness(modelId, probe[0]?.length ?? 0)
    return
  }
  const staging = stagingCacheDir()
  localModelStatus.set(modelId, { model: modelId, status: 'downloading', progress: 0, message: '' })
  await callWorker('download', { modelId, cacheDir: staging })
  if (!(await isDownloadedAt(stagingModelPath(modelId)))) {
    throw new Error('local embedding process completed without a valid model cache')
  }
  // The process holds its staging pipeline open. Release it before the atomic
  // promotion, which avoids a Windows file lock and guarantees the final
  // cache is either the old complete model or the new complete model.
  await callWorker('release', { modelId, cacheDir: staging })
  const finalPath = join(localModelCacheDir(), modelId)
  await mkdir(dirname(finalPath), { recursive: true })
  await rm(finalPath, { recursive: true, force: true })
  await rename(stagingModelPath(modelId), finalPath)
  await callWorker('load', { modelId })
  const probe = await callWorker('embed', { modelId, texts: ['dsh local embedding readiness probe'], pooling: poolingFor(modelId) }) as number[][]
  await writeLocalEmbeddingReadiness(modelId, probe[0]?.length ?? 0)
}

async function isDownloadedAt(modelRoot: string): Promise<boolean> {
  try {
    const [config, onnxEntries, tokenizer] = await Promise.all([
      stat(join(modelRoot, 'config.json')),
      readdir(join(modelRoot, 'onnx')),
      Promise.any([
        stat(join(modelRoot, 'tokenizer.json')),
        stat(join(modelRoot, 'tokenizer_config.json')),
        stat(join(modelRoot, 'vocab.txt')),
        stat(join(modelRoot, 'spiece.model')),
      ]),
    ])
    if (config.size <= 0 || tokenizer.size <= 0) return false
    for (const name of onnxEntries) {
      if (name.endsWith('.onnx') && (await stat(join(modelRoot, 'onnx', name))).size > 0) return true
    }
    return false
  } catch {
    return false
  }
}

/** Cancel only an active download. A previously ready model is never removed. */
export async function cancelLocalModel(modelId: string): Promise<void> {
  if (localModelStatus.get(modelId)?.status !== 'downloading') return
  await terminateLocalWorker(new Error('local embedding download cancelled'))
  localModelStatus.set(modelId, { model: modelId, status: 'idle', progress: 0, message: '' })
  await rm(join(localModelCacheDir(), '.staging', modelId), { recursive: true, force: true }).catch(() => {})
}

/** Drop a loaded extractor (frees its native sessions) and delete its cached weights. */
export async function removeLocalModel(modelId: string): Promise<void> {
  if (localModelStatus.get(modelId)?.status === 'downloading') {
    throw new Error('模型正在下载，完成后才能删除')
  }
  await withTimeout(callWorker('release', { modelId }), LOCAL_RELEASE_ACK_TIMEOUT_MS).catch(() => {})
  localModelStatus.delete(modelId)
  await rm(join(localModelCacheDir(), modelId), { recursive: true, force: true })
}

async function terminateLocalWorker(error: Error): Promise<void> {
  const worker = localWorker
  localWorker = null
  localActiveModelId = null
  clearIdleTimer()
  failAllPending(error)
  if (worker === null) return
  const processToStop = worker
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, LOCAL_RELEASE_ACK_TIMEOUT_MS)
    timer.unref?.()
    function done(): void {
      clearTimeout(timer)
      processToStop.removeListener('exit', done)
      resolve()
    }
    processToStop.once('exit', done)
    try { processToStop.kill('SIGTERM') } catch { done() }
  })
}

function isRecoverableLocalProcessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /process (?:exited|timed out|is not available)|process_crash|runtime_error/i.test(message)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local embedding operation timed out')), timeoutMs)
    timer.unref?.()
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** Gracefully terminate the isolated embedding process during plugin teardown. */
export async function disposeLocalModelWorker(): Promise<void> {
  clearIdleTimer()
  const worker = localWorker
  if (worker === null) return
  await withTimeout(callWorker('shutdown', { modelId: localActiveModelId ?? '' }), LOCAL_RELEASE_ACK_TIMEOUT_MS).catch(() => {})
  if (localWorker === worker) await terminateLocalWorker(new Error('local embedding process disposed'))
}

/** Whether any local model download is currently in flight (migration guard). */
export function hasActiveLocalModelDownload(): boolean {
  for (const status of localModelStatus.values()) {
    if (status.status === 'downloading') return true
  }
  return false
}

// ── remote providers ─────────────────────────────────────────────────────────

async function embedOpenAI(
  baseUrl: string,
  model: string,
  apiKey: string,
  texts: readonly string[],
  signal?: AbortSignal,
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
    ...(signal !== undefined ? { signal } : {}),
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
  signal?: AbortSignal,
): Promise<number[][]> {
  const base = trimBase(baseUrl.trim() === '' ? 'http://127.0.0.1:11434' : baseUrl)
  // Modern Ollama: POST /api/embed { model, input: [..] } -> { embeddings: [[..]] }
  const response = await httpFetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    timeoutMs: 60000,
    ...(signal !== undefined ? { signal } : {}),
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
      ...(signal !== undefined ? { signal } : {}),
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
