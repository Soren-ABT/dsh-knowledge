import { describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { ChunkDatabase, hashEmbeddingText, migrateLegacyChunkFile } from '../src/knowledge/chunkdb.js'
import { openStore } from '../src/knowledge/store.js'
import type { StorageDomainFacility } from '../src/knowledge/store.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'
import type { KnowledgeChunk } from '../src/knowledge/types.js'

const TEST_CONFIG: Config = {
  embeddingProvider: 'none',
  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingApiKey: '',
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  localRerankTimeoutMs: 60000,
  smartChunk: true,
  chunkSeparator: '\n\n',
  chunkSize: 800,
  chunkOverlap: 100,
  topK: 6,
  searchMode: 'auto',
  similarityThreshold: 0,
  mmrDiversity: 0,
  rrfVectorWeight: 1,
  embeddingBatchSize: 32,
  siblingChunks: 1,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
  documentProcessorProvider: 'builtin',
  mineruApiKey: '',
  mineruApiHost: '',
  semanticChunk: false,
  semanticChunkThreshold: 0.75,
  chunkTokenLimit: 0,
  conflictStrategy: 'rename',
  urlRefreshHours: 0,
  imageCaptionProvider: 'off',
  imageCaptionModel: '',
  imageCaptionBaseUrl: '',
  imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true,
  autoRetrieve: true,
  autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60000,
}

/** Minimal in-memory KvTable matching the storage-domain runtime contract. */
class FakeTable<K extends string, V> implements KvTable<K, V> {
  readonly map = new Map<K, V>()

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  get size(): number {
    return this.map.size
  }

  async put(key: K, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.map.delete(key)
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

function fakeDomain(): Domain<typeof knowledgeDomainSpec> {
  const tables = {
    bases: new FakeTable<string, unknown>(),
    documents: new FakeTable<string, unknown>(),
  }
  let globalValue: unknown = { overrides: {}, groups: [], enabled: true, enabledBaseIds: [] }
  return {
    name: 'knowledge',
    global: {
      get: () => globalValue,
      set: async (value: unknown) => { globalValue = value },
    },
    table: (name: string) => tables[name as keyof typeof tables] as unknown,
    close: async () => {},
  } as unknown as Domain<typeof knowledgeDomainSpec>
}

function chunk(id: string, docId: string, baseId: string, index: number, text: string): KnowledgeChunk {
  return { id, docId, baseId, index, text }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-kb-chunkdb-'))
}

describe('ChunkDatabase (per-chunk SQL layout)', () => {
  it('stores one row per chunk, lists by doc/base, and deletes in one op', async () => {
    const dir = await tempDir()
    try {
      const path = join(dir, 'chunks.sqlite')
      const db = new ChunkDatabase(path)
      db.putChunks([chunk('c1', 'd1', 'b1', 0, 'alpha'), chunk('c2', 'd1', 'b1', 1, 'beta'), chunk('c3', 'd2', 'b1', 0, 'gamma')])
      expect(db.size).toBe(3)
      expect(db.listChunksByDoc('d1').map(c => c.id).sort()).toEqual(['c1', 'c2'])
      expect(db.listChunks('b1')).toHaveLength(3)
      await db.deleteChunks('d1')
      expect(db.listChunksByDoc('d1')).toHaveLength(0)
      expect(db.listChunks('b1')).toHaveLength(1)
      db.close()

      const reopened = new ChunkDatabase(path)
      expect(reopened.listChunks('b1')).toHaveLength(1)
      reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deletes every chunk of a base in one sweep', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      db.putChunks([chunk('c1', 'd1', 'b1', 0, 'a'), chunk('c2', 'd2', 'b1', 0, 'b')])
      db.putChunks([chunk('c3', 'd3', 'b2', 0, 'c')])
      await db.deleteChunksByBase('b1')
      expect(db.listChunks('b1')).toHaveLength(0)
      expect(db.listChunks('b2')).toHaveLength(1)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs the FTS5 lexical lane over CJK and latin text', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      db.putChunks([
        chunk('c1', 'd1', 'b1', 0, '公司的报销流程是提交发票后审批'),
        chunk('c2', 'd1', 'b1', 1, '年假申请需要提前三天'),
        chunk('c3', 'd2', 'b1', 0, 'the quick brown fox jumps over the lazy dog'),
        chunk('c4', 'd2', 'b1', 1, 'unrelated filler content here'),
      ])
      const zh = await db.lexical('报销流程', ['b1'], 10)
      expect(zh.total).toBe(4)
      expect(zh.hits[0].id).toBe('c1')
      const en = await db.lexical('brown fox', ['b1'], 10)
      expect(en.hits[0].id).toBe('c3')
      // Two-character CJK term → trigram has nothing to index → LIKE fallback.
      const short = await db.lexical('年假', ['b1'], 10)
      expect(short.hits[0].id).toBe('c2')
      // Scope filtering: another base is invisible.
      const other = await db.lexical('报销流程', ['b9'], 10)
      expect(other.total).toBe(0)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ranks the vector lane by cosine similarity', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      const base = (label: string, vector: number[]): KnowledgeChunk => ({
        ...chunk(`c-${label}`, `d-${label}`, 'b1', 0, `text ${label}`),
        embedding: vector,
      })
      const near = base('near', [1, 0, 0])
      const far = base('far', [0, 1, 0])
      const mid = base('mid', [0.8, 0.6, 0])
      db.putChunks([near, far, mid])
      const result = await db.vector([1, 0.1, 0], ['b1'], 10)
      expect(result.total).toBe(3)
      expect(result.hits.map(h => h.id)).toEqual(['c-near', 'c-mid', 'c-far'])
      expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score)
      // Embeddings round-trip through the BLOB codec.
      expect(result.hits[0].embedding).toEqual([1, 0, 0])
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('migrates the previous bundle layout into per-chunk rows on open', async () => {
    const dir = await tempDir()
    try {
      const path = join(dir, 'chunks.sqlite')
      // Create the OLD layout by hand.
      const { DatabaseSync } = await import('node:sqlite')
      const seed = new DatabaseSync(path)
      seed.exec('CREATE TABLE chunk_bundles (doc_id TEXT PRIMARY KEY, base_id TEXT NOT NULL, chunks_json TEXT NOT NULL)')
      seed.prepare('INSERT INTO chunk_bundles (doc_id, base_id, chunks_json) VALUES (?, ?, ?)').run(
        'd1', 'b1', JSON.stringify([{ id: 'c1', docId: 'd1', baseId: 'b1', index: 0, text: 'alpha' }, { id: 'c2', docId: 'd1', baseId: 'b1', index: 1, text: 'beta' }]),
      )
      seed.close()

      const db = new ChunkDatabase(path)
      expect(db.size).toBe(2)
      expect(db.listChunksByDoc('d1').map(c => c.id).sort()).toEqual(['c1', 'c2'])
      // Legacy table is gone.
      const { DatabaseSync: Sync } = await import('node:sqlite')
      const check = new Sync(path)
      const leftover = check.prepare("SELECT name FROM sqlite_master WHERE name = 'chunk_bundles'").get()
      expect(leftover).toBeUndefined()
      check.close()
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('migrates legacy per-chunk rows and bundles from a unit file', async () => {
    const dir = await tempDir()
    try {
      const legacy = {
        unit: { name: 'knowledge', version: 0 },
        global: null,
        tables: {
          bases: {},
          documents: {},
          chunks: {
            'c1': { id: 'c1', docId: 'd1', baseId: 'b1', index: 0, text: 'a' },
            'c2': { id: 'c2', docId: 'd1', baseId: 'b1', index: 1, text: 'b' },
            'd2': [{ id: 'c3', docId: 'd2', baseId: 'b1', index: 0, text: 'c' }],
          },
        },
      }
      const jsonPath = join(dir, 'knowledge.json')
      await writeFile(jsonPath, JSON.stringify(legacy))

      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      const migrated = await migrateLegacyChunkFile(jsonPath, db, () => {})
      expect(migrated).toBe(2)
      expect(db.listChunksByDoc('d1').map(c => c.id).sort()).toEqual(['c1', 'c2'])
      expect(db.listChunksByDoc('d2').map(c => c.id)).toEqual(['c3'])
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips the unit-file migration once the store already holds chunks', async () => {
    const dir = await tempDir()
    try {
      const legacy = {
        unit: { name: 'knowledge', version: 0 },
        global: null,
        tables: { bases: {}, documents: {}, chunks: { 'c1': { id: 'c1', docId: 'd1', baseId: 'b1', index: 0, text: 'a' } } },
      }
      const jsonPath = join(dir, 'knowledge.json')
      await writeFile(jsonPath, JSON.stringify(legacy))

      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      db.putChunks([chunk('x1', 'd9', 'b9', 0, 'x')])
      const migrated = await migrateLegacyChunkFile(jsonPath, db, () => {})
      expect(migrated).toBe(0)
      expect(db.listChunksByDoc('d1')).toHaveLength(0)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reuses stored vectors by embedding-text hash + model, across documents', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      // All embedded chunks share context 'doc d1' — the embedding input is
      // context + text, so reuse only holds between chunks whose full search
      // text (hash key) is identical.
      const embedded = (id: string, docId: string, baseId: string, index: number, text: string, model: string, vector: number[]): KnowledgeChunk => ({
        ...chunk(id, docId, baseId, index, text),
        context: 'doc d1',
        embedding: vector,
        embeddingModel: model,
      })
      db.putChunks([
        embedded('c1', 'd1', 'b1', 0, 'alpha text', 'openai:m1', [1, 0, 0]),
        embedded('c2', 'd1', 'b1', 1, 'beta text', 'openai:m1', [0, 1, 0]),
        // Same chunk text under a different model must NOT be reusable.
        embedded('c3', 'd2', 'b2', 0, 'alpha text', 'openai:m2', [0.5, 0.5, 0]),
        // A lexical-only chunk (no vector) must never match.
        chunk('c4', 'd3', 'b1', 0, 'alpha text'),
      ])

      // Another document embedding the same text under the same model reuses.
      const alphaHash = hashEmbeddingText('doc d1\nalpha text')
      const betaHash = hashEmbeddingText('doc d1\nbeta text')
      const missingHash = hashEmbeddingText('doc d1\nnever seen')
      const reused = db.listEmbeddingVectorsByHashes([alphaHash, betaHash, missingHash], 'openai:m1')
      expect(reused.get(alphaHash)).toEqual([1, 0, 0])
      expect(reused.get(betaHash)).toEqual([0, 1, 0])
      expect(reused.has(missingHash)).toBe(false)
      // Another model sees only its own vectors.
      const m2 = db.listEmbeddingVectorsByHashes([alphaHash], 'openai:m2')
      expect(m2.get(alphaHash)).toEqual([0.5, 0.5, 0])
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('backfills the embedding_text_hash column on a store created by an older version', async () => {
    const dir = await tempDir()
    try {
      const path = join(dir, 'chunks.sqlite')
      // Create the OLD schema by hand (no embedding_text_hash column) with a stored vector.
      const { DatabaseSync } = await import('node:sqlite')
      const seed = new DatabaseSync(path)
      seed.exec(`
        CREATE TABLE chunk (
          chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, base_id TEXT NOT NULL, idx INTEGER NOT NULL,
          text TEXT NOT NULL, search_text TEXT NOT NULL, heading TEXT, context TEXT,
          embedding BLOB, embedding_model TEXT
        )
      `)
      const blob = Buffer.from(new Float32Array([1, 0, 0]).buffer)
      seed.prepare('INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text, context, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('c1', 'd1', 'b1', 0, 'alpha text', 'doc d1\nalpha text', 'doc d1', blob, 'openai:m1')
      seed.prepare('INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text) VALUES (?, ?, ?, ?, ?, ?)')
        .run('c2', 'd1', 'b1', 1, 'lexical only', 'doc d1\nlexical only')
      seed.close()

      const db = new ChunkDatabase(path)
      const hash = hashEmbeddingText('doc d1\nalpha text')
      const reused = db.listEmbeddingVectorsByHashes([hash], 'openai:m1')
      expect(reused.get(hash)).toEqual([1, 0, 0])
      // The lexical-only row still has no vector and no hash.
      const { DatabaseSync: Sync } = await import('node:sqlite')
      const check = new Sync(path)
      const row = check.prepare('SELECT embedding_text_hash FROM chunk WHERE chunk_id = ?').get('c2') as { embedding_text_hash: string | null }
      expect(row.embedding_text_hash).toBeNull()
      check.close()
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-embeds after a delete removes the reuse source', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      const embedded = (id: string, docId: string, text: string, vector: number[]): KnowledgeChunk => ({
        ...chunk(id, docId, 'b1', 0, text),
        context: 'doc',
        embedding: vector,
        embeddingModel: 'openai:m1',
      })
      db.putChunks([embedded('c1', 'd1', 'alpha text', [1, 0, 0])])
      const hash = hashEmbeddingText('doc\nalpha text')
      expect(db.listEmbeddingVectorsByHashes([hash], 'openai:m1').has(hash)).toBe(true)
      await db.deleteChunksByBase('b1')
      expect(db.listEmbeddingVectorsByHashes([hash], 'openai:m1').has(hash)).toBe(false)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists embedded batches incrementally without clearing the document', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      const embedded = (id: string, docId: string, index: number, text: string, vector: number[]): KnowledgeChunk => ({
        ...chunk(id, docId, 'b1', index, text),
        context: 'doc',
        embedding: vector,
        embeddingModel: 'openai:m1',
      })
      // Two batches land over time (as if embedding ran in two chunks of work).
      db.putChunkBatch([embedded('c1', 'd1', 0, 'alpha text', [1, 0, 0])])
      db.putChunkBatch([embedded('c2', 'd1', 1, 'beta text', [0, 1, 0])])
      // Both batches survive; no DELETE-then-INSERT wipe happened.
      expect(db.listChunksByDoc('d1').map(c => c.id).sort()).toEqual(['c1', 'c2'])
      // A later full replace still works after incremental batches.
      db.putChunks([embedded('c9', 'd1', 0, 'gamma text', [0, 0, 1])])
      expect(db.listChunksByDoc('d1').map(c => c.id)).toEqual(['c9'])
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fetches a bounded index range around a hit (sibling context)', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      db.putChunks([
        chunk('c0', 'd1', 'b1', 0, 'zero'),
        chunk('c1', 'd1', 'b1', 1, 'one'),
        chunk('c2', 'd1', 'b1', 2, 'two'),
        chunk('c3', 'd1', 'b1', 3, 'three'),
        chunk('c4', 'd2', 'b1', 0, 'other doc'),
      ])
      // Radius 1 around index 2 → [1..3], reading order, other docs excluded.
      const around = db.listChunksByIndexRange('d1', 1, 3)
      expect(around.map(c => c.id)).toEqual(['c1', 'c2', 'c3'])
      // Range clamps to the document's edges (no neighbours at index 0 radius 0).
      expect(db.listChunksByIndexRange('d1', 0, 0).map(c => c.id)).toEqual(['c0'])
      expect(db.listChunksByIndexRange('d1', 0, 1).map(c => c.id)).toEqual(['c0', 'c1'])
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('narrows both lanes to a document subset (metadata filter)', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      const embedded = (id: string, docId: string, text: string, vector: number[]): KnowledgeChunk => ({
        ...chunk(id, docId, 'b1', 0, text),
        embedding: vector,
        embeddingModel: 'm1',
      })
      db.putChunks([
        embedded('c1', 'd1', 'alpha queuing theory text', [1, 0, 0]),
        embedded('c2', 'd2', 'beta queuing theory text', [0.9, 0.1, 0]),
        embedded('c3', 'd3', 'gamma queuing theory text', [0.8, 0.2, 0]),
      ])
      // Lexical lane with docIds: only d2's chunk is visible.
      const lex = await db.lexical('queuing', ['b1'], 10, ['d2'])
      expect(lex.total).toBe(1)
      expect(lex.hits[0].id).toBe('c2')
      // Vector lane with docIds: only d1 + d3 are scanned.
      const vec = await db.vector([1, 0, 0], ['b1'], 10, ['d1', 'd3'])
      expect(vec.hits.map(h => h.id)).toEqual(['c1', 'c3'])
      // No docIds = unrestricted (existing behavior).
      const all = await db.lexical('queuing', ['b1'], 10)
      expect(all.total).toBe(3)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports interrupted documents for resume instead of dropping them', async () => {
    const dir = await tempDir()
    try {
      // Seed a crashed state: an incomplete document with rawText + one landed
      // chunk batch, an incomplete document with no chunks yet, and a pure
      // placeholder with neither text nor chunks.
      {
        const domain = fakeDomain()
        const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
        const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
        await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
        await documents.put('partial', { id: 'partial', baseId: 'b1', title: 'mid-embed', sourceType: 'file', rawText: 'full source text', charCount: 15, chunkCount: 0, incomplete: true, createdAt: 100, updatedAt: 100 })
        await documents.put('rawonly', { id: 'rawonly', baseId: 'b1', title: 'text-ok', sourceType: 'file', rawText: 'text but no chunks yet', charCount: 23, chunkCount: 0, incomplete: true, createdAt: 200, updatedAt: 200 })
        await documents.put('pure', { id: 'pure', baseId: 'b1', title: 'placeholder', sourceType: 'file', charCount: 0, chunkCount: 0, createdAt: 300, updatedAt: 300 })
        const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
          chunkStorePath: join(dir, 'chunks.sqlite'),
          legacyJsonPath: join(dir, 'missing.json'),
        })
        await store.putChunkBatch([{ ...chunk('c1', 'partial', 'b1', 0, 'first batch'), context: 'partial', embedding: [1, 0, 0], embeddingModel: 'openai:m1' }])
        await store.close()
      }
      // Reopen at a later "process start": incomplete documents are reported
      // for resume (kept, not dropped); the pure placeholder was already
      // removed by openStore's own recovery pass (so a second pass reports
      // zero removed and the same resume list).
      const domain = fakeDomain()
      const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
      const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
      await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
      await documents.put('partial', { id: 'partial', baseId: 'b1', title: 'mid-embed', sourceType: 'file', rawText: 'full source text', charCount: 15, chunkCount: 0, incomplete: true, createdAt: 100, updatedAt: 100 })
      await documents.put('rawonly', { id: 'rawonly', baseId: 'b1', title: 'text-ok', sourceType: 'file', rawText: 'text but no chunks yet', charCount: 23, chunkCount: 0, incomplete: true, createdAt: 200, updatedAt: 200 })
      await documents.put('pure', { id: 'pure', baseId: 'b1', title: 'placeholder', sourceType: 'file', charCount: 0, chunkCount: 0, createdAt: 300, updatedAt: 300 })
      const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
        chunkStorePath: join(dir, 'chunks.sqlite'),
        legacyJsonPath: join(dir, 'missing.json'),
      })
      // openStore's recovery pass already dropped the pure placeholder.
      expect(store.getDocument('pure')).toBeUndefined()
      const recovery = await store.recoverInterruptedImports(Date.now())
      expect(recovery.resume.sort()).toEqual(['partial', 'rawonly'])
      expect(recovery.removed).toBe(0)
      expect(store.getDocument('partial')).toBeDefined()
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('DomainStore wiring', () => {
  it('backs chunks with the SQLite store and business state with the domain', async () => {
    const dir = await tempDir()
    try {
      const store = await openStore({ open: async () => fakeDomain() } as unknown as StorageDomainFacility, {
        chunkStorePath: join(dir, 'chunks.sqlite'),
        legacyJsonPath: join(dir, 'missing.json'),
      })
      await store.putChunks([chunk('c1', 'd1', 'b1', 0, 'a'), chunk('c2', 'd1', 'b1', 1, 'b')])
      expect(store.listChunksByDoc('d1')).toHaveLength(2)
      // Pagination is pushed into SQL.
      expect(store.listChunksByDoc('d1', 1, 1).map(c => c.id)).toEqual(['c2'])
      expect(store.chunkCountsByDoc(['b1']).get('d1')).toBe(2)
      const status = store.docChunkStatus('b1')
      expect(status.withChunks.has('d1')).toBe(true)
      expect(status.missingEmbedding.has('d1')).toBe(true)
      await store.deleteChunks('d1')
      expect(store.listChunksByDoc('d1')).toHaveLength(0)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reconciles stale document chunkCount metadata against the chunk store', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      db.putChunks([chunk('c1', 'd1', 'b1', 0, 'a'), chunk('c2', 'd1', 'b1', 1, 'b'), chunk('c3', 'd2', 'b1', 0, 'c')])
      db.close()
      const domain = fakeDomain()
      const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
      const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
      await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
      await documents.put('d1', { id: 'd1', baseId: 'b1', title: 'stale', sourceType: 'text', charCount: 10, chunkCount: 99, createdAt: 1 })
      await documents.put('d2', { id: 'd2', baseId: 'b1', title: 'fine', sourceType: 'text', charCount: 10, chunkCount: 1, createdAt: 1 })

      const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
        chunkStorePath: join(dir, 'chunks.sqlite'),
        legacyJsonPath: join(dir, 'missing.json'),
      })
      expect(store.getDocument('d1')?.chunkCount).toBe(2)
      expect(store.getDocument('d2')?.chunkCount).toBe(1)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cleans up documents an interrupted import left behind', async () => {
    const dir = await tempDir()
    try {
      // First run: seed a crashed state — a placeholder (no chunks) and a
      // half-finished doc (chunkCount > 0 but no chunks) from a previous run.
      {
        const domain = fakeDomain()
        const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
        const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
        await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
        await documents.put('ghost', { id: 'ghost', baseId: 'b1', title: 'crash-placeholder', sourceType: 'file', fileName: 'a.pdf', charCount: 0, chunkCount: 0, createdAt: 100, updatedAt: 100 })
        await documents.put('half', { id: 'half', baseId: 'b1', title: 'crash-half', sourceType: 'file', charCount: 10, chunkCount: 5, createdAt: 200, updatedAt: 200 })
        await documents.put('fine', { id: 'fine', baseId: 'b1', title: 'complete', sourceType: 'file', charCount: 10, chunkCount: 1, createdAt: 300, updatedAt: 300 })
        const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
          chunkStorePath: join(dir, 'chunks.sqlite'),
          legacyJsonPath: join(dir, 'missing.json'),
        })
        // 'half' claims chunks but has none — give it a chunk so it is real.
        await store.putChunks([chunk('c1', 'fine', 'b1', 0, 'x')])
        await store.close()
      }
      // Reopen at a later "process start": ghosts with no chunks predating the
      // start are removed; the completed doc survives.
      const domain = fakeDomain()
      const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
      const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
      await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
      await documents.put('ghost', { id: 'ghost', baseId: 'b1', title: 'crash-placeholder', sourceType: 'file', fileName: 'a.pdf', charCount: 0, chunkCount: 0, createdAt: 100, updatedAt: 100 })
      await documents.put('half', { id: 'half', baseId: 'b1', title: 'crash-half', sourceType: 'file', charCount: 10, chunkCount: 5, createdAt: 200, updatedAt: 200 })
      await documents.put('fine', { id: 'fine', baseId: 'b1', title: 'complete', sourceType: 'file', charCount: 10, chunkCount: 1, createdAt: 300, updatedAt: 300 })
      const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
        chunkStorePath: join(dir, 'chunks.sqlite'),
        legacyJsonPath: join(dir, 'missing.json'),
      })
      expect(store.getDocument('ghost')).toBeUndefined()   // placeholder removed
      expect(store.getDocument('half')).toBeUndefined()     // no chunks → removed
      expect(store.getDocument('fine')).toBeDefined()       // has chunks → kept
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves lexical search through the SQL lanes end to end', async () => {
    const dir = await tempDir()
    try {
      vi.stubEnv('DSH_HOME', dir)
      const ctx = new Context()
      ctx.provide('webServer', { routes: [], register: () => () => {} })
      ctx.provide('storageDomain', { open: async () => fakeDomain() })
      await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
      const service = ctx.get('knowledge') as KnowledgeService

      const base = await service.createBase({ name: 'lanes' })
      await service.addTextDocument({ baseId: base.id, title: '报销', content: '公司的报销流程是提交发票后由财务审批。' })
      await service.addTextDocument({ baseId: base.id, title: '年假', content: '年假申请需要提前三天报备。' })

      const result = await service.search({ query: '报销流程', baseId: base.id })
      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits[0].documentTitle).toBe('报销')
      const zh = await service.search({ query: '年假', baseId: base.id })
      expect(zh.hits[0].documentTitle).toBe('年假')
      // Release the SQLite handle so the temp dir can be removed.
      await (service as unknown as { store: { close(): Promise<void> } }).store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists raw source bytes, re-reads them on reindex, and cleans them on delete', async () => {
    const dir = await tempDir()
    try {
      const domain = fakeDomain()
      const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
        chunkStorePath: join(dir, 'chunks.sqlite'),
        legacyJsonPath: join(dir, 'missing.json'),
      })
      expect(store.raw).toBeDefined()

      // Upload a text file: the raw copy must exist next to the chunk store.
      await store.putDocument({
        id: 'd1',
        baseId: 'b1',
        title: 'notes.txt',
        sourceType: 'file',
        fileName: 'notes.txt',
        rawFilePath: `${'b1'}/d1.txt`,
        charCount: 3,
        chunkCount: 1,
        createdAt: 1,
      })
      await store.raw!.write('b1', 'd1', '.txt', new TextEncoder().encode('abc'))
      await store.putChunks([{ id: 'c1', docId: 'd1', baseId: 'b1', index: 0, text: 'abc' }])

      const bytes = await store.raw!.read('b1/d1.txt')
      expect(new TextDecoder().decode(bytes!)).toBe('abc')

      // Delete removes the raw file.
      await store.raw!.delete('b1/d1.txt')
      expect(await store.raw!.read('b1/d1.txt')).toBeNull()

      // deleteBase removes the whole base's raw directory.
      await store.raw!.write('b1', 'd1', '.txt', new TextEncoder().encode('abc'))
      await store.raw!.deleteBase('b1')
      expect(await store.raw!.read('b1/d1.txt')).toBeNull()
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resumes a placeholder that only holds a raw source file (crash before parse)', async () => {
    const dir = await tempDir()
    try {
      // Seed a crashed state: a placeholder with rawFilePath + raw bytes but
      // no rawText and no chunks (crash between the raw write and parse).
      {
        const domain = fakeDomain()
        const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
        const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
        await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
        await documents.put('rawonly', { id: 'rawonly', baseId: 'b1', title: 'notes.txt', sourceType: 'file', fileName: 'notes.txt', rawFilePath: 'b1/rawonly.txt', charCount: 0, chunkCount: 0, createdAt: 100, updatedAt: 100 })
        const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
          chunkStorePath: join(dir, 'chunks.sqlite'),
          legacyJsonPath: join(dir, 'missing.json'),
        })
        await store.raw!.write('b1', 'rawonly', '.txt', new TextEncoder().encode('hello from raw file'))
        await store.close()
      }
      // Reopen: the raw-only placeholder must be reported for resume, not removed.
      const domain = fakeDomain()
      const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
      const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
      await bases.put('b1', { id: 'b1', name: 'b1', description: '', createdAt: 1, updatedAt: 1 })
      await documents.put('rawonly', { id: 'rawonly', baseId: 'b1', title: 'notes.txt', sourceType: 'file', fileName: 'notes.txt', rawFilePath: 'b1/rawonly.txt', charCount: 0, chunkCount: 0, createdAt: 100, updatedAt: 100 })
      const store = await openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
        chunkStorePath: join(dir, 'chunks.sqlite'),
        legacyJsonPath: join(dir, 'missing.json'),
      })
      const recovery = await store.recoverInterruptedImports(Date.now())
      expect(recovery.removed).toBe(0)
      expect(recovery.resume).toContain('rawonly')
      expect(store.getDocument('rawonly')).toBeDefined()
      // The raw bytes are still readable for the resume path.
      const bytes = await store.raw!.read('b1/rawonly.txt')
      expect(new TextDecoder().decode(bytes!)).toBe('hello from raw file')
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims space after a large delete and keeps FTS search working', async () => {
    const dir = await tempDir()
    try {
      const db = new ChunkDatabase(join(dir, 'chunks.sqlite'))
      // Fill with enough real text so the file grows past the 8 MB VACUUM
      // threshold, then delete most of it.
      const big = 'reclaimable paragraph content '.repeat(900)
      const docs: KnowledgeChunk[] = []
      for (let d = 0; d < 30; d += 1) {
        for (let i = 0; i < 20; i += 1) {
          docs.push(chunk(`c${d}-${i}`, `d${d}`, 'b1', i, `${big} doc ${d} chunk ${i}`))
        }
      }
      db.putChunks(docs)
      // Small delete: below the threshold → no VACUUM, cheap no-op.
      await db.deleteChunks('d0')
      const small = db.reclaimSpace()
      expect(small.vacuumed).toBe(false)

      // Large delete: most documents go → the threshold is crossed.
      for (let d = 1; d < 28; d += 1) await db.deleteChunks(`d${d}`)
      const outcome = db.reclaimSpace()
      expect(outcome.vacuumed).toBe(true)
      expect(outcome.reclaimedBytes).toBeGreaterThan(0)

      // FTS still answers after the optimize + VACUUM — and EVERY remaining
      // row is reachable through the stable fts_rowid surrogate (a rowid-keyed
      // FTS would silently drop rows once VACUUM renumbers the table).
      const result = await db.lexical('reclaimable', ['b1'], 100)
      expect(result.total).toBe(40) // d28 + d29 remain (d0..d27 deleted)
      expect(result.hits.length).toBe(40)
      expect(result.hits.every(hit => hit.docId === 'd28' || hit.docId === 'd29')).toBe(true)

      // Writes after the rebuild keep the trigger-assigned surrogate unique.
      db.putChunks([
        chunk('c-new', 'd30', 'b1', 0, `${big} doc 30`),
        chunk('c-new2', 'd30', 'b1', 1, `${big} doc 30 again`),
      ])
      const after = await db.lexical('doc 30', ['b1'], 10)
      expect(after.hits.length).toBeGreaterThan(0)
      await db.deleteChunks('d30')
      // '30' is a 2-char short term: its LIKE filter is relaxed when it
      // eliminates every candidate (Cherry's semantics), so other docs' hits
      // may appear — but the deleted doc's chunks must be gone from both paths.
      const gone = await db.lexical('doc 30', ['b1'], 10)
      expect(gone.hits.some(hit => hit.docId === 'd30')).toBe(false)
      const exact = await db.lexical('reclaimable', ['b1'], 100)
      expect(exact.hits.some(hit => hit.docId === 'd30')).toBe(false)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('KnowledgeService restart', () => {
  it('reapplies persisted runtime overrides (cache dir + HF mirror) on a fresh start without an explicit save', async () => {
    const dir = await tempDir()
    try {
      vi.stubEnv('DSH_HOME', dir)
      const domain = fakeDomain()
      const facility = { open: async () => domain }
      const mount = async (): Promise<KnowledgeService> => {
        const ctx = new Context()
        ctx.provide('webServer', { routes: [], register: () => () => {} })
        ctx.provide('storageDomain', facility)
        await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
        return ctx.get('knowledge') as KnowledgeService
      }
      const closeStore = async (service: KnowledgeService): Promise<void> => {
        await (service as unknown as { store: { close(): Promise<void> } }).store.close()
      }

      // First "run": mount, save runtime overrides, tear down.
      const service1 = await mount()
      const modelsDir = join(dir, 'models')
      await service1.setConfig({ localModelCacheDir: modelsDir, hfEndpoint: 'https://hf-mirror.com' })
      await closeStore(service1)

      // Second "run" on the same domain — the restart scenario. The saved
      // overrides must be live again from the first request: model checks use
      // the restored cache dir, downloads use the restored mirror.
      const { localModelCacheDir, getHfEndpoint } = await import('../src/knowledge/embed.js')
      const service2 = await mount()
      try {
        expect(localModelCacheDir()).toBe(resolve(modelsDir))
        expect(getHfEndpoint()).toBe('https://hf-mirror.com')
        expect(service2.getConfig().localModelCacheDir).toBe(resolve(modelsDir))
      } finally {
        await closeStore(service2)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
