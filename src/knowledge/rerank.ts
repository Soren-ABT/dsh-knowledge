/**
 * Rerank step (Cherry Studio's 重排模型): re-score the merged candidates
 * against the query through a Jina / SiliconFlow / Cohere-v2 style rerank
 * API (`POST {baseUrl}/rerank`), or through a local cross-encoder
 * (bge-reranker via transformers.js in the model worker) when the model id
 * carries the `local:` prefix. Disabled when no rerank model is set.
 * @module dsh-knowledge/knowledge/rerank
 */

import { httpFetch } from './net.js'
import { rerankInLocalProcess, LocalRerankError } from './local-rerank.js'
import { assertLocalRerankerReady, localRerankActionFor } from './localModels.js'
import { getHfEndpoint, localModelCacheDir } from './embed.js'
import type { RerankErrorDetail } from './types.js'

export interface RerankCandidate {
  id: string
  text: string
}

export class RerankExecutionError extends Error {
  constructor(readonly detail: RerankErrorDetail, readonly status?: number, technicalMessage = detail.message) {
    super(technicalMessage)
    this.name = 'RerankExecutionError'
  }
}

export function rerankErrorDetail(error: unknown): RerankErrorDetail {
  if (error instanceof RerankExecutionError) return error.detail
  if (error instanceof LocalRerankError) {
    const messages: Record<LocalRerankError['code'], string> = {
      model_not_downloaded: '本地重排模型尚未下载，请先在设置 → 本地模型中下载。',
      model_checking: '本地重排模型正在下载或验证，本次使用原始检索顺序。',
      model_unhealthy: '本地重排模型未通过健康检查，请在设置中重新验证。',
      unsupported_model: '本地重排模型未登记或架构不受支持，请检查配置。',
      timeout: '本地重排超过时间预算，本次使用原始检索顺序。',
      invalid_response: '本地重排返回了无效分数，请重新验证模型。',
      runtime_error: '本地重排运行失败，本次使用原始检索顺序。',
      process_crash: '本地重排进程异常退出，本次使用原始检索顺序。',
      circuit_open: '本地重排连续失败后已临时暂停，请稍后重试。',
      busy: '本地重排队列繁忙，本次使用原始检索顺序。',
    }
    return { code: error.code, message: messages[error.code], retryable: error.retryable, action: localRerankActionFor(error.code) }
  }
  return { code: 'provider_error', message: '重排服务暂时不可用，本次使用原始检索顺序。', retryable: true, action: 'retry_later' }
}

export function rerankTechnicalMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

/**
 * Rerank candidates, choosing the local worker when the model is `local:...`.
 * @param baseUrl - API root (ignored for local rerankers).
 * @param model - rerank model id (e.g. `jina-reranker-v2-base-multilingual`
 *   or `local:Xenova/bge-reranker-base`).
 * @param topN - how many candidates the reranker should keep (Cherry asks for
 *   the final result count); defaults to all candidates.
 * @param timeoutMs - per-request timeout (default 60000). Callers on a
 *   latency-critical path (e.g. pre-step auto-retrieval) pass a short budget;
 *   a timeout degrades to the BM25 order instead of blocking the request.
 * @returns id → relevance score clamped to [0, 1], containing only the kept
 *   (top-scoring) candidates — a caller that filters on this map implements
 *   Cherry's mergeRerankResults semantics (drop what the API did not return).
 */
export async function rerankCandidates(
  baseUrl: string,
  model: string,
  apiKey: string,
  query: string,
  candidates: readonly RerankCandidate[],
  topN?: number,
  timeoutMs = 60000,
): Promise<Map<string, number>> {
  const keep = topN !== undefined
    ? Math.max(1, Math.min(Math.trunc(topN), candidates.length))
    : candidates.length
  if (model.startsWith('local:')) {
    const modelId = model.slice('local:'.length).trim()
    if (modelId === '') throw new RerankExecutionError({ code: 'unsupported_model', message: 'local rerank model id is empty', retryable: false, action: 'check_config' })
    await assertLocalRerankerReady(modelId)
    const scores = await rerankInLocalProcess(
      modelId,
      localModelCacheDir(),
      getHfEndpoint(),
      query,
      candidates.map(candidate => candidate.text),
      timeoutMs,
    )
    if (scores.length !== candidates.length || scores.some(score => !Number.isFinite(score))) {
      throw new RerankExecutionError({ code: 'invalid_response', message: 'local rerank did not return one finite score per candidate', retryable: false, action: 'run_self_test' })
    }
    const out = new Map<string, number>()
    // Cherry's mergeRerankResults: only the top-N scored candidates survive.
    const ranked = candidates
      .map((candidate, i) => ({ id: candidate.id, score: clamp01(scores[i]!), index: i }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, keep)
    for (const entry of ranked) out.set(entry.id, entry.score)
    return out
  }
  if (baseUrl.trim() === '') throw new RerankExecutionError({ code: 'provider_error', message: 'rerank base URL is empty', retryable: false, action: 'check_config' })
  const url = `${baseUrl.replace(/\/+$/, '')}/rerank`
  const response = await httpFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      query,
      documents: candidates.map(candidate => candidate.text),
      top_n: keep,
    }),
    timeoutMs,
  })
  if (!response.ok) {
    // Carry the HTTP status so callers can distinguish a persistent
    // misconfiguration (401/403/404) from a transient blip.
    await response.text()
    throw new RerankExecutionError({
      code: 'provider_error',
      message: `重排服务请求失败（HTTP ${response.status}），本次使用原始检索顺序。`,
      retryable: ![400, 401, 403, 404].includes(response.status),
      action: [400, 401, 403, 404].includes(response.status) ? 'check_config' : 'retry_later',
    }, response.status, `rerank request failed: HTTP ${response.status}`)
  }
  const json = (await response.json()) as {
    results?: Array<{ index?: number; relevance_score?: number }>
  }
  const scores = new Map<string, number>()
  for (const result of json.results ?? []) {
    const index = result.index
    const score = result.relevance_score
    if (!Number.isInteger(index) || index === undefined || index < 0 || index >= candidates.length
      || typeof score !== 'number' || !Number.isFinite(score)) {
      throw new RerankExecutionError({ code: 'invalid_response', message: 'rerank provider returned an invalid index or score', retryable: false, action: 'check_config' })
    }
    const candidate = candidates[index]!
    if (scores.has(candidate.id)) throw new RerankExecutionError({ code: 'invalid_response', message: 'rerank provider returned duplicate candidate indexes', retryable: false, action: 'check_config' })
    scores.set(candidate.id, clamp01(score))
  }
  if (candidates.length > 0 && scores.size === 0) {
    throw new RerankExecutionError({ code: 'invalid_response', message: 'rerank provider returned no scored candidates', retryable: false, action: 'check_config' })
  }
  return scores
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
