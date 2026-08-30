# Retrieval benchmark

This directory contains a deterministic, copyright-safe retrieval benchmark
for dsh-knowledge. It uses 24 synthetic documents and 40 questions split
between Chinese and English. The corpus deliberately includes similar topics,
distractors, title and heading clues, cross-base ambiguity, identifiers, dates,
thresholds, and operational facts.

The required mode is lexical-only. It mounts `KnowledgeService` directly,
needs no DSH server, API key, network request, embedding model, or OCR weights,
and evaluates both primary-query search and multi-query RRF.

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

## Metrics

- Hit@1 and Hit@3: fraction of questions with an expected document at that
  depth.
- Recall@3: fraction of all expected documents recovered in the first three
  results.
- MRR: mean reciprocal rank of the first expected document.
- Context Recall: fraction of expected answer sentences present in retrieved
  chunk text or sibling context.
- p50/p95 elapsed time and process RSS: informational only, because shared CI
  hosts do not provide stable performance isolation.

Quality metrics are enforced against `baseline.json`. A failure prints the
question ID, expected source, and observed top documents. The committed
observations describe the current implementation but are not performance
promises for a user's corpus or hardware.

For real private corpora and configured embedding/rerank providers, use the
separate `scripts/eval-retrieval.mjs` and `scripts/eval-rag.mjs` tools against a
running DSH instance.
