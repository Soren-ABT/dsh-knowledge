import { describe, expect, it } from 'vitest'
import { autoRetrieveBackground } from '../src/tool-knowledge/index.js'
import type { KnowledgeService } from '../src/knowledge/index.js'
import type { SearchResult } from '../src/knowledge/types.js'

function stubKnowledge(overrides: Partial<{
  enabled: boolean
  baseCount: number
  autoRetrieve: boolean
  search: (request?: { query: string; topK?: number; mode?: string; baseId?: string }) => Promise<SearchResult>
}>): KnowledgeService {
  return {
    isEnabled: () => overrides.enabled ?? true,
    listBases: () => Array.from({ length: overrides.baseCount ?? 1 }, (_, i) => ({ id: `b${i}`, name: `base${i}` } as never)),
    getConfig: () => ({ autoRetrieve: overrides.autoRetrieve ?? true }) as never,
    search: overrides.search ?? (async () => ({ query: '', mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] })),
  } as unknown as KnowledgeService
}

let agentSeq = 0
function stubAgent(): { id: string; inject(message: unknown): void; injected: unknown[] } {
  agentSeq += 1
  const injected: unknown[] = []
  return { id: `test-agent-${agentSeq}`, inject: (message) => { injected.push(message) }, injected }
}

const hit = (text: string, score: number, title = 'doc', heading?: string): SearchResult['hits'][number] =>
  ({ chunkId: 'c', docId: 'd', baseId: 'b0', documentTitle: title, text, score, index: 0, ...(heading !== undefined ? { heading } : {}) })

describe('autoRetrieveBackground', () => {
  it('injects a background message when the top hit clears the relevance gate', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({ query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0, hits: [hit('报销流程是提交发票后审批', 0.7, '手册', '报销')] }),
    })
    await autoRetrieveBackground(knowledge, agent as never, '报销流程是什么？')
    expect(agent.injected).toHaveLength(1)
    const message = agent.injected[0] as { role: string; content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string } }
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('plugin')
    expect(message.content[0].type).toBe('text')
    expect(message.content[0].text).toContain('报销流程是提交发票后审批')
    expect(message.content[0].text).toContain('base0 / 手册 / 报销')
  })

  it('injects nothing when every hit scores below the gate', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({ query: 'q', mode: 'lexical', total: 2, reranked: false, elapsedMs: 0, hits: [hit('unrelated filler', 0.05), hit('more noise', 0.04)] }),
    })
    await autoRetrieveBackground(knowledge, agent as never, 'hello there')
    expect(agent.injected).toHaveLength(0)
  })

  it('injects nothing when the deployment is disabled or has no bases', async () => {
    const agent = stubAgent()
    await autoRetrieveBackground(stubKnowledge({ enabled: false }) as never, agent as never, 'some question here')
    expect(agent.injected).toHaveLength(0)
    await autoRetrieveBackground(stubKnowledge({ baseCount: 0 }) as never, agent as never, 'some question here')
    expect(agent.injected).toHaveLength(0)
  })

  it('injects nothing when auto-retrieve is turned off', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      autoRetrieve: false,
      search: async () => ({ query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0, hits: [hit('highly relevant content', 0.9)] }),
    })
    await autoRetrieveBackground(knowledge as never, agent as never, 'some question here')
    expect(agent.injected).toHaveLength(0)
  })

  it('keeps only the top relevant chunks (drops below-gate hits in a mixed result)', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({ query: 'q', mode: 'lexical', total: 3, reranked: false, elapsedMs: 0, hits: [hit('relevant one content', 0.6, 'A'), hit('noise unrelated', 0.03, 'B'), hit('relevant two content', 0.5, 'C')] }),
    })
    await autoRetrieveBackground(knowledge, agent as never, 'relevant question')
    const message = agent.injected[0] as { content: Array<{ text: string }> }
    expect(message.content[0].text).toContain('relevant one')
    expect(message.content[0].text).toContain('relevant two')
    expect(message.content[0].text).not.toContain('noise')
  })

  it('drops a high-score hit that shares no keyword with the query', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({
        query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
        hits: [hit('entirely different topic content', 0.9, 'other')],
      }),
    })
    await autoRetrieveBackground(knowledge as never, agent as never, '公司的报销流程')
    expect(agent.injected).toHaveLength(0)
  })

  it('passes a hit sharing a CJK keyword with the query', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({
        query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
        hits: [hit('报销流程是提交发票后审批', 0.6, '手册')],
      }),
    })
    await autoRetrieveBackground(knowledge as never, agent as never, '请问公司的报销流程是什么')
    expect(agent.injected).toHaveLength(1)
  })

  it('injects for a stopword-heavy English query when the hit shares the content word', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({
        query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
        hits: [hit('the reimbursement workflow content', 0.6)],
      }),
    })
    await autoRetrieveBackground(knowledge as never, agent as never, 'please tell me about the reimbursement workflow')
    expect(agent.injected).toHaveLength(1)
  })

  it('skips a same-topic follow-up inside the throttle window', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({
        query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
        hits: [hit('报销流程是提交发票后审批', 0.6, '手册')],
      }),
    })
    // First message injects…
    await autoRetrieveBackground(knowledge as never, agent as never, '报销流程是什么？')
    expect(agent.injected).toHaveLength(1)
    // …a same-topic follow-up right after is throttled (no context accumulation).
    await autoRetrieveBackground(knowledge as never, agent as never, '那第一步怎么走？')
    expect(agent.injected).toHaveLength(1)
  })

  it('injects a NEW topic even inside the throttle window', async () => {
    const agent = stubAgent()
    let topic = '报销流程是提交发票后审批'
    const knowledge = stubKnowledge({
      search: async () => ({
        query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
        hits: [hit(topic, 0.6, 'doc')],
      }),
    })
    await autoRetrieveBackground(knowledge as never, agent as never, '报销流程是什么？')
    expect(agent.injected).toHaveLength(1)
    // Switch the stub's corpus to an unrelated topic; the new keywords must
    // not overlap the last injected ones, so the throttle lets it through.
    topic = '年假申请需要提前三天'
    await autoRetrieveBackground(knowledge as never, agent as never, '年假怎么申请？')
    expect(agent.injected).toHaveLength(2)
  })

  it('restricts the search to an explicitly named base', async () => {
    const agent = stubAgent()
    const searched: Array<Record<string, unknown>> = []
    const knowledge = stubKnowledge({
      search: async (request) => {
        searched.push(request as unknown as Record<string, unknown>)
        return { query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0, hits: [hit('报销流程内容', 0.6, 'doc')] }
      },
    })
    await autoRetrieveBackground(knowledge as never, agent as never, '看看 base0 里的报销流程')
    expect(searched.length).toBe(1)
    expect(searched[0].baseId).toBe('b0')
    expect(agent.injected).toHaveLength(1)
  })
})
