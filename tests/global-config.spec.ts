import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/knowledge/config.js'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Store } from '../src/knowledge/store.js'

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

const EMBEDDING = { embeddingProvider: 'openai', embeddingBaseUrl: 'https://embed.invalid', embeddingModel: 'old-model' } as const

async function mount() {
  const dir = await mkdtemp(join(tmpdir(), 'kb-global-config-'))
  vi.stubEnv('DSH_HOME', dir)
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] }
    return new Response(JSON.stringify({ data: body.input.map(text => ({ embedding: text.includes('alpha') ? [1, 0] : [0, 1] })) }))
  })
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  const fiber = await ctx.plugin(KnowledgeService, { ...Config({} as Config), chunkStorePath: join(dir, 'chunks.sqlite') })
  onTestFinished(async () => { await fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const service = ctx.get('knowledge') as KnowledgeService
  const store = (service as unknown as { store: Store }).store
  return { service, store, fetchMock }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('global embedding configuration', () => {
  it.each([{ embeddingModel: 'new-model' }, { embeddingProvider: 'ollama' as const }])(
    'rejects $embeddingModel$embeddingProvider on populated inheriting bases before saving any fields', async patch => {
      const { service, store, fetchMock } = await mount()
      await service.setConfig(EMBEDDING)
      const base = await service.createBase({ name: 'inherited' })
      const doc = await service.addTextDocument({ baseId: base.id, title: 'alpha', content: 'alpha evidence' })
      const before = service.getConfig()
      const chunks = store.listChunks(base.id)
      fetchMock.mockClear()
      await expect(service.setConfig({ ...patch, topK: 13 })).rejects.toThrow(/inherited.*重建知识库/)
      expect(service.getConfig()).toEqual(before)
      expect(store.listChunks(base.id)).toEqual(chunks)
      expect(fetchMock).not.toHaveBeenCalled()
      expect((await service.search({ query: 'alpha', baseId: base.id, mode: 'vector' })).hits[0]?.docId).toBe(doc.id)
    },
  )

  it('detects model changes when only the provider is overridden per base', async () => {
    const { service } = await mount()
    await service.setConfig(EMBEDDING)
    const base = await service.createBase({ name: 'partial override', config: { embeddingProvider: 'openai' } })
    await service.addTextDocument({ baseId: base.id, title: 'alpha', content: 'alpha evidence' })
    await expect(service.setConfig({ embeddingModel: 'new-model' })).rejects.toThrow('重建知识库')
    expect(service.getConfigFor(base.id).embeddingModel).toBe('old-model')
  })

  it('allows a global model change for empty bases and preserves fully overridden populated bases', async () => {
    const { service, fetchMock } = await mount()
    const empty = await service.createBase({ name: 'empty inherited' })
    const fixed = await service.createBase({ name: 'fixed', config: EMBEDDING })
    await service.addTextDocument({ baseId: fixed.id, title: 'alpha', content: 'alpha evidence' })
    const reindex = vi.spyOn(service, 'reindexBase')
    fetchMock.mockClear()
    await service.setConfig({ ...EMBEDDING, embeddingModel: 'new-model' })
    expect(service.getConfigFor(empty.id).embeddingModel).toBe('new-model')
    expect(service.getConfigFor(fixed.id).embeddingModel).toBe('old-model')
    expect(reindex).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('backfills all inheriting lexical bases while preserving disabled embeddings and other settings', async () => {
    const { service, store } = await mount()
    await service.setConfig({ topK: 9 })
    const bases = await Promise.all(['first', 'second'].map(name => service.createBase({ name })))
    const disabled = await service.createBase({ name: 'disabled', config: { embeddingProvider: 'none' } })
    const documents = []
    for (const base of [...bases, disabled]) {
      documents.push(await service.addTextDocument({ baseId: base.id, title: 'alpha', content: 'alpha evidence' }))
    }
    await service.waitForIdle()
    await service.setEnabled(false)
    await service.setEnabledBaseIds([bases[0]!.id])
    const reindex = vi.spyOn(service, 'reindexBase')
    await service.setConfig(EMBEDDING)
    await service.waitForIdle()
    expect(reindex.mock.calls.map(([id]) => id).sort()).toEqual(bases.map(base => base.id).sort())
    for (const base of bases) {
      expect(store.listChunks(base.id).every(chunk => chunk.embedding?.length === 2)).toBe(true)
      const result = await service.search({ query: 'alpha', baseId: base.id, mode: 'vector' })
      expect(result.mode).toBe('vector')
      expect(result.hits).toHaveLength(1)
    }
    expect(store.listChunks(disabled.id).every(chunk => chunk.embedding === undefined)).toBe(true)
    expect(service.getConfig().topK).toBe(9)
    expect(service.isEnabled()).toBe(false)
    expect(service.getEnabledBaseIds()).toEqual([bases[0]!.id])
    expect(service.listDocuments(disabled.id)[0]?.id).toBe(documents[2]!.id)
  })

  it('validates every affected base before saving or starting any backfill', async () => {
    const { service, store } = await mount()
    const ready = await service.createBase({ name: 'backfillable' })
    const missing = await service.createBase({ name: 'missing source' })
    await service.addTextDocument({ baseId: ready.id, title: 'alpha', content: 'alpha evidence' })
    const doc = await service.addTextDocument({ baseId: missing.id, title: 'beta', content: 'beta evidence' })
    await service.waitForIdle()
    await store.putDocument({ ...store.getDocument(doc.id)!, rawText: undefined, rawFilePath: undefined })
    const reindex = vi.spyOn(service, 'reindexBase')
    await expect(service.setConfig(EMBEDDING)).rejects.toThrow(/missing source.*无法回填/)
    expect(service.getConfig().embeddingProvider).toBe('none')
    expect(reindex).not.toHaveBeenCalled()
    expect(store.listChunks(ready.id).every(chunk => chunk.embedding === undefined)).toBe(true)
  })

  it('rejects enabling embeddings during an active import without changing the global defaults', async () => {
    const { service, fetchMock } = await mount()
    const lexical = await service.createBase({ name: 'lexical' })
    await service.addTextDocument({ baseId: lexical.id, title: 'alpha', content: 'alpha evidence' })
    const busy = await service.createBase({ name: 'busy', config: EMBEDDING })
    let release!: (response: Response) => void
    const response = new Promise<Response>(resolve => { release = resolve })
    fetchMock.mockReturnValueOnce(response)
    const pending = service.addTextDocument({ baseId: busy.id, title: 'beta', content: 'beta evidence' })
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      await expect(service.setConfig(EMBEDDING)).rejects.toThrow('有文档正在处理中')
      expect(service.getConfig().embeddingProvider).toBe('none')
    } finally {
      release(new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] })))
      await pending
    }
  })
})
