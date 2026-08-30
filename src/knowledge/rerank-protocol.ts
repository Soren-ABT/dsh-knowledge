/** Versioned IPC contract shared by the local-rerank parent and child. */

export const LOCAL_RERANK_PROTOCOL_VERSION = 1 as const

export type LocalRerankOperation = 'load' | 'rerank' | 'self_test' | 'dispose' | 'shutdown'

interface RequestBase {
  protocolVersion: typeof LOCAL_RERANK_PROTOCOL_VERSION
  id: number
  operation: LocalRerankOperation
  modelId: string
  cacheDir: string
  hfEndpoint?: string
}

export type LocalRerankRequest =
  | (RequestBase & { operation: 'load' })
  | (RequestBase & { operation: 'rerank'; query: string; texts: string[] })
  | (RequestBase & { operation: 'self_test' })
  | (RequestBase & { operation: 'dispose' })
  | (RequestBase & { operation: 'shutdown' })

interface ResponseBase {
  protocolVersion: typeof LOCAL_RERANK_PROTOCOL_VERSION
  id: number
  operation: LocalRerankOperation
}

export type LocalRerankSuccessResponse =
  | (ResponseBase & { ok: true; operation: 'load' | 'dispose' | 'shutdown' })
  | (ResponseBase & { ok: true; operation: 'rerank'; scores: number[] })
  | (ResponseBase & {
      ok: true
      operation: 'self_test'
      health: { healthy: true; latencyMs: number; scores: number[]; batchSize: number }
    })

export type LocalRerankFailureResponse = ResponseBase & {
  ok: false
  error: { code: string; message: string; retryable: boolean }
}

export type LocalRerankResponse = LocalRerankSuccessResponse | LocalRerankFailureResponse

export interface LocalRerankProgressEvent {
  protocolVersion: typeof LOCAL_RERANK_PROTOCOL_VERSION
  event: 'progress'
  modelId: string
  status: 'downloading' | 'validating' | 'ready' | 'error'
  progress: number
  message: string
}

export function isProgressEvent(value: unknown): value is LocalRerankProgressEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<LocalRerankProgressEvent>
  return event.protocolVersion === LOCAL_RERANK_PROTOCOL_VERSION
    && event.event === 'progress'
    && typeof event.modelId === 'string'
    && typeof event.status === 'string'
    && typeof event.progress === 'number'
    && typeof event.message === 'string'
}

export function isResponseEnvelope(value: unknown): value is LocalRerankResponse {
  if (value === null || typeof value !== 'object') return false
  const response = value as Partial<LocalRerankResponse>
  return response.protocolVersion === LOCAL_RERANK_PROTOCOL_VERSION
    && typeof response.id === 'number'
    && typeof response.operation === 'string'
    && typeof response.ok === 'boolean'
}
