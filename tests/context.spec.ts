import { describe, expect, it } from 'vitest'
import {
  composeContextWindow,
  estimateContextTokens,
  serializeContextWindow,
} from '../src/knowledge/context.js'
import type { KnowledgeChunk } from '../src/knowledge/types.js'

function chunk(index: number, text: string, heading = 'Guide', docId = 'doc-1'): KnowledgeChunk {
  return {
    id: `${docId}-${index}`,
    docId,
    baseId: 'base-1',
    index,
    text,
    heading,
  }
}

describe('composeContextWindow', () => {
  it('returns before, anchor and after in document order from unsorted input', () => {
    const chunks = [chunk(2, 'after'), chunk(0, 'before'), chunk(1, 'anchor')]
    const window = composeContextWindow(chunks, chunks[2], {
      before: 1,
      after: 1,
      maxTokens: 128,
      documentChunkCount: 3,
    })

    expect(window.before.map(item => item.index)).toEqual([0])
    expect(window.anchor.index).toBe(1)
    expect(window.after.map(item => item.index)).toEqual([2])
    expect(serializeContextWindow(window)).toBe('[Guide] before\n\n>>> [Guide] anchor\n\n[Guide] after')
    expect(window.estimatedTokens).toBe(estimateContextTokens(serializeContextWindow(window)))
    expect(window.hasMoreBefore).toBe(false)
    expect(window.hasMoreAfter).toBe(false)
  })

  it('stops on the first different heading unless crossHeading is enabled', () => {
    const chunks = [
      chunk(0, 'older same heading', 'A'),
      chunk(1, 'adjacent previous section', 'B'),
      chunk(2, 'anchor', 'A'),
      chunk(3, 'adjacent next section', 'B'),
      chunk(4, 'later same heading', 'A'),
    ]
    const bounded = composeContextWindow(chunks, chunks[2], { before: 3, after: 3, maxTokens: 256, documentChunkCount: 5 })
    expect(bounded.before).toEqual([])
    expect(bounded.after).toEqual([])
    expect(bounded.hasMoreBefore).toBe(true)
    expect(bounded.hasMoreAfter).toBe(true)

    const crossing = composeContextWindow(chunks, chunks[2], {
      before: 2,
      after: 2,
      crossHeading: true,
      maxTokens: 256,
      documentChunkCount: 5,
    })
    expect(crossing.before.map(item => item.index)).toEqual([0, 1])
    expect(crossing.after.map(item => item.index)).toEqual([3, 4])
  })

  it('centres an oversized anchor around a tail match and preserves relative offsets', () => {
    const text = `${'unrelated prefix '.repeat(100)}TARGET-EVIDENCE-42. ${'tail '.repeat(30)}`
    const anchor = chunk(0, text)
    const window = composeContextWindow([anchor], anchor, {
      before: 0,
      after: 0,
      maxTokens: 45,
      focus: 'TARGET-EVIDENCE-42',
      documentChunkCount: 1,
    })

    expect(window.anchor.text).toContain('TARGET-EVIDENCE-42')
    expect(window.anchor.textStart).toBeGreaterThan(0)
    expect(window.anchor.textEnd).toBeLessThanOrEqual(text.length)
    expect(window.anchor.truncatedStart).toBe(true)
    expect(window.estimatedTokens).toBeLessThanOrEqual(45)
    expect(text.slice(window.anchor.textStart, window.anchor.textEnd)).toBe(window.anchor.text)
  })

  it('falls back to the opening sentence when an oversized anchor has no focus match', () => {
    const text = `First complete sentence. Second complete sentence. ${'later material '.repeat(200)}`
    const anchor = chunk(0, text)
    const window = composeContextWindow([anchor], anchor, {
      before: 0,
      after: 0,
      maxTokens: 12,
      focus: 'a query that is absent',
      documentChunkCount: 1,
    })

    expect(window.anchor.textStart).toBe(0)
    expect(window.anchor.text).toBe('First complete sentence.')
    expect(window.anchor.text.endsWith('.')).toBe(true)
    expect(window.anchor.truncatedStart).toBe(false)
    expect(window.anchor.truncatedEnd).toBe(true)
    expect(window.estimatedTokens).toBeLessThanOrEqual(12)
  })

  it('finds a Chinese keyword inside a longer conversational focus query', () => {
    const text = `${'不相关内容。'.repeat(300)}年假政策规定可携带五天。`
    const anchor = chunk(0, text)
    const window = composeContextWindow([anchor], anchor, {
      before: 0,
      after: 0,
      maxTokens: 64,
      focus: '请问这个年假政策是什么？',
      documentChunkCount: 1,
    })

    expect(window.anchor.text).toContain('年假政策')
    expect(window.estimatedTokens).toBeLessThanOrEqual(64)
  })

  it('does not let an untrusted oversized heading consume the hard budget', () => {
    const anchor = chunk(0, `${'prefix '.repeat(100)}NEEDED-EVIDENCE`, '标题'.repeat(1_000))
    const window = composeContextWindow([anchor], anchor, {
      before: 0,
      after: 0,
      maxTokens: 45,
      focus: 'NEEDED-EVIDENCE',
      documentChunkCount: 1,
    })

    expect(window.estimatedTokens).toBeLessThanOrEqual(45)
    expect(window.anchor.text).toContain('NEEDED-EVIDENCE')
    expect(window.anchor.heading).toBeUndefined()
  })

  it.each([1, 2, 3, 4, 8, 16])('never exceeds an extreme %i-token budget', maxTokens => {
    const chunks = [
      chunk(0, '前文'.repeat(200), '极长标题'.repeat(100)),
      chunk(1, `ANCHOR-${'内容'.repeat(200)}`, '极长标题'.repeat(100)),
      chunk(2, '后文'.repeat(200), '极长标题'.repeat(100)),
    ]
    const window = composeContextWindow(chunks, chunks[1], {
      before: 1,
      after: 1,
      maxTokens,
      focus: 'ANCHOR',
      documentChunkCount: 3,
    })

    expect(window.anchorChunkId).toBe(chunks[1].id)
    expect(window.anchorIndex).toBe(1)
    expect(window.estimatedTokens).toBe(estimateContextTokens(serializeContextWindow(window)))
    expect(window.estimatedTokens).toBeLessThanOrEqual(maxTokens)
  })

  it('deduplicates 24+ character overlap while preserving the anchor', () => {
    const overlap = 'abcdefghijklmnopqrstuvwx' // exactly 24 characters
    const chunks = [
      chunk(0, `before-${overlap}`),
      chunk(1, `${overlap}-anchor-${overlap}`),
      chunk(2, `${overlap}-after`),
    ]
    const window = composeContextWindow(chunks, chunks[1], {
      before: 1,
      after: 1,
      maxTokens: 256,
      documentChunkCount: 3,
    })
    const rendered = serializeContextWindow(window)

    expect(window.anchor.text).toBe(chunks[1].text)
    expect(window.before[0].text).toBe('before-')
    expect(window.before[0].truncatedEnd).toBe(true)
    expect(window.after[0].text).toBe('-after')
    expect(window.after[0].truncatedStart).toBe(true)
    expect(rendered.match(new RegExp(overlap, 'g'))).toHaveLength(2)
  })

  it('keeps the canonical serialization inside the hard budget and favours near neighbours', () => {
    const chunks = [
      chunk(0, 'far before '.repeat(100)),
      chunk(1, 'near before '.repeat(80)),
      chunk(2, 'short anchor with answer'),
      chunk(3, 'near after '.repeat(80)),
      chunk(4, 'far after '.repeat(100)),
    ]
    const window = composeContextWindow(chunks, chunks[2], {
      before: 2,
      after: 2,
      maxTokens: 90,
      documentChunkCount: 5,
    })

    expect(window.estimatedTokens).toBeLessThanOrEqual(90)
    expect(window.estimatedTokens).toBe(estimateContextTokens(serializeContextWindow(window)))
    expect(window.anchor.text).toBe('short anchor with answer')
    expect(window.before.at(-1)?.index).toBe(1)
    expect(window.after[0]?.index).toBe(3)
    expect(window.hasMoreBefore).toBe(true)
    expect(window.hasMoreAfter).toBe(true)
  })

  it('ignores chunks from another document and honours explicit availability hints', () => {
    const anchor = chunk(3, 'anchor')
    const window = composeContextWindow([chunk(2, 'wrong document', 'Guide', 'doc-2'), anchor], anchor, {
      maxTokens: 128,
      hasMoreBefore: false,
      hasMoreAfter: true,
    })

    expect(window.before).toEqual([])
    expect(window.after).toEqual([])
    expect(window.hasMoreBefore).toBe(false)
    expect(window.hasMoreAfter).toBe(true)
  })
})
