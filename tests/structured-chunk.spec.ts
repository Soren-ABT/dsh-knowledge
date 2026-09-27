import { describe, expect, it } from 'vitest'
import { chunkText, refineChunksByTokenLimit } from '../src/knowledge/chunk.js'
import { chunkParsedDocument } from '../src/knowledge/structured-chunk.js'
import { composeContextWindow, estimateContextTokens, serializeContextWindow } from '../src/knowledge/context.js'
import { sliceSourceSpans } from '../src/knowledge/source-spans.js'
import type { ParsedBlock, ParsedDocument } from '../src/knowledge/processing-types.js'
import type { KnowledgeChunk } from '../src/knowledge/types.js'

function parsed(entries: Array<{ text: string; type?: ParsedBlock['type']; pageIndex?: number; heading?: string }>): ParsedDocument {
  let text = ''
  const blocks: ParsedBlock[] = entries.map((entry, index) => {
    if (text.length > 0) text += '\n\n'
    const start = text.length
    text += entry.text
    return { ...entry, id: `block-${index}`, index, type: entry.type ?? 'text', textStart: start, textEnd: text.length }
  })
  return { schemaVersion: 1, text, blocks, assets: [], sourceHash: 'hash', optionsFingerprint: 'options', provider: 'mineru-local', completeness: 'complete', warnings: [] }
}

function verifyExact(doc: ParsedDocument, chunks: ReturnType<typeof chunkParsedDocument>): void {
  for (const chunk of chunks) {
    for (const span of chunk.sourceSpans ?? []) {
      const block = doc.blocks.find(block => block.id === span.blockId)!
      expect(chunk.text.slice(span.chunkStart, span.chunkEnd)).toBe(block.text.slice(span.blockStart, span.blockEnd))
      expect(span.pageIndex).toBe(block.pageIndex)
      expect(span.revision).toBe('rev-1')
    }
  }
}

describe('structure-aware chunking', () => {
  it('retains the original ordinary-text splitter for documents without blocks', () => {
    const doc = { ...parsed([]), text: '# Heading\n\nfirst paragraph\n\nsecond paragraph' }
    expect(chunkParsedDocument(doc, 'rev-1', 64, 8)).toEqual(chunkText(doc.text, 64, 8))
  })

  it('keeps headings and formulas intact and distinguishes repeated text on separate pages', () => {
    const doc = parsed([
      { text: '# Energy', type: 'heading', pageIndex: 0, heading: 'Energy' },
      { text: '$$ E = mc^2 - 7 $$', type: 'equation', pageIndex: 0, heading: 'Energy' },
      { text: 'Identical repeated text.', pageIndex: 1 },
      { text: 'Identical repeated text.', pageIndex: 2 },
    ])
    const chunks = chunkParsedDocument(doc, 'rev-1', 128, 10)
    expect(chunks[0].text).toContain('# Energy\n\n$$ E = mc^2 - 7 $$')
    expect(chunks[1].sourceSpans?.[0].pageIndex).toBe(1)
    expect(chunks[2].sourceSpans?.[0].pageIndex).toBe(2)
    verifyExact(doc, chunks)
  })

  it('repeats exact table headers while preserving bounded complete rows', () => {
    const rows = Array.from({ length: 24 }, (_, i) => `| item-${i} | ${i + 10} kg |`)
    const header = '| item | mass |\n| --- | --- |'
    const doc = parsed([{ text: `${header}\n${rows.join('\n')}`, type: 'table', pageIndex: 7 }])
    const chunks = chunkParsedDocument(doc, 'rev-1', 64, 8)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.text.startsWith(header)).toBe(true)
      expect(estimateContextTokens(chunk.text)).toBeLessThanOrEqual(64)
      expect(chunk.text.split('\n').slice(2).every(row => rows.includes(row))).toBe(true)
    }
    for (const row of rows) expect(chunks.filter(chunk => chunk.text.includes(row))).toHaveLength(1)
    verifyExact(doc, chunks)
  })

  it('bounds giant formulas, rows and headers without losing or fabricating source locations', () => {
    for (const type of ['table', 'equation'] as const) {
      const doc = parsed([{ text: `${type === 'equation' ? '$$x=' : ''}${'甲乙丙丁😀'.repeat(150)}-42`, type, pageIndex: 4 }])
      const chunks = chunkParsedDocument(doc, 'rev-1', 64, 0, { tokenLimit: 48 })
      expect(chunks.every(chunk => estimateContextTokens(chunk.text) <= 48)).toBe(true)
      expect(chunks.map(chunk => chunk.text).join('')).toBe(doc.text)
      expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk.text))).toBe(true)
      verifyExact(doc, chunks)
    }
  })

  it('also preserves inert HTML row/header slices when an adapter retains HTML tables', () => {
    const rows = Array.from({ length: 24 }, (_, i) => `<tr><td>sample-${i}</td><td>${i} kg</td></tr>`)
    const doc = parsed([{ type: 'table', pageIndex: 3, text: `<table><thead><tr><th>Name</th><th>Mass</th></tr></thead><tbody>${rows.join('')}</tbody></table>` }])
    const chunks = chunkParsedDocument(doc, 'rev-1', 128, 0)
    expect(chunks.length).toBeGreaterThan(1)
    for (const piece of chunks) {
      expect(piece.text).toContain('<th>Name</th>')
      expect(piece.text.endsWith('</tbody></table>')).toBe(true)
      expect(estimateContextTokens(piece.text)).toBeLessThanOrEqual(128)
    }
    for (const row of rows) expect(chunks.filter(chunk => chunk.text.includes(row))).toHaveLength(1)
    verifyExact(doc, chunks)
  })

  it('rejects incorrect block ranges instead of fuzzy-matching repeated content', () => {
    const doc = parsed([{ text: 'correct' }])
    expect(() => chunkParsedDocument({ ...doc, blocks: [{ ...doc.blocks[0], textStart: 1 }] }, 'rev-1', 64, 0)).toThrow('inconsistent')
  })

  it('retains exact mappings when structural grouping is disabled or refined', () => {
    const doc = parsed([{ text: '段落甲。'.repeat(150), pageIndex: 3 }])
    const chunks = chunkParsedDocument(doc, 'rev-1', 256, 8, { structured: false })
    verifyExact(doc, chunks)
    const refined = refineChunksByTokenLimit(chunks, 64, estimateContextTokens)
    verifyExact(doc, refined)
    expect(refined.length).toBeGreaterThan(chunks.length)
  })
})

describe('per-excerpt evidence provenance', () => {
  it('clips long-tail anchors into exact block and excerpt offsets with bounded citations', () => {
    const doc = parsed([{ text: `${'background. '.repeat(100)}TAIL-ANSWER is 42 kg.`, pageIndex: 9 }])
    const piece = chunkParsedDocument(doc, 'rev-1', 2048, 0)[0]
    const anchor: KnowledgeChunk = { ...piece, id: 'c', docId: 'd', baseId: 'b', index: 0, processingRevision: 'rev-1' }
    const window = composeContextWindow([anchor], anchor, { focus: 'TAIL-ANSWER', maxTokens: 80 })
    expect(window.anchor.text).toContain('TAIL-ANSWER')
    expect(window.estimatedTokens).toBeLessThanOrEqual(80)
    expect(serializeContextWindow(window)).toContain('p.10')
    expect(window.anchor.sourceSpans?.[0].chunkStart).toBe(0)
    expect(window.anchor.sourceSpans?.[0].blockStart).toBe(window.anchor.textStart)
    expect(window.anchor.sourceSpans?.[0].blockEnd).toBe(window.anchor.textEnd)
  })

  it('never attributes neighbouring evidence to the anchor or crosses generations', () => {
    const doc = parsed([{ text: 'before evidence', pageIndex: 0 }, { text: 'anchor evidence', pageIndex: 1 }, { text: 'after evidence', pageIndex: 2 }])
    const chunks: KnowledgeChunk[] = chunkParsedDocument(doc, 'rev-1', 128, 0).map((piece, index) => ({ ...piece, id: `c${index}`, docId: 'd', baseId: 'b', index, processingRevision: 'rev-1' }))
    const window = composeContextWindow(chunks, chunks[1], { maxTokens: 200 })
    expect(window.before[0].sourceSpans?.[0].pageIndex).toBe(0)
    expect(window.after[0].sourceSpans?.[0].pageIndex).toBe(2)
    const mixed = composeContextWindow([{ ...chunks[0], processingRevision: 'old' }, chunks[1], chunks[2]], chunks[1], { maxTokens: 200 })
    expect(mixed.before).toEqual([])
  })

  it('clips mappings twice without treating canonical chunk offsets as excerpt offsets', () => {
    const span = { revision: 'r', blockId: 'b', blockType: 'text' as const, chunkStart: 10, chunkEnd: 30, blockStart: 100, blockEnd: 120 }
    const first = sliceSourceSpans([span], 15, 40)
    expect(first[0]).toMatchObject({ chunkStart: 0, chunkEnd: 15, blockStart: 105, blockEnd: 120 })
    expect(sliceSourceSpans(first, 3, 9)[0]).toMatchObject({ chunkStart: 0, chunkEnd: 6, blockStart: 108, blockEnd: 114 })
  })
})
