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
}

export interface LocalModelSummary extends LocalModelDescriptor {
  readonly status: 'ready' | 'not_downloaded' | 'downloading' | 'error'
  readonly progress: number
  readonly message: string
}

/** The shipped in-process models (same ONNX repo Cherry Studio ships). */
export const LOCAL_MODELS: readonly LocalModelDescriptor[] = [
  {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    name: 'Qwen3 Embedding 0.6B',
    kind: 'embedding',
    subtitle: '1024 维 · 约 0.6B · 进程内推理（transformers.js）',
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
