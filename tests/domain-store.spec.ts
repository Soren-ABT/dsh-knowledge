import { describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { ChunkDatabase, migrateLegacyChunkFile } from '../src/knowledge/chunkdb.js'
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
  smartChunk: true,
  chunkSeparator: '\n\n',
  chunkSize: 800,
  chunkOverlap: 100,
  topK: 6,
  searchMode: 'auto',
  similarityThreshold: 0,
  mmrDiversity: 0,
  embeddingBatchSize: 32,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
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
      db.deleteChunks('d1')
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
      db.deleteChunksByBase('b1')
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
})
