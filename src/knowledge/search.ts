import { clampInt } from './bounds.js'
import type { RetrievalDocumentFilter } from './chunkdb.js'
import { DEFAULT_LOCAL_MODEL, embedTexts, isLocalModelDownloaded } from './embed.js'
import { throwIfAborted } from './net.js'
import { maximalMarginalRelevance, rank, reciprocalRankFusion, RRF_K, searchTextOf, type RankedHit } from './retrieval.js'
import { attachContextWindows, searchHitOf } from './search-context.js'
import { SearchReranker } from './search-rerank.js'
import type { Store } from './store.js'
import type {
  KnowledgeChunk, KnowledgeConfig, RetrievalStatus, SearchHit, SearchMode, SearchRequest, SearchResult, SearchScoreKind,
} from './types.js'

/** Per-call execution controls that are deliberately kept out of the public
 * search request/HTTP contract. Proactive retrieval uses these controls to
 * obtain lexical candidates without accidentally invoking a configured
 * reranker. */
export interface SearchExecutionOptions {
  readonly rerank?: 'configured' | 'skip'
  readonly signal?: AbortSignal
  /** Absolute deadline for synchronous retrieval lanes. Internal callers use
   * this alongside signal so SQLite can interrupt itself while JS is blocked. */
  readonly deadlineAt?: number
}

/** Candidate-pool cap for SQL retrieval lanes, bounding FTS + brute-force vector scans. */
const LANE_CANDIDATE_CAP = 200

const SEARCH_EVIDENCE_TOKENS = 768

export class KnowledgeSearch {
  private readonly reranker: SearchReranker

  constructor(
    private readonly getStore: () => Store,
    private readonly getConfigFor: (baseId?: string) => KnowledgeConfig,
    private readonly warn: (message: string) => void,
  ) {
    this.reranker = new SearchReranker(warn)
  }

  async search(request: SearchRequest, execution: SearchExecutionOptions = {}): Promise<SearchResult> {
    const startedAt = Date.now()
    throwIfAborted(execution.signal)
    throwIfDeadline(execution.deadlineAt)
    const query = request.query.trim()
    if (query.length === 0) return emptySearchResult(query, request.mode ?? 'lexical', 0)
    if (query.length > 2000) throw new Error('search query must not exceed 2000 characters')

    const variants = normalizeQueryVariants(query, request.queries)
    const allowRerank = execution.rerank !== 'skip'
    if (variants.length === 1) {
      return this.searchSingle({ ...request, query, queries: undefined }, allowRerank, startedAt, execution.signal, execution.deadlineAt)
    }

    const config = this.getConfigFor(request.baseId)
    const requestedMode = request.mode ?? config.searchMode
    const topK = clampInt(request.topK ?? config.topK, 1, 50, 6)
    const subTopK = Math.min(50, Math.max(topK * 2, 12))
    const results = await Promise.all(variants.map(variant => this.searchSingle({
      ...request,
      query: variant,
      queries: undefined,
      topK: subTopK,
    }, false, startedAt, execution.signal, execution.deadlineAt)))
    throwIfAborted(execution.signal)
    return this.finishMultiQuerySearch(config, query, requestedMode, results, topK, request.threshold, startedAt, allowRerank, execution.signal)
  }

  /** One retrieval pass. Multi-query orchestration lives in search() so each
   * variant cannot independently invoke an expensive reranker. */
  private async searchSingle(
    request: SearchRequest,
    allowRerank: boolean,
    startedAt: number,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<SearchResult> {
    throwIfAborted(signal)
    throwIfDeadline(deadlineAt)
    const store = this.getStore()
    const config = this.getConfigFor(request.baseId)
    const query = request.query.trim()
    if (query.length === 0) return emptySearchResult(query, request.mode ?? config.searchMode, 0)
    const requestedMode = request.mode ?? config.searchMode
    const topK = clampInt(request.topK ?? config.topK, 1, 50, 6)
    if (request.baseId === undefined && request.baseIds !== undefined && request.baseIds.length === 0) {
      return emptySearchResult(query, requestedMode, Date.now() - startedAt)
    }
    // A stale base id (e.g. a base deleted without sweeping child records)
    // must not surface orphaned content.
    if (request.baseId !== undefined && store.getBase(request.baseId) === undefined) {
      return emptySearchResult(query, requestedMode, 0)
    }

    const threshold = request.threshold ?? config.similarityThreshold

    // Both retrieval paths apply the same document selection before their
    // candidate limits, so excluded rows cannot consume retrieval seats.
    const documentFilter = resolveSearchFilter(store, request)
    // A present-but-empty allow-list is an explicit "match nothing" result.
    // Never pass it to a storage implementation that might interpret [] as
    // unrestricted scope.
    if (documentFilter?.docIds !== undefined && documentFilter.docIds.length === 0) {
      return emptySearchResult(query, requestedMode, Date.now() - startedAt)
    }

    const lane = store.retrievalLane
    if (lane !== undefined) {
      const scope = request.baseId !== undefined
        ? [request.baseId]
        : request.baseIds !== undefined && request.baseIds.length > 0
          ? [...request.baseIds]
          : store.listBases().map(base => base.id)
      const poolSize = Math.min(Math.max(topK * 4, 20), LANE_CANDIDATE_CAP)

      const queryVector = (requestedMode === 'vector' || requestedMode === 'hybrid' || requestedMode === 'auto') && config.embeddingProvider !== 'none'
        ? await this.embedQuery(config, query, signal)
        : undefined

      const useVector = queryVector !== undefined && requestedMode !== 'lexical'
      let ranked: RankedHit[] = []
      const byId = new Map<string, KnowledgeChunk>()
      let total = 0
      let vectorAttempted = false
      let vectorSucceeded = false
      let vectorReturned = 0
      let vectorError: string | undefined
      let lexicalAttempted = false
      let lexicalSucceeded = false
      let lexicalReturned = 0
      let lexicalError: string | undefined

      let vec: Awaited<ReturnType<typeof lane.vector>> | undefined
      if (useVector) {
        vectorAttempted = true
        try {
          vec = await lane.vector(queryVector!, scope, poolSize, documentFilter, deadlineAt)
          vectorSucceeded = true
          vectorReturned = vec.hits.length
          total = Math.max(total, vec.total)
          for (const hit of vec.hits) byId.set(hit.id, hit)
        } catch (error) {
          vectorError = retrievalErrorCode(error)
          this.warn(`vector retrieval failed, using lexical retrieval: ${safeErrorMessage(error)}`)
        }
      } else if (requestedMode !== 'lexical' && config.embeddingProvider !== 'none' && queryVector === undefined) {
        vectorError = 'embedding_unavailable'
      }

      // Hybrid/auto always execute lexical when vector worked, even when the
      // vector lane returned zero rows: a successful empty lane is distinct
      // from a failed lane in the public contract.
      let lex: Awaited<ReturnType<typeof lane.lexical>> | undefined
      if (requestedMode !== 'vector' || vec === undefined) {
        lexicalAttempted = true
        try {
          lex = await lane.lexical(query, scope, poolSize, documentFilter, deadlineAt)
          lexicalSucceeded = true
          lexicalReturned = lex.hits.length
          total = Math.max(total, lex.total)
          for (const hit of lex.hits) if (!byId.has(hit.id)) byId.set(hit.id, hit)
        } catch (error) {
          lexicalError = retrievalErrorCode(error)
          this.warn(`lexical retrieval failed: ${safeErrorMessage(error)}`)
        }
      }

      if (vec !== undefined && lex !== undefined) {
        // Hybrid/auto: fuse both lanes with Reciprocal Rank Fusion; the vector
        // lane carries the configured relative weight.
        const vectorOrder = vec.hits.map(hit => hit.id)
        const lexicalOrder = lex.hits.map(hit => hit.id)
        const vectorWeight = config.rrfVectorWeight
        const fused = reciprocalRankFusion([vectorOrder, lexicalOrder], [vectorWeight, 1])
        const maxFused = (vectorWeight + 1) / (RRF_K + 1)
        const vectorScores = new Map(vec.hits.map(hit => [hit.id, hit.score]))
        const lexicalScores = new Map(lex.hits.map(hit => [hit.id, hit.score]))
        ranked = [...new Set([...vectorOrder, ...lexicalOrder])].map(id => ({
          id,
          score: (fused.get(id) ?? 0) / maxFused,
          vectorScore: vectorScores.get(id),
          lexicalScore: lexicalScores.get(id),
        }))
      } else if (vec !== undefined) {
        ranked = vec.hits.map(hit => ({ id: hit.id, score: hit.score, vectorScore: hit.score }))
      } else if (lex !== undefined) {
        ranked = lex.hits.map(hit => ({ id: hit.id, score: hit.score, lexicalScore: hit.score }))
      }
      const laneStatus = retrievalStatus(requestedMode, {
        attempted: lexicalAttempted,
        succeeded: lexicalSucceeded,
        returnedCount: lexicalReturned,
        ...(lexicalError !== undefined ? { errorCode: lexicalError } : {}),
      }, {
        attempted: vectorAttempted,
        succeeded: vectorSucceeded,
        returnedCount: vectorReturned,
        ...(vectorError !== undefined ? { errorCode: vectorError } : {}),
      })

      ranked.sort((a, b) => b.score - a.score)
      if (request.mmr ?? config.mmrDiversity > 0) {
        if (config.mmrDiversity > 0 && queryVector !== undefined) {
          ranked = maximalMarginalRelevance(ranked, byId, queryVector, config.mmrDiversity, Math.max(topK * 3, 12))
        }
      }
      throwIfAborted(signal)
      return this.finishSearch(store, config, query, requestedMode, ranked, byId, topK, threshold, total, startedAt, laneStatus, allowRerank, signal)
    }

    const allowed = documentFilter?.docIds !== undefined ? new Set(documentFilter.docIds) : undefined
    const excluded = new Set(documentFilter?.excludeDocIds)
    const chunks = (request.baseId !== undefined
      ? store.listChunks(request.baseId)
      : request.baseIds !== undefined && request.baseIds.length > 0
        ? request.baseIds.flatMap(id => store.listChunks(id))
        : store.listBases().flatMap(base => store.listChunks(base.id)))
      .filter(chunk => (allowed === undefined || allowed.has(chunk.docId)) && !excluded.has(chunk.docId))
    if (chunks.length === 0) return emptySearchResult(query, requestedMode, 0)

    const byId = new Map(chunks.map(chunk => [chunk.id, chunk]))
    const candidates = chunks.map(chunk => ({
      id: chunk.id,
      text: searchTextOf(chunk),
      embedding: chunk.embedding,
    }))

    const queryVector = requestedMode !== 'lexical' && config.embeddingProvider !== 'none'
      ? await this.embedQuery(config, query, signal)
      : undefined

    // Retrieval produces a candidate pool; rerank (if configured) re-scores it
    // before the threshold + Top K cut, exactly like Cherry Studio's pipeline.
    const poolSize = Math.min(chunks.length, Math.max(topK * 4, 20))
    const ranked = rank(query, candidates, {
      mode: requestedMode,
      topK: poolSize,
      threshold: 0,
      mmr: request.mmr ?? config.mmrDiversity > 0,
      mmrLambda: config.mmrDiversity,
      queryVector,
    })
    throwIfAborted(signal)
    const retrieval = retrievalStatus(
      requestedMode,
      { attempted: true, succeeded: true, returnedCount: ranked.filter(hit => hit.lexicalScore !== undefined).length },
      {
        attempted: requestedMode !== 'lexical' && config.embeddingProvider !== 'none',
        succeeded: queryVector !== undefined,
        returnedCount: ranked.filter(hit => hit.vectorScore !== undefined).length,
      },
    )
    return this.finishSearch(store, config, query, requestedMode, ranked, byId, topK, threshold, chunks.length, startedAt, retrieval, allowRerank, signal)
  }

  /** Merge independent query rankings with RRF, then optionally rerank once. */
  private async finishMultiQuerySearch(
    config: KnowledgeConfig,
    query: string,
    requestedMode: SearchMode,
    results: readonly SearchResult[],
    topK: number,
    requestedThreshold: number | undefined,
    startedAt: number,
    allowRerank: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const store = this.getStore()
    throwIfAborted(signal)
    const orders = results.map(result => result.hits.map(hit => hit.chunkId))
    const fused = reciprocalRankFusion(orders)
    const maxFused = results.length / (RRF_K + 1)
    const byId = new Map<string, SearchHit>()
    for (const result of results) {
      for (const hit of result.hits) if (!byId.has(hit.chunkId)) byId.set(hit.chunkId, hit)
    }
    let hits = [...byId.values()]
      .map(hit => ({ ...hit, score: (fused.get(hit.chunkId) ?? 0) / maxFused }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(50, Math.max(topK * 4, 20)))
    const applied = await this.reranker.apply(store, config, query, hits, topK, allowRerank, signal)
    hits = applied.hits

    const retrieval = combineRetrievalStatus(requestedMode, results)
    const mode = retrieval.effectiveMode
    const threshold = requestedThreshold ?? config.similarityThreshold
    // Each variant already threshold-filtered its own lane scores inside
    // finishSearch (raw cosine for a vector query). After fusion the score is
    // an RRF rank value, so the vector threshold must not be re-applied here —
    // only rerank relevance scores share the threshold's 0–1 semantics.
    if (applied.reranked) hits = hits.filter(hit => hit.score >= threshold)
    const finalHits = attachContextWindows(store, hits.slice(0, topK), query, config.siblingChunks, SEARCH_EVIDENCE_TOKENS)
    return {
      query,
      mode,
      scoreKind: applied.reranked ? 'rerank' : 'rrf',
      retrieval,
      total: results.reduce((max, result) => Math.max(max, result.total), 0),
      reranked: applied.reranked,
      ...(applied.rerank !== undefined ? { rerank: applied.rerank } : {}),
      elapsedMs: Date.now() - startedAt,
      hits: finalHits,
    }
  }

  /** Shared tail: rerank (optional), threshold + top-K cut, and hit mapping. */
  private async finishSearch(
    store: Store,
    config: KnowledgeConfig,
    query: string,
    requestedMode: SearchMode,
    initial: RankedHit[],
    byId: ReadonlyMap<string, KnowledgeChunk>,
    topK: number,
    threshold: number,
    total: number,
    startedAt: number,
    // Required, and placed before the optional tail so the compiler enforces it:
    // the status must come from the lanes that actually ran. The old row-derived
    // default is gone because that inference IS the #16 defect — a search whose
    // vector lane contributed reported `mode: "lexical"` whenever no single row
    // happened to carry both scores.
    retrieval: RetrievalStatus,
    allowRerank = true,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    throwIfAborted(signal)
    const ranked = initial
    const candidates = ranked
      .map(hit => searchHitOf(store, byId.get(hit.id), hit))
      .filter((hit): hit is SearchHit => hit !== undefined)
    const applied = await this.reranker.apply(store, config, query, candidates, topK, allowRerank, signal)

    // Cherry's applyRelevanceThreshold: only 'relevance' scores are
    // threshold-filtered — pure-vector cosine (mode 'vector') and reranked
    // relevance. Raw BM25/hybrid ranking scores (incomparable scales) never
    // are, even with a threshold configured.
    const relevanceScores = applied.reranked || requestedMode === 'vector'
    const hits = attachContextWindows(
      store,
      applied.hits
        .filter(hit => (relevanceScores ? hit.score >= threshold : true))
        .slice(0, topK),
      query,
      config.siblingChunks,
      SEARCH_EVIDENCE_TOKENS,
    )

    return {
      query,
      mode: retrieval.effectiveMode,
      scoreKind: applied.reranked ? 'rerank' : scoreKindForMode(retrieval.effectiveMode),
      retrieval,
      total,
      reranked: applied.reranked,
      ...(applied.rerank !== undefined ? { rerank: applied.rerank } : {}),
      elapsedMs: Date.now() - startedAt,
      hits,
    }
  }

  private async embedQuery(config: KnowledgeConfig, query: string, signal?: AbortSignal): Promise<number[] | undefined> {
    try {
      const [vector] = await embedTexts(
        config.embeddingProvider, config.embeddingBaseUrl, config.embeddingModel, config.embeddingApiKey, [query], signal,
      )
      throwIfAborted(signal)
      return vector
    } catch (error) {
      throwIfAborted(signal)
      if (config.embeddingProvider === 'local') {
        const model = config.embeddingModel.trim() || DEFAULT_LOCAL_MODEL
        const onDisk = await isLocalModelDownloaded(model).catch(() => false)
        throw new Error(localEmbeddingErrorText(onDisk, safeErrorMessage(error)))
      }
      this.warn(`embedding failed, using lexical retrieval: ${safeErrorMessage(error)}`)
      return undefined
    }
  }
}

/**
 * Resolve inclusion metadata and title exclusions within the requested base
 * scope. Exclusion-only requests leave docIds absent rather than enumerating
 * every remaining document. An empty docIds array matches no documents.
 */
function resolveSearchFilter(store: Store, request: SearchRequest): RetrievalDocumentFilter | undefined {
  const filter = request.filter
  if (filter === undefined) return undefined
  const { docIds, excludeDocIds, titleIncludes, titleExcludes, sourceTypes, updatedAfter, updatedBefore } = filter
  // Presence is semantically distinct from absence: callers use an empty
  // allow-list to mean "match no documents", never "remove the filter".
  if (docIds !== undefined && docIds.length === 0) return { docIds: [] }
  if (sourceTypes !== undefined && sourceTypes.length === 0) return { docIds: [] }
  const hasDocIds = docIds !== undefined
  const title = titleIncludes?.trim().toLowerCase()
  const hasTitle = title !== undefined && title.length > 0
  const hasTypes = sourceTypes !== undefined
  const hasTime = updatedAfter !== undefined || updatedBefore !== undefined
  const hasInclusion = hasDocIds || hasTitle || hasTypes || hasTime
  const excludedTitles = [...new Set((titleExcludes ?? []).map(term => term.trim().toLowerCase()).filter(term => term.length > 0))]
  const excluded = new Set(excludeDocIds)
  if (!hasInclusion && excluded.size === 0 && excludedTitles.length === 0) return undefined
  if (!hasInclusion && excludedTitles.length === 0) return { excludeDocIds: [...excluded] }

  const scope = request.baseId !== undefined
    ? [request.baseId]
    : request.baseIds !== undefined && request.baseIds.length > 0
      ? [...request.baseIds]
      : store.listBases().map(base => base.id)
  const included = hasDocIds ? new Set(docIds) : undefined
  const allowed = hasInclusion ? new Set<string>() : undefined
  for (const baseId of scope) {
    for (const doc of store.listDocuments(baseId)) {
      const normalizedTitle = doc.title.toLowerCase()
      if (excludedTitles.some(term => normalizedTitle.includes(term))) excluded.add(doc.id)
      if (allowed === undefined || excluded.has(doc.id)) continue
      if (included !== undefined && !included.has(doc.id)) continue
      if (hasTitle && !normalizedTitle.includes(title!)) continue
      if (hasTypes && !sourceTypes!.includes(doc.sourceType)) continue
      if (updatedAfter !== undefined && (doc.updatedAt ?? doc.createdAt) < updatedAfter) continue
      if (updatedBefore !== undefined && (doc.updatedAt ?? doc.createdAt) > updatedBefore) continue
      allowed.add(doc.id)
    }
  }
  return {
    ...(allowed !== undefined ? { docIds: [...allowed] } : {}),
    ...(excluded.size > 0 ? { excludeDocIds: [...excluded] } : {}),
  }
}

/** User-facing message for a local-model embedding failure. Classifies the
 *  model-cache reality (checked from disk) so a broken binding/runtime error
 *  is NOT misrouted to "download the model" — the files may be intact and the
 *  fault is a worker/binding reload (e.g. "Module did not self-register"). */
export function localEmbeddingErrorText(onDisk: boolean, detail: string): string {
  if (onDisk) {
    return `local embedding model failed to load (${detail}); `
      + 'the model files are present but the runtime could not start — '
      + 'restart the service or retry later. If it persists, check the local model runtime install.'
  }
  return `local embedding model is unavailable (${detail}); `
    + 'download it in Settings → Local Models, or switch the embedding provider'
}

function retrievalStatus(
  requestedMode: SearchMode,
  lexical: RetrievalStatus['lexical'],
  vector: RetrievalStatus['vector'],
): RetrievalStatus {
  const effectiveMode: SearchMode = lexical.succeeded && vector.succeeded
    ? 'hybrid'
    : vector.succeeded
      ? 'vector'
      : 'lexical'
  return { requestedMode, effectiveMode, lexical, vector }
}

function emptyRetrievalStatus(requestedMode: SearchMode): RetrievalStatus {
  return retrievalStatus(
    requestedMode,
    { attempted: false, succeeded: false, returnedCount: 0 },
    { attempted: false, succeeded: false, returnedCount: 0 },
  )
}

function emptySearchResult(query: string, requestedMode: SearchMode, elapsedMs: number): SearchResult {
  const retrieval = emptyRetrievalStatus(requestedMode)
  return {
    query,
    mode: retrieval.effectiveMode,
    scoreKind: scoreKindForMode(retrieval.effectiveMode),
    retrieval,
    total: 0,
    reranked: false,
    elapsedMs,
    hits: [],
  }
}

function combineRetrievalStatus(requestedMode: SearchMode, results: readonly SearchResult[]): RetrievalStatus {
  const lexical = results.reduce((total, result) => total + (result.retrieval?.lexical.returnedCount ?? 0), 0)
  const vector = results.reduce((total, result) => total + (result.retrieval?.vector.returnedCount ?? 0), 0)
  const lexicalAttempted = results.some(result => result.retrieval?.lexical.attempted === true)
  const vectorAttempted = results.some(result => result.retrieval?.vector.attempted === true)
  const lexicalSucceeded = results.some(result => result.retrieval?.lexical.succeeded === true)
  const vectorSucceeded = results.some(result => result.retrieval?.vector.succeeded === true)
  const lexicalError = results.find(result => result.retrieval?.lexical.errorCode !== undefined)?.retrieval?.lexical.errorCode
  const vectorError = results.find(result => result.retrieval?.vector.errorCode !== undefined)?.retrieval?.vector.errorCode
  return retrievalStatus(requestedMode, {
    attempted: lexicalAttempted,
    succeeded: lexicalSucceeded,
    returnedCount: lexical,
    ...(lexicalError !== undefined ? { errorCode: lexicalError } : {}),
  }, {
    attempted: vectorAttempted,
    succeeded: vectorSucceeded,
    returnedCount: vector,
    ...(vectorError !== undefined ? { errorCode: vectorError } : {}),
  })
}

function scoreKindForMode(mode: SearchMode): SearchScoreKind {
  if (mode === 'hybrid') return 'rrf'
  if (mode === 'vector') return 'vector_similarity'
  return 'lexical_relevance'
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function retrievalErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'lane_error'
}

function throwIfDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new DOMException('knowledge search deadline exceeded', 'TimeoutError')
  }
}

/** Trim, validate, normalize, and cap multi-query variants. */
function normalizeQueryVariants(primary: string, queries?: readonly string[]): string[] {
  const variants = [primary]
  const seen = new Set([primary.toLowerCase()])
  for (const raw of (queries ?? []) as readonly unknown[]) {
    if (typeof raw !== 'string') continue
    const query = raw.trim()
    if (query.length === 0) continue
    if (query.length > 2000) throw new Error('extra search query must not exceed 2000 characters')
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    variants.push(query)
    if (variants.length >= 4) break
  }
  return variants
}
