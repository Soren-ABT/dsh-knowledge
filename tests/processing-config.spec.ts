import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, resolveConfig, resolveConfigFor } from '../src/knowledge/config.js'
import { baseConfigSchema, configOverridesSchema, knowledgeDomainSpec } from '../src/knowledge/domain.js'
import type { DocumentEvidence, DocumentProcessingInfo } from '../src/knowledge/processing-types.js'
import { KnowledgeApi } from '../src/ui/client/api.js'
import { renderKnowledgeDocumentPage, renderKnowledgeEvidence } from '../src/tool-knowledge/index.js'

const processing: DocumentProcessingInfo = {
  revision: 'revision-1', artifactId: 'artifact-1', sourceHash: 'hash', provider: 'mineru-local',
  processorVersion: '4.0.6', optionsFingerprint: 'options', parsedAt: 1,
  completeness: 'partial', processedPages: [0], pageCount: 2,
  warnings: [{ code: 'missing_page', message: 'Page 2 was not parsed' }],
}

describe('document processing configuration', () => {
  // The public Schema<Config> annotation accepts Config, though runtime defaults accept {}.
  const deployment = Config({} as Config)

  it('defaults local service options without changing the legacy provider', () => {
    const legacy = { ...deployment }
    delete legacy.mineruLocalUrl
    delete legacy.mineruLocalApiKey
    delete legacy.mineruTier
    delete legacy.documentProcessingTimeoutMs
    delete legacy.structuredChunking
    expect(resolveConfig(legacy, {})).toMatchObject({
      documentProcessorProvider: 'builtin', mineruLocalUrl: 'http://127.0.0.1:8000',
      mineruLocalApiKey: '', mineruTier: 'basic', documentProcessingTimeoutMs: 1_800_000, structuredChunking: true,
    })
    expect(resolveConfig(legacy, { documentProcessorProvider: 'mineru', mineruApiKey: 'cloud-key' }))
      .toMatchObject({ documentProcessorProvider: 'mineru', mineruApiKey: 'cloud-key', mineruLocalApiKey: '' })
  })

  it('keeps local/cloud credentials distinct and applies per-base overrides last', () => {
    const value = resolveConfigFor(deployment, {
      documentProcessorProvider: 'mineru-local', mineruApiKey: 'cloud-key', mineruLocalApiKey: 'global-local-key',
      mineruLocalUrl: 'http://127.0.0.1:9000', mineruTier: 'standard', structuredChunking: true,
    }, { mineruLocalApiKey: 'base-local-key', mineruTier: 'flash', structuredChunking: false })
    expect(value).toMatchObject({
      documentProcessorProvider: 'mineru-local', mineruApiKey: 'cloud-key', mineruLocalApiKey: 'base-local-key',
      mineruLocalUrl: 'http://127.0.0.1:9000', mineruTier: 'flash', structuredChunking: false,
    })
  })

  it('bounds processor deadlines at every resolution layer', () => {
    expect(resolveConfig(deployment, { documentProcessingTimeoutMs: 1 }).documentProcessingTimeoutMs).toBe(10_000)
    expect(resolveConfig(deployment, { documentProcessingTimeoutMs: Infinity }).documentProcessingTimeoutMs).toBe(1_800_000)
    expect(resolveConfigFor(deployment, {}, { documentProcessingTimeoutMs: 9_000_000 }).documentProcessingTimeoutMs).toBe(7_200_000)
  })

  it('persists all local settings and rejects unsupported values in both schemas', () => {
    const settings = { documentProcessorProvider: 'mineru-local', mineruLocalUrl: 'http://localhost:8000', mineruLocalApiKey: 'secret', mineruTier: 'advanced', documentProcessingTimeoutMs: 30_000, structuredChunking: false }
    for (const schema of [baseConfigSchema, configOverridesSchema]) {
      expect(schema.parse(settings)).toEqual(settings)
      expect(schema.safeParse({ mineruTier: 'auto' }).success).toBe(false)
      expect(schema.safeParse({ documentProcessorProvider: 'unknown' }).success).toBe(false)
      for (const timeout of [0, 9999, 7_200_001, 12_345.5]) {
        expect(schema.safeParse({ documentProcessingTimeoutMs: timeout }).success).toBe(false)
      }
    }
  })

  it('round-trips processing metadata while accepting existing documents without it', () => {
    const legacy = { id: 'doc', baseId: 'base', title: 'manual', sourceType: 'file', charCount: 10, chunkCount: 1, createdAt: 0 }
    const schema = knowledgeDomainSpec.tables.documents.valueSchema
    expect(schema.parse(legacy)).toEqual(legacy)
    expect(schema.parse({ ...legacy, processing })).toEqual({ ...legacy, processing })
    expect(schema.safeParse({ ...legacy, processing: { ...processing, processedPages: [-1] } }).success).toBe(false)
  })
})

describe('processing client API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('checks only saved configuration and sends explicit reindex/cancel operations', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, value: {} })))
    // Return a new body on each call: Response bodies are consumed once.
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetcher)
    const api = new KnowledgeApi()
    await api.checkProcessor('base-1')
    await api.reindexDocument('doc/1', 'reparse')
    await api.reindexDocument('doc/1', 'rechunk')
    await api.cancelProcessing('doc/1')
    expect(fetcher.mock.calls[0]).toMatchObject(['/knowledge/processors/check', { method: 'POST', body: '{"baseId":"base-1"}' }])
    expect(fetcher.mock.calls[1]).toMatchObject(['/knowledge/documents/doc%2F1/reindex', { method: 'POST', body: '{"mode":"reparse"}' }])
    expect(fetcher.mock.calls[2]).toMatchObject(['/knowledge/documents/doc%2F1/reindex', { method: 'POST', body: '{"mode":"rechunk"}' }])
    expect(fetcher.mock.calls[3]).toMatchObject(['/knowledge/documents/doc%2F1/cancel', { method: 'POST' }])
  })

  it('preserves page zero and block offsets in bounded evidence continuation', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetcher)
    await new KnowledgeApi().readDocumentEvidence('doc/1', { pageIndex: 0, blockId: 'table & 1', blockOffset: 42, maxTokens: 128 })
    const url = new URL(String(fetcher.mock.calls[0][0]), 'https://dsh.invalid')
    expect(url.pathname).toBe('/knowledge/documents/doc%2F1/evidence')
    expect(Object.fromEntries(url.searchParams)).toEqual({ pageIndex: '0', blockId: 'table & 1', blockOffset: '42', maxTokens: '128' })
  })
})

describe('bounded evidence presentation', () => {
  it('renders actual completeness, page, region and long-block continuation', () => {
    const evidence: DocumentEvidence = {
      documentId: 'doc', title: 'manual', processing, assets: [], estimatedTokens: 100, truncated: true,
      blocks: [{ id: 'table-1', index: 0, type: 'table', text: '<table>evidence</table>', textStart: 5, textEnd: 1000, pageIndex: 0, bbox: { coordinateSpace: 'normalized', x0: 0, y0: 0.1, x1: 1, y1: 0.5 } }],
      next: { blockId: 'table-1', blockOffset: 27 },
    }
    const rendered = renderKnowledgeEvidence(evidence)
    expect(rendered).toContain('completeness=partial')
    expect(rendered).toContain('Page 2 was not parsed')
    expect(rendered).toContain('page 1 (pageIndex=0)')
    expect(rendered).toContain('normalized region=0,0.1,1,0.5')
    expect(rendered).toContain('blockId="table-1", blockOffset=27')
    expect(rendered).not.toContain('[complete evidence selection]')
  })

  it('includes per-chunk provenance in document pagination', () => {
    const rendered = renderKnowledgeDocumentPage({ title: 'manual', chunkCount: 1, truncated: false, processing,
      chunks: [{ index: 0, text: 'table evidence', sourceSpans: [{ revision: 'revision-1', blockId: 'table-1', blockType: 'table', chunkStart: 0, chunkEnd: 14, blockStart: 0, blockEnd: 14, pageIndex: 0 }] }],
    })
    expect(rendered).toContain('p.1')
    expect(rendered).toContain('table:table-1')
    expect(rendered).toContain('completeness=partial')
  })

  it('keeps browser evidence inert and uses explicit same-origin assets', async () => {
    const ui = await readFile(new URL('../src/ui/client/processing-evidence.tsx', import.meta.url), 'utf8')
    expect(ui).not.toContain('dangerouslySetInnerHTML')
    expect(ui).not.toContain('<img')
    expect(ui).toContain('encodeURIComponent(assetId)')
    expect(ui).toContain('encodeURIComponent(revision)')
    expect(ui).toContain('Number.isSafeInteger(pageIndex)')
    expect(ui).toContain('#page=${pageIndex + 1}')
    expect(ui).toContain('setHistory(previous => [...previous, next])')
    expect(ui).toContain('previous.slice(0, -1)')
    expect(ui).toContain('JSON.stringify([props.documentId, props.revision])')
    expect(ui).toContain("t('evidenceRetry')")
  })
})
