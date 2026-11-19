/**
 * Metadata-write resilience (issue #55). Windows reports a contended atomic
 * `tmp + rename` unit write as `EPERM`; the host escalates an unhandled
 * rejection into a fatal load failure, so background work and failure markers
 * must degrade to warnings instead of taking the process down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { FakeTable } from './helpers/memory-kv-table.js'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'
import type { Store } from '../src/knowledge/store.js'

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

const homes: Array<{ dispose(): Promise<void>; dir: string }> = []
const scratchDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
  for (const { dispose, dir } of homes.splice(0)) {
    await dispose().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

interface Mounted {
  service: KnowledgeService
  ctx: Context
}

async function mount(): Promise<Mounted> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-resilience-'))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  const fiber = await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  homes.push({ dispose: () => fiber.dispose(), dir })
  return { service: ctx.get('knowledge') as KnowledgeService, ctx }
}

/** The way a contended Windows atomic rename reaches the caller. */
const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', errno: -4048, syscall: 'rename' })

const storeOf = (service: KnowledgeService): Store => (service as unknown as { store: Store }).store
const internalsOf = <T>(service: KnowledgeService): T => service as unknown as T
const warned = (warn: { mock: { calls: unknown[][] } }): string =>
  warn.mock.calls.map(call => String(call[0])).join('\n')

describe('metadata-write resilience (issue #55)', () => {
  it('does not reject when the recovery failure marker cannot be written', async () => {
    const { service, ctx } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const base = await service.createBase({ name: 'resilience' })
    const doc = await service.addTextDocument({ baseId: base.id, title: 'interrupted', content: '这是一段正文内容' })
    await service.waitForIdle()
    const store = storeOf(service)
    const current = store.getDocument(doc.id)!
    await store.putDocument({ ...current, incomplete: true, errorCode: 'interrupted', embeddingError: undefined })

    // The recovery attempt fails because the metadata unit is unavailable…
    vi.spyOn(internalsOf<{ reindexDocument(id: string, options?: unknown): Promise<unknown> }>(service), 'reindexDocument')
      .mockRejectedValue(eperm())
    // …and so does the marker write that records that failure.
    vi.spyOn(store, 'putDocument').mockRejectedValue(eperm())

    await expect(
      internalsOf<{ resumeInterruptedDocuments(ids: string[]): Promise<void> }>(service).resumeInterruptedDocuments([doc.id]),
    ).resolves.toBeUndefined()
    expect(warned(warn)).toContain('could not record failed recovery')
  })

  it('logs a rejected background directory import instead of escaping', async () => {
    const { service, ctx } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const base = await service.createBase({ name: 'jobs' })
    const scanDir = await mkdtemp(join(tmpdir(), 'kb-resilience-scan-'))
    scratchDirs.push(scanDir)

    vi.spyOn(internalsOf<{ runDirectoryImport(jobId: string, files: readonly string[]): Promise<void> }>(service), 'runDirectoryImport')
      .mockRejectedValue(eperm())

    await service.importDirectory({ baseId: base.id, path: scanDir })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warned(warn)).toContain('directory import job failed')
  })

  it('logs a rejected background reindex instead of escaping', async () => {
    const { service, ctx } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const base = await service.createBase({ name: 'reindex' })
    await service.addTextDocument({ baseId: base.id, title: 'doc', content: '这是一段正文内容' })
    await service.waitForIdle()

    vi.spyOn(internalsOf<{ runReindexJob(jobId: string, baseId: string): Promise<void> }>(service), 'runReindexJob')
      .mockRejectedValue(eperm())

    await service.startReindexBase(base.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warned(warn)).toContain('reindex job failed')
  })
})
