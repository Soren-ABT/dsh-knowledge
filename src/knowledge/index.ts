/**
 * The host knowledge service (`ctx.knowledge`): durable bases/documents/chunks
 * over `ctx.storageDomain`, heading-aware chunking with context injection,
 * batched embeddings, hybrid retrieval (BM25 + vector + MMR), deduplication,
 * reindexing, URL import, and statistics — plus a JSON HTTP surface.
 * @module dsh-knowledge/knowledge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { chunkText, mergeSemanticSegments, refineChunksByTokenLimit, splitSemanticSegments } from './chunk.js'
import type { ChunkPiece } from './chunk.js'
import { composeContextWindow, estimateContextTokens, serializeContextWindow } from './context.js'
import { Config, resolveConfig, resolveConfigFor } from './config.js'
import type { ConfigOverrides } from './domain.js'
import {
  DEFAULT_LOCAL_MODEL,
  disposeLocalModelWorker,
  embedTexts,
  expandHomePath,
  getLocalModelStatus,
  hasActiveLocalModelDownload,
  isLocalModelDownloaded,
  localModelCacheDir,
  setHfEndpoint,
  setLocalModelCacheDir,
  setLocalWorkerIdleTimeoutMs,
} from './embed.js'
import type { LocalModelStatus } from './embed.js'
import { cancelLocalModelDownload, deleteLocalModel, downloadLocalModel, hasActiveLocalRerankDownload, listLocalModels, LOCAL_MODELS, registerCustomLocalReranker, selfTestLocalModel } from './localModels.js'
import type { LocalModelSummary } from './localModels.js'
import { disposeLocalRerankProcess, setLocalRerankIdleTimeoutMs } from './local-rerank.js'
import { downloadOcrModels, disposeOcrWorker, getOcrModelStatus, removeOcrModels, type OcrModelStatus } from './ocr.js'
import { httpFetch } from './net.js'
import { knowledgeRoute } from './http.js'
import { SUPPORTED_DOCUMENT_EXTENSIONS, extractHtmlDocument, extractFromHtml, extensionOf, parseDocumentBuffer } from './parse.js'
import { rank } from './retrieval.js'
import { maximalMarginalRelevance, reciprocalRankFusion, RRF_K } from './retrieval.js'
import type { RankedHit } from './retrieval.js'
import { rerankCandidates, rerankErrorDetail, rerankTechnicalMessage } from './rerank.js'
import { hashEmbeddingText } from './chunkdb.js'
import { openStore } from './store.js'
import type { StorageDomainFacility, Store } from './store.js'
import {
  activeOllamaPulls as activeOllamaPullsHelper,
  cancelOllamaPull as cancelOllamaPullHelper,
  deleteOllamaModel as deleteOllamaModelHelper,
  getOllamaPullStatus as getOllamaPullStatusHelper,
  listOllamaModels as listOllamaModelsHelper,
  pullOllamaModel as pullOllamaModelHelper,
  type OllamaPullStatus,
} from './ollama.js'
import type {
  AddFileDocumentRequest,
  AddFilesRequest,
  AddFilesResult,
  AddTextDocumentRequest,
  BaseConfig,
  BaseSourceInfo,
  BaseStats,
  BaseSummary,
  CreateBaseRequest,
  ContextWindow,
  DocumentDetail,
  DocumentSourceType,
  DocumentSummary,
  EmbeddingProvider,
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
  RerankErrorDetail,
  RerankStatus,
  UpdateBaseRequest,
} from './types.js'

export type * from './types.js'
export { Config } from './config.js'
export { knowledgeDomainSpec } from './domain.js'
export { chunkText } from './chunk.js'
export { composeContextWindow, estimateContextTokens, serializeContextWindow } from './context.js'
export { embedTexts, getLocalModelStatus, DEFAULT_LOCAL_MODEL } from './embed.js'
export { tokenize, cosineSimilarity, rank } from './retrieval.js'

/** Per-call execution controls that are deliberately kept out of the public
 * search request/HTTP contract. Proactive retrieval uses these controls to
 * obtain lexical candidates without accidentally invoking a configured
 * reranker. */
export interface SearchExecutionOptions {
  readonly rerank?: 'configured' | 'skip'
  readonly signal?: AbortSignal
  /** Absolute deadline for synchronous retrieval lanes. Internal callers use
   * this alongside signal so SQLite can interrupt itself while JS is blocked. */
  readonly deadlineAt?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: KnowledgeService
  }
}

/** User-facing message for a local-model embedding failure. Classifies the
 *  model-cache reality (checked from disk) so a broken binding/runtime error
 *  is NOT misrouted to "download the model" — the files may be intact and the
 *  fault is a worker/binding reload (e.g. "Module did not self-register"). */
export function localEmbeddingErrorText(onDisk: boolean, detail: string): string {
  if (onDisk) {
    return `local embedding model failed to load (${detail}); ` 
      + 'the model files are present but the runtime could not start — '
      + 'restart the service or retry later. If it persists, check the local model runtime install.'
  }
  return `local embedding model is unavailable (${detail}); `
    + 'download it in Settings → Local Models, or switch the embedding provider'
}

/** Build the classified local-model failure error for the given config. */
async function localEmbeddingError(config: KnowledgeConfig, error: unknown): Promise<Error> {
  const detail = error instanceof Error ? error.message : String(error)
  const modelId = config.embeddingModel.trim() || DEFAULT_LOCAL_MODEL
  const onDisk = await isLocalModelDownloaded(modelId).catch(() => false)
  return new Error(localEmbeddingErrorText(onDisk, detail))
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
  local: LOCAL_MODELS.filter(model => model.kind === 'embedding').map(model => model.id),
  rerank: [
    'jina-reranker-v2-base-multilingual',
    'BAAI/bge-reranker-v2-m3',
    'bge-reranker-base',
    'bce-reranker-base_v1',
    // Local cross-encoder: download it in Settings → Local Models, then use
    // the `local:` prefix (e.g. `local:Xenova/bge-reranker-base`).
    'local:Xenova/bge-reranker-base',
  ],
  // Ollama registry recommendations (embedding + vision), mirroring the local
  // model registry posture: real, downloadable model names for the Ollama API.
  ollamaEmbedding: [
    'nomic-embed-text',
    'bge-m3',
    'qwen3-embedding:0.6b',
    'mxbai-embed-large',
    'snowflake-arctic-embed',
  ],
  ollamaVision: [
    'llava',
    'qwen2.5vl:7b',
    'llama3.2-vision:11b',
    'minicpm-v:8b',
  ],
} as const

/** Candidate-pool cap for SQL retrieval lanes, bounding FTS + brute-force vector scans. */
const LANE_CANDIDATE_CAP = 200

/** Max characters one deep-read slice returns (Cherry's CONCEPT_READ_MAX_CHARS). */
const CONCEPT_READ_MAX_CHARS = 20_000
/** Characters of context kept on each side of a grep match in its snippet (Cherry's pad). */
const CONCEPT_GREP_SNIPPET_PAD = 60
/** Max characters of any single line grep runs its pattern over (Cherry's catastrophic-backtracking guard). */
const CONCEPT_GREP_MAX_LINE_CHARS = 2000
/** How long a finished job's final progress stays visible (Cherry's linger TTL). */
const PROGRESS_LINGER_TTL_MS = 60_000
/** Embedding batch retry policy (Cherry's job retry contract). */
const EMBED_MAX_ATTEMPTS = 3
const EMBED_RETRY_BASE_DELAY_MS = 1000
const EMBED_RETRY_MAX_DELAY_MS = 30_000

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
  private readonly indexing = new Map<string, { baseId: string; title: string; phase: 'parsing' | 'embedding'; total: number; progress: number; controller?: AbortController }>()
  /**
   * Progress values that linger after a job exits (Cherry's 60s TTL), so the
   * list keeps showing the final percentage until the poll observes the
   * terminal status instead of blanking mid-frame. Purely a display aid —
   * every guard still consults {@link indexing}, never this map.
   */
  private readonly progressLinger = new Map<string, { baseId: string; title: string; phase: 'parsing' | 'embedding'; progress: number; expireAt: number }>()
  // Cherry Studio parity: per-base worker pool (Cherry's knowledge jobs run at
  // defaultConcurrency 5 on a per-base queue). Rows are created up front and
  // flip status as the queued parse+ingest tasks run in the background.
  private readonly ingestQueues = new Map<string, { pending: Array<() => Promise<void>>; running: number }>()
  // Per-base write chain guarding dedup-check + first persist (read-then-write),
  // so two concurrent imports of identical content cannot both pass the check.
  private readonly baseWriteChains = new Map<string, Promise<unknown>>()
  /** Last rerank failure code per model; only state transitions are logged. */
  private readonly rerankLogState = new Map<string, string>()

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
    // Reapply the RUNTIME overrides persisted in the domain (they survive
    // restarts): without this, a saved localModelCacheDir / hfEndpoint was
    // only live after the next explicit save — model downloads/checks and the
    // mirror would silently use the deployment defaults until then.
    const resolved = this.getConfig()
    setHfEndpoint(resolved.hfEndpoint)
    setLocalModelCacheDir(resolved.localModelCacheDir)
    setLocalWorkerIdleTimeoutMs(resolved.localWorkerIdleTimeoutMs)
    setLocalRerankIdleTimeoutMs(resolved.localWorkerIdleTimeoutMs)
    // One-time compatibility path for caches created before readiness markers:
    // validate only rerankers that are actually configured, in the background.
    const configuredLocalRerankers = new Set<string>()
    for (const effective of [resolved, ...store.listBases().map(base => resolveConfigFor(this.baseConfig, store.getConfigOverrides(), base.config))]) {
      if (effective.rerankModel.startsWith('local:')) {
        const modelId = effective.rerankModel.slice('local:'.length).trim()
        if (modelId !== '') configuredLocalRerankers.add(modelId)
      }
    }
    void listLocalModels().then(models => {
      for (const modelId of configuredLocalRerankers) {
        const model = models.find(entry => entry.id === modelId)
        if (model?.status === 'unhealthy' && model.health === 'unchecked') void selfTestLocalModel(modelId)
      }
    }).catch(() => {})
    this.ctx.effect(() => async () => { await store.close() }, 'knowledge: close store')
    // Terminate the local-model inference worker on teardown so a loaded
    // ~600MB model can never outlive the plugin (Cherry: lifecycle-managed worker).
    this.ctx.effect(() => () => { void disposeLocalModelWorker() }, 'knowledge: dispose local model worker')
    this.ctx.effect(() => () => { void disposeLocalRerankProcess() }, 'knowledge: dispose local rerank process')
    this.ctx.effect(() => () => { void disposeOcrWorker() }, 'knowledge: dispose OCR worker')
    // Resume documents a previous process left mid-embedding: their chunks are
    // partially persisted, so re-running the embed with hash reuse completes
    // them without re-embedding the batches that already landed. (openStore
    // already ran the removal half of the recovery; this second pass is
    // idempotent and only harvests the resume list.) The `resumeInterruptedOnStartup`
    // config gates the automatic re-spend: off marks them failed instead
    // (Cherry's posture — a deliberate app quit must not re-spend the
    // embedding API; the user reindexes manually).
    const resume = store.recoverInterruptedImports(Date.now()).then(async ({ resume: resumeIds }) => {
      if (resumeIds.length === 0) return
      if (!this.getConfig().resumeInterruptedOnStartup) {
        const reason = 'import was interrupted by a shutdown; reindex to resume'
        for (const id of resumeIds) {
          const doc = store.getDocument(id)
          if (doc !== undefined) {
            await store.putDocument({ ...doc, embeddingError: reason, errorCode: 'interrupted', updatedAt: Date.now() })
          }
        }
        this.ctx.logger.info(`knowledge: marked ${resumeIds.length} interrupted import(s) failed (auto-resume disabled)`)
        return
      }
      this.ctx.logger.info(`knowledge: resuming ${resumeIds.length} interrupted import(s)`)
      void this.resumeInterruptedDocuments(resumeIds)
    })
    void resume.catch(error => this.ctx.logger.warn(`knowledge: interrupted-import recovery failed: ${error instanceof Error ? error.message : String(error)}`))
    this.armUrlRefreshTimer()
  }

  // ── scheduled URL refresh (Cherry's snapshot + manual refresh, automated) ──

  private urlRefreshTimer: ReturnType<typeof setInterval> | null = null
  private urlRefreshing = false

  /** Arm the hourly sweep that refreshes URL documents older than `urlRefreshHours`. */
  private armUrlRefreshTimer(): void {
    const hours = this.getConfigFor(undefined).urlRefreshHours
    if (hours <= 0) return
    const run = (): void => {
      if (this.urlRefreshing) return
      this.urlRefreshing = true
      void this.refreshStaleUrls(hours).catch(error => {
        this.ctx.logger.warn(`knowledge: URL refresh sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => { this.urlRefreshing = false })
    }
    // First sweep shortly after startup (imports settle first), then hourly.
    const first = setTimeout(run, 5 * 60_000)
    first.unref?.()
    this.urlRefreshTimer = setInterval(run, 60 * 60_000)
    this.urlRefreshTimer.unref?.()
    this.ctx.effect(() => () => {
      clearTimeout(first)
      if (this.urlRefreshTimer !== null) clearInterval(this.urlRefreshTimer)
    }, 'knowledge: URL refresh timer')
  }

  /** Re-fetch every URL document whose last update predates `hours`; failures are logged, never thrown. */
  private async refreshStaleUrls(hours: number): Promise<void> {
    const store = this.requireStore()
    const cutoff = Date.now() - hours * 3600_000
    const stale: string[] = []
    for (const base of store.listBases()) {
      for (const doc of store.listDocuments(base.id)) {
        if (doc.sourceType === 'url' && doc.url !== undefined && (doc.updatedAt ?? 0) < cutoff) stale.push(doc.id)
      }
    }
    for (const id of stale) {
      try {
        const result = await this.refreshUrlDocument(id)
        if (result.changed) this.ctx.logger.info(`knowledge: URL auto-refreshed: ${result.title}`)
      } catch (error) {
        this.ctx.logger.warn(`knowledge: URL auto-refresh failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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

  /** Emit a structured warning on behalf of model-facing retrieval helpers. */
  warn(message: string): void {
    this.ctx.logger.warn(`knowledge: ${message}`)
  }

  /**
   * Rerank settings for proactive (cross-base) retrieval, which has no single
   * base config: the global rerank model wins; otherwise the first enabled
   * base that configured one. Returns undefined when none is set.
   */
  rerankSettings(): { model: string; baseUrl: string; apiKey: string } | undefined {
    const global = this.getConfig()
    if (global.rerankModel.trim() !== '') {
      return { model: global.rerankModel, baseUrl: global.rerankBaseUrl, apiKey: global.rerankApiKey }
    }
    for (const base of this.enabledBases()) {
      const config = this.getConfigFor(base.id)
      if (!config.autoRetrieve || config.autoRetrieveWeight === 0) continue
      if (config.rerankModel.trim() !== '') {
        return { model: config.rerankModel, baseUrl: config.rerankBaseUrl, apiKey: config.rerankApiKey }
      }
    }
    return undefined
  }

  async setConfig(overrides: ConfigOverrides): Promise<KnowledgeConfig> {
    await this.requireStore().setConfigOverrides(overrides)
    const resolved = this.getConfig()
    // Reapply the mirror switch, model cache dir, and worker idle timeout
    // live, so the panel can change them without a restart.
    setHfEndpoint(resolved.hfEndpoint)
    setLocalModelCacheDir(resolved.localModelCacheDir)
    setLocalWorkerIdleTimeoutMs(resolved.localWorkerIdleTimeoutMs)
    setLocalRerankIdleTimeoutMs(resolved.localWorkerIdleTimeoutMs)
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
   * Resolve the effective search scope for a model call. `undefined` means no
   * ids were configured (every base); an empty array means a non-empty saved
   * selection has gone entirely stale and must fail closed.
   */
  enabledScope(): string[] | undefined {
    const store = this.requireStore()
    const ids = store.getEnabledBaseIds()
    if (ids.length === 0) return undefined
    const existing = new Set(store.listBases().map(base => base.id))
    const valid = ids.filter(id => existing.has(id))
    return valid
  }

  /** Existing bases inside the strict model-invocation scope. */
  enabledBases(): BaseSummary[] {
    const bases = this.listBases()
    const scope = this.enabledScope()
    if (scope === undefined) return bases
    const allowed = new Set(scope)
    return bases.filter(base => allowed.has(base.id))
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
    // Cancel in-flight imports/reindexes under the deleted base (Cherry cancels
    // active jobs before purging): their finishing writes must not recreate
    // rows or chunks under the removed base, and their paid requests abort.
    for (const [docId, active] of [...this.indexing]) {
      if (active.baseId === id) {
        active.controller?.abort()
        this.indexing.delete(docId)
      }
    }
    // Two statements: the base record plus one chunk sweep by base id.
    await store.deleteChunksByBase(id)
    await store.raw?.deleteBase(id)
    await store.deleteBase(id)
    // A whole-base delete frees a large chunk of pages; hand them back to the
    // OS (threshold-gated, so a small base never pays for a VACUUM).
    this.reclaimAfterDelete()
    // Keep a selected id as a stale marker. If it was the last selected base,
    // enabledScope() must resolve to [] (fail closed), never broaden to all.
  }

  async renameBase(id: string, request: UpdateBaseRequest): Promise<KnowledgeBase> {
    const store = this.requireStore()
    const existing = store.getBase(id)
    if (existing === undefined) throw new Error(`knowledge base not found: ${id}`)
    const next: KnowledgeBase = {
      ...existing,
      name: request.name?.trim() || existing.name,
      description: request.description?.trim() ?? existing.description,
      ...(request.group !== undefined && request.group !== null
        ? { group: request.group.trim().length > 0 ? request.group.trim() : undefined }
        : {}),
      ...(request.config !== undefined
        ? { config: mergeBaseConfig(existing.config, request.config) }
        : {}),
      updatedAt: Date.now(),
    }
    // A base moved into a new group must register that group (createBase does;
    // renaming must not leave a group that owns bases but is absent from the
    // sidebar's group list).
    const nextGroup = next.group
    if (nextGroup !== undefined && !store.getGroups().includes(nextGroup)) {
      await store.setGroups([...store.getGroups(), nextGroup])
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
        // in the background (Cherry's enableEmbeddingModel). Cherry gates the
        // commit on the base being backfill-able: an in-flight import/reindex
        // would race the backfill, and a source-less document would leave a
        // model committed with nothing to back it — refuse both up front.
        if (this.indexing.size > 0) {
          throw new Error('有文档正在处理中——请等待导入/重建完成后再启用嵌入模型（Cherry Studio 语义）')
        }
        const documents = store.listDocuments(id)
        const sourceLess = documents.some(doc => doc.sourceType !== 'directory'
          && doc.rawText === undefined && doc.rawFilePath === undefined)
        if (sourceLess) {
          throw new Error('存在无源文本的文档，无法回填向量——请删除后重新添加（Cherry Studio 语义）')
        }
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
      const storedDocCount = documents.reduce((sum, doc) => sum + (doc.rawFilePath !== undefined ? 1 : 0), 0)
      const sourceInfo = baseSourceLines(documents)
      return {
        id: base.id,
        name: base.name,
        description: base.description,
        ...(base.group !== undefined ? { group: base.group } : {}),
        documentCount: documents.length,
        storedDocCount,
        chunkCount,
        charCount,
        tokenCount,
        ...(base.config !== undefined ? { config: base.config } : {}),
        ...(sourceInfo.length > 0 ? { sourceInfo } : {}),
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
      ...(request.parentDirectoryId !== undefined ? { parentDirectoryId: request.parentDirectoryId } : {}),
      text: request.content,
    })
  }

  async addFileDocument(request: AddFileDocumentRequest): Promise<KnowledgeDocument & { skipped?: boolean }> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    // Reject unsupported formats before the row is created (Cherry's
    // `assertSupportedKnowledgeFilePath`): a binary/image/archive must not be
    // decoded into garbage text and imported as a real document.
    if (!SUPPORTED_DOCUMENT_EXTENSION_SET.has(extensionOf(request.fileName))) {
      throw new Error(`Unsupported knowledge file type: ${request.fileName}`)
    }
    // Cherry Studio parity: publish the row FIRST (with "parsing" status) and
    // return immediately; the parse+embed runs on a per-base worker pool
    // (concurrency 5) and the row flips processing → completed/failed as it
    // goes, exactly like Cherry's create-then-index jobs.
    //
    // Conflict resolution, rename suffixing and the placeholder persist all
    // run under the per-base write lock: two concurrent imports of the same
    // file name must not both pass the "taken" check and end up with the same
    // fileName (the rename strategy would silently degrade to keep).
    let fileName = request.fileName
    let title = request.title?.trim() || request.fileName
    const lockResult = await this.withBaseWriteLock(request.baseId, async () => {
      // Re-run the conflict check against the freshest document list (a
      // concurrent add may have landed since the first pass above).
      const conflictStrategyNow = request.conflict ?? this.getConfigFor(request.baseId).conflictStrategy
      if (conflictStrategyNow === 'keep') {
        // Cherry's "keep both" auto-renames; dsh's keep keeps the EXISTING
        // item and skips the incoming duplicate, reporting it via `skipped`
        // so the UI can tell the user instead of silently dropping the file.
        const existing = store.listDocuments(request.baseId).find(doc => doc.fileName === request.fileName)
        if (existing !== undefined) {
          return { skippedDoc: existing }
        }
      } else {
        const existing = store.listDocuments(request.baseId).find(doc => doc.fileName === request.fileName)
        if (existing !== undefined) {
          if (conflictStrategyNow === 'replace') {
            await store.deleteChunks(existing.id, request.baseId)
            if (existing.rawFilePath !== undefined) await store.raw?.delete(existing.rawFilePath)
            await store.deleteDocument(existing.id)
          } else if (conflictStrategyNow === 'detect') {
            throw new ConflictError(`same-name document exists: ${request.fileName} (id ${existing.id}) — re-upload with conflict=replace or conflict=rename`)
          }
        }
      }
      let resolvedFileName = request.fileName
      let resolvedTitle = request.title?.trim() || request.fileName
      if (conflictStrategyNow === 'rename') {
        const taken = new Set(store.listDocuments(request.baseId).map(doc => doc.fileName))
        let candidate = resolvedFileName
        let counter = 1
        while (taken.has(candidate)) {
          const dot = resolvedFileName.lastIndexOf('.')
          const base = dot > 0 ? resolvedFileName.slice(0, dot) : resolvedFileName
          const ext = dot > 0 ? resolvedFileName.slice(dot) : ''
          candidate = `${base}_${counter}${ext}`
          counter += 1
        }
        if (candidate !== resolvedFileName) {
          resolvedFileName = candidate
          resolvedTitle = request.title !== undefined ? `${request.title.trim()}_${counter - 1}` : candidate
        }
      }
      const newDocId = crypto.randomUUID()
      const placeholder: KnowledgeDocument = {
        id: newDocId,
        baseId: request.baseId,
        title: resolvedTitle,
        sourceType: 'file',
        fileName: resolvedFileName,
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
      const newRawFilePath = store.raw !== undefined
        ? await store.raw.write(request.baseId, newDocId, safeRawExtension(resolvedFileName), decodeBase64(request.contentBase64))
        : undefined
      const storedDoc = { ...placeholder, ...(newRawFilePath !== undefined ? { rawFilePath: newRawFilePath } : {}) }
      await store.putDocument(storedDoc)
      return { fileName: resolvedFileName, title: resolvedTitle, docId: newDocId, rawFilePath: newRawFilePath, stored: storedDoc }
    })
    // keep-strategy skip: the duplicate already exists — report it instead of
    // creating a row (the caller surfaces it as "skipped", not as a failure).
    if ('skippedDoc' in (lockResult as { skippedDoc?: KnowledgeDocument })) {
      const skipped = (lockResult as { skippedDoc: KnowledgeDocument }).skippedDoc
      return { ...skipped, skipped: true }
    }
    const { fileName: resolvedFileName, title: resolvedTitle, docId, rawFilePath, stored } = lockResult as {
      fileName: string
      title: string
      docId: string
      rawFilePath?: string
      stored: KnowledgeDocument
    }
    fileName = resolvedFileName
    title = resolvedTitle
    // The task's abort controller: a delete of the row or base aborts the
    // in-flight MinerU batch and embedding requests (Cherry's job cancel).
    const taskController = new AbortController()
    this.indexing.set(docId, { baseId: request.baseId, title, phase: 'parsing', total: 0, progress: 0, controller: taskController })
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
            }, taskController.signal)
          } catch (error) {
            this.ctx.logger.warn(`knowledge: mineru extract failed, falling back to local: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (text === null) {
          text = await parseDocumentBuffer(bytes, fileName, request.mimeType)
        }
        if (text.trim().length === 0) throw new Error('parsed document is empty')
        // Image/table captioning (NexusRAG-style visual intelligence): embedded
        // PDF figures get VLM descriptions appended so charts become searchable.
        // Best-effort — a provider failure leaves the parsed text untouched.
        if (extensionOf(fileName) === 'pdf' && config.imageCaptionProvider !== 'off') {
          try {
            const { captionPdfImages } = await import('./caption.js')
            const captioned = await captionPdfImages(bytes, {
              provider: config.imageCaptionProvider,
              model: config.imageCaptionModel,
              baseUrl: config.imageCaptionBaseUrl,
              apiKey: config.imageCaptionApiKey,
              embeddingBaseUrl: config.embeddingBaseUrl,
            })
            if (captioned !== '') text = `${text}\n${captioned}`
          } catch (error) {
            this.ctx.logger.warn(`knowledge: captioning failed, importing text only: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
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
        }, taskController.signal)
      } catch (error) {
        this.indexing.delete(docId)
        taskController.abort()
        const message = error instanceof Error ? error.message : String(error)
        // The row may have been deleted (or its base removed) while the task
        // was queued or running — never resurrect it (Cherry's deleting-guard).
        const current = store.getDocument(docId)
        if (current === undefined || store.getBase(request.baseId) === undefined) return
        try {
          await store.putDocument({ ...current, embeddingError: message, errorCode: 'parse_failed', updatedAt: Date.now() })
        } catch {
          // best-effort: the row already exists; the status flip is cosmetic
        }
      }
    })
    return stored
  }

  /**
   * Batch file add with Cherry's server-authoritative conflict detection:
   * `conflict: 'detect'` reports every same-name collision (against existing
   * documents AND within the batch) without adding anything; `rename`/`replace`
   * add the whole batch under that strategy. The detect round may omit file
   * contents (names alone suffice); a clean detect returns `clean` so the
   * caller re-submits with contents under the rename strategy.
   */
  async addFiles(request: AddFilesRequest): Promise<AddFilesResult> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    for (const file of request.files) {
      if (!SUPPORTED_DOCUMENT_EXTENSION_SET.has(extensionOf(file.fileName))) {
        throw new Error(`Unsupported knowledge file type: ${file.fileName}`)
      }
    }
    const existingNames = new Set(
      store.listDocuments(request.baseId)
        .filter(doc => doc.sourceType === 'file')
        .map(doc => doc.fileName),
    )
    const seen = new Set<string>()
    const conflicts: string[] = []
    for (const file of request.files) {
      const name = file.fileName
      if (existingNames.has(name) || seen.has(name)) conflicts.push(name)
      seen.add(name)
    }
    const uniqueConflicts = [...new Set(conflicts)]
    if (request.conflict === 'detect') {
      if (uniqueConflicts.length > 0) return { status: 'conflicts', conflicts: uniqueConflicts }
      // No contents in the detect round → nothing to add yet.
      if (request.files.some(file => file.contentBase64 === undefined)) return { status: 'clean' }
    }
    const strategy = request.conflict === 'detect' ? 'rename' : request.conflict
    const accepted: Array<{ id: string; title: string; fileName: string; skipped?: boolean }> = []
    for (const file of request.files) {
      const doc = await this.addFileDocument({
        baseId: request.baseId,
        fileName: file.fileName,
        ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
        ...(request.parentDirectoryId !== undefined ? { parentDirectoryId: request.parentDirectoryId } : {}),
        contentBase64: file.contentBase64 ?? '',
        ...(strategy !== undefined ? { conflict: strategy } : {}),
      })
      accepted.push({
        id: doc.id,
        title: doc.title,
        fileName: doc.fileName ?? doc.title,
        ...(doc.skipped === true ? { skipped: true } : {}),
      })
    }
    return { status: 'added', accepted }
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
        // Cherry's prepare-root: persist a raw copy (base-relative path) so
        // the base stays rebuildable if the source disk changes. The stored
        // path is derived from a fresh uuid (not the source file name) so two
        // roots containing the same relative path can never collide.
        let rawFilePath: string | undefined
        const store = this.requireStore()
        if (store.raw !== undefined) {
          rawFilePath = await store.raw.write(job.baseId, crypto.randomUUID(), safeRawExtension(basename(file)), buffer)
        }
        try {
          await this.ingestDocument({
            baseId: job.baseId,
            title: basename(file),
            sourceType: 'file',
            fileName: basename(file),
            rawFilePath,
            text,
          })
        } catch (error) {
          // A rejected item (e.g. duplicate content) must not leave an
          // orphaned raw copy behind.
          if (rawFilePath !== undefined) await store.raw?.delete(rawFilePath)
          throw error
        }
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
    const store = this.requireStore()
    const rootName = basename(path)
    const rootId = parentDirectoryId ?? (await this.createDirectory(baseId, rootName)).id
    let imported = 0
    let directories = 1
    const errors: Array<{ file: string; error: string }> = []
    // Cherry's pathStorage: the container remembers its source path so a
    // later reindex can rescan the disk and pick up new/removed files.
    const recordSourcePath = async (containerId: string, source: string): Promise<void> => {
      const current = store.getDocument(containerId)
      if (current !== undefined) await store.putDocument({ ...current, sourcePath: source, updatedAt: Date.now() })
    }
    await recordSourcePath(rootId, path)

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
          await recordSourcePath(child.id, full)
          directories += 1
          await walk(full, child.id, depth + 1)
        } else if (entry.isFile() && DIRECTORY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          try {
            const buffer = await readFile(full)
            const text = await parseDocumentBuffer(buffer, basename(full))
            if (text.trim().length === 0) continue
            // Cherry's prepare-root: the base owns a stable copy of every
            // imported file under raw/, so a later reindex rebuilds from the
            // base even if the source disk changes. The stored path is a fresh
            // uuid (not the tree-relative path) so two roots that share a
            // relative path never collide in raw storage.
            let rawFilePath: string | undefined
            if (store.raw !== undefined) {
              rawFilePath = await store.raw.write(baseId, crypto.randomUUID(), safeRawExtension(basename(full)), buffer)
            }
            try {
              await this.ingestDocument({
                baseId,
                title: basename(full),
                sourceType: 'file',
                fileName: basename(full),
                parentDirectoryId: parentId,
                rawFilePath,
                text,
              })
            } catch (error) {
              // A rejected item (e.g. duplicate content) must not leave an
              // orphaned raw copy behind.
              if (rawFilePath !== undefined) await store.raw?.delete(rawFilePath)
              throw error
            }
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

  /** Import a single local file by its absolute path (server-side). */
  async importFileFromPath(baseId: string, filePath: string): Promise<{ imported: boolean; title: string }> {
    const store = this.requireStore()
    if (store.getBase(baseId) === undefined) throw new Error(`knowledge base not found: ${baseId}`)
    const name = basename(filePath)
    if (!SUPPORTED_DOCUMENT_EXTENSION_SET.has(extensionOf(name))) {
      throw new Error(`Unsupported knowledge file type: ${name}`)
    }
    const buffer = await readFile(filePath)
    const text = await parseDocumentBuffer(buffer, name)
    if (text.trim().length === 0) throw new Error(`file is empty or unreadable: ${filePath}`)
    // Persist a stable raw copy (Cherry's "import means copy") so the base
    // stays rebuildable even if the source file changes or disappears. The
    // stored path is a fresh uuid so it never collides with another import of
    // the same file name.
    let rawFilePath: string | undefined
    if (store.raw !== undefined) {
      rawFilePath = await store.raw.write(baseId, crypto.randomUUID(), safeRawExtension(name), buffer)
    }
    try {
      await this.ingestDocument({
        baseId,
        title: name,
        sourceType: 'file',
        fileName: name,
        rawFilePath,
        sourcePath: filePath,
        text,
      })
    } catch (error) {
      // A rejected item (e.g. duplicate content) must not leave an orphaned
      // raw copy behind.
      if (rawFilePath !== undefined) await store.raw?.delete(rawFilePath)
      throw error
    }
    return { imported: true, title: name }
  }

  /**
   * Import a local path (directory tree or single file) by its absolute path,
   * validating that it exists first. Directories reuse the tree import, which
   * records `sourcePath` on every container so reindex rescans the disk.
   */
  async importFromPath(baseId: string, path: string): Promise<{
    kind: 'directory' | 'file'
    imported: number
    errors: Array<{ file: string; error: string }>
  }> {
    const store = this.requireStore()
    if (store.getBase(baseId) === undefined) throw new Error(`knowledge base not found: ${baseId}`)
    const trimmed = path.trim()
    if (trimmed.length === 0) throw new Error('path is required')
    if (!isAbsolute(trimmed)) throw new Error(`path must be absolute: ${trimmed}`)
    let st
    try {
      st = await stat(trimmed)
    } catch {
      throw new Error(`path not found: ${trimmed}`)
    }
    if (st.isDirectory()) {
      const result = await this.importDirectoryTree(baseId, trimmed)
      return { kind: 'directory', imported: result.imported, errors: result.errors }
    }
    if (st.isFile()) {
      await this.importFileFromPath(baseId, trimmed)
      return { kind: 'file', imported: 1, errors: [] }
    }
    throw new Error(`not a file or directory: ${trimmed}`)
  }

  /**
   * Repoint exactly one top-level file or directory source. Source identity is
   * explicit: a base may contain several independent roots of the same kind,
   * and editing one must never redirect its siblings.
   */
  async setBaseSourcePath(baseId: string, sourceId: string, path: string): Promise<{ set: number }> {
    const store = this.requireStore()
    if (store.getBase(baseId) === undefined) throw new Error(`knowledge base not found: ${baseId}`)
    const source = store.getDocument(sourceId)
    if (source === undefined) throw new Error(`source document not found: ${sourceId}`)
    if (source.baseId !== baseId) throw new Error(`source ${sourceId} does not belong to knowledge base ${baseId}`)
    if (source.parentDirectoryId !== undefined) throw new Error('source path can only be changed for a top-level source')
    if (source.sourceType !== 'file' && source.sourceType !== 'directory') {
      throw new Error('source path can only be changed for a file or directory source')
    }
    const trimmed = path.trim()
    if (trimmed.length === 0) throw new Error('path is required')
    if (!isAbsolute(trimmed)) throw new Error(`path must be absolute: ${trimmed}`)
    let st
    try {
      st = await stat(trimmed)
    } catch {
      throw new Error(`path not found: ${trimmed}`)
    }
    if (source.sourceType === 'directory') {
      if (!st.isDirectory()) throw new Error('a directory source must be repointed to a directory')
      await store.putDocument({ ...source, sourcePath: trimmed, updatedAt: Date.now() })
    } else {
      if (!st.isFile()) throw new Error('a file source must be repointed to a file')
      const nextFileName = basename(trimmed)
      if (!SUPPORTED_DOCUMENT_EXTENSION_SET.has(extensionOf(nextFileName))) {
        throw new Error(`Unsupported knowledge file type: ${nextFileName}`)
      }
      // Drop stale MIME metadata so parser dispatch follows the new source's
      // extension. Preserve the user-facing title, which may have been renamed.
      const { mimeType: _staleMimeType, ...withoutMimeType } = source
      await store.putDocument({
        ...withoutMimeType,
        sourcePath: trimmed,
        fileName: nextFileName,
        updatedAt: Date.now(),
      })
    }
    await this.touchBase(baseId)
    return { set: 1 }
  }

  async addUrlDocument(request: ImportUrlRequest): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    if (store.getBase(request.baseId) === undefined) throw new Error(`knowledge base not found: ${request.baseId}`)
    const html = await fetchHtml(request.url)
    const extracted = await extractHtmlDocument(html)
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
      ...(request.parentDirectoryId !== undefined ? { parentDirectoryId: request.parentDirectoryId } : {}),
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
    const extracted = await extractHtmlDocument(html)
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
    // Invalidate any in-flight indexing for this document (Cherry cancels a
    // subtree's jobs before a delete): its finishing writes must not
    // resurrect the row or write chunks under the deleted item, and its
    // paid embedding/MinerU requests must be aborted.
    const active = this.indexing.get(id)
    active?.controller?.abort()
    this.indexing.delete(id)
    // Deleting a directory container also removes its descendants.
    if (existing.sourceType === 'directory') {
      for (const child of store.listDocuments(existing.baseId)) {
        if (child.parentDirectoryId === id) await this.deleteDocumentRecursive(child.id)
      }
    }
    if (existing.rawFilePath !== undefined) await store.raw?.delete(existing.rawFilePath)
    await store.deleteChunks(id, existing.baseId)
    await store.deleteDocument(id)
  }

  /**
   * Throw when the document (or its base) vanished while indexing was in
   * flight — Cherry's deleting-guard: a delete that lands mid-import or
   * mid-reindex must never be resurrected by the finishing writes, and chunks
   * must never land under a deleted base.
   */
  private assertIndexTargetAlive(docId: string, baseId: string): void {
    const store = this.requireStore()
    if (store.getDocument(docId) === undefined || store.getBase(baseId) === undefined) {
      throw new Error('indexing target no longer exists (deleted while indexing)')
    }
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
      // Cherry's reindex-subtree semantics. A container with a remembered
      // source path RESCANS the disk: files added since the import are
      // ingested, files removed from disk are deleted from the base, and
      // everything else is re-chunked/re-embedded. Legacy containers without
      // a source path fall back to re-indexing the existing children only.
      if (document.sourcePath !== undefined) {
        return await this.rescanDirectory(document)
      }
      // One bad leaf must not abort the rest of the subtree (Cherry's
      // reindex-subtree job keeps going; failing leaves are surfaced, not
      // fatal). Failures are collected and reported as a summary after the
      // sweep, so the user sees "N failed" instead of a silent partial run.
      let failed = 0
      let firstError = ''
      for (const child of store.listDocuments(document.baseId)) {
        if (child.parentDirectoryId !== document.id) continue
        if (this.indexing.has(child.id)) continue
        try {
          await this.reindexDocument(child.id)
        } catch (error) {
          failed += 1
          if (firstError === '') firstError = error instanceof Error ? error.message : String(error)
        }
      }
      if (failed > 0) {
        throw new Error(`directory reindex finished with ${failed} failed item(s): ${firstError}`)
      }
      // Refresh the container row's timestamp too (Cherry's updatedAt moves
      // with every status flip of the item).
      await store.putDocument({ ...document, updatedAt: Date.now() })
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
    const rebuilt = await this.sourceTextOf(document)
    const discardCandidate = async (): Promise<void> => {
      if (rebuilt.candidateRawFilePath === undefined) return
      try {
        await store.raw?.delete(rebuilt.candidateRawFilePath)
      } catch (error) {
        this.ctx.logger.warn(`knowledge: failed to discard uncommitted raw source ${rebuilt.candidateRawFilePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let candidateCommitted = false
    try {
      const config = this.getConfigFor(document.baseId)
      // Mark the document incomplete so a crash mid-reindex is resumed on the
      // next start (buildChunks persists each embedded batch; hash reuse makes
      // the resume re-embed only what never landed). The document continues to
      // reference the previous raw copy until the complete replacement commits.
      await store.putDocument({ ...document, incomplete: true, updatedAt: Date.now() })
      const { chunks, embeddingError, embeddingErrorCode } = await this.buildChunks(document.baseId, document.id, document.title, rebuilt.text, config, undefined, batch => store.putChunkBatch(batch))
      const { embeddingError: _staleError, errorCode: _staleCode, incomplete: _staleIncomplete, contentHash: _staleHash, ...rest } = document
      const next: KnowledgeDocument = {
        ...rest,
        ...(rebuilt.rawFilePath !== undefined ? { rawFilePath: rebuilt.rawFilePath } : {}),
        rawText: rebuilt.text,
        contentHash: sha256(rebuilt.text),
        charCount: rebuilt.text.length,
        tokenCount: estimateTokens(rebuilt.text),
        chunkCount: chunks.length,
        ...(embeddingError !== undefined
          ? { embeddingError, ...(embeddingErrorCode !== undefined ? { errorCode: embeddingErrorCode } : {}) }
          : {}),
        updatedAt: Date.now(),
      }
      // putChunks overwrites the doc's chunk bundle in one write (legacy
      // per-chunk rows, if any, stay hidden because a bundle record is
      // authoritative). A delete that landed mid-reindex must not resurrect
      // rows, chunks, or the candidate raw source.
      if (store.getDocument(document.id) === undefined || store.getBase(document.baseId) === undefined) {
        await discardCandidate()
        return document
      }
      await store.putChunks(chunks)
      await store.putDocument(next)
      candidateCommitted = true

      if (rebuilt.previousRawFilePath !== undefined && rebuilt.previousRawFilePath !== rebuilt.rawFilePath) {
        try {
          await store.raw?.delete(rebuilt.previousRawFilePath)
        } catch (error) {
          // The new document already points at the committed candidate. Leave
          // an undeleted predecessor for startup orphan reconciliation.
          this.ctx.logger.warn(`knowledge: failed to remove superseded raw source ${rebuilt.previousRawFilePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await this.touchBase(document.baseId)
      return next
    } catch (error) {
      if (!candidateCommitted) await discardCandidate()
      throw error
    }
  }

  /** Rebuild source text of a document. A path-imported single file (sourcePath)
   *  is re-read from disk first so EDITS and a repointed source (setBaseSourcePath)
   *  are picked up, refreshing the persisted raw copy; otherwise the raw copy,
   *  then persisted text, then reconstructed chunks are used. Returns the rebuilt
   *  text and, when the raw copy was refreshed, its new base-relative path. */
  private async sourceTextOf(document: KnowledgeDocument): Promise<{
    text: string
    rawFilePath?: string
    candidateRawFilePath?: string
    previousRawFilePath?: string
  }> {
    const store = this.requireStore()
    // A single-file path import tracks its live source on disk. Reindex re-reads
    // that path so edits and a repointed source (setBaseSourcePath) are actually
    // applied — the old behavior rebuilt only from the persisted raw copy and
    // ignored sourcePath. An unreadable path falls through to the stored copy.
    if (document.sourceType === 'file' && document.sourcePath !== undefined) {
      try {
        const buffer = await readFile(document.sourcePath)
        if (buffer.byteLength > 0) {
          const fileName = basename(document.sourcePath)
          // A repointed source may use a different extension. Dispatch from
          // the live source identity rather than stale fileName/MIME metadata.
          const text = await parseDocumentBuffer(buffer, fileName)
          if (text.trim().length > 0) {
            if (store.raw !== undefined) {
              // Always stage to a fresh path. The caller switches the document
              // reference only after chunks and metadata commit successfully.
              const nextRaw = await store.raw.write(document.baseId, crypto.randomUUID(), safeRawExtension(fileName), buffer)
              return {
                text,
                rawFilePath: nextRaw,
                candidateRawFilePath: nextRaw,
                ...(document.rawFilePath !== undefined ? { previousRawFilePath: document.rawFilePath } : {}),
              }
            }
            return { text }
          }
        }
      } catch (error) {
        this.ctx.logger.warn(`knowledge: re-reading source path failed, falling back to stored copy: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (document.rawFilePath !== undefined) {
      const raw = await store.raw?.read(document.rawFilePath)
      if (raw !== null && raw !== undefined && raw.byteLength > 0) {
        try {
          const text = await parseDocumentBuffer(raw, document.fileName ?? document.title, document.mimeType)
          if (text.trim().length > 0) return { text }
        } catch (error) {
          this.ctx.logger.warn(`knowledge: re-parsing raw source failed, falling back to stored text: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        this.ctx.logger.warn(`knowledge: raw source file missing for "${document.title}", falling back to stored text`)
      }
    }
    const text = document.rawText ?? reconstructFromChunks(this.requireStore().listChunksByDoc(document.id))
    if (text.trim().length === 0) throw new Error(`document "${document.title}" has no source text to reindex`)
    return { text }
  }

  /**
   * Cherry's prepare-root rescan: re-read the container's remembered source
   * directory and sync the base's children with the disk —
   * - files/directories removed from disk are deleted from the base,
   * - new supported files are parsed and ingested (raw copy persisted),
   * - new subdirectories become containers (with their own sourcePath),
   * - existing items are re-indexed (re-chunk + hash-reuse re-embed); when
   *   the on-disk bytes differ from the base's persisted raw copy, the copy
   *   is refreshed first so EDITS to source files are picked up too.
   * A missing/unreadable source keeps the existing subtree untouched (Cherry
   * skips roots whose source cannot be rebuilt). Failures are isolated per
   * entry and summarized at the end.
   */
  private async rescanDirectory(document: KnowledgeDocument): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    const source = document.sourcePath!
    // Mark the container itself active so its row shows a live status while
    // the rescan runs (Cherry's directory `preparing` state); children get
    // their own per-item statuses underneath.
    this.indexing.set(document.id, { baseId: document.baseId, title: document.title, phase: 'parsing', total: 0, progress: 0 })
    try {
      const result = await this.rescanDirectoryInner(document, source)
      // Cherry updates the container's updatedAt on every status flip; a
      // finished rescan must refresh the folder row's timestamp too (files
      // inside already do — the container itself did not).
      const current = store.getDocument(document.id)
      if (current !== undefined) {
        await store.putDocument({ ...current, updatedAt: Date.now() })
      }
      return result
    } finally {
      this.indexing.delete(document.id)
    }
  }

  private async rescanDirectoryInner(document: KnowledgeDocument, source: string): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    let entries
    try {
      entries = await readdir(source, { withFileTypes: true })
    } catch {
      // Source gone/unreadable: keep the existing subtree (never wipe vectors
      // for content that cannot be rebuilt — Cherry's canRebuildSource guard).
      this.ctx.logger.warn(`knowledge: source directory unreadable, keeping existing subtree: ${source}`)
      return document
    }
    const children = store.listDocuments(document.baseId).filter(child => child.parentDirectoryId === document.id)
    const onDisk = new Set(entries.map(entry => entry.name))
    let failures = 0
    let firstError = ''
    const fail = (error: unknown): void => {
      failures += 1
      if (firstError === '') firstError = error instanceof Error ? error.message : String(error)
    }
    // 1. Items whose source disappeared from disk are removed.
    for (const child of children) {
      const name = child.sourceType === 'directory' ? child.title : (child.fileName ?? child.title)
      if (!onDisk.has(name)) {
        try {
          await this.deleteDocumentRecursive(child.id)
        } catch (error) {
          fail(error)
        }
      }
    }
    // 2. Sync with what is on disk now.
    const remaining = store.listDocuments(document.baseId).filter(child => child.parentDirectoryId === document.id)
    for (const entry of entries) {
      const full = join(source, entry.name)
      if (entry.isDirectory()) {
        const existing = remaining.find(child => child.sourceType === 'directory' && child.title === entry.name)
        try {
          if (existing !== undefined) {
            const withSource = existing.sourcePath === full ? existing : { ...existing, sourcePath: full }
            await this.rescanDirectory(withSource)
          } else {
            const created = await this.createDirectory(document.baseId, entry.name, document.id)
            await this.rescanDirectory({ ...created, sourcePath: full })
          }
        } catch (error) {
          fail(error)
        }
      } else if (entry.isFile() && DIRECTORY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const existing = remaining.find(child => child.fileName === entry.name)
        try {
          if (existing !== undefined) {
            if (this.indexing.has(existing.id)) continue
            // Content sync with the disk: reindex alone rebuilds from the
            // base's persisted raw copy, so edits to a source file were never
            // picked up. When the on-disk bytes differ from the stored copy,
            // refresh the copy and re-index from the NEW content. Equal bytes
            // fall through to the plain reindex (rebuild from the stored
            // copy); a failed disk read must never wipe the stored copy or
            // the existing vectors, so it also falls through unchanged.
            if (store.raw !== undefined && existing.rawFilePath !== undefined) {
              try {
                const buffer = await readFile(full)
                const stored = await store.raw.read(existing.rawFilePath)
                const changed = stored === null || stored === undefined || stored.byteLength === 0
                  || !Buffer.from(stored).equals(buffer)
                if (changed) {
                  const text = await parseDocumentBuffer(buffer, entry.name)
                  // Never replace a good snapshot with empty/unreadable new
                  // content: keep the stored copy and the old vectors.
                  if (text.trim().length > 0) {
                    // rawFilePath already carries the `<baseId>/` prefix (it is
                    // the full base-relative path), so strip it before writeRel,
                    // which prepends `<baseId>/` again — otherwise the refreshed
                    // bytes land at a doubled path and the following reindex still
                    // rebuilds from the stale stored copy.
                    const relRaw = existing.rawFilePath.startsWith(`${document.baseId}/`)
                      ? existing.rawFilePath.slice(document.baseId.length + 1)
                      : existing.rawFilePath
                    await store.raw.writeRel(document.baseId, relRaw, buffer)
                    await this.reindexDocument(existing.id)
                    continue
                  }
                }
              } catch {
                // Disk or raw read failed: fall back to the stored-copy
                // reindex below (the copy and vectors stay intact).
              }
            }
            await this.reindexDocument(existing.id)
          } else {
            // New file: parse + ingest like an import, with a persisted raw
            // copy so a later reindex can rebuild from the base even if the
            // source disk changes. The stored path is a fresh uuid (not the
            // tree-relative path) so it cannot collide with a sibling root's
            // file that happens to share the same relative path.
            const buffer = await readFile(full)
            const text = await parseDocumentBuffer(buffer, entry.name)
            if (text.trim().length === 0) continue
            let rawFilePath: string | undefined
            if (store.raw !== undefined) {
              rawFilePath = await store.raw.write(document.baseId, crypto.randomUUID(), safeRawExtension(entry.name), buffer)
              try {
                await this.ingestDocument({
                  baseId: document.baseId,
                  title: entry.name,
                  sourceType: 'file',
                  fileName: entry.name,
                  parentDirectoryId: document.id,
                  rawFilePath,
                  text,
                })
              } catch (error) {
                // A rejected item (e.g. duplicate content) must not leave an
                // orphaned raw copy behind.
                await store.raw.delete(rawFilePath)
                throw error
              }
            } else {
              await this.ingestDocument({
                baseId: document.baseId,
                title: entry.name,
                sourceType: 'file',
                fileName: entry.name,
                parentDirectoryId: document.id,
                text,
              })
            }
          }
        } catch (error) {
          fail(error)
        }
      }
    }
    await this.touchBase(document.baseId)
    if (failures > 0) {
      throw new Error(`directory rescan finished with ${failures} failed item(s): ${firstError}`)
    }
    return document
  }

  async reindexBase(baseId: string): Promise<{ reindexed: number }> {
    const store = this.requireStore()
    const ids = store.listDocuments(baseId).map(doc => doc.id)
    // Fold to outermost roots: a directory reindexes its subtree recursively,
    // so its descendants must not be reindexed a second time as siblings.
    let reindexed = 0
    for (const id of this.outermostSelectedIds(ids)) {
      // In-flight documents are skipped (Cherry's REINDEX_ALLOWED_STATUSES),
      // never failed: a base reindex triggered while an import is running must
      // not abort the whole sweep because one row is busy.
      if (this.indexing.has(id)) continue
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
    // Presence is semantically distinct from absence: callers use an empty
    // allow-list to mean "match no documents", never "remove the filter".
    if (docIds !== undefined && docIds.length === 0) return new Set()
    if (sourceTypes !== undefined && sourceTypes.length === 0) return new Set()
    const hasDocIds = docIds !== undefined
    const hasTitle = titleIncludes !== undefined && titleIncludes.trim().length > 0
    const hasTypes = sourceTypes !== undefined
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
        ...(doc.errorCode !== undefined ? { errorCode: doc.errorCode } : {}),
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
    const now = Date.now()
    const out: Array<{ docId: string; baseId: string; title: string; phase: 'parsing' | 'embedding'; progress: number }> = []
    for (const [docId, entry] of this.indexing) {
      out.push({ docId, baseId: entry.baseId, title: entry.title, phase: entry.phase, progress: entry.progress })
    }
    // Linger entries (finished jobs) keep the last percentage for a short
    // window; expired ones are collected lazily.
    for (const [docId, entry] of [...this.progressLinger]) {
      if (entry.expireAt <= now) {
        this.progressLinger.delete(docId)
        continue
      }
      out.push({ docId, baseId: entry.baseId, title: entry.title, phase: entry.phase, progress: entry.progress })
    }
    return out
  }

  /** Current download/load state of an in-process embedding model. */
  async getLocalModelStatus(modelId?: string): Promise<LocalModelStatus> {
    const id = modelId?.trim() || DEFAULT_LOCAL_MODEL
    const live = getLocalModelStatus(id)
    if (live.status !== 'idle') return live
    // The in-memory map only tracks downloads/loads since this process
    // started; a model whose weights are already on disk is ready even
    // before its first lazy load (the embed worker loads it on demand).
    if (await isLocalModelDownloaded(id)) {
      return { model: id, status: 'ready', progress: 100, message: '' }
    }
    return live
  }

  /**
   * Embed one probe text through the given (or current) embedding config and
   * return the vector width — Cherry's `useEmbeddingDimensions` probe, run
   * before a config save so a wrong-dimension model is caught up front.
   * Local models answer from the catalog without loading the ~600MB pipeline.
   */
  async probeEmbeddingDimensions(options: {
    provider?: EmbeddingProvider
    baseUrl?: string
    model?: string
    apiKey?: string
  } = {}): Promise<number> {
    const config = this.getConfig()
    const provider = options.provider ?? config.embeddingProvider
    if (provider === 'none') throw new Error('no embedding provider configured')
    const model = options.model ?? config.embeddingModel
    if (provider === 'local') {
      const descriptor = LOCAL_MODELS.find(entry => entry.kind === 'embedding' && entry.id === model)
      if (descriptor?.dimensions !== undefined) return descriptor.dimensions
    }
    const [vector] = await embedTexts(
      provider,
      options.baseUrl ?? config.embeddingBaseUrl,
      model,
      options.apiKey ?? config.embeddingApiKey,
      ['test'],
    )
    if (vector === undefined || vector.length === 0) throw new Error('embedding returned an empty vector')
    return vector.length
  }

  // ── local model manager (settings "本地模型") ──────────────────────────────

  listLocalModels(): Promise<LocalModelSummary[]> {
    return listLocalModels()
  }

  downloadLocalModel(id: string): Promise<LocalModelSummary> {
    return downloadLocalModel(id)
  }

  registerCustomLocalReranker(id: string): Promise<LocalModelSummary> {
    return registerCustomLocalReranker(id)
  }

  selfTestLocalModel(id: string): Promise<LocalModelSummary> {
    return selfTestLocalModel(id)
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

  // ── Ollama model management (pull + installed list for the settings page) ──

  listOllamaModels(baseUrl: string): Promise<Array<{ name: string; size?: number }>> {
    return listOllamaModelsHelper(baseUrl)
  }

  deleteOllamaModel(model: string, baseUrl: string): Promise<void> {
    return deleteOllamaModelHelper(model, baseUrl)
  }

  pullOllamaModel(model: string, baseUrl: string): Promise<void> {
    return pullOllamaModelHelper(model, baseUrl)
  }

  cancelOllamaPull(model: string): void {
    cancelOllamaPullHelper(model)
  }

  getOllamaPullStatus(model: string): OllamaPullStatus {
    return getOllamaPullStatusHelper(model)
  }

  /** In-flight pulls (the panel restores its progress cards from this on open). */
  activeOllamaPulls(): Array<{ model: string; status: OllamaPullStatus['status']; progress: number; message: string }> {
    return activeOllamaPullsHelper()
  }

  /**
   * Migrate downloaded local models (and OCR files) from the current cache
   * directory to `to`, then point the config there. Loaded models are
   * released first so file locks (Windows) cannot block the move; moves fall
   * back to copy+delete across drives. The directory may be empty — the
   * config still switches, so future downloads land in the new location.
   */
  async migrateLocalModels(to: string): Promise<{ moved: number; from: string; to: string }> {
    const store = this.requireStore()
    const target = resolve(expandHomePath(to.trim() === '' ? '~/.dsh/cache/dsh-knowledge/local-models' : to.trim()))
    const from = localModelCacheDir()
    // Windows paths are case-insensitive: `C:\Users\...` vs `c:\users\...`
    // are the same directory and must not run a migration against itself.
    const samePath = process.platform === 'win32'
      ? from.toLowerCase() === target.toLowerCase()
      : from === target
    if (samePath) return { moved: 0, from, to: target }
    // A download in flight writes into the current cache directory; moving
    // its half-written files out from under the worker would corrupt the
    // model. Refuse instead of silently breaking the download.
    if (hasActiveLocalModelDownload() || hasActiveLocalRerankDownload()) {
      throw new Error('模型正在下载，请先等待下载完成或取消后再迁移')
    }
    // Release loaded models (up to ~600MB each) and the OCR worker BEFORE
    // touching the files, and wait for the worker threads to actually exit:
    // onnxruntime keeps model files mmap'd, and a Windows file lock makes
    // both the rename and the copy+delete fallback fail.
    await disposeLocalModelWorker()
    await disposeLocalRerankProcess()
    await disposeOcrWorker()
    const entries = await readdir(from).catch(() => [] as string[])
    let moved = 0
    await mkdir(target, { recursive: true })
    // Custom reranker registrations live beside the model directories. Keep
    // this hidden registry during migration without counting it as a model.
    await cp(join(from, '.dsh-rerank-models.json'), join(target, '.dsh-rerank-models.json'), { force: true }).catch(() => {})
    for (const entry of entries) {
      // Hidden entries (dot-prefixed) are never models: when the configured
      // cache dir is a parent of the target (e.g. from=/data/models,
      // target=/data/models/.local-models), the target itself shows up as an
      // entry — copying a directory into itself is a hard EINVAL. The same
      // guard protects unrelated dot-dirs (e.g. .ollama) from being dragged
      // into the migration.
      if (entry.startsWith('.')) continue
      const source = join(from, entry)
      const dest = join(target, entry)
      const info = await stat(source).catch(() => null)
      if (info === null || !info.isDirectory()) continue
      // Defense in depth: never move/copy a directory into itself or one of
      // its descendants, whatever the entry name looks like. The relation is
      // computed case-normalized on win32: `path.relative` is case-SENSITIVE
      // string math, so `C:\Models` vs `c:\models` (the same directory on
      // Windows) would produce a long `..\..\` detour and defeat the guard —
      // a case-mismatched config path could then copy the target into itself
      // again (the EINVAL we fixed once already).
      const src = process.platform === 'win32' ? source.toLowerCase() : source
      const dst = process.platform === 'win32' ? dest.toLowerCase() : dest
      const rel = relative(src, dst)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) continue
      // A destination entry that already exists is left untouched: a partial
      // previous migration (or a pre-existing model) must not be overwritten.
      if (await stat(dest).then(() => true).catch(() => false)) continue
      try {
        await rename(source, dest)
      } catch {
        // Cross-device or locked rename — copy then remove.
        await cp(source, dest, { recursive: true })
        await rm(source, { recursive: true, force: true })
      }
      moved += 1
    }
    await store.setConfigOverrides({ localModelCacheDir: target })
    setLocalModelCacheDir(target)
    return { moved, from, to: target }
  }

  listChunks(documentId: string, limit?: number, offset?: number): KnowledgeChunk[] {
    // Bounded SQL read (LIMIT/OFFSET) on the SQLite-backed store.
    const start = clampInt(offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 0)
    const count = limit === undefined ? undefined : clampInt(limit, 0, Number.MAX_SAFE_INTEGER, 0)
    return this.requireStore().listChunksByDoc(documentId, count, start)
  }

  /** Read a bounded ordered context window around one current chunk anchor. */
  getDocumentContext(
    documentId: string,
    options: {
      anchorChunkId?: string
      anchorIndex?: number
      before?: number
      after?: number
      maxTokens?: number
      focus?: string
      crossHeading?: boolean
    },
  ): {
    id: string
    baseId: string
    title: string
    sourceType: DocumentSourceType
    charCount: number
    chunkCount: number
    contextWindow: ContextWindow
  } {
    const hasChunkId = options.anchorChunkId !== undefined
    const hasIndex = options.anchorIndex !== undefined
    if (hasChunkId === hasIndex) throw new Error('provide exactly one of anchorChunkId or anchorIndex')
    if (options.focus !== undefined && options.focus.length > 500) throw new Error('focus must not exceed 500 characters')
    const store = this.requireStore()
    const doc = store.getDocument(documentId)
    if (doc === undefined) throw new Error(`document not found: ${documentId}`)
    let anchor: KnowledgeChunk | undefined
    if (options.anchorChunkId !== undefined) {
      anchor = store.getChunk(options.anchorChunkId)
      if (anchor === undefined) throw new Error('anchor chunk is stale or no longer exists; run knowledge_search again')
    } else {
      const requestedIndex = options.anchorIndex!
      if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= doc.chunkCount) {
        throw new Error('anchorIndex is outside this document')
      }
      const index = requestedIndex
      anchor = store.listChunksByIndexRange(documentId, index, index)[0]
      if (anchor === undefined) throw new Error('anchorIndex is outside this document')
    }
    if (anchor.docId !== documentId || anchor.baseId !== doc.baseId) {
      throw new Error('anchor chunk does not belong to the requested document')
    }
    const before = clampInt(options.before ?? 2, 0, 10, 2)
    const after = clampInt(options.after ?? 2, 0, 10, 2)
    const maxTokens = clampInt(options.maxTokens ?? 1600, 128, 4096, 1600)
    const chunks = store.listChunksByIndexRange(documentId, anchor.index - before, anchor.index + after)
    const contextWindow = composeContextWindow(chunks, anchor, {
      before,
      after,
      maxTokens,
      focus: options.focus,
      crossHeading: options.crossHeading === true,
      documentChunkCount: doc.chunkCount,
    })
    return {
      id: doc.id,
      baseId: doc.baseId,
      title: doc.title,
      sourceType: doc.sourceType,
      charCount: doc.charCount,
      chunkCount: doc.chunkCount,
      contextWindow,
    }
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
    // Where the caller would have ended without the cap (an omitted charEnd
    // reads to the document end) — Cherry's readConcept slice cap.
    const naturalEnd = clampInt(charEnd ?? total, start, total, total)
    const end = Math.max(start, Math.min(naturalEnd, start + CONCEPT_READ_MAX_CHARS))
    return {
      id: doc.id,
      baseId: doc.baseId,
      title: doc.title,
      sourceType: doc.sourceType,
      totalChars: total,
      charStart: start,
      charEnd: end,
      content: text.slice(start, end),
      // "There is more to read" — true both when the 20k cap cut the slice
      // short and when the caller stopped before the document end.
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
    // Cherry's scanConceptMatches: the pattern runs over ONE truncated line at
    // a time (2000 chars), so a catastrophic-backtracking pattern ((a+)+$) can
    // never freeze the host by spanning the whole document; `totalMatches`
    // counts the whole text even past the returned-match cap.
    const matches: Array<{ line: number; charStart: number; charEnd: number; snippet: string }> = []
    let totalMatches = 0
    let lineNumber = 0
    let lineStart = 0
    while (lineStart <= text.length) {
      lineNumber += 1
      const newlineIndex = text.indexOf('\n', lineStart)
      const lineEnd = newlineIndex === -1 ? text.length : newlineIndex
      const line = text.slice(lineStart, Math.min(lineEnd, lineStart + CONCEPT_GREP_MAX_LINE_CHARS))
      regex.lastIndex = 0
      for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
        totalMatches += 1
        const matchLength = match[0].length
        const matchStart = lineStart + match.index
        const matchEnd = matchStart + matchLength
        if (matches.length < cap) {
          const snippetStart = Math.max(0, matchStart - CONCEPT_GREP_SNIPPET_PAD)
          const snippetEnd = Math.min(text.length, matchEnd + CONCEPT_GREP_SNIPPET_PAD)
          matches.push({
            line: lineNumber,
            charStart: matchStart,
            charEnd: matchEnd,
            snippet: `${snippetStart > 0 ? '…' : ''}${text.slice(snippetStart, snippetEnd)}${snippetEnd < text.length ? '…' : ''}`,
          })
        }
        // Zero-width match: advance past the same position so exec() moves on.
        if (matchLength === 0) regex.lastIndex = match.index + 1
      }
      lineStart = lineEnd + 1
    }
    return { id: doc.id, baseId: doc.baseId, title: doc.title, totalMatches, matches }
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
      storedDocCount: documents.reduce((sum, doc) => sum + (doc.rawFilePath !== undefined ? 1 : 0), 0),
      chunkCount: chunkStats.count,
      charCount,
      tokenCount,
      embedded: chunkStats.embedded,
      ...(chunkStats.dimensions !== undefined ? { embeddingDimensions: chunkStats.dimensions } : {}),
      ...(hasCurrentKey && staleChunkCount > 0 ? { staleEmbeddings: true, staleChunkCount } : {}),
    }
  }

  // ── retrieval ─────────────────────────────────────────────────────────────

  async search(request: SearchRequest, execution: SearchExecutionOptions = {}): Promise<SearchResult> {
    const startedAt = Date.now()
    throwIfAborted(execution.signal)
    throwIfDeadline(execution.deadlineAt)
    const query = request.query.trim()
    if (query.length === 0) return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] }
    if (query.length > 2000) throw new Error('search query must not exceed 2000 characters')

    const variants = normalizeQueryVariants(query, request.queries)
    const allowRerank = execution.rerank !== 'skip'
    if (variants.length === 1) {
      return this.searchSingle({ ...request, query, queries: undefined }, allowRerank, startedAt, execution.signal, execution.deadlineAt)
    }

    const config = this.getConfigFor(request.baseId)
    const requestedMode = request.mode ?? config.searchMode
    const topK = clampInt(request.topK ?? config.topK, 1, 50, 6)
    const subTopK = Math.min(50, Math.max(topK * 2, 12))
    const results = await Promise.all(variants.map(variant => this.searchSingle({
      ...request,
      query: variant,
      queries: undefined,
      topK: subTopK,
    }, false, startedAt, execution.signal, execution.deadlineAt)))
    throwIfAborted(execution.signal)
    return this.finishMultiQuerySearch(config, query, requestedMode, results, topK, request.threshold, startedAt, allowRerank, execution.signal)
  }

  /** One retrieval pass. Multi-query orchestration lives in search() so each
   * variant cannot independently invoke an expensive reranker. */
  private async searchSingle(
    request: SearchRequest,
    allowRerank: boolean,
    startedAt: number,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<SearchResult> {
    throwIfAborted(signal)
    throwIfDeadline(deadlineAt)
    const store = this.requireStore()
    const config = this.getConfigFor(request.baseId)
    const query = request.query.trim()
    if (query.length === 0) return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] }
    const requestedMode = request.mode ?? config.searchMode
    const topK = clampInt(request.topK ?? config.topK, 1, 50, 6)
    if (request.baseId === undefined && request.baseIds !== undefined && request.baseIds.length === 0) {
      return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: Date.now() - startedAt, hits: [] }
    }
    // A stale base id (e.g. a base deleted without sweeping child records)
    // must not surface orphaned content.
    if (request.baseId !== undefined && store.getBase(request.baseId) === undefined) {
      return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: 0, hits: [] }
    }

    const threshold = request.threshold ?? config.similarityThreshold

    // Metadata filters narrow the search to a subset of documents. Resolved
    // once here into a docId allow-list shared by both retrieval paths.
    const filterDocIds = this.resolveSearchFilter(request)
    // A present-but-empty allow-list is an explicit "match nothing" result.
    // Never pass it to a storage implementation that might interpret [] as
    // unrestricted scope.
    if (filterDocIds !== undefined && filterDocIds.size === 0) {
      return { query, mode: 'lexical', total: 0, reranked: false, elapsedMs: Date.now() - startedAt, hits: [] }
    }

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
            signal,
          )
          throwIfAborted(signal)
          queryVector = vector
        } catch (error) {
          throwIfAborted(signal)
          // A configured local model that cannot load (weights deleted, download
          // failed) is a configuration problem, not a transient failure — surface
          // it instead of silently degrading to lexical (the user believes hybrid
          // is on). A model whose files ARE on disk but whose binding/worker
          // reload failed ("Module did not self-register") is a runtime error,
          // not a missing download — say so instead of sending them to re-download.
          if (config.embeddingProvider === 'local') {
            throw await localEmbeddingError(config, error)
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
        const vec = await lane.vector(queryVector!, scope, poolSize, filterList, deadlineAt)
        total = Math.max(total, vec.total)
        for (const hit of vec.hits) byId.set(hit.id, hit)
        if (requestedMode === 'vector') {
          ranked = vec.hits.map(hit => ({ id: hit.id, score: hit.score, vectorScore: hit.score }))
        } else {
          // Hybrid/auto: fuse both lanes with Reciprocal Rank Fusion; the
          // vector lane carries the configured relative weight.
          const lex = await lane.lexical(query, scope, poolSize, filterList, deadlineAt)
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
        const lex = await lane.lexical(query, scope, poolSize, filterList, deadlineAt)
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
      throwIfAborted(signal)
      return this.finishSearch(store, config, query, requestedMode, ranked, byId, topK, threshold, total, startedAt, allowRerank, signal)
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
          signal,
        )
        throwIfAborted(signal)
        queryVector = vector
      } catch (error) {
        throwIfAborted(signal)
        // See the lane path: a broken local model must not silently degrade.
        if (config.embeddingProvider === 'local') {
          throw await localEmbeddingError(config, error)
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
    throwIfAborted(signal)
    return this.finishSearch(store, config, query, requestedMode, ranked, byId, topK, threshold, chunks.length, startedAt, allowRerank, signal)
  }

  /** Merge independent query rankings with RRF, then optionally rerank once. */
  private async finishMultiQuerySearch(
    config: KnowledgeConfig,
    query: string,
    requestedMode: SearchMode,
    results: readonly SearchResult[],
    topK: number,
    requestedThreshold: number | undefined,
    startedAt: number,
    allowRerank: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const store = this.requireStore()
    throwIfAborted(signal)
    const orders = results.map(result => result.hits.map(hit => hit.chunkId))
    const fused = reciprocalRankFusion(orders)
    const maxFused = results.length / (RRF_K + 1)
    const byId = new Map<string, SearchHit>()
    for (const result of results) {
      for (const hit of result.hits) if (!byId.has(hit.chunkId)) byId.set(hit.chunkId, hit)
    }
    let hits = [...byId.values()]
      .map(hit => ({ ...hit, score: (fused.get(hit.chunkId) ?? 0) / maxFused }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(50, Math.max(topK * 4, 20)))
    const applied = await this.applyRerank(store, config, query, hits, topK, allowRerank, signal)
    hits = applied.hits

    const mode = results.some(result => result.mode === 'hybrid')
      ? 'hybrid'
      : results.some(result => result.mode === 'vector')
        ? 'vector'
        : requestedMode === 'lexical' ? 'lexical' : results[0]?.mode ?? 'lexical'
    const threshold = requestedThreshold ?? config.similarityThreshold
    if (applied.reranked || mode === 'vector') hits = hits.filter(hit => hit.score >= threshold)
    const finalHits = attachContextWindows(store, hits.slice(0, topK), query, config.siblingChunks, SEARCH_EVIDENCE_TOKENS)
    return {
      query,
      mode,
      total: results.reduce((max, result) => Math.max(max, result.total), 0),
      reranked: applied.reranked,
      ...(applied.rerank !== undefined ? { rerank: applied.rerank } : {}),
      elapsedMs: Date.now() - startedAt,
      hits: finalHits,
    }
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
    allowRerank = true,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    throwIfAborted(signal)
    const ranked = initial
    const candidates = ranked
      .map(hit => searchHitOf(store, byId.get(hit.id), hit))
      .filter((hit): hit is SearchHit => hit !== undefined)
    const applied = await this.applyRerank(store, config, query, candidates, topK, allowRerank, signal)

    // Cherry's applyRelevanceThreshold: only 'relevance' scores are
    // threshold-filtered — pure-vector cosine (mode 'vector') and reranked
    // relevance. Raw BM25/hybrid ranking scores (incomparable scales) never
    // are, even with a threshold configured.
    const relevanceScores = applied.reranked || requestedMode === 'vector'
    const hits = attachContextWindows(
      store,
      applied.hits
        .filter(hit => (relevanceScores ? hit.score >= threshold : true))
        .slice(0, topK),
      query,
      config.siblingChunks,
      SEARCH_EVIDENCE_TOKENS,
    )

    return {
      query,
      mode: effectiveMode(requestedMode, ranked),
      total,
      reranked: applied.reranked,
      ...(applied.rerank !== undefined ? { rerank: applied.rerank } : {}),
      elapsedMs: Date.now() - startedAt,
      hits,
    }
  }

  /** One canonical rerank stage for both single-query retrieval and RRF-fused
   * multi-query retrieval. It owns contextual input, deadline/retry policy,
   * stable tie handling, structured degradation, and original-order fallback. */
  private async applyRerank(
    store: Store,
    config: KnowledgeConfig,
    query: string,
    input: readonly SearchHit[],
    topK: number,
    allowRerank: boolean,
    signal?: AbortSignal,
  ): Promise<{ hits: SearchHit[]; reranked: boolean; rerank?: RerankStatus }> {
    throwIfAborted(signal)
    const original = [...input]
    const rerankModel = allowRerank ? config.rerankModel.trim() : ''
    if (rerankModel === '') return { hits: original, reranked: false }
    if (original.length <= 1) {
      return {
        hits: original,
        reranked: false,
        rerank: this.notNeededRerankStatus(rerankModel, original.length),
      }
    }

    const rerankQuery = fitRerankQuery(query)
    const contextual = attachContextWindows(
      store,
      original,
      query,
      config.siblingChunks,
      RERANK_EVIDENCE_TOKENS,
      hit => rerankTitleReserve(hit.documentTitle),
    )
    const candidateCount = contextual.length
    const rerankStartedAt = Date.now()
    const rerankTimeoutMs = rerankModel.startsWith('local:') ? config.localRerankTimeoutMs : 60_000
    try {
      const scores = await rerankCandidates(
        config.rerankBaseUrl,
        config.rerankModel,
        config.rerankApiKey,
        rerankQuery,
        contextual.map(hit => ({
          id: hit.chunkId,
          text: rerankEvidenceText(hit),
        })),
        {
          topN: topK,
          timeoutMs: rerankTimeoutMs,
          deadlineAt: rerankStartedAt + rerankTimeoutMs,
          retries: rerankModel.startsWith('local:') ? 0 : 1,
          ...(signal !== undefined ? { signal } : {}),
        },
      )
      throwIfAborted(signal)
      const order = new Map(contextual.map((hit, index) => [hit.chunkId, index]))
      const rescored = contextual
        .filter(hit => scores.has(hit.chunkId))
        .map(hit => ({ ...hit, score: scores.get(hit.chunkId)! }))
        .sort((left, right) => right.score - left.score
          || (order.get(left.chunkId) ?? 0) - (order.get(right.chunkId) ?? 0))
      // rerankCandidates rejects an empty response, but retain this defensive
      // branch for custom/test providers so an empty set never erases hits.
      if (rescored.length === 0) {
        const detail: RerankErrorDetail = {
          code: 'invalid_response',
          message: 'rerank provider returned no scored candidates',
          retryable: false,
          action: 'check_config',
        }
        const rerank = this.degradedRerankStatus(rerankModel, candidateCount, Date.now() - rerankStartedAt, detail)
        this.logRerankFailure(rerankModel, detail.code, candidateCount, rerank.elapsedMs ?? 0, detail.message)
        return { hits: original, reranked: false, rerank }
      }
      this.rerankLogState.delete(rerankModel)
      return {
        hits: rescored,
        reranked: true,
        rerank: this.appliedRerankStatus(rerankModel, candidateCount, Date.now() - rerankStartedAt),
      }
    } catch (error) {
      throwIfAborted(signal)
      const detail = rerankErrorDetail(error)
      const rerank = this.degradedRerankStatus(rerankModel, candidateCount, Date.now() - rerankStartedAt, detail)
      this.logRerankFailure(rerankModel, detail.code, candidateCount, rerank.elapsedMs ?? 0, rerankTechnicalMessage(error))
      return { hits: original, reranked: false, rerank }
    }
  }

  private rerankProvider(model: string): 'local' | 'remote' {
    return model.startsWith('local:') ? 'local' : 'remote'
  }

  private notNeededRerankStatus(model: string, candidateCount: number): RerankStatus {
    return {
      configured: true,
      provider: this.rerankProvider(model),
      model,
      status: 'not_needed',
      attempted: false,
      applied: false,
      candidateCount,
    }
  }

  private appliedRerankStatus(model: string, candidateCount: number, elapsedMs: number): RerankStatus {
    return {
      configured: true,
      provider: this.rerankProvider(model),
      model,
      status: 'applied',
      attempted: true,
      applied: true,
      candidateCount,
      elapsedMs,
    }
  }

  private degradedRerankStatus(model: string, candidateCount: number, elapsedMs: number, error: RerankErrorDetail): RerankStatus {
    const skipped = ['model_not_downloaded', 'model_checking', 'model_unhealthy', 'unsupported_model', 'circuit_open', 'busy'].includes(error.code)
    return {
      configured: true,
      provider: this.rerankProvider(model),
      model,
      status: 'degraded',
      attempted: !skipped,
      applied: false,
      candidateCount,
      elapsedMs,
      error,
    }
  }

  private logRerankFailure(model: string, code: string, candidateCount: number, elapsedMs: number, technicalMessage: string): void {
    if (this.rerankLogState.get(model) === code) return
    this.rerankLogState.set(model, code)
    this.ctx.logger.warn(`knowledge: rerank degraded model=${JSON.stringify(model)} code=${code} candidates=${candidateCount} elapsedMs=${elapsedMs} detail=${JSON.stringify(technicalMessage)}`)
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
      // Swallow the finally chain's rejection: a task that throws (e.g. an
      // unexpected store error) would otherwise become an unhandledRejection
      // and kill the whole DSH process.
      void task().finally(() => {
        entry.running -= 1
        this.pumpIngestQueue(baseId)
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`knowledge: ingest task failed: ${error instanceof Error ? error.message : String(error)}`)
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
    /** Absolute source path the item was imported from (file/path imports). */
    sourcePath?: string
    /** Pre-created placeholder id (already stored, shown while embedding). */
    placeholderId?: string
  }, signal?: AbortSignal): Promise<KnowledgeDocument> {
    const store = this.requireStore()
    const config = this.getConfigFor(input.baseId)
    const contentHash = sha256(input.text)
    // Dedup check + first persist run under the per-base write lock: concurrent
    // imports of identical content must not both pass the check (Cherry guards
    // the same read-then-write with its per-base mutation lock).
    const half = await this.withBaseWriteLock(input.baseId, async () => {
      // Cherry's deleting-guard: a base deleted while a queued import waited
      // must not accept new rows; a placeholder row deleted by the user before
      // its queued task ran must not be recreated.
      if (store.getBase(input.baseId) === undefined) {
        throw new Error('knowledge base no longer exists (deleted while indexing)')
      }
      if (input.placeholderId !== undefined && store.getDocument(input.placeholderId) === undefined) {
        throw new Error('document no longer exists (deleted while indexing)')
      }
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
        ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
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
    // Chunking (regular or semantic) happens inside buildChunks; passing no
    // pieces lets the configured semanticChunk path run.
    const { chunks, embeddingError, embeddingErrorCode } = await this.buildChunks(input.baseId, half.id, input.title, input.text, config, undefined, batch => store.putChunkBatch(batch), signal)
    // A delete that landed mid-embedding must not resurrect the row nor write
    // chunks under a deleted base (Cherry's deleting-guard).
    if (store.getDocument(half.id) === undefined || store.getBase(input.baseId) === undefined) {
      this.indexing.delete(half.id)
      return half
    }
    const document: KnowledgeDocument = {
      ...half,
      chunkCount: chunks.length,
      ...(embeddingError !== undefined
        ? { embeddingError, ...(embeddingErrorCode !== undefined ? { errorCode: embeddingErrorCode } : {}) }
        : {}),
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
    signal?: AbortSignal,
  ): Promise<{ chunks: KnowledgeChunk[]; embeddingError?: string; embeddingErrorCode?: 'dimension_mismatch' | 'embedding_provider' }> {
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
    // Cherry's deleting-guard on every persisted batch: a delete that lands
    // mid-embedding aborts the remaining batches instead of writing chunks
    // under a vanished document/base. The caller's finishing write re-checks
    // too (buildChunks reports the abort as an embeddingError).
    const guardedOnBatch = onBatch !== undefined
      ? (batch: KnowledgeChunk[]): Promise<void> => {
          this.assertIndexTargetAlive(docId, baseId)
          return onBatch(batch)
        }
      : undefined
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
    let embeddingErrorCode: 'dimension_mismatch' | 'embedding_provider' | undefined
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
          // Cherry's job retry policy (3 attempts, exponential backoff): a
          // transient provider/network failure retries the batch before the
          // import degrades to lexical-only.
          const vectors = await this.embedWithRetry(config, batchTexts, signal)
          // Same-width guarantee across the whole batch (a provider mixing
          // widths would poison every vector comparison in the store).
          const widths = new Set(vectors.map(vector => vector.length))
          if (widths.size > 1) {
            throw new Error(`embedding returned mixed vector dimensions: ${[...widths].join(', ')}`)
          }
          const width = vectors[0]?.length ?? 0
          if (width === 0) throw new Error('embedding returned empty vectors')
          if (storedDimension !== undefined && storedDimension !== width) {
            embeddingErrorCode = 'dimension_mismatch'
            throw new Error(`embedding vector dimension ${width} does not match the ${storedDimension} already stored for model "${key}" — switch back or reindex the base`)
          }
          const done: KnowledgeChunk[] = []
          for (let j = 0; j < batch.length; j += 1) {
            const index = batch[j]
            chunks[index] = { ...chunks[index], embedding: vectors[j], ...(key !== undefined ? { embeddingModel: key } : {}) }
            done.push(chunks[index])
          }
          if (guardedOnBatch !== undefined) await guardedOnBatch(done)
          this.indexing.set(docId, { baseId, title, phase: 'embedding', total: need.length, progress: Math.round((Math.min(i + batch.length, need.length) / need.length) * 100) })        }
      } catch (error) {
        embeddingError = error instanceof Error ? error.message : String(error)
        embeddingErrorCode ??= 'embedding_provider'
        this.ctx.logger.warn(`knowledge: embedding during import failed, storing lexical-only chunks: ${embeddingError}`)
      } finally {
        const active = this.indexing.get(docId)
        this.indexing.delete(docId)
        // Cherry's linger: keep the final percentage visible for ~60s so the
        // UI does not blank it while the row still reads processing.
        if (active !== undefined) {
          this.progressLinger.set(docId, {
            baseId,
            title,
            phase: active.phase,
            progress: active.progress,
            expireAt: Date.now() + PROGRESS_LINGER_TTL_MS,
          })
        }
      }
    }
    return { chunks, embeddingError, embeddingErrorCode }
  }

  /** Embed one batch through the configured provider (empty input → empty output). */
  private async embedTextsOnce(config: KnowledgeConfig, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return []
    return embedTexts(
      config.embeddingProvider,
      config.embeddingBaseUrl,
      config.embeddingModel,
      config.embeddingApiKey,
      texts,
      signal,
    )
  }

  /**
   * Embed with Cherry's job retry policy: 3 attempts, exponential backoff
   * (1s → 30s), so a transient provider/network failure self-heals instead of
   * degrading a whole import to lexical-only. An external abort (delete)
   * interrupts the request chain immediately.
   */
  private async embedWithRetry(config: KnowledgeConfig, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    let attempt = 1
    for (;;) {
      if (signal?.aborted === true) throw new Error('embedding aborted (document was deleted)')
      try {
        return await this.embedTextsOnce(config, texts, signal)
      } catch (error) {
        if (attempt >= EMBED_MAX_ATTEMPTS) throw error
        const delay = Math.min(EMBED_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), EMBED_RETRY_MAX_DELAY_MS)
        attempt += 1
        this.ctx.logger.warn(`knowledge: embedding attempt ${attempt - 1}/${EMBED_MAX_ATTEMPTS} failed, retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
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

/** Bounded list of a base's top-level sources (directory roots / files / URLs /
 *  text nodes), for the detail header. Nested children are covered by their
 *  root, so only `parentDirectoryId === undefined` items are listed. */
function baseSourceLines(documents: KnowledgeDocument[]): BaseSourceInfo[] {
  const MAX = 4
  const lines: BaseSourceInfo[] = []
  for (const doc of documents) {
    if (doc.parentDirectoryId !== undefined) continue
    let kind: DocumentSourceType
    let text: string
    if (doc.sourceType === 'directory') {
      kind = 'directory'
      text = doc.sourcePath ?? doc.title
    } else if (doc.sourceType === 'url') {
      kind = 'url'
      text = doc.url ?? doc.title
    } else if (doc.sourceType === 'file') {
      kind = 'file'
      text = doc.sourcePath ?? doc.fileName ?? doc.title
    } else {
      kind = 'text'
      text = 'node'
    }
    lines.push({
      sourceId: doc.id,
      kind,
      text,
      ...(doc.sourcePath !== undefined ? { sourcePath: doc.sourcePath } : {}),
    })
    if (lines.length >= MAX) break
  }
  return lines
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
const RERANK_EVIDENCE_TOKENS = 352
const RERANK_QUERY_TOKENS = 128
const RERANK_TITLE_TOKENS = 64
const SEARCH_EVIDENCE_TOKENS = 768

/** Deterministically retain both the intent at the start and qualifiers at the
 * end of an oversized rerank query. The estimator is the same one used for
 * evidence, so the pair budget remains enforceable without a model download. */
function fitRerankQuery(query: string): string {
  if (estimateContextTokens(query) <= RERANK_QUERY_TOKENS) return query
  let low = 0
  let high = query.length
  let best = ''
  while (low <= high) {
    const retained = Math.floor((low + high) / 2)
    const head = Math.ceil(retained * 0.6)
    const tail = retained - head
    const candidate = `${query.slice(0, head).trimEnd()} … ${query.slice(query.length - tail).trimStart()}`
    if (estimateContextTokens(candidate) <= RERANK_QUERY_TOKENS) {
      best = candidate
      low = retained + 1
    } else {
      high = retained - 1
    }
  }
  return best || query.slice(0, 1)
}

/** Bound untrusted document metadata before it enters the cross-encoder pair.
 * The title remains useful for disambiguation, but can never crowd the
 * query-centred anchor out of the fixed 352-token evidence budget. */
function fitRerankTitle(title: string): string {
  const trimmed = title.trim()
  if (estimateContextTokens(trimmed) <= RERANK_TITLE_TOKENS) return trimmed
  let low = 0
  let high = trimmed.length
  let best = ''
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = `${trimmed.slice(0, length).trimEnd()}…`
    if (estimateContextTokens(candidate) <= RERANK_TITLE_TOKENS) {
      best = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return best
}

function rerankTitleReserve(title: string): number {
  const fitted = fitRerankTitle(title)
  return fitted.length === 0 ? 0 : estimateContextTokens(`${fitted}\n`)
}

function rerankEvidenceText(hit: SearchHit): string {
  const title = fitRerankTitle(hit.documentTitle)
  const evidence = hit.contextWindow !== undefined ? serializeContextWindow(hit.contextWindow) : hit.text
  const combined = title.length === 0 ? evidence : `${title}\n${evidence}`
  // attachContextWindows reserved the exact fitted-title cost. Keep this
  // defensive assertion local so a future serializer change degrades rerank
  // instead of silently violating the public pair budget.
  if (estimateContextTokens(combined) > RERANK_EVIDENCE_TOKENS) {
    throw new Error('rerank evidence exceeded the 352-token budget')
  }
  return combined
}

function searchHitOf(store: Store, chunk: KnowledgeChunk | undefined, hit: RankedHit): SearchHit | undefined {
  if (chunk === undefined) return undefined
  return {
    chunkId: chunk.id,
    docId: chunk.docId,
    baseId: chunk.baseId,
    documentTitle: store.getDocument(chunk.docId)?.title ?? chunk.docId,
    ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
    index: chunk.index,
    text: chunk.text,
    score: hit.score,
    ...(hit.vectorScore !== undefined ? { vectorScore: hit.vectorScore } : {}),
    ...(hit.lexicalScore !== undefined ? { lexicalScore: hit.lexicalScore } : {}),
  }
}

/** Attach token-bounded ordered context to all hits while loading all merged
 * document ranges through one storage operation. */
function attachContextWindows(
  store: Store,
  hits: readonly SearchHit[],
  focus: string,
  radius: number,
  maxTokens: number,
  reserveTokens?: (hit: SearchHit) => number,
): SearchHit[] {
  if (hits.length === 0) return []
  const safeRadius = clampInt(radius, 0, 10, 0)
  const ranges = mergeChunkRanges(hits.map(hit => ({
    docId: hit.docId,
    fromIdx: Math.max(0, hit.index - safeRadius),
    toIdx: hit.index + safeRadius,
  })))
  const loaded = store.listChunksByIndexRanges(ranges)
  const byDoc = new Map<string, KnowledgeChunk[]>()
  for (const chunk of loaded) {
    const list = byDoc.get(chunk.docId) ?? []
    list.push(chunk)
    byDoc.set(chunk.docId, list)
  }
  return hits.map(hit => {
    const anchor: KnowledgeChunk = {
      id: hit.chunkId,
      docId: hit.docId,
      baseId: hit.baseId,
      index: hit.index,
      text: hit.text,
      ...(hit.heading !== undefined ? { heading: hit.heading } : {}),
    }
    const neighbours = byDoc.get(hit.docId) ?? [anchor]
    const document = store.getDocument(hit.docId)
    const contextWindow = composeContextWindow(neighbours, anchor, {
      before: safeRadius,
      after: safeRadius,
      maxTokens: Math.max(1, maxTokens - (reserveTokens?.(hit) ?? 0)),
      focus,
      documentChunkCount: document?.chunkCount,
    })
    const legacy = safeRadius > 0
      ? neighbours
        .filter(chunk => chunk.id !== anchor.id && chunk.index >= anchor.index - safeRadius && chunk.index <= anchor.index + safeRadius)
        .sort((a, b) => a.index - b.index)
        .map(chunk => `${chunk.heading !== undefined ? `[${chunk.heading}] ` : ''}${chunk.text}`)
        .join('\n\n')
      : ''
    const { siblingContext: _oldSibling, contextWindow: _oldWindow, ...base } = hit
    return {
      ...base,
      contextWindow,
      ...(legacy.length > 0 ? { siblingContext: legacy } : {}),
    }
  })
}

function mergeChunkRanges(
  ranges: readonly { docId: string; fromIdx: number; toIdx: number }[],
): Array<{ docId: string; fromIdx: number; toIdx: number }> {
  const ordered = [...ranges].sort((a, b) => a.docId.localeCompare(b.docId) || a.fromIdx - b.fromIdx || a.toIdx - b.toIdx)
  const merged: Array<{ docId: string; fromIdx: number; toIdx: number }> = []
  for (const range of ordered) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.docId === range.docId && range.fromIdx <= previous.toIdx + 1) {
      previous.toIdx = Math.max(previous.toIdx, range.toIdx)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The operation was aborted', 'AbortError')
}

function throwIfDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new DOMException('knowledge search deadline exceeded', 'TimeoutError')
  }
}

/** Trim, validate, normalize, and cap multi-query variants. */
function normalizeQueryVariants(primary: string, queries?: readonly string[]): string[] {
  const variants = [primary]
  const seen = new Set([primary.toLowerCase()])
  for (const raw of (queries ?? []) as readonly unknown[]) {
    if (typeof raw !== 'string') continue
    const query = raw.trim()
    if (query.length === 0) continue
    if (query.length > 2000) throw new Error('extra search query must not exceed 2000 characters')
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    variants.push(query)
    if (variants.length >= 4) break
  }
  return variants
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
