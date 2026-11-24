import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeService } from '../knowledge/index.js'
import { estimateContextTokens, serializeContextWindow } from '../knowledge/context-protocol.js'
import type { SearchHit, SearchResult } from '../knowledge/types.js'
import {
  AUTO_RETRIEVE_CONTEXT_TURNS, cleanRetrieveQuery, containsStrictIdentifier, findNamedBase,
  planAutoRetrieveQueries, retrievalIntent, sharesKeywords,
} from './auto-retrieve-query.js'
import { selectAutoRetrieveEvidence } from './auto-retrieve-selection.js'
import { clipAroundQuery, fitHeadTailToTokens, renderAutoRetrieveBackground, renderAutoRetrieveHit } from './render.js'

export function registerAutoRetrieve(ctx: Context): void {
  const knowledge = ctx.knowledge
  // Fold evidence into the same pre-step as the claimed user message.
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.length === 0 || signal.aborted) return decision
    const text = userTextOf(messages)
    if (text.length === 0) return decision
    // Follow-up context stores only bounded, cleaned retrieval queries, never
    // arbitrary full user messages. A deictic follow-up ("那第二步呢？") can
    // still resolve its topic without growing agent memory with long prompts.
    const prior = retrievalHistories.get(knowledge)?.get(agent.id)?.recent ?? []
    const remembered = cleanRetrieveQuery(text)
    const nextRecent = [...prior, remembered].filter(query => query.length > 0).slice(-AUTO_RETRIEVE_CONTEXT_TURNS)
    const background = await buildAutoRetrieveMessage(knowledge, agent, text, signal, prior)
    const history = retrievalHistories.get(knowledge)?.get(agent.id)
    if (!history || signal.aborted) return decision
    if (background === undefined) {
      history.recent = nextRecent
      return decision
    }
    // DSH brands UserMessage#id as MessageId; our literal cannot name the
    // brand, and the runtime accepts any unique string (the inject path has
    // used the same literal shape since the feature shipped).
    const folded = foldBackground(decision.messages, messages, background.message as never)
    if (signal.aborted) return decision
    history.recent = nextRecent
    background.commit()
    return { kind: 'enter', messages: folded }
  })
  // Forget this agent's throttle + context when it goes away.
  ctx.on('agent/disposed', ({ agent }) => { retrievalHistories.get(knowledge)?.delete(agent.id) })
  ctx.effect(() => () => { retrievalHistories.delete(knowledge) }, 'knowledge: forget retrieval history')
}

/** Extract the claimed USER input (source kind 'user') from a pre-step batch —
 *  plugin context (our own background, agent-instructions, approvals…) never
 *  triggers a retrieval, so a folded background cannot re-trigger itself.
 *  Exported for tests. */
export function userTextOf(messages: readonly AutoRetrieveMessage[]): string {
  return messages
    .filter(message => message.source?.kind === 'user')
    .map(message => (message.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join(' '))
    .join(' ')
    .trim()
}

/** Insert the background message right after the claimed batch (agent-instructions
 *  fold posture): the direct prompt precedes it, driver context follows it.
 *  Exported for tests. */
export function foldBackground<T>(
  decisionMessages: T[],
  claimedMessages: readonly AutoRetrieveMessage[],
  background: T,
): T[] {
  let lastClaimedIndex = -1
  for (let i = decisionMessages.length - 1; i >= 0; i -= 1) {
    if (claimedMessages.includes(decisionMessages[i] as unknown as AutoRetrieveMessage)) {
      lastClaimedIndex = i
      break
    }
  }
  if (lastClaimedIndex < 0) return [...decisionMessages, background]
  return [
    ...decisionMessages.slice(0, lastClaimedIndex + 1),
    background,
    ...decisionMessages.slice(lastClaimedIndex + 1),
  ]
}

/** Minimal structural view of an agent the auto-retriever folds into. */
interface AutoRetrieveAgent {
  readonly id: string
  inject(message: unknown): void
}

/** Minimal structural view of a claimed user message. */
interface AutoRetrieveMessage {
  readonly content: ReadonlyArray<{ readonly type?: string; readonly text?: string }>
  readonly source?: { readonly kind?: string; readonly plugin?: string }
}

/** How many top chunks to inject as background. */
const AUTO_RETRIEVE_TOP_K = 3
/**
 * Minimum gap between injections for one agent: injected background rides a
 * user-role message that persists in the session log, so without a throttle a
 * long conversation accumulates one background dump per turn and inflates the
 * context for every later step. The gate is topic-aware: a NEW topic injects
 * up to three hits, while a same-topic follow-up inside the window may add at
 * most one previously unseen evidence delta.
 */
const AUTO_RETRIEVE_MIN_INTERVAL_MS = 5 * 60_000

/** Rerank budget on the pre-step (latency-critical) path: a remote reranker
 *  past this budget degrades to the BM25 order instead of delaying the model's
 *  first token. Explicit knowledge_search keeps the full 60s budget. */
const AUTO_RETRIEVE_RERANK_TIMEOUT_MS = 4000
/** Candidate pool fetched from the store (multi-base coverage before per-base voting). */
const AUTO_RETRIEVE_CANDIDATE_POOL = 12
/** Chunk-id memory cap for injection dedup; over it the memory resets. */
const AUTO_RETRIEVE_MAX_MEMORY = 50

interface RetrievalHistory {
  recent: string[]
  lastInjection: number
  keywords: string[]
  chunks: Set<string>
}

const retrievalHistories = new WeakMap<KnowledgeService, Map<string, RetrievalHistory>>()

function retrievalHistory(knowledge: KnowledgeService, agentId: string): RetrievalHistory {
  let agents = retrievalHistories.get(knowledge)
  if (!agents) {
    agents = new Map()
    retrievalHistories.set(knowledge, agents)
  }
  let history = agents.get(agentId)
  if (!history) {
    history = { recent: [], lastInjection: 0, keywords: [], chunks: new Set() }
    agents.set(agentId, history)
  }
  return history
}
/** Last logged failure signature by stage, per service instance. Agents share
 * one provider/runtime, so provider outages must not emit one warning per
 * concurrent agent. Weak keys also avoid retaining disposed services. */
const autoRetrieveLogStates = new WeakMap<KnowledgeService, Map<string, string>>()

/** A folded auto-retrieve background message with a producer-owned source. */
export interface AutoRetrieveBackground {
  readonly message: {
    role: 'user'
    content: ReadonlyArray<{ type: 'text'; text: string }>
    source: { kind: 'dsh-knowledge' }
    id: string
  }
  /** Commit throttle/dedup state only after the message was actually folded or injected. */
  commit(): void
}

/** Search the bases for `text` and build the background message to fold into
 *  the triggering pre-step batch. Returns undefined when nothing clears the
 *  gates (best-effort; never throws). State is committed separately, after a
 *  caller has successfully folded or injected the returned message. */
export async function buildAutoRetrieveMessage(
  knowledge: KnowledgeService,
  agent: AutoRetrieveAgent,
  text: string,
  signal?: AbortSignal,
  contextText?: string | readonly string[],
): Promise<AutoRetrieveBackground | undefined> {
  try {
    if (signal?.aborted) return undefined
    if (!knowledge.isEnabled() || !knowledge.getConfig().autoRetrieve) {
      retrievalHistories.get(knowledge)?.delete(agent.id)
      return undefined
    }

    // Resolve an explicit base against the complete registry BEFORE enabled
    // scope and auto-retrieve switches/weights. Naming an inaccessible or
    // opted-out base must fail closed instead of searching other bases.
    const scope = knowledge.resolveInvocationScope()
    const namedBase = findNamedBase(scope.all, text)
    const scopedBases = scope.enabled
    if (scopedBases.length === 0) return undefined
    if (namedBase !== undefined) {
      if (!scopedBases.some(base => base.id === namedBase.id)) return undefined
      const namedConfig = knowledge.getConfigFor(namedBase.id)
      if (!namedConfig.autoRetrieve || namedConfig.autoRetrieveWeight <= 0) return undefined
    }
    const bases = scopedBases.filter(base => {
      const config = knowledge.getConfigFor(base.id)
      return config.autoRetrieve && config.autoRetrieveWeight > 0
    })
    if (bases.length === 0) return undefined

    const now = Date.now()
    const queryPlan = planAutoRetrieveQueries(text, contextText)
    const currentQuery = queryPlan.primary
    if (currentQuery.length === 0) return undefined
    const history = retrievalHistory(knowledge, agent.id)
    const throttled = now - history.lastInjection < AUTO_RETRIEVE_MIN_INTERVAL_MS
    const prevKeywords = history.keywords
    const intent = retrievalIntent(text, queryPlan)
    if (!intent) return undefined
    const { topicSignal, identifiers } = intent
    // A short deictic query inherits the prior topic only for same-topic
    // throttling; self-contained current messages never carry old topics.
    const sameTopic = prevKeywords.length > 0 && topicSignal.some(keyword => prevKeywords.includes(keyword))
    if (signal?.aborted) return undefined

    // One wall-clock budget covers lexical retrieval plus the optional remote
    // rerank. The search itself is explicitly forbidden from invoking a
    // configured reranker, preventing local model startup and remote double
    // billing on this latency-critical path.
    const deadlineAt = Date.now() + AUTO_RETRIEVE_RERANK_TIMEOUT_MS
    const budgetSignal = AbortSignal.timeout(AUTO_RETRIEVE_RERANK_TIMEOUT_MS)
    const executionSignal = signal !== undefined ? AbortSignal.any([signal, budgetSignal]) : budgetSignal
    const searchRequest = {
      query: currentQuery,
      ...(queryPlan.enhanced !== undefined ? { queries: [queryPlan.enhanced] } : {}),
      topK: AUTO_RETRIEVE_CANDIDATE_POOL,
      mode: 'lexical' as const,
      ...(namedBase ? { baseId: namedBase.id } : { baseIds: bases.map(base => base.id) }),
    }
    const searchStartedAt = Date.now()
    let searchResult: SearchResult
    try {
      searchResult = await awaitWithSignal(
        knowledge.search(searchRequest, { rerank: 'skip', signal: executionSignal, deadlineAt }),
        executionSignal,
      )
      clearAutoRetrieveFailure(knowledge, 'search')
      clearAutoRetrieveFailure(knowledge, 'planner')
    } catch (error) {
      if (signal?.aborted) return undefined
      if (budgetSignal.aborted) {
        logAutoRetrieveFailure(knowledge, 'search', undefined, 0, Date.now() - searchStartedAt, budgetSignal.reason)
        return undefined
      }
      logAutoRetrieveFailure(knowledge, 'search', undefined, 0, Date.now() - searchStartedAt, error)
      return undefined
    }
    if (signal?.aborted) return undefined
    if (budgetSignal.aborted) {
      logAutoRetrieveFailure(knowledge, 'search', undefined, searchResult.hits.length, Date.now() - searchStartedAt, budgetSignal.reason)
      return undefined
    }

    // Remove previously delivered evidence before relevance gates, rerank, and
    // seat allocation. An old top hit can no longer consume the winner slot or
    // prevent a genuinely fresh lower-ranked delta from being injected.
    const injected = history.chunks
    const relevanceQuery = queryPlan.enhanced ?? currentQuery
    const basesById = new Map(bases.map(base => [base.id, base]))
    const nameOf = (id: string): string => basesById.get(id)?.name ?? id
    const scored = searchResult.hits
      .map(hit => pruneInjectedEvidence(hit, injected))
      .filter((hit): hit is SearchHit => hit !== undefined)
      .map(hit => ({
        hit,
        score: hit.score,
        evidence: renderAutoRetrieveHit(hit, nameOf(hit.baseId), relevanceQuery),
      }))
      .filter(candidate => sharesKeywords(relevanceQuery, candidate.evidence))
      .filter(candidate => identifiers.every(identifier => containsStrictIdentifier(candidate.evidence, identifier)))
      .sort((a, b) => b.score - a.score)

    // Rerank participation: when a rerank model is configured (global or any
    // enabled base) and it is a remote API, re-score the candidates with it —
    // relevance scores replace BM25 for the injection order. The local
    // cross-encoder is skipped (loading ~280MB per user message is too heavy).
    const rerank = namedBase !== undefined
      ? rerankSettingsForBase(knowledge, namedBase.id)
      : knowledge.rerankSettings(bases)
    let ranked = scored
    let scoreKind: 'lexical' | 'rerank' = 'lexical'
    if (rerank !== undefined && !rerank.model.startsWith('local:') && scored.length > 1) {
      try {
        const { rerankCandidates } = await import('../knowledge/rerank.js')
        const remainingMs = Math.ceil(deadlineAt - Date.now())
        if (remainingMs <= 0) throw new DOMException('auto-retrieve rerank deadline expired', 'TimeoutError')
        const rerankQuery = fitHeadTailToTokens(relevanceQuery, 128)
        const evidenceBudget = Math.max(1, Math.min(352, 480 - estimateContextTokens(rerankQuery)))
        const scores = await awaitWithSignal(rerankCandidates(
          rerank.baseUrl, rerank.model, rerank.apiKey, rerankQuery,
          scored.map(candidate => ({
            id: candidate.hit.chunkId,
            text: clipAroundQuery(candidate.evidence, relevanceQuery, evidenceBudget),
          })),
          {
            topN: AUTO_RETRIEVE_CANDIDATE_POOL,
            timeoutMs: remainingMs,
            deadlineAt,
            retries: 0,
            signal: executionSignal,
          },
        ), executionSignal)
        if (signal?.aborted) return undefined
        if (budgetSignal.aborted) throw abortReason(budgetSignal)
        const reranked = scored
          .filter(candidate => scores.has(candidate.hit.chunkId))
          .map(candidate => ({ ...candidate, score: scores.get(candidate.hit.chunkId)! }))
          .sort((a, b) => b.score - a.score)
        if (reranked.length > 0) {
          ranked = reranked
          scoreKind = 'rerank'
          clearAutoRetrieveFailure(knowledge, 'rerank')
        }
      } catch (error) {
        if (signal?.aborted) return undefined
        if (budgetSignal.aborted) {
          logAutoRetrieveFailure(
            knowledge,
            'rerank',
            rerank.model,
            scored.length,
            AUTO_RETRIEVE_RERANK_TIMEOUT_MS,
            budgetSignal.reason,
          )
        } else {
          logAutoRetrieveFailure(
            knowledge,
            'rerank',
            rerank.model,
            scored.length,
            AUTO_RETRIEVE_RERANK_TIMEOUT_MS - Math.max(0, deadlineAt - Date.now()),
            error,
          )
        }
      }
    }
    const chosen = selectAutoRetrieveEvidence(
      ranked, scoreKind, throttled && sameTopic ? 1 : AUTO_RETRIEVE_TOP_K,
      id => basesById.has(id) ? knowledge.getConfigFor(id).autoRetrieveWeight : 0,
    )
    if (chosen.length === 0 || signal?.aborted) return undefined

    const rendered = renderAutoRetrieveBackground(chosen, nameOf, relevanceQuery, identifiers, knowledge.getConfig().autoRetrieveCitation !== false)
    if (rendered === undefined || signal?.aborted) return undefined

    let committed = false
    return {
      message: {
        role: 'user',
        content: [{ type: 'text', text: rendered.text }],
        source: { kind: 'dsh-knowledge' },
        id: crypto.randomUUID(),
      },
      commit() {
        if (committed) return
        committed = true
        history.lastInjection = Date.now()
        history.keywords = topicSignal
        const nextInjected = history.chunks
        for (const hit of rendered.delivered) {
          for (const chunkId of evidenceChunkIds(hit)) nextInjected.add(chunkId)
        }
        while (nextInjected.size > AUTO_RETRIEVE_MAX_MEMORY) {
          const oldest = nextInjected.values().next().value as string | undefined
          if (oldest === undefined) break
          nextInjected.delete(oldest)
        }
      },
    }
  } catch (error) {
    // Best-effort: auto-retrieval must never break a turn.
    if (signal?.aborted) return undefined
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return undefined
    logAutoRetrieveFailure(knowledge, 'planner', undefined, 0, 0, error)
    return undefined
  }
}

/** Back-compat entry: build the background and inject it via the agent handle
 *  (used by tests; production folds via agent/pre-step instead). */
export async function autoRetrieveBackground(
  knowledge: KnowledgeService,
  agent: AutoRetrieveAgent,
  text: string,
): Promise<void> {
  const background = await buildAutoRetrieveMessage(knowledge, agent, text)
  if (background !== undefined) {
    agent.inject(background.message)
    background.commit()
  }
}

function evidenceChunkIds(hit: SearchHit): string[] {
  if (hit.contextWindow === undefined) return [hit.chunkId]
  return [
    ...hit.contextWindow.before.map(excerpt => excerpt.chunkId),
    hit.contextWindow.anchor.chunkId,
    ...hit.contextWindow.after.map(excerpt => excerpt.chunkId),
  ]
}

/** Keep a fresh anchor while removing neighbour excerpts already shown in an
 * earlier turn. This prevents overlapping ContextWindows from re-injecting
 * old evidence without discarding a genuinely new adjacent chunk. */
function pruneInjectedEvidence(hit: SearchHit, injected: ReadonlySet<string>): SearchHit | undefined {
  if (injected.has(hit.chunkId)) return undefined
  const window = hit.contextWindow
  if (window === undefined) return hit
  if (injected.has(window.anchor.chunkId)) return undefined
  const before = window.before.filter(excerpt => !injected.has(excerpt.chunkId))
  const after = window.after.filter(excerpt => !injected.has(excerpt.chunkId))
  const removedBefore = before.length !== window.before.length
  const removedAfter = after.length !== window.after.length
  const next = {
    ...window,
    before,
    after,
    estimatedTokens: 0,
    hasMoreBefore: window.hasMoreBefore || removedBefore,
    hasMoreAfter: window.hasMoreAfter || removedAfter,
  }
  next.estimatedTokens = estimateContextTokens(serializeContextWindow(next))
  return { ...hit, contextWindow: next }
}

function rerankSettingsForBase(
  knowledge: KnowledgeService,
  baseId: string,
): { model: string; baseUrl: string; apiKey: string } | undefined {
  const config = knowledge.getConfigFor(baseId)
  const model = config.rerankModel.trim()
  if (model.length === 0) return undefined
  return { model, baseUrl: config.rerankBaseUrl, apiKey: config.rerankApiKey }
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

function logAutoRetrieveFailure(
  knowledge: KnowledgeService,
  stage: 'search' | 'rerank' | 'planner',
  model: string | undefined,
  candidateCount: number,
  elapsedMs: number,
  error: unknown,
): void {
  const code = autoRetrieveErrorCode(error)
  const safeModel = safeLogToken(model ?? 'none')
  const signature = `${safeModel}:${code}`
  const states = autoRetrieveLogStates.get(knowledge) ?? new Map<string, string>()
  if (states.get(stage) === signature) return
  states.set(stage, signature)
  autoRetrieveLogStates.set(knowledge, states)
  knowledge.warn(
    `auto-retrieve degraded stage=${stage} model=${safeModel} code=${safeLogToken(code)}`
    + ` candidateCount=${Math.max(0, Math.trunc(candidateCount))}`
    + ` elapsedMs=${Math.max(0, Math.trunc(elapsedMs))}`,
  )
}

function clearAutoRetrieveFailure(knowledge: KnowledgeService, stage: 'search' | 'rerank' | 'planner'): void {
  const states = autoRetrieveLogStates.get(knowledge)
  if (states === undefined) return
  states.delete(stage)
  if (states.size === 0) autoRetrieveLogStates.delete(knowledge)
}

function autoRetrieveErrorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  if (typeof error === 'object' && error !== null) {
    const detail = (error as { detail?: { code?: unknown } }).detail
    if (typeof detail?.code === 'string') return detail.code
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'provider_error'
}

function safeLogToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:/-]+/g, '_').slice(0, 128) || 'unknown'
}
