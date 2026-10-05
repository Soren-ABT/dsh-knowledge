/**
 * Browser fetch client for the knowledge host service. Same-origin JSON calls
 * against `/knowledge/*`, with local types mirroring the host vocabulary (the
 * client bundle never imports host modules).
 * @module dsh-knowledge/client/api
 */

import type { DocumentProcessingInfo, DocumentSourceSpan, MineruTier, ParsedAsset, ParsedBlock, ProcessingProgress, ProcessorCapabilities } from '../../knowledge/processing-types.js'
import type { MineruDeploymentPlan, MineruDeploymentStatus, MineruPythonDiscovery, MineruPythonEnvironment } from '../../knowledge/mineru-deployment-types.js'
export type { MineruDeploymentPlan, MineruDeploymentStatus, MineruPythonDiscovery, MineruPythonEnvironment }
export type { DocumentProcessingInfo, DocumentSourceSpan, MineruTier, ParsedAsset, ParsedBlock, ProcessingProgress, ProcessorCapabilities }

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
  localRerankTimeoutMs?: number
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
  documentProcessorProvider?: 'builtin' | 'mineru' | 'mineru-local'
  mineruApiKey?: string
  mineruApiHost?: string
  mineruLocalUrl?: string
  mineruLocalApiKey?: string
  mineruTier?: MineruTier
  documentProcessingTimeoutMs?: number
  structuredChunking?: boolean
  semanticChunk?: boolean
  semanticChunkThreshold?: number
  chunkTokenLimit?: number
  conflictStrategy?: 'keep' | 'replace' | 'rename'
  urlRefreshHours?: number
  imageCaptionProvider?: 'off' | 'openai' | 'ollama'
  imageCaptionModel?: string
  imageCaptionBaseUrl?: string
  imageCaptionApiKey?: string
  autoRetrieve?: boolean
  injectUsagePrompt?: boolean
  autoRetrieveWeight?: number
  resumeInterruptedOnStartup?: boolean
}

/** One origin line for a base: where its content came from (shown under the
 *  base name in the detail header — path for directories/files, link for URLs,
 *  "node" for manually added text). */
export interface BaseSourceInfo {
  /** Top-level document/container that owns this source. */
  sourceId: string
  kind: 'text' | 'file' | 'url' | 'directory'
  /** Directory path / file name / URL / 'node'. */
  text: string
  /** Absolute tracked path when this source can be repointed. */
  sourcePath?: string
}

export interface BaseSummary {
  id: string
  name: string
  description: string
  group?: string
  documentCount: number
  /** Documents with a persisted raw source copy (actually imported & stored). */
  storedDocCount: number
  chunkCount: number
  charCount: number
  tokenCount: number
  config?: BaseConfig
  /** Top-level sources of the base's content, for display (bounded). */
  sourceInfo?: BaseSourceInfo[]
  createdAt: number
  updatedAt: number
}

/** One itemized outcome of a directory synchronization, mirroring the host. */
export interface DirectorySyncItem {
  relativePath: string
  kind: 'file' | 'directory'
  documentId?: string
  action: 'created' | 'updated' | 'unchanged' | 'deleted' | 'failed'
  error?: { code: string; message: string }
}

/** The truthful aggregate a directory import or rescan returns. */
export interface DirectorySyncResult {
  sourceId: string
  status: 'synced' | 'unchanged' | 'partial'
  created: number
  updated: number
  unchanged: number
  deleted: number
  failed: number
  items: DirectorySyncItem[]
}

/** Read-only preview of what one delete would remove. The panel fetches this
 *  before a destructive call so a cascading directory delete is never silent. */
export interface DeleteImpact {
  documentId: string
  baseId: string
  directories: number
  files: number
  chunks: number
  rawSnapshots: number
  /** True only when the target is a non-empty directory that needs an explicit
   *  recursive confirmation before the host will accept the delete. */
  requiresRecursive: boolean
}

export interface DocumentSummary {
  id: string
  baseId: string
  title: string
  sourceType: 'text' | 'file' | 'url' | 'directory'
  fileName?: string
  url?: string
  parentDirectoryId?: string
  /** Absolute tracked path for a local-path source (administrative view only). */
  sourcePath?: string
  charCount: number
  tokenCount?: number
  chunkCount: number
  childCount?: number
  embedded: boolean
  embeddingError?: string
  errorCode?: 'interrupted' | 'dimension_mismatch' | 'parse_failed' | 'embedding_provider'
  status?: 'pending' | 'processing' | 'completed' | 'failed'
  indexingProgress?: number
  indexingPhase?: 'parsing' | 'embedding'
  processing?: DocumentProcessingInfo
  processingProgress?: ProcessingProgress
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
  kind: 'embedding' | 'reranking'
  support?: 'official' | 'experimental'
  subtitle: string
  status: 'ready' | 'not_downloaded' | 'downloading' | 'validating' | 'unhealthy' | 'error'
  health: 'unchecked' | 'checking' | 'healthy' | 'unhealthy'
  progress: number
  message: string
  lastCheckedAt?: number
  latencyMs?: number
}

export interface ChunkView {
  id: string
  docId: string
  baseId: string
  index: number
  text: string
  heading?: string
  context?: string
  sourceSpans?: readonly DocumentSourceSpan[]
}

export interface KnowledgeConfig {
  embeddingProvider: EmbeddingProvider
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKey: string
  rerankModel: string
  rerankBaseUrl: string
  rerankApiKey: string
  localRerankTimeoutMs: number
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
  mineruPythonIndexUrl?: string
  documentProcessorProvider: 'builtin' | 'mineru' | 'mineru-local'
  mineruApiKey: string
  mineruApiHost: string
  mineruLocalUrl?: string
  mineruLocalApiKey?: string
  mineruTier?: MineruTier
  documentProcessingTimeoutMs?: number
  structuredChunking?: boolean
  resumeInterruptedOnStartup: boolean
  autoRetrieve: boolean
  injectUsagePrompt?: boolean
  autoRetrieveWeight: number
  /** Local-model worker idle timeout in ms (0 = never release; keeps the
   *  model hot and avoids an onnxruntime binding reload on respawn). */
  localWorkerIdleTimeoutMs: number
}

export interface SearchHit {
  chunkId: string
  docId: string
  baseId: string
  documentTitle: string
  heading?: string
  index: number
  text: string
  /** Ordered, token-bounded evidence around the canonical hit. Optional for
   * compatibility with 0.3.7 servers and persisted responses. */
  contextWindow?: ContextWindow
  /** @deprecated Prefer contextWindow; retained throughout 0.3.x. */
  siblingContext?: string
  score: number
  vectorScore?: number
  lexicalScore?: number
  sourceSpans?: readonly DocumentSourceSpan[]
}

export interface ContextChunkExcerpt {
  chunkId: string
  index: number
  heading?: string
  text: string
  /** UTF-16 offsets relative to this chunk's canonical text. */
  textStart: number
  textEnd: number
  truncatedStart: boolean
  truncatedEnd: boolean
  sourceSpans?: readonly DocumentSourceSpan[]
}

export interface ContextWindow {
  anchorChunkId: string
  anchorIndex: number
  before: ContextChunkExcerpt[]
  anchor: ContextChunkExcerpt
  after: ContextChunkExcerpt[]
  estimatedTokens: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export interface SearchResult {
  query: string
  mode: SearchMode
  scoreKind?: 'lexical_relevance' | 'vector_similarity' | 'rrf' | 'rerank'
  retrieval?: {
    requestedMode: SearchMode
    effectiveMode: SearchMode
    lexical: { attempted: boolean; succeeded: boolean; returnedCount: number; errorCode?: string }
    vector: { attempted: boolean; succeeded: boolean; returnedCount: number; errorCode?: string }
  }
  total: number
  reranked: boolean
  rerank?: RerankStatus
  elapsedMs: number
  hits: SearchHit[]
}

export interface RerankStatus {
  configured: true
  provider: 'local' | 'remote'
  model: string
  status: 'applied' | 'not_needed' | 'skipped' | 'degraded'
  attempted: boolean
  applied: boolean
  candidateCount: number
  elapsedMs?: number
  error?: {
    code: 'model_not_downloaded' | 'model_checking' | 'model_unhealthy' | 'unsupported_model' | 'timeout' | 'invalid_response' | 'runtime_error' | 'process_crash' | 'circuit_open' | 'busy' | 'provider_error'
    message: string
    retryable: boolean
    action?: 'download_model' | 'run_self_test' | 'check_config' | 'retry_later'
  }
}

export interface BaseStats {
  baseId?: string
  documentCount: number
  /** Documents with a persisted raw source copy (actually imported & stored). */
  storedDocCount: number
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
  processing?: DocumentProcessingInfo
}

export interface DocumentEvidence {
  documentId: string
  title: string
  processing?: DocumentProcessingInfo
  blocks: ParsedBlock[]
  assets: ParsedAsset[]
  estimatedTokens: number
  truncated: boolean
  next?: { blockId: string; blockOffset: number }
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
  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const response = await fetch(`/knowledge${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(path.startsWith('/processors/managed/') ? { 'x-dsh-mineru-management': '1' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // A hung host must not pin the panel's busy state forever: fail the
      // call with a clear error instead of an indefinite spinner. Long-running
      // jobs (reindex of a whole base) pass a larger budget so a slow sweep is
      // not cut short while the server is still working.
      signal: AbortSignal.timeout(timeoutMs),
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

  planMineruDeployment(root: string, existingModels?: string, pythonExecutable?: string): Promise<MineruDeploymentPlan> {
    return this.call('POST', '/processors/managed/plan', { root, existingModels, pythonExecutable }, 310_000)
  }
  detectMineruPython(executable?: string): Promise<MineruPythonDiscovery> { return this.call('POST', '/processors/managed/python', { executable }, 70_000) }

  mineruDeploymentStatus(): Promise<MineruDeploymentStatus> { return this.call('GET', '/processors/managed/status') }
  prepareMineruDeployment(planId: string): Promise<MineruDeploymentStatus> { return this.call('POST', '/processors/managed/prepare', { planId, confirm: true }) }
  mineruDeploymentAction(action: 'start' | 'stop' | 'cancel'): Promise<MineruDeploymentStatus> { return this.call('POST', `/processors/managed/${action}`, {}) }
  useManagedMineru(): Promise<{ applied: boolean }> { return this.call('POST', '/processors/managed/use', {}) }

  checkProcessor(baseId?: string): Promise<ProcessorCapabilities> {
    return this.call('POST', '/processors/check', baseId === undefined ? {} : { baseId })
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

  registerCustomLocalReranker(id: string): Promise<LocalModelSummary> {
    return this.call('POST', '/local-models/custom', { id })
  }

  selfTestLocalModel(id: string): Promise<LocalModelSummary> {
    return this.call('POST', '/local-models/self-test', { id })
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

  /** Prepare the selected/default cache directory without saving or moving models. */
  prepareLocalModelCacheDirectory(path = ''): Promise<{ path: string }> {
    return this.call('POST', '/local-models/cache-directory', { path })
  }

  listOllamaModels(baseUrl: string): Promise<{ models: Array<{ name: string; size?: number }> }> {
    return this.call('GET', `/local-ollama/tags?baseUrl=${encodeURIComponent(baseUrl)}`)
  }

  pullOllamaModel(model: string, baseUrl: string): Promise<{ started: boolean }> {
    return this.call('POST', '/local-ollama/pull', { model, baseUrl })
  }

  cancelOllamaPull(model: string): Promise<{ cancelled: boolean }> {
    return this.call('DELETE', `/local-ollama/pull?model=${encodeURIComponent(model)}`)
  }

  deleteOllamaModel(model: string, baseUrl: string): Promise<{ deleted: boolean }> {
    return this.call('DELETE', '/local-ollama/delete', { model, baseUrl })
  }

  getOllamaPullStatus(model: string): Promise<{ status: string; progress: number; message: string }> {
    return this.call('GET', `/local-ollama/status?model=${encodeURIComponent(model)}`)
  }

  /** In-flight pulls, so the settings panel restores its cards after close/reopen. */
  listActiveOllamaPulls(): Promise<{ pulls: Array<{ model: string; status: string; progress: number; message: string }> }> {
    return this.call('GET', '/local-ollama/pulls')
  }

  setConfig(overrides: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> {
    return this.call('PUT', '/config', overrides)
  }

  /**
   * Embed one probe text through the given (or current) embedding config and
   * return the vector width (Cherry's dimension probe, run before a save).
   */
  probeEmbeddingDimensions(options: {
    provider?: EmbeddingProvider
    baseUrl?: string
    model?: string
    apiKey?: string
  } = {}): Promise<number> {
    return this.call('POST', '/probe-embedding-dimensions', options)
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

  /**
   * Batch file add with server-authoritative conflict detection: 'detect'
   * returns {status:'conflicts'} listing every collision (or 'clean'), and
   * 'rename'/'replace' add the whole batch under that strategy.
   */
  addFiles(
    baseId: string,
    files: Array<{ fileName: string; mimeType?: string; contentBase64?: string }>,
    conflict: 'detect' | 'rename' | 'replace',
    parentDirectoryId?: string,
  ): Promise<
    { status: 'conflicts'; conflicts: string[] }
    | { status: 'clean' }
    | { status: 'added'; accepted: Array<{ id: string; title: string; fileName: string; skipped?: boolean }> }
  > {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/files-batch`, { files, conflict, parentDirectoryId })
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

  restoreBase(baseId: string, name: string, config?: BaseConfig): Promise<{ id: string; name: string }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/restore`, { name, config })
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

  addTextDocument(baseId: string, title: string, content: string, parentDirectoryId?: string): Promise<{ id: string; title: string; chunkCount: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/documents`, {
      baseId, title, content,
      ...(parentDirectoryId !== undefined ? { parentDirectoryId } : {}),
    })
  }

  addFileDocument(
    baseId: string,
    fileName: string,
    mimeType: string,
    contentBase64: string,
    conflict?: 'keep' | 'replace' | 'rename' | 'detect',
    parentDirectoryId?: string,
  ): Promise<{ id: string; title: string; chunkCount: number; skipped?: boolean }> {
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

  addUrlDocument(baseId: string, url: string, parentDirectoryId?: string): Promise<{ id: string; title: string; chunkCount: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/documents`, {
      baseId, url,
      ...(parentDirectoryId !== undefined ? { parentDirectoryId } : {}),
    })
  }

  startDirectoryImport(baseId: string, path: string): Promise<{ jobId: string; total: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/import-directory`, { baseId, path })
  }

  importDirectoryTree(baseId: string, path: string): Promise<{
    imported: number
    directories: number
    errors: Array<{ file: string; error: string }>
    sourceId: string
    mode: 'created' | 'synced'
    sync: DirectorySyncResult
  }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/import-directory-tree`, { baseId, path })
  }

  /** Import a local directory or single file by its absolute path (validated server-side). */
  importFromPath(baseId: string, path: string): Promise<{
    kind: 'directory' | 'file'
    imported: number
    errors: Array<{ file: string; error: string }>
    directories?: number
    sourceId?: string
    mode?: 'created' | 'synced'
    sync?: DirectorySyncResult
  }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/import-path`, { baseId, path }, 30 * 60_000)
  }

  /** Repoint the base's source path (validated server-side). */
  setBaseSourcePath(baseId: string, sourceId: string, path: string): Promise<{ set: number }> {
    return this.call('POST', `/bases/${encodeURIComponent(baseId)}/source-path`, { baseId, sourceId, path })
  }

  getDirectoryImport(jobId: string): Promise<DirectoryImportStatus> {
    return this.call('GET', `/import-directory/${encodeURIComponent(jobId)}`)
  }

  cancelDirectoryImport(jobId: string): Promise<{ cancelled: boolean }> {
    return this.call('POST', `/import-directory/${encodeURIComponent(jobId)}/cancel`)
  }

  getIndexingStatus(): Promise<Array<{
    docId: string
    baseId: string
    title: string
    phase: 'parsing' | 'embedding'
    progress: number
    status?: 'running' | 'failed'
    processingProgress?: ProcessingProgress
    error?: { code: string; message: string }
  }>> {
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

  reindexDocument(documentId: string, mode?: 'reparse' | 'rechunk'): Promise<{ id: string; chunkCount: number; sync?: DirectorySyncResult }> {
    return this.call('POST', `/documents/${encodeURIComponent(documentId)}/reindex`, mode === undefined ? undefined : { mode }, 2 * 60 * 60_000 + 30_000)
  }

  cancelProcessing(documentId: string): Promise<{ cancelled: boolean }> {
    return this.call('POST', `/documents/${encodeURIComponent(documentId)}/cancel`)
  }

  readDocumentEvidence(documentId: string, options: { revision?: string; pageIndex?: number; blockId?: string; blockOffset?: number; maxTokens?: number } = {}): Promise<DocumentEvidence> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value))
    return this.call('GET', `/documents/${encodeURIComponent(documentId)}/evidence?${params}`)
  }

  refreshUrlDocument(documentId: string): Promise<{ changed: boolean; title: string; chunkCount: number }> {
    return this.call('POST', `/documents/${encodeURIComponent(documentId)}/refresh`)
  }

  reindexDocuments(ids: string[]): Promise<{ reindexed: number; skipped: number; failed: number; items: DirectorySyncItem[] }> {
    return this.call('POST', '/documents/reindex', { ids }, 30 * 60_000)
  }

  /** Preview the subtree and durable snapshots a delete would remove. */
  getDeleteImpact(documentId: string): Promise<DeleteImpact> {
    return this.call('GET', `/documents/${encodeURIComponent(documentId)}/delete-impact`)
  }

  deleteDocument(id: string, recursive = false): Promise<{ deleted: boolean }> {
    const query = recursive ? '?recursive=true' : ''
    return this.call('DELETE', `/documents/${encodeURIComponent(id)}${query}`)
  }

  /** Delete a selection. `deleted` is the number of documents removed (including
   *  the descendants of a selected directory); `roots` is the folded count. */
  deleteDocuments(ids: string[], recursive = false): Promise<{ deleted: number; roots: number }> {
    return this.call('DELETE', '/documents', { ids, recursive })
  }

  listChunks(documentId: string, limit?: number): Promise<ChunkView[]> {
    const params = new URLSearchParams()
    if (limit !== undefined) params.set('limit', String(limit))
    // The route returns every stored vector unless told otherwise; the preview
    // never reads them, and they are the bulk of the payload on a large document.
    params.set('includeEmbeddings', 'false')
    return this.call('GET', `/documents/${encodeURIComponent(documentId)}/chunks?${params.toString()}`)
  }

  search(request: {
    query: string
    baseId?: string
    topK?: number
    mode?: SearchMode
    threshold?: number
    filter?: {
      docIds?: string[]
      excludeDocIds?: string[]
      titleIncludes?: string
      titleExcludes?: string[]
      sourceTypes?: string[]
      updatedAfter?: number
      updatedBefore?: number
    }
  }): Promise<SearchResult> {
    return this.call('POST', '/search', request)
  }
}
