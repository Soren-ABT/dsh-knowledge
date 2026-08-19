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
 * @returns id → relevance score clamped to [0, 1].
 */
export async function rerankCandidates(
  baseUrl: string,
  model: string,
  apiKey: string,
  query: string,
  candidates: readonly RerankCandidate[],
): Promise<Map<string, number>> {
  if (model.startsWith('local:')) {
    const modelId = model.slice('local:'.length).trim()
    if (modelId === '') throw new Error('local rerank model id is empty')
    const scores = await rerankLocal(modelId, query, candidates.map(candidate => candidate.text))
    const out = new Map<string, number>()
    for (let i = 0; i < candidates.length && i < scores.length; i += 1) {
      out.set(candidates[i].id, clamp01(scores[i]))
    }
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
      top_n: candidates.length,
    }),
    timeoutMs: 60000,
  })
  if (!response.ok) {
    throw new Error(`rerank request failed: HTTP ${response.status} ${await response.text()}`)
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
