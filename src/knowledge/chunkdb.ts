/**
 * Chunk storage for dsh-knowledge: a plugin-owned SQLite file (Cherry Studio's
 * "derived index" idea — the durable domain keeps business state, chunks live
 * in a dedicated engine where each write is O(1)).
 *
 * Layout (one row per chunk, not per document):
 * - `chunk` holds every retrieval field; `embedding` is a plain little-endian
 *   float32 BLOB (Cherry's A1), so the DB stays engine-portable.
 * - `chunk_fts` is an external-content FTS5 table (trigram tokenizer) over the
 *   search text (context + body), kept in sync by AFTER INSERT/DELETE/UPDATE
 *   triggers — the lexical lane.
 * - The vector lane brute-force scans the scope's BLOBs at query time (no ANN
 *   index yet — the same posture as Cherry's first version).
 *
 * Nothing is loaded into memory at open: every read is a bounded SQL query, so
 * resident memory no longer scales with the corpus.
 * @module dsh-knowledge/knowledge/chunkdb
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { KnowledgeChunk, KnowledgeDocument } from './types.js'
import { validSourceSpan } from './source-spans.js'

/** Resolve the chunk database path: explicit config, else `<DSH_HOME>/storages/`. */
export function resolveChunkStorePath(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  return join(dshHome(), 'storages', 'knowledge-chunks.sqlite')
}

/** Legacy location of the old unit file whose chunks table feeds the one-time migration. */
export function legacyChunkFilePath(): string {
  return join(dshHome(), 'storages', 'knowledge.json')
}

function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Max bound parameters per reuse query (SQLite's limit is ~999; Cherry uses 500). */
const EMBEDDING_HASH_QUERY_BATCH = 500

/** Chunk rows deleted per statement (each row fires the FTS tombstone trigger). */
const DELETE_BATCH_SIZE = 2000
/** Yield the host event loop after this much cumulative delete time (Cherry's budget). */
const DELETE_YIELD_BUDGET_MS = 50

/**
 * VACUUM only when the freelist is BOTH a large share of the file AND a
 * meaningful byte count (Cherry's thresholds): a tiny delete must not pay for
 * a whole-file rewrite whose freed pages a later index would reuse anyway.
 * Below either bound, reclaim just truncates the WAL (cheap, returns nothing).
 */
const VACUUM_MIN_FREELIST_RATIO = 0.2
const VACUUM_MIN_FREED_BYTES = 8 * 1024 * 1024

function throwIfDeadlineExpired(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new DOMException('knowledge search deadline exceeded', 'TimeoutError')
  }
}

// ── FTS query compilation (trigram tokenizer) ────────────────────────────────

/**
 * Cap on MATCH terms per query. Bounds the term *count* a long CJK question can
 * contribute (each character past the second adds a trigram), not the size of
 * any one term. Whole words rank ahead of trigram windows in
 * {@link extractMatchTerms}, so the cap sheds the tail of a long clause rather
 * than a rare word sitting at the end of the question (Cherry's ftsQuery.ts).
 */
const MAX_MATCH_TERMS = 64

/** Extract word/number tokens (Unicode letters, numbers, underscore) from free user text. */
function extractFtsTokens(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? []
}

/** Tokens a trigram index can MATCH: whole words (≥3 chars) and CJK trigram windows. */
function extractMatchTerms(query: string): string[] {
  const trigrams: string[] = []
  const words: string[] = []
  for (const token of extractFtsTokens(query)) {
    const chars = [...token]
    let cursor = 0
    while (cursor < chars.length) {
      const unsegmented = UNSEGMENTED_SCRIPT.test(chars[cursor])
      let end = cursor + 1
      while (end < chars.length && UNSEGMENTED_SCRIPT.test(chars[end]) === unsegmented) end += 1
      const run = chars.slice(cursor, end)
      if (!unsegmented || run.length <= 3) {
        words.push(run.join(''))
      } else {
        for (let start = 0; start + 3 <= run.length; start += 1) trigrams.push(run.slice(start, start + 3).join(''))
      }
      cursor = end
    }
  }
  const distinct = [...new Set([...words.filter(word => [...word].length >= 3), ...trigrams])]
  if (distinct.length > MAX_MATCH_TERMS) {
    console.warn(`[dsh-knowledge] BM25 query exceeds the MATCH term cap; shedding the tail (${distinct.length} terms)`)
  }
  return distinct.slice(0, MAX_MATCH_TERMS)
}

/** Terms of 1–2 characters: no trigram, applied as LIKE filters (Cherry's approach). */
function extractShortTerms(query: string): string[] {
  return [...new Set(extractFtsTokens(query).filter(token => [...token].length < 3))]
}

/**
 * SQL fragment + params narrowing a chunk query to a document subset, or
 * `null` when unrestricted. Each id set uses one JSON parameter, so large
 * metadata filters do not exceed SQLite's bound-parameter limit.
 */
function docFilterSql(filter: RetrievalDocumentFilter | undefined, column: string): { sql: string; params: string[] } | null {
  if (filter === undefined) return null
  if (filter.docIds !== undefined && filter.docIds.length === 0) return { sql: ' AND 0 = 1', params: [] }
  const conditions: string[] = []
  const params: string[] = []
  if (filter.docIds !== undefined) {
    conditions.push(` AND ${column} IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(filter.docIds))
  }
  if (filter.excludeDocIds !== undefined && filter.excludeDocIds.length > 0) {
    conditions.push(` AND ${column} NOT IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(filter.excludeDocIds))
  }
  return conditions.length > 0 ? { sql: conditions.join(''), params } : null
}

const UNSEGMENTED_SCRIPT = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u

/** `%`-wrapped LIKE pattern matching `token` as a literal substring. */
function toLikePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, ch => `\\${ch}`)}%`
}

/**
 * True when the query yields no trigram-indexable term (symbols-only input
 * like `!!!`, or every token is 1–2 chars). A MATCH with no terms would be
 * `MATCH ''`, which FTS5 rejects with a syntax error — route to the safe
 * LIKE scan instead (which simply matches nothing for symbol-only input).
 */
function needsLikeFallback(query: string): boolean {
  return extractMatchTerms(query).length === 0
}

// ── embedding BLOB codec (little-endian float32) ─────────────────────────────

function encodeEmbedding(values: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer)
}

function decodeEmbedding(blob: Buffer | null | undefined): number[] | undefined {
  if (blob === undefined || blob === null || blob.byteLength === 0) return undefined
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4))
}

/** Decode an embedding BLOB straight into a Float32Array (cache path). */
function decodeEmbeddingFloat32(blob: Buffer | null | undefined): Float32Array | undefined {
  if (blob === undefined || blob === null || blob.byteLength === 0) return undefined
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
}

/** Cosine similarity between two equal-length float32 vectors (true cosine,
 *  correct for raw and unit-normalized vectors alike; NaN-safe). */
function cosineFloat32(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]
    const bv = b[i]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const norm = Math.sqrt(normA) * Math.sqrt(normB)
  if (norm === 0) return 0
  const cosine = dot / norm
  return Number.isFinite(cosine) ? Math.max(0, Math.min(1, cosine)) : 0
}

/** Rebuild a ChunkRow from a chunk for the vector cache. */
function toChunkRow(chunk: KnowledgeChunk): ChunkRow {
  return {
    chunk_id: chunk.id,
    doc_id: chunk.docId,
    base_id: chunk.baseId,
    idx: chunk.index,
    text: chunk.text,
    heading: chunk.heading ?? null,
    context: chunk.context ?? null,
    embedding: chunk.embedding !== undefined ? encodeEmbedding(chunk.embedding) : null,
    embedding_model: chunk.embeddingModel ?? null,
    source_spans: chunk.sourceSpans !== undefined ? JSON.stringify(chunk.sourceSpans) : null,
    processing_revision: chunk.processingRevision ?? null,
  }
}

/**
 * Stable hash of the exact text fed to the embedding model — the dedup key for
 * vector reuse (Cherry's `embedding_text_hash` / decision A4). Two chunks with
 * the same hash + embedding model share one embedding, so a re-embed (reindex,
 * chunk-size change) reuses stored vectors instead of re-spending the API.
 * The hash covers the SAME text `embedTexts` receives (context + body), so an
 * identical hash guarantees an identical vector.
 */
export function hashEmbeddingText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ── the store ────────────────────────────────────────────────────────────────

/** One candidate returned by a retrieval lane: a chunk plus its lane score. */
export interface LaneHit extends KnowledgeChunk {
  score: number
}

export interface LaneResult {
  /** Size of the scanned candidate pool (the pre-limit corpus). */
  total: number
  hits: LaneHit[]
}

/** Document selection shared by lexical and vector candidate retrieval. */
export interface RetrievalDocumentFilter {
  /** Absent means unrestricted; an empty array matches no documents. */
  readonly docIds?: readonly string[]
  /** Exact ids removed before counting, scoring, or limiting candidates. */
  readonly excludeDocIds?: readonly string[]
}

export interface RetrievalLane {
  /** FTS5 BM25 hits over the scope (score normalized into [0, 1)). */
  lexical(query: string, baseIds: readonly string[], limit: number, filter?: RetrievalDocumentFilter, deadlineAt?: number): Promise<LaneResult>
  /** Brute-force cosine hits over the scope's stored vectors. */
  vector(embedding: readonly number[], baseIds: readonly string[], limit: number, filter?: RetrievalDocumentFilter, deadlineAt?: number): Promise<LaneResult>
}

export interface StagedDocumentGeneration {
  readonly document: KnowledgeDocument
  readonly chunks: KnowledgeChunk[]
}

export interface PendingDocumentGeneration {
  readonly document: KnowledgeDocument
  readonly previousCreatedAt: number
}

export function validateDocumentGeneration(doc: KnowledgeDocument, chunks: readonly KnowledgeChunk[]): void {
  const ids = new Set<string>()
  const indices = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.docId !== doc.id || chunk.baseId !== doc.baseId || ids.has(chunk.id) || indices.has(chunk.index)
      || !Number.isSafeInteger(chunk.index) || chunk.index < 0
      || chunk.processingRevision !== doc.processing?.revision
      || !(chunk.sourceSpans ?? []).every(span => validSourceSpan(span) && span.chunkEnd <= chunk.text.length
        && span.revision === chunk.processingRevision)) throw new Error('invalid document generation')
    ids.add(chunk.id)
    indices.add(chunk.index)
  }
}

/** The chunk store: bounded SQL reads, single-transaction writes. */
export class ChunkDatabase implements RetrievalLane {
  private readonly db: DatabaseSync

  /**
   * Per-base vector cache for the brute-force lane: vectors load lazily on
   * the first vector query for a base and stay in sync with every write
   * path, so repeated searches never re-fetch/re-decode the BLOBs. Float32
   * storage keeps the cosine loop on typed arrays. Invalidation stays
   * exact (per doc / per base), never a whole-store flush.
   */
  private readonly vectorCache = new Map<string, Array<{ id: string; docId: string; vector: Float32Array; row: ChunkRow }>>()
  /** `PRAGMA data_version` observed when each base's cache was loaded, so a
   *  write from another connection invalidates it instead of being invisible. */
  private readonly vectorCacheDataVersion = new Map<string, number>()

  private static readonly SELECT_COLUMNS = 'chunk_id, doc_id, base_id, idx, text, heading, context, embedding, embedding_model, source_spans, processing_revision'

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = OFF')
    // Abort long synchronous scans from inside SQLite itself. AbortSignal
    // timers cannot fire while DatabaseSync blocks the JS event loop, so the
    // non-deterministic row guard checks the absolute deadline during VM
    // execution and raises before a short-CJK LIKE scan can run unbounded.
    this.db.function('knowledge_before_deadline', (deadline, _rowKey) => {
      if (typeof deadline === 'number' && Date.now() >= deadline) {
        throw new Error('knowledge search deadline exceeded')
      }
      return 1
    })
    // Multiple connections can touch the store (a second plugin instance, a
    // crashed-and-restarted host still holding the old file, the one-time
    // migration path, or a concurrent checkpoint/VACUUM). SQLite's default
    // busy_timeout is 0 — a write that meets another connection's lock fails
    // instantly with SQLITE_BUSY ("database is locked") instead of waiting.
    // 5s covers short read/write overlaps without hiding a real deadlock.
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        base_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        search_text TEXT NOT NULL,
        heading TEXT,
        context TEXT,
        embedding BLOB,
        embedding_model TEXT,
        embedding_text_hash TEXT,
        fts_rowid INTEGER
      );
      CREATE INDEX IF NOT EXISTS chunk_doc_idx ON chunk(doc_id);
      CREATE INDEX IF NOT EXISTS chunk_base_idx ON chunk(base_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        search_text, content='chunk', content_rowid='fts_rowid', tokenize='trigram'
      );
      -- fts_rowid is a STABLE surrogate key assigned by the insert trigger (never
      -- app code): the implicit rowid is renumbered by VACUUM, which would silently
      -- desync this external-content FTS from its rows (Cherry's #16132-class fix).
      CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
        UPDATE chunk SET fts_rowid = (SELECT COALESCE(MAX(fts_rowid), 0) + 1 FROM chunk)
          WHERE chunk_id = NEW.chunk_id;
        INSERT INTO chunk_fts(rowid, search_text)
        SELECT fts_rowid, search_text FROM chunk WHERE chunk_id = NEW.chunk_id;
      END;
      CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES ('delete', OLD.fts_rowid, OLD.search_text);
      END;
      -- fts_rowid is stable across a text edit, so it is not reassigned — only the
      -- FTS row is re-keyed.
      CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE OF search_text ON chunk BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES ('delete', OLD.fts_rowid, OLD.search_text);
        INSERT INTO chunk_fts(rowid, search_text) VALUES (NEW.fts_rowid, NEW.search_text);
      END;
    `)
    this.migrateEmbeddingHashColumn()
    this.migrateFtsRowidColumn()
    this.migrateEvidenceColumns()
    this.migrateFromBundleLayout()
  }

  private migrateEvidenceColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(chunk)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'source_spans')) this.db.exec('ALTER TABLE chunk ADD COLUMN source_spans TEXT')
    if (!columns.some(column => column.name === 'processing_revision')) this.db.exec('ALTER TABLE chunk ADD COLUMN processing_revision TEXT')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_generation_stage (
        doc_id TEXT PRIMARY KEY, base_id TEXT NOT NULL, revision TEXT NOT NULL, next_document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_generation_chunk (
        doc_id TEXT NOT NULL, chunk_id TEXT NOT NULL, chunk_json TEXT NOT NULL,
        embedding_text_hash TEXT, embedding_model TEXT, embedding BLOB,
        PRIMARY KEY (doc_id, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS generation_embedding_hash ON document_generation_chunk(embedding_text_hash, embedding_model);
      CREATE TABLE IF NOT EXISTS document_generation_commit (
        doc_id TEXT PRIMARY KEY, base_id TEXT NOT NULL, previous_created_at INTEGER NOT NULL, next_document TEXT NOT NULL
      );
    `)
  }

  /**
   * Schema evolution for the stable FTS surrogate key: older stores keyed the
   * external-content FTS on the implicit `rowid`, which VACUUM renumbers — the
   * FTS then silently points at the wrong rows (Cherry's #16132 class). Adds
   * the `fts_rowid` column, backfills it from the current rowid, and rebuilds
   * `chunk_fts` (virtual tables cannot change their content_rowid in place).
   * Idempotent: a fresh store already has both, so only the unique index is
   * ensured. `fts_rowid` must be unique so the MAX+1 assignment in the insert
   * trigger stays a correct key — the UNIQUE index makes a violation loud.
   */
  private migrateFtsRowidColumn(): void {
    // Guard on a PERSISTED MARKER, not on the schema text. A migration
    // interrupted between CREATE VIRTUAL TABLE and 'rebuild' leaves a table
    // whose SQL is exactly what the old textual check accepted
    // (`fts.sql.includes('fts_rowid')`), so the rebuild was skipped forever and
    // every lexical query silently returned nothing for pre-existing content.
    // The marker is written inside the same transaction as the rebuild, so it
    // can never exist for a half-applied migration; a store upgraded from an
    // older build simply rebuilds once. (FTS5's own 'integrity-check' cannot be
    // used here: on an external-content table it accepts an empty index.)
    this.db.exec('CREATE TABLE IF NOT EXISTS chunk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    if (this.readMeta('fts_rowid_migrated') === '1') return

    const columns = this.db.prepare('PRAGMA table_info(chunk)').all() as Array<{ name: string }>
    const hasFtsRowid = columns.some(column => column.name === 'fts_rowid')
    const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'").get() as { sql: string } | undefined
    const keyedOnFtsRowid = fts !== undefined && fts.sql.includes('fts_rowid')

    // The migration replaces the FTS table and its triggers in ~8 statements, so
    // make it atomic: a partial application is what produced the state above.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasFtsRowid) this.db.exec('ALTER TABLE chunk ADD COLUMN fts_rowid INTEGER')
      this.db.exec('UPDATE chunk SET fts_rowid = rowid WHERE fts_rowid IS NULL')
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS chunk_fts_rowid_uniq ON chunk(fts_rowid)')
      if (!keyedOnFtsRowid) {
        this.db.exec('DROP TRIGGER IF EXISTS chunk_ai')
        this.db.exec('DROP TRIGGER IF EXISTS chunk_ad')
        this.db.exec('DROP TRIGGER IF EXISTS chunk_au')
        this.db.exec('DROP TABLE IF EXISTS chunk_fts')
        this.db.exec(`CREATE VIRTUAL TABLE chunk_fts USING fts5(
          search_text, content='chunk', content_rowid='fts_rowid', tokenize='trigram'
        )`)
        this.db.exec(`CREATE TRIGGER chunk_ai AFTER INSERT ON chunk BEGIN
          UPDATE chunk SET fts_rowid = (SELECT COALESCE(MAX(fts_rowid), 0) + 1 FROM chunk)
            WHERE chunk_id = NEW.chunk_id;
          INSERT INTO chunk_fts(rowid, search_text)
          SELECT fts_rowid, search_text FROM chunk WHERE chunk_id = NEW.chunk_id;
        END`)
        this.db.exec(`CREATE TRIGGER chunk_ad AFTER DELETE ON chunk BEGIN
          INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES ('delete', OLD.fts_rowid, OLD.search_text);
        END`)
        this.db.exec(`CREATE TRIGGER chunk_au AFTER UPDATE OF search_text ON chunk BEGIN
          INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES ('delete', OLD.fts_rowid, OLD.search_text);
          INSERT INTO chunk_fts(rowid, search_text) VALUES (NEW.fts_rowid, NEW.search_text);
        END`)
      }
      this.db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')`)
      this.writeMeta('fts_rowid_migrated', '1')
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // the original failure is the one worth reporting
      }
      throw error
    }
  }

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM chunk_meta WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value
  }

  private writeMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO chunk_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /**
   * Schema evolution for the `embedding_text_hash` dedup column: add it to a
   * store created by an older version, then backfill the hash of every stored
   * vector from its `search_text` (the exact text the embedding model saw, so
   * the hash is authoritative for reuse). Idempotent — a fresh store already
   * has the column and nothing to backfill. The index is created here, AFTER
   * the column exists: on an old store the column does not exist when the
   * constructor's CREATE TABLE runs, and a CREATE INDEX on a missing column
   * would fail the whole open.
   */
  private migrateEmbeddingHashColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(chunk)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'embedding_text_hash')) {
      this.db.exec('ALTER TABLE chunk ADD COLUMN embedding_text_hash TEXT')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS chunk_emb_hash_idx ON chunk(embedding_text_hash, embedding_model)')
    const missing = this.db.prepare(
      'SELECT chunk_id, search_text FROM chunk WHERE embedding IS NOT NULL AND embedding_text_hash IS NULL',
    ).all() as Array<{ chunk_id: string; search_text: string }>
    if (missing.length === 0) return
    const update = this.db.prepare('UPDATE chunk SET embedding_text_hash = ? WHERE chunk_id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of missing) update.run(hashEmbeddingText(row.search_text), row.chunk_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** One-time migration from the previous per-document bundle layout. */
  private migrateFromBundleLayout(): void {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunk_bundles'").get() as { name: string } | undefined
    if (table === undefined) return
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM chunk').get() as { c: number }).c
    if (count === 0) {
      const bundles = this.db.prepare('SELECT doc_id, chunks_json FROM chunk_bundles').all() as Array<{ doc_id: string; chunks_json: string }>
      const insert = this.db.prepare(
        'INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text, heading, context, embedding, embedding_model, embedding_text_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of bundles) {
          const chunks = JSON.parse(row.chunks_json) as KnowledgeChunk[]
          for (const chunk of chunks) {
            const searchText = searchTextOf(chunk)
            insert.run(
              chunk.id,
              chunk.docId,
              chunk.baseId,
              chunk.index,
              chunk.text,
              searchText,
              chunk.heading ?? null,
              chunk.context ?? null,
              chunk.embedding !== undefined ? encodeEmbedding(chunk.embedding) : null,
              chunk.embeddingModel ?? null,
              chunk.embedding !== undefined ? hashEmbeddingText(searchText) : null,
            )
          }
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    this.db.exec('DROP TABLE IF EXISTS chunk_bundles')
  }

  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM chunk').get() as { c: number }).c
  }

  listChunks(baseId: string): KnowledgeChunk[] {
    const rows = this.db.prepare(`SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE base_id = ? ORDER BY doc_id, idx`).all(baseId) as unknown as ChunkRow[]
    return rows.map(rowToChunk)
  }

  getChunk(id: string): KnowledgeChunk | undefined {
    const row = this.db.prepare(
      `SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE chunk_id = ?`,
    ).get(id) as unknown as ChunkRow | undefined
    return row === undefined ? undefined : rowToChunk(row)
  }

  listChunksByDoc(docId: string, limit?: number, offset?: number): KnowledgeChunk[] {
    const sql = `SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE doc_id = ? ORDER BY idx`
    const rows = limit !== undefined
      ? this.db.prepare(`${sql} LIMIT ? OFFSET ?`).all(docId, limit, offset ?? 0)
      : this.db.prepare(sql).all(docId)
    return (rows as unknown as ChunkRow[]).map(rowToChunk)
  }

  /** Chunks of one document whose index falls in `[fromIdx, toIdx]` — the
   *  sibling context around a search hit, fetched with one bounded SQL query. */
  listChunksByIndexRange(docId: string, fromIdx: number, toIdx: number): KnowledgeChunk[] {
    const rows = this.db.prepare(
      `SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE doc_id = ? AND idx >= ? AND idx <= ? ORDER BY idx`,
    ).all(docId, fromIdx, toIdx) as unknown as ChunkRow[]
    return rows.map(rowToChunk)
  }

  /** Fetch several already-merged document ranges in one SQL statement. */
  listChunksByIndexRanges(ranges: readonly { docId: string; fromIdx: number; toIdx: number }[]): KnowledgeChunk[] {
    if (ranges.length === 0) return []
    const clauses = ranges.map(() => '(doc_id = ? AND idx >= ? AND idx <= ?)').join(' OR ')
    const params = ranges.flatMap(range => [range.docId, Math.trunc(range.fromIdx), Math.trunc(range.toIdx)])
    const rows = this.db.prepare(
      `SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE ${clauses} ORDER BY doc_id, idx`,
    ).all(...params) as unknown as ChunkRow[]
    return rows.map(rowToChunk)
  }

  /** Actual chunk count per document, for reconciling stale document metadata. */
  chunkCountsByDoc(baseIds: readonly string[]): Map<string, number> {
    const scope = [...baseIds]
    if (scope.length === 0) return new Map()
    const placeholders = scope.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT doc_id, COUNT(*) AS c FROM chunk WHERE base_id IN (${placeholders}) GROUP BY doc_id`).all(...scope) as Array<{ doc_id: string; c: number }>
    return new Map(rows.map(row => [row.doc_id, row.c]))
  }

  putChunks(chunks: KnowledgeChunk[]): void {
    if (chunks.length === 0) return
    const docId = chunks[0].docId
    const baseId = chunks[0].baseId
    // Scoped to the doc's own base: doc ids are UUIDs (globally unique in
    // practice), but an un-scoped delete would silently wipe another base's
    // rows if that invariant ever broke.
    const deleteOld = this.db.prepare('DELETE FROM chunk WHERE doc_id = ? AND base_id = ?')
    const insert = this.db.prepare(
      'INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text, heading, context, embedding, embedding_model, embedding_text_hash, source_spans, processing_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      deleteOld.run(docId, baseId)
      for (const chunk of chunks) {
        const searchText = searchTextOf(chunk)
        insert.run(
          chunk.id,
          chunk.docId,
          chunk.baseId,
          chunk.index,
          chunk.text,
          searchText,
          chunk.heading ?? null,
          chunk.context ?? null,
          chunk.embedding !== undefined ? encodeEmbedding(chunk.embedding) : null,
          chunk.embeddingModel ?? null,
          chunk.embedding !== undefined ? hashEmbeddingText(searchText) : null,
          chunk.sourceSpans !== undefined ? JSON.stringify(chunk.sourceSpans) : null,
          chunk.processingRevision ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    // Keep the vector cache in sync: the document's rows were replaced.
    this.dropVectorCacheByDoc(docId)
    for (const chunk of chunks) this.upsertVectorCache(chunk)
  }

  /**
   * Incrementally persist a batch of chunks WITHOUT clearing the document's
   * other rows (unlike {@link putChunks}, which replaces the whole bundle).
   * This is the crash-recovery write path: `ingestDocument` embeds in batches
   * and lands each batch here, so a crash mid-embedding leaves every completed
   * batch in the store. On restart the recovery pass re-runs the embed with
   * hash reuse (decision A4) and only the missing batches hit the API.
   *
   * `ON CONFLICT(chunk_id) DO UPDATE` (not REPLACE) keeps the rowid stable, so
   * the external-content FTS trigger chain stays consistent.
   */
  putChunkBatch(chunks: KnowledgeChunk[]): void {
    if (chunks.length === 0) return
    const upsert = this.db.prepare(
      `INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text, heading, context, embedding, embedding_model, embedding_text_hash, source_spans, processing_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         doc_id = excluded.doc_id, base_id = excluded.base_id, idx = excluded.idx,
         text = excluded.text, search_text = excluded.search_text, heading = excluded.heading,
         context = excluded.context, embedding = excluded.embedding,
         embedding_model = excluded.embedding_model, embedding_text_hash = excluded.embedding_text_hash,
         source_spans = excluded.source_spans, processing_revision = excluded.processing_revision`,
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const chunk of chunks) {
        const searchText = searchTextOf(chunk)
        upsert.run(
          chunk.id,
          chunk.docId,
          chunk.baseId,
          chunk.index,
          chunk.text,
          searchText,
          chunk.heading ?? null,
          chunk.context ?? null,
          chunk.embedding !== undefined ? encodeEmbedding(chunk.embedding) : null,
          chunk.embeddingModel ?? null,
          chunk.embedding !== undefined ? hashEmbeddingText(searchText) : null,
          chunk.sourceSpans !== undefined ? JSON.stringify(chunk.sourceSpans) : null,
          chunk.processingRevision ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    for (const chunk of chunks) this.upsertVectorCache(chunk)
  }

  /** Durable candidate batches remain invisible to both retrieval lanes. */
  stageDocumentGeneration(doc: KnowledgeDocument, chunks: KnowledgeChunk[]): void {
    validateDocumentGeneration(doc, chunks)
    const revision = doc.processing?.revision ?? `legacy:${doc.updatedAt}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT revision FROM document_generation_stage WHERE doc_id = ?').get(doc.id) as { revision: string } | undefined
      if (previous !== undefined && previous.revision !== revision) {
        this.db.prepare('DELETE FROM document_generation_chunk WHERE doc_id = ?').run(doc.id)
      }
      this.db.prepare(`INSERT INTO document_generation_stage(doc_id, base_id, revision, next_document) VALUES (?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET base_id = excluded.base_id, revision = excluded.revision, next_document = excluded.next_document`)
        .run(doc.id, doc.baseId, revision, JSON.stringify(doc))
      const insert = this.db.prepare(`INSERT INTO document_generation_chunk(doc_id, chunk_id, chunk_json, embedding_text_hash, embedding_model, embedding)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id, chunk_id) DO UPDATE SET chunk_json = excluded.chunk_json,
        embedding_text_hash = excluded.embedding_text_hash, embedding_model = excluded.embedding_model, embedding = excluded.embedding`)
      for (const chunk of chunks) insert.run(doc.id, chunk.id, JSON.stringify(chunk),
        chunk.embedding !== undefined ? hashEmbeddingText(searchTextOf(chunk)) : null,
        chunk.embeddingModel ?? null, chunk.embedding !== undefined ? encodeEmbedding(chunk.embedding) : null)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getStagedDocumentGeneration(docId: string): StagedDocumentGeneration | undefined {
    const row = this.db.prepare('SELECT next_document FROM document_generation_stage WHERE doc_id = ?').get(docId) as { next_document: string } | undefined
    if (row === undefined) return undefined
    const rows = this.db.prepare('SELECT chunk_json FROM document_generation_chunk WHERE doc_id = ?').all(docId) as Array<{ chunk_json: string }>
    return { document: JSON.parse(row.next_document) as KnowledgeDocument,
      chunks: rows.map(row => JSON.parse(row.chunk_json) as KnowledgeChunk).sort((a, b) => a.index - b.index) }
  }

  /** Replace the live generation and its recovery record in ONE transaction. */
  publishDocumentGeneration(doc: KnowledgeDocument, chunks: KnowledgeChunk[], previousCreatedAt: number): void {
    validateDocumentGeneration(doc, chunks)
    if (doc.chunkCount !== chunks.length) throw new Error('document generation chunk count mismatch')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM chunk WHERE doc_id = ? AND base_id = ?').run(doc.id, doc.baseId)
      const insert = this.db.prepare(`INSERT INTO chunk
        (chunk_id, doc_id, base_id, idx, text, search_text, heading, context, embedding, embedding_model, embedding_text_hash, source_spans, processing_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const chunk of chunks) insert.run(chunk.id, chunk.docId, chunk.baseId, chunk.index, chunk.text, searchTextOf(chunk),
        chunk.heading ?? null, chunk.context ?? null, chunk.embedding !== undefined ? encodeEmbedding(chunk.embedding) : null,
        chunk.embeddingModel ?? null, chunk.embedding !== undefined ? hashEmbeddingText(searchTextOf(chunk)) : null,
        chunk.sourceSpans !== undefined ? JSON.stringify(chunk.sourceSpans) : null, chunk.processingRevision ?? null)
      this.db.prepare(`INSERT INTO document_generation_commit(doc_id, base_id, previous_created_at, next_document) VALUES (?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET base_id = excluded.base_id, previous_created_at = excluded.previous_created_at, next_document = excluded.next_document`)
        .run(doc.id, doc.baseId, previousCreatedAt, JSON.stringify(doc))
      this.db.prepare('DELETE FROM document_generation_stage WHERE doc_id = ?').run(doc.id)
      this.db.prepare('DELETE FROM document_generation_chunk WHERE doc_id = ?').run(doc.id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.dropVectorCacheByDoc(doc.id)
    for (const chunk of chunks) this.upsertVectorCache(chunk)
  }

  pendingDocumentGenerations(): PendingDocumentGeneration[] {
    const rows = this.db.prepare('SELECT next_document, previous_created_at FROM document_generation_commit').all() as Array<{ next_document: string; previous_created_at: number }>
    return rows.map(row => ({ document: JSON.parse(row.next_document) as KnowledgeDocument, previousCreatedAt: row.previous_created_at }))
  }

  stagedDocumentHeaders(): KnowledgeDocument[] {
    const rows = this.db.prepare('SELECT next_document FROM document_generation_stage').all() as Array<{ next_document: string }>
    return rows.map(row => JSON.parse(row.next_document) as KnowledgeDocument)
  }

  discardPublishedGeneration(doc: KnowledgeDocument): void {
    // Reused IDs must not let an old journal delete a newer incarnation's rows.
    if (doc.processing?.revision !== undefined) {
      this.db.prepare('DELETE FROM chunk WHERE doc_id = ? AND base_id = ? AND processing_revision = ?')
        .run(doc.id, doc.baseId, doc.processing.revision)
      this.dropVectorCacheByDoc(doc.id)
      this.vectorCache.delete(doc.baseId)
    }
    this.discardDocumentGenerations(doc.id)
  }

  pendingDocumentGeneration(docId: string): PendingDocumentGeneration | undefined {
    const row = this.db.prepare('SELECT next_document, previous_created_at FROM document_generation_commit WHERE doc_id = ?').get(docId) as { next_document: string; previous_created_at: number } | undefined
    return row === undefined ? undefined : { document: JSON.parse(row.next_document) as KnowledgeDocument, previousCreatedAt: row.previous_created_at }
  }

  acknowledgeDocumentGeneration(docId: string): void {
    this.db.prepare('DELETE FROM document_generation_commit WHERE doc_id = ?').run(docId)
  }

  discardDocumentGenerations(docId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM document_generation_commit WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM document_generation_stage WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM document_generation_chunk WHERE doc_id = ?').run(docId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  discardStagedDocumentGeneration(docId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM document_generation_stage WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM document_generation_chunk WHERE doc_id = ?').run(docId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  async deleteChunks(docId: string, baseId?: string): Promise<void> {
    const where = baseId !== undefined ? 'doc_id = ? AND base_id = ?' : 'doc_id = ?'
    const keyParams: Array<string> = baseId !== undefined ? [docId, baseId] : [docId]
    // Batch the deletes so a huge document never blocks the host event loop in
    // one statement (every row fires the FTS tombstone trigger); yield to the
    // message pump after ~50ms of cumulative work (Cherry's
    // DELETE_YIELD_BUDGET_MS in deleteMaterials). `ORDER BY rowid` keeps each
    // batch deterministically anchored so the loop always makes progress.
    const stmt = this.db.prepare(
      `DELETE FROM chunk WHERE rowid IN (SELECT rowid FROM chunk WHERE ${where} ORDER BY rowid LIMIT ?)`,
    )
    let started = Date.now()
    for (;;) {
      const changed = stmt.run(...keyParams, DELETE_BATCH_SIZE).changes
      if (changed === 0) break
      if (Date.now() - started >= DELETE_YIELD_BUDGET_MS) {
        await new Promise<void>(resolve => setImmediate(resolve))
        started = Date.now()
      }
    }
    this.dropVectorCacheByDoc(docId)
  }

  async deleteChunksByBase(baseId: string): Promise<void> {
    const stmt = this.db.prepare(
      'DELETE FROM chunk WHERE rowid IN (SELECT rowid FROM chunk WHERE base_id = ? ORDER BY rowid LIMIT ?)',
    )
    let started = Date.now()
    for (;;) {
      const changed = stmt.run(baseId, DELETE_BATCH_SIZE).changes
      if (changed === 0) break
      if (Date.now() - started >= DELETE_YIELD_BUDGET_MS) {
        await new Promise<void>(resolve => setImmediate(resolve))
        started = Date.now()
      }
    }
    this.vectorCache.delete(baseId)
  }

  /**
   * Return space a large delete freed back to the OS (Cherry's
   * `KnowledgeIndexStore.reclaimSpace` + driver thresholds). Best-effort:
   * - Checkpoint first — cheap, and folds the delete's committed frees into
   *   the main file so `freelist_count` reflects them.
   * - VACUUM only when the freelist is a large share of the file AND a
   *   meaningful byte count; below either bound it just truncates the WAL.
   * - The external-content FTS only TOMBSTONES its trigram rows on delete (via
   *   the chunk delete trigger); the dead segment blobs linger in the shadow
   *   table, which VACUUM cannot reclaim on its own. 'optimize' merges and
   *   drops them, gated behind the same threshold so a small delete never pays
   *   the whole-index segment merge.
   * - VACUUM rewrites into the WAL, so checkpoint again to release it.
   */
  reclaimSpace(): { vacuumed: boolean; reclaimedBytes: number } {
    // Best-effort by contract, and it runs AFTER the delete has already been
    // committed: a failing checkpoint, FTS optimize, or VACUUM (SQLITE_BUSY is
    // the realistic case — the constructor explicitly supports a second
    // connection on this file) must never surface as "the delete failed".
    try {
      return this.reclaimSpaceUnchecked()
    } catch (error) {
      console.warn(`dsh-knowledge: space reclamation failed after a delete: ${error instanceof Error ? error.message : String(error)}`)
      return { vacuumed: false, reclaimedBytes: 0 }
    }
  }

  private reclaimSpaceUnchecked(): { vacuumed: boolean; reclaimedBytes: number } {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const pageSize = this.readPragmaInt('page_size')
    const pageCount = this.readPragmaInt('page_count')
    const freelist = this.readPragmaInt('freelist_count')
    const ratio = pageCount > 0 ? freelist / pageCount : 0
    if (ratio < VACUUM_MIN_FREELIST_RATIO || freelist * pageSize < VACUUM_MIN_FREED_BYTES) {
      return { vacuumed: false, reclaimedBytes: 0 }
    }
    this.db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')`)
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const pageCountAfter = this.readPragmaInt('page_count')
    return { vacuumed: true, reclaimedBytes: Math.max(0, pageCount - pageCountAfter) * pageSize }
  }

  private readPragmaInt(pragma: string): number {
    const row = this.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
    if (row === undefined) return 0
    const value = Object.values(row)[0]
    return typeof value === 'number' ? value : Number(value ?? 0)
  }

  /**
   * Library-wide vector reuse (Cherry's `listExistingEmbeddingHashes`, decision
   * A4): for each embedding-text hash already stored under `embeddingModel`,
   * return its vector. The caller embeds only the hashes missing from this
   * map, so a re-embed of unchanged chunk text reuses the stored vector instead
   * of re-spending the embedding API. Matching is (hash, embedding_model) —
   * two bases in one store may use different models, so a hash alone is not a
   * valid reuse key (vectors from another model are not comparable). Rows
   * without a vector (a failed/lexical-only import) never match.
   *
   * Batch size stays well under SQLite's bound-parameter limit (Cherry uses
   * 500 for the same reason).
   */
  listEmbeddingVectorsByHashes(hashes: readonly string[], embeddingModel: string): Map<string, number[]> {
    const vectors = new Map<string, number[]>()
    for (let i = 0; i < hashes.length; i += EMBEDDING_HASH_QUERY_BATCH) {
      const batch = hashes.slice(i, i + EMBEDDING_HASH_QUERY_BATCH)
      if (batch.length === 0) continue
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT embedding_text_hash, embedding FROM chunk
         WHERE embedding_text_hash IN (${placeholders}) AND embedding_model = ? AND embedding IS NOT NULL`,
      ).all(...batch, embeddingModel) as Array<{ embedding_text_hash: string; embedding: Buffer }>
      for (const row of rows) {
        const vector = decodeEmbedding(row.embedding)
        if (vector !== undefined) vectors.set(row.embedding_text_hash, vector)
      }
      const candidates = this.db.prepare(`SELECT embedding_text_hash, embedding FROM document_generation_chunk
        WHERE embedding_text_hash IN (${placeholders}) AND embedding_model = ? AND embedding IS NOT NULL`)
        .all(...batch, embeddingModel) as Array<{ embedding_text_hash: string; embedding: Buffer }>
      for (const row of candidates) {
        const vector = decodeEmbedding(row.embedding)
        if (vector !== undefined && !vectors.has(row.embedding_text_hash)) vectors.set(row.embedding_text_hash, vector)
      }
    }
    return vectors
  }

  /** Per-doc chunk presence + embedding coverage in one grouped pass (listDocuments). */
  docChunkStatus(baseId: string): { withChunks: Set<string>; missingEmbedding: Set<string> } {
    const rows = this.db.prepare(
      'SELECT doc_id, SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) AS missing FROM chunk WHERE base_id = ? GROUP BY doc_id',
    ).all(baseId) as Array<{ doc_id: string; missing: number }>
    const withChunks = new Set<string>()
    const missingEmbedding = new Set<string>()
    for (const row of rows) {
      withChunks.add(row.doc_id)
      if (row.missing > 0) missingEmbedding.add(row.doc_id)
    }
    return { withChunks, missingEmbedding }
  }

  /** Every document id that still has chunk rows, for orphan reconciliation:
   *  a delete that landed mid-embedding can leave batches behind whose document
   *  row is already gone, and those rows would keep matching the retrieval
   *  lanes (they scope by base, not by document existence) forever. */
  docIdsWithChunks(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT doc_id FROM chunk').all() as Array<{ doc_id: string }>
    return new Set(rows.map(row => row.doc_id))
  }

  /** Aggregate chunk stats for `stats()`: counts, embedding presence/dimensions, model tags. */
  chunkStats(baseIds: readonly string[]): {
    count: number
    embedded: boolean
    dimensions?: number
    embeddingModelCounts: Array<{ baseId: string; model: string; count: number }>
  } {
    const scope = [...baseIds]
    const placeholders = scope.map(() => '?').join(',')
    const count = scope.length > 0
      ? (this.db.prepare(`SELECT COUNT(*) AS c FROM chunk WHERE base_id IN (${placeholders})`).get(...scope) as { c: number }).c
      : 0
    if (count === 0) return { count, embedded: false, embeddingModelCounts: [] }
    const embedded = scope.length > 0 && (this.db.prepare(`SELECT 1 AS one FROM chunk WHERE base_id IN (${placeholders}) AND embedding IS NOT NULL LIMIT 1`).get(...scope)) !== undefined
    let dimensions: number | undefined
    if (embedded && scope.length > 0) {
      const row = this.db.prepare(`SELECT embedding FROM chunk WHERE base_id IN (${placeholders}) AND embedding IS NOT NULL LIMIT 1`).get(...scope) as { embedding: Buffer } | undefined
      dimensions = row !== undefined ? decodeEmbedding(row.embedding)?.length : undefined
    }
    const modelRows = this.db.prepare(
      `SELECT base_id, embedding_model, COUNT(*) AS c FROM chunk WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL AND base_id IN (${placeholders}) GROUP BY base_id, embedding_model`,
    ).all(...scope) as Array<{ base_id: string; embedding_model: string; c: number }>
    return {
      count,
      embedded,
      ...(dimensions !== undefined ? { dimensions } : {}),
      embeddingModelCounts: modelRows.map(row => ({ baseId: row.base_id, model: row.embedding_model, count: row.c })),
    }
  }

  // ── retrieval lanes ────────────────────────────────────────────────────────

  async lexical(query: string, baseIds: readonly string[], limit: number, filter?: RetrievalDocumentFilter, deadlineAt?: number): Promise<LaneResult> {
    try {
      return await this.lexicalUnchecked(query, baseIds, limit, filter, deadlineAt)
    } catch (error) {
      // node:sqlite wraps exceptions raised by a user-defined function. Restore
      // the public timeout identity once the absolute clock confirms that the
      // row guard was responsible.
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new DOMException('knowledge search deadline exceeded', 'TimeoutError')
      }
      throw error
    }
  }

  private async lexicalUnchecked(query: string, baseIds: readonly string[], limit: number, filter?: RetrievalDocumentFilter, deadlineAt?: number): Promise<LaneResult> {
    throwIfDeadlineExpired(deadlineAt)
    const scope = [...baseIds]
    if (scope.length === 0) return { total: 0, hits: [] }
    if (filter?.docIds !== undefined && filter.docIds.length === 0) return { total: 0, hits: [] }
    // An empty query must never scan the whole corpus (LIKE '%%' matches
    // everything) — the service layer guards too, but the lane stands alone.
    if (query.trim().length === 0) return { total: 0, hits: [] }
    const docFilter = docFilterSql(filter, 'c.doc_id')
    const placeholders = scope.map(() => '?').join(',')
    const deadlineSql = deadlineAt !== undefined ? ' AND knowledge_before_deadline(?, c.chunk_id)' : ''
    const scopeSql = `c.base_id IN (${placeholders})${docFilter?.sql ?? ''}${deadlineSql}`
    const params: Array<string | number> = [...scope, ...(docFilter?.params ?? []), ...(deadlineAt !== undefined ? [deadlineAt] : [])]
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM chunk c WHERE ${scopeSql}`).get(...params) as { c: number }).c
    if (total === 0) return { total: 0, hits: [] }

    const shortTerms = extractShortTerms(query)
    const likeFilters = shortTerms.map(() => `(c.search_text LIKE ? ESCAPE '\\')`).join(' AND ')
    if (needsLikeFallback(query)) {
      // Cherry's bm25LikeSearch: nothing trigram-indexable (e.g. a bare
      // two-character CJK term) — a pure LIKE scan with one AND-ed filter per
      // token (a single whole-query pattern would demand a verbatim contiguous
      // substring), ordered by text length (dense chunks first) with a
      // length-based score as the relevance proxy.
      const tokens = extractFtsTokens(query)
      if (tokens.length === 0) return { total, hits: [] }
      const filters = tokens
        .map(() => `(c.search_text LIKE ? ESCAPE '\\' OR c.context LIKE ? ESCAPE '\\')`)
        .join(' AND ')
      const sql = `
        SELECT ${ChunkDatabase.SELECT_COLUMNS}, search_text FROM chunk c
        WHERE ${scopeSql} AND ${filters}
        ORDER BY length(c.search_text) ASC, c.chunk_id ASC
        LIMIT ?
      `
      for (const token of tokens) {
        const pattern = toLikePattern(token)
        params.push(pattern, pattern)
      }
      params.push(limit)
      const rows = this.db.prepare(sql).all(...params) as unknown as Array<ChunkRow & { search_text: string }>
      return {
        total,
        hits: rows.map(row => ({
          ...rowToChunk(row),
          score: 1024 / (1024 + Math.max(1, row.search_text.length)),
        })),
      }
    }
    const matchTerms = extractMatchTerms(query)
    const matchQuery = matchTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const baseSql = `
      SELECT ${ChunkDatabase.SELECT_COLUMNS}, bm25(chunk_fts) AS fts_score
      FROM chunk_fts JOIN chunk c ON c.fts_rowid = chunk_fts.rowid
      WHERE ${scopeSql} AND chunk_fts MATCH ?
    `
    const matchSql = likeFilters !== ''
      ? `${baseSql} AND ${likeFilters} ORDER BY fts_score ASC LIMIT ?`
      : `${baseSql} ORDER BY fts_score ASC LIMIT ?`
    const relaxedSql = `${baseSql} ORDER BY fts_score ASC LIMIT ?`
    params.push(matchQuery)
    const filteredParams = [...params]
    for (const term of shortTerms) filteredParams.push(toLikePattern(term))
    filteredParams.push(limit)
    let rows = this.db.prepare(matchSql).all(...filteredParams) as unknown as Array<ChunkRow & { fts_score: number }>
    if (rows.length === 0 && shortTerms.length > 0) {
      // Cherry's relaxation: a filler short term ('to', 「的」) can eliminate
      // every candidate; retry without the filters rather than returning
      // nothing — the ranked MATCH terms alone decide the result.
      params.push(limit)
      rows = this.db.prepare(relaxedSql).all(...params) as unknown as Array<ChunkRow & { fts_score: number }>
    }
    const hits: LaneHit[] = rows.map(row => ({ ...rowToChunk(row), score: normalizeBm25(-row.fts_score) }))
    return { total, hits }
  }

  async vector(embedding: readonly number[], baseIds: readonly string[], limit: number, filter?: RetrievalDocumentFilter, deadlineAt?: number): Promise<LaneResult> {
    throwIfDeadlineExpired(deadlineAt)
    const scope = [...baseIds]
    if (scope.length === 0) return { total: 0, hits: [] }
    if (filter?.docIds !== undefined && filter.docIds.length === 0) return { total: 0, hits: [] }
    const query = embedding.length > 0 ? Float32Array.from(embedding) : null
    const allowed = filter?.docIds !== undefined ? new Set(filter.docIds) : undefined
    const excluded = new Set(filter?.excludeDocIds)
    const scored: LaneHit[] = []
    let total = 0
    let scanned = 0
    for (const baseId of scope) {
      for (const entry of this.ensureVectorCache(baseId)) {
        if ((scanned++ & 255) === 0) throwIfDeadlineExpired(deadlineAt)
        if ((allowed !== undefined && !allowed.has(entry.docId)) || excluded.has(entry.docId)) continue
        total += 1
        if (query === null || entry.vector.length !== query.length) continue
        scored.push({ ...rowToChunk(entry.row), score: cosineFloat32(query, entry.vector) })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return { total, hits: scored.slice(0, limit) }
  }

  /** Lazy-load a base's vectors into the cache (SQL once, then in-memory).
   *  `PRAGMA data_version` changes when ANOTHER connection commits to this
   *  file, so a second DSH process (or a second store instance) that deletes or
   *  re-embeds chunks cannot leave this lane serving vectors for rows that are
   *  gone — the "resurrect a deleted document" failure. Own writes do not bump
   *  it, which is why the local write paths still update the cache in place. */
  private ensureVectorCache(baseId: string): Array<{ id: string; docId: string; vector: Float32Array; row: ChunkRow }> {
    const dataVersion = this.readPragmaInt('data_version')
    const cached = this.vectorCache.get(baseId)
    if (cached !== undefined && this.vectorCacheDataVersion.get(baseId) === dataVersion) return cached
    const rows = this.db.prepare(
      `SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE base_id = ? AND embedding IS NOT NULL`,
    ).all(baseId) as unknown as ChunkRow[]
    const entries = rows
      .map(row => {
        const vector = decodeEmbeddingFloat32(row.embedding)
        return vector !== undefined ? { id: row.chunk_id, docId: row.doc_id, vector, row } : undefined
      })
      .filter((entry): entry is { id: string; docId: string; vector: Float32Array; row: ChunkRow } => entry !== undefined)
    this.vectorCache.set(baseId, entries)
    this.vectorCacheDataVersion.set(baseId, dataVersion)
    return entries
  }

  /** Rebuild one base's cache entry for a chunk after a write. */
  private upsertVectorCache(chunk: KnowledgeChunk): void {
    const list = this.vectorCache.get(chunk.baseId)
    if (list === undefined) return
    const index = list.findIndex(entry => entry.id === chunk.id)
    if (chunk.embedding === undefined) {
      if (index >= 0) list.splice(index, 1)
      return
    }
    const entry = { id: chunk.id, docId: chunk.docId, vector: Float32Array.from(chunk.embedding), row: toChunkRow(chunk) }
    if (index >= 0) list[index] = entry
    else list.push(entry)
  }

  /** Drop a document's cached vectors (delete path). */
  private dropVectorCacheByDoc(docId: string): void {
    for (const list of this.vectorCache.values()) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].docId === docId) list.splice(i, 1)
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

interface ChunkRow {
  chunk_id: string
  doc_id: string
  base_id: string
  idx: number
  text: string
  heading: string | null
  context: string | null
  embedding: Buffer | null
  embedding_model: string | null
  source_spans: string | null
  processing_revision: string | null
}

function rowToChunk(row: ChunkRow): KnowledgeChunk {
  const sourceSpans = decodeSourceSpans(row.source_spans, row.text.length, row.processing_revision)
  const chunk: KnowledgeChunk = {
    id: row.chunk_id,
    docId: row.doc_id,
    baseId: row.base_id,
    index: row.idx,
    text: row.text,
    ...(row.heading !== null ? { heading: row.heading } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
    ...(sourceSpans !== undefined ? { sourceSpans } : {}),
    ...(row.processing_revision != null ? { processingRevision: row.processing_revision } : {}),
  }
  const embedding = decodeEmbedding(row.embedding)
  return {
    ...chunk,
    ...(embedding !== undefined ? { embedding } : {}),
    ...(row.embedding_model !== null ? { embeddingModel: row.embedding_model } : {}),
  }
}

function decodeSourceSpans(json: string | null, length: number, revision: string | null): KnowledgeChunk['sourceSpans'] {
  if (json == null) return undefined
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value) || !value.every(span => validSourceSpan(span) && span.chunkEnd <= length
    && (revision == null || span.revision === revision))) throw new Error('invalid persisted source spans')
  return value
}

/** The search/embedding text of a chunk: context (title/heading path) + body. */
export function searchTextOf(chunk: KnowledgeChunk): string {
  return chunk.context !== undefined && chunk.context.length > 0 ? `${chunk.context}\n${chunk.text}` : chunk.text
}

/** Map an unbounded BM25 score into [0, 1). */
function normalizeBm25(raw: number): number {
  return raw / (raw + 1)
}

/**
 * One-time migration: move chunks out of the legacy JSON unit file into the
 * SQLite store. No-op when the file is absent.
 *
 * Resumable on purpose: the previous guard skipped the whole migration as soon
 * as the store held *any* row (`db.size > 0`), so a crash — or one bad record —
 * after the first document left the remaining documents stranded in the legacy
 * file forever, with a success-shaped return. Each document is now migrated
 * only when the store holds none of its chunks yet.
 *
 * @returns the number of documents migrated by this call.
 */
export async function migrateLegacyChunkFile(jsonPath: string, db: ChunkDatabase, log: (message: string) => void): Promise<number> {
  let raw: string
  try {
    raw = await readFile(jsonPath, 'utf8')
  } catch {
    return 0
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    log(`dsh-knowledge: legacy chunk file is not valid JSON, skipping migration: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
  const chunks = (document as { tables?: Record<string, unknown> }).tables?.chunks
  if (typeof chunks !== 'object' || chunks === null || Array.isArray(chunks)) return 0
  const byDoc = new Map<string, KnowledgeChunk[]>()
  for (const [key, value] of Object.entries(chunks as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      byDoc.set(key, [...(byDoc.get(key) ?? []), ...(value as KnowledgeChunk[])])
    } else if (typeof value === 'object' && value !== null) {
      const chunk = value as KnowledgeChunk
      const list = byDoc.get(chunk.docId) ?? []
      list.push(chunk)
      byDoc.set(chunk.docId, list)
    }
  }
  const alreadyStored = db.docIdsWithChunks()
  let migrated = 0
  for (const [docId, list] of byDoc) {
    // Per-document guard: a previous run that stopped midway must resume the
    // documents it never reached, and must never re-add one it already did.
    if (alreadyStored.has(docId)) continue
    const byId = new Map<string, KnowledgeChunk>()
    for (const chunk of list) byId.set(chunk.id, chunk)
    db.putChunks([...byId.values()].sort((a, b) => a.index - b.index))
    migrated += 1
  }
  if (migrated > 0) log(`dsh-knowledge: migrated ${migrated} documents' chunks to the SQLite store`)
  return migrated
}
