import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { hashEmbeddingText } from '../src/knowledge/chunkdb.js'
import type { Config } from '../src/knowledge/config.js'
import type { KnowledgeService as KnowledgeServiceType } from '../src/knowledge/index.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { EmbeddingProvider } from '../src/knowledge/types.js'

// Replace the embedding module with a deterministic stub so we can count how
// often the API would actually be called (the reuse path must not call it).
vi.mock('../src/knowledge/embed.js', () => ({
  DEFAULT_LOCAL_MODEL: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
  embedTexts: vi.fn(async (_provider: EmbeddingProvider, _baseUrl: string, _model: string, _apiKey: string, texts: readonly string[]) =>
    texts.map(text => {
      // Deterministic 4-dim vector from the text hash — same text → same vector.
      const hex = hashEmbeddingText(text)
      const parts = [0, 1, 2, 3].map(i => (parseInt(hex.slice(i * 2, i * 2 + 2), 16) ?? 0) / 255 + 0.1)
      const norm = Math.sqrt(parts.reduce((sum, v) => sum + v * v, 0))
      return parts.map(v => v / norm)
    }),
  ),
  getLocalModelStatus: vi.fn(() => ({ model: '', status: 'idle', progress: 0, message: '' })),
  isLocalModelDownloaded: vi.fn(async () => false),
  loadLocalModel: vi.fn(async () => {}),
  removeLocalModel: vi.fn(async () => {}),
  cancelLocalModel: vi.fn(async () => {}),
  setLocalModelCacheDir: vi.fn(),
  setHfEndpoint: vi.fn(),
  applyGlobalProxy: vi.fn(),
}))

import { embedTexts } from '../src/knowledge/embed.js'

const embedTextsMock = vi.mocked(embedTexts)

const DEFAULT_CONFIG: Config = {
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
  rrfVectorWeight: 1,
  embeddingBatchSize: 32,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
}

function fakeWebServer() {
  const routes: unknown[] = []
  return {
    routes,
    register(route: unknown) {
      routes.push(route)
      return () => {}
    },
  }
}

async function mountService(): Promise<KnowledgeServiceType> {
  const ctx = new Context()
  ctx.provide('webServer', fakeWebServer())
  await ctx.plugin(KnowledgeService, DEFAULT_CONFIG)
  return ctx.get('knowledge') as unknown as KnowledgeServiceType
}

describe('embedding hash reuse (Cherry decision A4)', () => {
  it('reindexes without re-embedding unchanged chunk text', async () => {
    embedTextsMock.mockClear()
    const service = await mountService()
    const base = await service.createBase({
      name: 'reuse',
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://x', embeddingModel: 'm1', embeddingApiKey: 'k' },
    })
    const content = 'word '.repeat(50) + '\n\n' + 'another paragraph '.repeat(40)
    const doc = await service.addTextDocument({ baseId: base.id, title: 't', content })
    const firstCalls = embedTextsMock.mock.calls.length
    expect(firstCalls).toBeGreaterThan(0)

    // Reindex with identical content: every chunk's search text hashes to a
    // stored vector, so the embedding API must not be called again.
    embedTextsMock.mockClear()
    await service.reindexDocument(doc.id)
    expect(embedTextsMock).not.toHaveBeenCalled()

    // A chunk-size change re-embeds only the newly sliced chunks.
    embedTextsMock.mockClear()
    await service.renameBase(base.id, { config: { chunkSize: 300 } })
    await service.reindexDocument(doc.id)
    expect(embedTextsMock).toHaveBeenCalled()

    // A different embedding model invalidates every hash → full re-embed.
    embedTextsMock.mockClear()
    await service.renameBase(base.id, { config: { embeddingModel: 'm2' } })
    await service.reindexDocument(doc.id)
    const modelSwitchTexts = embedTextsMock.mock.calls.flatMap(call => call[4])
    expect(modelSwitchTexts.length).toBeGreaterThan(0)
  })

  it('reuses vectors across documents with identical chunk text', async () => {
    embedTextsMock.mockClear()
    const service = await mountService()
    const base = await service.createBase({
      name: 'cross',
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://x', embeddingModel: 'm1', embeddingApiKey: 'k' },
    })
    // The shared paragraph is its own block, so it slices into identical
    // chunks in both documents (same title → same context → same search text).
    const shared = 'shared paragraph text '.repeat(60)
    const docA = await service.addTextDocument({ baseId: base.id, title: 'A', content: `AAA\n\n${shared}` })
    expect(embedTextsMock).toHaveBeenCalled()

    // Doc B reuses A's vectors for the shared paragraph; only the 'BBB' block
    // is embedded.
    embedTextsMock.mockClear()
    const docB = await service.addTextDocument({ baseId: base.id, title: 'A', content: `BBB\n\n${shared}` })
    expect(embedTextsMock).toHaveBeenCalled()
    const bTexts = embedTextsMock.mock.calls.flatMap(call => call[4])
    expect(bTexts.some(text => text.includes('shared paragraph'))).toBe(false)
    expect(bTexts.some(text => text.includes('BBB'))).toBe(true)

    // The reused chunks carry the same embedding model tag and vectors as A's.
    const chunksB = service.listChunks(docB.id)
    const chunksA = service.listChunks(docA.id)
    const sharedB = chunksB.find(c => c.text.includes('shared paragraph'))
    const sharedA = chunksA.find(c => c.text.includes('shared paragraph'))
    expect(sharedB?.embedding).toEqual(sharedA?.embedding)
    expect(sharedB?.embeddingModel).toBe('openai:m1')
  })

  it('reuses across bases when the model matches', async () => {
    embedTextsMock.mockClear()
    const service = await mountService()
    const cfg = { embeddingProvider: 'openai', embeddingBaseUrl: 'http://x', embeddingModel: 'm1', embeddingApiKey: 'k' } as const
    const base1 = await service.createBase({ name: 'b1', config: cfg })
    const base2 = await service.createBase({ name: 'b2', config: cfg })
    const content = 'identical corpus text '.repeat(80)
    await service.addTextDocument({ baseId: base1.id, title: 'one', content })
    embedTextsMock.mockClear()
    await service.addTextDocument({ baseId: base2.id, title: 'one', content })
    // Everything already embedded in base1 → nothing re-embedded.
    expect(embedTextsMock).not.toHaveBeenCalled()
  })
})
