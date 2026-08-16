# Changelog

## 0.2.2 — Crash-resumable imports (lightweight recoverable indexing)

A crash mid-embedding no longer loses the document. `ingestDocument` now
persists the document (with its source text, marked `incomplete`) BEFORE
embedding starts, and `buildChunks` lands every finished embedding batch into
the chunk store as it completes (`putChunkBatch`, an incremental upsert that
does not clear the document's other rows). On the next start, startup recovery
reports interrupted documents instead of dropping them, and the service
automatically resumes each one: hash reuse (0.2.1) re-embeds only the batches
that never landed, so a multi-hour PDF import interrupted at 60% resumes from
60% — no re-upload, no full re-embed.

- **Incremental batch persistence**: `ChunkDatabase.putChunkBatch` (upsert by
  chunk id, rowid-stable `ON CONFLICT DO UPDATE` so the FTS trigger chain stays
  consistent) — the crash-recovery write path used by both import and reindex.
- **Interrupted-document recovery**: `recoverInterruptedImports` now returns
  `{ removed, resume }` — `removed` stays the pure placeholders with no
  recoverable text (parse crashed before the source was persisted); `resume`
  lists documents holding rawText that were `incomplete` when the process
  died. The service re-indexes them in the background after startup.
- **Resumable reindex**: `reindexDocument` marks the document incomplete while
  it rebuilds, so a crash during reindex is recovered the same way.
- Retrieval behavior is unchanged; eval baselines are identical.

## 0.2.1 — Library-wide embedding reuse (Cherry's decision A4)

Re-embedding unchanged text no longer re-spends the embedding API. Each chunk
row now persists `embedding_text_hash` (sha256 of the exact search text the
embedding model sees), and `buildChunks` asks the store which of the new
chunk hashes already have a vector under the current embedding model before
calling the API — only the missing hashes are embedded.

- **Library-wide reuse**: a reindex, a chunk-size change, or a fresh import of
  text already indexed elsewhere (same base, another base, or the same
  document) reuses the stored vector whenever `(hash, embedding_model)` matches
  — the same dedup Cherry Studio gets from its `embedding` table keyed by
  `embedding_text_hash`. The model is part of the key because one chunk store
  can serve several bases with different models, so a hash alone is not a valid
  reuse key.
- **Automatic migration**: on first start after upgrade, the `embedding_text_hash`
  column is added and backfilled for every stored vector from its `search_text`
  (idempotent; ~3k vectors backfill in well under a second). The hash index is
  created after the column exists, so an older store opens cleanly.
- **No behavior change to retrieval**: reuse only affects which vectors are
  *computed*, not what is stored or searched; eval baselines are unchanged.

## 0.2.0 — SQLite chunk store + SQL retrieval (scale fix)

Chunk data moved out of the durable domain (`json` backend, which atomically
rewrote the whole unit file on every write — deletion and import slowed as
data grew) into a dedicated SQLite file (Node's built-in `node:sqlite`) where
every chunk put/delete is a single statement. This mirrors Cherry Studio's
design: business state (bases, documents, runtime config) stays in the domain,
the chunk index lives in its own engine.

- **Chunk storage**: one row per chunk in `<DSH_HOME>/storages/knowledge-chunks.sqlite` (configurable via `chunkStorePath`); embeddings stored as little-endian float32 BLOBs (Cherry's A1). Delete a document/base = one statement regardless of chunk count.
- **SQL retrieval lanes** (Cherry's FTS5 + brute-force vector posture): the lexical lane runs an external-content **FTS5 trigram** index (BM25 scoring in SQL, with CJK trigram windowing and a LIKE fallback for terms a trigram index cannot see); the vector lane scans the scope's stored BLOBs at query time. Hybrid search fuses both lanes with Reciprocal Rank Fusion. The in-memory JS rank path remains as the fallback for stores without SQL lanes.
- **Bounded reads**: nothing is loaded into memory at open; document lists, stats, and search run bounded SQL queries, so resident memory no longer scales with the corpus.
- **Automatic migration**: on first start after upgrade, chunks still stored in the legacy `knowledge.json` unit are moved into the SQLite store (duplicate rows from an interrupted earlier migration are dropped), and the previous per-document bundle layout is converted to per-chunk rows; the JSON unit then trims itself on the next write.
- **Parse/embedding status**: during import the file row appears immediately with live 解析中 / 嵌入中 NN% status, and folder rows show 导入中 while any descendant is processing.

## 0.1.0 (initial release)

A Cherry Studio-style knowledge base as a standalone, open-source bundle plugin for DeepSeek Harness (DSH).

### Features

- **Knowledge bases & groups**: create / rename / delete bases, grouped sidebar navigation with collapsible sections, move-to-group, and group create / rename / delete.
- **Documents**: add text, upload files (txt / md / csv / html / json / pdf / docx / pptx / xlsx / epub, multi-file drag-drop), import a URL, or import a whole directory; same-name conflict resolution (keep all / replace); content-hash dedup; per-document ready/not-embedded status and relative update time.
- **Chunking**: heading-aware smart chunking with configurable size / overlap / separator, with the document title + heading path injected as retrieval context.
- **Embeddings**: OpenAI-compatible endpoints, Ollama, an in-process local model (transformers.js, default `onnx-community/Qwen3-Embedding-0.6B-ONNX`), or lexical-only fallback (CJK bigram + latin BM25).
- **Retrieval**: BM25 + vector hybrid with Reciprocal Rank Fusion, MMR diversity, optional rerank (Jina / SiliconFlow / Cohere v2 style APIs), search modes (auto / hybrid / vector / lexical), and a score threshold; recall test with highlighted match snippets, per-hit vector/lexical scores, latency, and replayable history.
- **Local model manager**: a Settings → "Local Models" page with download / cancel / remove / retry and a live progress bar; configurable cache directory (`localModelCacheDir`).
- **Management panel**: a sidebar-foot entry opening a frame-wide Cherry Studio-style page (source list as a table with multi-select bulk reindex/delete, recall test, and per-base rag settings), plus model-id suggestion comboboxes.
- **Model tools**: `knowledge_search`, `knowledge_list_bases`, `knowledge_create_base`, `knowledge_delete_base`, `knowledge_add_document`, `knowledge_list_documents`, `knowledge_delete_document`, `knowledge_import_url`, `knowledge_stats`, `knowledge_get_document`, `knowledge_reindex_base`.

### Persistence

Business state (bases, documents, runtime config) is durable through DSH's
`storageDomain` seam (`json` backend), falling back to in-memory when no
storage backend is available. Chunks live in a dedicated SQLite file
(`<DSH_HOME>/storages/knowledge-chunks.sqlite`).
