<div align="center">

# dsh-knowledge

**A knowledge base plugin for DSH**

[**English**](./README.en.md) · [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)
[![Node.js >= 22](https://img.shields.io/badge/node.js-%3E%3D22-brightgreen?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-%23003B57?logo=sqlite)](https://www.sqlite.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

A **knowledge base system** as a standalone, open-source bundle plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): bases (with **groups**) and documents, text chunking, embeddings (OpenAI-compatible / Ollama / **local model** / lexical fallback), retrieval, model-facing tools, and a browser management panel.

</div>

---

## Why dsh-knowledge

Bring project manuals, papers, and team wikis into DSH. In chat, you can search for a passage, cite it, and read what comes next. Start with keyword search and add an embedding model to the libraries that need semantic search.

| What you want to do | How it works |
| --- | --- |
| Keep sources together | Import files, directories, text notes, HTML pages, or raw Markdown URLs. Group bases by project and preview the original document, its chunks, and processing progress in the panel. |
| Keep a library current | Bind a directory to a path DSH can access and sync additions, edits, and deletions manually or on a schedule. Rescans run in the background and show the entry count and most recent path. Reopen the same base to see progress or its last sync result. Refresh a web page or Markdown URL in place while retaining its document ID, folder, and custom title. |
| Read scans and complex PDFs | Use local OCR for scanned PDFs. For tables, equations, or multi-column layouts, choose cloud or self-hosted MinerU. Results with structured source information can point back to a page and region. [MinerU setup](./docs/mineru-self-hosted.md) |
| Find an exact term or a related idea | Use keywords for identifiers and terminology, vectors for paraphrases, or hybrid search to combine both. Filter by document, title, source, or update time and optionally rerank the results. |
| Check a citation | Each hit includes the document title and chunk position. Read the surrounding passage or follow a citation to its source block when structured parsing is available. Recall Test shows scores and timing and lets you copy a citation. |
| Choose what reaches the model | Enable the bases available to chat. Automatic retrieval can supply evidence before an answer and carry the topic into a follow-up. Under Global defaults → Advanced Settings, you can turn off the request to cite auto-retrieved sources. The evidence keeps its source labels and untrusted-content notice. Explicit searches can target selected bases and include citations. |

## Install and try it

Start DSH `0.2.2-rc.5` with Node.js 24.9.0 or newer and choose a profile. Merge these entries into `allowBuilds` in the profile’s `pnpm-workspace.yaml`.

```yaml
allowBuilds:
  esbuild: true
  onnxruntime-node: true
  protobufjs: true
  sharp: true
  tesseract.js: false
```

Choose one command and replace `<profile>` with your profile name. The first installs the npm stable release. The second installs this exact beta once it is published.

```sh
dsh plugin --profile <profile> add dsh-knowledge
dsh plugin --profile <profile> add dsh-knowledge@0.6.0-beta.1
```

To try a locally packed release candidate, run `dsh plugin --profile <profile> add ./dsh-knowledge-0.6.0-beta.1.tgz`. Restart the DSH web service and refresh the page.

1. Open **Knowledge** at the bottom of the sidebar. Create a base and import a document you know. Supported formats include PDF, Word, PowerPoint, Excel, EPUB, Markdown, HTML, CSV, JSON, and plain text.
2. Enter a phrase from the document in **Recall Test**. Inspect the matching passage and its neighbors. Keyword search works immediately.
3. Enable the base and ask a question that calls for a source, such as “What is the return period in the manual? Cite the clause and check the exceptions that follow.”

Press Esc to dismiss the current menu or dialog. Press Esc in the main Knowledge panel to return to DSH.

## Retrieval and model settings

| Setup | Configuration |
| --- | --- |
| Work offline | Use the default keyword search. For semantic search, reranking, or OCR, download the corresponding models in **Local Models** once and run them on your machine. |
| Use an inference service | Embeddings support OpenAI-compatible endpoints and Ollama. Reranking can use a compatible remote rerank endpoint. An optional vision model can caption images or tables. The processing steps you enable determine what is sent to a remote service. |
| Tune individual projects | Set global defaults, then override chunking, retrieval mode, models, or automatic retrieval weight per base. Rebuild a base’s index after switching embedding models. |

## What agents can do

`knowledge_search` accepts `baseId` or `baseIds`. For example, get the IDs from `knowledge_list_bases` and search just the manuals and policies, excluding documents with “contents” in the title.

```json
{"query":"return period","baseIds":["<manuals ID>","<policies ID>"],"titleExcludes":["contents"]}
```

Omitting the base arguments searches the enabled scope. Passing `baseIds: []` returns no hits. DSH asks for confirmation before permanent deletion.

<details>
<summary>Browse all 15 model tools by task</summary>

| Task | Tools |
| --- | --- |
| Browse bases, documents, and statistics | `knowledge_list_bases`, `knowledge_list_documents`, `knowledge_stats` |
| Search, read on, and inspect evidence | `knowledge_search`, `knowledge_get_document`, `knowledge_read_document`, `knowledge_read_evidence` |
| Add sources and refresh URLs | `knowledge_add_document`, `knowledge_import_url`, `knowledge_refresh_url` |
| Rebuild a document or base index | `knowledge_reindex_document`, `knowledge_reindex_base` |
| Create a base or delete material | `knowledge_create_base`, `knowledge_delete_document`, `knowledge_delete_base` |

</details>

## Running and maintaining the plugin

- Packed-install CI boots the plugin on Windows and Ubuntu with DSH `0.2.2-rc.5`. On Intel Macs, use keyword search or a remote model.
- Back up DSH storage-domain metadata, the SQLite chunk database, `knowledge-raw` originals, and the `knowledge-artifacts` processing outputs together.
- [Changelog](./CHANGELOG.md) · [Retrieval benchmarks](./benchmarks/README.md) · [Contributing](./CONTRIBUTING.md) · [Security reporting](./SECURITY.md) · [AGPL-3.0 license](./LICENSE)
