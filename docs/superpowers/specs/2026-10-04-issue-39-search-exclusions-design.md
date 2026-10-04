# Issue #39: request-level search exclusions

Status: approved for implementation on 2026-10-04. The feature is pending release.

## Goal

Keep bibliography, table-of-contents, and processing-log documents out of retrieval candidates when a caller explicitly excludes them. Filtering must occur before candidate limits and final TopK, so eligible body documents can fill the result set.

## Contract

- Add `excludeDocIds?: readonly string[]` and `titleExcludes?: readonly string[]` to `SearchFilter` and equivalent client fields.
- HTTP accepts these fields inside `filter`; `knowledge_search` accepts them at the top level.
- IDs match exactly. Title terms are trimmed, ignore case, and use literal substring matching; any nonblank match excludes a document.
- Inclusion conditions remain conjunctive. Exclusion wins when a document is both included and excluded.
- Empty exclusion arrays, blank title terms, and unknown IDs have no effect. Existing empty `docIds` and `sourceTypes` arrays still match nothing.
- HTTP rejects malformed new fields with `400 invalid_request`; the tool uses its parameter schema. `excludeDocIds` is canonical, with no `notDocIds` alias.
- Scope and enabled-base rules remain intact. Examples omit `baseId` or use a real ID.

## Implementation

Resolve positive metadata filters into an optional allowed-ID set. Preserve a separate excluded-ID set, merging title matches into it. Exclusion-only requests must not enumerate all remaining documents into an allow-list.

Pass the document-filter object to both retrieval lanes. Share SQL `IN` / `NOT IN` conditions across FTS, short-word LIKE, relaxed queries, and count queries before `LIMIT`. Bind each ID set as one JSON parameter consumed by `json_each`, removing the former 500-ID binding limit.

Apply allowed and excluded sets before vector scoring and memory ranking. Keep deadline checks active while scanning excluded vectors. Every query variant uses the same request filters; excluded documents never enter fusion, MMR, reranking, or returned evidence.

No schema migration, reindex, default per-base exclusion policy, or corpus move is needed.

## Acceptance

- Reproduce the unique appendix-marker query on SQLite: excluding every matching appendix returns no hits.
- Seed more high-scoring excluded documents than the candidate pool admits; eligible body documents must still fill TopK in lexical, vector, hybrid, and auto modes.
- Cover combined ID/title filters, overlapping inclusion, empty arrays, unknown IDs, trimming, case, literal punctuation, cross-base scope, and more than 500 IDs.
- Cover FTS, short-word LIKE, relaxed-query counts, vector deadlines, multi-query retrieval, reranker input, a real HTTP server, and tool runtime execution.
- Run focused regressions, typecheck, build, retrieval benchmark, workspace/package checks, and review the diff. Existing CI supplies Node 22.19 / 24 / 26 and platform validation.
- Deliver bilingual README updates, an Unreleased changelog entry, and bilingual issue-response drafts. Publish no issue comment or release as part of this local implementation.

## Local validation record

Windows / Node.js 24.16.0, 2026-10-04:

- Focused retrieval regressions: 207 tests across 7 files passed.
- Complete regression suite, including HTTP to SQLite: 498 tests across 39 files passed.
- Typecheck, build, workspace policy, release metadata, npm package verification, and `git diff --check` passed.
- Retrieval benchmark (24 documents / 40 questions): primary and multiple-query Hit@1, Hit@3, Recall@3, context recall, and visible evidence were 100%; MRR was 1.000.
- Production audit could not obtain registry results: pnpm returned `fetch failed`, leaving the audit script without `advisories` data. No dependencies or audit policy were changed.
- Cross-platform and Node 22.19 / 26 checks remain pending in existing CI. Embedding and rerank tests use mocked provider responses and isolated temporary libraries.
