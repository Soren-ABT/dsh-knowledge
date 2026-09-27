# Implementation checklist

- [x] Audit current entry points, storage, context pipeline, and official MinerU 4 API.
- [x] Confirm local/self-hosted preference and both implementation phases.
- [x] Record the approved design and isolate work on a feature branch.
- [x] Add public processing/provenance contracts and additive configuration.
- [x] Implement self-hosted V1 protocol, normalization, artifacts, and offline protocol tests.
- [x] Implement source-aware/structure-aware chunking, context propagation, and SQLite persistence.
- [x] Unify import/sync/rebuild paths and implement artifact reuse, cancellation, and recovery.
- [x] Add configuration/diagnostics and evidence navigation UI plus tool contracts (browser acceptance pending).
- [x] Add deterministic structured-evidence test command, opt-in synthetic-PDF smoke, and operating documentation.
- [ ] Complete real Basic/Standard inference and representative scanned/multi-column/table PDF gold-set evaluation.
- [x] Run available local type/test/build/benchmark/package gates, review the integrated diff, and commit reviewable units.
- [x] Report separately the real-service, browser, packed-host and cross-platform gates not executed locally.

Ownership: provider adapter and normalized output; structural chunk/storage/context
pipeline; UI/config/tool presentation; root service orchestration and integration.
Agents do not commit or edit other owners' files. Root runs integration gates.

## 2026-09-27 checkpoint

The implementation is on `feat/mineru-structured-evidence`; version stays 0.4.1.
No cloud upload, Python/model installation, remote push, tag or publication was performed.

Verified locally: TypeScript, 393 tests across 31 files, the existing 40-question
retrieval benchmark, build, release metadata and npm tarball verification.
The SQLite integration test covers upload/path parity, source-span propagation,
rechunk without another POST, explicit reparse, and stale revision rejection.
The protocol/structure suite is not a real OCR-quality benchmark.

Still required before release: configured MinerU real inference, representative
PDF gold cases, actual browser acceptance, Windows/Linux packed-host smoke and
cross-platform CI. No `dsh` executable was found on this session's PATH; no
MinerU endpoint has been supplied for real inference.
