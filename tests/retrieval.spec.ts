import { describe, expect, it } from 'vitest'
import {
  buildBm25,
  cosineSimilarity,
  normalizeBm25,
  rank,
  reciprocalRankFusion,
  tokenize,
} from '../src/knowledge/retrieval.js'
import { normalize } from '../src/knowledge/embed.js'

describe('tokenize', () => {
  it('tokenizes latin words and CJK bigrams', () => {
    const tokens = tokenize('Knowledge 知识库 base')
    expect(tokens).toContain('knowledge')
    expect(tokens).toContain('知识')
    expect(tokens).toContain('识库')
    expect(tokens).toContain('base')
  })
})

describe('cosineSimilarity', () => {
  it('computes similarity between normalized vectors', () => {
    expect(cosineSimilarity(normalize([1, 0]), normalize([1, 0]))).toBeCloseTo(1, 5)
    expect(cosineSimilarity(normalize([1, 0]), normalize([0, 1]))).toBeCloseTo(0, 5)
  })
})

describe('buildBm25', () => {
  it('scores matching documents higher than unrelated ones', () => {
    const scorer = buildBm25([
      { id: 'a', text: 'the quick brown fox jumps over the lazy dog' },
      { id: 'b', text: 'completely unrelated content here' },
    ])
    const query = tokenize('quick brown fox')
    expect(scorer.score('a', query)).toBeGreaterThan(scorer.score('b', query))
    expect(normalizeBm25(scorer.score('a', query))).toBeGreaterThan(0)
  })
})

describe('rank', () => {
  const candidates = [
    { id: 'a', text: 'the quick brown fox jumps over the lazy dog', embedding: normalize([1, 0, 0]) },
    { id: 'b', text: 'a fox is a wild animal', embedding: normalize([0, 1, 0]) },
    { id: 'c', text: 'totally different topic', embedding: normalize([0, 0, 1]) },
  ]

  it('ranks lexically', () => {
    const hits = rank('quick brown fox', candidates, { mode: 'lexical', topK: 3, threshold: 0, mmr: false, mmrLambda: 0 })
    expect(hits[0].id).toBe('a')
  })

  it('ranks by vector', () => {
    const hits = rank('fox', candidates, {
      mode: 'vector', topK: 3, threshold: 0, mmr: false, mmrLambda: 0, queryVector: normalize([1, 0, 0]),
    })
    expect(hits[0].id).toBe('a')
  })

  it('hybrid fuses both signals', () => {
    const hits = rank('fox', candidates, {
      mode: 'hybrid', topK: 3, threshold: 0, mmr: false, mmrLambda: 0, queryVector: normalize([1, 0, 0]),
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].score).toBeGreaterThan(0)
    expect(hits[0].vectorScore).toBeDefined()
    expect(hits[0].lexicalScore).toBeDefined()
  })

  it('applies a score threshold', () => {
    const hits = rank('fox', candidates, {
      mode: 'lexical', topK: 3, threshold: 0.9, mmr: false, mmrLambda: 0,
    })
    expect(hits.every(hit => hit.score >= 0.9)).toBe(true)
  })
})

describe('reciprocalRankFusion', () => {
  it('fuses multiple ranked lists', () => {
    const fused = reciprocalRankFusion([['a', 'b'], ['a', 'c']])
    expect(fused.get('a') ?? 0).toBeGreaterThan(fused.get('b') ?? 0)
  })
})
