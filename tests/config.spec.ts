import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/knowledge/config.js'
import type { Config } from '../src/knowledge/config.js'
import { LOCAL_MODELS } from '../src/knowledge/localModels.js'
import { poolingFor } from '../src/knowledge/embed.js'
import { MODEL_SUGGESTIONS } from '../src/knowledge/index.js'

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
  siblingChunks: 1,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
  documentProcessorProvider: 'builtin',
  mineruApiKey: '',
  mineruApiHost: '',
  semanticChunk: false,
  semanticChunkThreshold: 0.75,
  chunkTokenLimit: 0,
  conflictStrategy: 'rename',
  urlRefreshHours: 0,
  imageCaptionProvider: 'off',
  imageCaptionModel: '',
  imageCaptionBaseUrl: '',
  imageCaptionApiKey: '',
}

describe('resolveConfig', () => {
  it('uses deployment defaults with empty overrides', () => {
    const { chunkStorePath: _chunkStorePath, ...expected } = base
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

describe('local model registry', () => {
  it('ships real, download-ready ONNX models with dimensions', () => {
    // Every registry entry is a transformers.js-compatible ONNX repo; the
    // settings suggestions mirror the registry exactly.
    expect(LOCAL_MODELS.length).toBeGreaterThanOrEqual(3)
    for (const model of LOCAL_MODELS) {
      expect(model.id.length).toBeGreaterThan(0)
      if (model.kind === 'embedding') {
        expect(model.dimensions).toBeGreaterThan(0)
        expect(model.maxTokens).toBeGreaterThan(0)
      }
    }
    expect(MODEL_SUGGESTIONS.local).toEqual(LOCAL_MODELS.map(model => model.id))
    // The default local model stays the flagship Chinese-capable one.
    expect(LOCAL_MODELS[0].id).toBe('onnx-community/Qwen3-Embedding-0.6B-ONNX')
    // The registry also ships a local cross-encoder for reranking.
    expect(LOCAL_MODELS.some(model => model.kind === 'reranking' && model.id === 'Xenova/bge-reranker-base')).toBe(true)
  })

  it('picks the pooling strategy per model family (Cherry pooling.ts)', () => {
    expect(poolingFor('onnx-community/Qwen3-Embedding-0.6B-ONNX')).toBe('last_token')
    expect(poolingFor('Xenova/bge-small-zh-v1.5')).toBe('cls')
    expect(poolingFor('Xenova/bge-small-en-v1.5')).toBe('cls')
    expect(poolingFor('Xenova/gte-small')).toBe('mean')
    expect(poolingFor('Xenova/multilingual-e5-small')).toBe('mean')
    // Unknown ids fall back to the safest general choice.
    expect(poolingFor('some/unknown-model')).toBe('mean')
  })
})
