/**
 * Public data vocabulary for dsh-knowledge. Every value here is plain,
 * JSON-serializable data — never a Cordis/DSH live object — so it can cross
 * the HTTP boundary and be stored durably.
 * @module dsh-knowledge/knowledge/types
 */

/** Supported embedding backends. `local` runs in-process (transformers.js); `none` keeps the base lexical-only. */
export type EmbeddingProvider = 'openai' | 'ollama' | 'local' | 'none'

/** Search strategy. `auto` picks hybrid when vectors exist, else lexical. */
export type SearchMode = 'auto' | 'hybrid' | 'vector' | 'lexical'

/** Per-base configuration overrides (Cherry Studio: every base picks its own model). */
export interface BaseConfig {
  readonly embeddingProvider?: EmbeddingProvider
  readonly embeddingBaseUrl?: string
  readonly embeddingModel?: string
  readonly embeddingApiKey?: string
  readonly rerankModel?: string
  readonly rerankBaseUrl?: string
  readonly rerankApiKey?: string
  readonly smartChunk?: boolean
  readonly chunkSeparator?: string
  readonly chunkSize?: number
  readonly chunkOverlap?: number
  readonly topK?: number
  readonly searchMode?: SearchMode
  readonly similarityThreshold?: number
  readonly mmrDiversity?: number
  /** Relative weight of the vector lane in RRF hybrid fusion (0.1–5, 1 = balanced). */
  readonly rrfVectorWeight?: number
  readonly embeddingBatchSize?: number
  /** How many neighbouring chunks (±) to attach to each search hit as context (0–3, 0 = off). */
  readonly siblingChunks?: number
  readonly documentProcessorProvider?: 'builtin' | 'mineru'
  readonly mineruApiKey?: string
  readonly mineruApiHost?: string
  readonly semanticChunk?: boolean
  readonly semanticChunkThreshold?: number
  readonly chunkTokenLimit?: number
}

/** One knowledge base (a namespace of documents). */
export interface KnowledgeBase {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Knowledge base group (Cherry Studio's 分组), empty = ungrouped. */
  readonly group?: string
  /** Per-base config overrides, merged over the global config for this base. */
  readonly config?: BaseConfig
  readonly createdAt: number
  readonly updatedAt: number
}

/** Where a document's text came from. `directory` is a container of child items. */
export type DocumentSourceType = 'text' | 'file' | 'url' | 'directory'

/** One imported document inside a knowledge base. */
export interface KnowledgeDocument {
  readonly id: string
  readonly baseId: string
  readonly title: string
  readonly sourceType: DocumentSourceType
  readonly fileName?: string
  readonly mimeType?: string
  /** Origin URL for sourceType 'url'. */
  readonly url?: string
  /** Parent directory id, when this item lives inside a `directory` container. */
  readonly parentDirectoryId?: string
  /** SHA-256 of the source text, for duplicate detection. */
  readonly contentHash?: string
  /**
   * Base-relative path of the document's original source bytes in the raw
   * store (`<baseId>/<docId><ext>`, under `<chunkStoreDir>/knowledge-raw`).
   * Present for file documents whose bytes were persisted at import; reindex
   * re-reads and re-parses this source instead of only reusing rawText.
   */
  readonly rawFilePath?: string
  /** Original source text, retained so the document can be re-chunked. */
  readonly rawText?: string
  /** Raw character count of the source text (before chunking). */
  readonly charCount: number
  /** Estimated token count of the source text. */
  readonly tokenCount?: number
  /** Number of chunks produced at import time. */
  readonly chunkCount: number
  /**
   * True while the document is being indexed (placeholder → mid-embedding).
   * A crash leaves `incomplete: true` + rawText, so startup recovery can
   * resume the interrupted embed instead of dropping the document.
   */
  readonly incomplete?: boolean
  /** Reason embedding failed at import/reindex time, when it degraded to lexical-only. */
  readonly embeddingError?: string
  readonly createdAt: number
  readonly updatedAt?: number
}

/** One chunk of a document, with its optional embedding vector. */
export interface KnowledgeChunk {
  readonly id: string
  readonly docId: string
  readonly baseId: string
  readonly index: number
  /** The chunk's own text (no injected context). */
  readonly text: string
  /** Markdown heading path introducing this chunk, e.g. "Section > Sub". */
  readonly heading?: string
  /** Retrieval context injected for embedding/search (title + heading). */
  readonly context?: string
  /** L2-normalized embedding, when one was produced at import time. */
  readonly embedding?: number[]
  /** Embedding source key (`provider:model`) that produced {@link embedding}. */
  readonly embeddingModel?: string
}

/** The resolved, user-visible knowledge configuration. */
export interface KnowledgeConfig {
  readonly embeddingProvider: EmbeddingProvider
  readonly embeddingBaseUrl: string
  readonly embeddingModel: string
  readonly embeddingApiKey: string
  /** Optional rerank model (empty = disabled), Cherry Studio style. */
  readonly rerankModel: string
  readonly rerankBaseUrl: string
  readonly rerankApiKey: string
  /** Heading-aware chunking (Cherry Studio's 智能分段); off = delimiter-only. */
  readonly smartChunk: boolean
  /** Chunk boundary separator when smartChunk is off. */
  readonly chunkSeparator: string
  readonly chunkSize: number
  readonly chunkOverlap: number
  readonly topK: number
  readonly searchMode: SearchMode
  readonly similarityThreshold: number
  readonly mmrDiversity: number
  /** Relative weight of the vector lane in RRF hybrid fusion (0.1–5, 1 = balanced). */
  readonly rrfVectorWeight: number
  readonly embeddingBatchSize: number
  /** How many neighbouring chunks (±) to attach to each search hit as context (0–3, 0 = off). */
  readonly siblingChunks: number
  /** Hugging Face endpoint override (mirror); empty = official hub / `HF_ENDPOINT` env. */
  readonly hfEndpoint: string
  /** Document processor: `builtin` (local parsers + OCR) or `mineru` (remote MinerU API). */
  readonly documentProcessorProvider: 'builtin' | 'mineru'
  /** MinerU API key (required when provider is `mineru`). */
  readonly mineruApiKey: string
  /** MinerU API host; empty = https://mineru.net */
  readonly mineruApiHost: string
  /** Semantic chunking: embed paragraph-level segments and merge similar adjacent ones. */
  readonly semanticChunk: boolean
  /** Cosine threshold below which adjacent segments start a new chunk (0–1). */
  readonly semanticChunkThreshold: number
  /** Token budget per chunk (0 = off); oversized chunks split at preferred boundaries. */
  readonly chunkTokenLimit: number
}

/** One ranked search result. */
export interface SearchHit {
  readonly chunkId: string
  readonly docId: string
  readonly baseId: string
  readonly documentTitle: string
  readonly heading?: string
  readonly index: number
  readonly text: string
  /** Surrounding chunks (±`siblingChunks`) of the hit, concatenated as
   *  context — the full paragraph the hit sits in. Empty when the document
   *  has no neighbours or sibling context is disabled. */
  readonly siblingContext?: string
  readonly score: number
  readonly vectorScore?: number
  readonly lexicalScore?: number
}

/** Summary of one document, for listing UIs. */
export interface DocumentSummary {
  readonly id: string
  readonly baseId: string
  readonly title: string
  readonly sourceType: DocumentSourceType
  readonly fileName?: string
  readonly url?: string
  readonly parentDirectoryId?: string
  readonly charCount: number
  readonly tokenCount?: number
  readonly chunkCount: number
  /** For `directory` items: number of direct child items. */
  readonly childCount?: number
  /** True when every chunk carries a vector (false for lexical-only content). */
  readonly embedded: boolean
  /** Reason embedding failed, when the document is lexical-only due to an error. */
  readonly embeddingError?: string
  /** Live indexing state: `pending` (not yet embedded), `processing` (embedding now),
   *  `completed` (vectors ready), or `failed` (embedding errored). */
  readonly status?: 'pending' | 'processing' | 'completed' | 'failed'
  /** 0–100 embedding progress while `status === 'processing'`. */
  readonly indexingProgress?: number
  /** Current processing phase when `status === 'processing'`. */
  readonly indexingPhase?: 'parsing' | 'embedding'
  readonly createdAt: number
  readonly updatedAt?: number
}

/** Summary of one knowledge base, for listing UIs. */
export interface BaseSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly group?: string
  readonly documentCount: number
  readonly chunkCount: number
  readonly charCount: number
  readonly tokenCount: number
  readonly config?: BaseConfig
  readonly createdAt: number
  readonly updatedAt: number
}

/** Aggregate statistics for one base (or all bases). */
export interface BaseStats {
  readonly baseId?: string
  readonly documentCount: number
  readonly chunkCount: number
  readonly charCount: number
  readonly tokenCount: number
  /** Whether the base's chunks carry embeddings. */
  readonly embedded: boolean
  readonly embeddingDimensions?: number
  /** True when some embedded chunks were produced by a different embedding model than the one now configured. */
  readonly staleEmbeddings?: boolean
  /** Number of embedded chunks whose model differs from the current configuration. */
  readonly staleChunkCount?: number
}

/** Full document view: metadata, raw text, and every chunk. */
export interface DocumentDetail {
  readonly id: string
  readonly baseId: string
  readonly title: string
  readonly sourceType: DocumentSourceType
  readonly fileName?: string
  readonly url?: string
  /** Base-relative path of the persisted original source bytes (file docs). */
  readonly rawFilePath?: string
  readonly rawText?: string
  /** True when `rawText` was capped to `rawTextLimit` to keep the payload bounded. */
  readonly rawTextTruncated?: boolean
  readonly charCount: number
  readonly tokenCount?: number
  readonly chunkCount: number
  readonly createdAt: number
  /** Omitted when the caller requests a lightweight view (`includeChunks: false`). */
  readonly chunks?: KnowledgeChunk[]
}

/** Payload for creating a knowledge base. */
export interface CreateBaseRequest {
  readonly name: string
  readonly description?: string
  readonly group?: string
  readonly config?: BaseConfig
}

/** Payload for updating a knowledge base (name, description, group, per-base config). */
export interface UpdateBaseRequest {
  readonly name?: string
  readonly description?: string
  readonly group?: string
  readonly config?: BaseConfig
}

/** Payload for adding a document from raw text. */
export interface AddTextDocumentRequest {
  readonly baseId: string
  readonly title: string
  readonly content: string
}

/** Payload for adding a document from an uploaded file (base64 content). */
export interface AddFileDocumentRequest {
  readonly baseId: string
  readonly title?: string
  readonly fileName: string
  readonly mimeType?: string
  /** Base64-encoded file bytes. */
  readonly contentBase64: string
  /** Same-name conflict handling: keep both (default) or replace the existing entry. */
  readonly conflict?: 'keep' | 'replace'
  /** Parent directory id, when this file lives inside a directory container. */
  readonly parentDirectoryId?: string
}

/** Payload for importing a local directory (every supported file becomes an entry). */
export interface ImportDirectoryRequest {
  readonly baseId: string
  readonly path: string
}

/** Payload for importing a document from a URL. */
export interface ImportUrlRequest {
  readonly baseId: string
  readonly url: string
  readonly title?: string
}

/** Metadata filters narrowing a search to a subset of documents (all optional, ANDed). */
export interface SearchFilter {
  /** Restrict to these document ids. */
  readonly docIds?: readonly string[]
  /** Case-insensitive substring match on the document title. */
  readonly titleIncludes?: string
  /** Restrict to these source types (file / text / url / directory). */
  readonly sourceTypes?: readonly DocumentSourceType[]
  /** Only documents updated at or after this epoch millisecond. */
  readonly updatedAfter?: number
  /** Only documents updated at or before this epoch millisecond. */
  readonly updatedBefore?: number
}

/** Payload for a search. */
export interface SearchRequest {
  readonly query: string
  readonly baseId?: string
  /** Search only these bases (omitted baseId + empty/absent baseIds = every base). */
  readonly baseIds?: readonly string[]
  readonly topK?: number
  readonly mode?: SearchMode
  readonly threshold?: number
  readonly mmr?: boolean
  /** Metadata filters narrowing the search to a subset of documents. */
  readonly filter?: SearchFilter
}

/** Result of a search. */
export interface SearchResult {
  readonly query: string
  readonly mode: SearchMode
  readonly total: number
  readonly reranked: boolean
  readonly elapsedMs: number
  readonly hits: SearchHit[]
}
