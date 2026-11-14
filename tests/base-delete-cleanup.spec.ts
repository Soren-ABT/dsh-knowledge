import { describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { openStore } from '../src/knowledge/store.js'
import type { StorageDomainFacility } from '../src/knowledge/store.js'
import type { KnowledgeBase, KnowledgeChunk, KnowledgeDocument } from '../src/knowledge/types.js'
import type { ChunkDatabase } from '../src/knowledge/chunkdb.js'

/** Minimal in-memory KvTable matching the storage-domain runtime contract. */
class FakeTable<K extends string, V> implements KvTable<K, V> {
  readonly map = new Map<K, V>()
  get(key: K): V | undefined { return this.map.get(key) }
  entries(): IterableIterator<[K, V]> { return this.map.entries() }
  keys(): IterableIterator<K> { return this.map.keys() }
  get size(): number { return this.map.size }
  async put(key: K, value: V): Promise<void> { this.map.set(key, value) }
  async delete(key: K): Promise<boolean> { return this.map.delete(key) }
  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

function fakeDomain(): Domain<typeof knowledgeDomainSpec> {
  const tables = { bases: new FakeTable<string, unknown>(), documents: new FakeTable<string, unknown>() }
  let globalValue: unknown = { overrides: {}, groups: [], enabled: true, enabledBaseIds: [] }
  return {
    name: 'knowledge',
    global: { get: () => globalValue, set: async (value: unknown) => { globalValue = value } },
    table: (name: string) => tables[name as keyof typeof tables] as unknown,
    close: async () => {},
  } as unknown as Domain<typeof knowledgeDomainSpec>
}

const base = (id: string): KnowledgeBase => ({ id, name: id, description: '', createdAt: 1, updatedAt: 1 })
const doc = (id: string, baseId: string, extra: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({
  id, baseId, title: id, sourceType: 'file', charCount: 10, chunkCount: 0, createdAt: 1, updatedAt: 1, ...extra,
})
const chunk = (id: string, docId: string, baseId: string): KnowledgeChunk => ({ id, docId, baseId, index: 0, text: `chunk ${id}` })

async function domainStore(dir: string, domain: Domain<typeof knowledgeDomainSpec>) {
  return openStore({ open: async () => domain } as unknown as StorageDomainFacility, {
    chunkStorePath: join(dir, 'chunks.sqlite'),
    legacyJsonPath: join(dir, 'missing.json'),
  })
}

describe('deleting a base collects its documents', () => {
  it('drops the documents on the in-memory store and leaves other bases alone', async () => {
    const store = await openStore(undefined)
    try {
      await store.putBase(base('b1'))
      await store.putBase(base('b2'))
      await store.putDocument(doc('d1', 'b1'))
      await store.putDocument(doc('d2', 'b1'))
      await store.putDocument(doc('d3', 'b2'))

      await store.deleteBase('b1')

      expect(store.getBase('b1')).toBeUndefined()
      expect(store.getDocument('d1')).toBeUndefined()
      expect(store.getDocument('d2')).toBeUndefined()
      expect(store.getDocument('d3')).toBeDefined()
    } finally {
      await store.close()
    }
  })

  it('collects the durable rows too, in the order the service uses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-base-delete-'))
    const domain = fakeDomain()
    const store = await domainStore(dir, domain)
    try {
      await store.putBase(base('b1'))
      await store.putBase(base('b2'))
      await store.putDocument(doc('d1', 'b1'))
      await store.putDocument(doc('d3', 'b2'))
      await store.putChunks([chunk('c1', 'd1', 'b1')])

      // KnowledgeService.deleteBase runs these two in this order.
      await store.deleteChunksByBase('b1')
      await store.deleteBase('b1')

      expect(store.getDocument('d1')).toBeUndefined()
      expect(store.listChunks('b1')).toEqual([])
      expect(store.getDocument('d3')).toBeDefined()
      const table = domain.table('documents') as unknown as FakeTable<string, unknown>
      expect(table.map.has('d1')).toBe(false)
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('startup recovery never resumes documents of a removed base', () => {
  it('collects an orphan even when its published generation awaits metadata acknowledgement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-orphan-generation-'))
    const domain = fakeDomain()
    const store = await domainStore(dir, domain)
    try {
      await store.putBase(base('b1'))
      await store.putDocument(doc('d1', 'b1'))
      const documents = domain.table('documents')
      const put = vi.spyOn(documents, 'put').mockRejectedValueOnce(new Error('disk unavailable'))
      await expect(store.commitDocumentGeneration(doc('d1', 'b1', { chunkCount: 1 }), [chunk('c1', 'd1', 'b1')]))
        .rejects.toMatchObject({ published: true })
      put.mockRestore()
      await domain.table('bases').delete('b1')

      expect(await store.recoverInterruptedImports(Date.now())).toEqual({ removed: 1, resume: [] })
      expect(store.getDocument('d1')).toBeUndefined()
      expect(store.listChunksByDoc('d1')).toEqual([])
      const db = (store as unknown as { chunkDb: ChunkDatabase }).chunkDb
      expect(db.pendingDocumentGeneration('d1')).toBeUndefined()
      expect(await store.recoverInterruptedImports(Date.now())).toEqual({ removed: 0, resume: [] })
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('discards staged chunks when collecting a removed base directory record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-orphan-staged-'))
    const domain = fakeDomain()
    const store = await domainStore(dir, domain)
    try {
      await store.putBase(base('b1'))
      const directory = doc('d1', 'b1', { sourceType: 'directory', errorCode: 'parse_failed' })
      await store.putDocument(directory)
      await store.stageDocumentGeneration(directory, [chunk('c1', 'd1', 'b1')])
      await domain.table('bases').delete('b1')

      expect(await store.recoverInterruptedImports(Date.now())).toEqual({ removed: 1, resume: [] })
      const db = (store as unknown as { chunkDb: ChunkDatabase }).chunkDb
      expect(db.getStagedDocumentGeneration('d1')).toBeUndefined()
      expect(store.getDocument('d1')).toBeUndefined()
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('collects a base-less document whatever its embedding state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-base-gone-'))
    const domain = fakeDomain()
    const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
    const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
    await bases.put('b1', base('b1'))
    // Live base, interrupted mid-import: must still resume.
    await documents.put('live', { ...doc('live', 'b1'), rawText: 'live text', incomplete: true })
    // Removed base: carries the shape a failed embedding leaves behind
    // (`embeddingError` + `errorCode`), so `hasCompletedEmptyIndex()` is false.
    await documents.put('orphan', {
      ...doc('orphan', 'gone'),
      rawText: 'orphan text',
      incomplete: false,
      errorCode: 'embedding_provider',
      embeddingError: 'document processing failed',
    })

    const store = await domainStore(dir, domain)
    try {
      // openStore's healing pass already collected the base-less row.
      expect(store.getDocument('orphan')).toBeUndefined()
      const recovery = await store.recoverInterruptedImports(Date.now() + 1)
      expect(recovery.resume).toEqual(['live'])
      expect(recovery.removed).toBe(0)
      expect(store.getDocument('live')).toBeDefined()
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps resuming an interrupted import whose base still exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-live-base-'))
    const domain = fakeDomain()
    const bases = domain.table('bases') as unknown as FakeTable<string, unknown>
    const documents = domain.table('documents') as unknown as FakeTable<string, unknown>
    await bases.put('b1', base('b1'))
    await documents.put('partial', { ...doc('partial', 'b1'), rawText: 'half embedded', incomplete: true })

    const store = await domainStore(dir, domain)
    try {
      expect((await store.recoverInterruptedImports(Date.now() + 1)).resume).toEqual(['partial'])
      expect(store.getDocument('partial')).toBeDefined()
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
