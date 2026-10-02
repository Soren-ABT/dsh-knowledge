import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { ChunkDatabase, hashEmbeddingText, searchTextOf } from '../src/knowledge/chunkdb.js'
import { DocumentGenerationCommitError, openStore, type StorageDomainFacility, type Store } from '../src/knowledge/store.js'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import type { KnowledgeBase, KnowledgeChunk, KnowledgeDocument } from '../src/knowledge/types.js'

const base: KnowledgeBase = { id: 'base', name: 'Fixture', description: '', createdAt: 1, updatedAt: 1 }
const document: KnowledgeDocument = { id: 'doc', baseId: 'base', title: 'fixture.pdf', sourceType: 'file', charCount: 8, chunkCount: 1, rawText: 'old body', createdAt: 1, updatedAt: 1 }
const oldChunk: KnowledgeChunk = { id: 'old', docId: 'doc', baseId: 'base', index: 0, text: 'old body', embedding: [1, 0], embeddingModel: 'test' }
const nextDocument: KnowledgeDocument = { ...document, rawText: 'new body', updatedAt: 2, processing: {
  revision: 'rev-2', artifactId: 'art-2', sourceHash: 'hash', provider: 'mineru-local', optionsFingerprint: 'options', parsedAt: 2, completeness: 'complete', warnings: [],
} }
const newChunk: KnowledgeChunk = { ...oldChunk, id: 'new', text: 'new body', processingRevision: 'rev-2', sourceSpans: [
  { revision: 'rev-2', blockId: 'block-2', blockType: 'text', chunkStart: 0, chunkEnd: 8, blockStart: 10, blockEnd: 18, pageIndex: 2 },
] }

function domainFixture() {
  const bases = new Map<string, KnowledgeBase>()
  const documents = new Map<string, KnowledgeDocument>()
  const documentPut = vi.fn(async (id: string, doc: KnowledgeDocument) => { documents.set(id, doc) })
  const documentDelete = vi.fn(async (id: string) => documents.delete(id))
  const table = (map: Map<string, unknown>) => ({ get: (id: string) => map.get(id), entries: () => map.entries(),
    put: async (id: string, value: unknown) => { map.set(id, value) }, delete: async (id: string) => map.delete(id) })
  const domain = { table: (name: string) => name === 'bases' ? table(bases) : {
    ...table(documents), put: documentPut, delete: documentDelete,
  }, global: { get: () => ({}), set: async () => {} }, close: async () => {} } as unknown as Domain<typeof knowledgeDomainSpec>
  return { bases, documents, documentPut, documentDelete, facility: { open: async () => domain } as unknown as StorageDomainFacility }
}

const dirs: string[] = []
const stores: Store[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function storage(fixture = domainFixture()) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-generations-'))
  dirs.push(dir)
  const options = { chunkStorePath: join(dir, 'chunks.sqlite'), legacyJsonPath: join(dir, 'no-legacy.json') }
  const store = await openStore(fixture.facility, options)
  stores.push(store)
  await store.putBase(base)
  await store.putDocument(document)
  await store.putChunks([oldChunk])
  return { ...fixture, store, options }
}

describe('generation staging and atomic publication', () => {
  it('keeps candidate batches invisible, upserts idempotently, and reuses their vectors', async () => {
    const { store } = await storage()
    await store.stageDocumentGeneration(nextDocument, [newChunk])
    await store.stageDocumentGeneration(nextDocument, [newChunk])
    expect(store.listChunksByDoc(document.id)).toEqual([oldChunk])
    expect(store.getStagedDocumentGeneration(document.id)?.chunks).toEqual([newChunk])
    expect((await store.retrievalLane!.lexical('new', [base.id], 10)).hits).toEqual([])
    expect(store.listEmbeddingVectorsByHashes([hashEmbeddingText(searchTextOf(newChunk))], 'test').size).toBe(1)
    await store.commitDocumentGeneration(nextDocument, [newChunk])
    expect(store.getDocument(document.id)).toEqual(nextDocument)
    expect(store.listChunksByDoc(document.id)).toEqual([newChunk])
    expect(store.getStagedDocumentGeneration(document.id)).toBeUndefined()
    expect((await store.retrievalLane!.vector([1, 0], [base.id], 10)).hits[0].sourceSpans).toEqual(newChunk.sourceSpans)
  })

  it('preserves old live evidence on invalid publication and clears a prior candidate revision', async () => {
    const { store } = await storage()
    await store.stageDocumentGeneration(nextDocument, [newChunk])
    await expect(store.commitDocumentGeneration({ ...nextDocument, chunkCount: 2 }, [newChunk])).rejects.toThrow('count mismatch')
    expect(store.listChunksByDoc(document.id)).toEqual([oldChunk])
    const laterDoc = { ...nextDocument, processing: { ...nextDocument.processing!, revision: 'rev-3' } }
    const laterChunk = { ...newChunk, id: 'later', processingRevision: 'rev-3', sourceSpans: newChunk.sourceSpans!.map(span => ({ ...span, revision: 'rev-3' })) }
    await store.stageDocumentGeneration(laterDoc, [laterChunk])
    expect(store.getStagedDocumentGeneration(document.id)?.chunks.map(chunk => chunk.id)).toEqual(['later'])
  })

  it('survives failure between SQL publication and DomainKV and replays before ordinary import recovery', async () => {
    const fixture = await storage()
    // Prime the vector cache before replacing its generation.
    await fixture.store.retrievalLane!.vector([1, 0], [base.id], 10)
    fixture.documentPut.mockRejectedValueOnce(new Error('simulated disk error'))
    await expect(fixture.store.commitDocumentGeneration(nextDocument, [newChunk])).rejects.toBeInstanceOf(DocumentGenerationCommitError)
    expect(fixture.documents.get(document.id)).toEqual(document)
    // In-process consumers see the journal's correct metadata, not old pages.
    expect(fixture.store.getDocument(document.id)).toEqual(nextDocument)
    expect(fixture.store.listDocuments(base.id)).toEqual([nextDocument])
    expect((await fixture.store.retrievalLane!.vector([1, 0], [base.id], 10)).hits[0].id).toBe('new')
    await fixture.store.close()
    stores.splice(stores.indexOf(fixture.store), 1)
    const reopened = await openStore(fixture.facility, fixture.options)
    stores.push(reopened)
    expect(reopened.getDocument(document.id)).toEqual(nextDocument)
    expect(reopened.listChunksByDoc(document.id)).toEqual([newChunk])
    expect(await reopened.recoverDocumentGenerations()).toBe(0)
  })

  it('does not resurrect an externally deleted document from a pending recovery record', async () => {
    const fixture = await storage()
    fixture.documentPut.mockRejectedValueOnce(new Error('simulated disk error'))
    await expect(fixture.store.commitDocumentGeneration(nextDocument, [newChunk])).rejects.toMatchObject({ published: true })
    fixture.documents.delete(document.id)
    expect(await fixture.store.recoverDocumentGenerations()).toBe(0)
    expect(fixture.store.getDocument(document.id)).toBeUndefined()
    expect(fixture.store.listChunksByDoc(document.id)).toEqual([])
    await expect(fixture.store.stageDocumentGeneration(nextDocument, [newChunk])).rejects.toThrow('target_missing')
    await expect(fixture.store.commitDocumentGeneration(nextDocument, [newChunk])).rejects.toThrow('target_missing')
  })

  it('rejects stale metadata writes while a published generation is pending', async () => {
    const fixture = await storage()
    fixture.documentPut.mockRejectedValueOnce(new Error('simulated disk error'))
    await expect(fixture.store.commitDocumentGeneration(nextDocument, [newChunk])).rejects.toMatchObject({ published: true })
    await expect(fixture.store.putDocument(document)).rejects.toThrow('stale_document_generation')
    await fixture.store.deleteDocument(document.id)
    expect(await fixture.store.recoverDocumentGenerations()).toBe(0)
    expect(fixture.store.getDocument(document.id)).toBeUndefined()
  })

  it('supports memory stores with identical staging and replacement semantics', async () => {
    const store = await openStore(undefined)
    stores.push(store)
    await store.putBase(base)
    await store.putDocument(document)
    await store.putChunks([oldChunk])
    await store.stageDocumentGeneration(nextDocument, [newChunk])
    expect(store.listChunksByDoc(document.id)).toEqual([oldChunk])
    await store.commitDocumentGeneration(nextDocument, [newChunk])
    expect(store.getDocument(document.id)).toEqual(nextDocument)
    expect(store.listChunksByDoc(document.id)).toEqual([newChunk])
    await store.deleteDocument(document.id)
    await expect(store.commitDocumentGeneration(nextDocument, [newChunk])).rejects.toThrow('target_missing')
  })
})

describe('SQLite evidence persistence', () => {
  it('round-trips evidence in all lanes, cache updates and reopening the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-source-spans-'))
    dirs.push(dir)
    const path = join(dir, 'chunks.sqlite')
    let db = new ChunkDatabase(path)
    try {
      db.putChunks([newChunk])
      expect(db.getChunk('new')).toEqual(newChunk)
      expect((await db.lexical('new', [base.id], 10)).hits[0].sourceSpans).toEqual(newChunk.sourceSpans)
      expect((await db.vector([1, 0], [base.id], 10)).hits[0].sourceSpans).toEqual(newChunk.sourceSpans)
      const edited = { ...newChunk, sourceSpans: newChunk.sourceSpans!.map(span => ({ ...span, pageIndex: 6 })) }
      db.putChunkBatch([edited])
      expect((await db.vector([1, 0], [base.id], 10)).hits[0].sourceSpans?.[0].pageIndex).toBe(6)
      db.close()
      db = new ChunkDatabase(path)
      expect(db.getChunk('new')).toEqual(edited)
    } finally { db.close() }
  })
})
