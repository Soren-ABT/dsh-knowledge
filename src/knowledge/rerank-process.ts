/** Dedicated local cross-encoder process. Never imported by the host. */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { applyGlobalProxy, NETWORK_HINT } from './net.js'
import { CrossEncoderResponseError, scoreCrossEncoder } from './rerank-adapter.js'
import {
  LOCAL_RERANK_PROTOCOL_VERSION,
  type LocalRerankFailureResponse,
  type LocalRerankProgressEvent,
  type LocalRerankRequest,
  type LocalRerankSuccessResponse,
} from './rerank-protocol.js'

applyGlobalProxy()

interface TransformersModule {
  env: { allowLocalModels: boolean; allowRemoteModels?: boolean; cacheDir?: string; remoteHost?: string }
  AutoModel: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<{
      (inputs: Record<string, unknown>): Promise<{ logits?: { data?: ArrayLike<number>; dims?: number[] } }>
      dispose?(): Promise<void>
    }>
  }
  AutoTokenizer: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<
      (texts: string[], options: { text_pair: string[]; padding: true; truncation: true }) => Promise<Record<string, unknown>>
    >
  }
}

interface Runner {
  modelId: string
  rerank(query: string, texts: readonly string[]): Promise<number[]>
  dispose(): Promise<void>
  batchSize(): number
}

let transformers: TransformersModule | null = null
let activeRunner: Runner | null = null
let operationChain: Promise<unknown> = Promise.resolve()

function post(message: LocalRerankSuccessResponse | LocalRerankFailureResponse | LocalRerankProgressEvent): void {
  if (typeof process.send === 'function') process.send(message)
}

function progress(modelId: string, status: LocalRerankProgressEvent['status'], value: number, message = ''): void {
  post({
    protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION,
    event: 'progress',
    modelId,
    status,
    progress: value,
    message,
  })
}

async function loadTransformers(): Promise<TransformersModule> {
  if (transformers !== null) return transformers
  transformers = (await import('@huggingface/transformers')) as unknown as TransformersModule
  return transformers
}

async function hasOnnxWeights(modelId: string, cacheDir: string): Promise<boolean> {
  try {
    const names = await readdir(join(cacheDir, modelId, 'onnx'))
    for (const name of names) {
      if (!name.endsWith('.onnx')) continue
      const info = await stat(join(cacheDir, modelId, 'onnx', name))
      if (info.isFile() && info.size > 0) return true
    }
  } catch {
    return false
  }
  return false
}

function applyEndpoint(tf: TransformersModule, endpoint: string | undefined): void {
  if (endpoint !== undefined && endpoint.trim() !== '') {
    tf.env.remoteHost = endpoint.trim().replace(/\/+$/, '')
  }
}

async function disposeRunner(): Promise<void> {
  const runner = activeRunner
  activeRunner = null
  await runner?.dispose().catch(() => {})
}

async function createRunner(request: LocalRerankRequest): Promise<Runner> {
  const tf = await loadTransformers()
  applyEndpoint(tf, request.hfEndpoint)
  tf.env.cacheDir = request.cacheDir
  tf.env.allowLocalModels = true

  if (!(await hasOnnxWeights(request.modelId, request.cacheDir))) {
    tf.env.allowRemoteModels = true
    progress(request.modelId, 'downloading', 0)
    let lastProgressAt = 0
    const progressCallback = (info: { status?: string; progress?: number }): void => {
      if (info.status !== 'progress' || typeof info.progress !== 'number') return
      const now = Date.now()
      if (now - lastProgressAt < 250) return
      lastProgressAt = now
      progress(request.modelId, 'downloading', info.progress)
    }
    let downloadedModel: Awaited<ReturnType<TransformersModule['AutoModel']['from_pretrained']>> | undefined
    try {
      downloadedModel = await tf.AutoModel.from_pretrained(request.modelId, {
        dtype: 'q8',
        progress_callback: progressCallback,
        trust_remote_code: false,
      })
      await tf.AutoTokenizer.from_pretrained(request.modelId, {
        progress_callback: progressCallback,
        trust_remote_code: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      progress(request.modelId, 'error', 0, `${message} · ${NETWORK_HINT}`)
      throw error
    } finally {
      await downloadedModel?.dispose?.().catch(() => {})
    }
  }

  progress(request.modelId, 'validating', 100)
  tf.env.allowRemoteModels = false
  const localPath = join(request.cacheDir, request.modelId)
  const model = await tf.AutoModel.from_pretrained(localPath, { dtype: 'q8', local_files_only: true, trust_remote_code: false })
  const tokenizer = await tf.AutoTokenizer.from_pretrained(localPath, { local_files_only: true, trust_remote_code: false })
  let safeBatchSize = 16
  return {
    modelId: request.modelId,
    async rerank(query, texts) {
      const result = await scoreCrossEncoder(tokenizer, model, query, texts, safeBatchSize)
      safeBatchSize = result.batchSize
      return result.scores
    },
    async dispose() { await model.dispose?.() },
    batchSize: () => safeBatchSize,
  }
}

async function ensureRunner(request: LocalRerankRequest): Promise<Runner> {
  if (activeRunner?.modelId === request.modelId) return activeRunner
  await disposeRunner()
  activeRunner = await createRunner(request)
  return activeRunner
}

async function selfTest(request: LocalRerankRequest): Promise<{ healthy: true; latencyMs: number; scores: number[]; batchSize: number }> {
  const runner = await ensureRunner(request)
  const startedAt = Date.now()
  const scores = await runner.rerank('如何申请费用报销？', [
    '费用报销需要提交发票并经过负责人审批。',
    '今天的天气晴朗，适合户外散步。',
  ])
  if (scores.length !== 2 || scores.some(score => !Number.isFinite(score))) {
    throw new CrossEncoderResponseError('rerank self-test returned invalid scores')
  }
  if (!(scores[0]! > scores[1]!) || Math.abs(scores[0]! - scores[1]!) < 1e-6) {
    throw new CrossEncoderResponseError('rerank self-test did not distinguish relevant and irrelevant text')
  }
  const health = { healthy: true as const, latencyMs: Date.now() - startedAt, scores, batchSize: runner.batchSize() }
  progress(request.modelId, 'ready', 100)
  return health
}

async function handle(request: LocalRerankRequest): Promise<LocalRerankSuccessResponse> {
  if (request.protocolVersion !== LOCAL_RERANK_PROTOCOL_VERSION) throw new CrossEncoderResponseError('unsupported local rerank protocol version')
  if (request.operation === 'shutdown') {
    await disposeRunner()
    return { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id: request.id, operation: 'shutdown', ok: true }
  }
  if (request.operation === 'dispose') {
    await disposeRunner()
    return { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id: request.id, operation: 'dispose', ok: true }
  }
  if (request.operation === 'load') {
    await ensureRunner(request)
    return { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id: request.id, operation: 'load', ok: true }
  }
  if (request.operation === 'self_test') {
    return { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id: request.id, operation: 'self_test', ok: true, health: await selfTest(request) }
  }
  const runner = await ensureRunner(request)
  const scores = await runner.rerank(request.query, request.texts)
  return { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id: request.id, operation: 'rerank', ok: true, scores }
}

function failure(request: LocalRerankRequest, error: unknown): LocalRerankFailureResponse {
  const code = error instanceof CrossEncoderResponseError ? 'invalid_response' : 'runtime_error'
  return {
    protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION,
    id: request.id,
    operation: request.operation,
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error), retryable: code !== 'invalid_response' },
  }
}

process.on('message', (message: LocalRerankRequest) => {
  operationChain = operationChain
    .then(async () => {
      try {
        const response = await handle(message)
        post(response)
        if (message.operation === 'shutdown') process.exit(0)
      } catch (error) {
        post(failure(message, error))
      }
    })
    .catch(() => {})
})

process.on('disconnect', () => {
  void disposeRunner().finally(() => process.exit(0))
})
