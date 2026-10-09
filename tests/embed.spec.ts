import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedTexts } from '../src/knowledge/embed.js'

describe('embedding provider URL defaults', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the local Ollama endpoint when the configured base URL is empty', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ embeddings: [[0.25, 0.75]] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const vectors = await embedTexts('ollama', '   ', 'nomic-embed-text', '', ['hello'])
    expect(vectors[0]?.[0]).toBeCloseTo(0.316227766)
    expect(vectors[0]?.[1]).toBeCloseTo(0.948683298)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/embed')
  })

  it('continues to reject an empty OpenAI-compatible base URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(embedTexts('openai', ' ', 'text-embedding-3-small', '', ['hello']))
      .rejects.toThrow('embedding base URL is empty')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['openai', 'ollama'] as const)('repairs malformed text before sending a %s embedding request', async provider => {
    const texts = Object.freeze(['before\uD83Dafter', 'valid📝and\uDCDDtail'])
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      provider === 'openai' ? { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] } : { embeddings: [[1, 0], [0, 1]] },
    ), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(embedTexts(provider, 'http://127.0.0.1:11434', 'model', 'key', texts)).resolves.toEqual([[1, 0], [0, 1]])
    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(request?.body as string)).toEqual({ model: 'model', input: ['before\uFFFDafter', 'valid📝and\uFFFDtail'] })
    expect(texts).toEqual(['before\uD83Dafter', 'valid📝and\uDCDDtail'])
  })

  it('keeps repaired text in the legacy Ollama fallback', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => new Response(
      String(input).endsWith('/api/embed') ? '{}' : JSON.stringify({ embedding: [1, 0] }),
      { status: String(input).endsWith('/api/embed') ? 404 : 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(embedTexts('ollama', '', 'model', '', ['before\uD83Dafter📝'])).resolves.toEqual([[1, 0]])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ model: 'model', prompt: 'before\uFFFDafter📝' })
  })
})
