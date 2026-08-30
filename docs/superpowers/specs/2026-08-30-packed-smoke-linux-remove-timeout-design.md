# Linux Packed-Smoke Uninstall Timeout Design

## Problem

The packed-install smoke successfully packs and installs `dsh-knowledge`, boots
DSH, and verifies `GET /knowledge/bases` on Ubuntu. Its final uninstall command
also mutates the profile correctly: pnpm reports completion and removes the
dependency. The `dsh plugin remove` process can nevertheless remain alive on
Linux until the smoke's ten-minute `spawnSync` timeout expires. This turns a
successful plugin smoke into a failed CI run and hides the already-proven
installation and runtime result behind a process-lifecycle failure.

The smoke must continue to detect an uninstall that did not change the profile.
It must not treat a timeout alone as proof that uninstall failed.

## Scope

This change is limited to `scripts/smoke-packed-install.mjs` and its automated
tests. It does not change production plugin behavior, DSH itself, package
versions, tags, or npm publishing. Issue #6 and the uncommitted
`src/knowledge/chunk.ts` experiment remain outside this change.

## Design

### Supervised command execution

Keep the existing synchronous helper for short, deterministic setup commands.
Add an asynchronous supervised runner for the uninstall round trip. The runner:

1. spawns the DSH command without a shell on POSIX and with the existing Windows
   shim handling;
2. inherits output so CI retains pnpm and DSH diagnostics;
3. resolves with an explicit `exited`, `timed_out`, or `spawn_error` outcome;
4. uses a short uninstall deadline instead of the current ten-minute ceiling;
5. terminates the full process tree on timeout and waits a bounded interval for
   exit before continuing.

On Windows the existing `taskkill /T /F` process-tree mechanism is reused. On
POSIX the command is launched as its own process group and the group receives
`SIGTERM`, followed by `SIGKILL` only if it does not exit within the grace
period. Cleanup is idempotent and never targets a PID that the runner did not
spawn.

### State-based uninstall verdict

After the uninstall process exits or is forcibly reclaimed, the smoke reads the
profile manifest and applies the authoritative verdict:

- fail if `dependencies.dsh-knowledge` still exists;
- fail if `dsh.profile.bundles` still contains `dsh-knowledge`;
- fail immediately on a spawn error because no uninstall attempt was proven;
- fail on a non-zero normal exit, even if partial mutations occurred;
- pass on exit code zero when both manifest checks are clean;
- pass with a clear warning on timeout only when both manifest checks are clean.

The timeout warning names the command-lifecycle anomaly and states that the
on-disk uninstall result was verified. This prevents a false green when pnpm or
DSH never removed the plugin while keeping an already-correct removal from
failing the plugin's CI solely because the parent CLI did not terminate.

### Test seam

Extract the supervised runner and uninstall-verdict logic into exported,
side-effect-free or dependency-injected helpers in the smoke script (or a small
adjacent helper module if required). Guard the script entry point so importing
it in Vitest does not execute the smoke.

Automated tests cover:

- clean zero exit;
- non-zero exit;
- spawn failure;
- timeout with dependency and bundle removed (warning/pass);
- timeout with either manifest entry retained (failure);
- process-tree termination is requested once and the grace deadline is bounded;
- the normal packed install and HTTP readiness path remains unchanged.

## CI and delivery

Run typecheck, the full Vitest suite, build, retrieval benchmark, production
audit, workspace-policy verification, and package verification. The existing
Windows packed smoke remains a platform check; the next GitHub push is the
authoritative Ubuntu validation.

The fix is committed separately from Issue #6. It may be pushed after local
quality gates pass. npm publishing remains blocked until the corrected regular
CI and the manually triggered Ubuntu local-rerank smoke both pass.
