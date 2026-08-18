# Changelog

## 0.3.0 — Cherry-parity import pipeline + worker-thread local models

The import path is rebuilt around Cherry Studio's architecture (verified
against its source), and local-model inference moves off the main process.

- **Uncapped directory imports**: the folder picker no longer truncates to
  the 20-item interactive-file limit (Cherry imports a directory as one
  source with no cap); the 20 limit now applies to file/note picks only,
  with a "too many files" hint. The import failure dialog is gone — failed
  imports keep their row, marked red with the reason (Cherry's failed items),
  reindexable from the raw copy.
- **Cherry-style parallel import**: `addFileDocument` creates the row and
  returns immediately; parse+ingest runs on a per-base worker pool
  (concurrency 5, Cherry's `defaultConcurrency`), rows flip
  parsing → embedding x% → completed/failed via the existing status poll.
  Dedup check + first persist run under a per-base write lock so concurrent
  identical imports cannot both pass.
- **Local embedding in a dedicated worker thread** (Cherry's "in its own
  worker" `InferenceServiceBase`): transformers.js and its ~600MB model run
  off the main process — a large import batch can no longer freeze the host
  (previously the in-process model plus 5 concurrent parses exceeded the
  main heap and froze the whole web instance). Serialized inference in the
  worker, request/response ids with timeout, 60s idle release of the loaded
  model, crash → fail in-flight + respawn, `unref()` so the worker never
  blocks shutdown; proxy + HF mirror honoured inside the worker.
- **Download failures are visible**: a background model download/load
  failure lands in the status map (`error` + reason) instead of being
  swallowed, so the Local Models panel shows why a download did not start.
- **Cherry-detail pass**: drag & drop upload onto the document list (the
  hint existed, the handlers did not); directory imports filter unsupported
  formats and hidden entries up front (Cherry's directory scan) with a
  "skipped N" toast; server-side extension whitelist rejects binaries
  before a row is created; embedding vector-width guard (Cherry's
  `assertEmbeddingVectors`) prevents a switched model from corrupting cosine
  search; reindex skips in-flight rows (Cherry's `REINDEX_ALLOWED_STATUSES`)
  with visible counts; `.mdx` joins the supported formats.
- Retrieval behavior and eval baselines are unchanged.

## 0.2.12 — Remove real eval sets (privacy)

The four real evaluation sets (`eval-questions.json`, `eval-rephrase.json`,
`eval-extra.json`, `eval-base22.json`) were built from private study
materials, so they are removed from the repo and its history. The runner
(`scripts/eval-retrieval.mjs`) and the example template
(`scripts/eval-questions.example.json`) remain, so anyone can build their own
sets. Run `node scripts/eval-retrieval.mjs --file your-set.json --base <id>`.

## 0.2.11 — Security hardening (SSRF, path traversal, zip bombs)

Audit-driven hardening of the import paths:

- **SSRF guard on URL import**: `fetchHtml` now refuses non-http(s) protocols
  and loopback / link-local / RFC1918 private hosts (`127.0.0.0/8`,
  `10.x`, `172.16–31.x`, `192.168.x`, `169.254.x`, `0.x`, `localhost`,
  `[::1]`, `metadata.google.internal`, …) before any request is sent. The
  `knowledge_import_url` tool and the URL refresh path share the guard.
- **Redirect re-validation**: fetch no longer follows redirects implicitly —
  `httpFetch` accepts a `redirect: 'manual'` policy and `fetchHtml` walks up
  to 5 hops itself, validating every hop's protocol and host. A public page
  can no longer 302 to an internal address to bypass the check.
- **Path-traversal depth**: `RawFileStorage.deleteBase` now validates its
  `baseId` through the same boundary as every other raw path (a tampered
  domain record could previously have driven `rm -rf` outside the raw root).
- **Zip-bomb guard**: office archives (docx/pptx/xlsx/epub) whose declared
  uncompressed size exceeds 256 MB are rejected before any entry is inflated.
- **Route segment decoding**: `/knowledge/*` path segments are
  `decodeURIComponent`-decoded so encoded ids resolve like the JSON API.
- Retrieval behavior is unchanged; eval baselines are identical.

## 0.2.10 — Extended retrieval eval sets

Two new real eval sets join the original 24 questions:

- **`scripts/eval-extra.json`** (16 questions, base 11): covers documents the
  original set did not touch (偏最小二乘回归 / 随机模拟与系统仿真 /
  微分方程建模), plus harder variants of covered topics (Little 定律, 生灭过程,
  CR 一致性检验, 0-1 背包, Kruskal, 允许缺货, Leslie 矩阵, EDD 规则, …).
  Baseline: hybrid Hit@5 0.938 vs lexical 0.778 — the vector lane bridges
  another +0.16 over the extra questions. Two stub documents with 0 chunks
  (计算机仿真 / 数学建模算法, empty imports) are noted in the set and not
  tested; the Leslie question is a known semantic gap (the term never appears
  in the 差分方程 document).
- **`scripts/eval-base22.json`** (6 questions, base 22): retrieval of the
  writing-guide documents (math-model-writing) and data corpora (oil.csv /
  holidays_events.csv / ensemble_log.txt). The three writing questions hit
  1.0 in every mode; the three data questions fail in every mode — a real
  property of tabular/CSV retrieval (numeric cells carry no semantic text),
  kept as a documented known gap.

No runtime behavior changed.

## 0.2.9 — Space reclamation after large deletes (Cherry's reclaimSpace)

Deleting documents no longer leaves the freed pages stranded in the chunk
store file. `ChunkDatabase.reclaimSpace` mirrors Cherry's `reclaimSpace` +
driver thresholds:

- **WAL checkpoint first** (cheap; folds the delete's committed frees into
  the main file so `freelist_count` reflects them).
- **Threshold-gated VACUUM**: only when the freelist is ≥20% of the file AND
  ≥8 MB — a small delete never pays for a whole-file rewrite whose pages a
  later index would reuse anyway.
- **FTS 'optimize' before the VACUUM**: the external-content trigram index
  only TOMBSTONES its rows on delete; the dead segment blobs linger in the
  shadow table, which VACUUM cannot reclaim on its own.
- **Reclaim after delete**: `deleteBase`, `deleteDocument`, and
  `deleteDocuments` call it synchronously; the thresholds keep the common
  case a no-op. Memory-backed stores skip it.
- Retrieval behavior is unchanged; eval baselines are identical.

## 0.2.8 — Multi-model local embedding registry

The Settings → Local Models page now offers five download-ready in-process
models instead of one, and each model gets the pooling strategy its family
requires — Cherry Studio's `pooling.ts` posture, previously hardcoded to
Qwen3's last-token pooling.

- **Registry**: `onnx-community/Qwen3-Embedding-0.6B-ONNX` (1024-dim, zh,
  last-token), `Xenova/bge-small-zh-v1.5` (512-dim, zh, CLS),
  `Xenova/bge-small-en-v1.5` (384-dim, en, CLS), `Xenova/gte-small` (384-dim,
  multilingual, mean), `Xenova/multilingual-e5-small` (384-dim, multilingual,
  mean). Every entry is a real, downloadable transformers.js ONNX repo.
- **Per-family pooling** (`poolingFor`): Qwen3 → last-token, BGE/BCE → CLS,
  GTE/E5/unknown → mean — a BGE model previously produced wrong vectors under
  the hardcoded last-token pooling.
- **Suggestions synced**: the settings combobox's local list mirrors the
  registry exactly, so every suggestion is actually downloadable.
- The default model and its pooling are unchanged, so existing embeddings and
  eval baselines are identical.

## 0.2.7 — Metadata-filtered search

Search can now be narrowed to a document subset by metadata — a capability
neither Cherry Studio's search nor the reference implementation offers
(Cherry's `metadata` is output-only; its search is scoped by base alone).

- **`filter` on search requests**: `docIds`, `titleIncludes` (case-insensitive
  substring), `sourceTypes` (file / text / url / directory), and
  `updatedAfter` / `updatedBefore` (epoch ms) — all optional, ANDed.
- **Resolved once into a doc-id allow-list** shared by both retrieval paths:
  the SQL lanes push `doc_id IN (...)` into the FTS5 / vector queries (bounded
  to SQLite's parameter limit), and the in-memory fallback filters candidates.
  A filter that matches nothing returns zero hits.
- **Exposed** in the `knowledge_search` tool parameters (`docIds`,
  `titleIncludes`, `sourceTypes`, `updatedAfter`, `updatedBefore`), the HTTP
  `/search` route, and the browser panel types.
- Retrieval ranking is untouched; eval baselines are identical.

## 0.2.6 — Directory subtree operations (Cherry's outermost-root folding)

Batch operations now understand the directory tree. `deleteDocuments` and
`reindexDocuments` fold their selection to the outermost roots first —
Cherry's `getOutermostSelectedItemIds` semantics — so a directory plus one of
its descendants in the same batch is handled once, and each selected
directory operates on its whole subtree recursively.

- **Subtree delete**: `deleteDocuments` removes a selected directory and
  everything below it (chunks + raw files + rows), instead of leaving orphaned
  descendants behind.
- **Subtree reindex**: `reindexDocument` on a directory container recursively
  reindexes its descendants; `reindexDocuments` and `reindexBase` fold the
  selection so no document is reindexed twice (a directory's children are
  covered by the directory itself).
- **New tool `knowledge_reindex_document`**: re-index one document or a whole
  directory subtree (Cherry's `refreshConcepts` counterpart) — re-reads the
  raw source, re-chunks, and re-embeds only what changed.
- Retrieval behavior is unchanged; eval baselines are identical.

## 0.2.5 — URL snapshots with refresh

URL documents now keep a persisted snapshot of the fetched text (Cherry's
snapshot model): the base owns a stable copy, reindex re-reads it, and
refresh re-fetches the page and updates the snapshot + index in place.

- **Snapshot on import**: `addUrlDocument` persists the fetched text as
  `<baseId>/<docId>.md` in the raw store (`rawFilePath`), so a URL document is
  rebuildable from its snapshot and crash recovery covers the fetch/parse
  window like any file import.
- **Refresh**: `refreshUrlDocument` re-fetches the page; when the text (or
  title) changed it overwrites the snapshot and re-indexes — hash reuse
  re-embeds only the chunks that changed. An unchanged page or a failed fetch
  leaves the current snapshot and index untouched; refresh never degrades.
- **Surface**: `POST /knowledge/documents/:id/refresh`, the
  `knowledge_refresh_url` tool (returns `changed: false` for no-op), and a
  "刷新快照" action on URL document rows in the panel.
- **Bug fix**: the in-memory store's `putChunks` now mirrors the SQLite
  replace semantics (drop the document's old rows first) — a reindex in a
  memory-backed profile no longer leaves stale chunks searchable.
- Retrieval behavior is unchanged; eval baselines are identical.

## 0.2.4 — Raw source storage (Cherry's "import means copy")

Uploaded file documents now keep their original bytes — Cherry's `raw/`
material store, adapted to the plugin layout: `<chunkStoreDir>/knowledge-raw/
<baseId>/<docId><ext>`, with the base-relative path recorded on the document
(`rawFilePath`).

- **Import means copy**: the base owns a stable copy of every uploaded file;
  deleting the document removes it, `deleteBase` sweeps the whole base's
  directory, and restore copies the bytes across so a restored base stays
  rebuildable from source.
- **Reindex from source**: `reindexDocument` re-reads and re-parses the raw
  bytes first (a parser upgrade now actually improves extraction on reindex),
  falling back to the stored text and then to reconstructed chunks when the
  file is gone — a reindex never wipes vectors for an unrebuildable source.
  This is Cherry's `canKnowledgeItemRebuildSource` posture, made simpler by
  the plugin's atomic overwrite writes (no delete-then-rebuild window).
- **Crash recovery from the file**: a placeholder that only holds a raw file
  (crash before/during parse) is now resumed from source instead of dropped —
  the same recoverability Cherry gets from its `raw/` copy.
- **Download route**: `GET /knowledge/documents/:id/raw` streams the original
  bytes (attachment, original mime type).
- Retrieval behavior is unchanged; eval baselines are identical.

## 0.2.3 — Sibling-chunk context on search hits

Each search hit now carries its surrounding chunks (`siblingContext`,
±`siblingChunks` in the same document, in reading order, heading-prefixed) —
the full paragraph a RAG answer needs, instead of a bare chunk that often
cuts a sentence mid-way. Cherry Studio returns only the single chunk body,
so this is an enhancement over the reference implementation.

- **New setting `siblingChunks`** (0–3, default 1, 0 = off) in Settings and
  per-base config: how many neighbouring chunks (±) to attach to each hit.
- **One bounded SQL query** per hit (`listChunksByIndexRange`) — no full
  document scan, works on the SQLite-backed store and the in-memory fallback.
- **Exposed everywhere the hit is**: `SearchResult.hits[].siblingContext` in
  the HTTP API, the `knowledge_search` tool schema, its text render (context
  before the hit, `>>>` marker), and the browser panel types.
- Retrieval ranking is untouched; eval baselines are identical.

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
