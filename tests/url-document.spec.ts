import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUrlDocument } from '../src/knowledge/url-document.js'
import { readResponseBytes } from '../src/knowledge/response-body.js'

const signal = new AbortController().signal
afterEach(() => vi.unstubAllGlobals())

describe('URL document formats and body limits', () => {
  it.each([
    ['/download', 'text/markdown'], ['/download', 'Text/X-Markdown; charset=utf-8'],
    ['/manual.MD?v=1', 'text/plain'], ['/manual.markdown', 'application/octet-stream'], ['/raw.md', ''],
  ])('preserves Markdown structure from %s served as %s', async (path, mimeType) => {
    const source = '# Wiki\r\n\r\n```html\n<div>Hello</div>\n```\n'
    vi.stubGlobal('fetch', async () => new Response(new TextEncoder().encode(source), {
      headers: mimeType ? { 'content-type': mimeType } : {},
    }))
    expect((await fetchUrlDocument('https://example.com' + path, signal)).text).toBe(source)
  })

  it('uses the final URL for file type and releases redirect bodies', async () => {
    const cancel = vi.fn()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: '/raw/wiki.md' } }))
      .mockResolvedValueOnce(new Response('# Notes', { headers: { 'content-type': 'text/plain' } }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchUrlDocument('https://example.com/link', signal)).toEqual({ title: '', text: '# Notes' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://example.com/link', 'https://example.com/raw/wiki.md'])
  })

  it('gives HTML media types priority over filenames', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html><head><title>Rendered</title></head><body><p>page text</p></body></html>', {
      headers: { 'content-type': 'text/html' },
    }))
    expect(await fetchUrlDocument('https://example.com/rendered.md', signal)).toEqual({ title: 'Rendered', text: 'page text' })
  })

  it.each([
    ['https://example.com/raw.md', 'application/pdf', [65], /HTML page or Markdown/],
    ['https://example.com/download', 'application/octet-stream', [65], /HTML page or Markdown/],
    ['https://example.com/raw.md', 'text/plain', [0, 65], /binary data/],
    ['https://example.com/raw.md', 'text/plain', [255], /UTF-8/],
  ] as const)('rejects unsupported data from %s (%s)', async (url, type, bytes, expected) => {
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from(bytes), { headers: { 'content-type': type } }))
    await expect(fetchUrlDocument(url, signal)).rejects.toThrow(expected)
  })

  it('cancels rejected responses before reading a declared oversized body', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'text/html', 'content-length': String(8 * 1024 * 1024 + 1) },
    }))
    await expect(fetchUrlDocument('https://example.com/wiki', signal)).rejects.toThrow('8 MiB')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('enforces the byte limit while streaming and releases the reader', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); controller.enqueue(Uint8Array.of(4, 5)) },
      cancel,
    })
    await expect(readResponseBytes(new Response(body), 4, signal, () => new Error('size limit'))).rejects.toThrow('size limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
})
