import { describe, expect, it, vi } from 'vitest'
import { CrossEncoderResponseError, scoreCrossEncoder } from '../src/knowledge/rerank-adapter.js'

describe('cross-encoder adapter', () => {
  it('passes batched query and document pairs as parallel tokenizer arrays', async () => {
    const tokenizer = vi.fn(async () => ({ input_ids: [] }))
    const model = vi.fn(async () => ({ logits: { data: [2, -2], dims: [2, 1] } }))
    const result = await scoreCrossEncoder(tokenizer, model, 'expense policy', ['reimbursement', 'weather'], 16)

    expect(tokenizer).toHaveBeenCalledWith(['expense policy', 'expense policy'], {
      text_pair: ['reimbursement', 'weather'],
      padding: true,
      truncation: true,
    })
    expect(result.scores[0]).toBeGreaterThan(result.scores[1]!)
    expect(result.scores).toHaveLength(2)
  })

  it('batches deterministically and returns one finite score per input', async () => {
    const tokenizer = vi.fn(async (_queries: string[], options: { text_pair: string[] }) => ({ count: options.text_pair.length }))
    const model = vi.fn(async (inputs: Record<string, unknown>) => {
      const count = inputs.count as number
      return { logits: { data: Array.from({ length: count }, (_, index) => index), dims: [count, 1] } }
    })
    const result = await scoreCrossEncoder(tokenizer, model, 'q', ['a', 'b', 'c', 'd', 'e'], 2)
    expect(tokenizer).toHaveBeenCalledTimes(3)
    expect(result.scores).toHaveLength(5)
    expect(result.scores.every(Number.isFinite)).toBe(true)
  })

  it('rejects missing, multi-label, mismatched, and non-finite logits', async () => {
    const tokenizer = vi.fn(async () => ({}))
    await expect(scoreCrossEncoder(tokenizer, async () => ({}), 'q', ['a'])).rejects.toBeInstanceOf(CrossEncoderResponseError)
    await expect(scoreCrossEncoder(tokenizer, async () => ({ logits: { data: [1, 2], dims: [1, 2] } }), 'q', ['a']))
      .rejects.toThrow('one logit per pair')
    await expect(scoreCrossEncoder(tokenizer, async () => ({ logits: { data: [1], dims: [2, 1] } }), 'q', ['a', 'b']))
      .rejects.toThrow('score count mismatch')
    await expect(scoreCrossEncoder(tokenizer, async () => ({ logits: { data: [Number.NaN], dims: [1, 1] } }), 'q', ['a']))
      .rejects.toThrow('non-finite')
  })

  it('reduces only recognized OOM batches and retries the same input', async () => {
    const sizes: number[] = []
    const tokenizer = vi.fn(async (_queries: string[], options: { text_pair: string[] }) => {
      sizes.push(options.text_pair.length)
      return { count: options.text_pair.length }
    })
    const model = vi.fn(async (inputs: Record<string, unknown>) => {
      const count = inputs.count as number
      if (count > 4) throw new Error('out of memory')
      return { logits: { data: Array.from({ length: count }, () => 1), dims: [count, 1] } }
    })
    const result = await scoreCrossEncoder(tokenizer, model, 'q', Array.from({ length: 10 }, (_, index) => String(index)), 16)
    expect(sizes.slice(0, 3)).toEqual([10, 8, 4])
    expect(result.batchSize).toBe(4)
    expect(result.scores).toHaveLength(10)
  })

  it('does not hide non-OOM runtime failures', async () => {
    await expect(scoreCrossEncoder(async () => ({}), async () => { throw new Error('session corrupt') }, 'q', ['a'], 16))
      .rejects.toThrow('session corrupt')
  })
})
