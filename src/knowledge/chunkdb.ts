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
import { cosineSimilarity } from './retrieval.js'
import type { KnowledgeChunk } from './types.js'

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

// ── FTS query compilation (trigram tokenizer) ────────────────────────────────

/** Tokens a trigram index can MATCH: whole words (≥3 chars) and CJK trigram windows. */
function extractMatchTerms(query: string): string[] {
  const trigrams: string[] = []
  const words: string[] = []
  for (const token of query.match(/[\p{L}\p{N}_]+/gu) ?? []) {
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
  return [...new Set([...words.filter(word => [...word].length >= 3), ...trigrams])]
}

/** Terms of 1–2 characters: no trigram, applied as LIKE filters (Cherry's approach). */
function extractShortTerms(query: string): string[] {
  const words: string[] = []
  for (const token of query.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if ([...token].length < 3) words.push(token)
  }
  return [...new Set(words)]
}

const UNSEGMENTED_SCRIPT = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u

/** `%`-wrapped LIKE pattern matching `token` as a literal substring. */
function toLikePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, ch => `\\${ch}`)}%`
}

/** True when the query has tokens but none is trigram-indexable → pure LIKE scan. */
function needsLikeFallback(query: string): boolean {
  const terms = extractMatchTerms(query)
  return terms.length === 0 && (query.match(/[\p{L}\p{N}_]+/gu) ?? []).length > 0
}

// ── embedding BLOB codec (little-endian float32) ─────────────────────────────

function encodeEmbedding(values: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer)
}

function decodeEmbedding(blob: Buffer | null | undefined): number[] | undefined {
  if (blob === undefined || blob === null || blob.byteLength === 0) return undefined
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4))
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

export interface RetrievalLane {
  /** FTS5 BM25 hits over the scope (score normalized into [0, 1)). */
  lexical(query: string, baseIds: readonly string[], limit: number): Promise<LaneResult>
  /** Brute-force cosine hits over the scope's stored vectors. */
  vector(embedding: readonly number[], baseIds: readonly string[], limit: number): Promise<LaneResult>
}

/** The chunk store: bounded SQL reads, single-transaction writes. */
export class ChunkDatabase implements RetrievalLane {
  private readonly db: DatabaseSync

  private static readonly SELECT_COLUMNS = 'chunk_id, doc_id, base_id, idx, text, heading, context, embedding, embedding_model'

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = OFF')
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
        embedding_text_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS chunk_doc_idx ON chunk(doc_id);
      CREATE INDEX IF NOT EXISTS chunk_base_idx ON chunk(base_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        search_text, content='chunk', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
        INSERT INTO chunk_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE OF search_text ON chunk BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
        INSERT INTO chunk_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
      END;
    `)
    this.migrateEmbeddingHashColumn()
    this.migrateFromBundleLayout()
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
    const deleteOld = this.db.prepare('DELETE FROM chunk WHERE doc_id = ?')
    const insert = this.db.prepare(
      'INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text, heading, context, embedding, embedding_model, embedding_text_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      deleteOld.run(docId)
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
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
      `INSERT INTO chunk (chunk_id, doc_id, base_id, idx, text, search_text, heading, context, embedding, embedding_model, embedding_text_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         doc_id = excluded.doc_id, base_id = excluded.base_id, idx = excluded.idx,
         text = excluded.text, search_text = excluded.search_text, heading = excluded.heading,
         context = excluded.context, embedding = excluded.embedding,
         embedding_model = excluded.embedding_model, embedding_text_hash = excluded.embedding_text_hash`,
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
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteChunks(docId: string): void {
    this.db.prepare('DELETE FROM chunk WHERE doc_id = ?').run(docId)
  }

  deleteChunksByBase(baseId: string): void {
    this.db.prepare('DELETE FROM chunk WHERE base_id = ?').run(baseId)
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
      'SELECT base_id, embedding_model, COUNT(*) AS c FROM chunk WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL GROUP BY base_id, embedding_model',
    ).all() as Array<{ base_id: string; embedding_model: string; c: number }>
    return {
      count,
      embedded,
      ...(dimensions !== undefined ? { dimensions } : {}),
      embeddingModelCounts: modelRows.map(row => ({ baseId: row.base_id, model: row.embedding_model, count: row.c })),
    }
  }

  // ── retrieval lanes ────────────────────────────────────────────────────────

  async lexical(query: string, baseIds: readonly string[], limit: number): Promise<LaneResult> {
    const scope = [...baseIds]
    if (scope.length === 0) return { total: 0, hits: [] }
    const placeholders = scope.map(() => '?').join(',')
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM chunk WHERE base_id IN (${placeholders})`).get(...scope) as { c: number }).c
    if (total === 0) return { total: 0, hits: [] }

    const shortTerms = extractShortTerms(query)
    const likeFilters = shortTerms.map(() => `(c.search_text LIKE ? ESCAPE '\\')`).join(' AND ')
    const params: Array<string | number> = [...scope]
    if (needsLikeFallback(query)) {
      // Nothing trigram-indexable (e.g. a bare two-character CJK term): a pure
      // LIKE scan — bm25() has no MATCH context here, so no FTS join at all.
      const pattern = toLikePattern(query.trim())
      const sql = `
        SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk c
        WHERE c.base_id IN (${placeholders}) AND (c.search_text LIKE ? ESCAPE '\\' OR c.context LIKE ? ESCAPE '\\')
        ORDER BY c.rowid
        LIMIT ?
      `
      params.push(pattern, pattern, limit)
      const rows = this.db.prepare(sql).all(...params) as unknown as ChunkRow[]
      return { total, hits: rows.map(row => ({ ...rowToChunk(row), score: 1 })) }
    }
    const matchTerms = extractMatchTerms(query)
    const sql = `
      SELECT ${ChunkDatabase.SELECT_COLUMNS}, bm25(chunk_fts) AS fts_score
      FROM chunk_fts JOIN chunk c ON c.rowid = chunk_fts.rowid
      WHERE c.base_id IN (${placeholders}) AND chunk_fts MATCH ?
      ${likeFilters !== '' ? `AND ${likeFilters}` : ''}
      ORDER BY fts_score ASC
      LIMIT ?
    `
    params.push(matchTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR '))
    for (const term of shortTerms) params.push(toLikePattern(term))
    params.push(limit)
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<ChunkRow & { fts_score: number }>
    const hits: LaneHit[] = rows.map(row => ({ ...rowToChunk(row), score: normalizeBm25(-row.fts_score) }))
    return { total, hits }
  }

  async vector(embedding: readonly number[], baseIds: readonly string[], limit: number): Promise<LaneResult> {
    const scope = [...baseIds]
    if (scope.length === 0) return { total: 0, hits: [] }
    const placeholders = scope.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT ${ChunkDatabase.SELECT_COLUMNS} FROM chunk WHERE base_id IN (${placeholders}) AND embedding IS NOT NULL`,
    ).all(...scope) as unknown as ChunkRow[]
    const scored: LaneHit[] = []
    for (const row of rows) {
      const vector = decodeEmbedding(row.embedding)
      if (vector === undefined) continue
      scored.push({ ...rowToChunk(row), score: cosineSimilarity(embedding, vector) })
    }
    scored.sort((a, b) => b.score - a.score)
    return { total: scored.length, hits: scored.slice(0, limit) }
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
}

function rowToChunk(row: ChunkRow): KnowledgeChunk {
  const chunk: KnowledgeChunk = {
    id: row.chunk_id,
    docId: row.doc_id,
    baseId: row.base_id,
    index: row.idx,
    text: row.text,
    ...(row.heading !== null ? { heading: row.heading } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  }
  const embedding = decodeEmbedding(row.embedding)
  return {
    ...chunk,
    ...(embedding !== undefined ? { embedding } : {}),
    ...(row.embedding_model !== null ? { embeddingModel: row.embedding_model } : {}),
  }
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
 * SQLite store. No-op when the store already has data or the file is absent.
 * @returns the number of documents migrated.
 */
export async function migrateLegacyChunkFile(jsonPath: string, db: ChunkDatabase, log: (message: string) => void): Promise<number> {
  if (db.size > 0) return 0
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
  for (const [docId, list] of byDoc) {
    const byId = new Map<string, KnowledgeChunk>()
    for (const chunk of list) byId.set(chunk.id, chunk)
    db.putChunks([...byId.values()].sort((a, b) => a.index - b.index))
  }
  if (byDoc.size > 0) log(`dsh-knowledge: migrated ${byDoc.size} documents' chunks to the SQLite store`)
  return byDoc.size
}
