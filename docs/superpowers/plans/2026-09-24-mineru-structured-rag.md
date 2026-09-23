# Implementation checklist

- [x] Audit current entry points, storage, context pipeline, and official MinerU 4 API.
- [x] Confirm local/self-hosted preference and both implementation phases.
- [x] Record the approved design and isolate work on a feature branch.
- [ ] Add public processing/provenance contracts and additive configuration.
- [ ] Implement strict self-hosted V1 protocol, normalization, safe artifacts, and offline tests.
- [ ] Implement source-aware/structure-aware chunking, context propagation, and SQLite persistence.
- [ ] Unify import/sync/rebuild paths and implement artifact reuse, cancellation, and recovery.
- [ ] Add configuration/diagnostics and evidence navigation UI plus tool contracts.
- [ ] Add structured-evidence benchmark, real-service smoke, and operating documentation.
- [ ] Run full local gates, review the integrated diff, and commit reviewable units.
- [ ] Report separately any real-service or cross-platform gates not executable locally.

Ownership: provider adapter and normalized output; structural chunk/storage/context
pipeline; UI/config/tool presentation; root service orchestration and integration.
Agents do not commit or edit other owners' files. Root runs integration gates.
