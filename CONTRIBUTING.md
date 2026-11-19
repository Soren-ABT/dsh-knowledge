# Contributing to dsh-knowledge

Thanks for improving dsh-knowledge. The plugin follows DeepSeek Harness (DSH)
closely, so a reproducible DSH compatibility anchor is part of the development
environment rather than an optional extra.

## Development setup

Use Node.js 24.9.0 or newer and the pnpm version declared by each repository.
Check out the repositories
as siblings because the development dependencies use `link:../dsh/...`:

```text
workspace/
├── dsh/
└── dsh-knowledge/
```

For this release, source builds use DSH `0.2.2-rc.5` at the commit below.
When preparing a new plugin release, pin the three most recently published
`@deepseek-ai/dsh` versions in the packed-install matrix and align the source
commit with the newest one. Match the plugin's development version of Zod to
the one used by the host's `storage-domain` package, so both compile the same
document schemas. DSH provides the runtime peer. The `Packed DSH compatibility`
check covers all three public CLIs on Windows and Ubuntu.

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh
git -C dsh checkout 9c2670d3bce5275e0d1610272958121af87787bb
git clone https://github.com/Soren-ABT/dsh-knowledge.git dsh-knowledge
cd dsh
pnpm install --frozen-lockfile
pnpm run build:lib
cd ../dsh-knowledge
pnpm install --frozen-lockfile
```

## Where to change retrieval

| When you change | Start here |
| --- | --- |
| Search filters, candidate retrieval, or fusion across queries | [Search engine](src/knowledge/search.ts). Both the tool and the HTTP API call `KnowledgeService.search()`. |
| Reranker behavior or the context attached to a hit | [Search reranking](src/knowledge/search-rerank.ts) and [context assembly](src/knowledge/search-context.ts). The service owns reranker state for its lifetime. |
| Automatic retrieval on a new message or follow-up | [Query planning](src/tool-knowledge/auto-retrieve-query.ts) handles intent and identifiers. [Evidence selection](src/tool-knowledge/auto-retrieve-selection.ts) applies score thresholds and per-base limits. [The pre-step hook](src/tool-knowledge/auto-retrieve.ts) owns cancellation and per-agent history. |
| Source labels, clipping, or the text shown to the model | [Evidence rendering](src/tool-knowledge/render.ts) applies the explicit-search and automatic-injection budgets. |
| Tool parameters, execution, or access | Use the matching [search](src/tool-knowledge/search-tool.ts), [library](src/tool-knowledge/library-tools.ts), or [document](src/tool-knowledge/document-tools.ts) registration. [Tool access](src/tool-knowledge/tool-access.ts) owns shared scope and approval checks. |

The [tool plugin entry](src/tool-knowledge/index.ts) wires these registrations
and exposes the public helpers. When changing behavior, exercise the normal
tool, pre-step, or service entry in the relevant tests.

## Required checks

Run the checks relevant to your change before opening a pull request:

```bash
npm run verify:workspace
npm run typecheck
npm test
npm run build
npm run benchmark
npm run audit:prod
npm run verify:package
```

The workspace check is dependency-free and should run before `pnpm install` in
clean environments. It rejects missing or non-boolean native build decisions.

`npm run release:check` is the maintainer's final, non-publishing release gate.
It expects a clean Git working tree and never creates a tag, pushes, or
publishes to npm.

Changes involving paths, workers, native dependencies, OCR, SQLite, process
lifecycle, or installation must be tested on both Windows and Linux. Do not
download model weights in ordinary automated tests; isolate real-model checks
as an explicitly documented validation step.

## Pull requests

- Keep each pull request focused on one problem.
- Add regression coverage for behavior changes and bug fixes.
- Update both English and Chinese user documentation when user-visible
  behavior changes.
- Explain compatibility, security, storage migration, and release-note impact.
- Do not commit generated tarballs, model files, caches, credentials, or local
  DSH profiles.
- Treat lower retrieval benchmark scores as a behavior change that requires an
  explanation, not as a baseline file to update silently.

The maintainer performs npm publication and GitHub Release creation manually.
A pull request must not add credentials or publish from an untrusted context.
