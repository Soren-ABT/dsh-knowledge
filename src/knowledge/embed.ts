/**
 * Embedding providers. `openai` targets any OpenAI-compatible `/embeddings`
 * endpoint; `ollama` targets a local Ollama server; `local` runs an embedding
 * model in-process through transformers.js (Cherry Studio's Local Models).
 * Every provider returns one L2-normalized vector per input text.
 * @module dsh-knowledge/knowledge/embed
 */

import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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

// ── local (in-process transformers.js) ───────────────────────────────────────

interface TransformersModule {
  env: { allowLocalModels: boolean; cacheDir?: string; remoteHost?: string }
  pipeline(task: string, modelId: string, options?: Record<string, unknown>): Promise<
    (text: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): unknown }>
  >
}

export interface LocalModelStatus {
  model: string
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0–100 download progress while `downloading`. */
  progress: number
  message: string
}

interface ProgressInfo {
  status?: string
  file?: string
  progress?: number
}

const localExtractors = new Map<string, Promise<LocalExtractor>>()
const localModelStatus = new Map<string, LocalModelStatus>()
const cancelledModels = new Set<string>()
// Per-model inference chain: transformers.js gives no concurrency guarantee for
// parallel runs on one pipeline instance, so serialize inference per model (the
// extractor itself is shared — the model loads once — only the runs queue up).
// Remote providers (openai/ollama) are unaffected and keep full parallelism.
const localInferenceChains = new Map<string, Promise<unknown>>()

/** Current load/download state for an in-process model (for the settings panel). */
export function getLocalModelStatus(modelId: string): LocalModelStatus {
  return localModelStatus.get(modelId) ?? { model: modelId, status: 'idle', progress: 0, message: '' }
}

/** Download + load a local model into the in-memory extractor cache (no inference). */
export async function loadLocalModel(modelId: string): Promise<void> {
  await getLocalExtractor(modelId)
}

/** Cancel an in-flight download; the next progress tick throws and aborts the load. */
export async function cancelLocalModel(modelId: string): Promise<void> {
  cancelledModels.add(modelId)
  localExtractors.delete(modelId)
  localModelStatus.set(modelId, { model: modelId, status: 'idle', progress: 0, message: '' })
  await rm(join(localModelCacheDir(), modelId), { recursive: true, force: true }).catch(() => {})
}

/** Drop a loaded extractor and delete its cached weights from disk. */
export async function removeLocalModel(modelId: string): Promise<void> {
  if (localModelStatus.get(modelId)?.status === 'downloading') {
    throw new Error('模型正在下载，完成后才能删除')
  }
  cancelledModels.delete(modelId)
  localExtractors.delete(modelId)
  localModelStatus.delete(modelId)
  await rm(join(localModelCacheDir(), modelId), { recursive: true, force: true })
}

/** Whether a model's cached weights are already on disk (a real `.onnx` weight file). */
export async function isLocalModelDownloaded(modelId: string): Promise<boolean> {
  try {
    const entries = await readdir(join(localModelCacheDir(), modelId, 'onnx'))
    return entries.some(name => name.endsWith('.onnx'))
  } catch {
    return false
  }
}

type LocalExtractor = (texts: string[]) => Promise<number[][]>

/**
 * Per-model pooling strategy, mirroring Cherry Studio's `pooling.ts`: the
 * model family decides how the token embeddings are collapsed into one vector.
 * - Qwen3-Embedding → last-token pooling
 * - BGE (small/base, zh/en) → CLS token pooling
 * - GTE / E5 → mean pooling (transformers.js default)
 * Unknown ids fall back to mean pooling, which is the safest general choice.
 */
export function poolingFor(modelId: string): 'last_token' | 'cls' | 'mean' {
  const id = modelId.toLowerCase()
  if (id.includes('qwen3')) return 'last_token'
  if (id.includes('bge') || id.includes('bce')) return 'cls'
  if (id.includes('e5')) return 'mean'
  if (id.includes('gte')) return 'mean'
  return 'mean'
}

async function embedLocal(modelId: string, texts: readonly string[]): Promise<number[][]> {
  const extractor = await getLocalExtractor(modelId)
  // Chain this run behind the previous one for the same model; a failed run
  // must not break the chain (the error still propagates to this caller).
  const prev = localInferenceChains.get(modelId) ?? Promise.resolve()
  const run = prev.then(() => extractor([...texts]))
  localInferenceChains.set(modelId, run.then(() => undefined, () => undefined))
  return run
}

async function getLocalExtractor(modelId: string): Promise<LocalExtractor> {
  const cached = localExtractors.get(modelId)
  if (cached !== undefined) return cached
  const pending = createLocalExtractor(modelId)
  localExtractors.set(modelId, pending)
  try {
    return await pending
  } catch (error) {
    localExtractors.delete(modelId)
    if (cancelledModels.has(modelId)) {
      cancelledModels.delete(modelId)
      localModelStatus.set(modelId, { model: modelId, status: 'idle', progress: 0, message: '' })
    } else {
      localModelStatus.set(modelId, {
        model: modelId,
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}

async function createLocalExtractor(modelId: string): Promise<LocalExtractor> {
  const transformers = (await import('@huggingface/transformers')) as unknown as TransformersModule
  const hfEndpoint = hfEndpointOverride
    ?? (typeof process !== 'undefined' && process.env.HF_ENDPOINT !== undefined ? process.env.HF_ENDPOINT : undefined)
  if (hfEndpoint !== undefined && hfEndpoint.trim() !== '') {
    transformers.env.remoteHost = hfEndpoint.trim().replace(/\/+$/, '')
  }
  transformers.env.cacheDir = localModelCacheDir()

  // 1. Download through the repo id (progress reported); discard the pipeline so it
  //    does not pin ~600MB — inference reloads from disk below (Cherry Studio style).
  if (!(await isLocalModelDownloaded(modelId))) {
    localModelStatus.set(modelId, { model: modelId, status: 'downloading', progress: 0, message: '' })
    try {
      await transformers.pipeline('feature-extraction', modelId, {
        dtype: 'q8',
        progress_callback: (info: ProgressInfo): void => {
          if (cancelledModels.has(modelId)) throw new Error('download cancelled')
          const current = localModelStatus.get(modelId)
          if (current === undefined) return
          if (info.status === 'progress' && typeof info.progress === 'number') {
            localModelStatus.set(modelId, { ...current, status: 'downloading', progress: info.progress })
          }
        },
      })
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      throw new Error(`${raw} · ${NETWORK_HINT}`)
    }
  }

  // 2. Load from the absolute cache directory: an absolute path is not a valid HF repo
  //    id, so transformers.js treats it as a local model and never touches the network.
  localModelStatus.set(modelId, { model: modelId, status: 'ready', progress: 100, message: '' })
  const pipeline = await transformers.pipeline('feature-extraction', join(localModelCacheDir(), modelId), { dtype: 'q8' })
  return async (texts: string[]): Promise<number[][]> => {
    // Pooling depends on the model family (see poolingFor) — Qwen3 takes the
    // last token, BGE takes the CLS token, GTE/E5 take the mean. transformers.js
    // slices + L2-normalizes in one step (matches Cherry Studio's pooling.ts).
    const pooling = poolingFor(modelId)
    const output = await pipeline(texts, { pooling, normalize: true })
    return output.tolist() as number[][]
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
