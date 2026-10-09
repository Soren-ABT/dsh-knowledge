import { describe, expect, it } from 'vitest'
import {
  buildAutoRetrieveMessage,
  clipAroundQuery,
  renderKnowledgeDocumentPage,
  renderKnowledgeEvidence,
  renderKnowledgeReadResult,
  renderKnowledgeSearchResult,
} from '../src/tool-knowledge/index.js'
import { estimateContextTokens } from '../src/knowledge/index.js'
import type { KnowledgeService } from '../src/knowledge/index.js'
import type { SearchResult } from '../src/knowledge/types.js'
import { ensureWellFormed, snapSliceEnd, snapSliceStart } from '../src/knowledge/text-safety.js'
import { sourceSpanLabel } from '../src/knowledge/source-spans.js'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const isWellFormed = (value: string): boolean => !LONE_SURROGATE.test(value)
const NOTE = '\u{1F4DD}'

function stubKnowledge(search: () => Promise<SearchResult>): KnowledgeService {
  const bases = [{ id: 'b0', name: 'base0' }]
  return {
    isEnabled: () => true,
    listBases: () => bases,
    enabledBases: () => bases,
    getConfig: () => ({ autoRetrieve: true }),
    getConfigFor: () => ({ autoRetrieve: true, autoRetrieveWeight: 3, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '' }),
    enabledScope: () => undefined,
    rerankSettings: () => undefined,
    warn: () => {},
    search,
  } as unknown as KnowledgeService
}

function stubHit(text: string, index = 0): SearchResult['hits'][number] {
  return {
    chunkId: `c-${index}`,
    docId: 'd',
    baseId: 'b0',
    documentTitle: '文档',
    text,
    score: 0.7,
    index: 0,
  }
}

describe('UTF-16 boundary safety (issue #51)', () => {
  it('snaps slice boundaries into the pair and repairs lone surrogates', () => {
    const text = `a${NOTE}b`
    expect(snapSliceStart(text, 1)).toBe(1)
    expect(snapSliceStart(text, 2)).toBe(3)
    expect(snapSliceEnd(text, 3)).toBe(3)
    expect(snapSliceEnd(text, 2)).toBe(1)
    expect(snapSliceStart(text, 0)).toBe(0)
    expect(snapSliceEnd(text, text.length)).toBe(text.length)
    expect(ensureWellFormed(`a\uD83Db`)).toBe('a\uFFFDb')
    expect(ensureWellFormed(`a\uDCDDb`)).toBe('a\uFFFDb')
    expect(ensureWellFormed(text)).toBe(text)
  })

  it('clipAroundQuery never emits a lone surrogate at any budget', () => {
    const samples = [
      `- ${NOTE} 一、光学显微镜\n   - 光学显微镜包括：目镜、物镜、载物台。`,
      `${'甲'.repeat(120)}${NOTE}${'乙'.repeat(120)}`,
      `${'x'.repeat(200)}\u{1F600}${'y'.repeat(200)}`,
    ]
    for (const text of samples) {
      for (const query of ['', 'zzzz', '光学显微镜', '甲甲甲']) {
        for (let budget = 1; budget <= 200; budget += 1) {
          const output = clipAroundQuery(text, query, budget)
          expect(isWellFormed(output), `budget=${budget} query=${query} out=${JSON.stringify(output.slice(0, 24))}`).toBe(true)
          expect(estimateContextTokens(output)).toBeLessThanOrEqual(budget)
        }
      }
    }
  })

  it('auto-retrieve never injects a lone surrogate across cropped layouts', async () => {
    const violations: string[] = []
    let injected = 0
    let cases = 0
    for (const pre of [0, 40]) {
      for (let i = 60; i <= 140; i += 1) {
        for (const tail of [0, 200]) {
          for (let titlePad = 0; titlePad <= 6; titlePad += 1) {
            cases += 1
            const text = `${'案'.repeat(pre)}${NOTE}${'案'.repeat(i)}甲甲内容${'案'.repeat(tail)}`
            const knowledge = stubKnowledge(async () => ({
              query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
              hits: [{ ...stubHit(text, cases), documentTitle: `文档${'附'.repeat(titlePad)}` }],
            }))
            const background = await buildAutoRetrieveMessage(
              knowledge,
              { id: `surrogate-${cases}` } as never,
              '甲甲内容',
            )
            const rendered = background?.message.content[0]?.text ?? ''
            if (rendered.length === 0) continue
            injected += 1
            if (!isWellFormed(rendered)) violations.push(`pre=${pre} i=${i} tail=${tail} titlePad=${titlePad}`)
          }
        }
      }
    }
    expect(injected).toBeGreaterThan(500)
    expect(violations).toEqual([])
  })

  it('auto-retrieve repairs a hit that is already poisoned', async () => {
    const knowledge = stubKnowledge(async () => ({
      query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
      hits: [stubHit('报销流程\uD83D提交审批')],
    }))
    const background = await buildAutoRetrieveMessage(knowledge, { id: 'poisoned-input' } as never, '报销流程是什么')
    const rendered = background?.message.content[0]?.text ?? ''
    expect(rendered).toContain('报销流程')
    expect(isWellFormed(rendered)).toBe(true)
    expect(rendered).toContain('\uFFFD')
  })

  it('repairs lone surrogates at the model-visible render exits', () => {
    const poisoned = '前置\uD83D后置'
    const search = renderKnowledgeSearchResult({
      query: 'q', mode: 'lexical', total: 1, reranked: false, elapsedMs: 0,
      hits: [stubHit(poisoned)],
    })
    expect(isWellFormed(search)).toBe(true)
    expect(search).toContain('\uFFFD')
    const page = renderKnowledgeDocumentPage({
      title: 'manual',
      chunkCount: 1,
      chunks: [{ index: 0, text: poisoned }],
      truncated: false,
    })
    expect(isWellFormed(page)).toBe(true)
    expect(page).toContain('\uFFFD')
    const read = renderKnowledgeReadResult({
      title: 'manual',
      totalChars: 12,
      charStart: 0,
      charEnd: 12,
      content: poisoned,
      truncated: false,
    })
    expect(isWellFormed(read)).toBe(true)
    expect(read).toContain('\uFFFD')
  })

  it('repairs metadata on empty search and grep results', () => {
    const poisoned = `missing\uD83D${NOTE}\uDCDD`
    const search = renderKnowledgeSearchResult({
      query: poisoned, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [],
    })
    const read = renderKnowledgeReadResult({ title: poisoned, matches: [], totalMatches: 0 })
    for (const output of [search, read]) {
      expect(isWellFormed(output)).toBe(true)
      expect(output).toContain(`missing\uFFFD${NOTE}\uFFFD`)
    }
  })

  it('repairs evidence text and metadata without changing the evidence value', () => {
    const text = `prefix\uD83D${NOTE}\uDCDD suffix`
    const evidence = {
      documentId: 'd', title: text, blocks: [{
        id: 'b', index: 0, type: 'text' as const, text, textStart: 0, textEnd: text.length,
      }], assets: [], estimatedTokens: 20, truncated: false,
    }
    const output = renderKnowledgeEvidence(evidence)
    expect(isWellFormed(output)).toBe(true)
    expect(output).toContain(`prefix\uFFFD${NOTE}\uFFFD suffix`)
    expect(evidence.blocks[0]?.text).toBe(text)
  })

  it('bounds source labels without splitting an astral block identifier', () => {
    const label = sourceSpanLabel([{
      blockId: `${'a'.repeat(39)}${NOTE}`, blockType: 'text',
      revision: 'r1', chunkStart: 0, chunkEnd: 4, blockStart: 0, blockEnd: 4,
    }])
    expect(isWellFormed(label)).toBe(true)
    expect(label).toContain('a'.repeat(39))
    expect(label).not.toContain('\uFFFD')
  })
})
