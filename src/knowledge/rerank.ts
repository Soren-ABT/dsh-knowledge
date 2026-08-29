/**
 * Rerank step (Cherry Studio's 重排模型): re-score the merged candidates
 * against the query through a Jina / SiliconFlow / Cohere-v2 style rerank
 * API (`POST {baseUrl}/rerank`), or through a local cross-encoder
 * (bge-reranker via transformers.js in the model worker) when the model id
 * carries the `local:` prefix. Disabled when no rerank model is set.
 * @module dsh-knowledge/knowledge/rerank
 */

import { httpFetch } from './net.js'
import { rerankLocal } from './embed.js'

export interface RerankCandidate {
  id: string
  text: string
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
    if (modelId === '') throw new Error('local rerank model id is empty')
    const scores = await rerankLocal(modelId, query, candidates.map(candidate => candidate.text))
    const out = new Map<string, number>()
    // Cherry's mergeRerankResults: only the top-N scored candidates survive.
    const ranked = candidates
      .map((candidate, i) => ({ id: candidate.id, score: scores[i] !== undefined ? clamp01(scores[i]) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, keep)
    for (const entry of ranked) out.set(entry.id, entry.score)
    return out
  }
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
    const error = new Error(`rerank request failed: HTTP ${response.status} ${await response.text()}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  const json = (await response.json()) as {
    results?: Array<{ index?: number; relevance_score?: number }>
  }
  const scores = new Map<string, number>()
  for (const result of json.results ?? []) {
    const candidate = candidates[result.index ?? -1]
    if (candidate === undefined) continue
    scores.set(candidate.id, typeof result.relevance_score === 'number' ? clamp01(result.relevance_score) : 0)
  }
  return scores
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
