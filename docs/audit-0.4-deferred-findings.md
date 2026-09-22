# Deferred audit findings (0.4.0, updated for 0.4.1)

The 0.4.0 reliability audit was closed in `41c1c67` plus the documentation batch that
follows it. Everything the audit classified as critical or high was fixed in that
range. This file records what was deliberately **not** fixed, so a later release can
pick it up without re-deriving it, and so the record does not claim more than was
verified.

**0.4.1 update:** five of the six code changes listed in section 2 were fixed in
0.4.1 (PRs #27–#29, contributed by InfiniteScope) and the retrieval benchmark was
made hermetic at the same time. Section 2.1 lists what remains open; section 2.2
keeps the closed findings and how they were resolved.

Two categories appear below: items that need a **runtime reproduction** before a fix
can be trusted (section 1), and code changes that are understood but were out of
scope for a release already carrying ten commits of behaviour change (section 2).

Section 3 records corrections to the audit itself, where a note did not survive
re-inspection.

## 1. Needs a runtime reproduction

- **Issue #18's "reindex → gate" causation chain.** The three mechanisms the fix
  addresses are each locked by unit tests (stale `validating` flag expiry, live
  status dropped when the child dies, routine load no longer publishing
  `validating`, gate refusal reported as `skipped`, cold-load allowance). What is
  *not* verified is the reporter's specific claim that a directory reindex is what
  leaves the gate armed; confirming it needs a real local reranker and a corpus of
  the size they used (267 documents / 8,995 chunks). The response to #18 asks them to
  confirm it on their machine.
- **`Module did not self-register` is process-local.** The fix depends on this: a
  failed `load`/`embed` now replaces the child, so the retry is a fresh process.
  The reporter verified a clean `node -e require(...)` loads the same addon, which
  is strong evidence, but we could not reproduce the failure mode locally (needs
  Linux / Node 26 / a ~585 MB model / a ~650 KB/s link).
- **Inherited embedding caches cannot be size-validated.** Expected byte sizes come
  from the downloader's own progress events, so they exist only for a download this
  process performed. A cache inherited from 0.3.9 is judged by "non-empty `.onnx`"
  plus the fingerprint readiness record. The rerank path additionally quarantines a
  cache that fails to load and re-downloads it; the embedding path reports the real
  failure and replaces the child but leaves the file for the user to delete. Closing
  this needs the HF API's LFS size/sha256 for the model files (an extra registry
  call), which is a behaviour change worth its own review.
- **Does a browser disconnect dispose the plugin scope?** The panel's polling and
  in-flight requests assume the scope outlives a disconnected client. This lives in
  the DSH host, outside this repository, and was not exercised.
- **The `prepack` path.** `scripts/smoke-packed-install.mjs` installs and exercises
  the packed tarball, but the `prepack` script itself (run by npm before packing)
  was not executed in this audit; the gates verify the tarball's *contents*, not the
  hook that produces it.

## 2. Deferred code changes

### 2.1 Still open

- **mupdf page rendering still runs on the host thread.** `src/knowledge/ocr.ts`
  renders PDF pages through mupdf's synchronous WASM build, which holds the event
  loop for the duration of a page. The fix is to move the render into the OCR worker
  thread, where mupdf state is per-thread. It was not done here because the obvious
  in-place workaround is unsafe: yielding between pages with `setImmediate` was
  measured to crash the process (2 of 6 runs of `tests/ocr.spec.ts` died with an
  access violation, 0xC0000005; 6 of 6 passed without the yield, twice). The render
  is now bounded by the 15-minute OCR budget and a cumulative raster cap, so the
  worst case is a stall of bounded size rather than an unbounded one.

### 2.2 Closed in 0.4.1

Kept here with the original reasoning, because the reasoning is what shows whether a
fix actually addressed the defect.

- **`rawTextLimit` is not clamped.** `readIntQuery` in `src/knowledge/http.ts`
  accepts any finite integer, so a negative value reaches
  `rawText.slice(0, rawTextLimit)` in `getDocument` and silently drops the tail
  instead of capping the payload, and a huge value simply returns everything.
  Clamping needs a decision about the maximum a caller may request.
  **Fixed in PR #27:** the route now clamps the value.
- **`stats()` for a missing base returns zeros.** `src/knowledge/index.ts`
  (`stats(baseId?)`) filters bases rather than asserting existence, so
  `GET /knowledge/stats?baseId=<unknown>` answers with a plausible-looking empty
  summary. Answering 404 would be a contract change.
  **Fixed in PR #27:** an unknown base now answers 404.
- **`windowBlock` can emit an empty chunk.** In `src/knowledge/chunk.ts`,
  `cut = Math.max(findCut(...), start + 1)` may land one character past a run of
  whitespace, and `.trim()` then yields `''`. Identified by inspection; no
  reproduction, and no observed empty chunk in stored data. A fix should filter at
  the call site rather than in the windowing loop.
  **Fixed in PR #28:** empty chunks are filtered.
- **`src/knowledge/context.ts` is bundled twice.** `src/tool-knowledge/index.ts`
  imports values (`estimateContextTokens`, `serializeContextWindow`) from it, so it
  is inlined into both `lib/knowledge/index.js` and `lib/tool-knowledge/index.js`.
  Measured on the built output. `context.ts` imports types only and holds no state,
  so today this costs bundle size and nothing else — but the same import pattern
  would silently duplicate module state for a stateful helper, so it is worth a
  shared chunk (or a small `context-protocol` module) before the next helper lands
  there.
  **Fixed in PR #28:** the shared part moved to `src/knowledge/context-protocol.ts`.
- **`scripts/stress-auto-retrieve.mts` is outside the typecheck.**
  `tsconfig.json` includes `src` and `tests` only, so the one stress script that
  drives retrieval through the model tools is not covered by `tsc --noEmit`.
  **Fixed in PR #28:** the script is inside the typecheck.
- **Not in the original list, fixed at the same time (PR #29):** the retrieval
  benchmark used the developer's real `DSH_HOME`; it now runs against a throwaway
  one.

## 3. Corrections to the audit

These notes were raised during the audit and did not survive re-inspection. They are
recorded so they are not re-raised as findings.

- **MinerU envelope/abort/zip handling.** `src/knowledge/mineru.ts` checks the poll
  envelope (`result.code !== 0`), threads an `AbortSignal` through every fetch and
  re-checks it between polls, validates the result zip for a non-asset `.md` entry,
  and rejects empty markdown. No deferred item remains there.
- **"`lib/client.js` inlines `src/knowledge/context.ts`."** It does not: the client
  bundle contains no copy of `estimateContextTokens`. The duplication is between the
  two host bundles (see section 2).
- **Legacy duplicate directory trees are not cleaned up.** This is not a deferred
  defect: issue #20's report is explicit that the correct behaviour is to report
  `ambiguous_source` and let the user remove the redundant tree, never to guess,
  merge, or delete it. The delete-impact preview and the `recursive` gate were added
  so that doing so is safe.
