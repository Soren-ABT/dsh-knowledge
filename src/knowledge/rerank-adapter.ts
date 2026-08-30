/** Strict, testable cross-encoder scoring adapter. */

export interface CrossEncoderLogits {
  data?: ArrayLike<number>
  dims?: number[]
}

export type CrossEncoderTokenizer = (
  texts: string[],
  options: { text_pair: string[]; padding: true; truncation: true },
) => Promise<Record<string, unknown>>

export type CrossEncoderModel = (
  inputs: Record<string, unknown>,
) => Promise<{ logits?: CrossEncoderLogits }>

export class CrossEncoderResponseError extends Error {
  readonly code = 'invalid_response'
}

function stableSigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function isOutOfMemory(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /out[ -]?of[ -]?memory|allocation failed|failed to allocate|bad_alloc/i.test(text)
}

function nextBatchSize(current: number): number {
  if (current > 8) return 8
  if (current > 4) return 4
  return 1
}

export async function scoreCrossEncoder(
  tokenizer: CrossEncoderTokenizer,
  model: CrossEncoderModel,
  query: string,
  texts: readonly string[],
  initialBatchSize = 16,
): Promise<{ scores: number[]; batchSize: number }> {
  if (texts.length === 0) return { scores: [], batchSize: Math.max(1, initialBatchSize) }
  let batchSize = Math.max(1, Math.trunc(initialBatchSize))
  const scores: number[] = []
  let offset = 0

  while (offset < texts.length) {
    const batch = texts.slice(offset, offset + batchSize)
    try {
      const inputs = await tokenizer(batch.map(() => query), {
        text_pair: [...batch],
        padding: true,
        truncation: true,
      })
      const outputs = await model(inputs)
      const logits = outputs.logits
      if (logits?.data === undefined) throw new CrossEncoderResponseError('rerank model returned no logits')
      const dims = logits.dims
      if (dims !== undefined && (dims.length === 0 || dims.at(-1) !== 1)) {
        throw new CrossEncoderResponseError(`rerank model must return one logit per pair (dims=${dims.join('x')})`)
      }
      if (logits.data.length !== batch.length) {
        throw new CrossEncoderResponseError(`rerank score count mismatch: expected ${batch.length}, received ${logits.data.length}`)
      }
      for (let index = 0; index < batch.length; index += 1) {
        const logit = Number(logits.data[index])
        if (!Number.isFinite(logit)) throw new CrossEncoderResponseError('rerank model returned a non-finite logit')
        const score = stableSigmoid(logit)
        if (!Number.isFinite(score)) throw new CrossEncoderResponseError('rerank model returned a non-finite score')
        scores.push(score)
      }
      offset += batch.length
    } catch (error) {
      if (batchSize > 1 && isOutOfMemory(error)) {
        batchSize = nextBatchSize(batchSize)
        continue
      }
      throw error
    }
  }

  if (scores.length !== texts.length) {
    throw new CrossEncoderResponseError(`rerank score count mismatch: expected ${texts.length}, received ${scores.length}`)
  }
  return { scores, batchSize }
}
