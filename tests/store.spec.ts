import { describe, expect, it } from 'vitest'
import { openStore } from '../src/knowledge/store.js'
import type { KnowledgeBase, KnowledgeChunk, KnowledgeDocument } from '../src/knowledge/types.js'

async function memoryStore() {
  return openStore(undefined)
}

function base(id: string): KnowledgeBase {
  return { id, name: `base ${id}`, description: '', createdAt: 1, updatedAt: 1 }
}

function doc(id: string, baseId: string): KnowledgeDocument {
  return { id, baseId, title: `doc ${id}`, sourceType: 'text', charCount: 10, chunkCount: 1, createdAt: 1 }
}

function chunk(id: string, docId: string, baseId: string): KnowledgeChunk {
  return { id, docId, baseId, index: 0, text: `chunk ${id}` }
}

describe('MemoryStore (openStore(undefined))', () => {
  it('persists bases', async () => {
    const store = await memoryStore()
    await store.putBase(base('b1'))
    expect(store.getBase('b1')?.name).toBe('base b1')
    expect(store.listBases()).toHaveLength(1)
    await store.close()
  })

  it('deletes bases', async () => {
    const store = await memoryStore()
    await store.putBase(base('b1'))
    await store.deleteBase('b1')
    expect(store.getBase('b1')).toBeUndefined()
    await store.close()
  })

  it('lists documents and chunks by base', async () => {
    const store = await memoryStore()
    await store.putBase(base('b1'))
    await store.putDocument(doc('d1', 'b1'))
    await store.putDocument(doc('d2', 'b1'))
    await store.putDocument(doc('d3', 'other'))
    await store.putChunks([chunk('c1', 'd1', 'b1'), chunk('c2', 'd1', 'b1')])
    expect(store.listDocuments('b1')).toHaveLength(2)
    expect(store.listChunks('b1')).toHaveLength(2)
    expect(store.listChunksByDoc('d1')).toHaveLength(2)
    await store.close()
  })

  it('round-trips config overrides', async () => {
    const store = await memoryStore()
    expect(store.getConfigOverrides()).toEqual({})
    await store.setConfigOverrides({ embeddingProvider: 'openai', topK: 5 })
    expect(store.getConfigOverrides()).toEqual({ embeddingProvider: 'openai', topK: 5 })
    await store.close()
  })

  it('round-trips group names next to global overrides', async () => {
    const store = await memoryStore()
    expect(store.getGroups()).toEqual([])
    await store.setConfigOverrides({ topK: 5 })
    await store.setGroups(['工作', '研究'])
    expect(store.getGroups()).toEqual(['工作', '研究'])
    expect(store.getConfigOverrides()).toEqual({ topK: 5 })
    await store.setGroups([])
    expect(store.getGroups()).toEqual([])
    expect(store.getConfigOverrides()).toEqual({ topK: 5 })
    await store.close()
  })

  it('stores base group membership', async () => {
    const store = await memoryStore()
    await store.putBase({ ...base('b1'), group: '工作' })
    expect(store.getBase('b1')?.group).toBe('工作')
    await store.putBase({ ...base('b1'), group: undefined })
    expect(store.getBase('b1')?.group).toBeUndefined()
    await store.close()
  })
})
