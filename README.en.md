<div align="center">

# dsh-knowledge

**A knowledge base plugin for DSH**

[**English**](./README.en.md) · [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![Node.js >= 22](https://img.shields.io/badge/node.js-%3E%3D22-brightgreen?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-%23003B57?logo=sqlite)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A **knowledge base system** as a standalone, open-source bundle plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): bases (with **groups**) and documents, text chunking, embeddings (OpenAI-compatible / Ollama / **local model** / lexical fallback), retrieval, model-facing tools, and a browser management panel.

</div>

---

## Features

- **Bases, groups & documents**: create/delete/rename bases, documents and **groups** (grouped sidebar navigation with collapsible sections, move-to-group, create/rename/delete group); add text, upload files (txt / md / csv / html / json / pdf / docx / **doc / pptx / ppt / xlsx / xls** / epub, drag-and-drop, up to 20 per pick — imports run in a **5-way concurrent background pool**), import a URL or a whole **directory** (imported as a drillable folder tree); same-name **conflict resolution** (keep all / replace); content-hash dedup; **document preview** (inline PDF viewer + text/chunk preview with truncation for huge files); per-document **✓ ready badge, live import status**, and relative updated time. Imports run in the background — each file row appears the moment parsing starts, folders show importing while any descendant is processing, and errors surface as toasts.
- **Scanned-document OCR (local engine)**: scanned PDFs and images are recognized automatically by **PaddleOCR PP-OCRv5** (≈21MB models with an 18k-entry Chinese dictionary, one-click download in Settings → Local Models), falling back to Tesseract on failure; **1-bit rasters (JBIG2/CCITT fax-style scans) are handled correctly**; recognized text is chunked, embedded, and searchable like any other document.
- **Per-base configuration**: each base can pick its own embedding provider/model (including the **local model**), **rerank model**, chunk size, and Top K — unset fields inherit the global config; reindex one document or the whole base after a config change.
- **Optional MinerU remote processing**: PDFs can be handed to a [MinerU](https://github.com/opendatalab/MinerU) service (formulas, tables, layout reconstructed as Markdown) by entering a MinerU API Key in the base settings (global or per-base); without a key the local parse chain runs instead.
- **Embeddings & retrieval**: pluggable providers — any OpenAI-compatible `/embeddings` endpoint, a local Ollama server, or an **in-process local model (transformers.js, default `onnx-community/Qwen3-Embedding-0.6B-ONNX`)** — with **hybrid retrieval** (BM25 + vector + Reciprocal Rank Fusion), **rerank** (Jina / SiliconFlow / Cohere v2 style APIs), **MMR diversity**, search modes (auto/hybrid/vector/lexical), and a score threshold. A lexical BM25 fallback (CJK bigram + latin word) keeps it working with zero configuration; the recall test shows per-hit scores, latency, and keeps a **replayable search history**.
- **Smart chunking**: heading-aware chunking (preserves the Markdown heading path) with the document title + heading injected as retrieval context for better recall.
- **Index management**: reindex on demand (re-chunk + re-embed after changing chunk size or the provider), batched embedding, and statistics (docs / chunks / chars / tokens / embedded).
- **Model tools**: 12 tools — search, list/create/delete bases, add/list/delete documents, import URL, stats, get document, deep-read a document (paged text slices or regex grep), reindex.
- **Management panel**: NOT in Settings — a sidebar-foot "Knowledge" action (beside Settings) opens a frame-wide Cherry Studio-style page: left grouped navigator with base cards, right content column with stat chips, an "updated at" header, add-source popover, a **table-style source list (checkbox + name/type/status/updated-at columns with multi-select bulk reindex/delete)**, per-base settings panel (document processing / embedding / rerank / Top K / advanced), recall test, and toasts.
- **Local model manager (in Settings)**: a Settings → "Local Models" page (via the `settings.section` slot) with Cherry Studio-style **cards for the embedding model and the OCR model**: name/subtitle, a ready badge, download / retry / remove actions, and a live download progress bar. Downloaded models become selectable as the embedding provider, and scanned PDFs get OCR automatically.
- **Persistence**: business state (bases, documents, runtime config) is durable via DSH's `storageDomain` seam (the `json` backend shipped by the `web` profile); **chunks live in a dedicated SQLite file** (`<DSH_HOME>/storages/knowledge-chunks.sqlite`, configurable via `chunkStorePath`) so put/delete stay O(1) as data grows — one row per chunk, embeddings as float32 BLOBs. Lexical search runs an FTS5 trigram index and the vector lane scans stored vectors at query time; nothing loads into memory at open, so resident memory does not scale with the corpus. One-time migrations on first start after upgrade convert the legacy JSON unit and the previous bundle layout. Falls back to in-memory when no storage backend is available.

---

## Architecture

One bundle mounts three plugin rows plus **two dedicated worker threads** that carry all inference (Cherry's own-worker posture — a native/WASM crash can never take down the host):

| Plugin / thread                | Platform | Role                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `knowledge` (`ctx.knowledge`) | host     | Core engine: storage domain, chunking, embeddings, retrieval, OCR scheduling, `/knowledge/*` HTTP surface |
| `tool-knowledge`              | host     | 12 model tools consuming `ctx.knowledge`                     |
| `ui-knowledge`                | client   | Sidebar-foot entry (`sidebar.footer.action`) + frame-wide Cherry Studio-style panel (`shell.overlay`), calling the host over same-origin `fetch` |
| `embed-worker` (worker thread)| host     | transformers.js local embedding inference (the ~600MB model never enters the host process) |
| `ocr-worker` (worker thread)  | host     | PaddleOCR / Tesseract recognition (onnxruntime, OpenCV.js, tesseract workers all isolated in-thread) |

Data model: business state lives in the storage domain `knowledge` (version 0) — `bases` and `documents` tables plus a global slot for runtime config overrides; chunks (each may carry an `embedding` vector) live in the plugin-owned SQLite chunk store, one row per chunk.

---

## Install

The package declares `dsh.bundle.patch`, so `dsh plugin add` registers it automatically:

```bash
dsh plugin --profile <name> add dsh-knowledge          # from npm
dsh plugin --profile <name> add file:/path/to/dsh-knowledge
dsh plugin --profile <name> add ./dsh-knowledge-0.2.2.tgz
```

> **pnpm 10+ build allowlist (required)**: the plugin's dependencies `onnxruntime-node`, `sharp`, `protobufjs`, and `tesseract.js` ship postinstall scripts that pnpm refuses to run by default and exits non-zero — `dsh plugin add` then **stops before registering the bundle, so the plugin never activates**. Add this to the profile's `pnpm-workspace.yaml` **before** installing, then run the add:
>
> ```yaml
> allowBuilds:
>   onnxruntime-node: true
>   sharp: true
>   protobufjs: true
>   tesseract.js: true
> ```
>
> (Platform binaries are already bundled inside the npm packages, so skipping these scripts does not hurt functionality — but pnpm treats the refusal as an error, so approving them is the clean route. If you only add the config after a first failed add, just run the add again: the package is already in `node_modules` and the rerun registers it.)

Restart the web service for the host half and refresh the page for the client panel.

> The plugin installs at the **profile level** (`dsh plugin` runs pnpm inside the profile directory), so the same three commands work identically whether DSH was installed from npm or run from a fresh source checkout — no plugin source, checkout links, or DSH builds are involved.

### Zero-basis install (only DSH present)

Everything beyond the add command — local embedding, OCR, scanned-document recognition, hybrid retrieval, the management panel — ships with the plugin; **there are no personal configs or external services to reproduce**. Four prerequisites:

1. **Node.js ≥ 22 and pnpm ≥ 10 on PATH** (DSH itself already assumes these; `dsh plugin add` shells out to pnpm and will tell you if it is missing).
2. **Write the `allowBuilds` block before adding** (above — the only required pre-step; the profile's `pnpm-workspace.yaml` is generated on first init, just append those four lines).
3. **Model-download network reachability**:
   - **Local embedding model** (≈585MB, Qwen3-Embedding-0.6B): mirrors apply automatically in China; set `hfEndpoint` in the panel (base settings → Advanced, or Settings → Local Models) or the `HF_ENDPOINT` env var for a custom endpoint.
   - **OCR model** (≈21MB, PaddleOCR): downloads from hf-mirror.com by default; **users outside China** should set the same `hfEndpoint` field to `https://huggingface.co` — both OCR and embedding downloads then use it.
   - Skipping the downloads is fine (remote OpenAI-compatible / Ollama embeddings + text PDFs), only local vectorization and scan recognition are unavailable.
4. **Platforms**: Windows / macOS (Apple Silicon) / Linux x64+arm64 are fully supported; **Intel Mac (macOS x64) cannot run local embedding or local OCR** (no darwin-x64 onnxruntime binary) — use a remote embedding provider there.

First use after install: download the embedding model in Settings → "Local Models" (or point a base at a remote provider), download the OCR model if you need scan recognition — afterwards the feature set matches this repository's dev machine exactly.

---

## Compatibility

- **DSH version**: developed and verified against [deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness) commit `47f943859b` (public npm-plugin-ecosystem era, 2026-08). The plugin declares no peer dependencies — the DSH host injects cordis / zod / storage etc. as externals — so a newer DSH source checkout installs without resolution errors; if a newer DSH release breaks something, report an issue with the DSH commit you run.
- **Node.js**: `^22.19.0 || >=24.0.0` (the same floor DSH itself requires — the chunk store uses Node's built-in `node:sqlite`, which DSH's own session storage also uses).
- **Platforms**: Windows / macOS (Apple Silicon) / Linux x64+arm64 fully supported. Legacy `.doc` / `.ppt` / `.xls` parsing uses `@firecrawl/anydoc` (per-platform native binaries); `@napi-rs/canvas`'s Windows platform package is declared as an optionalDependency and is skipped on other platforms. **Intel Mac (darwin-x64)**: no onnxruntime binary exists for that platform — local embedding and local OCR are unavailable; use a remote embedding provider.
- **First-run network**: enabling `embeddingProvider: local` downloads model weights from Hugging Face on first use (cache under `localModelCacheDir`); the OCR model (≈21MB) downloads from Settings → Local Models. Both honor the panel's `hfEndpoint` field or the `HF_ENDPOINT` env var (OCR defaults to hf-mirror.com; users outside China can switch to huggingface.co).

---

## Configuration

Deployment defaults live in the `knowledge` row of `cordis.patch.yml`; the panel's Settings can override them at runtime (persisted in the storage domain):

| Field                                            | Default | Notes                                                        |
| ------------------------------------------------ | ------- | ------------------------------------------------------------ |
| `embeddingProvider`                              | `none`  | `openai` / `ollama` / `local` (in-process transformers.js) / `none` |
| `embeddingBaseUrl`                               | `''`    | e.g. `https://api.openai.com/v1` or `http://127.0.0.1:11434` (unused by `local`) |
| `embeddingModel`                                 | `''`    | e.g. `text-embedding-3-small`; for `local`, a Hugging Face repo id (default `onnx-community/Qwen3-Embedding-0.6B-ONNX`) |
| `embeddingApiKey`                                | `''`    | optional; `KNOWLEDGE_API_KEY` env var also works             |
| `rerankModel` / `rerankBaseUrl` / `rerankApiKey` | `''`    | rerank model (empty = disabled), Jina / SiliconFlow / Cohere v2 style APIs |
| `smartChunk`                                     | `true`  | heading/paragraph-aware chunking; off = separator only       |
| `chunkSeparator`                                 | `\n\n`  | block boundary when smart chunking is off (`\n` allowed)     |
| `chunkSize`                                      | `800`   | characters per chunk                                         |
| `chunkOverlap`                                   | `100`   | overlap between consecutive chunks                           |
| `topK`                                           | `6`     | results per search (1–50)                                    |
| `searchMode`                                     | `auto`  | `auto` / `hybrid` / `vector` / `lexical`                     |
| `similarityThreshold`                            | `0`     | drop results below this score (0–1)                          |
| `mmrDiversity`                                   | `0`     | MMR diversity (0–1, 0 = off)                                 |
| `embeddingBatchSize`                             | `32`    | texts per embedding request                                  |
| `hfEndpoint`                                     | `''`    | Hugging Face endpoint (download mirror for embedding and OCR models); empty = embeddings use the transformers default, OCR uses hf-mirror.com |
| `documentProcessorProvider`                      | `builtin` | PDF document processing: `builtin` (local parsing + optional OCR) / `mineru` (remote MinerU service) |
| `mineruApiKey`                                   | `''`    | MinerU API Key (needed in `mineru` mode; global or per-base)  |
| `mineruApiHost`                                  | `''`    | MinerU service host; empty = official `https://mineru.net`    |
| `localModelCacheDir`                             | `''`    | local-model cache root; empty = `<DSH_HOME>/cache/dsh-knowledge/local-models` (`~/.dsh` when `DSH_HOME` is unset) |
| `chunkStorePath`                                 | `''`    | chunk SQLite file; empty = `<DSH_HOME>/storages/knowledge-chunks.sqlite` |

Chunk data is stored in a dedicated SQLite file rather than the domain KV store: on the `web` profile's JSON backend every record write rewrites the whole unit file, which made deletion and import cost seconds-to-minutes as data grew. The SQLite store makes each put/delete a single statement, FTS5 trigram full-text search (BM25) plus a brute-force vector scan at query time, and bounded reads — resident memory does not grow with the corpus. A one-time migration on first start after an upgrade moves chunks out of a legacy JSON unit into the SQLite store (idempotent; duplicate rows from interrupted migrations are dropped).

> Every field can be overridden per base in the panel's Settings view (empty = inherit global); API keys are stored in plain text on the local machine.

### Local (in-process) embeddings and OCR

With `embeddingProvider: local`, the host runs embeddings in a **dedicated worker thread** via `@huggingface/transformers` (+ onnxruntime) — no external service needed. The default model is `onnx-community/Qwen3-Embedding-0.6B-ONNX` (1024 dims); set `embeddingModel` to any ONNX embedding repo id on Hugging Face. The first use downloads the weights from the Hub (cached under `$DSH_HOME/cache/dsh-knowledge/local-models`); later imports and searches run fully locally. Download / cancel / remove / retry in Settings → "Local Models", which shows live progress.

**OCR (scan recognition)**: after downloading the OCR model, scanned PDFs and images are recognized automatically on import (PaddleOCR PP-OCRv5 first, Tesseract fallback, all inside the `ocr-worker` thread). The models are ≈21MB and download from hf-mirror.com by default; users outside China can set the same `hfEndpoint` field to `https://huggingface.co`.

---

## Retrieval quality (measured)

A reproducible benchmark ships in `scripts/` — real mathematical-modeling questions over the imported corpus, scored by Hit@k / Recall@k / MRR:

| Question style | Lexical | Hybrid | Vector |
| --- | --- | --- | --- |
| Direct (topic word present, 14 q) | **0.929** | 0.857 | — |
| Rephrased (topic word absent, 10 q) | 0.600 | 0.900 (MRR 0.575) | 0.900 (**MRR 0.628**) |

Direct questions (the document's topic word appears in the query) are already answered by lexical search; the local embedding model's real value shows on rephrased questions, where vector retrieval lifts Hit@5 from 0.600 to 0.900. Run the benchmark against any base:

```bash
node scripts/eval-retrieval.mjs --file scripts/eval-rephrase.json --base <baseId> --mode hybrid
```

---

## Usage

1. Click the **sidebar-foot "Knowledge" button** (beside Settings) to open the full-page panel — not inside Settings.
2. Click "New base", then paste text, drag-and-drop txt/md/pdf/docx files, or import a URL; scanned PDFs work too once the OCR model is downloaded (Settings → Local Models).
3. Verify recall in the "Recall test" (switch hybrid/vector/lexical modes and the threshold); configure embeddings via the Settings button in the top-right.
4. Tell the agent *"answer using the knowledge base"* — it will call tools like `knowledge_search`.

---

## Development

Depends on the public DeepSeek Harness monorepo as a sibling checkout (`devDependencies` use `link:../dsh/...`):

```bash
pnpm install --config.auto-install-peers=false
pnpm run check    # typecheck + test + build
pnpm run build    # esbuild → lib/ (host entries + factory-form client bundle)
```

## Verification

- `pnpm test` — unit tests for chunking, retrieval, config, storage, and service level.
- `pnpm run typecheck` — `tsc --noEmit`.
- `pnpm run build` — host ESM entries + browser factory-form client bundle + type declarations.

---

## Known limitations

- **Model pickers are suggestion comboboxes, not live provider lists**: DSH's `ctx.llm` only surfaces chat models (`listModels` carries no embedding-modality tag, and this plugin's embedding endpoint/model are configured independently). The settings panel therefore uses native datalist comboboxes (embedding / local / rerank suggestions) with free-text fallback for custom ids.
- **Embedding runs inline within an import**: parsing and chunking show live per-file status, but vectorization runs in batches inline in the import flow (inference in a dedicated worker thread, imports per base queued through a 5-way concurrent pool); the local model's first download blocks until cached (the settings panel shows live progress).
- **MinerU needs an API Key**: `documentProcessorProvider: mineru` relies on the official MinerU service (or a self-hosted host) and requires registration for a Key; without one, PDFs use the local parse + OCR chain.
- **No built-in note editor**: note editing stays in DSH.

---

## License

[MIT](LICENSE). Special thanks to [Cherry Studio](https://github.com/CherryHQ/cherry-studio): this project's UI and feature design draws its inspiration from Cherry Studio (AGPL-3.0), while the code is an independent implementation that contains none of its source. Also thanks to [dsh-interconnect](https://github.com/deepseek-ai/deepseek-harness), [dsh-deeptutor](https://github.com/TecFancy/dsh-deeptutor), and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
