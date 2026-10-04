import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    expect(hits.hits.every(hit => hit.score > 0 && hit.score < 1)).toBe(true)
    db.close()
  })

  it('normalizes two-character CJK LIKE scores and breaks equal-length ties by chunk id', async () => {
    const db = open()
    db.putChunks([
      { id: 'c-b', docId: 'd-b', baseId: 'b1', index: 0, text: '年假乙' },
      { id: 'c-a', docId: 'd-a', baseId: 'b1', index: 0, text: '年假甲' },
    ])

    const result = await db.lexical('年假', ['b1'], 20)
    expect(result.hits.map(hit => hit.id)).toEqual(['c-a', 'c-b'])
    expect(result.hits[0]?.score).toBeCloseTo(1024 / (1024 + 3), 12)
    db.close()
  })

  it('treats an empty document allow-list as match-nothing', async () => {
    const db = openSeeded()
    await expect(db.lexical('hello', ['b1'], 20, { docIds: [] })).resolves.toEqual({ total: 0, hits: [] })
    db.close()
  })

  it('excludes documents before FTS, LIKE, and relaxed-query limits', async () => {
    const db = open()
    try {
      db.putChunks([
        { id: 'blocked', docId: 'catalog', baseId: 'b1', index: 0, text: 'alpha zz 年假' },
        { id: 'kept', docId: 'body', baseId: 'b1', index: 0, text: 'alpha 年假 body evidence with extra context' },
        { id: 'foreign', docId: 'foreign', baseId: 'b2', index: 0, text: 'alpha zz 年假' },
      ])
      for (const query of ['alpha', '年假', 'alpha zz']) {
        const result = await db.lexical(query, ['b1'], 1, {
          docIds: ['catalog', 'body', 'foreign'],
          excludeDocIds: ['catalog'],
        })
        expect(result.total, query).toBe(1)
        expect(result.hits.map(hit => hit.docId), query).toEqual(['body'])
      }
      await expect(db.lexical('alpha', ['b1'], 1, { excludeDocIds: ['catalog', 'body'] }))
        .resolves.toEqual({ total: 0, hits: [] })
      const unrestricted = await db.lexical('alpha', ['b1'], 1)
      expect(await db.lexical('alpha', ['b1'], 1, { excludeDocIds: [] })).toEqual(unrestricted)
    } finally {
      db.close()
    }
  })

  it('uses large literal ID sets without exhausting SQL bind parameters', async () => {
    const db = open()
    try {
      const blockedIds = Array.from({ length: 600 }, (_, index) => `catalog-${index}`)
      const keptId = `body'\"%_[literal]`
      db.putChunks([
        ...blockedIds.map((docId, index) => ({
          id: `c${index}`, docId, baseId: 'b1', index: 0, text: 'needle',
        })),
        { id: 'kept', docId: keptId, baseId: 'b1', index: 0, text: 'needle body evidence' },
      ])
      const result = await db.lexical('needle', ['b1'], 1, {
        docIds: [...blockedIds, keptId],
        excludeDocIds: blockedIds,
      })
      expect(result.total).toBe(1)
      expect(result.hits.map(hit => hit.docId)).toEqual([keptId])
    } finally {
      db.close()
    }
  })

  it('interrupts a synchronous SQLite lexical scan at its absolute deadline', async () => {
    const db = open()
    db.putChunks([{ id: 'deadline', docId: 'deadline-doc', baseId: 'b1', index: 0, text: 'alpha deadline evidence' }])
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(1_000)
    try {
      await expect(db.lexical('alpha', ['b1'], 20, undefined, 500)).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      now.mockRestore()
      db.close()
    }
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

  it('treats an empty document allow-list as match-nothing', async () => {
    const db = open()
    db.putChunkBatch([
      { id: 'v1', docId: 'd1', baseId: 'b1', index: 0, text: 'a', embedding: [1, 0], embeddingModel: 'm' },
    ])
    await expect(db.vector([1, 0], ['b1'], 20, { docIds: [] })).resolves.toEqual({ total: 0, hits: [] })
    db.close()
  })

  it('excludes higher-scoring documents before counting and limiting vectors', async () => {
    const db = open()
    try {
      db.putChunks([
        { id: 'blocked', docId: 'catalog', baseId: 'b1', index: 0, text: 'catalog', embedding: [1, 0] },
        { id: 'kept', docId: 'body', baseId: 'b1', index: 0, text: 'body', embedding: [0.9, 0.1] },
        { id: 'foreign', docId: 'foreign', baseId: 'b2', index: 0, text: 'foreign', embedding: [1, 0] },
      ])
      const result = await db.vector([1, 0], ['b1'], 1, {
        docIds: ['catalog', 'body', 'foreign'], excludeDocIds: ['catalog'],
      })
      expect(result.total).toBe(1)
      expect(result.hits.map(hit => hit.docId)).toEqual(['body'])
      await expect(db.vector([1, 0], ['b1'], 1, { excludeDocIds: ['catalog', 'body'] }))
        .resolves.toEqual({ total: 0, hits: [] })
    } finally {
      db.close()
    }
  })

  it('checks deadlines while skipping excluded vectors', async () => {
    const db = open()
    db.putChunks(Array.from({ length: 300 }, (_, index) => ({
      id: `c${index}`, docId: index === 0 ? 'body' : 'catalog', baseId: 'b1', index,
      text: 'needle', embedding: [1, 0],
    })))
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000)
    try {
      await expect(db.vector([1, 0], ['b1'], 1, { excludeDocIds: ['catalog'] }, 500))
        .rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      now.mockRestore()
      db.close()
    }
  })
})

describe('ChunkDatabase FTS migration recovery', () => {
  it('rebuilds the trigram index when a previous migration was interrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-fts-'))
    const path = join(dir, 'chunks.sqlite')
    let db: ChunkDatabase | undefined
    let reopened: ChunkDatabase | undefined
    try {
      db = new ChunkDatabase(path)
      db.putChunks([{ id: 'c1', docId: 'd1', baseId: 'b1', index: 0, text: 'half applied rebuild' }])
      expect((await db.lexical('half applied', ['b1'], 20)).hits.map(hit => hit.id)).toContain('c1')
      db.close()
      db = undefined

      // Reproduce an interrupted upgrade exactly: the FTS table exists with the
      // shape the old textual guard accepted and holds no rows, and no migration
      // marker was written. That is the state whose rebuild the old code skipped
      // forever, leaving the whole lexical lane silently empty.
      const raw = new DatabaseSync(path)
      raw.exec('DROP TRIGGER IF EXISTS chunk_ai')
      raw.exec('DROP TRIGGER IF EXISTS chunk_ad')
      raw.exec('DROP TRIGGER IF EXISTS chunk_au')
      raw.exec('DROP TABLE IF EXISTS chunk_fts')
      raw.exec(`CREATE VIRTUAL TABLE chunk_fts USING fts5(
        search_text, content='chunk', content_rowid='fts_rowid', tokenize='trigram'
      )`)
      raw.exec(`DELETE FROM chunk_meta WHERE key = 'fts_rowid_migrated'`)
      raw.close()

      // Reopening must notice the migration never completed and rebuild.
      reopened = new ChunkDatabase(path)
      const hits = await reopened.lexical('half applied', ['b1'], 20)
      expect(hits.hits.map(hit => hit.id)).toContain('c1')
    } finally {
      try { db?.close() } catch { /* already closed */ }
      try { reopened?.close() } catch { /* already closed */ }
      await rm(dir, { recursive: true, force: true })
    }
  })
})
