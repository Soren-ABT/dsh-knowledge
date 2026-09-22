/**
 * MinerU recovery regressions (issue #30). A document whose remote extraction
 * failed at import keeps its uploaded bytes but no text; reindexing it must go
 * through the configured processor chain again instead of being stuck on a
 * local parser that cannot read a scanned PDF, and a double failure must report
 * both the remote and the local reason (the remote one used to be log-only).
 *
 * A fake MinerU endpoint stands in for the paid API: the suite stays offline,
 * deterministic, and downloads no model weights.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
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
  embeddingProvider: 'none', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKey: '',
  rerankModel: '', rerankBaseUrl: '', rerankApiKey: '', localRerankTimeoutMs: 60000,
  smartChunk: true, chunkSeparator: '\n\n', chunkSize: 800, chunkOverlap: 100,
  topK: 6, searchMode: 'auto', similarityThreshold: 0, mmrDiversity: 0,
  rrfVectorWeight: 1, embeddingBatchSize: 32, siblingChunks: 1,
  localModelCacheDir: '', hfEndpoint: '', chunkStorePath: '',
  documentProcessorProvider: 'mineru', mineruApiKey: 'test-key', mineruApiHost: '',
  semanticChunk: false, semanticChunkThreshold: 0.75, chunkTokenLimit: 0,
  conflictStrategy: 'rename', urlRefreshHours: 0,
  imageCaptionProvider: 'off', imageCaptionModel: '', imageCaptionBaseUrl: '', imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true, autoRetrieve: true, autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60000,
}

interface FakeMineru {
  readonly server: Server
  readonly url: string
  /** Every API call, including ones answered with a failure. */
  readonly state: { failing: boolean; failNext: number; calls: number }
}

/** Minimal MinerU v4 API stand-in: batch create → upload → poll → result zip. */
async function startFakeMineru(): Promise<FakeMineru> {
  const state = { failing: false, failNext: 0, calls: 0 }
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      state.calls += 1
      if (state.failing || state.failNext > 0) {
        if (!state.failing) state.failNext -= 1
        res.writeHead(500).end('fake mineru outage')
        return
      }
      const port = (server.address() as { port: number }).port
      const url = req.url ?? '/'
      if (req.method === 'POST' && url.startsWith('/api/v4/file-urls/batch')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { batch_id: 'batch-1', file_urls: [`http://127.0.0.1:${port}/upload`] } }))
        return
      }
      if (req.method === 'PUT' && url.startsWith('/upload')) {
        res.writeHead(200).end()
        return
      }
      if (req.method === 'GET' && url.startsWith('/api/v4/extract-results/batch/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: `http://127.0.0.1:${port}/result.zip` }] } }))
        return
      }
      if (req.method === 'GET' && url.startsWith('/result.zip')) {
        const zip = new JSZip()
        zip.file('scan/auto/scan.md', '# MinerU markdown\n\n这是 MinerU 解析出的正文内容。')
        void zip.generateAsync({ type: 'nodebuffer' }).then(buffer => {
          res.writeHead(200, { 'content-type': 'application/zip' })
          res.end(buffer)
        })
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}`, state }
}

const homes: Array<{ dispose(): Promise<void>; dir: string }> = []
const servers: Server[] = []

afterEach(async () => {
  for (const { dispose, dir } of homes.splice(0)) {
    await dispose().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
})

async function mount(mineruUrl: string): Promise<KnowledgeService> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-mineru-'))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  const fiber = await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, mineruApiHost: mineruUrl, chunkStorePath: join(dir, 'chunks.sqlite') })
  homes.push({ dispose: () => fiber.dispose(), dir })
  return ctx.get('knowledge') as KnowledgeService
}

function storeOf(service: KnowledgeService): Store {
  return (service as unknown as { store: Store }).store
}

/** Bytes no local parser can read: only the fake MinerU can extract text from them. */
const NOT_A_PDF = Buffer.from('scanned-looking bytes without a text layer').toString('base64')

describe('MinerU recovery (issue #30)', () => {
  it('recovers a failed MinerU import on reindex and reports both failure reasons', { timeout: 45_000 }, async () => {
    const mineru = await startFakeMineru()
    servers.push(mineru.server)
    const service = await mount(mineru.url)
    const base = await service.createBase({ name: 'recovery' })

    mineru.state.failing = true
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      contentBase64: NOT_A_PDF,
    })
    await service.waitForIdle()

    const failed = service.listDocuments(base.id).find(entry => entry.id === doc.id)
    expect(failed?.status).toBe('failed')
    // Both reasons reach the row: the remote outage AND the local parser failure.
    expect(failed?.embeddingError).toMatch(/MinerU extraction failed/)
    expect(failed?.embeddingError).toMatch(/local parsing failed/)

    // An explicit retry while both processors still fail must report the
    // underlying reasons instead of a generic missing-source message.
    await expect(service.reindexDocument(doc.id)).rejects.toThrow(/MinerU extraction failed .*local parsing failed/)
    // A completed failed import is not a crash-resume candidate at startup.
    const recovery = await storeOf(service).recoverInterruptedImports(Date.now() + 1)
    expect(recovery.resume).not.toContain(doc.id)
    expect(storeOf(service).getDocument(doc.id)?.errorCode).toBe('parse_failed')

    // The processor works again: reindexing rebuilds the document through it.
    mineru.state.failing = false
    const reindexed = await service.reindexDocument(doc.id)
    expect(reindexed.chunkCount).toBeGreaterThan(0)
    expect(service.getDocument(doc.id, { includeChunks: false }).rawText).toContain('MinerU markdown')
    const settled = service.listDocuments(base.id).find(entry => entry.id === doc.id)
    expect(settled?.embeddingError).toBeUndefined()
  })

  it('rebuilds a MinerU-imported PDF through MinerU again on reindex', { timeout: 45_000 }, async () => {
    const mineru = await startFakeMineru()
    servers.push(mineru.server)
    const service = await mount(mineru.url)
    const base = await service.createBase({ name: 'parity' })
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      contentBase64: NOT_A_PDF,
    })
    await service.waitForIdle()
    const callsAfterImport = mineru.state.calls
    expect(callsAfterImport).toBeGreaterThan(0)

    await service.reindexDocument(doc.id)
    // The configured processor is authoritative for a rebuild, not the local
    // parser: a reindex must not silently downgrade a MinerU document.
    expect(mineru.state.calls).toBeGreaterThan(callsAfterImport)
    expect(service.getDocument(doc.id, { includeChunks: false }).rawText).toContain('MinerU markdown')
  })

  it('keeps non-PDF documents on the local parsers even with MinerU configured', async () => {
    const mineru = await startFakeMineru()
    servers.push(mineru.server)
    const service = await mount(mineru.url)
    const base = await service.createBase({ name: 'local-only' })
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'notes.md',
      contentBase64: Buffer.from('# local text survives').toString('base64'),
    })
    await service.waitForIdle()

    expect(mineru.state.calls).toBe(0)
    expect(service.getDocument(doc.id, { includeChunks: false }).rawText).toContain('local text survives')
  })

  it('does not send identical live and cached bytes to MinerU twice in one reindex', async () => {
    const mineru = await startFakeMineru()
    servers.push(mineru.server)
    const service = await mount(mineru.url)
    const base = await service.createBase({ name: 'same source' })
    mineru.state.failing = true
    const doc = await service.addFileDocument({
      baseId: base.id, fileName: 'scan.pdf', mimeType: 'application/pdf', contentBase64: NOT_A_PDF,
    })
    await service.waitForIdle()
    const sourcePath = join(homes.at(-1)!.dir, 'scan.pdf')
    await writeFile(sourcePath, Buffer.from(NOT_A_PDF, 'base64'))
    await storeOf(service).putDocument({ ...storeOf(service).getDocument(doc.id)!, sourcePath })

    const before = mineru.state.calls
    await expect(service.reindexDocument(doc.id)).rejects.toThrow(/MinerU extraction failed .*local parsing failed/)
    expect(mineru.state.calls - before).toBe(1)
  })

  it('tries a distinct cached raw source after the live path fails', { timeout: 45_000 }, async () => {
    const mineru = await startFakeMineru()
    servers.push(mineru.server)
    const service = await mount(mineru.url)
    const base = await service.createBase({ name: 'different source' })
    const doc = await service.addFileDocument({
      baseId: base.id, fileName: 'scan.pdf', mimeType: 'application/pdf', contentBase64: NOT_A_PDF,
    })
    await service.waitForIdle()
    const sourcePath = join(homes.at(-1)!.dir, 'replacement.pdf')
    await writeFile(sourcePath, Buffer.from('different invalid PDF bytes'))
    await storeOf(service).putDocument({ ...storeOf(service).getDocument(doc.id)!, sourcePath })

    mineru.state.failNext = 1
    const before = mineru.state.calls
    const rebuilt = await service.reindexDocument(doc.id)
    expect(rebuilt.rawText).toContain('MinerU markdown')
    // The failed live request and successful cached request both ran.
    expect(mineru.state.calls - before).toBeGreaterThan(1)
  })

  it('retains persisted text when a later MinerU reindex cannot parse the raw PDF', { timeout: 45_000 }, async () => {
    const mineru = await startFakeMineru()
    servers.push(mineru.server)
    const service = await mount(mineru.url)
    const base = await service.createBase({ name: 'text fallback' })
    const doc = await service.addFileDocument({
      baseId: base.id, fileName: 'scan.pdf', mimeType: 'application/pdf', contentBase64: NOT_A_PDF,
    })
    await service.waitForIdle()
    const original = service.getDocument(doc.id, { includeChunks: false }).rawText

    mineru.state.failing = true
    const rebuilt = await service.reindexDocument(doc.id)
    expect(rebuilt.rawText).toBe(original)
    expect(rebuilt.chunkCount).toBeGreaterThan(0)
  })
})
