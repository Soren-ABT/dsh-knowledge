# PR #10–#13 Integration Design

## Objective

Integrate the useful work from community PRs #10–#13 without placing known
behavioral or data-integrity defects on `main`. Preserve the contributor's
original commits and authorship, apply maintainer fixes on an isolated branch,
and merge only after the combined result passes the repository's full release
quality gates.

This integration does not change the package version, create a tag, publish to
npm, merge into `main`, or push to GitHub without a separate maintainer action.

## Branch and commit strategy

- Work only on `integration/pr-10-13`, created from clean `v0.3.8` commit
  `ac952a1`.
- Cherry-pick the contributor commits in dependency order: #10, #11, #13,
  then #12.
- Keep the contributor commits intact so Git records their original author.
- Add maintainer fixes and tests as separate, reviewable commits.
- Do not rewrite or close the contributor's new PRs during local integration.

## Accepted contribution scope

### PR #10 — Ollama empty-URL fallback

Keep the server-side fallback from an empty Ollama embedding URL to
`http://127.0.0.1:11434`. Empty OpenAI-compatible URLs must continue to fail.
Add a regression test that observes the requested URL rather than relying on a
live Ollama server.

### PR #11 — locale additions

Keep the additive Chinese and English locale keys. Correct awkward English
copy, especially the cache-migration message, and ensure labels describe
source items accurately when the count includes both folders and files.

### PR #13 — theme and interaction improvements

Keep the theme tokens, readable secondary text, focus feedback, portal menu,
localized placeholders, and dismissible toasts, subject to these constraints:

- Refreshing or pulling an Ollama model must not silently change the global
  embedding provider, URL, or selected model. Configuration changes remain in
  explicit configuration controls.
- The toast close button must be connected to state removal in the same
  integrated result.
- The top-level portal menu must remain within the viewport. Nested menus must
  open beside their parent and flip horizontally when necessary rather than
  covering following parent-menu rows.
- Menu actions, outside-click dismissal, and submenu placement should be
  expressed through independently testable helpers where practical.

### PR #12 — local-path import and source tracking

Keep server-side file/directory path import, unique raw-copy storage, base
source summaries, source edit UI, orphan reconciliation, and the contributor's
two regression tests. Tighten the source-edit contract as follows.

#### Source identity

`BaseSourceInfo` carries the top-level source document ID. The UI renders an
edit action only for path-backed file and directory sources, and associates
the action with the selected source row. The source-path endpoint accepts both
`sourceId` and `path`.

The service rejects a target that does not exist, belongs to another base, is
nested rather than top-level, or is not a file/directory source. Updating one
source must never update sibling roots. URL and manual-text sources are not
offered a path edit.

#### Path and parser correctness

Path-import and source-edit inputs must be absolute existing paths. A file
source must point to a supported file type. Repointing a file updates its
stored `fileName` to the new basename and clears stale MIME metadata so reindex
selects the parser from the new source rather than the old extension. A
directory source may only point to a directory.

#### Failure-safe raw replacement

Re-reading a tracked file writes the candidate bytes to a fresh raw path. The
old raw copy remains referenced until new chunks and the updated document have
been committed. On failure, delete only the candidate copy and retain the old
document/raw relationship. After successful commit, delete the superseded raw
copy; a cleanup failure is logged and left for orphan reconciliation.

#### Import result visibility

Directory path import must not discard per-file errors. Return the error list
to the client and surface a warning when the import is partial. Use the
existing long-operation HTTP budget so a directory import is not cut off by
the generic 60-second panel timeout. A new background-job architecture is out
of scope for this integration.

## Compatibility and boundaries

- No database migration or re-embedding is required.
- Existing v0.3.8 documents without `sourcePath` keep their current rebuild
  behavior.
- The current raw-cache root remains dedicated to knowledge source copies.
- No changes to chunking, reranking, retrieval ranking, OCR policy, version
  metadata, release tags, or npm publication are included.
- No implicit configuration mutation is introduced by model browsing.

## Verification

Add or retain automated coverage for:

- empty Ollama URL fallback and empty OpenAI URL rejection;
- source edit targets exactly one of multiple top-level files/directories;
- cross-base, nested, missing, relative, and type-mismatched source targets;
- cross-extension file repoint uses the new parser identity;
- failed reindex retains the previous raw reference and removes the candidate;
- duplicate directory-relative filenames keep independent raw copies;
- partial path imports return their errors;
- toast dismissal and deterministic menu placement helpers;
- no model-refresh or model-pull path silently persists embedding config.

Before handoff, run:

- `npm run typecheck`
- full Vitest suite
- `npm run benchmark`
- `npm run build`
- `npm run verify:release`
- `npm run verify:package`
- relevant packed smoke tests when the combined source changes packaging or
  runtime boot behavior

The integration is ready for maintainer review only when the working tree is
clean and every required local gate passes.
