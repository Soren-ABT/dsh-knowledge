/**
 * Store abstraction over the knowledge data. The service reads and writes
 * plain data through one interface; implementations back it:
 * - a durable `DomainStore` — business state (bases, documents, runtime
 *   config) over `ctx.storageDomain`, chunks in a dedicated SQLite file
 *   (`ChunkDatabase`) so writes stay O(1) no matter how much data grows;
 * - an in-memory `MemoryStore` used when the storage backend is unavailable
 *   (e.g. a headless profile without a configured storage route, or tests).
 * @module dsh-knowledge/knowledge/store
 */

import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { knowledgeDomainSpec, TABLES } from './domain.js'
import type { ConfigOverrides } from './domain.js'
import { ChunkDatabase, hashEmbeddingText, legacyChunkFilePath, migrateLegacyChunkFile, resolveChunkStorePath, searchTextOf } from './chunkdb.js'
import type { RetrievalLane } from './chunkdb.js'
import type {
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeDocument,
} from './types.js'

export interface ChunkStats {
  count: number
  embedded: boolean
  dimensions?: number
  /** Distinct embedding-model tags on embedded chunks (count per base+model). */
  embeddingModelCounts: Array<{ baseId: string; model: string; count: number }>
}

/**
 * Original source bytes of uploaded documents (Cherry's `raw/` material store):
 * "import means copy" — the base keeps its own stable copy, and reindex can
 * re-read + re-parse the source instead of only reusing the persisted text.
 * Stored under `<chunkStorePath dir>/knowledge-raw/<baseId>/<docId><ext>`.
 */
export interface RawFileStore {
  /** Persist one document's source bytes; returns the base-relative path. */
  write(baseId: string, docId: string, ext: string, bytes: Uint8Array): Promise<string>
  /** Read a document's source bytes back (null when absent). */
  read(relativePath: string): Promise<Uint8Array | null>
  /** Remove one document's source file by its stored relative path (missing = no-op). */
  delete(relativePath: string): Promise<void>
  /** Remove every source file of a base. */
  deleteBase(baseId: string): Promise<void>
}

/** Filesystem-backed {@link RawFileStore}. */
export class RawFileStorage implements RawFileStore {
  constructor(private readonly root: string) {}

  private pathOf(relativePath: string): string {
    const resolved = join(this.root, relativePath)
    // The relative path is always built from uuid segments + a sanitized ext;
    // assert it stays inside the root regardless.
    const rel = relativePath.replace(/\\/g, '/')
    if (rel === '..' || rel.startsWith('../') || rel.includes('/../') || resolved.startsWith(this.root) === false) {
      throw new Error(`unsafe raw file path: ${relativePath}`)
    }
    return resolved
  }

  async write(baseId: string, docId: string, ext: string, bytes: Uint8Array): Promise<string> {
    const relativePath = `${baseId}/${docId}${ext}`
    const full = this.pathOf(relativePath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, bytes)
    return relativePath
  }

  async read(relativePath: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathOf(relativePath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async delete(relativePath: string): Promise<void> {
    await rm(this.pathOf(relativePath), { force: true })
  }

  async deleteBase(baseId: string): Promise<void> {
    // Validate through the same boundary as every other path: a crafted baseId
    // (e.g. a tampered domain record) must never let `rm -rf` escape the root.
    await rm(this.pathOf(baseId), { recursive: true, force: true })
  }
}

export interface Store {
  listBases(): KnowledgeBase[]
  getBase(id: string): KnowledgeBase | undefined
  putBase(base: KnowledgeBase): Promise<void>
  deleteBase(id: string): Promise<void>

  listDocuments(baseId: string): KnowledgeDocument[]
  getDocument(id: string): KnowledgeDocument | undefined
  putDocument(doc: KnowledgeDocument): Promise<void>
  deleteDocument(id: string): Promise<void>

  listChunks(baseId: string): KnowledgeChunk[]
  listChunksByDoc(docId: string, limit?: number, offset?: number): KnowledgeChunk[]
  /** Chunks of one document whose index falls in `[fromIdx, toIdx]` (sibling context around a search hit). */
  listChunksByIndexRange(docId: string, fromIdx: number, toIdx: number): KnowledgeChunk[]
  putChunks(chunks: KnowledgeChunk[]): Promise<void>
  /**
   * Incrementally persist a batch of chunks WITHOUT clearing the document's
   * other rows (the crash-recovery write path — each embedded batch lands
   * here, so a mid-embedding crash keeps every completed batch).
   */
  putChunkBatch(chunks: KnowledgeChunk[]): Promise<void>
  deleteChunks(docId: string): Promise<void>
  /** Drop every chunk of a base in one operation (used by deleteBase). */
  deleteChunksByBase(baseId: string): Promise<void>
  /**
   * Library-wide vector reuse: stored vectors for the given embedding-text
   * hashes under one embedding model (Cherry's `listExistingEmbeddingHashes` /
   * decision A4). The caller embeds only the hashes missing from the result,
   * so re-embedding unchanged chunk text reuses the stored vector.
   */
  listEmbeddingVectorsByHashes(hashes: readonly string[], embeddingModel: string): Map<string, number[]>
  /** Actual chunk count per document, for reconciling stale document metadata. */
  chunkCountsByDoc(baseIds: readonly string[]): Map<string, number>
  /** Per-doc chunk presence + embedding coverage in one pass (document lists). */
  docChunkStatus(baseId: string): { withChunks: Set<string>; missingEmbedding: Set<string> }
  /**
   * Startup self-healing, returning:
   * - `removed`: documents a crashed import left behind with nothing to
   *   recover — non-directory items with no chunks, no rawText AND no raw
   *   source file whose last update predates this process's start.
   * - `resume`: documents that hold recoverable material — rawText (crash
   *   mid-embedding, chunks partial) or a persisted raw source file (crash
   *   before/during parse) — re-indexed by the service after startup.
   */
  recoverInterruptedImports(startedAt: number): Promise<{ removed: number; resume: string[] }>
  /** Aggregate chunk stats without loading chunk rows. */
  chunkStats(baseIds: readonly string[]): ChunkStats
  /** SQL-backed retrieval lanes (FTS5 + vector scan); absent on in-memory stores. */
  readonly retrievalLane?: RetrievalLane
  /** Original source bytes of uploaded documents (absent on in-memory stores). */
  readonly raw?: RawFileStore
  /**
   * Return space a large delete freed back to the OS (Cherry's
   * `reclaimSpace`): WAL checkpoint, threshold-gated VACUUM + FTS optimize.
   * Absent on in-memory stores.
   */
  readonly reclaimSpace?: () => { vacuumed: boolean; reclaimedBytes: number }

  getConfigOverrides(): ConfigOverrides
  setConfigOverrides(overrides: ConfigOverrides): Promise<void>

  getGroups(): string[]
  setGroups(groups: string[]): Promise<void>

  getEnabled(): boolean
  setEnabled(enabled: boolean): Promise<void>
  getEnabledBaseIds(): string[]
  setEnabledBaseIds(ids: string[]): Promise<void>

  close(): Promise<void>
}

/** Facility surface the store needs — typed locally because the class type is package-private. */
export interface StorageDomainFacility {
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
}

export interface OpenStoreOptions {
  /** Chunk SQLite file; default `<DSH_HOME>/storages/knowledge-chunks.sqlite`. */
  chunkStorePath?: string
  /** Legacy JSON unit file to migrate chunks from; default `<DSH_HOME>/storages/knowledge.json`. */
  legacyJsonPath?: string
}

/**
 * Open a durable store. Business state comes from the domain facility; chunks
 * live in a plugin-owned SQLite file (`chunkStorePath`, defaulted under
 * `<DSH_HOME>/storages`). A one-time migration moves any chunks still stored
 * in the legacy JSON unit file into the SQLite store. Falls back to memory
 * when the facility is absent or fails.
 */
export async function openStore(
  facility: StorageDomainFacility | undefined,
  options?: OpenStoreOptions,
): Promise<Store> {
  if (facility !== undefined) {
    try {
      const domain = await facility.open(knowledgeDomainSpec)
      const chunkStorePath = resolveChunkStorePath(options?.chunkStorePath)
      const chunkDb = new ChunkDatabase(chunkStorePath)
      await migrateLegacyChunkFile(options?.legacyJsonPath ?? legacyChunkFilePath(), chunkDb, message => console.warn(message))
      // Original source bytes live next to the chunk store (Cherry's `raw/`
      // material store): `<chunkStoreDir>/knowledge-raw`.
      const raw = new RawFileStorage(join(dirname(chunkStorePath), 'knowledge-raw'))
      const store = new DomainStore(domain, chunkDb, raw)
      // Startup self-healing: drop documents a crashed import left behind
      // (pure placeholders with no recoverable text), then reconcile stale
      // chunkCount metadata. Resume candidates (rawText present, chunks
      // partial) are re-indexed by the service after openStore returns.
      const recovery = await store.recoverInterruptedImports(Date.now())
      if (recovery.removed > 0) console.warn(`dsh-knowledge: removed ${recovery.removed} incomplete import(s) left by an interrupted run`)
      await store.reconcileChunkCounts()
      return store
    } catch (error) {
      // Fall through to memory on any open failure (no backend, version mismatch, …).
      console.warn(`dsh-knowledge: storage domain unavailable, using in-memory store: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return new MemoryStore()
}

class DomainStore implements Store {
  constructor(
    private readonly domain: Domain<typeof knowledgeDomainSpec>,
    private readonly chunkDb: ChunkDatabase,
    private readonly rawStore: RawFileStorage,
  ) {}

  private get bases() {
    return this.domain.table(TABLES.bases)
  }

  private get documents() {
    return this.domain.table(TABLES.documents)
  }

  listBases(): KnowledgeBase[] {
    return [...this.bases.entries()].map(([, value]) => value)
  }

  getBase(id: string): KnowledgeBase | undefined {
    return this.bases.get(id)
  }

  putBase(base: KnowledgeBase): Promise<void> {
    return this.bases.put(base.id, base)
  }

  deleteBase(id: string): Promise<void> {
    return this.bases.delete(id).then(() => {})
  }

  listDocuments(baseId: string): KnowledgeDocument[] {
    return [...this.documents.entries()].map(([, value]) => value).filter(doc => doc.baseId === baseId)
  }

  getDocument(id: string): KnowledgeDocument | undefined {
    return this.documents.get(id)
  }

  putDocument(doc: KnowledgeDocument): Promise<void> {
    return this.documents.put(doc.id, doc)
  }

  deleteDocument(id: string): Promise<void> {
    return this.documents.delete(id).then(() => {})
  }

  listChunks(baseId: string): KnowledgeChunk[] {
    return this.chunkDb.listChunks(baseId)
  }

  listChunksByDoc(docId: string, limit?: number, offset?: number): KnowledgeChunk[] {
    return this.chunkDb.listChunksByDoc(docId, limit, offset)
  }

  listChunksByIndexRange(docId: string, fromIdx: number, toIdx: number): KnowledgeChunk[] {
    return this.chunkDb.listChunksByIndexRange(docId, fromIdx, toIdx)
  }

  async putChunks(chunks: KnowledgeChunk[]): Promise<void> {
    this.chunkDb.putChunks(chunks)
  }

  async putChunkBatch(chunks: KnowledgeChunk[]): Promise<void> {
    this.chunkDb.putChunkBatch(chunks)
  }

  async deleteChunks(docId: string): Promise<void> {
    this.chunkDb.deleteChunks(docId)
  }

  async deleteChunksByBase(baseId: string): Promise<void> {
    this.chunkDb.deleteChunksByBase(baseId)
  }

  listEmbeddingVectorsByHashes(hashes: readonly string[], embeddingModel: string): Map<string, number[]> {
    return this.chunkDb.listEmbeddingVectorsByHashes(hashes, embeddingModel)
  }

  chunkCountsByDoc(baseIds: readonly string[]): Map<string, number> {
    return this.chunkDb.chunkCountsByDoc(baseIds)
  }

  async recoverInterruptedImports(startedAt: number): Promise<{ removed: number; resume: string[] }> {
    const withChunks = new Set<string>()
    for (const base of this.listBases()) {
      for (const docId of this.chunkDb.docChunkStatus(base.id).withChunks) withChunks.add(docId)
    }
    let removed = 0
    const resume: string[] = []
    for (const [id, doc] of [...this.documents.entries()]) {
      if (doc.sourceType === 'directory') continue
      // An `incomplete` document holds persisted rawText and (probably) some
      // embedded batches — a crash mid-ingest. Recovery re-runs the embed:
      // hash reuse (decision A4) re-embeds only the missing batches, so the
      // resume is cheap. Distinguish it from a stale metadata count: the
      // reconciliation pass that runs after this one would otherwise make the
      // chunk count agree and hide the interrupted document forever.
      if (doc.incomplete === true) {
        if (doc.rawText !== undefined || doc.rawFilePath !== undefined) resume.push(id)
        continue
      }
      if (withChunks.has(id)) {
        // Chunks exist and the document is not marked incomplete: a completed
        // document (possibly with a recording embedding failure) — keep it.
        continue
      }
      // No chunks at all and no incomplete marker: a placeholder whose source
      // was never persisted (crash before the raw write or before rawText
      // landed) is unrecoverable; one that already holds rawText or a raw
      // source file was interrupted mid-import — resume it.
      if (doc.rawText !== undefined || doc.rawFilePath !== undefined) {
        if ((doc.updatedAt ?? doc.createdAt) < startedAt) resume.push(id)
        continue
      }
      // A completed document always has chunks (chunkText yields ≥1, even on
      // embedding failure); an item with none that predates this process was
      // left by a crash mid-import.
      if ((doc.updatedAt ?? doc.createdAt) >= startedAt) continue
      this.chunkDb.deleteChunks(id)
      await this.documents.delete(id)
      removed += 1
    }
    return { removed, resume }
  }

  /**
   * Write back the actual chunk count onto document records whose `chunkCount`
   * drifted from the chunk store (historical stale metadata). Also the first
   * domain write after a legacy-format upgrade, which trims the JSON unit file.
   */
  async reconcileChunkCounts(): Promise<void> {
    const actual = this.chunkCountsByDoc(this.listBases().map(base => base.id))
    for (const [id, doc] of [...this.documents.entries()]) {
      if ((doc.chunkCount ?? 0) !== (actual.get(id) ?? 0)) {
        await this.documents.put(id, { ...doc, chunkCount: actual.get(id) ?? 0 })
      }
    }
  }

  docChunkStatus(baseId: string): { withChunks: Set<string>; missingEmbedding: Set<string> } {
    return this.chunkDb.docChunkStatus(baseId)
  }

  chunkStats(baseIds: readonly string[]): ChunkStats {
    return this.chunkDb.chunkStats(baseIds)
  }

  get retrievalLane(): RetrievalLane {
    return this.chunkDb
  }

  get raw(): RawFileStore {
    return this.rawStore
  }

  reclaimSpace(): { vacuumed: boolean; reclaimedBytes: number } {
    return this.chunkDb.reclaimSpace()
  }

  getConfigOverrides(): ConfigOverrides {
    return this.readGlobal().overrides
  }

  async setConfigOverrides(overrides: ConfigOverrides): Promise<void> {
    await this.writeGlobal({ overrides: { ...this.readGlobal().overrides, ...overrides } })
  }

  getGroups(): string[] {
    return this.readGlobal().groups
  }

  async setGroups(groups: string[]): Promise<void> {
    await this.writeGlobal({ groups })
  }

  getEnabled(): boolean {
    return this.readGlobal().enabled
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.writeGlobal({ enabled })
  }

  getEnabledBaseIds(): string[] {
    return this.readGlobal().enabledBaseIds
  }

  async setEnabledBaseIds(ids: string[]): Promise<void> {
    await this.writeGlobal({ enabledBaseIds: ids })
  }

  private readGlobal(): { overrides: ConfigOverrides; groups: string[]; enabled: boolean; enabledBaseIds: string[] } {
    const global = this.domain.global.get() as { overrides?: ConfigOverrides; groups?: string[]; enabled?: boolean; enabledBaseIds?: string[] }
    return {
      overrides: global.overrides ?? {},
      groups: global.groups ?? [],
      enabled: global.enabled ?? true,
      enabledBaseIds: global.enabledBaseIds ?? [],
    }
  }

  private async writeGlobal(patch: { overrides?: ConfigOverrides; groups?: string[]; enabled?: boolean; enabledBaseIds?: string[] }): Promise<void> {
    const current = this.readGlobal()
    await (this.domain.global as { set(value: unknown): Promise<void> }).set({ ...current, ...patch })
  }

  async close(): Promise<void> {
    this.chunkDb.close()
    await this.domain.close()
  }
}

class MemoryStore implements Store {
  private readonly bases = new Map<string, KnowledgeBase>()
  private readonly documents = new Map<string, KnowledgeDocument>()
  private readonly chunks = new Map<string, KnowledgeChunk>()
  private overrides: ConfigOverrides = {}
  private groups: string[] = []
  private enabled = true
  private enabledBaseIds: string[] = []

  listBases(): KnowledgeBase[] {
    return [...this.bases.values()]
  }

  getBase(id: string): KnowledgeBase | undefined {
    return this.bases.get(id)
  }

  async putBase(base: KnowledgeBase): Promise<void> {
    this.bases.set(base.id, base)
  }

  async deleteBase(id: string): Promise<void> {
    this.bases.delete(id)
  }

  listDocuments(baseId: string): KnowledgeDocument[] {
    return [...this.documents.values()].filter(doc => doc.baseId === baseId)
  }

  getDocument(id: string): KnowledgeDocument | undefined {
    return this.documents.get(id)
  }

  async putDocument(doc: KnowledgeDocument): Promise<void> {
    this.documents.set(doc.id, doc)
  }

  async deleteDocument(id: string): Promise<void> {
    this.documents.delete(id)
  }

  listChunks(baseId: string): KnowledgeChunk[] {
    return [...this.chunks.values()].filter(chunk => chunk.baseId === baseId)
  }

  listChunksByDoc(docId: string, limit?: number, offset?: number): KnowledgeChunk[] {
    const chunks = [...this.chunks.values()].filter(chunk => chunk.docId === docId).sort((a, b) => a.index - b.index)
    const start = offset ?? 0
    const count = limit ?? chunks.length
    return chunks.slice(start, start + count)
  }

  listChunksByIndexRange(docId: string, fromIdx: number, toIdx: number): KnowledgeChunk[] {
    return [...this.chunks.values()]
      .filter(chunk => chunk.docId === docId && chunk.index >= fromIdx && chunk.index <= toIdx)
      .sort((a, b) => a.index - b.index)
  }

  async putChunks(chunks: KnowledgeChunk[]): Promise<void> {
    // Mirror the SQLite store's replace semantics: drop the document's old
    // rows, then insert the new bundle (a reindex must not leave stale chunks).
    const docId = chunks.length > 0 ? chunks[0].docId : undefined
    if (docId !== undefined) await this.deleteChunks(docId)
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk)
  }

  async putChunkBatch(chunks: KnowledgeChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk)
  }

  async deleteChunks(docId: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.docId === docId) this.chunks.delete(id)
    }
  }

  async deleteChunksByBase(baseId: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.baseId === baseId) this.chunks.delete(id)
    }
  }

  listEmbeddingVectorsByHashes(hashes: readonly string[], embeddingModel: string): Map<string, number[]> {
    const wanted = new Set(hashes)
    const vectors = new Map<string, number[]>()
    for (const chunk of this.chunks.values()) {
      if (chunk.embedding === undefined || chunk.embeddingModel !== embeddingModel) continue
      const hash = hashEmbeddingText(searchTextOf(chunk))
      if (wanted.has(hash)) vectors.set(hash, chunk.embedding)
    }
    return vectors
  }

  chunkCountsByDoc(baseIds: readonly string[]): Map<string, number> {
    const scope = new Set(baseIds)
    const counts = new Map<string, number>()
    for (const chunk of this.chunks.values()) {
      if (!scope.has(chunk.baseId)) continue
      counts.set(chunk.docId, (counts.get(chunk.docId) ?? 0) + 1)
    }
    return counts
  }

  async recoverInterruptedImports(startedAt: number): Promise<{ removed: number; resume: string[] }> {
    const withChunks = new Set<string>()
    for (const chunk of this.chunks.values()) withChunks.add(chunk.docId)
    let removed = 0
    const resume: string[] = []
    for (const [id, doc] of [...this.documents.entries()]) {
      if (doc.sourceType === 'directory') continue
      if (doc.incomplete === true) {
        if (doc.rawText !== undefined || doc.rawFilePath !== undefined) resume.push(id)
        continue
      }
      if (withChunks.has(id)) continue
      if (doc.rawText !== undefined || doc.rawFilePath !== undefined) {
        if ((doc.updatedAt ?? doc.createdAt) < startedAt) resume.push(id)
        continue
      }
      if ((doc.updatedAt ?? doc.createdAt) >= startedAt) continue
      this.documents.delete(id)
      removed += 1
    }
    return { removed, resume }
  }

  docChunkStatus(baseId: string): { withChunks: Set<string>; missingEmbedding: Set<string> } {
    const withChunks = new Set<string>()
    const missingEmbedding = new Set<string>()
    for (const chunk of this.chunks.values()) {
      if (chunk.baseId !== baseId) continue
      withChunks.add(chunk.docId)
      if (chunk.embedding === undefined) missingEmbedding.add(chunk.docId)
    }
    return { withChunks, missingEmbedding }
  }

  chunkStats(baseIds: readonly string[]): ChunkStats {
    const scope = new Set(baseIds)
    const modelCounts = new Map<string, number>()
    let count = 0
    let embedded = false
    let dimensions: number | undefined
    for (const chunk of this.chunks.values()) {
      if (!scope.has(chunk.baseId)) continue
      count += 1
      if (chunk.embedding === undefined) continue
      embedded = true
      if (dimensions === undefined) dimensions = chunk.embedding.length
      if (chunk.embeddingModel !== undefined) {
        const key = `${chunk.baseId}\u0000${chunk.embeddingModel}`
        modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1)
      }
    }
    return {
      count,
      embedded,
      ...(dimensions !== undefined ? { dimensions } : {}),
      embeddingModelCounts: [...modelCounts.entries()].map(([key, countValue]) => {
        const [baseId, model] = key.split('\u0000')
        return { baseId, model, count: countValue }
      }),
    }
  }

  getConfigOverrides(): ConfigOverrides {
    return { ...this.overrides }
  }

  async setConfigOverrides(overrides: ConfigOverrides): Promise<void> {
    this.overrides = { ...this.overrides, ...overrides }
  }

  getGroups(): string[] {
    return [...this.groups]
  }

  async setGroups(groups: string[]): Promise<void> {
    this.groups = [...groups]
  }

  getEnabled(): boolean {
    return this.enabled
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
  }

  getEnabledBaseIds(): string[] {
    return [...this.enabledBaseIds]
  }

  async setEnabledBaseIds(ids: string[]): Promise<void> {
    this.enabledBaseIds = [...ids]
  }

  async close(): Promise<void> {}
}
