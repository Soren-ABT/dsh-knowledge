# Managed MinerU implementation

Approved scope: optional isolated deployment, selectable storage, capacity and
verified reuse information, matching-theme UI, small additive knowledge UI fixes.
No automatic model installation during development, push or publication.

- [x] Inspect existing storage/model UI and fixed upstream 4.0.6 contracts.
- [x] Add pinned Basic model manifest, byte accounting and safe path checks.
- [x] Add loopback-only management protection (the host has no built-in auth).
- [ ] Implement durable serialized preparation, independent cancellation and recovery.
  - Background tasks, exclusive locks, persisted phases and restart discovery implemented.
  - Hard-crash lock reconciliation stays manual until descendant ownership is provable.
- [ ] Implement isolated Python environment, model download, verification and real probe.
  - Basic pipeline implemented with explicitly selected eligible CPython 3.10–3.14, pinned files, resumable download,
    isolated venv and synthetic probe. Real model execution is not yet validated.
- [ ] Add service ownership, start/stop and safe external model reuse.
  - Owned service control and verified external copies implemented; fake-process tests pass.
- [ ] Integrate bilingual model settings and installation plan UI.
  - Confirmation, prepare/cancel/start/stop/global-use actions and non-overlapping status
    polling wired. Managed Standard, filters, uninstall and browser acceptance remain.
- [ ] Refine document progress/evidence interactions without removing functions.
  - Evidence previous/retry navigation and revision-scoped cursor reset implemented.
- [ ] Test lifecycle and security with fixtures; run type/test/build/package gates.
- [ ] Real install/inference and browser verification, only report actually run gates.

2026-09-27 checkpoint: 425 tests / 34 files pass; no real Python environment or
MinerU model was installed while developing. Preparation remains explicitly experimental.

The optional writing-plans skill is not installed; this checklist follows the
approved design directly. Frontend and React skills apply when editing the UI.

Security finding: DSH webserver explicitly supplies no auth/origin policy. New
installer routes must fail closed when the host is network-bound, reject remote
peers and non-loopback Host values, and require a same-origin management header.
Existing parsing/external-service workflows remain independent. Electron IPC
without a provable loopback carrier must not silently gain installer privileges.
