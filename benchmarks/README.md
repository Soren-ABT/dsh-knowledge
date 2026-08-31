# Retrieval benchmark

This directory contains a deterministic, copyright-safe retrieval benchmark
for dsh-knowledge. It uses 24 synthetic documents and 40 questions split
between Chinese and English. The corpus deliberately includes similar topics,
distractors, title and heading clues, cross-base ambiguity, identifiers, dates,
thresholds, and operational facts.

The required mode is lexical-only. It mounts `KnowledgeService` directly,
needs no DSH server, API key, network request, embedding model, or OCR weights,
and evaluates primary-query search, multi-query RRF, and the actual exported
auto-retrieve background builder.

## Run

```bash
pnpm benchmark
pnpm benchmark:json
pnpm benchmark:update-baseline
```

Normal runs never modify tracked files. The update command refreshes only the
observed quality metrics in `baseline.json`; it preserves thresholds. Lowering
a threshold is a manual review decision and must be explained in the commit or
pull request.

## Schema v2 metrics

- Hit@1 and Hit@3: fraction of questions with an expected document at that
  depth.
- Recall@3: fraction of all expected documents recovered in the first three
  results.
- MRR: mean reciprocal rank of the first expected document.
- Context Recall: fraction of expected answer sentences present in retrieved
  chunk text or sibling context.
- Visible Evidence Recall: fraction present in the text that is actually made
  model-visible through the production `serializeContextWindow` and
  `renderKnowledgeSearchResult` exports. Missing either production helper is a
  benchmark failure; there is no structural or legacy rendering fallback.
- Context-window coverage: every hit in all 40 primary and multi-query cases
  must carry a `ContextWindow` (`1.0` is a hard minimum).
- Bridge Success@1: a dedicated real three-chunk fixture retrieves a locator
  anchor whose canonical text intentionally does **not** contain the answer.
  The answer must be present in both the search hit's `ContextWindow` and a
  separate `service.getDocumentContext(anchorChunkId)` continuation, and must
  survive the production renderer. This is not an alias for ordinary
  ground-truth recall.
- Long-anchor tail visibility: a single canonical anchor larger than 768
  tokens places the answer at its tail. The query-centred `ContextWindow` and
  the final production renderer must expose that answer without exceeding the
  per-hit budget.
- Auto-retrieve injection rate and Visible Evidence Recall: evaluate the real
  `buildAutoRetrieveMessage` output with isolated agent identities, including
  its relevance gates and final clipping/composition.
- Structural and final-renderer ordering errors must both be zero. Each
  model-visible hit is capped at 768 estimated tokens and the entire explicit
  search rendering at 8192; the auto-preview cap remains 640. All budget
  overruns are hard failures.
- Duplicate-token ratio is informational and counts token occurrences as a
  multiset, including repeated occurrences inside the same hit; it does not
  collapse a hit to a set before measuring duplication. Average visible tokens
  remains informational.
- p50/p95 elapsed time and process RSS: informational only, because shared CI
  hosts do not provide stable performance isolation.

Quality minima and correctness maxima are enforced against the schema-v2
`baseline.json`. A failure prints the question ID, expected source, and
observed top documents/background status. The committed observations describe
the current implementation but are not performance promises for a user's
corpus or hardware. Native DSH agent-loop tool-call counts are intentionally
outside this deterministic service harness and belong in trajectory tests.

For real private corpora and configured embedding/rerank providers, use the
separate `scripts/eval-retrieval.mjs` and `scripts/eval-rag.mjs` tools against a
running DSH instance.
