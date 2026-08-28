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
  /** Neighbouring chunks (±) attached to each search hit as context (0–3). */
  siblingChunks: number
  /** Local-model cache root; empty = `<DSH_HOME>/cache/dsh-knowledge/local-models`. */
  localModelCacheDir: string
  /** Hugging Face endpoint override (mirror); empty = official hub / `HF_ENDPOINT` env. */
  hfEndpoint: string
  /** Chunk SQLite file; empty = `<DSH_HOME>/storages/knowledge-chunks.sqlite`. */
  chunkStorePath: string
  /** Document processor: `builtin` (local parsers + OCR) or `mineru` (remote MinerU API). */
  documentProcessorProvider: 'builtin' | 'mineru'
  /** MinerU API key (required when provider is `mineru`). */
  mineruApiKey: string
  /** MinerU API host; empty = https://mineru.net */
  mineruApiHost: string
  /** Semantic chunking: embed paragraph-level segments and merge similar adjacent ones. */
  semanticChunk: boolean
  /** Cosine threshold below which adjacent segments start a new chunk (0–1). */
  semanticChunkThreshold: number
  /** Token budget per chunk (0 = off); oversized chunks split at preferred boundaries. */
  chunkTokenLimit: number
  /** Same-name conflict strategy for file imports: keep / replace / rename (Cherry's default). */
  conflictStrategy: 'keep' | 'replace' | 'rename'
  /** Auto-refresh URL documents older than this many hours (0 = off). */
  urlRefreshHours: number
  /** Image/table captioning: `off` / `openai` (vision chat API) / `ollama` (local VLM). */
  imageCaptionProvider: 'off' | 'openai' | 'ollama'
  /** Captioning model id (OpenAI-compatible vision model, or an Ollama VLM like llava / qwen2.5vl). */
  imageCaptionModel: string
  /** Captioning API root; empty = the embedding base URL (openai) or http://127.0.0.1:11434 (ollama). */
  imageCaptionBaseUrl: string
  /** Captioning API key (openai provider). */
  imageCaptionApiKey: string
  /**
   * Re-run interrupted imports on startup (hash reuse re-embeds only the
   * batches that never landed). Off = mark them failed instead — Cherry's
   * posture: a deliberate app quit must not re-spend the embedding API.
   */
  resumeInterruptedOnStartup: boolean
  /**
   * Proactive auto-retrieval: on every user message, cheaply search the
   * enabled bases and inject clearly relevant chunks as model-visible
   * background, so imported facts reach the model even without an explicit
   * "use the knowledge base" instruction or a knowledge_search call.
   */
  autoRetrieve: boolean
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
  chunkSize: Schema.number().default(1024),
  chunkOverlap: Schema.number().default(200),
  topK: Schema.number().default(6),
  searchMode: Schema.union(['auto', 'hybrid', 'vector', 'lexical']).default('auto'),
  similarityThreshold: Schema.number().default(0),
  mmrDiversity: Schema.number().default(0),
  rrfVectorWeight: Schema.number().default(1),
  embeddingBatchSize: Schema.number().default(32),
  siblingChunks: Schema.number().default(1),
  localModelCacheDir: Schema.string().default(''),
  hfEndpoint: Schema.string().default(''),
  chunkStorePath: Schema.string().default(''),
  documentProcessorProvider: Schema.union(['builtin', 'mineru']).default('builtin'),
  mineruApiKey: Schema.string().default(''),
  mineruApiHost: Schema.string().default(''),
  semanticChunk: Schema.boolean().default(false),
  semanticChunkThreshold: Schema.number().default(0.75),
  chunkTokenLimit: Schema.number().default(0),
  conflictStrategy: Schema.union(['keep', 'replace', 'rename']).default('rename'),
  urlRefreshHours: Schema.number().default(0),
  imageCaptionProvider: Schema.union(['off', 'openai', 'ollama']).default('off'),
  imageCaptionModel: Schema.string().default(''),
  imageCaptionBaseUrl: Schema.string().default(''),
  imageCaptionApiKey: Schema.string().default(''),
  resumeInterruptedOnStartup: Schema.boolean().default(true),
  autoRetrieve: Schema.boolean().default(true),
})

/** Resolve a full config from deployment defaults plus runtime overrides. */
export function resolveConfig(config: Config, overrides: ConfigOverrides): KnowledgeConfig {
  const apiKey = overrides.embeddingApiKey
    ?? process.env.KNOWLEDGE_API_KEY
    ?? config.embeddingApiKey
  const rerankApiKey = overrides.rerankApiKey
    ?? process.env.KNOWLEDGE_RERANK_API_KEY
    ?? config.rerankApiKey
  const chunkSize = clampInt(overrides.chunkSize ?? config.chunkSize, 64, 100_000, 1024)
  const chunkOverlap = clampInt(overrides.chunkOverlap ?? config.chunkOverlap, 0, chunkSize - 1, 0)
  const topK = clampInt(overrides.topK ?? config.topK, 1, 50, 6)
  const embeddingBatchSize = clampInt(overrides.embeddingBatchSize ?? config.embeddingBatchSize, 1, 512, 32)
  const rrfVectorWeight = clampNumber(overrides.rrfVectorWeight ?? config.rrfVectorWeight, 0.1, 5, 1)
  const siblingChunks = clampInt(overrides.siblingChunks ?? config.siblingChunks, 0, 3, 1)
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
    siblingChunks,
    hfEndpoint: overrides.hfEndpoint ?? config.hfEndpoint,
    documentProcessorProvider: overrides.documentProcessorProvider ?? config.documentProcessorProvider,
    mineruApiKey: overrides.mineruApiKey ?? config.mineruApiKey,
    mineruApiHost: overrides.mineruApiHost ?? config.mineruApiHost,
    semanticChunk: overrides.semanticChunk ?? config.semanticChunk,
    semanticChunkThreshold: clampNumber(overrides.semanticChunkThreshold ?? config.semanticChunkThreshold, 0, 1, 0.75),
    chunkTokenLimit: clampInt(overrides.chunkTokenLimit ?? config.chunkTokenLimit, 0, 1_000_000, 0),
    conflictStrategy: overrides.conflictStrategy ?? config.conflictStrategy,
    urlRefreshHours: clampInt(overrides.urlRefreshHours ?? config.urlRefreshHours, 0, 24 * 365, 0),
    imageCaptionProvider: overrides.imageCaptionProvider ?? config.imageCaptionProvider,
    imageCaptionModel: overrides.imageCaptionModel ?? config.imageCaptionModel,
    imageCaptionBaseUrl: overrides.imageCaptionBaseUrl ?? config.imageCaptionBaseUrl,
    imageCaptionApiKey: overrides.imageCaptionApiKey ?? config.imageCaptionApiKey,
    resumeInterruptedOnStartup: overrides.resumeInterruptedOnStartup ?? config.resumeInterruptedOnStartup,
    autoRetrieve: overrides.autoRetrieve ?? config.autoRetrieve,
    localModelCacheDir: overrides.localModelCacheDir ?? config.localModelCacheDir,
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
    siblingChunks: clampInt(baseConfig.siblingChunks ?? resolved.siblingChunks, 0, 3, 1),
    documentProcessorProvider: baseConfig.documentProcessorProvider ?? resolved.documentProcessorProvider,
    mineruApiKey: baseConfig.mineruApiKey ?? resolved.mineruApiKey,
    mineruApiHost: baseConfig.mineruApiHost ?? resolved.mineruApiHost,
    semanticChunk: baseConfig.semanticChunk ?? resolved.semanticChunk,
    semanticChunkThreshold: clampNumber(baseConfig.semanticChunkThreshold ?? resolved.semanticChunkThreshold, 0, 1, 0.75),
    chunkTokenLimit: clampInt(baseConfig.chunkTokenLimit ?? resolved.chunkTokenLimit, 0, 1_000_000, 0),
    conflictStrategy: baseConfig.conflictStrategy ?? resolved.conflictStrategy,
    urlRefreshHours: clampInt(baseConfig.urlRefreshHours ?? resolved.urlRefreshHours, 0, 24 * 365, 0),
    imageCaptionProvider: baseConfig.imageCaptionProvider ?? resolved.imageCaptionProvider,
    imageCaptionModel: baseConfig.imageCaptionModel ?? resolved.imageCaptionModel,
    imageCaptionBaseUrl: baseConfig.imageCaptionBaseUrl ?? resolved.imageCaptionBaseUrl,
    imageCaptionApiKey: baseConfig.imageCaptionApiKey ?? resolved.imageCaptionApiKey,
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
