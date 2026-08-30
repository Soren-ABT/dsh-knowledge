# Packed-Smoke Uninstall Lifecycle Design

## Problem

The packed-install smoke successfully packs and installs `dsh-knowledge`, boots
DSH, and verifies `GET /knowledge/bases` on Ubuntu. Its final uninstall command
also mutates the profile correctly: pnpm reports completion and removes the
dependency. The `dsh plugin remove` process can nevertheless remain alive on
Linux until the smoke's ten-minute `spawnSync` timeout expires. This turns a
successful plugin smoke into a failed CI run and hides the already-proven
installation and runtime result behind a process-lifecycle failure.

The smoke must continue to detect an uninstall that did not remove the package
dependency. It must not treat a timeout alone as proof that the plugin failed.

A later Ubuntu run exposed a second lifecycle state in the pinned public DSH
CLI. `pnpm remove` can remove `dependencies.dsh-knowledge`, after which the DSH
process hangs before its post-command reconciliation removes `dsh-knowledge`
from `dsh.profile.bundles`. This is a partial upstream cleanup, not an install,
boot, route, or package-removal failure in this plugin.

## Scope

This change is limited to `scripts/smoke-packed-install.mjs`,
`scripts/smoke-packed-lifecycle.mjs`, and their automated tests. It does not
change production plugin behavior, DSH itself, package versions, tags, or npm
publishing. Issue #6 and the reverted `src/knowledge/chunk.ts` experiment remain
outside this change.

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
- fail immediately on a spawn error because no uninstall attempt was proven;
- fail on a non-zero normal exit, even if partial mutations occurred;
- fail if a zero exit leaves `dsh.profile.bundles` inconsistent, because the CLI
  claimed success without completing its contract;
- pass on exit code zero when both manifest checks are clean;
- pass with a clear warning on timeout only when both manifest checks are clean;
- in the default plugin smoke, pass with a distinct warning when a timeout
  removed the package dependency but left only the bundle-stack entry;
- in strict uninstall mode, fail that same partial-reconciliation state.

The default mode deliberately treats the package dependency as the plugin-owned
uninstall boundary. The stale bundle entry is still surfaced, never silently
accepted: GitHub Actions receives a native warning annotation and local runs
receive the same concise warning on stderr. The temporary smoke profile is
deleted in `finally`, so the known upstream state cannot contaminate a real
profile or later job.

Strict mode is enabled with `DSH_SMOKE_STRICT_UNINSTALL=1`. It preserves the
original requirement that dependency and bundle-stack cleanup must both finish,
and is intended for manual compatibility validation and future DSH releases.
No other value enables strict mode, keeping the CI contract deterministic.

This policy does not manually rewrite the manifest after a timeout. Doing so
would hide the exact DSH state under test and would make the smoke validate its
own repair rather than the public CLI.

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
- timeout with the dependency retained (failure in every mode);
- timeout with only the bundle entry retained (warning in default mode, failure
  in strict mode);
- zero exit with the bundle entry retained (failure in every mode);
- warning formatting for GitHub Actions without leaking multiline output;
- process-tree termination is requested once and the grace deadline is bounded;
- the normal packed install and HTTP readiness path remains unchanged.

## CI and delivery

Run typecheck, the full Vitest suite, build, retrieval benchmark, production
audit, workspace-policy verification, and package verification. The existing
Windows packed smoke remains a platform check; the next GitHub push is the
authoritative Ubuntu validation.

The fix is committed separately from Issues #6 and #7. It may be pushed after
local quality gates pass. npm publishing remains blocked until the corrected
regular CI and the manually triggered Ubuntu local-rerank smoke both pass.

## Alternatives considered

Making uninstall non-blocking as a separate CI job would separate ownership
visually, but adds workflow complexity and weakens local parity. Removing the
bundle check entirely would be simpler, but would conceal a useful upstream
compatibility signal. The selected state classifier keeps one portable smoke,
retains strict mode, and changes only the known timeout-plus-partial-reconcile
case from an error to a visible warning.
