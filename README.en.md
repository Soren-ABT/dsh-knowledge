<div align="center">

# dsh-knowledge

**A knowledge base plugin for DSH**

[**English**](./README.en.md) · [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![Node.js >= 22](https://img.shields.io/badge/node.js-%3E%3D22-brightgreen?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-%23003B57?logo=sqlite)](https://www.sqlite.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

A **knowledge base system** as a standalone, open-source bundle plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): bases (with **groups**) and documents, text chunking, embeddings (OpenAI-compatible / Ollama / **local model** / lexical fallback), retrieval, model-facing tools, and a browser management panel.

</div>

---

## Why dsh-knowledge

dsh-knowledge brings document ingestion, parsing, chunking, retrieval, evidence composition, and anchored follow-up reading into DSH. It works without vector configuration and can also run with fully local models, without a separate knowledge-base service.

| Capability | What it provides |
|---|---|
| Document sources | Files, directories, web pages, and text notes, with durable local-path rescans and reindexing |
| Hybrid retrieval | FTS5 BM25, vector recall, RRF fusion, MMR diversity, and optional reranking |
| Evidence context | Ordered `ContextWindow` composition and continuation around a specific search hit |
| Local operation | Local embeddings, reranking, and OCR, plus OpenAI-compatible APIs and Ollama |
| Document processing | Common office formats, scanned PDFs, PaddleOCR, Tesseract fallback, and optional MinerU |
| Management UI | Base groups, batch import, previews, recall testing, model management, and index rebuilds |

---

## Quick start

### 1. Prepare the environment

- Node.js: `^22.19.0 || >=24.0.0`
- pnpm: `>=10`
- An installed and initialized DeepSeek Harness profile

Before installing the plugin, add the following build permissions to the target profile's `pnpm-workspace.yaml`. These dependencies contain postinstall scripts; when pnpm 10 blocks them, `dsh plugin add` exits before it can register the bundle.

```yaml
allowBuilds:
  onnxruntime-node: true
  sharp: true
  protobufjs: true
  tesseract.js: true
```

### 2. Install the plugin

```bash
dsh plugin --profile <name> add dsh-knowledge
```

The plugin is installed at the profile level, so the same command works whether DSH came from npm or a source checkout. Restart the web service after installation and refresh the page to load the management panel.

### 3. Complete the first setup

1. Open Knowledge from the bottom of the sidebar, beside Settings.
2. Create a base and import files, a directory, a web page, or text.
3. For local vector retrieval, download an embedding model from Settings > Local Models. You can instead configure an OpenAI-compatible endpoint or Ollama.
4. Download the approximately 21 MB OCR model if you need scanned-document recognition.
5. Check results in Recall Test, then let the model use the base through `knowledge_search`.

Lexical retrieval works without downloading a model. Scanned-document OCR, local embeddings, and local reranking activate only after their respective models are downloaded and pass readiness checks.

<details>
<summary>Other installation methods</summary>

```bash
# Tarball from GitHub Releases or npm pack
dsh plugin --profile <name> add ./dsh-knowledge-0.3.9.tgz

# Local source directory; build it first
dsh plugin --profile <name> add file:/path/to/dsh-knowledge
```

If the first installation fails because pnpm blocked build scripts, add the `allowBuilds` entries and run the add command again. The package is normally already present in `node_modules`, and the second run completes bundle registration.

</details>

---

## Core capabilities

### Documents and source tracking

- Create, rename, group, and delete bases; collapse groups in the sidebar and move bases between them.
- Import documents from uploads, absolute file paths, directories, URLs, or plain text. Directory sources retain a stable ID, kind, and original path for later rescans.
- Upload up to 20 files per selection, with a 22 MB per-file limit and a five-way background import pool.
- Resolve same-name conflicts through server-authoritative rename, replace, or cancel choices; content hashes prevent duplicate imports.
- Track queued, parsing, embedding, ready, and failed states, with inline PDF, source-text, and complete chunk previews.
- Store recoverable raw sources. Identical relative paths under different directory roots do not collide, and a failed replacement rebuild keeps the previously committed source.

<details>
<summary>Supported formats and directory behavior</summary>

Directory imports recursively scan `txt`, `md`, `csv`, `html`, `json`, `pdf`, `docx`, `doc`, `pptx`, `ppt`, `xlsx`, `xls`, `epub`, and other supported formats while retaining a drillable folder tree in the panel.

A directory rescan imports new files, rebuilds changed files, and removes files that disappeared from disk. One failed item does not obscure successful imports; the service and UI retain per-file errors.

</details>

### Retrieval and evidence flow

- Without embeddings, retrieval uses CJK bigrams and Latin-token BM25. With vectors available, bases can use auto, hybrid, vector, or lexical mode.
- Hybrid retrieval combines BM25 and vector rankings through Reciprocal Rank Fusion, with optional similarity thresholds, MMR diversity, and multi-query fusion.
- Remote and local cross-encoder rerankers are optional. A timeout, process failure, or invalid score response preserves the original recall order.
- Every hit receives a dynamically composed `ContextWindow` ordered as `before → anchor → after`; bridge text is never duplicated into the index or embeddings.
- Proactive retrieval is enabled by default and injects strongly relevant evidence before the answer while bounding latency, duplicate context, and each base's share.
- Recall Test shows sources, relevance, lexical/vector scores, latency, and rerank state, and supports citation copying and query-history replay.

<details>
<summary>ContextWindow and proactive-retrieval details</summary>

`SearchHit.text` remains the complete canonical anchor. `contextWindow` stays within the same heading path by default, crops oversized anchors around the query at sentence boundaries, and removes repeated suffix/prefix text between adjacent chunks. The legacy `siblingContext` field remains compatible throughout 0.3.x, but new consumers should prefer `contextWindow`.

`knowledge_get_document` supports normal `chunkOffset` / `chunkLimit` pagination and an anchored mode selected with `anchorChunkId` or `anchorIndex`. Anchored reads accept `before`, `after`, `maxTokens`, `focus`, and `crossHeading` controls.

The first-token proactive path never launches a local reranker. A remote reranker may run at most once within the shared four-second deadline. Cancellation, timeouts, and provider failures do not mutate retrieval memory or widen the search into unrelated bases.

</details>

### Chunking, parsing, and OCR

- Heading-aware chunking preserves Markdown heading paths and fenced code, and includes the document title and heading path as retrieval context.
- `chunkSize` and `chunkOverlap` are token budgets. Long text looks for boundaries in headings, code, paragraphs, sentence punctuation, lists, and line breaks.
- Optional semantic chunking merges similar adjacent paragraphs; an optional token ceiling further divides oversized chunks near sentence, comma, or whitespace boundaries.
- Scanned PDFs, vector-only PDFs without a text layer, corrupt text layers, and per-glyph layouts can switch automatically to full-page OCR.
- PaddleOCR PP-OCRv5 is the primary local recognizer, with Tesseract fallback. The pipeline also handles 1-bit JBIG2/CCITT-style scans.
- Optional remote MinerU processing can recover formulas, tables, and complex layouts as Markdown. Without it, documents continue through the local parser and OCR path.

### Models and management UI

- Each base can override embedding, reranking, chunking, topK, proactive retrieval, conflict handling, and document-processing settings; empty fields inherit global values.
- Embeddings can come from an OpenAI-compatible `/embeddings` endpoint, Ollama, or a local transformers.js model.
- The Local Models page manages embedding, rerank, and OCR downloads, retries, deletion, progress, readiness, and health state.
- The cache directory supports native folder selection, opening, and safe migration so large local weights can live outside the system drive.
- Ollama management supports listing, pulling, cancelling, and deleting models. Browsing or pulling never changes the active embedding configuration implicitly.
- The management panel provides base navigation, document tables, batch rebuild/delete actions, source and chunk previews, recall testing, global/per-base settings, and toast feedback.

<details>
<summary>How local models run</summary>

The default local embedding model is `onnx-community/Qwen3-Embedding-0.6B-ONNX`, approximately 585 MB with 1024 output dimensions. It runs in a dedicated worker thread. Idle cleanup can release ONNX sessions while keeping the worker alive, which avoids re-registering Linux native bindings in a replacement worker.

`rerankModel: local:Xenova/bge-reranker-base` runs in a separate child process isolated from the embedding worker. Search never downloads a reranker implicitly; the model must be downloaded and pass its health check first. Custom Hugging Face ONNX rerankers are experimental and must pass single-logit capability validation plus a positive/negative self-test.

Models are cached under `<DSH_HOME>/cache/dsh-knowledge/local-models` by default. Set `hfEndpoint` in the panel or use the `HF_ENDPOINT` environment variable to choose a mirror. OCR defaults to `hf-mirror.com`; users outside China can use `https://huggingface.co`.

</details>

### Model-facing tools

The plugin exposes 14 tools. Reads, writes, and proactive retrieval all obey the enabled-base boundary; an empty or stale selection matches zero bases instead of silently expanding to the entire library. Permanent deletion requires host approval.

<details>
<summary>View all tools</summary>

- `knowledge_search`
- `knowledge_list_bases`
- `knowledge_create_base`
- `knowledge_delete_base`
- `knowledge_add_document`
- `knowledge_list_documents`
- `knowledge_delete_document`
- `knowledge_import_url`
- `knowledge_refresh_url`
- `knowledge_stats`
- `knowledge_get_document`
- `knowledge_read_document`
- `knowledge_reindex_document`
- `knowledge_reindex_base`

`knowledge_search` returns citations, `chunkIndex`, and an ordered `ContextWindow`. `knowledge_read_document` supports character-range reads and regex location, while `knowledge_get_document` supports pagination and continuation around a retrieval anchor.

</details>

### Storage and indexes

- Bases, documents, and runtime configuration are persisted through DSH `storageDomain`.
- Chunks live in a dedicated SQLite file at `<DSH_HOME>/storages/knowledge-chunks.sqlite`, configurable through `chunkStorePath`.
- Lexical retrieval uses a SQLite FTS5 trigram index; vectors use a resident Float32Array cache with precise invalidation.
- Legacy JSON chunk data is migrated idempotently on first start. The service falls back to memory storage when no persistent backend is available.
- After changing chunk or embedding settings, rebuild one document or the entire base from the panel or model tools.

---

## v0.3.9 highlights

- Import a single file or full directory tree by absolute path while retaining durable top-level source tracking.
- Repoint only the selected top-level source, with parser identity updated when the extension changes.
- Prevent raw-cache collisions between separate directory roots and preserve the previous committed source when replacement reindexing fails.
- Fall back to `http://127.0.0.1:11434` for an empty Ollama embedding URL without allowing model browsing or pulls to alter active settings.
- Improve shared theme tokens, viewport-aware popovers, dismissal behavior, toast interaction, and Chinese/English localization.

The upgrade requires no database migration, automatic reindex, or model redownload and does not change the v0.3.8 evidence-window contracts. ThinkForge-core's authorship from community PRs #10–#13 remains preserved in Git history.

[Read the v0.3.9 GitHub Release](https://github.com/Soren-ABT/dsh-knowledge/releases/tag/v0.3.9) · [Read the changelog](./CHANGELOG.md)

---

## How it works

1. **Ingest**: accept a file, directory, URL, or text note and retain source metadata plus recoverable original content.
2. **Parse**: extract text by format; route scans and abnormal PDFs through local OCR when needed, or use MinerU when configured.
3. **Chunk**: produce stable, indexed chunks from headings, document structure, and token budgets.
4. **Embed**: build retrieval data through a remote API, Ollama, a local model, or lexical-only mode.
5. **Recall**: run BM25 and vector lanes as configured, with RRF fusion in hybrid mode.
6. **Compose evidence**: optionally rerank and apply MMR, then build an ordered, token-bounded context window.
7. **Continue reading**: use `chunkIndex` or an anchor ID to read nearby context or the source document.

---

## Technical design: from a query to continuable evidence

dsh-knowledge is designed to produce an explainable, degradable evidence chain, not merely a list of Top K strings. The main explicit-search path is:

```text
current query
  └─ Query Planner: primary query + optional variants
       ├─ SQLite FTS5 / BM25 lexical recall
       └─ embedding / cosine vector recall
            └─ weighted RRF fusion
                 └─ optional MMR deduplication
                      └─ optional remote/local cross-encoder rerank
                           └─ Context Composer
                                ├─ ordered, budgeted model-visible evidence
                                └─ anchorChunkId / chunkIndex continuation
```

### Recall, fusion, and ranking

| Stage | Implementation | Design purpose |
|---|---|---|
| Query Planner | The primary query always comes from the current message; multi-query variants are recalled independently and fused afterwards | Preserve current-turn intent while covering paraphrased questions |
| Lexical recall | SQLite FTS5 trigram index with BM25 ranking; query processing recognizes CJK bigrams and Latin words | Remain searchable without embeddings, downloaded weights, or a remote service |
| Vector recall | Embed the query, run cosine retrieval, and validate vector dimensions | Recover semantic matches with little keyword overlap |
| RRF fusion | `score(d) = Σᵢ wᵢ / (60 + rankᵢ(d))`; `rrfVectorWeight` controls the vector lane | Fuse ranks without pretending raw BM25 and cosine scores share a scale |
| MMR | Trade relevance against similarity to already selected candidates | Reduce semantic repetition within Top K |
| Rerank | Apply a remote API or local cross-encoder to a bounded pool; a multi-query request reranks only once at the end | Keep cost and latency tied to the candidate pool rather than query-variant count |
| Threshold | Apply only to comparable vector or rerank relevance scores | Avoid filtering BM25/RRF ranks with an unrelated numeric scale |

Ties retain the original recall order. A reranker must return exactly one finite score in `[0, 1]` for every retained candidate. Missing, out-of-range, mismatched, or protocol-invalid results are degradation events, never successful reranks.

### Context Composer: connect context at query time

Chunking produces stable index units; Context Composer decides what the model actually sees. It does not permanently copy neighboring text into every chunk or embed bridge text twice. After a hit, it batch-loads adjacent ranges and composes them around the anchor:

- Evidence order is always `before → anchor → after`, within the same heading path by default.
- The anchor has priority. When it exceeds the budget, the composer crops around the query and prefers sentence boundaries.
- An exact suffix/prefix overlap of at least 24 characters is removed between adjacent excerpts, preventing overlap from being read twice.
- `SearchHit.text` remains the complete canonical anchor; `ContextWindow` records only the window selected for this query.
- Every result carries a stable `anchorChunkId` and `chunkIndex`. The model can continue around the same location instead of guessing a new document position.

| Consumer | Fixed budget |
|---|---|
| Rerank pair | Up to 128 tokens for the query, 352 for evidence, and 480 total |
| Explicit `knowledge_search` | Target 768 tokens per hit; 8192 tokens maximum model-visible output per call |
| Proactive-retrieval background | Up to 180 tokens per hit and 640 tokens total |
| Anchored continuation | 1600 tokens by default, configurable from 128 to 4096 |

<details>
<summary>Why proactive retrieval does not inject Top K on every turn</summary>

Proactive retrieval uses current-turn-first planning. The current message is bounded to 200 characters. Only when it is at most 40 characters and contains a deictic expression such as “that,” “above,” “continue,” or “step N,” or lacks enough topic terms, may the planner use up to the two latest user messages to form a second history-enhanced query. Both queries run lexical recall independently and are fused through RRF; history never replaces the current question.

The entire pre-first-token path shares a four-second wall-clock deadline. Service-level reranking is explicitly skipped and the number of local-reranker calls is always zero. A configured remote reranker may run once with no retry. Cancellation exits immediately; a timeout or provider failure retains lexical order and stops injection without receiving a fresh timeout budget.

Previously delivered chunks are removed before relevance gates and per-base seat allocation. A same-topic turn can add at most one fresh item within five minutes; a new topic can add at most three. Each base's `autoRetrieveWeight` limits its seats. Numeric IDs and compound model/version/error identifiers use a strict channel: the final text visible to the model must contain the complete identifier with correct boundaries or nothing is injected.

Injected material is explicitly labelled as untrusted reference evidence and cannot override the current user's instructions, permissions, or tool rules. Deduplication and throttling state is committed only after the background is actually folded into the model context.

</details>

---

## Engineering reliability

| Risk | Handling | Caller-visible outcome |
|---|---|---|
| Empty or stale base/document filters | Only `undefined` means unrestricted; an empty set matches zero documents in both SQLite lanes | A filtering mistake cannot silently search the whole library |
| Remote-rerank timeout or malformed output | Shared deadline, strict result-index and score validation, structured `rerank` status | Return the original recall order and do not apply a rerank threshold |
| Local rerank hangs or crashes | Isolated child process, hard-timeout termination, clean restart, and separation from the embedding worker | Degrade the current search without restarting the embedding lifecycle |
| Incomplete or incompatible local weights | Require configuration, tokenizer files, and non-empty ONNX weights; write a runtime-versioned, file-fingerprinted readiness marker only after self-test | Search never downloads implicitly or treats “an ONNX file exists” as readiness |
| Repeated local-rerank failures | Total queue cap of 16; open a five-minute circuit after three consecutive timeout/crash/runtime/invalid-response failures, with one half-open probe | Prevent a broken model from repeatedly consuming process and latency budgets |
| Partial replacement rebuild or directory rescan | Replace the committed source only after the new raw source, parse, and index succeed; retain per-file results | One failed item does not destroy the old version or hide successful siblings |
| Missing release files or platform drift | Node 22.19/24 quality gates, Windows/Linux/macOS native tests, Windows/Linux tarball install-and-boot smoke, and optional real local-rerank smoke | Both source builds and the published npm shape are continuously checked |

These constraints share one principle: fail closed on scope, fail soft on ranking enhancement, and preserve the committed version of user data. Degradation is exposed through structured state or UI feedback instead of being presented as success.

---

## Architecture

One bundle mounts three plugin rows. Local embeddings and OCR run in separate worker threads, while local reranking runs in a replaceable child process. Local inference failures remain outside the DSH host's main execution space.

| Component | Platform | Responsibility |
|---|---|---|
| `knowledge` (`ctx.knowledge`) | host | Storage, chunking, embedding/parser orchestration, retrieval, OCR scheduling, and `/knowledge/*` HTTP APIs |
| `tool-knowledge` | host | Registration and execution of the 14 model-facing tools |
| `ui-knowledge` | client | Sidebar entry, workspace management panel, and same-origin API calls |
| `embed-worker` | worker thread | Local transformers.js embedding inference; large model sessions stay outside the host process |
| `ocr-worker` | worker thread | mupdf page rendering plus PaddleOCR, OpenCV, and Tesseract recognition |
| `rerank-process.mjs` | child process | Local cross-encoder reranking, hard-timeout isolation, and process-level recovery |

The `knowledge` storage domain contains `bases`, `documents`, and global configuration. Chunks and optional embeddings live in the plugin-owned SQLite store. Original file bytes live in the adjacent `knowledge-raw` directory.

---

## Position in the DSH knowledge and RAG ecosystem

dsh-knowledge is an integrated document knowledge base; it does not claim that every workload is better served by it than by a focused plugin. The comparison below explains design boundaries. It was reviewed on **2026-09-04** from each project's public README on its default branch. “Not documented in the README” does not prove that a capability is impossible, and the table may become stale as those projects evolve.

<details>
<summary>Compare adjacent DSH knowledge and RAG projects</summary>

| Project | Public positioning and primary design | Boundary relative to dsh-knowledge |
|---|---|---|
| [dsh-knowledge-base](https://github.com/htcqp802/dsh-knowledge-base) | General document library with multi-format import, a folder UI, FTS5 trigram, and BM25 | dsh-knowledge additionally covers vector/RRF/MMR/rerank, proactive evidence, ContextWindow, local OCR, and model management; the other project is lighter |
| [Mindspace Local RAG](https://github.com/Spirtxiaoqi7/mindspace-dsh-local-rag) | A technically substantial local hybrid RAG with BM25+, vectors, RRF, parent/child chunks, source follow-up, document revisions, and compaction summaries | Mindspace deliberately keeps retrieval model-directed and currently avoids reranking; its revision/rollback and summary governance are more specialized. dsh-knowledge emphasizes the complete management UI, complex-format OCR, local cross-encoder, and optional proactive retrieval |
| [dsh-plugin-rag](https://github.com/mervyn-teo/dsh-plugin-rag) | Listens to DSH session events and incrementally maintains cross-session semantic memory in a local JSON vector index | Its primary object is the live session surface rather than user documents. dsh-knowledge owns source ingestion, parsing, rebuilds, citations, and anchored document reading; the two serve different memory layers |
| [dsh-ragflow](https://github.com/staff-os/dsh-ragflow) | Connects a DSH tool to existing RAGFlow datasets through a clean provider/seam/tool/config split | RAGFlow owns ingestion and parsing, and the plugin documents itself as retrieval-only. dsh-knowledge completes ingestion through evidence delivery without requiring another knowledge-base service |
| [dsh-plugin-kb4rag](https://github.com/yyang8891/dsh-plugin-kb4rag) | Paper-oriented Python offline extraction/build, Ollama embeddings, and Node Float32Array Top K | Its runtime retrieval is deliberately simple and dependency-light. dsh-knowledge adds runtime ingestion/rebuild, hybrid recall, OCR, a management UI, and multi-level evidence continuation |
| [dsh-rag-kb](https://github.com/AlowEnsoul/dsh-rag-kb) | Ollama vector retrieval, multiple bases, JSON persistence, and a draggable floating UI | dsh-knowledge uses SQLite/FTS5 and a multi-stage ranking pipeline, then adds source transactions, local-model health, complex-PDF OCR, and release validation |

</details>

Among the projects reviewed above, no single public README documents the same complete combination of:

- lifecycle management for files, directories, URLs, and text, with recoverable raw sources and safe rebuilds;
- local complex-document parsing, scanned-PDF OCR, remote MinerU, and per-base processing policy;
- BM25, vectors, weighted RRF, MMR, multi-query, and local/remote reranking in one retrieval chain;
- query-time ContextWindow composition, strict token budgets, proactive evidence, and anchored continuation;
- isolated embedding/OCR/rerank execution units, model readiness and self-tests, structured degradation, and cross-platform tarball verification.

The primary differentiator is therefore not another vector-search implementation. It is the engineering between a source entering the system and the model receiving citable, continuable evidence, delivered as one DSH-native bundle with defined failure behavior.

---

## Compatibility

- **DSH**: developed and verified against [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) commit `b150a55` (2026.8.21). Include your DSH commit when reporting compatibility problems with a newer version.
- **Node.js**: `^22.19.0 || >=24.0.0`.
- **Platforms**: Windows, Linux x64/arm64, and macOS on Apple Silicon support the complete feature set.
- **Intel Mac**: onnxruntime does not provide a darwin-x64 binary, so local embeddings and OCR are unavailable. Use an OpenAI-compatible remote provider or Ollama instead.
- **Legacy Office formats**: `.doc`, `.ppt`, and `.xls` parsing depends on the platform-native binaries from `@firecrawl/anydoc`.
- **First-use network access**: local embedding and OCR models must be downloaded once. Lexical retrieval and remote providers do not require local weights.

---

## Configuration

Deployment defaults live in the `knowledge` row of `cordis.patch.yml`. The management panel can persist runtime overrides, and most retrieval and document settings can also be overridden per base.

<details>
<summary>View every configuration field</summary>

| Field | Default | Notes |
|---|---:|---|
| `embeddingProvider` | `none` | `openai`, `ollama`, `local`, or `none` |
| `embeddingBaseUrl` | `''` | Embedding API root; an empty Ollama URL falls back to its standard local endpoint |
| `embeddingModel` | `''` | Remote model name or local Hugging Face repository ID |
| `embeddingApiKey` | `''` | Can also be supplied through `KNOWLEDGE_API_KEY` |
| `rerankModel` / `rerankBaseUrl` / `rerankApiKey` | `''` | Remote or `local:` reranking; an empty model disables it |
| `localRerankTimeoutMs` | `60000` | Total local rerank budget, including queue time; range 10,000–300,000 ms |
| `smartChunk` | `true` | Heading/paragraph-aware chunking; off uses only the separator |
| `chunkSeparator` | `\n\n` | Separator used when `smartChunk` is off |
| `chunkSize` | `800` | Target token budget per chunk |
| `chunkOverlap` | `100` | Overlap token budget between adjacent chunks |
| `topK` | `4` | Default result count; accepted range 1–50 |
| `searchMode` | `auto` | `auto`, `hybrid`, `vector`, or `lexical` |
| `similarityThreshold` | `0` | Minimum result score, from 0 to 1 |
| `mmrDiversity` | `0` | MMR diversity; `0` disables it |
| `rrfVectorWeight` | `1` | Vector-lane weight in hybrid RRF fusion |
| `embeddingBatchSize` | `32` | Texts sent in each embedding batch |
| `siblingChunks` | `1` | Adjacent chunks per side, range 0–3; `0` still produces an anchor-only window |
| `semanticChunk` | `false` | Merge semantically similar adjacent paragraphs |
| `semanticChunkThreshold` | `0.75` | Cosine threshold for semantic chunking |
| `chunkTokenLimit` | `0` | Hard per-chunk token ceiling; `0` disables it |
| `conflictStrategy` | `rename` | Same-name import behavior: `keep`, `replace`, or `rename` |
| `urlRefreshHours` | `0` | URL refresh interval; `0` disables it |
| `imageCaptionProvider` | `off` | `off`, `openai`, or `ollama` |
| `imageCaptionModel` | `''` | Vision model ID used for figure descriptions |
| `imageCaptionBaseUrl` | `''` | Figure-captioning API root |
| `imageCaptionApiKey` | `''` | Key for an OpenAI-compatible vision endpoint |
| `hfEndpoint` | `''` | Hugging Face download endpoint or mirror |
| `documentProcessorProvider` | `builtin` | Local `builtin` parsing or remote `mineru` processing |
| `mineruApiKey` | `''` | Required for MinerU mode |
| `mineruApiHost` | `''` | Empty uses `https://mineru.net` |
| `resumeInterruptedOnStartup` | `true` | Resume interrupted imports at startup |
| `autoRetrieve` | `true` | Search user messages proactively and inject relevant background |
| `autoRetrieveWeight` | `3` | Per-base proactive seat cap, range 0–5; `0` excludes the base |
| `localModelCacheDir` | `''` | Empty uses `<DSH_HOME>/cache/dsh-knowledge/local-models` |
| `localWorkerIdleTimeoutMs` | `60000` | Idle time before releasing local embedding sessions; `0` keeps them hot |
| `chunkStorePath` | `''` | Empty uses `<DSH_HOME>/storages/knowledge-chunks.sqlite` |

Empty per-base fields inherit the global configuration. `localModelCacheDir`, `localWorkerIdleTimeoutMs`, and `chunkStorePath` are process-wide. API keys are stored as plain text on the local machine, so protect the profile data directory.

</details>

---

## Retrieval evaluation

Two dependency-free scripts can evaluate retrieval and RAG context against your own base:

```bash
# Hit@k, Recall@k, and MRR
node scripts/eval-retrieval.mjs --file scripts/eval-questions.example.json --base <baseId> --mode hybrid

# Hit@k, sentence-level Context Recall (RAGAS-style approximation, no LLM), and MRR
node scripts/eval-rag.mjs --file scripts/eval-rag.example.json --base <baseId> --topK 5
```

Copy an example JSON file and replace its questions, expected document-title fragments, and reference answers. The fixed synthetic fixtures in this repository are regression gates, not an accuracy guarantee for every private corpus, language, or model configuration.

---

## Development and verification

Source development expects the public DeepSeek Harness monorepo as a sibling checkout because `devDependencies` use `link:../dsh/...`:

```bash
pnpm install --config.auto-install-peers=false
pnpm run check
pnpm run build
```

- `pnpm test`: chunking, retrieval, configuration, storage, and service tests.
- `pnpm run typecheck`: run `tsc --noEmit`.
- `pnpm run build`: build host ESM entries, the browser client bundle, and declarations.
- `npm run release:check -- --expected-version <version>`: run the complete release gate.

---

## Known limitations

- Model selectors are editable suggestion comboboxes rather than live provider model lists; custom IDs can be entered manually.
- Embeddings run in batches inside the import flow. The first local-model download blocks that import, while the management panel displays progress.
- MinerU requires an API key for its official or self-hosted service. Without one, PDFs use the local parser and OCR path.
- The text entry is intended for lightweight notes and is not a rich-text editor.
- Intel Macs cannot run the onnxruntime-based local embedding and OCR paths.

---

## Security

Report vulnerabilities through GitHub's private reporting flow as described in [SECURITY.md](./SECURITY.md). Do not place exploit details, credentials, private documents, or unredacted logs in a public issue.

Use [GitHub Issues](https://github.com/Soren-ABT/dsh-knowledge/issues) for ordinary bugs and usage questions.

---

## License

[AGPL-3.0](LICENSE). PDF page rendering depends on [mupdf](https://mupdf.com/) under AGPL-3.0, so the project uses AGPL-3.0 to keep distribution licensing consistent. It also matches the license of the design reference [Cherry Studio](https://github.com/CherryHQ/cherry-studio), but this is an independent implementation containing none of Cherry Studio's source.

Thanks to [dsh-interconnect](https://github.com/deepseek-ai/deepseek-harness), [dsh-deeptutor](https://github.com/TecFancy/dsh-deeptutor), [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), and the community contributors who submit code and issue reports.
