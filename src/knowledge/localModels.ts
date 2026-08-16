/**
 * Local (in-process) model registry — the download/remove manager backing the
 * settings "本地模型" section, mirroring Cherry Studio's Local Models cards.
 * @module dsh-knowledge/knowledge/localModels
 */

import { cancelLocalModel, getLocalModelStatus, isLocalModelDownloaded, loadLocalModel, removeLocalModel } from './embed.js'

export interface LocalModelDescriptor {
  readonly id: string
  readonly name: string
  readonly kind: 'embedding'
  readonly subtitle: string
  /** Embedding width the model produces (for the UI and dimension checks). */
  readonly dimensions: number
  /** Practical max input length in tokens (model context window). */
  readonly maxTokens: number
}

export interface LocalModelSummary extends LocalModelDescriptor {
  readonly status: 'ready' | 'not_downloaded' | 'downloading' | 'error'
  readonly progress: number
  readonly message: string
}

/**
 * The shipped in-process models (transformers.js ONNX). All are real,
 * downloadable ONNX repos; a model's pooling strategy lives in embed.ts
 * (`poolingFor`), keyed by the same ids.
 */
export const LOCAL_MODELS: readonly LocalModelDescriptor[] = [
  {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    name: 'Qwen3 Embedding 0.6B',
    kind: 'embedding',
    subtitle: '1024 维 · 中文强 · last-token 池化',
    dimensions: 1024,
    maxTokens: 32768,
  },
  {
    id: 'Xenova/bge-small-zh-v1.5',
    name: 'BGE Small zh v1.5',
    kind: 'embedding',
    subtitle: '512 维 · 中文检索 · CLS 池化',
    dimensions: 512,
    maxTokens: 512,
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    name: 'BGE Small en v1.5',
    kind: 'embedding',
    subtitle: '384 维 · 英文检索 · CLS 池化',
    dimensions: 384,
    maxTokens: 512,
  },
  {
    id: 'Xenova/gte-small',
    name: 'GTE Small',
    kind: 'embedding',
    subtitle: '384 维 · 多语言 · mean 池化',
    dimensions: 384,
    maxTokens: 512,
  },
  {
    id: 'Xenova/multilingual-e5-small',
    name: 'Multilingual E5 Small',
    kind: 'embedding',
    subtitle: '384 维 · 多语言 · CLS 池化',
    dimensions: 384,
    maxTokens: 512,
  },
]

function findModel(id: string): LocalModelDescriptor {
  const descriptor = LOCAL_MODELS.find(model => model.id === id)
  if (descriptor === undefined) throw new Error(`unknown local model: ${id}`)
  return descriptor
}

/** Resolve a descriptor's live status, preferring in-memory state over disk. */
async function summarize(descriptor: LocalModelDescriptor): Promise<LocalModelSummary> {
  const live = getLocalModelStatus(descriptor.id)
  if (live.status === 'downloading') {
    return { ...descriptor, status: 'downloading', progress: live.progress, message: live.message }
  }
  if (live.status === 'error') {
    return { ...descriptor, status: 'error', progress: live.progress, message: live.message }
  }
  if (live.status === 'ready') {
    return { ...descriptor, status: 'ready', progress: 100, message: '' }
  }
  const downloaded = await isLocalModelDownloaded(descriptor.id)
  return { ...descriptor, status: downloaded ? 'ready' : 'not_downloaded', progress: downloaded ? 100 : 0, message: '' }
}

export async function listLocalModels(): Promise<LocalModelSummary[]> {
  return Promise.all(LOCAL_MODELS.map(summarize))
}

export async function downloadLocalModel(id: string): Promise<LocalModelSummary> {
  const descriptor = findModel(id)
  // Fire-and-forget: the download runs in the host, progress + completion are
  // observed through listLocalModels (the poller drives the UI, Cherry-style).
  void loadLocalModel(id).catch(() => {})
  return summarize(descriptor)
}

export async function cancelLocalModelDownload(id: string): Promise<LocalModelSummary> {
  const descriptor = findModel(id)
  await cancelLocalModel(id)
  return { ...descriptor, status: 'not_downloaded', progress: 0, message: '' }
}

export async function deleteLocalModel(id: string): Promise<LocalModelSummary> {
  const descriptor = findModel(id)
  await removeLocalModel(id)
  return { ...descriptor, status: 'not_downloaded', progress: 0, message: '' }
}
