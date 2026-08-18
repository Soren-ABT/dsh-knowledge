import { afterEach, describe, expect, it } from 'vitest'
import { ChunkDatabase } from '../src/knowledge/chunkdb.js'

const open = (): ChunkDatabase => new ChunkDatabase(':memory:')

const openSeeded = (): ChunkDatabase => {
  const db = open()
  db.putChunks([
    { id: 'c1', docId: 'd1', baseId: 'b1', index: 0, text: 'hello world 中文测试', context: 'doc' },
    { id: 'c2', docId: 'd2', baseId: 'b1', index: 0, text: 'another chunk of text', context: 'doc2' },
    { id: 'c3', docId: 'd3', baseId: 'b2', index: 0, text: '中文内容 深度学习', context: '深度学习笔记' },
  ])
  return db
}

afterEach(() => {})

describe('ChunkDatabase lexical lane', () => {
  it('matches CJK trigrams and latin words through FTS5', async () => {
    const db = openSeeded()
    const hits = await db.lexical('中文测试', ['b1'], 20)
    expect(hits.hits.map(hit => hit.id)).toContain('c1')
    const latin = await db.lexical('hello', ['b1'], 20)
    expect(latin.hits.map(hit => hit.id)).toContain('c1')
    db.close()
  })

  it('does not crash on symbol-only queries (FTS5 would reject MATCH "")', async () => {
    const db = openSeeded()
    for (const query of ['!!!', '###', '中文!!!测试', '（（（']) {
      const result = await db.lexical(query, ['b1'], 20)
      expect(Array.isArray(result.hits)).toBe(true)
    }
    db.close()
  })

  it('routes 1–2 char terms through the LIKE fallback instead of FTS', async () => {
    const db = openSeeded()
    const hits = await db.lexical('中', ['b1', 'b2'], 20)
    expect(hits.hits.length).toBeGreaterThan(0)
    db.close()
  })

  it('respects the base scope', async () => {
    const db = openSeeded()
    const b1 = await db.lexical('中文', ['b1'], 20)
    const b2 = await db.lexical('中文', ['b2'], 20)
    expect(b1.hits.some(hit => hit.baseId === 'b2')).toBe(false)
    expect(b2.hits.some(hit => hit.baseId === 'b1')).toBe(false)
    db.close()
  })
})

describe('ChunkDatabase vector lane', () => {
  it('returns cosine-ranked hits only for chunks with vectors', async () => {
    const db = openSeeded()
    const result = await db.vector([1, 0, 0], ['b1'], 20)
    expect(result.total).toBe(0) // no embeddings stored
    db.putChunkBatch([
      { id: 'v1', docId: 'd1', baseId: 'b1', index: 0, text: 'a', embedding: [1, 0, 0], embeddingModel: 'm' },
      { id: 'v2', docId: 'd1', baseId: 'b1', index: 1, text: 'b', embedding: [0, 1, 0], embeddingModel: 'm' },
    ])
    const ranked = await db.vector([1, 0, 0], ['b1'], 20)
    expect(ranked.hits[0].id).toBe('v1')
    expect(ranked.hits[0].score).toBeGreaterThan(ranked.hits[1].score)
    db.close()
  })
})
