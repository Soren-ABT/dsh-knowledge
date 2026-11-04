/** Shared limits for ordinary and semantic local embedding calls. */
import type { EmbeddingProvider } from './types.js'

export function embeddingBatchSize(provider: EmbeddingProvider, configured: number): number {
  const size = Math.max(1, Math.trunc(configured))
  return provider === 'local' ? Math.min(size, 8) : size
}

export function isEmbeddingOutOfMemory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /out[ -]?of[ -]?memory|allocation failed|failed to allocate|bad_alloc/i.test(message)
}

/** Retry only the failed slice at a smaller size; preserve order and completed work. */
export async function embedWithMemoryFallback(
  texts: readonly string[],
  initialSize: number,
  embed: (batch: readonly string[]) => Promise<number[][]>,
  onReduced: (size: number) => void,
  signal?: AbortSignal,
): Promise<number[][]> {
  const vectors: number[][] = []
  let size = Math.max(1, Math.trunc(initialSize))
  let offset = 0
  while (offset < texts.length) {
    signal?.throwIfAborted()
    const batch = texts.slice(offset, offset + size)
    try {
      const result = await embed(batch)
      if (result.length !== batch.length) throw new Error('embedding returned an invalid vector count')
      vectors.push(...result)
      offset += batch.length
    } catch (error) {
      signal?.throwIfAborted()
      if (size <= 1 || !isEmbeddingOutOfMemory(error)) throw error
      size = Math.max(1, Math.floor(size / 2))
      onReduced(size)
    }
  }
  return vectors
}
