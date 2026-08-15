/**
 * Retrieval ranking. Three signals share one interface: BM25 lexical scoring,
 * cosine similarity over normalized vectors, and their Reciprocal Rank Fusion
 * hybrid, with optional Maximal Marginal Relevance for diverse results.
 * @module dsh-knowledge/knowledge/retrieval
 */

import type { SearchMode } from './types.js'

// ── primitives ──────────────────────────────────────────────────────────────

/** Cosine similarity between two (assumed L2-normalized) vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return clamp01(dot)
}

const LATIN_WORD = /[a-z0-9_]+/g
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g

/**
 * Tokenize text: latin words (lowercased) plus CJK character bigrams, with
 * single CJK chars as a fallback so short queries still match. Deterministic.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lowered = text.toLowerCase()
  for (const match of lowered.match(LATIN_WORD) ?? []) {
    if (match.length > 1) tokens.push(match)
  }
  for (const run of lowered.match(CJK) ?? []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

// ── BM25 ────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.5
const BM25_B = 0.75

/** A corpus-built BM25 scorer: `score(id, queryTokens)` → raw BM25 score. */
export interface Bm25Scorer {
  score(id: string, queryTokens: readonly string[]): number
}

/** Build a BM25 scorer over a corpus of `{ id, text }` documents. */
export function buildBm25(documents: ReadonlyArray<{ id: string; text: string }>): Bm25Scorer {
  const docTokens = new Map<string, string[]>()
  const df = new Map<string, number>()
  let totalLength = 0
  for (const doc of documents) {
    const tokens = tokenize(doc.text)
    docTokens.set(doc.id, tokens)
    totalLength += tokens.length
    const seen = new Set<string>()
    for (const token of tokens) {
      if (!seen.has(token)) {
        df.set(token, (df.get(token) ?? 0) + 1)
        seen.add(token)
      }
    }
  }
  const n = documents.length
  const avgdl = n > 0 ? totalLength / n : 0
  return {
    score(id, queryTokens) {
      const tokens = docTokens.get(id)
      if (tokens === undefined || tokens.length === 0) return 0
      const tf = new Map<string, number>()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      let sum = 0
      for (const token of queryTokens) {
        const documentFrequency = df.get(token)
        if (documentFrequency === undefined) continue
        const idf = Math.log((n - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)
        const termFrequency = tf.get(token) ?? 0
        if (termFrequency === 0) continue
        const norm = termFrequency / (termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgdl)))
        sum += idf * norm
      }
      return sum
    },
  }
}

/** Map an unbounded BM25 score into [0, 1). */
export function normalizeBm25(raw: number): number {
  return raw / (raw + 1)
}

// ── fusion and diversity ────────────────────────────────────────────────────

export const RRF_K = 60

/** Reciprocal Rank Fusion over id-ranked lists; returns id → fused score. */
export function reciprocalRankFusion(rankedLists: ReadonlyArray<readonly string[]>): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  return fused
}

/** Re-rank hits for diversity using Maximal Marginal Relevance. */
export function maximalMarginalRelevance(
  hits: readonly RankedHit[],
  byId: ReadonlyMap<string, { embedding?: number[] }>,
  queryVector: readonly number[],
  lambda: number,
  topK: number,
): RankedHit[] {
  const withEmbedding = hits.filter(hit => {
    const embedding = byId.get(hit.id)?.embedding
    return embedding !== undefined && embedding.length === queryVector.length
  })
  const withoutEmbedding = hits.filter(hit => !withEmbedding.includes(hit))
  if (withEmbedding.length < 2) return [...hits]

  const selected: RankedHit[] = []
  const remaining = [...withEmbedding]
  const target = Math.min(withEmbedding.length, topK)
  while (selected.length < target && remaining.length > 0) {
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let i = 0; i < remaining.length; i += 1) {
      const hit = remaining[i]
      const embedding = byId.get(hit.id)!.embedding!
      let maxSimilarity = 0
      for (const picked of selected) {
        const pickedEmbedding = byId.get(picked.id)!.embedding!
        maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(embedding, pickedEmbedding))
      }
      const score = lambda * hit.score - (1 - lambda) * maxSimilarity
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }
  return [...selected, ...remaining, ...withoutEmbedding]
}

// ── orchestration ───────────────────────────────────────────────────────────

export interface RankableChunk {
  id: string
  text: string
  embedding?: number[]
}

export interface RankOptions {
  mode: SearchMode
  topK: number
  threshold: number
  mmr: boolean
  mmrLambda: number
  queryVector?: number[]
}

export interface RankedHit {
  id: string
  score: number
  vectorScore?: number
  lexicalScore?: number
}

/** Rank candidates with the selected strategy, then threshold + top-k. */
export function rank(query: string, candidates: readonly RankableChunk[], options: RankOptions): RankedHit[] {
  const queryTokens = tokenize(query)
  const vectorAvailable = options.queryVector !== undefined
    && candidates.some(candidate => candidate.embedding !== undefined && candidate.embedding.length === options.queryVector!.length)

  let mode: 'hybrid' | 'vector' | 'lexical'
  if (options.mode === 'vector' || options.mode === 'hybrid') mode = options.mode
  else if (options.mode === 'lexical') mode = 'lexical'
  else mode = vectorAvailable ? 'hybrid' : 'lexical'
  if (mode !== 'lexical' && !vectorAvailable) mode = 'lexical'

  const scorer = buildBm25(candidates)
  const lexical = new Map<string, number>()
  for (const candidate of candidates) lexical.set(candidate.id, normalizeBm25(scorer.score(candidate.id, queryTokens)))

  const vector = new Map<string, number>()
  if (options.queryVector !== undefined) {
    for (const candidate of candidates) {
      if (candidate.embedding !== undefined && candidate.embedding.length === options.queryVector.length) {
        vector.set(candidate.id, cosineSimilarity(options.queryVector, candidate.embedding))
      }
    }
  }

  let ranked: RankedHit[]
  if (mode === 'vector') {
    ranked = [...vector.entries()].map(([id, score]) => ({ id, score, vectorScore: score }))
  } else if (mode === 'lexical') {
    ranked = [...lexical.entries()].map(([id, score]) => ({ id, score, lexicalScore: score }))
  } else {
    const vectorOrder = [...vector.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const lexicalOrder = [...lexical.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const fused = reciprocalRankFusion([vectorOrder, lexicalOrder])
    const maxFused = 2 / (RRF_K + 1)
    ranked = candidates.map(candidate => ({
      id: candidate.id,
      score: (fused.get(candidate.id) ?? 0) / maxFused,
      vectorScore: vector.get(candidate.id),
      lexicalScore: lexical.get(candidate.id),
    }))
  }

  ranked.sort((a, b) => b.score - a.score)

  if (options.mmr && options.mmrLambda > 0 && options.queryVector !== undefined) {
    const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
    ranked = maximalMarginalRelevance(ranked, byId, options.queryVector, options.mmrLambda, Math.max(options.topK * 3, 12))
  }

  return ranked.filter(hit => hit.score >= options.threshold).slice(0, options.topK)
}
