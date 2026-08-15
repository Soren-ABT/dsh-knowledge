/**
 * Rerank step (Cherry Studio's 重排模型): re-score the merged candidates
 * against the query through a Jina / SiliconFlow / Cohere-v2 style rerank
 * API (`POST {baseUrl}/rerank`). Disabled when no rerank model is set.
 * @module dsh-knowledge/knowledge/rerank
 */

export interface RerankCandidate {
  id: string
  text: string
}

/**
 * Rerank candidates with a cross-encoder API.
 * @param baseUrl - API root; may include a version prefix (e.g. `https://api.jina.ai/v1`).
 * @param model - rerank model id (e.g. `jina-reranker-v2-base-multilingual`).
 * @returns id → relevance score clamped to [0, 1].
 */
export async function rerankCandidates(
  baseUrl: string,
  model: string,
  apiKey: string,
  query: string,
  candidates: readonly RerankCandidate[],
): Promise<Map<string, number>> {
  const url = `${baseUrl.replace(/\/+$/, '')}/rerank`
  const response = await fetch(url, {
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
