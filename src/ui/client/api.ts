/**
 * Browser fetch client for the knowledge host service. Same-origin JSON calls
 * against `/knowledge/*`, with local types mirroring the host vocabulary (the
 * client bundle never imports host modules).
 * @module dsh-knowledge/client/api
 */

export type EmbeddingProvider = 'openai' | 'ollama' | 'local' | 'none'
export type SearchMode = 'auto' | 'hybrid' | 'vector' | 'lexical'

export interface BaseConfig {
  embeddingProvider?: EmbeddingProvider
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
  searchMode?: SearchMode
  similarityThreshold?: number
  mmrDiversity?: number
  rrfVectorWeight?: number
  embeddingBatchSize?: number
  siblingChunks?: number
  semanticChunk?: boolean
  semanticChunkThreshold?: number
  chunkTokenLimit?: number
  conflictStrategy?: 'keep' | 'replace' | 'rename'
  urlRefreshHours?: number
  imageCaptionProvider?: 'off' | 'openai' | 'ollama'
  imageCaptionModel?: string
  imageCaptionBaseUrl?: string
  imageCaptionApiKey?: string
}

export interface BaseSummary {
  id: string
  name: string
  description: string
  group?: string
  documentCount: number
  chunkCount: number
  charCount: number
  tokenCount: number
  config?: BaseConfig
  createdAt: number
  updatedAt: number
}

export interface DocumentSummary {
  id: string
  baseId: string
  title: string
  sourceType: 'text' | 'file' | 'url' | 'directory'
  fileName?: string
  url?: string
  parentDirectoryId?: string
  charCount: number
  tokenCount?: number
  chunkCount: number
  childCount?: number
  embedded: boolean
  embeddingError?: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
  indexingProgress?: number
  indexingPhase?: 'parsing' | 'embedding'
  createdAt: number
  updatedAt?: number
}

export interface LocalModelStatus {
  model: string
  status: 'idle' | 'downloading' | 'ready' | 'error'
  progress: number
  message: string
}

export interface ModelSuggestions {
  embedding: string[]
  local: string[]
  rerank: string[]
  /** Ollama registry embedding recommendations (for provider `ollama`). */
  ollamaEmbedding: string[]
  /** Ollama registry vision-model recommendations (for image captioning). */
  ollamaVision: string[]
}

export interface LocalModelSummary {
  id: string
  name: string
  kind: 'embedding'
  subtitle: string
  status: 'ready' | 'not_downloaded' | 'downloading' | 'error'
  progress: number
  message: string
}

export interface ChunkView {
  id: string
  docId: string
  baseId: string
  index: number
  text: string
  heading?: string
  context?: string
}

export interface KnowledgeConfig {
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
  rrfVectorWeight: number
  embeddingBatchSize: number
  semanticChunk: boolean
  semanticChunkThreshold: number
  chunkTokenLimit: number
  conflictStrategy: 'keep' | 'replace' | 'rename'
  urlRefreshHours: number
  imageCaptionProvider: 'off' | 'openai' | 'ollama'
  imageCaptionModel: string
  imageCaptionBaseUrl: string
  imageCaptionApiKey: string
  localModelCacheDir: string
  siblingChunks: number
  hfEndpoint: string
  documentProcessorProvider: 'builtin' | 'mineru'
  mineruApiKey: string
  mineruApiHost: string
}

export interface SearchHit {
  chunkId: string
  docId: string
  baseId: string
  documentTitle: string
  heading?: string
  index: number
  text: string
  siblingContext?: string
  score: number
  vectorScore?: number
  lexicalScore?: number
}

export interface SearchResult {
  query: string
  mode: SearchMode
  total: number
  reranked: boolean
  elapsedMs: number
  hits: SearchHit[]
}

export interface BaseStats {
  baseId?: string
  documentCount: number
  chunkCount: number
  charCount: number
  tokenCount: number
  embedded: boolean
  embeddingDimensions?: number
  staleEmbeddings?: boolean
  staleChunkCount?: number
}

export interface DocumentDetail {
  id: string
  baseId: string
  title: string
  sourceType: 'text' | 'file' | 'url' | 'directory'
  fileName?: string
  url?: string
  rawText?: string
  rawTextTruncated?: boolean
  charCount: number
  tokenCount?: number
  chunkCount: number
  createdAt: number
  chunks?: ChunkView[]
}

export interface DirectoryImportStatus {
  baseId: string
  cancelled: boolean
  imported: number
  skipped: number
  total: number
  current: string
  errors: Array<{ file: string; error: string }>
  done: boolean
}

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

export class KnowledgeApi {
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/knowledge${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    let envelope: Envelope<T>
    try {
      envelope = (await response.json()) as Envelope<T>
    } catch {
      // A gateway/proxy may answer with a non-JSON error page.
      throw new Error(`knowledge request failed (HTTP ${response.status})`)
    }
    if (!response.ok || envelope.ok !== true || envelope.value === undefined) {
      throw new Error(envelope.error?.message ?? `knowledge request failed (HTTP ${response.status})`)
    }
    return envelope.value
  }

  getConfig(): Promise<KnowledgeConfig> {
    return this.call('GET', '/config')
  }

  getLocalModelStatus(model?: string): Promise<LocalModelStatus> {
    const query = model !== undefined ? `?model=${encodeURIComponent(model)}` : ''
    return this.call('GET', `/local-model-status${query}`)
  }

  getModelSuggestions(): Promise<ModelSuggestions> {
    return this.call('GET', '/model-suggestions')
  }

  listLocalModels(): Promise<LocalModelSummary[]> {
    return this.call('GET', '/local-models')
  }

  downloadLocalModel(id: string): Promise<LocalModelSummary> {
    return this.call('POST', `/local-models/download?model=${encodeURIComponent(id)}`)
  }

  cancelLocalModel(id: string): Promise<LocalModelSummary> {
    return this.call('POST', `/local-models/cancel?model=${encodeURIComponent(id)}`)
  }

  removeLocalModel(id: string): Promise<LocalModelSummary> {
    return this.call('DELETE', `/local-models/remove?model=${encodeURIComponent(id)}`)
  }

  getOcrStatus(): Promise<{ status: string; progress: number; message: string }> {
    return this.call('GET', '/local-ocr')
  }

  downloadOcr(): Promise<{ status: string; progress: number; message: string }> {
    return this.call('POST', '/local-ocr/download', {})
  }

  removeOcr(): Promise<{ deleted: boolean }> {
    return this.call('DELETE', '/local-ocr/remove')
  }

  migrateLocalModels(to: string): Promise<{ moved: number; from: string; to: string }> {
    return this.call('POST', '/local-models/migrate', { to })
  }

  listOllamaModels(baseUrl: string): Promise<{ models: string[] }> {
    return this.call('GET', `/local-ollama/tags?baseUrl=${encodeURIComponent(baseUrl)}`)
  }

  pullOllamaModel(model: string, baseUrl: string): Promise<{ started: boolean }> {
    return this.call('POST', '/local-ollama/pull', { model, baseUrl })
  }

  getOllamaPullStatus(model: string): Promise<{ status: string; progress: number; message: string }> {
    return this.call('GET', `/local-ollama/status?model=${encodeURIComponent(model)}`)
  }

  setConfig(overrides: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> {
    return this.call('PUT', '/config', overrides)
  }

  listBases(): Promise<BaseSummary[]> {
    return this.call('GET', '/bases')
  }

  createBase(name: string, description: string, group: string, config?: BaseConfig): Promise<{ id: string; name: string }> {
    return this.call('POST', '/bases', { name, description, group, config })
  }

  updateBase(id: string, patch: { name?: string; description?: string; group?: string; config?: BaseConfig }): Promise<{ id: string; name: string }> {
    return this.call('PATCH', `/bases/${encodeURIComponent(id)}`, patch)
  }

  deleteBase(id: string): Promise<{ deleted: boolean }> {
    return this.call('DELETE', `/bases/${encodeURIComponent(id)}`)
  }

  listGroups(): Promise<string[]> {
    return this.call('GET', '/groups')
  }

  createGroup(name: string): Promise<string[]> {
    return this.call('POST', '/groups', { name })
  }

  renameGroup(from: string, to: string): Promise<string[]> {
    return this.call('PATCH', '/groups', { from, to })
  }

  deleteGroup(name: string): Promise<{ deleted: boolean }> {
    return this.call('DELETE', '/groups', { name })
  }

  getKnowledgeToggle(): Promise<{ enabled: boolean; enabledBaseIds: string[] }> {
    return this.call('GET', '/knowledge-toggle')
  }

  setKnowledgeToggle(patch: { enabled?: boolean; enabledBaseIds?: string[] }): Promise<{ enabled: boolean; enabledBaseIds: string[] }> {
    return this.call('PUT', '/knowledge-toggle', patch)
  }

  stats(baseId?: string): Promise<BaseStats> {
    return this.call('GET', baseId !== undefined ? `/bases/${encodeURIComponent(baseId)}/stats` : '/stats')
  }

  startReindexBase(baseId: string): Promise<{ jobId: string; total: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/reindex`)
  }

  restoreBase(baseId: string, name: string): Promise<{ id: string; name: string }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/restore`, { name })
  }

  getReindexJob(jobId: string): Promise<DirectoryImportStatus> {
    return this.call('GET', `/reindex/${encodeURIComponent(jobId)}`)
  }

  cancelReindexJob(jobId: string): Promise<{ cancelled: boolean }> {
    return this.call('POST', `/reindex/${encodeURIComponent(jobId)}/cancel`)
  }

  listDocuments(baseId: string): Promise<DocumentSummary[]> {
    return this.call('GET', `/bases/${encodeURIComponent(baseId)}/documents`)
  }

  addTextDocument(baseId: string, title: string, content: string): Promise<{ id: string; title: string; chunkCount: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/documents`, { baseId, title, content })
  }

  addFileDocument(
    baseId: string,
    fileName: string,
    mimeType: string,
    contentBase64: string,
    conflict?: 'keep' | 'replace' | 'rename' | 'detect',
    parentDirectoryId?: string,
  ): Promise<{ id: string; title: string; chunkCount: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/documents`, {
      baseId, fileName, mimeType, contentBase64, conflict,
      ...(parentDirectoryId !== undefined ? { parentDirectoryId } : {}),
    })
  }

  createDirectory(baseId: string, title: string, parentDirectoryId?: string): Promise<{ id: string; title: string }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/directories`, {
      baseId, title,
      ...(parentDirectoryId !== undefined ? { parentDirectoryId } : {}),
    })
  }

  addUrlDocument(baseId: string, url: string): Promise<{ id: string; title: string; chunkCount: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/documents`, { baseId, url })
  }

  startDirectoryImport(baseId: string, path: string): Promise<{ jobId: string; total: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/import-directory`, { baseId, path })
  }

  importDirectoryTree(baseId: string, path: string): Promise<{ imported: number; directories: number; errors: Array<{ file: string; error: string }> }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/import-directory-tree`, { baseId, path })
  }

  getDirectoryImport(jobId: string): Promise<DirectoryImportStatus> {
    return this.call('GET', `/import-directory/${encodeURIComponent(jobId)}`)
  }

  cancelDirectoryImport(jobId: string): Promise<{ cancelled: boolean }> {
    return this.call('POST', `/import-directory/${encodeURIComponent(jobId)}/cancel`)
  }

  getIndexingStatus(): Promise<Array<{ docId: string; baseId: string; title: string; phase: 'parsing' | 'embedding'; progress: number }>> {
    return this.call('GET', '/indexing-status')
  }

  getDocument(documentId: string, opts?: { rawTextLimit?: number }): Promise<DocumentDetail> {
    const query = opts?.rawTextLimit !== undefined
      ? `?rawTextLimit=${encodeURIComponent(String(opts.rawTextLimit))}&includeChunks=false`
      : ''
    return this.call('GET', `/documents/${encodeURIComponent(documentId)}${query}`)
  }

  renameDocument(documentId: string, title: string): Promise<{ id: string; title: string }> {
    return this.call('PATCH', `/documents/${encodeURIComponent(documentId)}`, { title })
  }

  reindexDocument(documentId: string): Promise<{ id: string; chunkCount: number }> {
    return this.call('POST', `/documents/${encodeURIComponent(documentId)}/reindex`)
  }

  refreshUrlDocument(documentId: string): Promise<{ changed: boolean; title: string; chunkCount: number }> {
    return this.call('POST', `/documents/${encodeURIComponent(documentId)}/refresh`)
  }

  reindexDocuments(ids: string[]): Promise<{ reindexed: number; skipped: number }> {
    return this.call('POST', '/documents/reindex', { ids })
  }

  deleteDocument(id: string): Promise<{ deleted: boolean }> {
    return this.call('DELETE', `/documents/${encodeURIComponent(id)}`)
  }

  deleteDocuments(ids: string[]): Promise<{ deleted: number }> {
    return this.call('DELETE', '/documents', { ids })
  }

  listChunks(documentId: string, limit?: number): Promise<ChunkView[]> {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : ''
    return this.call('GET', `/documents/${encodeURIComponent(documentId)}/chunks${query}`)
  }

  search(request: {
    query: string
    baseId?: string
    topK?: number
    mode?: SearchMode
    threshold?: number
    filter?: {
      docIds?: string[]
      titleIncludes?: string
      sourceTypes?: string[]
      updatedAfter?: number
      updatedBefore?: number
    }
  }): Promise<SearchResult> {
    return this.call('POST', '/search', request)
  }
}
