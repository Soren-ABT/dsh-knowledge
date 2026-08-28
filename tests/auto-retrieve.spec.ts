import { describe, expect, it } from 'vitest'
import { autoRetrieveBackground } from '../src/tool-knowledge/index.js'
import type { KnowledgeService } from '../src/knowledge/index.js'
import type { SearchResult } from '../src/knowledge/types.js'

function stubKnowledge(overrides: Partial<{
  enabled: boolean
  baseCount: number
  search: () => Promise<SearchResult>
}>): KnowledgeService {
  return {
    isEnabled: () => overrides.enabled ?? true,
    listBases: () => Array.from({ length: overrides.baseCount ?? 1 }, (_, i) => ({ id: `b${i}`, name: `base${i}` } as never)),
    search: overrides.search ?? (async () => ({ query: '', mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] })),
  } as unknown as KnowledgeService
}

function stubAgent(): { inject(message: unknown): void; injected: unknown[] } {
  const injected: unknown[] = []
  return { inject: (message) => { injected.push(message) }, injected }
}

const hit = (text: string, score: number, title = 'doc', heading?: string): SearchResult['hits'][number] =>
  ({ chunkId: 'c', docId: 'd', baseId: 'b0', documentTitle: title, text, score, index: 0, ...(heading !== undefined ? { heading } : {}) })

describe('autoRetrieveBackground', () => {
  it('injects a background message when the top hit clears the relevance gate', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({ query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0, hits: [hit('the reimbursement workflow is A then B', 0.7, '手册', '报销')] }),
    })
    await autoRetrieveBackground(knowledge, agent as never, '报销流程是什么？')
    expect(agent.injected).toHaveLength(1)
    const message = agent.injected[0] as { role: string; content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string } }
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('plugin')
    expect(message.content[0].type).toBe('text')
    expect(message.content[0].text).toContain('reimbursement workflow')
    expect(message.content[0].text).toContain('手册 / 报销')
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

  it('keeps only the top relevant chunks (drops below-gate hits in a mixed result)', async () => {
    const agent = stubAgent()
    const knowledge = stubKnowledge({
      search: async () => ({ query: 'q', mode: 'lexical', total: 3, reranked: false, elapsedMs: 0, hits: [hit('relevant one', 0.6, 'A'), hit('noise', 0.03, 'B'), hit('relevant two', 0.5, 'C')] }),
    })
    await autoRetrieveBackground(knowledge, agent as never, 'question text')
    const message = agent.injected[0] as { content: Array<{ text: string }> }
    expect(message.content[0].text).toContain('relevant one')
    expect(message.content[0].text).toContain('relevant two')
    expect(message.content[0].text).not.toContain('noise')
  })
})
