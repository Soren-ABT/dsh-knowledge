/** Local embedding/reranker registry, downloads, health, and readiness records. */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import {
  cancelLocalModel,
  getHfEndpoint,
  getLocalModelStatus,
  isLocalModelDownloaded,
  loadLocalModel,
  localModelCacheDir,
  markLocalModelError,
  removeLocalModel,
} from './embed.js'
import {
  LocalRerankError,
  cancelLocalReranker,
  loadLocalReranker,
  releaseLocalReranker,
  selfTestLocalReranker,
  setLocalRerankProgressListener,
  type LocalRerankFailureCode,
} from './local-rerank.js'

export interface LocalModelDescriptor {
  readonly id: string
  readonly name: string
  readonly kind: 'embedding' | 'reranking'
  readonly subtitle: string
  readonly support?: 'official' | 'experimental'
  readonly dimensions?: number
  readonly maxTokens?: number
  readonly recommendedBatchSize?: number
}

export interface LocalModelSummary extends LocalModelDescriptor {
  readonly status: 'ready' | 'not_downloaded' | 'downloading' | 'validating' | 'unhealthy' | 'error'
  readonly health: 'unchecked' | 'checking' | 'healthy' | 'unhealthy'
  readonly progress: number
  readonly message: string
  readonly lastCheckedAt?: number
  readonly latencyMs?: number
}

interface ReadinessRecord {
  schemaVersion: 1
  modelId: string
  kind: 'reranking'
  support: 'official' | 'experimental'
  fingerprint: string
  validatedAt: number
  latencyMs: number
  runtime: { transformers: '3.7.x'; onnxruntime: '1.21.0' }
}

interface CustomRegistry {
  schemaVersion: 1
  rerankers: Array<{ id: string; addedAt: number }>
}

interface LiveRerankStatus {
  status: LocalModelSummary['status']
  health: LocalModelSummary['health']
  progress: number
  message: string
  lastCheckedAt?: number
  latencyMs?: number
}

const REGISTRY_FILE = '.dsh-rerank-models.json'
const READY_FILE = '.dsh-rerank-ready.json'
const liveRerankStatus = new Map<string, LiveRerankStatus>()
const cancelledRerankers = new Set<string>()
const readinessCache = new Map<string, { cacheDir: string; record: ReadinessRecord }>()
let registryWriteChain: Promise<void> = Promise.resolve()

export const LOCAL_MODELS: readonly LocalModelDescriptor[] = [
  { id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', name: 'Qwen3 Embedding 0.6B', kind: 'embedding', subtitle: '1024 维 · 中文强 · last-token 池化', dimensions: 1024, maxTokens: 32768 },
  { id: 'Xenova/bge-small-zh-v1.5', name: 'BGE Small zh v1.5', kind: 'embedding', subtitle: '512 维 · 中文检索 · CLS 池化', dimensions: 512, maxTokens: 512 },
  { id: 'Xenova/bge-small-en-v1.5', name: 'BGE Small en v1.5', kind: 'embedding', subtitle: '384 维 · 英文检索 · CLS 池化', dimensions: 384, maxTokens: 512 },
  { id: 'Xenova/gte-small', name: 'GTE Small', kind: 'embedding', subtitle: '384 维 · 多语言 · mean 池化', dimensions: 384, maxTokens: 512 },
  { id: 'Xenova/multilingual-e5-small', name: 'Multilingual E5 Small', kind: 'embedding', subtitle: '384 维 · 多语言 · CLS 池化', dimensions: 384, maxTokens: 512 },
  {
    id: 'Xenova/bge-reranker-base', name: 'BGE Reranker Base', kind: 'reranking', support: 'official',
    subtitle: '本地重排 · 单 logit 跨编码器 · sigmoid · 双语（约 280MB）', maxTokens: 512, recommendedBatchSize: 16,
  },
]

setLocalRerankProgressListener(event => {
  liveRerankStatus.set(event.modelId, {
    status: event.status === 'ready' ? 'ready' : event.status,
    health: event.status === 'ready' ? 'healthy' : event.status === 'validating' ? 'checking' : event.status === 'error' ? 'unhealthy' : 'unchecked',
    progress: event.progress,
    message: event.message,
  })
})

export function validateHuggingFaceRepoId(id: string): string {
  const normalized = id.trim()
  if (normalized.length < 3 || normalized.length > 200 || normalized.includes('..') || normalized.includes('\\')
    || normalized.startsWith('/') || normalized.endsWith('/')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(normalized)) {
    throw new Error('invalid Hugging Face repository id; expected "owner/model" without paths or ".."')
  }
  return normalized
}

function customRegistryPath(): string { return join(localModelCacheDir(), REGISTRY_FILE) }
function readinessPath(modelId: string): string { return join(localModelCacheDir(), modelId, READY_FILE) }

async function readRegistry(): Promise<CustomRegistry> {
  try {
    const parsed = JSON.parse(await readFile(customRegistryPath(), 'utf8')) as Partial<CustomRegistry>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.rerankers)) return { schemaVersion: 1, rerankers: [] }
    return {
      schemaVersion: 1,
      rerankers: parsed.rerankers.filter(entry => entry !== null && typeof entry === 'object'
        && typeof entry.id === 'string' && typeof entry.addedAt === 'number'),
    }
  } catch {
    return { schemaVersion: 1, rerankers: [] }
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function writeRegistry(update: (registry: CustomRegistry) => void): Promise<void> {
  const run = registryWriteChain.then(async () => {
    const registry = await readRegistry()
    update(registry)
    await writeJsonAtomic(customRegistryPath(), registry)
  })
  registryWriteChain = run.catch(() => {})
  return run
}

async function descriptors(): Promise<LocalModelDescriptor[]> {
  const registry = await readRegistry()
  const custom = registry.rerankers
    .filter(entry => !LOCAL_MODELS.some(model => model.id === entry.id))
    .map(entry => ({
      id: entry.id, name: basename(entry.id), kind: 'reranking' as const, support: 'experimental' as const,
      subtitle: '自定义本地重排 · 实验性 · 需要兼容性验证', maxTokens: 512, recommendedBatchSize: 16,
    }))
  return [...LOCAL_MODELS, ...custom]
}

async function findModel(id: string): Promise<LocalModelDescriptor> {
  const descriptor = (await descriptors()).find(model => model.id === id)
  if (descriptor === undefined) throw new Error(`unknown local model: ${id}`)
  return descriptor
}

async function modelFingerprint(modelId: string): Promise<{ fingerprint: string; complete: boolean }> {
  const root = join(localModelCacheDir(), modelId)
  const entries: Array<{ path: string; size: number; mtimeMs: number }> = []
  let hasConfig = false
  let hasTokenizer = false
  let hasWeights = false
  async function walk(dir: string): Promise<void> {
    const children = await readdir(dir, { withFileTypes: true })
    for (const child of children) {
      if (child.name === READY_FILE) continue
      const path = join(dir, child.name)
      if (child.isDirectory()) await walk(path)
      else if (child.isFile()) {
        const info = await stat(path)
        const rel = relative(root, path).replaceAll('\\', '/')
        entries.push({ path: rel, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
        if (rel === 'config.json') hasConfig = info.size > 0
        if (/tokenizer|vocab|sentencepiece|spiece/i.test(rel)) hasTokenizer ||= info.size > 0
        if (rel.endsWith('.onnx')) hasWeights ||= info.size > 0
      }
    }
  }
  try { await walk(root) } catch { return { fingerprint: '', complete: false } }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), complete: hasConfig && hasTokenizer && hasWeights }
}

async function readReadiness(modelId: string): Promise<ReadinessRecord | undefined> {
  const cacheDir = localModelCacheDir()
  const cached = readinessCache.get(modelId)
  if (cached?.cacheDir === cacheDir) return cached.record
  try {
    const record = JSON.parse(await readFile(readinessPath(modelId), 'utf8')) as ReadinessRecord
    if (record.schemaVersion !== 1 || record.modelId !== modelId || record.kind !== 'reranking'
      || record.runtime?.transformers !== '3.7.x' || record.runtime?.onnxruntime !== '1.21.0') return undefined
    const current = await modelFingerprint(modelId)
    if (!current.complete || current.fingerprint !== record.fingerprint) return undefined
    readinessCache.set(modelId, { cacheDir, record })
    return record
  } catch { return undefined }
}

async function writeReadiness(descriptor: LocalModelDescriptor, latencyMs: number): Promise<ReadinessRecord> {
  const files = await modelFingerprint(descriptor.id)
  if (!files.complete) throw new Error('local rerank model cache is incomplete')
  const record: ReadinessRecord = {
    schemaVersion: 1, modelId: descriptor.id, kind: 'reranking', support: descriptor.support ?? 'experimental',
    fingerprint: files.fingerprint, validatedAt: Date.now(), latencyMs,
    runtime: { transformers: '3.7.x', onnxruntime: '1.21.0' },
  }
  await writeJsonAtomic(readinessPath(descriptor.id), record)
  readinessCache.set(descriptor.id, { cacheDir: localModelCacheDir(), record })
  return record
}

async function summarize(descriptor: LocalModelDescriptor): Promise<LocalModelSummary> {
  if (descriptor.kind === 'embedding') {
    const live = getLocalModelStatus(descriptor.id)
    if (live.status === 'downloading' || live.status === 'error') {
      return { ...descriptor, status: live.status, health: live.status === 'error' ? 'unhealthy' : 'unchecked', progress: live.progress, message: live.message }
    }
    const downloaded = live.status === 'ready' || await isLocalModelDownloaded(descriptor.id)
    return { ...descriptor, status: downloaded ? 'ready' : 'not_downloaded', health: downloaded ? 'healthy' : 'unchecked', progress: downloaded ? 100 : 0, message: '' }
  }
  const live = liveRerankStatus.get(descriptor.id)
  if (live !== undefined && live.status !== 'ready') return { ...descriptor, ...live }
  const files = await modelFingerprint(descriptor.id)
  if (!files.complete) return { ...descriptor, status: 'not_downloaded', health: 'unchecked', progress: 0, message: '' }
  const ready = await readReadiness(descriptor.id)
  if (ready === undefined) return { ...descriptor, status: 'unhealthy', health: 'unchecked', progress: 100, message: '模型已下载，使用前需要完成兼容性验证' }
  return { ...descriptor, status: 'ready', health: 'healthy', progress: 100, message: '', lastCheckedAt: ready.validatedAt, latencyMs: ready.latencyMs }
}

export async function listLocalModels(): Promise<LocalModelSummary[]> { return Promise.all((await descriptors()).map(summarize)) }

export function hasActiveLocalRerankDownload(): boolean {
  for (const status of liveRerankStatus.values()) if (status.status === 'downloading' || status.status === 'validating') return true
  return false
}

async function validateReranker(descriptor: LocalModelDescriptor): Promise<LocalModelSummary> {
  liveRerankStatus.set(descriptor.id, { status: 'validating', health: 'checking', progress: 100, message: '' })
  try {
    const report = await selfTestLocalReranker(descriptor.id, localModelCacheDir(), getHfEndpoint())
    const record = await writeReadiness(descriptor, report.latencyMs)
    liveRerankStatus.set(descriptor.id, { status: 'ready', health: 'healthy', progress: 100, message: '', lastCheckedAt: record.validatedAt, latencyMs: record.latencyMs })
  } catch (error) {
    liveRerankStatus.set(descriptor.id, { status: 'unhealthy', health: 'unhealthy', progress: 100, message: error instanceof Error ? error.message : String(error) })
  }
  return summarize(descriptor)
}

export async function selfTestLocalModel(id: string): Promise<LocalModelSummary> {
  const descriptor = await findModel(id)
  if (descriptor.kind !== 'reranking') throw new Error('self-test is available only for local rerankers')
  return validateReranker(descriptor)
}

export async function downloadLocalModel(id: string): Promise<LocalModelSummary> {
  const descriptor = await findModel(id)
  if (descriptor.kind === 'embedding') {
    void loadLocalModel(id, 'feature-extraction').catch((error: unknown) => markLocalModelError(descriptor.id, error instanceof Error ? error.message : String(error)))
    return summarize(descriptor)
  }
  liveRerankStatus.set(id, { status: 'downloading', health: 'unchecked', progress: 0, message: '' })
  cancelledRerankers.delete(id)
  void loadLocalReranker(id, localModelCacheDir(), getHfEndpoint())
    .then(() => validateReranker(descriptor))
    .catch((error: unknown) => {
      if (cancelledRerankers.delete(id)) return
      liveRerankStatus.set(id, { status: 'error', health: 'unhealthy', progress: 0, message: error instanceof Error ? error.message : String(error) })
    })
  return summarize(descriptor)
}

export async function registerCustomLocalReranker(id: string): Promise<LocalModelSummary> {
  const normalized = validateHuggingFaceRepoId(id)
  await writeRegistry(registry => {
    if (!registry.rerankers.some(entry => entry.id === normalized)) registry.rerankers.push({ id: normalized, addedAt: Date.now() })
  })
  return downloadLocalModel(normalized)
}

export async function cancelLocalModelDownload(id: string): Promise<LocalModelSummary> {
  const descriptor = await findModel(id)
  if (descriptor.kind === 'embedding') await cancelLocalModel(id)
  else {
    cancelledRerankers.add(id)
    await cancelLocalReranker(id)
    liveRerankStatus.delete(id)
    readinessCache.delete(id)
    await rm(join(localModelCacheDir(), id), { recursive: true, force: true }).catch(() => {})
  }
  return { ...descriptor, status: 'not_downloaded', health: 'unchecked', progress: 0, message: '' }
}

export async function deleteLocalModel(id: string): Promise<LocalModelSummary> {
  const descriptor = await findModel(id)
  if (descriptor.kind === 'embedding') await removeLocalModel(id)
  else {
    await releaseLocalReranker(id, localModelCacheDir(), getHfEndpoint())
    await rm(join(localModelCacheDir(), id), { recursive: true, force: true })
    liveRerankStatus.delete(id)
    cancelledRerankers.delete(id)
    readinessCache.delete(id)
    if (descriptor.support === 'experimental') await writeRegistry(registry => { registry.rerankers = registry.rerankers.filter(entry => entry.id !== id) })
  }
  return { ...descriptor, status: 'not_downloaded', health: 'unchecked', progress: 0, message: '' }
}

export async function assertLocalRerankerReady(modelId: string): Promise<void> {
  let descriptor: LocalModelDescriptor
  try { descriptor = await findModel(modelId) } catch {
    throw new LocalRerankError('unsupported_model', '本地重排模型尚未登记，请在设置 → 本地模型中添加并验证', false)
  }
  if (descriptor.kind !== 'reranking') throw new LocalRerankError('unsupported_model', '所选本地模型不是重排模型', false)
  const live = liveRerankStatus.get(modelId)
  if (live?.status === 'downloading' || live?.status === 'validating') throw new LocalRerankError('model_checking', '本地重排模型正在下载或验证，请稍后重试', true)
  if (live?.status === 'unhealthy' || live?.status === 'error') throw new LocalRerankError('model_unhealthy', '本地重排模型验证失败，请在设置中重新验证', false)
  const files = await modelFingerprint(modelId)
  if (!files.complete) throw new LocalRerankError('model_not_downloaded', '本地重排模型尚未下载，请在设置 → 本地模型中下载', false)
  if (await readReadiness(modelId) === undefined) throw new LocalRerankError('model_unhealthy', '本地重排模型尚未通过兼容性验证，请在设置中运行自检', false)
}

export function localRerankActionFor(code: LocalRerankFailureCode): 'download_model' | 'run_self_test' | 'check_config' | 'retry_later' {
  if (code === 'model_not_downloaded') return 'download_model'
  if (code === 'model_checking' || code === 'model_unhealthy') return 'run_self_test'
  if (code === 'unsupported_model') return 'check_config'
  return 'retry_later'
}
