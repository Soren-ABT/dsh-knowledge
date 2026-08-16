/**
 * Plugin configuration (schemastery) and resolved-config merging. The
 * cordis.yml `config:` block supplies deployment defaults; the browser panel
 * can override them at runtime (persisted in the domain global slot), and
 * every base can layer its own per-base config on top.
 * @module dsh-knowledge/knowledge/config
 */

import Schema from '@deepseek-ai/schemastery'
import type { ConfigOverrides } from './domain.js'
import type { BaseConfig, EmbeddingProvider, KnowledgeConfig, SearchMode } from './types.js'

export interface Config {
  embeddingProvider: EmbeddingProvider
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKey: string
  rerankModel: string
  rerankBaseUrl: string
  rerankApiKey: string
  smartChunk: boolean
  chunkSeparator: string
  chunkSize: number
  chunkOverlap: number
  topK: number
  searchMode: SearchMode
  similarityThreshold: number
  mmrDiversity: number
  /** Relative weight of the vector lane in RRF hybrid fusion (0.1–5, 1 = balanced). */
  rrfVectorWeight: number
  embeddingBatchSize: number
  /** Local-model cache root; empty = `<DSH_HOME>/cache/dsh-knowledge/local-models`. */
  localModelCacheDir: string
  /** Hugging Face endpoint override (mirror); empty = official hub / `HF_ENDPOINT` env. */
  hfEndpoint: string
  /** Chunk SQLite file; empty = `<DSH_HOME>/storages/knowledge-chunks.sqlite`. */
  chunkStorePath: string
}

export const Config: Schema<Config> = Schema.object({
  embeddingProvider: Schema.union(['openai', 'ollama', 'local', 'none']).default('none'),
  embeddingBaseUrl: Schema.string().default(''),
  embeddingModel: Schema.string().default(''),
  embeddingApiKey: Schema.string().default(''),
  rerankModel: Schema.string().default(''),
  rerankBaseUrl: Schema.string().default(''),
  rerankApiKey: Schema.string().default(''),
  smartChunk: Schema.boolean().default(true),
  chunkSeparator: Schema.string().default('\n\n'),
  chunkSize: Schema.number().default(800),
  chunkOverlap: Schema.number().default(100),
  topK: Schema.number().default(6),
  searchMode: Schema.union(['auto', 'hybrid', 'vector', 'lexical']).default('auto'),
  similarityThreshold: Schema.number().default(0),
  mmrDiversity: Schema.number().default(0),
  rrfVectorWeight: Schema.number().default(1),
  embeddingBatchSize: Schema.number().default(32),
  localModelCacheDir: Schema.string().default(''),
  hfEndpoint: Schema.string().default(''),
  chunkStorePath: Schema.string().default(''),
})

/** Resolve a full config from deployment defaults plus runtime overrides. */
export function resolveConfig(config: Config, overrides: ConfigOverrides): KnowledgeConfig {
  const apiKey = overrides.embeddingApiKey
    ?? process.env.KNOWLEDGE_API_KEY
    ?? config.embeddingApiKey
  const rerankApiKey = overrides.rerankApiKey
    ?? process.env.KNOWLEDGE_RERANK_API_KEY
    ?? config.rerankApiKey
  const chunkSize = clampInt(overrides.chunkSize ?? config.chunkSize, 64, 100_000, 800)
  const chunkOverlap = clampInt(overrides.chunkOverlap ?? config.chunkOverlap, 0, chunkSize - 1, 0)
  const topK = clampInt(overrides.topK ?? config.topK, 1, 50, 6)
  const embeddingBatchSize = clampInt(overrides.embeddingBatchSize ?? config.embeddingBatchSize, 1, 512, 32)
  const rrfVectorWeight = clampNumber(overrides.rrfVectorWeight ?? config.rrfVectorWeight, 0.1, 5, 1)
  return {
    embeddingProvider: overrides.embeddingProvider ?? config.embeddingProvider,
    embeddingBaseUrl: overrides.embeddingBaseUrl ?? config.embeddingBaseUrl,
    embeddingModel: overrides.embeddingModel ?? config.embeddingModel,
    embeddingApiKey: apiKey,
    rerankModel: overrides.rerankModel ?? config.rerankModel,
    rerankBaseUrl: overrides.rerankBaseUrl ?? config.rerankBaseUrl,
    rerankApiKey,
    smartChunk: overrides.smartChunk ?? config.smartChunk,
    chunkSeparator: overrides.chunkSeparator ?? config.chunkSeparator,
    chunkSize,
    chunkOverlap,
    topK,
    searchMode: overrides.searchMode ?? config.searchMode,
    similarityThreshold: clampNumber(overrides.similarityThreshold ?? config.similarityThreshold, 0, 1, 0),
    mmrDiversity: clampNumber(overrides.mmrDiversity ?? config.mmrDiversity, 0, 1, 0),
    rrfVectorWeight,
    embeddingBatchSize,
    hfEndpoint: overrides.hfEndpoint ?? config.hfEndpoint,
  }
}

/**
 * Resolve one base's effective config: plugin defaults, then global runtime
 * overrides, then that base's own per-base config (highest precedence for
 * the fields it sets).
 */
export function resolveConfigFor(config: Config, overrides: ConfigOverrides, baseConfig?: BaseConfig): KnowledgeConfig {
  const resolved = resolveConfig(config, overrides)
  if (baseConfig === undefined) return resolved
  const chunkSize = clampInt(baseConfig.chunkSize ?? resolved.chunkSize, 64, 100_000, 800)
  const chunkOverlap = clampInt(baseConfig.chunkOverlap ?? resolved.chunkOverlap, 0, chunkSize - 1, 0)
  const topK = clampInt(baseConfig.topK ?? resolved.topK, 1, 50, 6)
  return {
    ...resolved,
    embeddingProvider: baseConfig.embeddingProvider ?? resolved.embeddingProvider,
    embeddingBaseUrl: baseConfig.embeddingBaseUrl ?? resolved.embeddingBaseUrl,
    embeddingModel: baseConfig.embeddingModel ?? resolved.embeddingModel,
    embeddingApiKey: baseConfig.embeddingApiKey ?? resolved.embeddingApiKey,
    rerankModel: baseConfig.rerankModel ?? resolved.rerankModel,
    rerankBaseUrl: baseConfig.rerankBaseUrl ?? resolved.rerankBaseUrl,
    rerankApiKey: baseConfig.rerankApiKey ?? resolved.rerankApiKey,
    smartChunk: baseConfig.smartChunk ?? resolved.smartChunk,
    chunkSeparator: baseConfig.chunkSeparator ?? resolved.chunkSeparator,
    chunkSize,
    chunkOverlap,
    topK,
    searchMode: baseConfig.searchMode ?? resolved.searchMode,
    similarityThreshold: clampNumber(baseConfig.similarityThreshold ?? resolved.similarityThreshold, 0, 1, 0),
    mmrDiversity: clampNumber(baseConfig.mmrDiversity ?? resolved.mmrDiversity, 0, 1, 0),
    rrfVectorWeight: clampNumber(baseConfig.rrfVectorWeight ?? resolved.rrfVectorWeight, 0.1, 5, 1),
    embeddingBatchSize: clampInt(baseConfig.embeddingBatchSize ?? resolved.embeddingBatchSize, 1, 512, 32),
  }
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
