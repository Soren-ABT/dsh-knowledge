# Changelog

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
