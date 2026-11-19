import { estimateContextTokens, serializeContextWindow } from './context-protocol.js'
import { localRerankChildIsWarm } from './local-rerank.js'
import { throwIfAborted } from './net.js'
import { rerankCandidates, rerankErrorDetail, rerankTechnicalMessage } from './rerank.js'
import { attachContextWindows } from './search-context.js'
import type { Store } from './store.js'
import { snapSliceEnd, snapSliceStart } from './text-safety.js'
import type { KnowledgeConfig, RerankErrorDetail, RerankStatus, SearchHit } from './types.js'

/** Extra deadline granted to a COLD local rerank child so its model load is not
 *  charged to the inference budget of the query that triggered it (issue #18). */
const LOCAL_RERANK_LOAD_ALLOWANCE_MS = 120_000

const RERANK_EVIDENCE_TOKENS = 352
const RERANK_QUERY_TOKENS = 128
const RERANK_TITLE_TOKENS = 64

export class SearchReranker {
  private readonly rerankLogState = new Map<string, string>()

  constructor(private readonly warn: (message: string) => void) {}

  /** One canonical rerank stage for both single-query retrieval and RRF-fused
   * multi-query retrieval. It owns contextual input, deadline/retry policy,
   * stable tie handling, structured degradation, and original-order fallback. */
  async apply(
    store: Store,
    config: KnowledgeConfig,
    query: string,
    input: readonly SearchHit[],
    topK: number,
    allowRerank: boolean,
    signal?: AbortSignal,
  ): Promise<{ hits: SearchHit[]; reranked: boolean; rerank?: RerankStatus }> {
    throwIfAborted(signal)
    const original = [...input]
    const rerankModel = allowRerank ? config.rerankModel.trim() : ''
    if (rerankModel === '') return { hits: original, reranked: false }
    if (original.length <= 1) {
      return {
        hits: original,
        reranked: false,
        rerank: this.notNeededRerankStatus(rerankModel, original.length),
      }
    }

    const rerankQuery = fitRerankQuery(query)
    const contextual = attachContextWindows(
      store,
      original,
      query,
      config.siblingChunks,
      RERANK_EVIDENCE_TOKENS,
      hit => rerankTitleReserve(hit.documentTitle),
    )
    const candidateCount = contextual.length
    const rerankStartedAt = Date.now()
    // A cold local child loads ~280MB before it can score anything, and that load
    // shares this single deadline with the inference it precedes. Without an
    // allowance the first query after a restart (or after an idle release) could
    // be killed mid-load, which used to latch the readiness gate and leave the
    // reranker unusable until a manual self-test (issue #18). The allowance is
    // granted only when the child has not scored anything yet.
    const rerankTimeoutMs = rerankModel.startsWith('local:')
      ? config.localRerankTimeoutMs + (localRerankChildIsWarm() ? 0 : LOCAL_RERANK_LOAD_ALLOWANCE_MS)
      : 60_000
    try {
      const scores = await rerankCandidates(
        config.rerankBaseUrl,
        config.rerankModel,
        config.rerankApiKey,
        rerankQuery,
        contextual.map(hit => ({
          id: hit.chunkId,
          text: rerankEvidenceText(hit),
        })),
        {
          topN: topK,
          timeoutMs: rerankTimeoutMs,
          deadlineAt: rerankStartedAt + rerankTimeoutMs,
          retries: rerankModel.startsWith('local:') ? 0 : 1,
          ...(signal !== undefined ? { signal } : {}),
        },
      )
      throwIfAborted(signal)
      const order = new Map(contextual.map((hit, index) => [hit.chunkId, index]))
      const rescored = contextual
        .filter(hit => scores.has(hit.chunkId))
        .map(hit => ({ ...hit, score: scores.get(hit.chunkId)! }))
        .sort((left, right) => right.score - left.score
          || (order.get(left.chunkId) ?? 0) - (order.get(right.chunkId) ?? 0))
      // rerankCandidates rejects an empty response, but retain this defensive
      // branch for custom/test providers so an empty set never erases hits.
      if (rescored.length === 0) {
        const detail: RerankErrorDetail = {
          code: 'invalid_response',
          message: 'rerank provider returned no scored candidates',
          retryable: false,
          action: 'check_config',
        }
        const rerank = this.degradedRerankStatus(rerankModel, candidateCount, Date.now() - rerankStartedAt, detail)
        this.logRerankFailure(rerankModel, detail.code, candidateCount, rerank.elapsedMs ?? 0, detail.message)
        return { hits: original, reranked: false, rerank }
      }
      this.rerankLogState.delete(rerankModel)
      return {
        hits: rescored,
        reranked: true,
        rerank: this.appliedRerankStatus(rerankModel, candidateCount, Date.now() - rerankStartedAt),
      }
    } catch (error) {
      throwIfAborted(signal)
      const detail = rerankErrorDetail(error)
      const rerank = this.degradedRerankStatus(rerankModel, candidateCount, Date.now() - rerankStartedAt, detail)
      this.logRerankFailure(rerankModel, detail.code, candidateCount, rerank.elapsedMs ?? 0, rerankTechnicalMessage(error))
      return { hits: original, reranked: false, rerank }
    }
  }

  private rerankProvider(model: string): 'local' | 'remote' {
    return model.startsWith('local:') ? 'local' : 'remote'
  }

  private notNeededRerankStatus(model: string, candidateCount: number): RerankStatus {
    return {
      configured: true,
      provider: this.rerankProvider(model),
      model,
      status: 'not_needed',
      attempted: false,
      applied: false,
      candidateCount,
    }
  }

  private appliedRerankStatus(model: string, candidateCount: number, elapsedMs: number): RerankStatus {
    return {
      configured: true,
      provider: this.rerankProvider(model),
      model,
      status: 'applied',
      attempted: true,
      applied: true,
      candidateCount,
      elapsedMs,
    }
  }

  private degradedRerankStatus(model: string, candidateCount: number, elapsedMs: number, error: RerankErrorDetail): RerankStatus {
    const skipped = ['model_not_downloaded', 'model_checking', 'model_unhealthy', 'unsupported_model', 'circuit_open', 'busy'].includes(error.code)
    return {
      configured: true,
      provider: this.rerankProvider(model),
      model,
      // A gate refusal is not a degradation: nothing was attempted, so say so
      // and omit the elapsed time rather than reporting a failure at 0ms.
      status: skipped ? 'skipped' : 'degraded',
      attempted: !skipped,
      applied: false,
      candidateCount,
      ...(skipped ? {} : { elapsedMs }),
      error,
    }
  }

  private logRerankFailure(model: string, code: string, candidateCount: number, elapsedMs: number, technicalMessage: string): void {
    if (this.rerankLogState.get(model) === code) return
    this.rerankLogState.set(model, code)
    this.warn(`rerank degraded model=${JSON.stringify(model)} code=${code} candidates=${candidateCount} elapsedMs=${elapsedMs} detail=${JSON.stringify(technicalMessage)}`)
  }
}

/** Deterministically retain both the intent at the start and qualifiers at the
 * end of an oversized rerank query. The estimator is the same one used for
 * evidence, so the pair budget remains enforceable without a model download. */
function fitRerankQuery(query: string): string {
  if (estimateContextTokens(query) <= RERANK_QUERY_TOKENS) return query
  let low = 0
  let high = query.length
  let best = ''
  while (low <= high) {
    const retained = Math.floor((low + high) / 2)
    const head = Math.ceil(retained * 0.6)
    const tail = retained - head
    const headEnd = snapSliceEnd(query, head)
    const tailStart = snapSliceStart(query, query.length - tail)
    const candidate = `${query.slice(0, headEnd).trimEnd()} … ${query.slice(tailStart).trimStart()}`
    if (estimateContextTokens(candidate) <= RERANK_QUERY_TOKENS) {
      best = candidate
      low = retained + 1
    } else {
      high = retained - 1
    }
  }
  return best || query.slice(0, snapSliceEnd(query, 1))
}

/** Bound untrusted document metadata before it enters the cross-encoder pair.
 * The title remains useful for disambiguation, but can never crowd the
 * query-centred anchor out of the fixed 352-token evidence budget. */
function fitRerankTitle(title: string): string {
  const trimmed = title.trim()
  if (estimateContextTokens(trimmed) <= RERANK_TITLE_TOKENS) return trimmed
  let low = 0
  let high = trimmed.length
  let best = ''
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = `${trimmed.slice(0, snapSliceEnd(trimmed, length)).trimEnd()}…`
    if (estimateContextTokens(candidate) <= RERANK_TITLE_TOKENS) {
      best = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return best
}

function rerankTitleReserve(title: string): number {
  const fitted = fitRerankTitle(title)
  return fitted.length === 0 ? 0 : estimateContextTokens(`${fitted}\n`)
}

function rerankEvidenceText(hit: SearchHit): string {
  const title = fitRerankTitle(hit.documentTitle)
  const evidence = hit.contextWindow !== undefined ? serializeContextWindow(hit.contextWindow) : hit.text
  const combined = title.length === 0 ? evidence : `${title}\n${evidence}`
  // attachContextWindows reserved the exact fitted-title cost. Keep this
  // defensive assertion local so a future serializer change degrades rerank
  // instead of silently violating the public pair budget.
  if (estimateContextTokens(combined) > RERANK_EVIDENCE_TOKENS) {
    throw new Error('rerank evidence exceeded the 352-token budget')
  }
  return combined
}
