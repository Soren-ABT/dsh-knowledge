import { describe, expect, it } from 'vitest'
import { chunkText, normalizeText } from '../src/knowledge/chunk.js'

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
