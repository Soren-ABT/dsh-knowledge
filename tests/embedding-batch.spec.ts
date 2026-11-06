import { describe, expect, it, vi } from 'vitest'
import { embeddingBatchSize, embedWithMemoryFallback, isEmbeddingBatchLimitError, isEmbeddingOutOfMemory } from '../src/knowledge/embedding-batch.js'

describe('local embedding memory policy', () => {
  it('caps local calls without reducing remote provider batches', () => {
    expect(embeddingBatchSize('local', 32)).toBe(8)
    expect(embeddingBatchSize('local', 1)).toBe(1)
    expect(embeddingBatchSize('openai', 32)).toBe(32)
  })

  it('recognizes provider input-count caps but not unrelated 400s', () => {
    expect(isEmbeddingBatchLimitError(new Error(
      '<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, it should not be larger than 25.: input.contents',
    ))).toBe(true)
    expect(isEmbeddingBatchLimitError(new Error('too many inputs'))).toBe(true)
    expect(isEmbeddingBatchLimitError(new Error('embedding request failed: HTTP 401 invalid api key'))).toBe(false)
    expect(isEmbeddingBatchLimitError(new Error('invalid model configuration'))).toBe(false)
  })

  it('reduces only failed slices and preserves every vector in input order', async () => {
    const inputs = Array.from({ length: 13 }, (_, index) => String(index))
    const embed = vi.fn(async (batch: readonly string[]) => {
      if (Number(batch[0]) >= 8 && batch.length > 2) throw new Error('runtime_error: failed to allocate memory')
      return batch.map(text => [Number(text)])
    })
    const reduced = vi.fn()
    expect(await embedWithMemoryFallback(inputs, 8, embed, reduced)).toEqual(inputs.map(text => [Number(text)]))
    expect(embed.mock.calls.map(([batch]) => batch.length)).toEqual([8, 5, 4, 2, 2, 1])
    expect(reduced.mock.calls).toEqual([[4], [2]])
  })

  it('stops at one input and does not classify generic crashes as memory errors', async () => {
    const reduced = vi.fn()
    const embed = vi.fn(async () => { throw new Error('bad_alloc') })
    await expect(embedWithMemoryFallback(['a', 'b'], 2, embed, reduced)).rejects.toThrow('bad_alloc')
    expect(embed).toHaveBeenCalledTimes(2)
    expect(reduced).toHaveBeenCalledExactlyOnceWith(1)
    expect(isEmbeddingOutOfMemory(new Error('process exited (null, SIGKILL)'))).toBe(false)
    const invalid = vi.fn(async () => { throw new Error('invalid model configuration') })
    await expect(embedWithMemoryFallback(['a', 'b'], 2, invalid, reduced)).rejects.toThrow('invalid model')
    expect(invalid).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before retrying an allocation failure', async () => {
    const controller = new AbortController()
    const embed = vi.fn(async () => {
      controller.abort(new Error('cancelled by owner'))
      throw new Error('out of memory')
    })
    await expect(embedWithMemoryFallback(['a', 'b'], 2, embed, vi.fn(), controller.signal)).rejects.toThrow('cancelled by owner')
    expect(embed).toHaveBeenCalledTimes(1)
  })
})
