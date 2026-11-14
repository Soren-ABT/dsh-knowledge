/**
 * Issue #73: the startup artifact scan used to run on the service-init path and
 * await two filesystem calls per document, so a 7k-document library could
 * exceed the host's 60s startup budget. The scan is best-effort GC and must not
 * gate readiness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactRepository } from '../src/knowledge/artifacts.js'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'

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
  documentProcessorProvider: 'builtin', mineruApiKey: '', mineruApiHost: '',
  semanticChunk: false, semanticChunkThreshold: 0.75, chunkTokenLimit: 0,
  conflictStrategy: 'rename', urlRefreshHours: 0,
  imageCaptionProvider: 'off', imageCaptionModel: '', imageCaptionBaseUrl: '', imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true, autoRetrieve: true, autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60000,
}

const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function mountShared(domain: Domain<typeof knowledgeDomainSpec>, dir: string): Promise<{ service: KnowledgeService; dispose(): Promise<void> }> {
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => domain })
  const fiber = await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  return { service: ctx.get('knowledge') as KnowledgeService, dispose: () => fiber.dispose() }
}

describe('startup artifact cleanup (issue #73)', () => {
  it('finishes service init before the detached artifact scan completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-startup-gc-'))
    dirs.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    const domain = fakeDomain()

    const first = await mountShared(domain, dir)
    try {
      const base = await first.service.createBase({ name: 'gc' })
      await first.service.addTextDocument({ baseId: base.id, title: 'doc', content: '启动扫描期间不应阻塞就绪的文档内容。' })
      await first.service.waitForIdle()
    } finally {
      await first.dispose()
    }

    // The scan would hang forever at the first document. Service init must not
    // wait for it: the timeout below catches the old serial-await behavior.
    let release!: (value: number) => void
    const pending = new Promise<number>(resolve => { release = resolve })
    const collect = vi.spyOn(ArtifactRepository.prototype, 'collectDocument').mockImplementation(() => pending)

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('knowledge init waited for artifact cleanup')), 5000)
    })
    const started = Date.now()
    let second: { service: KnowledgeService; dispose(): Promise<void> } | undefined
    try {
      second = await Promise.race([mountShared(domain, dir), timeout])
      expect(Date.now() - started).toBeLessThan(3000)
      await vi.waitFor(() => expect(collect).toHaveBeenCalled(), { timeout: 2000 })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      release(0)
      await second?.dispose()
    }
  }, 20_000)
})
