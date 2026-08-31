import { afterEach, describe, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => ({
  ready: vi.fn(async () => {}),
  rerank: vi.fn(async () => [0.1, 0.9]),
}))

vi.mock('../src/knowledge/localModels.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/knowledge/localModels.js')>()
  return { ...original, assertLocalRerankerReady: local.ready }
})

vi.mock('../src/knowledge/local-rerank.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/knowledge/local-rerank.js')>()
  return { ...original, rerankInLocalProcess: local.rerank }
})

import { RerankExecutionError, rerankCandidates } from '../src/knowledge/rerank.js'

describe('rerank provider validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    local.ready.mockClear()
    local.rerank.mockClear()
  })

  it('uses the isolated local runtime and preserves deterministic score order', async () => {
    const result = await rerankCandidates('', 'local:Xenova/bge-reranker-base', '', 'q', [
      { id: 'a', text: 'a' }, { id: 'b', text: 'b' },
    ], 2, 12_345)
    expect(local.ready).toHaveBeenCalledWith('Xenova/bge-reranker-base')
    expect(local.rerank).toHaveBeenCalledWith('Xenova/bge-reranker-base', expect.any(String), undefined, 'q', ['a', 'b'], expect.any(Number), undefined)
    const appliedBudget = (local.rerank.mock.calls[0] as unknown[] | undefined)?.[5] as number
    expect(appliedBudget).toBeGreaterThan(0)
    expect(appliedBudget).toBeLessThanOrEqual(12_345)
    expect([...result.keys()]).toEqual(['b', 'a'])
  })

  it('accepts execution options and applies the shared deadline to local inference', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const result = await rerankCandidates('', 'local:Xenova/bge-reranker-base', '', 'q', [
      { id: 'a', text: 'a' }, { id: 'b', text: 'b' },
    ], { topN: 1, timeoutMs: 5_000, deadlineAt: 2_200 })

    expect(local.rerank).toHaveBeenCalledWith(
      'Xenova/bge-reranker-base', expect.any(String), undefined, 'q', ['a', 'b'], 1_200, undefined,
    )
    expect([...result.keys()]).toEqual(['b'])
  })

  it('rejects local scores outside the public [0, 1] range', async () => {
    local.rerank.mockResolvedValueOnce([-0.01, 0.9])
    await expect(rerankCandidates('', 'local:Xenova/bge-reranker-base', '', 'q', [
      { id: 'a', text: 'a' }, { id: 'b', text: 'b' },
    ])).rejects.toMatchObject({ detail: { code: 'invalid_response' } })
  })

  it('surfaces an owner abort immediately while local inference is pending', async () => {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    local.rerank.mockImplementationOnce(async () => {
      markStarted()
      return await new Promise<number[]>(() => {})
    })
    const controller = new AbortController()
    const reason = new DOMException('owner cancelled', 'AbortError')
    const pending = rerankCandidates('', 'local:Xenova/bge-reranker-base', '', 'q', [
      { id: 'a', text: 'a' }, { id: 'b', text: 'b' },
    ], { signal: controller.signal })

    await started
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('rejects missing, partial, duplicate, out-of-range, and non-finite remote results', async () => {
    const run = async (results: unknown, candidates = [{ id: 'a', text: 'a' }], topN?: number) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } })))
      return rerankCandidates('https://rerank.test', 'model', '', 'q', candidates, topN)
    }
    await expect(run([])).rejects.toMatchObject({ detail: { code: 'invalid_response' } })
    await expect(run({}, [{ id: 'a', text: 'a' }])).rejects.toMatchObject({ detail: { code: 'invalid_response' } })
    await expect(run([{ index: 0, relevance_score: 0.5 }], [
      { id: 'a', text: 'a' }, { id: 'b', text: 'b' },
    ], 2)).rejects.toMatchObject({ detail: { code: 'invalid_response' } })
    await expect(run([{ index: 2, relevance_score: 0.5 }])).rejects.toBeInstanceOf(RerankExecutionError)
    await expect(run([{ index: 0, relevance_score: Number.NaN }])).rejects.toBeInstanceOf(RerankExecutionError)
    await expect(run([{ index: 0, relevance_score: -0.01 }])).rejects.toMatchObject({ detail: { code: 'invalid_response' } })
    await expect(run([{ index: 0, relevance_score: 1.01 }])).rejects.toMatchObject({ detail: { code: 'invalid_response' } })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [
      { index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.4 },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }]))
      .rejects.toMatchObject({ detail: { code: 'invalid_response' } })
  })

  it('classifies persistent HTTP configuration errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    await expect(rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }]))
      .rejects.toMatchObject({ status: 401, detail: { code: 'provider_error', retryable: false, action: 'check_config' } })
  })

  it('honours retries=0 for latency-critical remote reranking', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchMock)
    await expect(rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }], {
      retries: 0,
      timeoutMs: 4_000,
      deadlineAt: Date.now() + 4_000,
    })).rejects.toThrow('network request failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies an exhausted remote deadline as timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') }))
    await expect(rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }], {
      retries: 0,
      timeoutMs: 10,
      deadlineAt: Date.now() + 10,
    })).rejects.toMatchObject({ detail: { code: 'timeout', retryable: true, action: 'retry_later' } })
  })

  it('keeps the shared deadline active while reading a stalled response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start() {
        // Headers arrive, but the provider never completes its JSON body.
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const started = Date.now()
    await expect(rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }], {
      retries: 0,
      timeoutMs: 25,
      deadlineAt: Date.now() + 25,
    })).rejects.toMatchObject({ detail: { code: 'timeout' } })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('rejects malformed provider JSON as an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    await expect(rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }], {
      retries: 0,
    })).rejects.toMatchObject({ detail: { code: 'invalid_response', retryable: false } })
  })
})
