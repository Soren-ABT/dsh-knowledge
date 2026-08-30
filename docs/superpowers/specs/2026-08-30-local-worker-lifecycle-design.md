# Local embedding worker lifecycle fix

## Goal

Release dsh-knowledge 0.3.5 with a durable fix for GitHub issue #5. Local embedding models must be unloadable after an idle period without terminating and recreating the worker thread, because reloading `onnxruntime-node` in a second worker isolate can fail on Linux with `Module did not self-register`.

## Scope

The patch covers the local embedding worker lifecycle, its global idle-timeout setting, user-facing load errors, regression coverage, versioning, and release. It does not replace worker threads with child processes, change OCR worker behavior, or automatically close issue #5.

## Design

### Worker lifecycle

The host owns one lazy local-embedding worker. When the configured idle timeout expires and no request is pending, the host sends `release-models`. The worker disposes every loaded embedding and reranking runner, clears its runner cache, acknowledges completion, and remains alive. The next request reloads the model from disk in the same worker, so the native binding is loaded only once in the host process.

The worker exits only during plugin teardown or an unrecoverable worker failure. Teardown continues to await termination so native file handles do not outlive the plugin.

Model release and the next model operation must be serialized. A request arriving immediately after the idle timer fires waits for release completion before it creates or uses a runner.

### Configuration

`localWorkerIdleTimeoutMs` is a global worker setting. It remains part of deployment and global runtime configuration but is removed from per-base configuration, durable per-base schemas, and the per-base RAG panel.

The global Local Models settings page exposes the value and saves it through the global `setConfig` API. A value of `0` cancels the idle timer and keeps loaded models hot. A positive value starts or restarts the timer immediately when a worker exists, including changes from one positive value to another. Values are clamped to 0 through 24 hours.

### Errors

Local embedding failures inspect the configured model cache. Missing model files retain the download guidance. When files are present, the error reports a runtime startup failure and suggests restarting the service or checking the local-model runtime instead of downloading the model again.

### Tests

Automated coverage will verify:

- default, zero, and clamped global idle-timeout resolution;
- the setting is stored and applied through global configuration, not per-base configuration;
- changing a positive timeout rearms an existing timer and setting zero cancels it;
- `embed -> release-models -> embed` uses one worker lifecycle and does not overlap model disposal with reload;
- missing-model and runtime-failure error messages remain distinct;
- generated host and worker bundles contain the release protocol.

The full TypeScript check, Vitest suite, production build, and package-content inspection must pass. Because the reported native-loader failure is Linux-specific, the pushed revision must also receive a Linux verification signal before npm publication when repository CI provides one; otherwise the built worker reproduction is run on an available Linux host before the issue is closed.

## Git and release flow

Fetch the current remote `main`, rebase the local fix and design commits onto it, and resolve only conflicts within this change. Update the package and lockfile to 0.3.5 and add a concise changelog entry. Build and inspect the publish tarball before committing the implementation.

After all checks pass, push `main`, verify the remote commit, and publish `dsh-knowledge@0.3.5` to npm. If GitHub or npm authentication, two-factor authentication, or a failing external check blocks the release, stop at that boundary and request user action. Do not close issue #5 automatically; publication and reporter verification are separate from shipping the fix.

## Acceptance criteria

- Idle release never terminates a healthy embedding worker.
- Model memory is released through runner disposal and later requests reload on the same worker.
- The idle timeout is globally configurable and the UI control changes the live worker timer.
- Runtime binding failures never instruct users to redownload intact model files.
- Type checking, tests, build, and package inspection pass from a clean worktree.
- GitHub `main` and npm contain version 0.3.5 after authorized publication.
