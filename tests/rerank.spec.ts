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
    vi.unstubAllGlobals()
    local.ready.mockClear()
    local.rerank.mockClear()
  })

  it('uses the isolated local runtime and preserves deterministic score order', async () => {
    const result = await rerankCandidates('', 'local:Xenova/bge-reranker-base', '', 'q', [
      { id: 'a', text: 'a' }, { id: 'b', text: 'b' },
    ], 2, 12_345)
    expect(local.ready).toHaveBeenCalledWith('Xenova/bge-reranker-base')
    expect(local.rerank).toHaveBeenCalledWith('Xenova/bge-reranker-base', expect.any(String), undefined, 'q', ['a', 'b'], 12_345)
    expect([...result.keys()]).toEqual(['b', 'a'])
  })

  it('rejects empty, duplicate, out-of-range, and non-finite remote results', async () => {
    const run = async (results: unknown[]) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } })))
      return rerankCandidates('https://rerank.test', 'model', '', 'q', [{ id: 'a', text: 'a' }])
    }
    await expect(run([])).rejects.toMatchObject({ detail: { code: 'invalid_response' } })
    await expect(run([{ index: 2, relevance_score: 0.5 }])).rejects.toBeInstanceOf(RerankExecutionError)
    await expect(run([{ index: 0, relevance_score: Number.NaN }])).rejects.toBeInstanceOf(RerankExecutionError)

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
})
