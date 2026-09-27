# Optional managed MinerU deployment and UI refinement

Status: design draft for maintainer review. This extends the approved service
adapter; it does not mean managed installation is implemented or validated.

## Scope and direction

Use an optional plugin-managed, isolated runtime. Keep cloud API and external
self-hosted service modes. Never install Python/models during npm installation
or silently switch a local processing request to a cloud service. Match existing
theme tokens, spacing, typography and rounded cards; no visual rebrand.

Alternatives considered: model-download-only leaves installation to users;
Docker-only introduces an extra prerequisite for desktop users. The default
design is an isolated environment with explicit user-initiated preparation.
External services remain the escape hatch for unsupported platforms/backends.

## Runtime ownership

- Installation occurs on the DSH host, not necessarily the browser computer.
- A managed installation has its own runtime, environment, model, staging and
  sanitized log directories under a user-selected absolute root.
- Reuse a compatible Python interpreter only through an isolated environment;
  do not pip-install into the user's global/Conda environment or modify CUDA.
- If no compatible interpreter exists, offer explicit preparation of a pinned
  managed Python distribution; show source, version and disk plan first.
- Pin the MinerU adapter/runtime compatibility manifest. Never install a moving
  latest version or execute arbitrary commands supplied by the browser.
- Use executable plus argument arrays without a shell. Validate paths and reject
  symlink/junction escapes for owned-directory writes/deletion.
- Managed commands require the host's management authorization. Browser-origin
  checks/CSRF protection and server-side allowlists must precede installer routes.
  Do not expose an unauthenticated arbitrary execution surface.
- Only listen on loopback for a managed service, using supported authentication
  where available. Track owned child processes/generations; never kill a process
  solely because it occupies the desired port. Report port conflicts.
- Shutdown is bounded and refuses destructive model operations while in use.
  Starting/stopping local service does not rewrite cloud configuration silently.

## Models and capacity

- Existing Qwen3 Embedding, BGE, E5, GTE and reranker weights are not MinerU models.
  Node inference packages are not a replacement for Python runtime dependencies.
- Offer Basic (initial low-complexity CPU/ONNX path) and optional Standard after
  compatibility checks. Advanced shares Standard resources; no duplicate card
  offering an independent Advanced model download.
- Reuse only files with matching model revision, format, backend and successful
  validation. Torch/ONNX/GGUF variants are not interchangeable. Basic-to-Standard
  reuse is conditional on the selected manifest, not universally guaranteed.
- External model directories are read/verify-only inputs. Never delete, migrate,
  upgrade or write markers into them without separate explicit authorization.
  If upstream requires writable metadata, retain that metadata in owned storage.
- Display download bytes, verified reusable bytes, remaining transfer bytes,
  installed footprint, peak installation space and free target space separately.
  Deduplicate shared files by identity; account for copies versus shared storage.
- Keep runtime downloads separate from model downloads. Memory/VRAM requirements
  are separate hardware guidance and never inferred from file download sizes.
- Size metadata is keyed by pinned revision and backend. Show its source and
  freshness. Unknown sizes remain unknown; estimated sizes carry an estimate
  label. Detect insufficient disk space both before and during preparation.
- Use upstream download/verify facilities where reliable, rather than duplicate
  model internals. Validate manifests and sources. Mirror selection is explicit;
  never transfer credentials between unrelated origins.
- Download-only is available once the runtime is prepared. A separate prepare
  action orchestrates environment, models, validation and synthetic parse probe.

## Durable operations and cancellation

Persist operation ID, installation ID, phase, resource manifest and safe error
code; never secrets, queries or user-document contents. One mutating operation
per installation, guarded across processes. Double clicks reuse/reject the same
operation, not spawn duplicate installers. UI navigation does not cancel work.

Installation states: absent -> inspecting -> preparing_environment -> downloading
-> validating_files -> probing -> ready; errors identify the failed phase.
Service states are separate: stopped, starting, running, stopping, error.
A completed download is not ready until validation and a synthetic parse pass.

Cancel the owned task/process tree with bounded cleanup, retain verified files
and resumable parts; a separate explicit cleanup action removes owned incomplete
data. Unknown installer completion requires reconciliation, not blind rerun.
Partial installations never replace an existing verified runtime. Versioned
environment promotion preserves the previous working version for rollback.

## UI and interaction contract

- Keep the existing local-model section and add purpose filters: embedding,
  reranking, document parsing. Do not imply every model is required.
- A MinerU overview card shows managed/external ownership, service state and
  whether document bytes remain on this machine or go to another server.
- Basic/Standard cards show supported use cases, backend, capacity breakdown,
  runtime requirements and readiness. Unknown hardware is not marked supported.
- Primary actions follow state: inspect plan, confirm preparation, cancel,
  retry failed phase, validate, start or stop. Mutually conflicting operations
  are disabled with a visible reason, without freezing unrelated model cards.
- Before installation show exact root, selected sources, runtime/model versions,
  applicable license notices, space plan and explicitly accepted action scope.
- Progress uses real completed/total bytes when available; otherwise a phase
  indicator. Never derive artificial percent from time. Rate/ETA only when
  reliable; changing backends invalidates the old capacity plan.
- Announce transitions through aria-live; semantic buttons, focus indicators,
  keyboard/Escape dialogs, correct focus restoration, readable contrast, narrow
  viewport handling, light/dark support and reduced-motion behavior.
- Document reparse progress distinguishes parsing from indexing and publication.
  Prior published evidence remains usable until atomic generation publication.
- Retry messages explain what is preserved. Uninstall lists owned paths and
  shared references and never removes documents, embedding models or externals.

## Validation gates

Test manifest sizes/deduplication/unknown values, path and process ownership,
command injection, authorization/CSRF, insufficient space, concurrent requests,
failed dependencies, network interruption, cancel at each phase, restart recovery,
external-cache protection, checksum failures, probe failures and rollback.

Component/browser tests cover double click, disabled explanations, dialogs and
focus, refresh/reconnect, progress, error recovery, dark mode and small viewports.
Run actual Basic install/parse on an isolated supported environment before calling
it one-click supported. Standard requires separate runtime and real inference
qualification. Do not generalize one machine's success to all three OSes.
Routine CI uses fixtures and fake processes, never implicit model downloads.

## Preview and current limits

Preview: `mineru-deploy-v1/content/mineru-manager-v1.html` under the Codex
visualization directory. All capacities, paths, hardware and progress are labeled
examples. Buttons only change preview state. No install/download/API requests.
Browser automation inventory failed in this session (`nodeRepl.fetch request
failed`), so automatic rendering and click acceptance are not claimed.

Implementation remains pending review. No version bump, push or release is part
of this design task. Real package and model sizes must be resolved against the
selected pinned manifest before production cards display numeric claims.
