import { describe, expect, it } from 'vitest'
import { chunkText, mergeSemanticSegments, normalizeText, splitSemanticSegments } from '../src/knowledge/chunk.js'

describe('chunkText', () => {
  it('returns [] for empty input', () => {
    expect(chunkText('', 800, 100)).toEqual([])
  })

  it('keeps short text as a single chunk', () => {
    expect(chunkText('hello world', 800, 100)).toEqual([{ text: 'hello world' }])
  })

  it('splits long text into bounded chunks', () => {
    const text = 'word '.repeat(1000) // 5000 chars
    const chunks = chunkText(text, 500, 50)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(500)
  })

  it('splits on paragraph boundaries', () => {
    const text = 'first paragraph\n\nsecond paragraph\n\nthird paragraph'
    expect(chunkText(text, 800, 100).map(c => c.text)).toEqual(['first paragraph', 'second paragraph', 'third paragraph'])
  })

  it('tracks markdown heading paths', () => {
    const text = '# Intro\n\nhello world\n\n## Methods\n\nbody text here'
    const chunks = chunkText(text, 800, 100)
    const intro = chunks.find(c => c.text === 'hello world')
    const methods = chunks.find(c => c.text === 'body text here')
    expect(intro?.heading).toBe('Intro')
    expect(methods?.heading).toBe('Intro > Methods')
  })

  it('skips never-seen heading levels instead of emitting empty segments', () => {
    const text = '# Intro\n\n### Deep\n\nbody text here'
    const chunks = chunkText(text, 800, 100)
    const deep = chunks.find(c => c.text === 'body text here')
    expect(deep?.heading).toBe('Intro > Deep')
  })

  it('normalizes line endings', () => {
    expect(normalizeText('a\r\nb\r\n\r\nc')).toBe('a\nb\n\nc')
  })
})

describe('splitSemanticSegments', () => {
  it('splits into heading-aware paragraph segments without windowing', () => {
    const text = '# Intro\nfirst paragraph\n\nsecond paragraph\n\n## Deep\nbody text'
    const segments = splitSemanticSegments(text)
    expect(segments.length).toBe(3)
    expect(segments[0].text).toBe('first paragraph')
    expect(segments[0].heading).toBe('Intro')
    expect(segments[1].text).toBe('second paragraph')
    expect(segments[2].text).toBe('body text')
    expect(segments[2].heading).toBe('Intro > Deep')
  })
})

describe('mergeSemanticSegments', () => {
  it('merges similar adjacent segments up to the size bound', () => {
    const segments = [
      { text: 'a'.repeat(100) },
      { text: 'b'.repeat(100) },
      { text: 'c'.repeat(100) },
      { text: 'd'.repeat(200) },
    ]
    // All vectors identical → all merge until size; then the size bound cuts.
    // The '\n' joiners count toward the budget (100+100+100+2 = 302).
    const vectors = segments.map(() => [1, 0, 0])
    const merged = mergeSemanticSegments(segments, vectors, 350)
    expect(merged.length).toBe(2)
    expect(merged[0].text.length).toBe(302)
    expect(merged[1].text.length).toBe(200)
    // Merged vector is the length-weighted mean, still normalized.
    expect(merged[0].embedding?.[0]).toBeCloseTo(1, 5)
  })

  it('cuts where adjacent segments are dissimilar', () => {
    const segments = [
      { text: 'alpha' },
      { text: 'beta' },
      { text: 'gamma' },
    ]
    const vectors = [
      [1, 0, 0],
      [0, 1, 0], // orthogonal to alpha → below threshold → cut
      [0.1, 0.9, 0], // close to beta → merges with it
    ]
    const merged = mergeSemanticSegments(segments, vectors, 1000, 0.5)
    expect(merged.length).toBe(2)
    expect(merged[0].text).toBe('alpha')
    expect(merged[1].text).toBe('beta\ngamma')
  })

  it('keeps the first segment\'s heading on a merged chunk', () => {
    const segments = [
      { text: 'one', heading: 'Top' },
      { text: 'two', heading: 'Top' },
    ]
    const merged = mergeSemanticSegments(segments, [[1, 0], [1, 0]], 1000)
    expect(merged.length).toBe(1)
    expect(merged[0].text).toBe('one\ntwo')
    expect(merged[0].heading).toBe('Top')
  })

  it('handles missing vectors by merging on size only', () => {
    const segments = [{ text: 'x'.repeat(100) }, { text: 'y'.repeat(100) }]
    const merged = mergeSemanticSegments(segments, [undefined, undefined], 150)
    expect(merged.length).toBe(2)
    expect(merged[0].embedding).toBeUndefined()
  })
})
