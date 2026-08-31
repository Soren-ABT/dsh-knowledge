import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpFetch } from '../src/knowledge/net.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('httpFetch execution budget', () => {
  it('does not start or retry a request whose owner already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const reason = new DOMException('owner cancelled', 'AbortError')
    controller.abort(reason)

    await expect(httpFetch('https://example.test', {
      retries: 4,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not retry when the owner aborts an in-flight request', async () => {
    const controller = new AbortController()
    const reason = new DOMException('owner cancelled', 'AbortError')
    const fetchMock = vi.fn(async () => {
      controller.abort(reason)
      throw reason
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(httpFetch('https://example.test', {
      retries: 4,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one absolute deadline across all retry attempts', async () => {
    let fetchCalls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => fetchCalls === 0 ? 1_000 : 2_000)
    const fetchMock = vi.fn(async () => {
      fetchCalls += 1
      throw new Error('temporary network failure')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(httpFetch('https://example.test', {
      timeoutMs: 10_000,
      deadlineAt: 1_500,
      retries: 4,
    })).rejects.toThrow('timeout')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
