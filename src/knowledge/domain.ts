/**
 * The single durable domain for the knowledge store: `bases`, `documents`,
 * and `chunks` tables plus a global slot holding runtime config overrides.
 * Record schemas are zod (validated at the durable boundary by
 * `@deepseek-ai/dsh-storage-domain`); plugin Config stays schemastery.
 * @module dsh-knowledge/knowledge/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  KnowledgeBase,
  KnowledgeConfig,
  KnowledgeDocument,
} from './types.js'

/** Per-base config overrides, validated at the durable boundary. */
export const baseConfigSchema = z.object({
  embeddingProvider: z.enum(['openai', 'ollama', 'local', 'none']).optional(),
  embeddingBaseUrl: z.string().optional(),
  embeddingModel: z.string().optional(),
  embeddingApiKey: z.string().optional(),
  rerankModel: z.string().optional(),
  rerankBaseUrl: z.string().optional(),
  rerankApiKey: z.string().optional(),
  smartChunk: z.boolean().optional(),
  chunkSeparator: z.string().optional(),
  chunkSize: z.number().int().gt(0).optional(),
  chunkOverlap: z.number().int().gte(0).optional(),
  topK: z.number().int().gt(0).optional(),
  searchMode: z.enum(['auto', 'hybrid', 'vector', 'lexical']).optional(),
  similarityThreshold: z.number().gte(0).lte(1).optional(),
  mmrDiversity: z.number().gte(0).lte(1).optional(),
  rrfVectorWeight: z.number().gte(0.1).lte(5).optional(),
  embeddingBatchSize: z.number().int().gt(0).optional(),
  siblingChunks: z.number().int().gte(0).lte(3).optional(),
  // Mirrors BaseConfig: every base-settable field must survive the durable
  // boundary — a missing key here makes zod strip the override on save.
  documentProcessorProvider: z.enum(['builtin', 'mineru']).optional(),
  mineruApiKey: z.string().optional(),
  mineruApiHost: z.string().optional(),
  semanticChunk: z.boolean().optional(),
  semanticChunkThreshold: z.number().gte(0).lte(1).optional(),
  chunkTokenLimit: z.number().int().gte(0).optional(),
  conflictStrategy: z.enum(['keep', 'replace', 'rename']).optional(),
  urlRefreshHours: z.number().int().gte(0).optional(),
  imageCaptionProvider: z.enum(['off', 'openai', 'ollama']).optional(),
  imageCaptionModel: z.string().optional(),
  imageCaptionBaseUrl: z.string().optional(),
  imageCaptionApiKey: z.string().optional(),
})

const baseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  group: z.string().optional(),
  config: baseConfigSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const documentSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  title: z.string(),
  sourceType: z.enum(['text', 'file', 'url', 'directory']),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  url: z.string().optional(),
  parentDirectoryId: z.string().optional(),
  /** Absolute path of the source directory this container was imported from
   *  (Cherry's pathStorage): reindexing the container rescans the path and
   *  picks up new/removed files. Absent on legacy/created containers. */
  sourcePath: z.string().optional(),
  contentHash: z.string().optional(),
  rawFilePath: z.string().optional(),
  rawText: z.string().optional(),
  charCount: z.number().int().gte(0),
  tokenCount: z.number().int().gte(0).optional(),
  chunkCount: z.number().int().gte(0),
  incomplete: z.boolean().optional(),
  embeddingError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
})

/** Runtime overrides merged over the plugin Config defaults (user-editable). */
export const configOverridesSchema = z.object({
  embeddingProvider: z.enum(['openai', 'ollama', 'local', 'none']).optional(),
  embeddingBaseUrl: z.string().optional(),
  embeddingModel: z.string().optional(),
  embeddingApiKey: z.string().optional(),
  rerankModel: z.string().optional(),
  rerankBaseUrl: z.string().optional(),
  rerankApiKey: z.string().optional(),
  smartChunk: z.boolean().optional(),
  chunkSeparator: z.string().optional(),
  chunkSize: z.number().int().gt(0).optional(),
  chunkOverlap: z.number().int().gte(0).optional(),
  topK: z.number().int().gt(0).optional(),
  searchMode: z.enum(['auto', 'hybrid', 'vector', 'lexical']).optional(),
  similarityThreshold: z.number().gte(0).lte(1).optional(),
  mmrDiversity: z.number().gte(0).lte(1).optional(),
  rrfVectorWeight: z.number().gte(0.1).lte(5).optional(),
  embeddingBatchSize: z.number().int().gt(0).optional(),
  siblingChunks: z.number().int().gte(0).lte(3).optional(),
  hfEndpoint: z.string().optional(),
  documentProcessorProvider: z.enum(['builtin', 'mineru']).optional(),
  mineruApiKey: z.string().optional(),
  mineruApiHost: z.string().optional(),
  semanticChunk: z.boolean().optional(),
  semanticChunkThreshold: z.number().gte(0).lte(1).optional(),
  chunkTokenLimit: z.number().int().gte(0).optional(),
  conflictStrategy: z.enum(['keep', 'replace', 'rename']).optional(),
  urlRefreshHours: z.number().int().gte(0).optional(),
  imageCaptionProvider: z.enum(['off', 'openai', 'ollama']).optional(),
  imageCaptionModel: z.string().optional(),
  imageCaptionBaseUrl: z.string().optional(),
  imageCaptionApiKey: z.string().optional(),
  localModelCacheDir: z.string().optional(),
})

/** Partial runtime config stored in the domain global slot. */
export interface ConfigOverrides {
  embeddingProvider?: KnowledgeConfig['embeddingProvider']
  embeddingBaseUrl?: string
  embeddingModel?: string
  embeddingApiKey?: string
  rerankModel?: string
  rerankBaseUrl?: string
  rerankApiKey?: string
  smartChunk?: boolean
  chunkSeparator?: string
  chunkSize?: number
  chunkOverlap?: number
  topK?: number
  searchMode?: KnowledgeConfig['searchMode']
  similarityThreshold?: number
  mmrDiversity?: number
  rrfVectorWeight?: number
  embeddingBatchSize?: number
  siblingChunks?: number
  hfEndpoint?: string
  documentProcessorProvider?: KnowledgeConfig['documentProcessorProvider']
  mineruApiKey?: string
  mineruApiHost?: string
  semanticChunk?: boolean
  semanticChunkThreshold?: number
  chunkTokenLimit?: number
  conflictStrategy?: 'keep' | 'replace' | 'rename'
  urlRefreshHours?: number
  imageCaptionProvider?: 'off' | 'openai' | 'ollama'
  imageCaptionModel?: string
  imageCaptionBaseUrl?: string
  imageCaptionApiKey?: string
  localModelCacheDir?: string
}

export const knowledgeDomainSpec = defineDomain({
  name: 'knowledge',
  version: 0,
  global: {
    schema: z.object({
      overrides: configOverridesSchema,
      groups: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
      enabledBaseIds: z.array(z.string()).optional(),
    }),
    initial: { overrides: {} as ConfigOverrides, enabled: true, enabledBaseIds: [] as string[] },
  },
  tables: {
    bases: domainTable<string, KnowledgeBase>(baseSchema),
    documents: domainTable<string, KnowledgeDocument>(documentSchema),
  },
})

/** Table names, for the store layer. */
export const TABLES = {
  bases: 'bases',
  documents: 'documents',
  chunks: 'chunks',
} as const
