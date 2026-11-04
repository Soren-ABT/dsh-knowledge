/**
 * Multi-query scoring regression (issue #59). Variants are fused with RRF, so
 * the fused score is a rank value, not a vector similarity. The vector
 * similarityThreshold must only filter the per-variant cosine scores (applied
 * inside finishSearch) and rerank relevance scores — never the fused score.
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

const rerankMock = vi.hoisted(() => vi.fn())

vi.mock('../src/knowledge/rerank.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/knowledge/rerank.js')>()
  return { ...actual, rerankCandidates: rerankMock }
})

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
  embeddingProvider: 'openai', embeddingBaseUrl: 'http://embed.invalid', embeddingModel: 'test-embed', embeddingApiKey: 'k',
  rerankModel: '', rerankBaseUrl: '', rerankApiKey: '', localRerankTimeoutMs: 60000,
  smartChunk: true, chunkSeparator: '\n\n', chunkSize: 800, chunkOverlap: 100,
  topK: 6, searchMode: 'vector', similarityThreshold: 0.5, mmrDiversity: 0,
  rrfVectorWeight: 1, embeddingBatchSize: 32, siblingChunks: 1,
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
  rerankMock.mockReset()
  vi.unstubAllGlobals()
  for (const { dispose, dir } of homes.splice(0)) {
    await dispose().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** Embeddings are marker-driven one-hot vectors, so cosine is exactly 1 for a
 *  matching marker and 0 otherwise — no model, no network, no flakiness. */
function vectorFor(text: string): number[] {
  if (text.includes('alpha')) return [1, 0, 0]
  if (text.includes('beta')) return [0, 1, 0]
  if (text.includes('gamma')) return [0, 0, 1]
  return [1, 1, 1]
}

async function mountWithEmbeddings(): Promise<KnowledgeService> {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown }
    const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')]
    return new Response(JSON.stringify({ data: inputs.map(text => ({ embedding: vectorFor(text) })) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
  const dir = await mkdtemp(join(tmpdir(), 'kb-i59-'))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  const fiber = await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  homes.push({ dispose: () => fiber.dispose(), dir })
  return ctx.get('knowledge') as KnowledgeService
}

async function seed(service: KnowledgeService): Promise<string> {
  const base = await service.createBase({ name: 'issue59' })
  for (const marker of ['alpha', 'beta', 'gamma']) {
    await service.addTextDocument({
      baseId: base.id,
      title: `${marker} 文档`,
      content: `${marker} 主题内容：这是 ${marker} 的说明。`,
    })
  }
  await service.waitForIdle()
  return base.id
}

describe('multi-query relevance thresholds (issue #59)', () => {
  it('keeps chunks whose own vector similarity passed the threshold', async () => {
    const service = await mountWithEmbeddings()
    const baseId = await seed(service)

    const single = await service.search({ query: 'alpha 是什么', baseId, mode: 'vector', topK: 5, threshold: 0.5 })
    expect(single.mode).toBe('vector')
    expect(single.scoreKind).toBe('vector_similarity')
    expect(single.hits.map(hit => hit.documentTitle)).toEqual(['alpha 文档'])
    expect(single.hits[0]!.score).toBeGreaterThanOrEqual(0.5)

    // Each variant matches exactly one chunk (cosine 1.0, above the threshold),
    // but that chunk appears in only one of three fused rankings, so its
    // normalized RRF score is 1/3. The vector threshold must not drop it.
    const multi = await service.search({
      query: 'alpha 是什么',
      queries: ['beta 是什么', 'gamma 是什么'],
      baseId,
      mode: 'vector',
      topK: 5,
      threshold: 0.5,
    })
    expect(multi.mode).toBe('vector')
    expect(multi.scoreKind).toBe('rrf')
    expect(multi.hits).toHaveLength(3)
    expect(multi.hits.every(hit => hit.score < 0.5)).toBe(true)
    expect(multi.hits.map(hit => hit.documentTitle).sort()).toEqual(['alpha 文档', 'beta 文档', 'gamma 文档'])
  }, 120_000)

  it('still applies the threshold to rerank relevance scores', async () => {
    const service = await mountWithEmbeddings()
    const baseId = await seed(service)
    await service.setConfig({ rerankModel: 'test-rerank', rerankBaseUrl: 'http://rerank.invalid', rerankApiKey: 'k' })

    rerankMock.mockImplementation(async (
      _baseUrl: string, _model: string, _apiKey: string, _query: string,
      candidates: ReadonlyArray<{ id: string }>,
    ) => new Map(candidates.map(candidate => [candidate.id, 0.1])))
    const below = await service.search({
      query: 'alpha 是什么', queries: ['beta 是什么'], baseId, mode: 'vector', topK: 5, threshold: 0.5,
    })
    expect(below.reranked).toBe(true)
    expect(below.scoreKind).toBe('rerank')
    expect(below.hits).toHaveLength(0)

    rerankMock.mockImplementation(async (
      _baseUrl: string, _model: string, _apiKey: string, _query: string,
      candidates: ReadonlyArray<{ id: string }>,
    ) => new Map(candidates.map(candidate => [candidate.id, 0.9])))
    const above = await service.search({
      query: 'alpha 是什么', queries: ['beta 是什么'], baseId, mode: 'vector', topK: 5, threshold: 0.5,
    })
    expect(above.reranked).toBe(true)
    expect(above.hits.length).toBeGreaterThan(0)
  }, 120_000)
})
