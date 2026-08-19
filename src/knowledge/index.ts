/**
 * The host knowledge service (`ctx.knowledge`): durable bases/documents/chunks
 * over `ctx.storageDomain`, heading-aware chunking with context injection,
 * batched embeddings, hybrid retrieval (BM25 + vector + MMR), deduplication,
 * reindexing, URL import, and statistics — plus a JSON HTTP surface.
 * @module dsh-knowledge/knowledge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { chunkText, mergeSemanticSegments, refineChunksByTokenLimit, splitSemanticSegments } from './chunk.js'
import type { ChunkPiece } from './chunk.js'
import { Config, resolveConfig, resolveConfigFor } from './config.js'
import type { ConfigOverrides } from './domain.js'
import { DEFAULT_LOCAL_MODEL, disposeLocalModelWorker, embedTexts, getLocalModelStatus, setHfEndpoint, setLocalModelCacheDir } from './embed.js'
import type { LocalModelStatus } from './embed.js'
import { cancelLocalModelDownload, deleteLocalModel, downloadLocalModel, listLocalModels, LOCAL_MODELS } from './localModels.js'
import type { LocalModelSummary } from './localModels.js'
import { downloadOcrModels, disposeOcrWorker, getOcrModelStatus, removeOcrModels, type OcrModelStatus } from './ocr.js'
import { httpFetch } from './net.js'
import { knowledgeRoute } from './http.js'
import { SUPPORTED_DOCUMENT_EXTENSIONS, extractFromHtml, extensionOf, parseDocumentBuffer } from './parse.js'
import { rank } from './retrieval.js'
import { maximalMarginalRelevance, reciprocalRankFusion, RRF_K } from './retrieval.js'
import type { RankedHit } from './retrieval.js'
import { rerankCandidates } from './rerank.js'
import { hashEmbeddingText } from './chunkdb.js'
import { openStore } from './store.js'
import type { StorageDomainFacility, Store } from './store.js'
import type {
  AddFileDocumentRequest,
  AddTextDocumentRequest,
  BaseConfig,
  BaseStats,
  BaseSummary,
  CreateBaseRequest,
  DocumentDetail,
  DocumentSourceType,
  DocumentSummary,
  ImportDirectoryRequest,
  ImportUrlRequest,
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeConfig,
  KnowledgeDocument,
  SearchHit,
  SearchMode,
  SearchRequest,
  SearchResult,
  UpdateBaseRequest,
} from './types.js'

export type * from './types.js'
export { Config } from './config.js'
export { knowledgeDomainSpec } from './domain.js'
export { chunkText } from './chunk.js'
export { embedTexts, getLocalModelStatus, DEFAULT_LOCAL_MODEL } from './embed.js'
export { tokenize, cosineSimilarity, rank } from './retrieval.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: KnowledgeService
  }
}

/** Curated model-id suggestions for the settings comboboxes (DSH exposes chat models, not embedding models). */
export const MODEL_SUGGESTIONS = {
  embedding: [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'text-embedding-ada-002',
    'bge-m3',
    'bge-large-zh-v1.5',
    'bge-small-zh-v1.5',
    'nomic-embed-text',
    'mxbai-embed-large',
    'snowflake-arctic-embed2',
  ],
  // Local models mirror the shipped registry (localModels.ts) — every entry is
  // a real, downloadable transformers.js ONNX repo with a known pooling rule.
  local: LOCAL_MODELS.map(model => model.id),
  rerank: [
    'jina-reranker-v2-base-multilingual',
    'BAAI/bge-reranker-v2-m3',
    'bge-reranker-base',
    'bce-reranker-base_v1',
    // Local cross-encoder: download it in Settings → Local Models, then use
    // the `local:` prefix (e.g. `local:Xenova/bge-reranker-base`).
    'local:Xenova/bge-reranker-base',
  ],
} as const

/** Candidate-pool cap for SQL retrieval lanes, bounding FTS + brute-force vector scans. */
const LANE_CANDIDATE_CAP = 200

interface BackgroundJob {
  readonly baseId: string
  /** Human label for the unit of work (file name or document title). */
  kind: 'directory' | 'reindex'
  cancelled: boolean
  imported: number
  skipped: number
  total: number
  current: string
  errors: Array<{ file: string; error: string }>
  done: boolean
}

/** Raised by same-name conflict detection (`conflict: 'detect'`); the HTTP
 *  layer maps it to 409 Conflict so callers can re-submit with a strategy. */
export class ConflictError extends Error {
  readonly code = 'conflict'
}

export class KnowledgeService extends Service {
  static inject = ['webServer']
  static Config = Config

  private readonly baseConfig: Config
  private store: Store | undefined
  private readonly storeReady: Promise<void>
  private resolveStore: () => void = () => {}
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly indexing = new Map<string, { baseId: string; title: string; phase: 'parsing' | 'embedding'; total: number; progress: number }>()
  // Cherry Studio parity: per-base worker pool (Cherry's knowledge jobs run at
  // defaultConcurrency 5 on a per-base queue). Rows are created up front and
  // flip status as the queued parse+ingest tasks run in the background.
  private readonly ingestQueues = new Map<string, { pending: Array<() => Promise<void>>; running: number }>()
  // Per-base write chain guarding dedup-check + first persist (read-then-write),
  // so two concurrent imports of identical content cannot both pass the check.
  private readonly baseWriteChains = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'knowledge')
    this.baseConfig = config
    this.storeReady = new Promise<void>(resolve => { this.resolveStore = resolve })
    ctx.effect(() => ctx.webServer.register(knowledgeRoute(this)), 'knowledge: /knowledge route')
  }

  protected async [Service.init](): Promise<void> {
    setLocalModelCacheDir(this.baseConfig.localModelCacheDir)
    setHfEndpoint(this.baseConfig.hfEndpoint)
    const facility = this.ctx.get('storageDomain') as StorageDomainFacility | undefined
    this.store = await openStore(facility, { chunkStorePath: this.baseConfig.chunkStorePath })
    this.resolveStore()
    const store = this.store
    this.ctx.effect(() => async () => { await store.close() }, 'knowledge: close store')
    // Terminate the local-model inference worker on teardown so a loaded
    // ~600MB model can never outlive the plugin (Cherry: lifecycle-managed worker).
    this.ctx.effect(() => () => { disposeLocalModelWorker() }, 'knowledge: dispose local model worker')
    this.ctx.effect(() => () => { disposeOcrWorker() }, 'knowledge: dispose OCR worker')
    // Resume documents a previous process left mid-embedding: their chunks are
    // partially persisted, so re-running the embed with hash reuse completes
    // them without re-embedding the batches that already landed. (openStore
    // already ran the removal half of the recovery; this second pass is
    // idempotent and only harvests the resume list.)
    const resume = store.recoverInterruptedImports(Date.now()).then(({ resume: resumeIds }) => {
      if (resumeIds.length > 0) {
        this.ctx.logger.info(`knowledge: resuming ${resumeIds.length} interrupted import(s)`)
        void this.resumeInterruptedDocuments(resumeIds)
      }
    })
    void resume.catch(error => this.ctx.logger.warn(`knowledge: interrupted-import recovery failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  /**
   * Re-index documents a crash left mid-import. Each document holds rawText
   * and/or a persisted raw source file; hash reuse (decision A4) makes the
   * re-embed re-embed only missing batches. A placeholder that only has the
   * raw file (crash before/during parse) is re-parsed from source. Runs in
   * the background so startup is not blocked.
   */
  private async resumeInterruptedDocuments(ids: readonly string[]): Promise<void> {
    const store = this.requireStore()
    for (const id of ids) {
      const doc = store.getDocument(id)
      if (doc === undefined || doc.sourceType === 'directory') continue
      try {
        if (doc.rawFilePath !== undefined && doc.rawText === undefined) {
          // Crash before the text was persisted: rebuild from the raw copy.
          const bytes = await store.raw?.read(doc.rawFilePath)
          if (bytes === null || bytes === undefined || bytes.byteLength === 0) {
            this.ctx.logger.warn(`knowledge: raw source missing for interrupted import "${doc.title}", dropping it`)
            await store.deleteDocument(id)
            continue
          }
          const text = await parseDocumentBuffer(bytes, doc.fileName ?? doc.title, doc.mimeType)
          if (text.trim().length === 0) throw new Error('parsed document is empty')
          await this.ingestDocument({
            baseId: doc.baseId,
            title: doc.title,
            sourceType: 'file',
            ...(doc.fileName !== undefined ? { fileName: doc.fileName } : {}),
            ...(doc.mimeType !== undefined ? { mimeType: doc.mimeType } : {}),
            ...(doc.parentDirectoryId !== undefined ? { parentDirectoryId: doc.parentDirectoryId } : {}),
            placeholderId: doc.id,
            rawFilePath: doc.rawFilePath,
            text,
          })
        } else {
          await this.reindexDocument(id)
        }
      } catch (error) {
        this.ctx.logger.warn(`knowledge: resume of interrupted import failed for "${doc.title}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Wait until the durable store is ready; the HTTP route awaits this. */
  async whenReady(): Promise<void> {
    await this.storeReady
  }

  // ── configuration ─────────────────────────────────────────────────────────

  getConfig(): KnowledgeConfig {
    return resolveConfig(this.baseConfig, this.requireStore().getConfigOverrides())
  }

  /** Static model-id suggestions for the settings comboboxes. */
  modelSuggestions(): typeof MODEL_SUGGESTIONS {
    return MODEL_SUGGESTIONS
  }

  /** Resolve one base's effective config (global + that base's overrides). */
  getConfigFor(baseId?: string): KnowledgeConfig {
    const store = this.requireStore()
    if (baseId !== undefined) {
      const base = store.getBase(baseId)
      if (base !== undefined) {
        return resolveConfigFor(this.baseConfig, store.getConfigOverrides(), base.config)
      }
    }
    return this.getConfig()
  }

  async setConfig(overrides: ConfigOverrides): Promise<KnowledgeConfig> {
    await this.requireStore().setConfigOverrides(overrides)
    const resolved = this.getConfig()
    // Reapply the mirror switch live, so the panel can change it without a restart.
    setHfEndpoint(resolved.hfEndpoint)
    return resolved
  }

  // ── invocation toggle ─────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.requireStore().getEnabled()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.requireStore().setEnabled(enabled)
  }

  getEnabledBaseIds(): string[] {
    return this.requireStore().getEnabledBaseIds()
  }

  async setEnabledBaseIds(ids: readonly string[]): Promise<void> {
    await this.requireStore().setEnabledBaseIds([...new Set(ids)])
  }

  /**
   * Resolve the effective search scope for a model call: the enabled base ids,
   * or `undefined` when none are pinned (meaning "every base", Cherry's no-binding case).
   */
  enabledScope(): string[] | undefined {
    const store = this.requireStore()
    const ids = store.getEnabledBaseIds()
    if (ids.length === 0) return undefined
    const existing = new Set(store.listBases().map(base => base.id))
    const valid = ids.filter(id => existing.has(id))
    return valid.length > 0 ? valid : undefined
  }

  // ── bases ─────────────────────────────────────────────────────────────────

  async createBase(request: CreateBaseRequest): Promise<KnowledgeBase> {
    const name = request.name.trim()
    if (name.length === 0) throw new Error('base name is required')
    const now = Date.now()
    const store = this.requireStore()
    const group = request.group?.trim()
    if (group !== undefined && group.length > 0 && !store.getGroups().includes(group)) {
      await store.setGroups([...store.getGroups(), group])
    }
    const base: KnowledgeBase = {
      id: crypto.randomUUID(),
      name,
      description: request.description?.trim() ?? '',
      ...(group !== undefined && group.length > 0 ? { group } : {}),
      ...(request.config !== undefined ? { config: compactBaseConfig(request.config) } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await store.putBase(base)
    return base
  }

  /** Cherry-style restore: re-embed every source document into a fresh base
   *  (with the source's current config), returning the new base. Raw source
   *  files are copied across so the restored base keeps the rebuild source. */
  async restoreBase(sourceBaseId: string, name: string, config?: BaseConfig): Promise<KnowledgeBase> {
    const store = this.requireStore()
    const source = store.getBase(sourceBaseId)
    if (source === undefined) throw new Error(`knowledge base not found: ${sourceBaseId}`)
    // Cherry's restore flow rebuilds with a (possibly different) embedding
    // model: an explicit config overrides the source's (used when the user
    // switches models), otherwise the source config carries over.
    const base = await this.createBase({
      name: name.trim() || `${source.name} (恢复)`,
      description: source.description,
      group: source.group,
      config: config ?? source.config,
    })
    for (const doc of store.listDocuments(sourceBaseId)) {
      if (doc.sourceType === 'directory') continue
      const text = doc.rawText ?? reconstructFromChunks(store.listChunksByDoc(doc.id))
      if (text.trim().length === 0) continue
      // Copy the original bytes into the restored base so reindex stays
      // rebuildable from source there too (Cherry's restore carries raw/).
      let rawFilePath: string | undefined
      if (store.raw !== undefined && doc.rawFilePath !== undefined) {
        const raw = await store.raw.read(doc.rawFilePath)
        if (raw !== null) {
          const ext = rawExtensionOf(doc.rawFilePath)
          rawFilePath = await store.raw.write(base.id, crypto.randomUUID(), ext, raw)
        }
      }
      await this.ingestDocument({
        baseId: base.id,
        title: doc.title,
        sourceType: doc.sourceType,
        ...(doc.fileName !== undefined ? { fileName: doc.fileName } : {}),
        ...(doc.mimeType !== undefined ? { mimeType: doc.mimeType } : {}),
        ...(doc.url !== undefined ? { url: doc.url } : {}),
        ...(rawFilePath !== undefined ? { rawFilePath } : {}),
        text,
      })
    }
    return base
  }

  async deleteBase(id: string): Promise<void> {
    const store = this.requireStore()
    if (store.getBase(id) === undefined) throw new Error(`knowledge base not found: ${id}`)
    // Two statements: the base record plus one chunk sweep by base id.
    await store.deleteChunksByBase(id)
    await store.raw?.deleteBase(id)
    await store.deleteBase(id)
    // A whole-base delete frees a large chunk of pages; hand them back to the
    // OS (threshold-gated, so a small base never pays for a VACUUM).
    this.reclaimAfterDelete()
    // Keep the invocation scope clean: a deleted base id must not silently
    // narrow future searches to a base that no longer exists.
    const enabled = store.getEnabledBaseIds()
    if (enabled.includes(id)) await store.setEnabledBaseIds(enabled.filter(x => x !== id))
  }

  async renameBase(id: string, request: UpdateBaseRequest): Promise<KnowledgeBase> {
    const store = this.requireStore()
    const existing = store.getBase(id)
    if (existing === undefined) throw new Error(`knowledge base not found: ${id}`)
    const next: KnowledgeBase = {
      ...existing,
      name: request.name?.trim() || existing.name,
      description: request.description?.trim() ?? existing.description,
      ...(request.group !== undefined
        ? { group: request.group.trim().length > 0 ? request.group.trim() : undefined }
        : {}),
      ...(request.config !== undefined
        ? { config: mergeBaseConfig(existing.config, request.config) }
        : {}),
      updatedAt: Date.now(),
    }
    // Cherry's embedding-model change routes (resolveEmbeddingModelChangeRoute):
    // an empty base saves directly; a BM25-only base gaining a model backfills
    // vectors in place; switching an already-configured model invalidates every
    // stored vector and must go through rebuild (restore) — refuse the direct
    // change with that guidance instead of silently breaking retrieval.
    const patch = request.config
    if (patch !== undefined) {
      const oldConfig = this.getConfigFor(id)
      const newConfig = resolveConfigFor(this.baseConfig, store.getConfigOverrides(), next.config)
      const modelChanged = newConfig.embeddingProvider !== oldConfig.embeddingProvider
        || newConfig.embeddingModel !== oldConfig.embeddingModel
      if (modelChanged && store.listDocuments(id).length > 0) {
        const hadModel = oldConfig.embeddingProvider !== 'none' && oldConfig.embeddingModel.trim() !== ''
        if (hadModel) {
          throw new Error('切换嵌入模型会使已有向量全部失效——请使用「重建知识库」以新模型重建（Cherry Studio 语义）')
        }
        // BM25-only → enable-in-place: commit the model, then backfill vectors
        // in the background (Cherry's enableEmbeddingModel).
        await store.putBase(next)
        const baseId = id
        void this.reindexBase(baseId).catch((error: unknown) => {
          this.ctx.logger.warn(`knowledge: in-place embedding backfill failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        return next
      }
    }
    await store.putBase(next)
    return next
  }

  listBases(): BaseSummary[] {
    const store = this.requireStore()
    return store.listBases().map(base => {
      const documents = store.listDocuments(base.id)
      const chunkCount = documents.reduce((sum, doc) => sum + doc.chunkCount, 0)
      const charCount = documents.reduce((sum, doc) => sum + doc.charCount, 0)
      const tokenCount = documents.reduce((sum, doc) => sum + (doc.tokenCount ?? 0), 0)
      return {
        id: base.id,
        name: base.name,
        description: base.description,
        ...(base.group !== undefined ? { group: base.group } : {}),
        documentCount: documents.length,
        chunkCount,
        charCount,
        tokenCount,
        ...(base.config !== undefined ? { config: base.config } : {}),
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
      }
    })
  }

  // ── groups ────────────────────────────────────────────────────────────────

  listGroups(): string[] {
    return [...this.requireStore().getGroups()].sort((a, b) => a.localeCompare(b))
  }

  async createGroup(name: string): Promise<string[]> {
    const store = this.requireStore()
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new Error('group name is required')
    const groups = new Set(store.getGroups())
    if (groups.has(trimmed)) throw new Error(`group "${trimmed}" already exists`)
    groups.add(trimmed)
    await store.setGroups([...groups])
    return [...groups].sort((a, b) => a.localeCompare(b))
  }

  async renameGroup(from: string, to: string): Promise<string[]> {
    const store = this.requireStore()
    const trimmed = to.trim()
    if (trimmed.length === 0) throw new Error('group name is required')
    const groups = new Set(store.getGroups())
    if (!groups.has(from)) throw new Error(`group "${from}" does not exist`)
    if (groups.has(trimmed) && from !== trimmed) throw new Error(`group "${trimmed}" already exists`)
    groups.delete(from)
    groups.add(trimmed)
    for (const base of store.listBases()) {
      if (base.group === from) await store.putBase({ ...base, group: trimmed, updatedAt: Date.now() })
    }
    await store.setGroups([...groups])
    return [...groups].sort((a, b) => a.localeCompare(b))
  }

  async deleteGroup(name: string): Promise<void> {
    const store = this.requireStore()
    const groups = store.getGroups().filter(group => group !== name)
    await store.setGroups(groups)
    for (const base of store.listBases()) {
      if (base.group === name) await store.putBase({ ...base, group: undefined, updatedAt: Date.now() })
    }
  }

  // ── documents ─────────────────────────────────────────────────────────────

  async addTextDocument(request: AddTextDocumentRequest): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    if (request.content.trim().length === 0) throw new Error('document content is empty')
    return this.ingestDocument({
      baseId: request.baseId,
      title: request.title.trim(),
      sourceType: 'text',
      text: request.content,
    })
  }

  async addFileDocument(request: AddFileDocumentRequest): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    // Reject unsupported formats before the row is created (Cherry's
    // `assertSupportedKnowledgeFilePath`): a binary/image/archive must not be
    // decoded into garbage text and imported as a real document.
    if (!SUPPORTED_DOCUMENT_EXTENSION_SET.has(extensionOf(request.fileName))) {
      throw new Error(`Unsupported knowledge file type: ${request.fileName}`)
    }
    // Same-name conflict handling (Cherry Studio's three strategies, plus
    // keep): the effective strategy is the per-request override, else the
    // base/global `conflictStrategy` config, else rename (Cherry's default).
    const conflictStrategy = request.conflict ?? this.getConfigFor(request.baseId).conflictStrategy
    if (conflictStrategy !== 'keep') {
      const existing = store.listDocuments(request.baseId).find(doc => doc.fileName === request.fileName)
      if (existing !== undefined) {
        if (conflictStrategy === 'replace') {
          await store.deleteChunks(existing.id)
          if (existing.rawFilePath !== undefined) await store.raw?.delete(existing.rawFilePath)
          await store.deleteDocument(existing.id)
        } else if (conflictStrategy === 'detect') {
          throw new ConflictError(`same-name document exists: ${request.fileName} (id ${existing.id}) — re-upload with conflict=replace or conflict=rename`)
        }
      }
    }
    // Rename strategy: bump to `name_1.ext`, `name_2.ext`, … until free
    // (Cherry's automatic `_1` suffix). Applies to both fileName and title.
    let fileName = request.fileName
    let title = request.title?.trim() || request.fileName
    if (conflictStrategy === 'rename') {
      const taken = new Set(store.listDocuments(request.baseId).map(doc => doc.fileName))
      let candidate = fileName
      let counter = 1
      while (taken.has(candidate)) {
        const dot = fileName.lastIndexOf('.')
        const base = dot > 0 ? fileName.slice(0, dot) : fileName
        const ext = dot > 0 ? fileName.slice(dot) : ''
        candidate = `${base}_${counter}${ext}`
        counter += 1
      }
      if (candidate !== fileName) {
        fileName = candidate
        if (request.title !== undefined) title = `${request.title.trim()}_${counter - 1}`
      }
    }
    // Cherry Studio parity: publish the row FIRST (with "parsing" status) and
    // return immediately; the parse+embed runs on a per-base worker pool
    // (concurrency 5) and the row flips processing → completed/failed as it
    // goes, exactly like Cherry's create-then-index jobs.
    const docId = crypto.randomUUID()
    const placeholder: KnowledgeDocument = {
      id: docId,
      baseId: request.baseId,
      title,
      sourceType: 'file',
      fileName,
      ...(request.mimeType !== undefined ? { mimeType: request.mimeType } : {}),
      ...(request.parentDirectoryId !== undefined ? { parentDirectoryId: request.parentDirectoryId } : {}),
      charCount: 0,
      chunkCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    // Persist the original bytes FIRST (Cherry's "import means copy"): the
    // base keeps its own stable source copy, reindex can re-read and re-parse
    // it, and a crash before/during parse is recoverable from the file
    // instead of being a lost upload.
    const rawFilePath = store.raw !== undefined
      ? await store.raw.write(request.baseId, docId, safeRawExtension(fileName), decodeBase64(request.contentBase64))
      : undefined
    const stored = { ...placeholder, ...(rawFilePath !== undefined ? { rawFilePath } : {}) }
    await store.putDocument(stored)
    this.indexing.set(docId, { baseId: request.baseId, title, phase: 'parsing', total: 0, progress: 0 })
    // Queue the background parse+ingest. The task re-reads the persisted raw
    // copy instead of holding the payload in memory, so a large batch never
    // accumulates file contents in the queue; only a deployment without a raw
    // backend (e.g. in-memory test stores) keeps the payload for the task. A
    // failed import KEEPS its row (marked failed with the reason — Cherry
    // shows failed rows in the list, reindexable from the raw copy) instead of
    // vanishing from the list.
    const fallbackPayload = rawFilePath !== undefined ? undefined : request.contentBase64
    this.enqueueIngest(request.baseId, async () => {
      try {
        // Prefer re-reading the persisted raw copy (the queue never holds file
        // contents in memory); fall back to the request payload only when the
        // deployment has no raw backend (e.g. in-memory test stores).
        let bytes: Uint8Array | null = rawFilePath !== undefined ? (await store.raw?.read(rawFilePath)) ?? null : null
        if (bytes === null && fallbackPayload !== undefined) bytes = decodeBase64(fallbackPayload)
        if (bytes === null) throw new Error('raw copy is missing — cannot parse the file')
        // Cherry's fileProcessorId posture: when the MinerU remote processor
        // is configured, PDFs go through the API first (scanned/complex
        // layouts get true layout-aware Markdown); any failure falls back to
        // the local pipeline.
        const config = this.getConfigFor(request.baseId)
        let text: string | null = null
        if (config.documentProcessorProvider === 'mineru' && config.mineruApiKey.trim() !== ''
          && extensionOf(fileName) === 'pdf') {
          try {
            const { extractPdfWithMineru } = await import('./mineru.js')
            text = await extractPdfWithMineru(bytes, fileName, {
              apiKey: config.mineruApiKey,
              apiHost: config.mineruApiHost,
            })
          } catch (error) {
            this.ctx.logger.warn(`knowledge: mineru extract failed, falling back to local: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (text === null) {
          text = await parseDocumentBuffer(bytes, fileName, request.mimeType)
        }
        if (text.trim().length === 0) throw new Error('parsed document is empty')
        await this.ingestDocument({
          baseId: request.baseId,
          title,
          sourceType: 'file',
          fileName,
          ...(request.mimeType !== undefined ? { mimeType: request.mimeType } : {}),
          ...(request.parentDirectoryId !== undefined ? { parentDirectoryId: request.parentDirectoryId } : {}),
          placeholderId: docId,
          rawFilePath,
          text,
        })
      } catch (error) {
        this.indexing.delete(docId)
        const message = error instanceof Error ? error.message : String(error)
        try {
          await store.putDocument({ ...stored, embeddingError: message })
        } catch {
          // best-effort: the row already exists; the status flip is cosmetic
        }
      }
    })
    return stored
  }

  /** Start importing a local directory as a cancellable background job. */
  async importDirectory(request: ImportDirectoryRequest): Promise<{ jobId: string; total: number }> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    const files = await scanDirectory(request.path)
    const jobId = crypto.randomUUID()
    this.pruneJobs()
    this.jobs.set(jobId, {
      baseId: request.baseId,
      kind: 'directory',
      cancelled: false,
      imported: 0,
      skipped: 0,
      total: files.length,
      current: '',
      errors: [],
      done: false,
    })
    void this.runDirectoryImport(jobId, files)
    return { jobId, total: files.length }
  }

  /** Progress snapshot of an active (or just-finished) directory import. */
  directoryImportStatus(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId)
  }

  cancelDirectoryImport(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job !== undefined && !job.done) job.cancelled = true
  }

  private async runDirectoryImport(jobId: string, files: readonly string[]): Promise<void> {
    const job = this.jobs.get(jobId)
    if (job === undefined) return
    for (const file of files) {
      if (job.cancelled) break
      job.current = file
      try {
        const buffer = await readFile(file)
        const text = await parseDocumentBuffer(buffer, basename(file))
        if (text.trim().length === 0) {
          job.skipped += 1
          continue
        }
        await this.ingestDocument({
          baseId: job.baseId,
          title: basename(file),
          sourceType: 'file',
          fileName: basename(file),
          text,
        })
        job.imported += 1
      } catch (error) {
        job.errors.push({ file, error: error instanceof Error ? error.message : String(error) })
      }
    }
    job.done = true
    job.current = ''
  }

  private pruneJobs(): void {
    if (this.jobs.size < 50) return
    for (const [id, job] of this.jobs) {
      if (job.done) this.jobs.delete(id)
    }
  }

  /** Create a directory container item (no chunks) under an optional parent. */
  async createDirectory(baseId: string, title: string, parentDirectoryId?: string): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    const document: KnowledgeDocument = {
      id: crypto.randomUUID(),
      baseId,
      title: title.trim() || 'directory',
      sourceType: 'directory',
      ...(parentDirectoryId !== undefined ? { parentDirectoryId } : {}),
      charCount: 0,
      chunkCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await store.putDocument(document)
    await this.touchBase(baseId)
    return document
  }

  /** Import a local directory as a nested tree of directory containers + file items. */
  async importDirectoryTree(
    baseId: string,
    path: string,
    parentDirectoryId?: string,
  ): Promise<{ imported: number; directories: number; errors: Array<{ file: string; error: string }> }> {
    const rootName = basename(path)
    const rootId = parentDirectoryId ?? (await this.createDirectory(baseId, rootName)).id
    let imported = 0
    let directories = 1
    const errors: Array<{ file: string; error: string }> = []

    const walk = async (dir: string, parentId: string, depth: number): Promise<void> => {
      if (depth > DIRECTORY_MAX_DEPTH) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        errors.push({ file: dir, error: error instanceof Error ? error.message : String(error) })
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          const child = await this.createDirectory(baseId, entry.name, parentId)
          directories += 1
          await walk(full, child.id, depth + 1)
        } else if (entry.isFile() && DIRECTORY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          try {
            const buffer = await readFile(full)
            const text = await parseDocumentBuffer(buffer, basename(full))
            if (text.trim().length === 0) continue
            await this.ingestDocument({
              baseId,
              title: basename(full),
              sourceType: 'file',
              fileName: basename(full),
              parentDirectoryId: parentId,
              text,
            })
            imported += 1
          } catch (error) {
            errors.push({ file: full, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
    }

    await walk(path, rootId, 0)
    return { imported, directories, errors }
  }

  async addUrlDocument(request: ImportUrlRequest): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    const html = await fetchHtml(request.url)
    const extracted = extractFromHtml(html)
    if (extracted.text.trim().length === 0) throw new Error('URL returned no extractable text')
    // Persist the fetched text as the URL's snapshot (Cherry's snapshot model:
    // the base owns a stable copy; refresh re-fetches and overwrites it).
    const docId = crypto.randomUUID()
    const title = request.title?.trim() || extracted.title || request.url
    let rawFilePath: string | undefined
    if (store.raw !== undefined) {
      rawFilePath = await store.raw.write(request.baseId, docId, '.md', encodeUtf8(extracted.text))
    }
    return this.ingestDocument({
      baseId: request.baseId,
      title,
      sourceType: 'url',
      url: request.url,
      rawFilePath,
      text: extracted.text,
    })
  }

  /**
   * Cherry-style URL refresh: re-fetch the page, and when its text changed,
   * overwrite the snapshot and re-index the document (hash reuse re-embeds
   * only the chunks that changed). A failed fetch or an unchanged page leaves
   * the current snapshot and index untouched — refresh never degrades.
   */
  async refreshUrlDocument(id: string): Promise<{ changed: boolean; title: string; chunkCount: number }> {
    const store = this.requireStore()
    const document = store.getDocument(id)
    if (document === undefined) throw new Error(`document not found: ${id}`)
    if (document.sourceType !== 'url' || document.url === undefined) {
      throw new Error(`document "${document.title}" is not a URL document`)
    }
    const html = await fetchHtml(document.url)
    const extracted = extractFromHtml(html)
    if (extracted.text.trim().length === 0) throw new Error('URL returned no extractable text')
    const title = extracted.title.trim().length > 0 ? extracted.title.trim() : document.title
    if (extracted.text === document.rawText && title === document.title) {
      return { changed: false, title: document.title, chunkCount: document.chunkCount }
    }
    // Overwrite the snapshot (or persist a new one for pre-snapshot docs).
    let rawFilePath = document.rawFilePath
    if (store.raw !== undefined) {
      const ext = rawFilePath !== undefined ? rawExtensionOf(rawFilePath) : '.md'
      rawFilePath = await store.raw.write(document.baseId, document.id, ext, encodeUtf8(extracted.text))
    }
    const refreshed = await this.ingestDocument({
      baseId: document.baseId,
      title,
      sourceType: 'url',
      url: document.url,
      rawFilePath,
      text: extracted.text,
      placeholderId: document.id,
    })
    return { changed: true, title: refreshed.title, chunkCount: refreshed.chunkCount }
  }

  async deleteDocument(id: string): Promise<void> {
    const store = this.requireStore()
    const existing = store.getDocument(id)
    if (existing === undefined) throw new Error(`document not found: ${id}`)
    await this.deleteDocumentRecursive(id)
    // One updatedAt write per delete, not per descendant.
    await this.touchBase(existing.baseId)
    this.reclaimAfterDelete()
  }

  /** Threshold-gated space reclamation after a delete (Cherry's reclaimSpace). */
  private reclaimAfterDelete(): void {
    const store = this.requireStore()
    const outcome = store.reclaimSpace?.()
    if (outcome !== undefined && outcome.vacuumed) {
      this.ctx.logger.info(`knowledge: reclaimed ${outcome.reclaimedBytes} bytes after delete`)
    }
  }

  /** Delete one document (recursing into directory containers), one write per item. */
  private async deleteDocumentRecursive(id: string): Promise<void> {
    const store = this.requireStore()
    const existing = store.getDocument(id)
    if (existing === undefined) return
    // Deleting a directory container also removes its descendants.
    if (existing.sourceType === 'directory') {
      for (const child of store.listDocuments(existing.baseId)) {
        if (child.parentDirectoryId === id) await this.deleteDocumentRecursive(child.id)
      }
    }
    if (existing.rawFilePath !== undefined) await store.raw?.delete(existing.rawFilePath)
    await store.deleteChunks(id)
    await store.deleteDocument(id)
  }

  async renameDocument(id: string, title: string): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    const existing = store.getDocument(id)
    if (existing === undefined) throw new Error(`document not found: ${id}`)
    const next = { ...existing, title: title.trim() || existing.title, updatedAt: Date.now() }
    await store.putDocument(next)
    return next
  }

  async reindexDocument(id: string): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    const document = store.getDocument(id)
    if (document === undefined) throw new Error(`document not found: ${id}`)
    // A directory container has no content of its own: reindexing it means
    // reindexing its whole subtree (Cherry's reindex-subtree semantics).
    // In-flight leaves are skipped (Cherry's REINDEX_ALLOWED_STATUSES), not
    // failed, so reindexing a busy directory never aborts mid-subtree.
    if (document.sourceType === 'directory') {
      for (const child of store.listDocuments(document.baseId)) {
        if (child.parentDirectoryId !== document.id) continue
        if (this.indexing.has(child.id)) continue
        await this.reindexDocument(child.id)
      }
      return document
    }
    if (this.indexing.has(id)) {
      throw new Error(`"${document.title}" is still being indexed — try again when it finishes`)
    }
    // Re-read and re-parse the original source when it was persisted (Cherry's
    // `canKnowledgeItemRebuildSource`): a reindex after a parser upgrade gets
    // the better extraction, and the raw copy is the stable rebuild source.
    // Fall back to the persisted text (then to reconstructed chunks) when the
    // file is gone or unreadable — a reindex must never wipe vectors for a
    // source that cannot be rebuilt.
    const text = await this.sourceTextOf(document)
    const config = this.getConfigFor(document.baseId)
    // Mark the document incomplete so a crash mid-reindex is resumed on the
    // next start (buildChunks persists each embedded batch; hash reuse makes
    // the resume re-embed only what never landed).
    await store.putDocument({ ...document, incomplete: true, updatedAt: Date.now() })
    const { chunks, embeddingError } = await this.buildChunks(document.baseId, document.id, document.title, text, config, undefined, batch => store.putChunkBatch(batch))
    const { embeddingError: _staleError, incomplete: _staleIncomplete, contentHash: _staleHash, ...rest } = document
    const next: KnowledgeDocument = {
      ...rest,
      rawText: text,
      contentHash: sha256(text),
      charCount: text.length,
      tokenCount: estimateTokens(text),
      chunkCount: chunks.length,
      ...(embeddingError !== undefined ? { embeddingError } : {}),
      updatedAt: Date.now(),
    }
    // putChunks overwrites the doc's chunk bundle in one write (legacy per-chunk
    // rows, if any, stay hidden because a bundle record is authoritative).
    await store.putChunks(chunks)
    await store.putDocument(next)
    await this.touchBase(document.baseId)
    return next
  }

  /** Rebuild source text of a document: raw file first, then persisted text, then chunks. */
  private async sourceTextOf(document: KnowledgeDocument): Promise<string> {
    if (document.rawFilePath !== undefined) {
      const store = this.requireStore()
      const raw = await store.raw?.read(document.rawFilePath)
      if (raw !== null && raw !== undefined && raw.byteLength > 0) {
        try {
          const text = await parseDocumentBuffer(raw, document.fileName ?? document.title, document.mimeType)
          if (text.trim().length > 0) return text
        } catch (error) {
          this.ctx.logger.warn(`knowledge: re-parsing raw source failed, falling back to stored text: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        this.ctx.logger.warn(`knowledge: raw source file missing for "${document.title}", falling back to stored text`)
      }
    }
    const text = document.rawText ?? reconstructFromChunks(this.requireStore().listChunksByDoc(document.id))
    if (text.trim().length === 0) throw new Error(`document "${document.title}" has no source text to reindex`)
    return text
  }

  async reindexBase(baseId: string): Promise<{ reindexed: number }> {
    const store = this.requireStore()
    const ids = store.listDocuments(baseId).map(doc => doc.id)
    // Fold to outermost roots: a directory reindexes its subtree recursively,
    // so its descendants must not be reindexed a second time as siblings.
    let reindexed = 0
    for (const id of this.outermostSelectedIds(ids)) {
      await this.reindexDocument(id)
      reindexed += 1
    }
    return { reindexed }
  }

  /** Start re-embedding a whole base as a cancellable background job. */
  async startReindexBase(baseId: string): Promise<{ jobId: string; total: number }> {
    const store = this.requireStore()
    if (store.getBase(baseId) === undefined) throw new Error(`knowledge base not found: ${baseId}`)
    const documents = store.listDocuments(baseId)
    const jobId = crypto.randomUUID()
    this.pruneJobs()
    this.jobs.set(jobId, {
      baseId,
      kind: 'reindex',
      cancelled: false,
      imported: 0,
      skipped: 0,
      total: documents.length,
      current: '',
      errors: [],
      done: false,
    })
    void this.runReindexJob(jobId, baseId)
    return { jobId, total: documents.length }
  }

  /** Progress snapshot of an active (or just-finished) reindex job. */
  reindexJobStatus(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId)
  }

  cancelReindexJob(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job !== undefined && !job.done) job.cancelled = true
  }

  private async runReindexJob(jobId: string, baseId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (job === undefined) return
    const documents = this.requireStore().listDocuments(baseId)
    for (const doc of documents) {
      if (job.cancelled) break
      job.current = doc.title
      if (doc.sourceType === 'directory') {
        job.skipped += 1
        continue
      }
      try {
        await this.reindexDocument(doc.id)
        job.imported += 1
      } catch (error) {
        job.errors.push({ file: doc.title, error: error instanceof Error ? error.message : String(error) })
      }
    }
    job.done = true
    job.current = ''
  }

  async reindexDocuments(ids: readonly string[]): Promise<{ reindexed: number; skipped: number }> {
    const store = this.requireStore()
    // Fold the selection to its outermost roots first (Cherry's
    // `getOutermostSelectedItemIds`): a directory and one of its descendants
    // in the same batch must not reindex the subtree twice, and each selected
    // directory reindexes its whole subtree recursively. In-flight rows are
    // skipped and counted so the UI can tell the user (Cherry's bulk gate).
    let reindexed = 0
    let skipped = 0
    for (const id of this.outermostSelectedIds(ids)) {
      if (store.getDocument(id) === undefined) continue
      if (this.indexing.has(id)) {
        skipped += 1
        continue
      }
      await this.reindexDocument(id)
      reindexed += 1
    }
    return { reindexed, skipped }
  }

  async deleteDocuments(ids: readonly string[]): Promise<{ deleted: number }> {
    const store = this.requireStore()
    // Fold to outermost roots so a directory and its selected descendants are
    // not deleted twice; deleteDocumentRecursive removes the whole subtree.
    const touched = new Set<string>()
    let deleted = 0
    for (const id of this.outermostSelectedIds(ids)) {
      const document = store.getDocument(id)
      if (document === undefined) continue
      await this.deleteDocumentRecursive(id)
      touched.add(document.baseId)
      deleted += 1
    }
    // One updatedAt write per affected base, not per document.
    for (const baseId of touched) await this.touchBase(baseId)
    this.reclaimAfterDelete()
    return { deleted }
  }

  /**
   * Resolve the request's metadata filter into a document-id allow-list, or
   * `undefined` when no filter is present (unrestricted search). A filter that
   * matches nothing yields an empty set, so the caller returns no hits.
   */
  private resolveSearchFilter(request: SearchRequest): Set<string> | undefined {
    const filter = request.filter
    if (filter === undefined) return undefined
    const { docIds, titleIncludes, sourceTypes, updatedAfter, updatedBefore } = filter
    const hasDocIds = docIds !== undefined && docIds.length > 0
    const hasTitle = titleIncludes !== undefined && titleIncludes.trim().length > 0
    const hasTypes = sourceTypes !== undefined && sourceTypes.length > 0
    const hasTime = updatedAfter !== undefined || updatedBefore !== undefined
    if (!hasDocIds && !hasTitle && !hasTypes && !hasTime) return undefined

    const store = this.requireStore()
    const scope = request.baseId !== undefined
      ? [request.baseId]
      : request.baseIds !== undefined && request.baseIds.length > 0
        ? [...request.baseIds]
        : store.listBases().map(base => base.id)
    const title = hasTitle ? filter!.titleIncludes!.trim().toLowerCase() : undefined
    const allowed = new Set<string>()
    for (const baseId of scope) {
      for (const doc of store.listDocuments(baseId)) {
        if (hasDocIds && !docIds!.includes(doc.id)) continue
        if (title !== undefined && !doc.title.toLowerCase().includes(title)) continue
        if (hasTypes && !sourceTypes!.includes(doc.sourceType)) continue
        if (updatedAfter !== undefined && (doc.updatedAt ?? doc.createdAt) < updatedAfter) continue
        if (updatedBefore !== undefined && (doc.updatedAt ?? doc.createdAt) > updatedBefore) continue
        allowed.add(doc.id)
      }
    }
    return allowed
  }

  /**
   * Fold a set of selected document ids to its outermost roots (Cherry's
   * `getOutermostSelectedItemIds`): ids that are descendants of another
   * selected id are dropped, so a directory plus one of its children in the
   * same batch resolves to just the directory — the subtree is then handled
   * once by the recursive operations.
   */
  private outermostSelectedIds(ids: readonly string[]): string[] {
    const store = this.requireStore()
    const selected = new Set(ids.filter(id => store.getDocument(id) !== undefined))
    if (selected.size === 0) return []
    const childrenOf = new Map<string, string[]>()
    for (const base of store.listBases()) {
      for (const doc of store.listDocuments(base.id)) {
        const parent = doc.parentDirectoryId
        if (parent === undefined) continue
        const list = childrenOf.get(parent) ?? []
        list.push(doc.id)
        childrenOf.set(parent, list)
      }
    }
    // A selected id is "inner" when any of its ancestors is also selected.
    const inner = new Set<string>()
    const walk = (docId: string, depth: number): void => {
      if (depth > 0 && selected.has(docId)) inner.add(docId)
      for (const child of childrenOf.get(docId) ?? []) walk(child, depth + 1)
    }
    for (const id of selected) walk(id, 0)
    return [...selected].filter(id => !inner.has(id))
  }

  listDocuments(baseId: string): DocumentSummary[] {
    const store = this.requireStore()
    // One grouped pass over the base's chunks (embedding is all-or-nothing per
    // doc), avoiding a full chunk scan per document on every list.
    const { withChunks, missingEmbedding } = store.docChunkStatus(baseId)
    const allDocs = store.listDocuments(baseId)
    const childCount = new Map<string, number>()
    for (const doc of allDocs) {
      if (doc.parentDirectoryId !== undefined) {
        childCount.set(doc.parentDirectoryId, (childCount.get(doc.parentDirectoryId) ?? 0) + 1)
      }
    }
    return allDocs.map(doc => {
      const embedded = withChunks.has(doc.id) && !missingEmbedding.has(doc.id)
      const active = this.indexing.get(doc.id)
      let status: 'pending' | 'processing' | 'completed' | 'failed' = 'pending'
      if (doc.sourceType !== 'directory') {
        if (doc.embeddingError !== undefined) status = 'failed'
        else if (active !== undefined) status = 'processing'
        else if (embedded) status = 'completed'
      }
      return {
        id: doc.id,
        baseId: doc.baseId,
        title: doc.title,
        sourceType: doc.sourceType,
        fileName: doc.fileName,
        url: doc.url,
        ...(doc.parentDirectoryId !== undefined ? { parentDirectoryId: doc.parentDirectoryId } : {}),
        charCount: doc.charCount,
        tokenCount: doc.tokenCount,
        chunkCount: doc.chunkCount,
        ...(doc.sourceType === 'directory' ? { childCount: childCount.get(doc.id) ?? 0 } : {}),
        embedded,
        ...(doc.embeddingError !== undefined ? { embeddingError: doc.embeddingError } : {}),
        ...(doc.sourceType !== 'directory' ? { status } : {}),
        ...(active !== undefined ? { indexingProgress: active.progress, indexingPhase: active.phase } : {}),
        createdAt: doc.createdAt,
        ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
      }
    })
  }

  /** Pre-order DFS outline of one base's directory tree (kb_list outline mode). */
  listBaseOutline(baseId: string): {
    baseId: string
    totalItems: number
    nodes: Array<{ depth: number; docId: string; title: string; type: DocumentSourceType; status: string }>
  } {
    const summaries = this.listDocuments(baseId)
    const children = new Map<string, DocumentSummary[]>()
    const roots: DocumentSummary[] = []
    for (const doc of summaries) {
      if (doc.parentDirectoryId === undefined) roots.push(doc)
      else {
        const list = children.get(doc.parentDirectoryId) ?? []
        list.push(doc)
        children.set(doc.parentDirectoryId, list)
      }
    }
    const byTitle = (a: DocumentSummary, b: DocumentSummary): number => a.title.localeCompare(b.title)
    roots.sort(byTitle)
    for (const list of children.values()) list.sort(byTitle)
    const nodes: Array<{ depth: number; docId: string; title: string; type: DocumentSourceType; status: string }> = []
    const walk = (doc: DocumentSummary, depth: number): void => {
      nodes.push({
        depth,
        docId: doc.id,
        title: doc.title,
        type: doc.sourceType,
        status: doc.status ?? 'completed',
      })
      for (const child of children.get(doc.id) ?? []) walk(child, depth + 1)
    }
    for (const root of roots) walk(root, 0)
    return { baseId, totalItems: summaries.length, nodes }
  }

  /** Live import/embedding progress for every document currently being indexed. */
  indexingStatus(): Array<{ docId: string; baseId: string; title: string; phase: 'parsing' | 'embedding'; progress: number }> {
    return [...this.indexing.entries()].map(([docId, entry]) => ({
      docId,
      baseId: entry.baseId,
      title: entry.title,
      phase: entry.phase,
      progress: entry.progress,
    }))
  }

  /** Current download/load state of an in-process embedding model. */
  getLocalModelStatus(modelId?: string): LocalModelStatus {
    return getLocalModelStatus(modelId?.trim() || DEFAULT_LOCAL_MODEL)
  }

  // ── local model manager (settings "本地模型") ──────────────────────────────

  listLocalModels(): Promise<LocalModelSummary[]> {
    return listLocalModels()
  }

  downloadLocalModel(id: string): Promise<LocalModelSummary> {
    return downloadLocalModel(id)
  }

  cancelLocalModel(id: string): Promise<LocalModelSummary> {
    return cancelLocalModelDownload(id)
  }

  deleteLocalModel(id: string): Promise<LocalModelSummary> {
    return deleteLocalModel(id)
  }

  // ── local OCR (scanned-PDF recognition, Cherry's local-document posture) ──

  getOcrStatus(): OcrModelStatus {
    return getOcrModelStatus()
  }

  downloadOcr(): Promise<OcrModelStatus> {
    // The OCR models come from a Hugging Face endpoint; honor the configured
    // hfEndpoint mirror (default hf-mirror.com) so overseas users can point
    // the download at huggingface.co.
    return downloadOcrModels(this.baseConfig.hfEndpoint)
  }

  deleteOcr(): Promise<{ deleted: true }> {
    return removeOcrModels().then(() => ({ deleted: true }))
  }

  listChunks(documentId: string, limit?: number, offset?: number): KnowledgeChunk[] {
    // Bounded SQL read (LIMIT/OFFSET) on the SQLite-backed store.
    const start = clampInt(offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 0)
    const count = limit === undefined ? undefined : clampInt(limit, 0, Number.MAX_SAFE_INTEGER, 0)
    return this.requireStore().listChunksByDoc(documentId, count, start)
  }

  getDocument(id: string, opts?: { includeChunks?: boolean; rawTextLimit?: number }): DocumentDetail {
    const store = this.requireStore()
    const doc = store.getDocument(id)
    if (doc === undefined) throw new Error(`document not found: ${id}`)
    const rawText = doc.rawText
    const rawTextLimit = opts?.rawTextLimit
    const truncated = rawText !== undefined && rawTextLimit !== undefined && rawText.length > rawTextLimit
    return {
      id: doc.id,
      baseId: doc.baseId,
      title: doc.title,
      sourceType: doc.sourceType,
      ...(doc.fileName !== undefined ? { fileName: doc.fileName } : {}),
      ...(doc.url !== undefined ? { url: doc.url } : {}),
      ...(doc.rawFilePath !== undefined ? { rawFilePath: doc.rawFilePath } : {}),
      rawText: truncated ? rawText.slice(0, rawTextLimit) : rawText,
      ...(truncated ? { rawTextTruncated: true } : {}),
      charCount: doc.charCount,
      ...(doc.tokenCount !== undefined ? { tokenCount: doc.tokenCount } : {}),
      chunkCount: doc.chunkCount,
      createdAt: doc.createdAt,
      ...(opts?.includeChunks === false ? {} : { chunks: store.listChunksByDoc(id) }),
    }
  }

  /** Original source bytes of a file document (for the download route). */
  async getRawFile(id: string): Promise<{ bytes: Uint8Array; fileName: string; mimeType?: string } | undefined> {
    const store = this.requireStore()
    const doc = store.getDocument(id)
    if (doc === undefined || doc.rawFilePath === undefined) return undefined
    const bytes = await store.raw?.read(doc.rawFilePath)
    if (bytes === null || bytes === undefined) return undefined
    return { bytes, fileName: doc.fileName ?? doc.title, mimeType: doc.mimeType }
  }

  /** Read one document's source text as a `[charStart, charEnd)` slice (kb_read read mode). */
  readDocumentText(id: string, charStart?: number, charEnd?: number): {
    id: string
    baseId: string
    title: string
    sourceType: DocumentSourceType
    totalChars: number
    charStart: number
    charEnd: number
    content: string
    truncated: boolean
  } {
    const store = this.requireStore()
    const doc = store.getDocument(id)
    if (doc === undefined) throw new Error(`document not found: ${id}`)
    const text = doc.rawText ?? reconstructFromChunks(store.listChunksByDoc(id))
    const total = text.length
    const start = clampInt(charStart ?? 0, 0, total, 0)
    const end = clampInt(charEnd ?? total, start, total, total)
    return {
      id: doc.id,
      baseId: doc.baseId,
      title: doc.title,
      sourceType: doc.sourceType,
      totalChars: total,
      charStart: start,
      charEnd: end,
      content: text.slice(start, end),
      truncated: end < total,
    }
  }

  /** Grep one document's source text for a regular expression (kb_read grep mode). */
  grepDocument(id: string, pattern: string, maxMatches?: number, ignoreCase = true): {
    id: string
    baseId: string
    title: string
    totalMatches: number
    matches: Array<{ line: number; charStart: number; charEnd: number; snippet: string }>
  } {
    const store = this.requireStore()
    const doc = store.getDocument(id)
    if (doc === undefined) throw new Error(`document not found: ${id}`)
    const text = doc.rawText ?? reconstructFromChunks(store.listChunksByDoc(id))
    let regex: RegExp
    try {
      regex = new RegExp(pattern, `g${ignoreCase ? 'i' : ''}`)
    } catch (error) {
      throw new Error(`invalid regex: ${error instanceof Error ? error.message : String(error)}`)
    }
    const cap = clampInt(maxMatches ?? 50, 1, 200, 50)
    const matches: Array<{ line: number; charStart: number; charEnd: number; snippet: string }> = []
    let match: RegExpExecArray | null
    while (matches.length < cap && (match = regex.exec(text)) !== null) {
      const matchStart = match.index
      const matchEnd = matchStart + match[0].length
      const line = text.slice(0, matchStart).split('\n').length
      const snippetStart = Math.max(0, matchStart - 60)
      const snippetEnd = Math.min(text.length, matchEnd + 60)
      matches.push({
        line,
        charStart: matchStart,
        charEnd: matchEnd,
        snippet: `${snippetStart > 0 ? '…' : ''}${text.slice(snippetStart, snippetEnd)}${snippetEnd < text.length ? '…' : ''}`,
      })
      if (match[0].length === 0) regex.lastIndex += 1
    }
    return { id: doc.id, baseId: doc.baseId, title: doc.title, totalMatches: matches.length, matches }
  }

  // ── statistics ────────────────────────────────────────────────────────────

  stats(baseId?: string): BaseStats {
    const store = this.requireStore()
    const bases = baseId !== undefined ? store.listBases().filter(base => base.id === baseId) : store.listBases()
    const documents = bases.flatMap(base => store.listDocuments(base.id))
    const charCount = documents.reduce((sum, doc) => sum + doc.charCount, 0)
    const tokenCount = documents.reduce((sum, doc) => sum + (doc.tokenCount ?? 0), 0)
    const chunkStats = store.chunkStats(bases.map(base => base.id))
    // Staleness: an embedded chunk is stale when it was produced by a different
    // embedding source than the base's currently resolved configuration.
    let staleChunkCount = 0
    let hasCurrentKey = false
    for (const base of bases) {
      const key = embeddingKey(this.getConfigFor(base.id))
      if (key === undefined) continue
      hasCurrentKey = true
      for (const entry of chunkStats.embeddingModelCounts) {
        if (entry.baseId === base.id && entry.model !== key) staleChunkCount += entry.count
      }
    }
    return {
      ...(baseId !== undefined ? { baseId } : {}),
      documentCount: documents.length,
      chunkCount: chunkStats.count,
      charCount,
      tokenCount,
      embedded: chunkStats.embedded,
      ...(chunkStats.dimensions !== undefined ? { embeddingDimensions: chunkStats.dimensions } : {}),
      ...(hasCurrentKey && staleChunkCount > 0 ? { staleEmbeddings: true, staleChunkCount } : {}),
    }
  }

  // ── retrieval ─────────────────────────────────────────────────────────────

  async search(request: SearchRequest): Promise<SearchResult> {
    const startedAt = Date.now()
    const store = this.requireStore()
    const config = this.getConfigFor(request.baseId)
    const query = request.query.trim()
    if (query.length === 0) return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] }
    // A stale base id (e.g. a base deleted without sweeping child records)
    // must not surface orphaned content.
    if (request.baseId !== undefined && store.getBase(request.baseId) === undefined) {
      return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] }
    }

    const requestedMode = request.mode ?? config.searchMode
    const topK = clampInt(request.topK ?? config.topK, 1, 50, 6)
    const threshold = request.threshold ?? config.similarityThreshold

    // Metadata filters narrow the search to a subset of documents. Resolved
    // once here into a docId allow-list shared by both retrieval paths.
    const filterDocIds = this.resolveSearchFilter(request)

    const lane = store.retrievalLane
    if (lane !== undefined) {
      const scope = request.baseId !== undefined
        ? [request.baseId]
        : request.baseIds !== undefined && request.baseIds.length > 0
          ? [...request.baseIds]
          : store.listBases().map(base => base.id)
      const poolSize = Math.min(Math.max(topK * 4, 20), LANE_CANDIDATE_CAP)

      let queryVector: number[] | undefined
      if ((requestedMode === 'vector' || requestedMode === 'hybrid' || requestedMode === 'auto') && config.embeddingProvider !== 'none') {
        try {
          const [vector] = await embedTexts(
            config.embeddingProvider,
            config.embeddingBaseUrl,
            config.embeddingModel,
            config.embeddingApiKey,
            [query],
          )
          queryVector = vector
        } catch (error) {
          // A configured local model that cannot load (weights deleted, download
          // failed) is a configuration problem, not a transient failure — surface
          // it instead of silently degrading to lexical (the user believes hybrid
          // is on). Remote providers still degrade on transient failures.
          if (config.embeddingProvider === 'local') {
            throw new Error(
              `local embedding model is unavailable (${error instanceof Error ? error.message : String(error)}); `
              + 'download it in Settings → Local Models, or switch the embedding provider',
            )
          }
          this.ctx.logger.warn(`knowledge: embedding failed, using lexical retrieval: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const useVector = queryVector !== undefined && requestedMode !== 'lexical'
      const filterList = filterDocIds !== undefined ? [...filterDocIds] : undefined
      let ranked: RankedHit[] = []
      const byId = new Map<string, KnowledgeChunk>()
      let total = 0
      if (useVector) {
        const vec = await lane.vector(queryVector!, scope, poolSize, filterList)
        total = Math.max(total, vec.total)
        for (const hit of vec.hits) byId.set(hit.id, hit)
        if (requestedMode === 'vector') {
          ranked = vec.hits.map(hit => ({ id: hit.id, score: hit.score, vectorScore: hit.score }))
        } else {
          // Hybrid/auto: fuse both lanes with Reciprocal Rank Fusion; the
          // vector lane carries the configured relative weight.
          const lex = await lane.lexical(query, scope, poolSize, filterList)
          total = Math.max(total, lex.total)
          for (const hit of lex.hits) if (!byId.has(hit.id)) byId.set(hit.id, hit)
          const vectorOrder = vec.hits.map(hit => hit.id)
          const lexicalOrder = lex.hits.map(hit => hit.id)
          const vectorWeight = config.rrfVectorWeight
          const fused = reciprocalRankFusion([vectorOrder, lexicalOrder], [vectorWeight, 1])
          const maxFused = (vectorWeight + 1) / (RRF_K + 1)
          const vectorScores = new Map(vec.hits.map(hit => [hit.id, hit.score]))
          const lexicalScores = new Map(lex.hits.map(hit => [hit.id, hit.score]))
          ranked = [...new Set([...vectorOrder, ...lexicalOrder])].map(id => ({
            id,
            score: (fused.get(id) ?? 0) / maxFused,
            vectorScore: vectorScores.get(id),
            lexicalScore: lexicalScores.get(id),
          }))
        }
      } else {
        const lex = await lane.lexical(query, scope, poolSize, filterList)
        total = lex.total
        for (const hit of lex.hits) byId.set(hit.id, hit)
        ranked = lex.hits.map(hit => ({ id: hit.id, score: hit.score, lexicalScore: hit.score }))
      }

      ranked.sort((a, b) => b.score - a.score)
      if (request.mmr ?? config.mmrDiversity > 0) {
        if (config.mmrDiversity > 0 && queryVector !== undefined) {
          ranked = maximalMarginalRelevance(ranked, byId, queryVector, config.mmrDiversity, Math.max(topK * 3, 12))
        }
      }
      return this.finishSearch(store, config, query, requestedMode, ranked, byId, topK, threshold, total, startedAt)
    }

    const chunks = (request.baseId !== undefined
      ? store.listChunks(request.baseId)
      : request.baseIds !== undefined && request.baseIds.length > 0
        ? request.baseIds.flatMap(id => store.listChunks(id))
        : store.listBases().flatMap(base => store.listChunks(base.id)))
      .filter(chunk => filterDocIds === undefined || filterDocIds.has(chunk.docId))
    if (chunks.length === 0) return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] }

    const byId = new Map(chunks.map(chunk => [chunk.id, chunk]))
    const candidates = chunks.map(chunk => ({
      id: chunk.id,
      text: chunkSearchText(chunk),
      embedding: chunk.embedding,
    }))

    let queryVector: number[] | undefined
    if (requestedMode !== 'lexical' && config.embeddingProvider !== 'none') {
      try {
        const [vector] = await embedTexts(
          config.embeddingProvider,
          config.embeddingBaseUrl,
          config.embeddingModel,
          config.embeddingApiKey,
          [query],
        )
        queryVector = vector
      } catch (error) {
        // See the lane path: a broken local model must not silently degrade.
        if (config.embeddingProvider === 'local') {
          throw new Error(
            `local embedding model is unavailable (${error instanceof Error ? error.message : String(error)}); `
            + 'download it in Settings → Local Models, or switch the embedding provider',
          )
        }
        this.ctx.logger.warn(`knowledge: embedding failed, using lexical retrieval: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Retrieval produces a candidate pool; rerank (if configured) re-scores it
    // before the threshold + Top K cut, exactly like Cherry Studio's pipeline.
    const poolSize = Math.min(chunks.length, Math.max(topK * 4, 20))
    const ranked = rank(query, candidates, {
      mode: requestedMode,
      topK: poolSize,
      threshold: 0,
      mmr: request.mmr ?? config.mmrDiversity > 0,
      mmrLambda: config.mmrDiversity,
      queryVector,
    })
    return this.finishSearch(store, config, query, requestedMode, ranked, byId, topK, threshold, chunks.length, startedAt)
  }

  /** Shared tail: rerank (optional), threshold + top-K cut, and hit mapping. */
  private async finishSearch(
    store: Store,
    config: KnowledgeConfig,
    query: string,
    requestedMode: SearchMode,
    initial: RankedHit[],
    byId: ReadonlyMap<string, KnowledgeChunk>,
    topK: number,
    threshold: number,
    total: number,
    startedAt: number,
  ): Promise<SearchResult> {
    let ranked = initial
    let reranked = false
    if (config.rerankModel.trim() !== '' && ranked.length > 1) {
      try {
        const pool = ranked.map(hit => ({ id: hit.id, text: chunkSearchText(byId.get(hit.id)!)}))
        const scores = await rerankCandidates(
          config.rerankBaseUrl,
          config.rerankModel,
          config.rerankApiKey,
          query,
          pool,
        )
        ranked = ranked.map(hit => ({
          ...hit,
          score: scores.get(hit.id) ?? hit.score,
        }))
        ranked.sort((a, b) => b.score - a.score)
        reranked = true
      } catch (error) {
        this.ctx.logger.warn(`knowledge: rerank failed, keeping retrieval order: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const hits: SearchHit[] = ranked
      // Cherry semantics: the threshold filters only reranked `relevance` scores;
      // raw BM25/hybrid ranking scores are never threshold-filtered.
      .filter(hit => (reranked ? hit.score >= threshold : true))
      .slice(0, topK)
      .map(hit => {
        const chunk = byId.get(hit.id)
        if (chunk === undefined) return undefined
        return {
          chunkId: chunk.id,
          docId: chunk.docId,
          baseId: chunk.baseId,
          documentTitle: store.getDocument(chunk.docId)?.title ?? chunk.docId,
          ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
          index: chunk.index,
          text: chunk.text,
          ...(config.siblingChunks > 0 ? { siblingContext: siblingContextOf(store, chunk, config.siblingChunks) } : {}),
          score: hit.score,
          ...(hit.vectorScore !== undefined ? { vectorScore: hit.vectorScore } : {}),
          ...(hit.lexicalScore !== undefined ? { lexicalScore: hit.lexicalScore } : {}),
        }
      })
      .filter((hit): hit is SearchHit => hit !== undefined)

    return {
      query,
      mode: effectiveMode(requestedMode, ranked),
      total,
      reranked,
      elapsedMs: Date.now() - startedAt,
      hits,
    }
  }

  // ── internal ──────────────────────────────────────────────────────────────

  /**
   * How many parse+ingest tasks may run concurrently per base (Cherry Studio:
   * 5, on a per-base queue). Local-model inference no longer constrains this:
   * it runs in a dedicated worker thread (see embed.ts), exactly like Cherry's
   * own-worker embedding service.
   */
  private static readonly INGEST_CONCURRENCY = 5

  private ingestConcurrency(): number {
    return KnowledgeService.INGEST_CONCURRENCY
  }

  /** Queue one parse+ingest task behind a per-base worker pool (Cherry's job queue). */
  private enqueueIngest(baseId: string, task: () => Promise<void>): void {
    let entry = this.ingestQueues.get(baseId)
    if (entry === undefined) {
      entry = { pending: [], running: 0 }
      this.ingestQueues.set(baseId, entry)
    }
    entry.pending.push(task)
    this.pumpIngestQueue(baseId)
  }

  private pumpIngestQueue(baseId: string): void {
    const entry = this.ingestQueues.get(baseId)
    if (entry === undefined) return
    const concurrency = this.ingestConcurrency()
    while (entry.running < concurrency && entry.pending.length > 0) {
      const task = entry.pending.shift()
      if (task === undefined) break
      entry.running += 1
      void task().finally(() => {
        entry.running -= 1
        this.pumpIngestQueue(baseId)
      })
    }
    if (entry.running === 0 && entry.pending.length === 0) this.ingestQueues.delete(baseId)
  }

  /** Serialize a read-then-write section per base (dedup check + first persist). */
  private withBaseWriteLock<T>(baseId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.baseWriteChains.get(baseId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.baseWriteChains.set(baseId, run.then(() => undefined, () => undefined))
    return run
  }

  /**
   * Resolve once every queued/active ingest task has settled (all bases).
   * Pipeline/test helper — the HTTP surface never needs it because the client
   * polls /indexing-status. Throws when the tasks do not drain in time.
   * The initial 25ms tick lets a fire-and-forget task (e.g. the in-place
   * backfill after a model change) reach its first indexing entry before the
   * first busy() probe, avoiding a false "idle".
   */
  async waitForIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    await new Promise(resolve => setTimeout(resolve, 25))
    const busy = (): boolean =>
      this.indexing.size > 0
      || [...this.ingestQueues.values()].some(entry => entry.running > 0 || entry.pending.length > 0)
    while (busy()) {
      if (Date.now() > deadline) throw new Error('knowledge: ingest tasks did not settle in time')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  private async ingestDocument(input: {
    baseId: string
    title: string
    sourceType: DocumentSourceType
    fileName?: string
    mimeType?: string
    url?: string
    parentDirectoryId?: string
    text: string
    /** Base-relative path of the persisted original source bytes (file docs). */
    rawFilePath?: string
    /** Pre-created placeholder id (already stored, shown while embedding). */
    placeholderId?: string
  }): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    const config = this.getConfigFor(input.baseId)
    const contentHash = sha256(input.text)
    const pieces = chunkText(input.text, config.chunkSize, config.chunkOverlap, {
      smartChunk: config.smartChunk,
      separator: config.chunkSeparator,
    })
    // Dedup check + first persist run under the per-base write lock: concurrent
    // imports of identical content must not both pass the check (Cherry guards
    // the same read-then-write with its per-base mutation lock).
    const half = await this.withBaseWriteLock(input.baseId, async () => {
      for (const doc of store.listDocuments(input.baseId)) {
        if (doc.id === input.placeholderId) continue
        if (doc.contentHash === contentHash) {
          throw new Error(`duplicate document: "${doc.title}" already contains identical content`)
        }
      }
      const docId = input.placeholderId ?? crypto.randomUUID()
      const prior = input.placeholderId !== undefined ? store.getDocument(docId) : undefined
      const createdAt = prior?.createdAt ?? Date.now()
      // Persist the document (with its source text) BEFORE embedding starts and
      // mark it incomplete: a crash mid-embedding then leaves a recoverable
      // record — startup recovery re-runs the embed with hash reuse, which only
      // re-embeds the batches that never landed. Without this write a crash
      // would leave either a raw placeholder (no text to rebuild from) or an
      // old complete record, both losing the in-flight work.
      const halfDoc: KnowledgeDocument = {
        id: docId,
        baseId: input.baseId,
        title: input.title,
        sourceType: input.sourceType,
        ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.parentDirectoryId !== undefined ? { parentDirectoryId: input.parentDirectoryId } : {}),
        ...(input.rawFilePath !== undefined ? { rawFilePath: input.rawFilePath } : {}),
        contentHash,
        rawText: input.text,
        charCount: input.text.length,
        tokenCount: estimateTokens(input.text),
        chunkCount: 0,
        incomplete: true,
        createdAt,
        updatedAt: Date.now(),
      }
      await store.putDocument(halfDoc)
      return halfDoc
    })
    const { chunks, embeddingError } = await this.buildChunks(input.baseId, half.id, input.title, input.text, config, pieces, batch => store.putChunkBatch(batch))
    const document: KnowledgeDocument = {
      ...half,
      chunkCount: chunks.length,
      ...(embeddingError !== undefined ? { embeddingError } : {}),
      updatedAt: Date.now(),
    }
    await store.putDocument(document)
    await store.putChunks(chunks)
    this.indexing.delete(half.id)
    await this.touchBase(input.baseId)
    return document
  }

  private async buildChunks(
    baseId: string,
    docId: string,
    title: string,
    text: string,
    config: KnowledgeConfig,
    pieces?: readonly ChunkPiece[],
    onBatch?: (chunks: KnowledgeChunk[]) => Promise<void>,
  ): Promise<{ chunks: KnowledgeChunk[]; embeddingError?: string }> {
    let slices: ReadonlyArray<ChunkPiece & { embedding?: number[] }>
    if (pieces !== undefined) {
      slices = pieces
    } else if (config.semanticChunk) {
      // Semantic chunking: embed paragraph-level segments, merge adjacent
      // similar ones (length-weighted mean vector — no extra embedding pass).
      // Segment embedding is best-effort: any failure falls back to the
      // regular chunker and the normal embedding flow below still runs.
      const segments = splitSemanticSegments(text, { separator: config.chunkSeparator })
      let merged: Array<ChunkPiece & { embedding?: number[] }> | null = null
      if (segments.length > 0 && config.embeddingProvider !== 'none') {
        try {
          const vectors: Array<number[] | undefined> = []
          const batchSize = Math.max(1, config.embeddingBatchSize)
          for (let i = 0; i < segments.length; i += batchSize) {
            const batch = segments.slice(i, i + batchSize)
            const embedded = await this.embedTextsOnce(config, batch.map(segment => segment.text))
            for (const vector of embedded) vectors.push(vector)
          }
          merged = mergeSemanticSegments(segments, vectors, config.chunkSize, config.semanticChunkThreshold)
        } catch (error) {
          this.ctx.logger.warn(`knowledge: semantic chunking embedding failed, using regular chunker: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      slices = merged !== null && merged.length > 0 ? merged : chunkText(text, config.chunkSize, config.chunkOverlap, {
        smartChunk: config.smartChunk,
        separator: config.chunkSeparator,
      })
    } else {
      slices = chunkText(text, config.chunkSize, config.chunkOverlap, {
        smartChunk: config.smartChunk,
        separator: config.chunkSeparator,
      })
    }
    // Token budget: oversized chunks split at preferred boundaries (Cherry's
    // refineChunksByTokenLimit) so local models never see inputs past their
    // context window.
    if (config.chunkTokenLimit > 0) {
      slices = refineChunksByTokenLimit(slices, config.chunkTokenLimit, estimateTokens)
    }
    const chunks: KnowledgeChunk[] = slices.map((piece, index) => ({
      id: crypto.randomUUID(),
      docId,
      baseId,
      index,
      text: piece.text,
      ...(piece.heading !== undefined ? { heading: piece.heading } : {}),
      ...(piece.embedding !== undefined ? { embedding: piece.embedding } : {}),
      context: piece.heading !== undefined ? `${title} > ${piece.heading}` : title,
    }))
    let embeddingError: string | undefined
    if (config.embeddingProvider !== 'none' && chunks.length > 0) {
      const key = embeddingKey(config)
      this.indexing.set(docId, { baseId, title, phase: 'embedding', total: chunks.length, progress: 0 })
      try {
        // Library-wide vector reuse (Cherry's decision A4): chunks whose search
        // text is byte-identical to a chunk already stored under the SAME
        // embedding model get that stored vector; only the missing hashes hit
        // the embedding API. This covers re-chunking after a chunk-size change,
        // reindexing, and re-importing text already indexed elsewhere — the
        // reuse key is the hash of the exact text the model sees, so an equal
        // hash guarantees an equal vector.
        const hashes = chunks.map(chunk => hashEmbeddingText(chunkSearchText(chunk)))
        const stored = key !== undefined
          ? this.requireStore().listEmbeddingVectorsByHashes(hashes, key)
          : new Map<string, number[]>()
        // Cherry's `assertEmbeddingVectors`: one consistent width per batch and
        // it must match the width already stored under this model — a switched
        // model/维度 would silently corrupt every downstream cosine search.
        const storedDimension = [...stored.values()][0]?.length
        const need: number[] = []
        const needTexts: string[] = []
        for (let i = 0; i < chunks.length; i += 1) {
          // Semantic merging already produced this chunk's vector (mean of its
          // segments) — tag the model and skip the API call.
          if (chunks[i].embedding !== undefined && key !== undefined) {
            chunks[i] = { ...chunks[i], embeddingModel: key }
            continue
          }
          const cached = stored.get(hashes[i])
          if (cached !== undefined) {
            chunks[i] = { ...chunks[i], embedding: cached, ...(key !== undefined ? { embeddingModel: key } : {}) }
          } else {
            need.push(i)
            needTexts.push(chunkSearchText(chunks[i]))
          }
        }
        // Embed in batches and persist every finished batch as it lands: a
        // crash mid-embedding then leaves each completed batch in the store
        // (onBatch → putChunkBatch), so startup recovery resumes from the
        // persisted state — hash reuse re-embeds only the missing batches.
        // The local in-process model is capped at 8 chunks per call (Cherry
        // uses 10) so one forward pass never allocates a huge intermediate
        // tensor in the shared main-process WASM heap.
        const batchSize = config.embeddingProvider === 'local'
          ? Math.min(config.embeddingBatchSize, 8)
          : config.embeddingBatchSize
        for (let i = 0; i < need.length; i += batchSize) {
          const batch = need.slice(i, i + batchSize)
          const batchTexts = needTexts.slice(i, i + batchSize)
          const vectors = await this.embedTextsOnce(config, batchTexts)
          // Same-width guarantee across the whole batch (a provider mixing
          // widths would poison every vector comparison in the store).
          const widths = new Set(vectors.map(vector => vector.length))
          if (widths.size > 1) {
            throw new Error(`embedding returned mixed vector dimensions: ${[...widths].join(', ')}`)
          }
          const width = vectors[0]?.length ?? 0
          if (width === 0) throw new Error('embedding returned empty vectors')
          if (storedDimension !== undefined && storedDimension !== width) {
            throw new Error(`embedding vector dimension ${width} does not match the ${storedDimension} already stored for model "${key}" — switch back or reindex the base`)
          }
          const done: KnowledgeChunk[] = []
          for (let j = 0; j < batch.length; j += 1) {
            const index = batch[j]
            chunks[index] = { ...chunks[index], embedding: vectors[j], ...(key !== undefined ? { embeddingModel: key } : {}) }
            done.push(chunks[index])
          }
          if (onBatch !== undefined) await onBatch(done)
          this.indexing.set(docId, { baseId, title, phase: 'embedding', total: need.length, progress: Math.round((Math.min(i + batch.length, need.length) / need.length) * 100) })
        }
      } catch (error) {
        embeddingError = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`knowledge: embedding during import failed, storing lexical-only chunks: ${embeddingError}`)
      } finally {
        this.indexing.delete(docId)
      }
    }
    return { chunks, embeddingError }
  }

  /** Embed one batch through the configured provider (empty input → empty output). */
  private async embedTextsOnce(config: KnowledgeConfig, texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return embedTexts(
      config.embeddingProvider,
      config.embeddingBaseUrl,
      config.embeddingModel,
      config.embeddingApiKey,
      texts,
    )
  }

  /** Bump the base's updatedAt so the data view's "更新于" stays meaningful. */
  private async touchBase(baseId: string): Promise<void> {
    const store = this.requireStore()
    const base = store.getBase(baseId)
    if (base !== undefined) await store.putBase({ ...base, updatedAt: Date.now() })
  }

  private requireStore(): Store {
    if (this.store === undefined) throw new Error('knowledge store is not ready')
    return this.store
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function chunkSearchText(chunk: KnowledgeChunk): string {
  return chunk.context !== undefined && chunk.context.length > 0
    ? `${chunk.context}\n${chunk.text}`
    : chunk.text
}

/** Stable identifier for the embedding source, used to detect model changes. */
function embeddingKey(config: KnowledgeConfig): string | undefined {
  if (config.embeddingProvider === 'none') return undefined
  // `embedTexts` falls back to the default local model when the field is empty;
  // mirror that so the key matches what actually produced the vectors.
  const model = config.embeddingModel.trim() === '' && config.embeddingProvider === 'local'
    ? DEFAULT_LOCAL_MODEL
    : config.embeddingModel.trim()
  if (model === '') return undefined
  return `${config.embeddingProvider}:${model}`
}

function effectiveMode(requested: SearchMode, ranked: readonly RankedHit[]): SearchMode {
  if (requested === 'vector' || requested === 'lexical') return requested
  const hybrid = ranked.some(hit => hit.vectorScore !== undefined && hit.lexicalScore !== undefined)
  if (requested === 'hybrid') return hybrid ? 'hybrid' : 'lexical'
  // auto
  return hybrid ? 'hybrid' : 'lexical'
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}

function reconstructFromChunks(chunks: KnowledgeChunk[]): string {
  return chunks
    .slice()
    .sort((a, b) => a.index - b.index)
    .map(chunk => chunk.text)
    .join('\n\n')
}

/**
 * Sibling context of a search hit: the `radius` chunks before and after it in
 * the same document, in reading order, each prefixed with its heading path so
 * the caller can see where the excerpt sits. Empty when the chunk has no
 * neighbours. This is the "full paragraph" a RAG answer needs — a bare chunk
 * often cuts a sentence mid-way, and the neighbouring chunks carry the rest.
 */
function siblingContextOf(store: Store, chunk: KnowledgeChunk, radius: number): string {
  const neighbours = store.listChunksByIndexRange(chunk.docId, chunk.index - radius, chunk.index + radius)
  const parts: string[] = []
  for (const sibling of neighbours) {
    if (sibling.id === chunk.id) continue
    const heading = sibling.heading !== undefined ? `[${sibling.heading}] ` : ''
    parts.push(`${heading}${sibling.text}`)
  }
  return parts.join('\n\n')
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Drop empty-string config fields so a base only stores real overrides. */
function compactBaseConfig(config: BaseConfig): BaseConfig {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      if (value.trim().length > 0) next[key] = value
    } else if (typeof value === 'boolean') {
      next[key] = value
    } else if (value !== undefined && Number.isFinite(value)) {
      next[key] = value
    }
  }
  return next as BaseConfig
}

/** Merge a per-base config patch; an empty string clears the override (inherit global). */
function mergeBaseConfig(existing: BaseConfig | undefined, patch: BaseConfig): BaseConfig | undefined {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string' && value.trim() === '') {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }
  return merged as BaseConfig
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64')
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** A safe file extension (leading dot, alphanumeric) for the raw store, from an upload name. */
function safeRawExtension(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '.bin'
}

/** The extension of a stored raw file path (`.../<docId><ext>`). */
function rawExtensionOf(relativePath: string): string {
  const ext = extname(relativePath).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '.bin'
}

/** Hosts that must never be fetched by URL import — loopback, link-local,
 *  and RFC1918 private ranges. Blocks the classic SSRF targets (metadata
 *  endpoints, internal services); DNS-rebinding is outside this check (the
 *  plugin trusts the host's resolver for public names). */
const BLOCKED_URL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '[::]',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
])

function isBlockedUrlHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_URL_HOSTS.has(host)) return true
  // IPv4 private + link-local ranges, including `127.0.0.0/8` variants.
  if (/^127\./.test(host)) return true
  if (/^(10\.|192\.168\.)/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^0\./.test(host)) return true
  return false
}

async function fetchHtml(url: string): Promise<string> {
  // Manual redirect handling: `fetch` follows redirects by default, which
  // would let a public page 302 to a loopback/private address and bypass the
  // SSRF check below — every hop is validated here instead.
  let current = url
  for (let hop = 0; hop <= 5; hop += 1) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      throw new Error(`invalid URL: ${current}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL protocol not allowed: ${parsed.protocol}`)
    }
    if (isBlockedUrlHost(parsed.hostname)) {
      throw new Error(`URL host not allowed: ${parsed.hostname}`)
    }
    const response = await httpFetch(parsed.toString(), {
      method: 'GET',
      headers: { 'user-agent': 'dsh-knowledge/0.1 (+knowledge-base-import)' },
      timeoutMs: 30000,
      redirect: 'manual',
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) throw new Error(`URL redirect without Location (HTTP ${response.status})`)
      current = new URL(location, parsed).toString()
      continue
    }
    if (!response.ok) throw new Error(`URL fetch failed: HTTP ${response.status}`)
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== '' && contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      throw new Error(`URL did not return HTML (content-type: ${contentType || 'unknown'})`)
    }
    return response.text()
  }
  throw new Error('URL redirect limit exceeded')
}

/** Lowercased extensions accepted by addFileDocument (defensive gate; the UI filters first). */
const SUPPORTED_DOCUMENT_EXTENSION_SET = new Set<string>(SUPPORTED_DOCUMENT_EXTENSIONS)

/** Dot-prefixed forms for the host-side directory scan (Cherry's directory import has no cap). */
const DIRECTORY_EXTENSIONS = new Set(SUPPORTED_DOCUMENT_EXTENSIONS.map(ext => `.${ext}`))

const DIRECTORY_MAX_FILES = 500
const DIRECTORY_MAX_DEPTH = 8

/** Recursively collect supported files under a directory (bounded). */
async function scanDirectory(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > DIRECTORY_MAX_DEPTH || found.length >= DIRECTORY_MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      throw new Error(`cannot read directory ${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const entry of entries) {
      if (found.length >= DIRECTORY_MAX_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile() && DIRECTORY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(full)
      }
    }
  }
  await walk(root, 0)
  return found
}

export default KnowledgeService
