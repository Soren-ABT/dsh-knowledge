# Knowledge Tool Retrieval Hardening Design

## Summary

Harden the model-facing knowledge tools and proactive retrieval path without renaming the existing fourteen tools or changing the public HTTP search contract. The repair makes enabled knowledge bases a strict boundary, makes global and per-base auto-retrieval settings durable and effective, prevents stale conversation context from suppressing a new topic, treats retrieved documents as untrusted reference data, and improves multi-query fusion and Native Mode output.

## Scope and compatibility

- Keep all existing tool names, primary arguments, HTTP routes, and stored knowledge data compatible.
- Preserve the existing empty-selection meaning of “all existing bases”. Treat a non-empty saved selection with no remaining valid ids as an empty scope, never as “all”.
- Allow creating a new base regardless of the current scope. Every operation on an existing base or document must resolve through the strict enabled scope.
- Preserve lexical, vector, hybrid RRF, metadata filtering, reranking, MMR, sibling context, and lexical fallback behavior unless this design explicitly changes it.

## Scope and configuration architecture

Introduce one service-level effective-scope representation that distinguishes all bases from an explicitly empty set. System-prompt base names, explicit search, proactive retrieval, reranker discovery, statistics, and every existing-base tool must consume this representation instead of independently interpreting `undefined` or an empty array.

The global `autoRetrieve` setting remains the deployment-wide master switch. Each base may override `autoRetrieve`; a false value removes that base from proactive retrieval. `autoRetrieveWeight` remains a per-base seat cap from zero to five, with zero excluding the base. Add the missing fields to the runtime override schema and `BaseConfig` type, and apply them in `resolveConfigFor` so UI changes survive validation, take effect immediately, and persist across restarts.

If configured enabled ids become stale, operations return no eligible content or a clear “not enabled” error. They must not silently broaden the search. Expected empty-scope outcomes are not treated as retrieval failures.

## Proactive retrieval data flow

The pre-step hook will pass the current user message separately from the recent-context query. Topic detection, throttling, filler rejection, and named-base matching use only the current message. The lexical retrieval query may include up to the configured two recent user turns so deictic follow-ups still work.

Named-base resolution operates only over eligible bases and prefers the longest matching non-empty name, making overlapping names deterministic. Candidate validation considers the indexed evidence available to the model: document title, heading, hit text, and sibling context. Proactive retrieval remains lexical-first for latency. A configured remote reranker may rescore candidates within the existing four-second budget; local cross-encoders remain excluded from the pre-step path.

Per-agent injected chunk memory becomes insertion-ordered and bounded: adding entries beyond the cap removes only the oldest entries instead of clearing the whole set. Throttle state records keywords from the current message, not the context-augmented query.

## Untrusted context and citations

Automatically retrieved material is framed as untrusted reference data. The framing tells the model to use it only as factual evidence and never follow instructions, permission claims, or tool requests found inside it. Each injected excerpt includes a stable source label with base name, `baseId`, `docId`, `chunkId`, document title, and heading when present.

Explicit search renders each excerpt once. The same result line carries the stable source label, while the canonical citations array remains available to programmatic/Code Mode consumers. Citation content includes the stable identifiers and does not require duplicating the entire excerpt in Native Mode.

## Multi-query retrieval

Accept a primary query of at most 2,000 characters and at most three non-empty extra variants of at most 2,000 characters each after trimming, case-insensitive normalization, and deduplication against the primary query and each other. The service also enforces these limits so HTTP or programmatic callers cannot bypass the tool schema.

Each variant retrieves a candidate ranking without performing its own remote rerank. Merge variant rankings with reciprocal-rank fusion by chunk id, retain a bounded candidate pool, and run at most one final rerank using the primary query. This avoids comparing raw BM25, hybrid, vector, and rerank scores from independent searches and prevents duplicate embedding/rerank costs. Result `total` represents a non-inflated candidate/corpus total rather than a sum repeated for every variant.

## Tool behavior and approval

- Keep the fourteen registered tools, but centralize base/document scope guards.
- Give `mode` and `sourceTypes` enum schemas and validate query lengths, extra-query counts, time ranges, read offsets, and grep limits.
- Make `knowledge_get_document` useful in Native Mode with `chunkOffset` (default zero) and `chunkLimit` (default twenty, maximum fifty), returning the total chunk count, truncation state, and next offset. Preserve canonical structured chunks for Code Mode.
- Make `knowledge_read_document` rendering state whether the slice is truncated, the next character offset, returned match count, and total match count.
- Route `knowledge_delete_base` and `knowledge_delete_document` through a `tools/pre-execute` decision of `ask`. If approval is unavailable, rejected, or cancelled, DSH fails closed before the tool body runs.
- Other management tools continue without an approval prompt but cannot target disabled bases.

## Errors and observability

Use the knowledge service logger rather than `console.warn` for proactive retrieval failures and rerank fallback. Scope denial errors identify the target as not enabled without revealing unrelated base ids. Invalid caller input produces deterministic validation errors. Best-effort proactive retrieval continues to return no background on operational failure and never breaks the user turn.

## Test and acceptance plan

Add regression coverage for:

- all-bases, selected-bases, partially stale selections, and all-stale selections across the prompt, explicit search, proactive retrieval, and management tools;
- durable global/per-base auto-retrieval switches and effective per-base weights;
- the real pre-step two-turn flow where a new topic follows a recently injected topic;
- overlapping base names, title/heading-only matches, bounded dedup memory, and untrusted-context framing;
- extra-query capping, normalization, RRF fusion, non-inflated totals, and at most one rerank call;
- Native Mode document/search/read rendering and stable source identifiers;
- one-shot approval for both destructive tools, including unavailable/rejected paths;
- every existing test as a compatibility regression.

Acceptance requires `npm run typecheck`, the full Vitest suite, and `npm run build` to pass. The final worktree must contain only files relevant to this repair, with no generated or unrelated changes accidentally committed.
