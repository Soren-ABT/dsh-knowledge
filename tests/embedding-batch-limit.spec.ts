/**
 * Remote embedding batch-cap regression (issue #62). OpenAI-compatible
 * endpoints such as DashScope/Bailian can cap the number of inputs per request
 * at 20–25. The import must shrink the batch and retry the same slice instead
 * of failing the whole document.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'
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

const TEST_CONFIG: Config = {
  embeddingProvider: 'openai', embeddingBaseUrl: 'http://embed.invalid', embeddingModel: 'qwen3.7-text-embedding-flash', embeddingApiKey: 'k',
  rerankModel: '', rerankBaseUrl: '', rerankApiKey: '', localRerankTimeoutMs: 60000,
  smartChunk: true, chunkSeparator: '\n\n', chunkSize: 64, chunkOverlap: 0,
  topK: 6, searchMode: 'vector', similarityThreshold: 0, mmrDiversity: 0,
  rrfVectorWeight: 1, embeddingBatchSize: 32, siblingChunks: 0,
  localModelCacheDir: '', hfEndpoint: '', chunkStorePath: '',
  documentProcessorProvider: 'builtin', mineruApiKey: '', mineruApiHost: '',
  semanticChunk: false, semanticChunkThreshold: 0.75, chunkTokenLimit: 0,
  conflictStrategy: 'rename', urlRefreshHours: 0,
  imageCaptionProvider: 'off', imageCaptionModel: '', imageCaptionBaseUrl: '', imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true, autoRetrieve: true, autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60000,
}

const homes: Array<{ dispose(): Promise<void>; dir: string }> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const { dispose, dir } of homes.splice(0)) {
    await dispose().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function mount(): Promise<KnowledgeService> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-i62-'))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  const fiber = await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  homes.push({ dispose: () => fiber.dispose(), dir })
  return ctx.get('knowledge') as KnowledgeService
}

const paragraphs = (count: number): string => Array.from({ length: count }, (_, index) =>
  `第 ${index + 1} 段：这是用于测试嵌入批次的段落内容，长度足够形成独立分块。`).join('\n\n')

const storeOf = (service: KnowledgeService): Store => (service as unknown as { store: Store }).store

describe('remote embedding batch caps (issue #62)', () => {
  it('halves the slice and completes the document when the endpoint caps inputs at 20', async () => {
    const calls: Array<{ size: number; ok: boolean }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
      const inputs = body.input ?? []
      if (inputs.length > 20) {
        calls.push({ size: inputs.length, ok: false })
        return new Response(JSON.stringify({
          error: {
            message: '<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, it should not be larger than 20.: input.contents',
            type: 'invalid_request_error', code: 'invalid_parameter_error',
          },
        }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      calls.push({ size: inputs.length, ok: true })
      return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 0, 0] })) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))

    const service = await mount()
    const base = await service.createBase({ name: 'issue62' })
    const big = await service.addTextDocument({ baseId: base.id, title: 'big', content: paragraphs(30) })
    const small = await service.addTextDocument({ baseId: base.id, title: 'small', content: paragraphs(10) })
    await service.waitForIdle()

    const store = storeOf(service)
    const embedded = (id: string): number => store.listChunksByDoc(id).filter(chunk => chunk.embedding !== undefined).length

    expect(store.listChunksByDoc(big.id)).toHaveLength(30)
    expect(embedded(big.id)).toBe(30)
    expect(store.getDocument(big.id)?.embeddingError).toBeUndefined()
    expect(embedded(small.id)).toBe(10)

    // One over-cap request, then the retried halves — no 3× retry storm of the
    // same oversized batch (the old behavior), and no repeated failures.
    // 32 halves to 16, so the 30-chunk document lands as 16 + 14.
    expect(calls.filter(call => !call.ok)).toEqual([{ size: 30, ok: false }])
    expect(calls.filter(call => call.ok).map(call => call.size)).toEqual([16, 14, 10])
  }, 120_000)
})
