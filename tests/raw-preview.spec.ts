/**
 * Issue #85: directory imports used to publish documents without a MIME type,
 * so the raw-file route served every PDF as application/octet-stream and the
 * panel's iframe fell back to a download. MIME must be derived from the file
 * name at import time and again as a route-level fallback for old records.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import { knowledgeRoute } from '../src/knowledge/http.js'
import { mimeTypeForFileName } from '../src/knowledge/parse.js'
import type { Config } from '../src/knowledge/config.js'
import { FakeTable } from './helpers/memory-kv-table.js'

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
  documentProcessorProvider: 'builtin', mineruApiKey: '', mineruApiHost: '',
  semanticChunk: false, semanticChunkThreshold: 0.75, chunkTokenLimit: 0,
  conflictStrategy: 'rename', urlRefreshHours: 0,
  imageCaptionProvider: 'off', imageCaptionModel: '', imageCaptionBaseUrl: '', imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true, autoRetrieve: true, autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60000,
}

const dirs: string[] = []
const servers: Server[] = []
const fibers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const fiber of fibers.splice(0)) await fiber.dispose().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

async function mountService(): Promise<KnowledgeService> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-raw-'))
  dirs.push(dir)
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  const fiber = await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  fibers.push(fiber)
  return ctx.get('knowledge') as KnowledgeService
}

/** Minimal valid single-page PDF; parsers accept it, so the import completes. */
function makeTestPdf(text: string): Buffer {
  const objects: string[] = []
  const add = (body: string): number => { objects.push(body); return objects.length }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
  add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  objects.forEach(body => {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${offsets.length} 0 obj\n${body}\nendobj\n`))
  })
  const xrefPos = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for directory import')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('raw file MIME (issue #85)', () => {
  it('maps supported file extensions to their content types', () => {
    expect(mimeTypeForFileName('scan.PDF')).toBe('application/pdf')
    expect(mimeTypeForFileName('notes.md')).toBe('text/markdown')
    expect(mimeTypeForFileName('report.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(mimeTypeForFileName('archive.unknown')).toBeUndefined()
  })

  it('publishes a MIME type for directory-imported files', async () => {
    const scanDir = await mkdtemp(join(tmpdir(), 'kb-raw-scan-'))
    dirs.push(scanDir)
    await writeFile(join(scanDir, 'scan.pdf'), makeTestPdf('PDF preview fixture'))

    const service = await mountService()
    const base = await service.createBase({ name: 'pdf' })
    const { jobId } = await service.importDirectory({ baseId: base.id, path: scanDir })
    await waitFor(() => service.directoryImportStatus(jobId)?.done === true)

    const doc = service.listDocuments(base.id).find(item => item.fileName === 'scan.pdf')
    expect(doc).toBeDefined()
    // The public summary intentionally omits storage-only fields; inspect the
    // durable record for the MIME that the raw route will serve.
    const stored = (service as unknown as {
      store: { getDocument(id: string): { mimeType?: string } | undefined }
    }).store.getDocument(doc!.id)
    expect(stored?.mimeType).toBe('application/pdf')
    const raw = await service.getRawFile(doc!.id)
    expect(raw?.mimeType).toBe('application/pdf')
    expect(Buffer.from(raw!.bytes).subarray(0, 4).toString()).toBe('%PDF')
  })

  it('derives the response content type when an older record has no MIME', async () => {
    const service = {
      whenReady: async () => {},
      getRawFile: async () => ({ bytes: new Uint8Array([1, 2, 3]), fileName: 'scan.pdf' }),
    } as unknown as KnowledgeService
    const route = knowledgeRoute(service)
    if (route.kind !== 'prefix') throw new Error('expected a prefix route')
    const server = createServer((req, res) => { void route.handler(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing address')
    const response = await fetch(`http://127.0.0.1:${address.port}/knowledge/documents/doc/raw?inline=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain('inline')
  })
})
