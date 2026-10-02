import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowledgeService } from '../src/knowledge/index.js'
import { Config } from '../src/knowledge/config.js'
import type { Store } from '../src/knowledge/store.js'
import { extractWithMineruLocal, probeMineruLocal } from '../src/knowledge/mineru-local.js'
import { normalizeMineruArchive } from '../src/knowledge/parsed-document.js'
import { ArtifactRepository } from '../src/knowledge/artifacts.js'
import { ProcessorTransport, processingBudget } from '../src/knowledge/processor-transport.js'

const source = new TextEncoder().encode('synthetic PDF fixture, not a user document')
async function archive(extra?: (zip: JSZip) => void) {
  const zip = new JSZip()
  zip.file('middle_json.json', JSON.stringify({ schema: 'docvortex.middle', schema_version: '2.0', is_full_document: true,
    pages: [{ page_idx: 0, blocks: [
      { type: 'doc_title', content: 'Laboratory results', bbox: [0.1, 0.1, 0.9, 0.2] },
      { type: 'table', content: [{ type: 'table_body', content: '<table><tr><th>Sample</th><th>Mass</th></tr><tr><td>A</td><td>42 kg</td></tr></table>' }] },
      { type: 'equation', content: 'E = mc^2 - 7' },
      { type: 'image', content: [{ type: 'image_body', content: '', image_path: 'images/figure.png' }, { type: 'image_caption', content: 'Figure 1. Measured sample.' }] },
    ] }] }))
  zip.file('images/figure.png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))
  extra?.(zip)
  return zip.generateAsync({ type: 'uint8array' })
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
async function mockService(options: { running?: boolean; invalidId?: boolean; version?: string } = {}) {
  const zip = await archive()
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, headers: new Headers(init?.headers), body: init?.body })
    if (url.endsWith('/v1/health')) return json({ status: 'ok', version: options.version ?? '4.0.6', features: { sources: ['file_id'], output_formats: ['zip'] } })
    if (url.endsWith('/v1/tiers')) return json({ object: 'list', data: [{ id: 'basic' }] })
    if (url.endsWith('/v1/uploads')) return json({ id: 'upload-1', status: 'pending', upload_method: 'PUT', upload_url: 'http://storage.test/object', upload_headers: {} })
    if (url === 'http://storage.test/object') return new Response(null, { status: 200 })
    if (url.endsWith('/complete')) return json({ id: 'upload-1', status: 'completed', file: { id: 'file-1', bytes: source.length, purpose: 'parse' } })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (url.includes('/v1/parse/jobs')) return json({ job_id: options.invalidId && method === 'GET' ? 'wrong' : 'job-1',
      status: options.running ? 'running' : 'completed', files: [{ status: 'completed', output_files: { zip: { file_id: 'result-1', bytes: zip.length } } }] })
    if (url.endsWith('/v1/files/result-1/content')) return new Response(Uint8Array.from(zip).buffer)
    throw new Error('unexpected test request')
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, fetcher }
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('self-hosted MinerU V1', () => {
  it('preserves SQLite search citations, reuses artifacts for rechunk, and shares upload/path processing', async () => {
    const { calls } = await mockService()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mineru-integration-'))
    vi.stubEnv('DSH_HOME', dir)
    const tables = new Map<string, Map<string, unknown>>()
    let global: unknown = { overrides: {}, enabled: true, enabledBaseIds: [], groups: [] }
    const domain = { global: { get: () => global, set: async (value: unknown) => { global = value } }, close: async () => {},
      table: (name: string) => {
        const map = tables.get(name) ?? new Map<string, unknown>(); tables.set(name, map)
        return { get: (id: string) => map.get(id), entries: () => map.entries(),
          put: async (id: string, value: unknown) => { map.set(id, value) }, delete: async (id: string) => map.delete(id) }
      } }
    const ctx = new Context()
    ctx.provide('webServer', { routes: [], register: () => () => {} })
    ctx.provide('storageDomain', { open: async () => domain })
    await ctx.plugin(KnowledgeService, { ...Config({} as Config), embeddingProvider: 'none',
      documentProcessorProvider: 'mineru-local', mineruLocalUrl: 'http://mineru.test', mineruTier: 'basic',
      chunkStorePath: join(dir, 'chunks.sqlite'), localModelCacheDir: join(dir, 'models') })
    const service = ctx.get('knowledge') as KnowledgeService
    const store = (service as unknown as { store: Store }).store
    try {
      const base = await service.createBase({ name: 'structured fixture' })
      const doc = await service.addFileDocument({ baseId: base.id, fileName: 'test.pdf', contentBase64: Buffer.from(source).toString('base64') })
      await service.waitForIdle()
      const before = service.getDocument(doc.id)
      expect(before.processing?.provider).toBe('mineru-local')
      const result = await service.search({ baseId: base.id, query: 'Mass 42 kg', mode: 'lexical' })
      expect(result.hits.some(hit => hit.text.includes('42 kg'))).toBe(true)
      for (const hit of result.hits) {
        expect(hit.processingRevision).toBe(before.processing?.revision)
        expect(hit.contextWindow?.anchor.sourceSpans?.[0].pageIndex).toBe(0)
      }
      const posts = () => calls.filter(call => call.method === 'POST' && call.url.endsWith('/v1/parse/jobs')).length
      expect(posts()).toBe(1)
      await service.reindexDocument(doc.id, { mode: 'rechunk' })
      expect(posts()).toBe(1)
      expect(service.getDocument(doc.id).processing?.revision).toBe(before.processing?.revision)
      const evidence = await service.readDocumentEvidence(doc.id, { pageIndex: 0 })
      expect(evidence.blocks.some(block => block.type === 'table' && block.text.includes('42 kg'))).toBe(true)
      expect(evidence.assets).toHaveLength(1)
      await expect(service.getEvidenceAsset(doc.id, evidence.assets[0]!.id, 'stale')).rejects.toThrow('revision')
      await service.reindexDocument(doc.id, { mode: 'reparse' })
      expect(posts()).toBe(2)
      expect(service.getDocument(doc.id).processing?.revision).not.toBe(before.processing?.revision)
      await expect(service.readDocumentEvidence(doc.id, { revision: before.processing!.revision })).rejects.toThrow('revision')
      const anotherBase = await service.createBase({ name: 'path fixture' })
      const path = join(dir, 'test.pdf'); await writeFile(path, source)
      await service.importFileFromPath(anotherBase.id, path)
      expect(posts()).toBe(3)
      expect(service.listDocuments(anotherBase.id)[0]!.processing?.provider).toBe('mineru-local')
      const pathDoc = service.listDocuments(anotherBase.id)[0]!
      expect(service.getDocument(pathDoc.id).rawText).toBe(before.rawText)
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('negotiates capabilities, uploads once and keeps credentials on the configured origin', async () => {
    const { calls } = await mockService()
    const output = await extractWithMineruLocal(source, 'document.pdf', { apiUrl: 'http://mineru.test', apiKey: 'local-secret', tier: 'basic' })
    expect(output.document.completeness).toBe('complete')
    expect(output.document.text).toContain('42 kg')
    expect(output.document.text).toContain('E = mc^2 - 7')
    expect(calls.filter(call => call.url.endsWith('/v1/parse/jobs'))).toHaveLength(1)
    expect(calls.find(call => call.url === 'http://storage.test/object')?.headers.has('authorization')).toBe(false)
    expect(calls.filter(call => call.url.startsWith('http://mineru.test')).every(call => call.headers.get('authorization') === 'Bearer local-secret')).toBe(true)
    for (const block of output.document.blocks) expect(output.document.text.slice(block.textStart, block.textEnd)).toBe(block.text)
    // Exercise storage too: normalized asset identities must be valid filesystem components.
    const artifacts = new ArtifactRepository()
    const info = await artifacts.save('base', 'document', output)
    expect((await artifacts.readAsset('base', 'document', info, output.document.assets[0]!.id))?.mimeType).toBe('image/png')
  })

  it('resumes a known job without another upload/submission', async () => {
    const { calls } = await mockService()
    await extractWithMineruLocal(source, 'doc.pdf', { apiUrl: 'http://mineru.test', tier: 'basic' }, { resumeJobId: 'job-1' })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('rejects unsupported versions before sending a document', async () => {
    const { calls } = await mockService({ version: '3.9.0' })
    await expect(probeMineruLocal({ apiUrl: 'http://mineru.test' })).rejects.toMatchObject({ code: 'unsupported_version' })
    expect(calls).toHaveLength(1)
  })

  it('checks resumed job identity and never resubmits a mismatched response', async () => {
    const { calls } = await mockService({ invalidId: true })
    await expect(extractWithMineruLocal(source, 'doc.pdf', { apiUrl: 'http://mineru.test', tier: 'basic' }, { resumeJobId: 'job-1' }))
      .rejects.toMatchObject({ code: 'invalid_response' })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('cancels polling promptly and issues bounded best-effort job deletion', async () => {
    const { calls } = await mockService({ running: true })
    const controller = new AbortController()
    await expect(extractWithMineruLocal(source, 'doc.pdf', { apiUrl: 'http://mineru.test', tier: 'basic' }, {
      signal: controller.signal, onProgress: progress => { if (progress.stage === 'parsing') controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/job-1'))).toBe(true)
  })

  it('includes response-body reads in the deadline', async () => {
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')) } })))
    const budget = processingBudget(30)
    try { await expect(new ProcessorTransport('http://mineru.test', '', budget.signal).json('/v1/health')).rejects.toMatchObject({ code: 'timeout' }) }
    finally { budget.dispose() }
  })

  it('does not retry an ambiguously submitted job', async () => {
    const fetcher = vi.fn(async () => { throw new Error('connection reset') })
    vi.stubGlobal('fetch', fetcher)
    const budget = processingBudget(1000)
    try { await expect(new ProcessorTransport('http://mineru.test', '', budget.signal).json('/v1/parse/jobs', { method: 'POST', ambiguousSubmission: true })).rejects.toMatchObject({ code: 'submission_unknown' }) }
    finally { budget.dispose() }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects path traversal, duplicate manifests and unsupported schemas', async () => {
    await expect(normalizeMineruArchive(await archive(zip => { zip.file('../outside.txt', 'bad') }), source, { tier: 'basic' })).rejects.toMatchObject({ code: 'unsafe_archive' })
    await expect(normalizeMineruArchive(await archive(zip => { zip.file('other/middle_json.json', '{}') }), source, { tier: 'basic' })).rejects.toMatchObject({ code: 'unsupported_schema' })
    await expect(normalizeMineruArchive(await archive(zip => { zip.file('middle_json.json', '{}') }), source, { tier: 'basic' })).rejects.toMatchObject({ code: 'unsupported_schema' })
  })
})
