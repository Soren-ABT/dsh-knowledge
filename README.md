# dsh-knowledge

A Cherry Studio-style **knowledge base system** as a standalone, open-source bundle plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): bases (with **groups**) and documents, text chunking, embeddings (OpenAI-compatible / Ollama / **local model** / lexical fallback), retrieval, model-facing tools, and a browser management panel.

## Features

- **Bases, groups & documents**: create/delete/rename bases, documents and **groups** (grouped sidebar navigation with collapsible sections, move-to-group, create/rename/delete group); add text, upload files (txt / md / csv / html / json / pdf / docx / **doc / pptx / ppt / xlsx / xls** / epub, drag-and-drop), import a URL or a whole **directory** (imported as a drillable folder tree); same-name **conflict resolution** (keep all / replace); content-hash dedup; chunk and raw-text preview; per-document **✓ ready badge, live import status (解析中 / 嵌入中 NN%)**, and relative updated time. Imports run in the background — each file row appears the moment parsing starts, folders show 导入中 while any descendant is processing, and errors surface as toasts.
- **Embeddings & retrieval**: pluggable providers — any OpenAI-compatible `/embeddings` endpoint, a local Ollama server, or an **in-process local model (transformers.js, default `onnx-community/Qwen3-Embedding-0.6B-ONNX`)** — with **hybrid retrieval** (BM25 + vector + Reciprocal Rank Fusion), **rerank** (Jina / SiliconFlow / Cohere v2 style APIs), **MMR diversity**, search modes (auto/hybrid/vector/lexical), and a score threshold. A lexical BM25 fallback (CJK bigram + latin word) keeps it working with zero configuration; the recall test shows per-hit scores, latency, and keeps a **replayable search history**.
- **Smart chunking**: heading-aware chunking (preserves the Markdown heading path) with the document title + heading injected as retrieval context for better recall.
- **Index management**: reindex on demand (re-chunk + re-embed after changing chunk size or the provider), batched embedding, and statistics (docs / chunks / chars / tokens / embedded).
- **Model tools**: 11 tools — search, list/create/delete bases, add/list/delete documents, import URL, stats, get document, reindex.
- **Management panel**: NOT in Settings — a sidebar-foot "Knowledge" action (beside Settings) opens a frame-wide Cherry Studio-style page: left grouped navigator with base cards, right content column with stat chips, an "updated at" header, add-source popover, a **table-style source list (checkbox + name/type/status/updated-at columns with multi-select bulk reindex/delete)**, per-base **设置** panel (document processing / embedding / rerank / Top K / advanced), recall test, and toasts.
- **Local model manager (in Settings)**: a Settings → "Local Models" page (via the `settings.section` slot) with Cherry Studio-style cards: model name/subtitle, a ready badge, download / retry / remove actions, and a live download progress bar. Downloaded models are selectable as the embedding provider in a base's settings.
- **Persistence**: business state (bases, documents, runtime config) is durable via DSH's `storageDomain` seam (the `json` backend shipped by the `web` profile); **chunks live in a dedicated SQLite file** (`<DSH_HOME>/storages/knowledge-chunks.sqlite`, configurable via `chunkStorePath`) so put/delete stay O(1) as data grows — one row per chunk, embeddings as float32 BLOBs. Lexical search runs an FTS5 trigram index and the vector lane scans stored vectors at query time (Cherry Studio's posture); nothing loads into memory at open, so resident memory does not scale with the corpus. One-time migrations on first start after upgrade convert the legacy JSON unit and the previous bundle layout. Falls back to in-memory when no storage backend is available.

## Architecture

One bundle mounts three plugin rows:

| Plugin | Platform | Role |
|---|---|---|
| `knowledge` (`ctx.knowledge`) | host | Core engine: storage domain, chunking, embeddings, retrieval, `/knowledge/*` HTTP surface |
| `tool-knowledge` | host | 11 model tools consuming `ctx.knowledge` |
| `ui-knowledge` | client | Sidebar-foot entry (`sidebar.footer.action`) + frame-wide Cherry Studio-style panel (`shell.overlay`), calling the host over same-origin `fetch` |

Data model: business state lives in the storage domain `knowledge` (version 0) — `bases` and `documents` tables plus a global slot for runtime config overrides; chunks (each may carry an `embedding` vector) live in the plugin-owned SQLite chunk store, one row per chunk.

## Install

The package declares `dsh.bundle.patch`, so `dsh plugin add` registers it automatically:

```bash
dsh plugin --profile <name> add dsh-knowledge          # from npm
dsh plugin --profile <name> add file:/path/to/dsh-knowledge
dsh plugin --profile <name> add ./dsh-knowledge-0.1.0.tgz
```

> **pnpm 10+ build allowlist**: the in-process local-embedding runtime pulls `onnxruntime-node`, `sharp`, and `protobufjs`, whose postinstall scripts pnpm refuses to run by default — `dsh plugin add` will then exit non-zero and stop before registering the bundle. Add this to the profile's `pnpm-workspace.yaml` **before** installing, then run the add again:
>
> ```yaml
> allowBuilds:
>   onnxruntime-node: true
>   sharp: true
>   protobufjs: true
> ```
>
> (None of these scripts are required for the Windows embedding path — onnxruntime's Windows binaries are bundled and `sharp`/`protobufjs` are unused — but pnpm treats the refusal as an error, so approving them is the clean route.)

Restart the web service for the host half and refresh the page for the client panel.

> The plugin installs at the **profile level** (`dsh plugin` runs pnpm inside the
> profile directory), so the same three commands work identically whether DSH
> was installed from npm or run from a fresh source checkout — no plugin
> source, checkout links, or DSH builds are involved.

## Compatibility

- **DSH version**: developed and verified against [deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness) commit `47f943859b` (public npm-plugin-ecosystem era, 2026-08). Peer dependencies are declared as `*` (DSH's convention), so a newer DSH source checkout installs without resolution errors; if a newer DSH release breaks something, report an issue with the DSH commit you run.
- **Node.js**: `^22.19.0 || >=24.0.0` (the same floor DSH itself requires — the chunk store uses Node's built-in `node:sqlite`, which DSH's own session storage also uses).
- **Platforms**: Windows / macOS / Linux x64+arm64. Legacy `.doc` / `.ppt` / `.xls` parsing uses `@firecrawl/anydoc` (per-platform native binaries); everything else is pure JS.
- **First-run network**: enabling `embeddingProvider: local` downloads model weights from Hugging Face on first use (cache under `localModelCacheDir`); set `HF_ENDPOINT` to a mirror if needed.

## Configuration

Deployment defaults live in the `knowledge` row of `cordis.patch.yml`; the panel's Settings can override them at runtime (persisted in the storage domain):

| Field | Default | Notes |
|---|---|---|
| `embeddingProvider` | `none` | `openai` / `ollama` / `local` (in-process transformers.js) / `none` |
| `embeddingBaseUrl` | `''` | e.g. `https://api.openai.com/v1` or `http://127.0.0.1:11434` (unused by `local`) |
| `embeddingModel` | `''` | e.g. `text-embedding-3-small`; for `local`, a Hugging Face repo id (default `onnx-community/Qwen3-Embedding-0.6B-ONNX`) |
| `embeddingApiKey` | `''` | optional; `KNOWLEDGE_API_KEY` env var also works |
| `rerankModel` / `rerankBaseUrl` / `rerankApiKey` | `''` | rerank model (empty = disabled), Jina / SiliconFlow / Cohere v2 style APIs |
| `smartChunk` | `true` | heading/paragraph-aware chunking; off = separator only |
| `chunkSeparator` | `\n\n` | block boundary when smart chunking is off (`\n` allowed) |
| `chunkSize` | `800` | characters per chunk |
| `chunkOverlap` | `100` | overlap between consecutive chunks |
| `topK` | `6` | results per search (1–50) |
| `searchMode` | `auto` | `auto` / `hybrid` / `vector` / `lexical` |
| `similarityThreshold` | `0` | drop results below this score (0–1) |
| `mmrDiversity` | `0` | MMR diversity (0–1, 0 = off) |
| `embeddingBatchSize` | `32` | texts per embedding request |
| `localModelCacheDir` | `''` | local-model cache root; empty = `<DSH_HOME>/cache/dsh-knowledge/local-models` (`~/.dsh` when `DSH_HOME` is unset) |
| `chunkStorePath` | `''` | chunk SQLite file; empty = `<DSH_HOME>/storages/knowledge-chunks.sqlite` |

Chunk data is stored in a dedicated SQLite file rather than the domain KV store: on the `web` profile's JSON backend every record write rewrites the whole unit file, which made deletion and import cost seconds-to-minutes as data grew. The SQLite store makes each put/delete a single statement, FTS5 trigram full-text search (BM25) plus a brute-force vector scan at query time, and bounded reads — resident memory does not grow with the corpus. A one-time migration on first start after an upgrade moves chunks out of a legacy JSON unit into the SQLite store (idempotent, keeps a `.bak`-free in-place conversion; duplicate rows from interrupted migrations are dropped).

Every field can be overridden per base in the panel's Settings view (empty = inherit global).

### Local (in-process) embeddings

With `embeddingProvider: local`, the host runs embeddings in-process via `@huggingface/transformers` (+ onnxruntime) — no external service needed. The default model is `onnx-community/Qwen3-Embedding-0.6B-ONNX` (1024 dims, same as Cherry Studio); set `embeddingModel` to any ONNX embedding repo id on Hugging Face. The first use downloads the weights from the Hub (cached under `$DSH_HOME/cache/dsh-knowledge/local-models`); later imports and searches run fully locally. Download / cancel / remove / retry in Settings → "Local Models", which shows live progress; `HF_ENDPOINT` can point at a mirror to speed up the download.

## Development

Depends on the public DeepSeek Harness monorepo as a sibling checkout (`devDependencies` use `link:../dsh/...`):

```bash
pnpm install --config.auto-install-peers=false
pnpm run check    # typecheck + test + build
pnpm run build    # esbuild → lib/ (host entries + factory-form client bundle)
```

## Known limitations

- **Model pickers are suggestion comboboxes, not live provider lists**: DSH's `ctx.llm` only surfaces chat models (`listModels` carries no embedding-modality tag, and this plugin's embedding endpoint/model are configured independently). The settings panel therefore uses native datalist comboboxes (embedding / local / rerank suggestions) with free-text fallback for custom ids.
- **Embedding is synchronous within an import**: parsing and chunking show live per-file status, but embedding runs inline in the host process (batched) rather than on a worker queue; the local model's first download also blocks until cached (the settings panel shows live progress).
- **No OCR / no built-in note editor**: images and scanned PDFs yield no text (Cherry outsources OCR to external processors, which a DSH plugin cannot); note editing stays in DSH.

## License

[MIT](LICENSE). With thanks to [dsh-interconnect](https://github.com/deepseek-ai/deepseek-harness), [dsh-deeptutor](https://github.com/TecFancy/dsh-deeptutor), and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
