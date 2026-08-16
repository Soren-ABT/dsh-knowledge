import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/knowledge/config.js'
import type { Config } from '../src/knowledge/config.js'

const base: Config = {
  embeddingProvider: 'none',
  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingApiKey: '',
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  smartChunk: true,
  chunkSeparator: '\n\n',
  chunkSize: 800,
  chunkOverlap: 100,
  topK: 6,
  searchMode: 'auto',
  similarityThreshold: 0,
  mmrDiversity: 0,
  rrfVectorWeight: 1,
  embeddingBatchSize: 32,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
}

describe('resolveConfig', () => {
  it('uses deployment defaults with empty overrides', () => {
    const { localModelCacheDir: _deploymentOnly, chunkStorePath: _chunkStorePath, ...expected } = base
    expect(resolveConfig(base, {})).toEqual(expected)
  })

  it('applies runtime overrides', () => {
    const resolved = resolveConfig(base, { embeddingProvider: 'openai', chunkSize: 1000, searchMode: 'hybrid', rerankModel: 'jina-reranker-v2-base-multilingual' })
    expect(resolved.embeddingProvider).toBe('openai')
    expect(resolved.chunkSize).toBe(1000)
    expect(resolved.searchMode).toBe('hybrid')
    expect(resolved.rerankModel).toBe('jina-reranker-v2-base-multilingual')
  })

  it('clamps out-of-range values', () => {
    expect(resolveConfig(base, { chunkSize: 1 }).chunkSize).toBe(64)
    expect(resolveConfig(base, { topK: 10000 }).topK).toBe(50)
    expect(resolveConfig(base, { mmrDiversity: 5 }).mmrDiversity).toBe(1)
  })
})
