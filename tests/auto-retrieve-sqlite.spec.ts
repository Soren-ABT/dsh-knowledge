import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeDomainSpec } from '../src/knowledge/domain.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'
import {
  buildAutoRetrieveMessage,
  type AutoRetrieveBackground,
} from '../src/tool-knowledge/index.js'

const rerankMock = vi.hoisted(() => vi.fn(async (
  _baseUrl: string,
  _model: string,
  _apiKey: string,
  _query: string,
  candidates: ReadonlyArray<{ id: string; text: string }>,
  _options: unknown,
) => new Map(candidates.map((candidate, index) => [candidate.id, 0.95 - index * 0.01]))))

vi.mock('../src/knowledge/rerank.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/knowledge/rerank.js')>()
  return { ...actual, rerankCandidates: rerankMock }
})

const TEST_CONFIG: Config = {
  embeddingProvider: 'none',
  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingApiKey: '',
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  localRerankTimeoutMs: 60_000,
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
  siblingChunks: 1,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
  documentProcessorProvider: 'builtin',
  mineruApiKey: '',
  mineruApiHost: '',
  semanticChunk: false,
  semanticChunkThreshold: 0.75,
  chunkTokenLimit: 0,
  conflictStrategy: 'rename',
  urlRefreshHours: 0,
  imageCaptionProvider: 'off',
  imageCaptionModel: '',
  imageCaptionBaseUrl: '',
  imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true,
  autoRetrieve: true,
  autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60_000,
}

class FakeTable<K extends string, V> implements KvTable<K, V> {
  readonly map = new Map<K, V>()

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  get size(): number {
    return this.map.size
  }

  async put(key: K, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.map.delete(key)
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

function fakeDomain(): Domain<typeof knowledgeDomainSpec> {
  const tables = {
    bases: new FakeTable<string, unknown>(),
    documents: new FakeTable<string, unknown>(),
  }
  let globalValue: unknown = { overrides: {}, groups: [], enabled: true, enabledBaseIds: [] }
  return {
    name: 'knowledge',
    global: {
      get: () => globalValue,
      set: async (value: unknown) => { globalValue = value },
    },
    table: (name: string) => tables[name as keyof typeof tables] as unknown,
    close: async () => {},
  } as unknown as Domain<typeof knowledgeDomainSpec>
}

interface MountedService {
  service: KnowledgeService
  close(): Promise<void>
}

async function mountService(): Promise<MountedService> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-sqlite-'))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => fakeDomain() })
  await ctx.plugin(KnowledgeService, { ...TEST_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  const service = ctx.get('knowledge') as KnowledgeService
  return {
    service,
    async close() {
      await (service as unknown as { store: { close(): Promise<void> } }).store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

let agentSequence = 0
function agent(): { id: string } {
  agentSequence += 1
  return { id: `sqlite-auto-agent-${agentSequence}` }
}

function textOf(background: AutoRetrieveBackground | undefined): string {
  return background?.message.content[0]?.text ?? ''
}

afterEach(() => {
  rerankMock.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('auto retrieval through the real SQLite lane', () => {
  it.each([
    ['年假', '年假申请需要提前三天在员工系统提交。', '年假'],
    ['体检', '年度体检可在健康中心页面预约时段。', '体检'],
    ['发票', '电子发票需要上传原件并填写费用归属。', '发票'],
    ['审批', '普通审批会在两个工作日内完成。', '审批'],
  ])('lets the short Chinese query %s clear the real auto gate', async (query, content, expected) => {
    const mounted = await mountService()
    try {
      const base = await mounted.service.createBase({ name: `短中文-${expected}` })
      await mounted.service.addTextDocument({ baseId: base.id, title: expected, content })

      const background = await buildAutoRetrieveMessage(mounted.service, agent() as never, query)

      expect(background).toBeDefined()
      expect(textOf(background)).toContain(expected)
      expect(textOf(background)).toContain('[source:')
    } finally {
      await mounted.close()
    }
  })

  it('runs remote rerank exactly once in auto search, skips service rerank, and keeps explicit rerank enabled', async () => {
    const mounted = await mountService()
    try {
      const base = await mounted.service.createBase({ name: 'remote-rerank' })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '报销步骤一',
        content: '报销发票流程第一步是上传电子发票。',
      })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '报销步骤二',
        content: '报销发票流程第二步是等待财务复核。',
      })
      await mounted.service.setConfig({
        rerankModel: 'remote-test-reranker',
        rerankBaseUrl: 'https://rerank.invalid',
        rerankApiKey: 'test-key',
      })
      const searchSpy = vi.spyOn(mounted.service, 'search')

      const background = await buildAutoRetrieveMessage(
        mounted.service,
        agent() as never,
        '报销发票流程是什么？',
      )

      expect(background).toBeDefined()
      expect(searchSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy.mock.calls[0]?.[1]).toMatchObject({
        rerank: 'skip',
        signal: expect.any(AbortSignal),
        deadlineAt: expect.any(Number),
      })
      expect(rerankMock).toHaveBeenCalledTimes(1)
      expect(rerankMock.mock.calls[0]?.[1]).toBe('remote-test-reranker')
      expect(rerankMock.mock.calls[0]?.[5]).toMatchObject({ retries: 0, timeoutMs: expect.any(Number) })

      const explicit = await mounted.service.search({
        query: '报销发票流程',
        baseId: base.id,
        mode: 'lexical',
      })

      expect(explicit.reranked).toBe(true)
      expect(rerankMock).toHaveBeenCalledTimes(2)
      expect(rerankMock.mock.calls[1]?.[5]).toMatchObject({ retries: 1, timeoutMs: 60_000 })
    } finally {
      await mounted.close()
    }
  })

  it('never runs a local reranker in auto search but still runs it for explicit search', async () => {
    const mounted = await mountService()
    try {
      const base = await mounted.service.createBase({ name: 'local-rerank' })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '审批甲',
        content: '发票审批流程需要先核对金额。',
      })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '审批乙',
        content: '发票审批流程还需要检查费用归属。',
      })
      await mounted.service.setConfig({ rerankModel: 'local:Xenova/bge-reranker-base' })

      const background = await buildAutoRetrieveMessage(
        mounted.service,
        agent() as never,
        '审批',
      )

      expect(background).toBeDefined()
      expect(rerankMock).not.toHaveBeenCalled()

      const explicit = await mounted.service.search({
        query: '发票审批流程',
        baseId: base.id,
        mode: 'lexical',
      })

      expect(explicit.reranked).toBe(true)
      expect(rerankMock).toHaveBeenCalledTimes(1)
      expect(rerankMock.mock.calls[0]?.[1]).toBe('local:Xenova/bge-reranker-base')
    } finally {
      await mounted.close()
    }
  })

  it('commits a first hit, adds one deictic fresh delta, then suppresses delivered evidence', async () => {
    const mounted = await mountService()
    try {
      const base = await mounted.service.createBase({ name: '财务制度' })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '报销入口',
        content: '报销入口位于财务系统首页，提交后会生成受理编号。',
      })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '发票审批',
        content: '审批阶段需要核对发票原件，额度超过五千元需主管签字。',
      })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '合同审批',
        content: '审批阶段还要复核合同附件并确认成本中心。',
      })
      const sameAgent = agent()

      const first = await buildAutoRetrieveMessage(
        mounted.service,
        sameAgent as never,
        '报销入口在哪里？',
      )
      expect(first).toBeDefined()
      expect(textOf(first)).toContain('财务系统首页')
      first!.commit()

      const followUp = await buildAutoRetrieveMessage(
        mounted.service,
        sameAgent as never,
        'then 审批',
        undefined,
        ['报销入口在哪里？'],
      )
      expect(followUp).toBeDefined()
      expect(textOf(followUp)).toContain('审批阶段')
      expect(textOf(followUp)).not.toContain('财务系统首页')
      expect(textOf(followUp).match(/\[source:/g)).toHaveLength(1)
      const firstDelta = textOf(followUp)
      followUp!.commit()

      // The exact evidence already delivered cannot repeat. Because another
      // unseen approval chunk exists, the same-topic turn may contribute one
      // more fresh delta; after that the real SQLite candidate set is spent.
      const nextDelta = await buildAutoRetrieveMessage(
        mounted.service,
        sameAgent as never,
        'then 审批',
        undefined,
        ['报销入口在哪里？'],
      )
      expect(nextDelta).toBeDefined()
      expect(textOf(nextDelta)).not.toBe(firstDelta)
      expect(textOf(nextDelta).match(/\[source:/g)).toHaveLength(1)
      nextDelta!.commit()

      const exhausted = await buildAutoRetrieveMessage(
        mounted.service,
        sameAgent as never,
        'then 审批',
        undefined,
        ['报销入口在哪里？'],
      )
      expect(exhausted).toBeUndefined()
    } finally {
      await mounted.close()
    }
  })

  it('does not commit auto state when an owner aborts, so the same agent can retry', async () => {
    const mounted = await mountService()
    try {
      const base = await mounted.service.createBase({ name: '中止恢复' })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '年假申请',
        content: '年假申请需要提前三天在员工系统提交。',
      })
      const sameAgent = agent()
      const controller = new AbortController()
      const searchSpy = vi.spyOn(mounted.service, 'search')
      searchSpy.mockImplementationOnce(async (_request, execution) => await new Promise((resolve, reject) => {
        execution?.signal?.addEventListener('abort', () => reject(execution.signal?.reason), { once: true })
        void resolve
      }))

      const pending = buildAutoRetrieveMessage(
        mounted.service,
        sameAgent as never,
        '年假',
        controller.signal,
      )
      await Promise.resolve()
      controller.abort()
      expect(await pending).toBeUndefined()

      searchSpy.mockRestore()
      const retried = await buildAutoRetrieveMessage(
        mounted.service,
        sameAgent as never,
        '年假',
      )
      expect(retried).toBeDefined()
      expect(textOf(retried)).toContain('提前三天')
    } finally {
      await mounted.close()
    }
  })

  it('rejects filler, no-match text, short random digits, and an unmatched strict identifier', async () => {
    const mounted = await mountService()
    try {
      const base = await mounted.service.createBase({ name: '负例' })
      await mounted.service.addTextDocument({
        baseId: base.id,
        title: '普通制度',
        content: '普通制度只介绍办公用品领用流程。',
      })
      const sameAgent = agent()

      expect(await buildAutoRetrieveMessage(mounted.service, sameAgent as never, '好的好的好的')).toBeUndefined()
      expect(await buildAutoRetrieveMessage(mounted.service, sameAgent as never, '量子火箭燃料规范')).toBeUndefined()
      expect(await buildAutoRetrieveMessage(mounted.service, sameAgent as never, '12345')).toBeUndefined()
      expect(await buildAutoRetrieveMessage(mounted.service, sameAgent as never, '88888888')).toBeUndefined()
    } finally {
      await mounted.close()
    }
  })
})
