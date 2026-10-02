# MinerU structured evidence integration

Status: approved by the maintainer on 2026-09-24 (both phases).
Baseline: dsh-knowledge 0.4.1, commit 88af2a3.

## Product boundary

Keep the existing SQLite retrieval, embedding/rerank isolation, context budgets,
and model-facing tools. Add an optional, independently deployed MinerU 4 V1
processor. Preserve the existing `builtin` and MinerU cloud v4 configurations.
Never fail over from a local processor to a cloud processor implicitly. Do not
install Python, inference engines, or model weights as part of the npm package.
No version bump, npm publishing, tag, or main-branch push is part of this work.

## Deliverables

1. One document-processing entry point for uploads, live paths, directory import
   and sync, reparse, and recovery. Report the processor actually used, warnings,
   completeness, and reuse of old evidence. Local-only fallback stays local.
2. A MinerU 4.0.6 V1 adapter with health/capability discovery, optional bearer
   authentication, upload/create/poll/cancel/download, one total deadline,
   bounded output sizes, archive validation, and strict response checks.
3. A versioned ParsedDocument model containing canonical text and explicit block
   ranges, source hashes, processor provenance, page indices, optional block
   geometry, and bounded assets. Keep upstream artifacts independently of the
   text projection. Do not infer page locations through fuzzy string matching.
4. Source spans travel through chunk refinement, SQLite, vector caches, search,
   each context excerpt, and tool schemas. Offsets are UTF-16 text offsets, never
   original PDF byte offsets. Bboxes describe blocks, not individual glyphs.
5. Structure-aware chunking for opted-in structured documents: preserve table
   headers and rows, formula units and captions, with bounded continuation for
   oversized units. Ordinary text chunking and Issue #6 behavior remain unchanged.
6. Distinct synchronization, reparse, and rechunk operations. Parsing artifacts
   can be reused for rechunking without another MinerU submission. Preserve the
   existing raw source and old usable evidence when a replacement fails.
7. Immutable artifact generations, SQLite staging and a replayable local commit
   journal. SQLite plus DomainKV is NOT a distributed transaction: publish
   chunks and a recovery record together, then reconcile document metadata.
   Never expose a new chunk with an old revision's source locations.
8. Configuration and evidence UI: explicit local/cloud choice, connection check,
   progress/cancel, actual processor and completeness, PDF page navigation,
   block geometry/asset inspection when available, and reparse/rechunk controls.
9. Offline fixtures plus real-service smoke and PDF gold cases. Test protocol
   behavior separately from OCR quality. Preserve the old 40-question regression
   baseline; new evidence tests must preserve mathematical signs, numeric units,
   table cell relationships, and per-excerpt citation provenance.

## Storage and recovery

Artifacts are scoped by base/document and immutable revision; manifests contain
hashes and relative asset references, never credentials. Archives may not escape
their output directory. Untrusted HTML is not injected as active markup; remote
image references are not fetched automatically. Limits apply to response bytes,
archive members, expanded bytes, block count, and individual fields.

An interrupted download stays a candidate, not a ready artifact. New chunks are
staged until the full generation is ready. A local commit record holds enough
information to finish a DomainKV update without calling MinerU again. Garbage
collection protects live and pending generations. Legacy documents/chunks with
no provenance remain readable with unknown source locations and are not
automatically reparsed or re-embedded. Schema additions must be additive.

Upstream V1 job IDs are process-memory state and may disappear on a service
restart. Resume polling only a known surviving job. A lost job is reported as
such; an ambiguous POST is not blindly retried. A bounded explicit retry may
create a replacement job. Cancellation is best effort on the remote service;
canceling locally does not imply remote billing stopped.

## Verification and release boundary

Run typecheck, all Vitest tests, old retrieval benchmark, structured-evidence
benchmark, build, package/release verification, and offline packed smoke where
available. Add a separately invoked real MinerU smoke; never download models or
send private files during routine CI. Real Basic/Standard inference requires a
configured service and approved fixture documents. If no service is available,
report that gate unverified rather than claiming model-quality validation.

Validate crashes before artifact promotion, during staging, after SQLite commit,
and after DomainKV update. Validate local/cloud privacy, cross-origin credential
isolation, unknown schema rejection, unsafe archives, missing pages, stale
anchors, deleted documents, and directory entry-point parity.

## Upstream compatibility

- https://github.com/opendatalab/MinerU/releases/tag/mineru-4.0.6-released
- https://opendatalab.github.io/MinerU/usage/http_api/
- https://opendatalab.github.io/MinerU/reference/output_files/
- https://opendatalab.github.io/MinerU/usage/tiers/
- https://github.com/opendatalab/MinerU/blob/mineru-4.0.6-released/LICENSE.md

MinerU 4.0.6 has Apache-2.0-based terms with additional conditions. Keep explicit
MinerU attribution and link its license. Model/runtime licenses are separate.
The plugin does not copy or redistribute the Python engine or model weights.

## Non-goals

No second Doclib vector database, automatic cloud fallback, implicit caption LLM
calls, global Python/CUDA installation, universal model-quality claims, automatic
reprocessing of old libraries, or changes to unrelated embedding-space policies.
