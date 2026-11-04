/** Versioned IPC contract for the isolated local embedding process. */

export const LOCAL_EMBED_PROTOCOL_VERSION = 1 as const

export type LocalEmbedOperation = 'download' | 'load' | 'embed' | 'release' | 'shutdown'
export type LocalEmbedPooling = 'last_token' | 'cls' | 'mean'

interface LocalEmbedEnvelope {
  readonly protocolVersion: typeof LOCAL_EMBED_PROTOCOL_VERSION
  readonly id: number
  readonly operation: LocalEmbedOperation
}

export interface LocalEmbedRequest extends LocalEmbedEnvelope {
  readonly modelId: string
  readonly cacheDir: string
  readonly hfEndpoint?: string
  readonly texts?: string[]
  readonly pooling?: LocalEmbedPooling
}

export interface LocalEmbedSuccess extends LocalEmbedEnvelope {
  readonly ok: true
  readonly vectors?: number[][]
}

export interface LocalEmbedFailure extends LocalEmbedEnvelope {
  readonly ok: false
  readonly error: { readonly code: 'runtime_error' | 'invalid_response'; readonly message: string; readonly retryable: boolean }
}

export interface LocalEmbedProgress {
  readonly type: 'progress'
  readonly modelId: string
  readonly status: 'idle' | 'downloading' | 'ready' | 'error'
  readonly progress: number
  readonly message: string
  readonly runtimeState?: 'unloaded' | 'loading' | 'loaded' | 'error'
  readonly loadStartedAt?: number
  readonly loadDurationMs?: number
}

export type LocalEmbedResponse = LocalEmbedSuccess | LocalEmbedFailure

export function isLocalEmbedRequest(value: unknown): value is LocalEmbedRequest {
  if (value === null || typeof value !== 'object') return false
  const request = value as Partial<LocalEmbedRequest>
  return request.protocolVersion === LOCAL_EMBED_PROTOCOL_VERSION
    && typeof request.id === 'number'
    && Number.isInteger(request.id)
    && typeof request.modelId === 'string'
    && typeof request.cacheDir === 'string'
    && ['download', 'load', 'embed', 'release', 'shutdown'].includes(String(request.operation))
}

export function isLocalEmbedResponse(value: unknown): value is LocalEmbedResponse {
  if (value === null || typeof value !== 'object') return false
  const response = value as Partial<LocalEmbedResponse>
  return response.protocolVersion === LOCAL_EMBED_PROTOCOL_VERSION
    && typeof response.id === 'number'
    && Number.isInteger(response.id)
    && ['download', 'load', 'embed', 'release', 'shutdown'].includes(String(response.operation))
    && typeof response.ok === 'boolean'
}

export function isLocalEmbedProgress(value: unknown): value is LocalEmbedProgress {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<LocalEmbedProgress>
  return event.type === 'progress'
    && typeof event.modelId === 'string'
    && ['idle', 'downloading', 'ready', 'error'].includes(String(event.status))
    && typeof event.progress === 'number'
    && typeof event.message === 'string'
    && (event.runtimeState === undefined || ['unloaded', 'loading', 'loaded', 'error'].includes(event.runtimeState))
    && (event.loadStartedAt === undefined || Number.isFinite(event.loadStartedAt))
    && (event.loadDurationMs === undefined || Number.isFinite(event.loadDurationMs) && event.loadDurationMs >= 0)
}
