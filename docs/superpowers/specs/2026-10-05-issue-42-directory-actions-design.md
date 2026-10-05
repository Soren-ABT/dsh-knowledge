# Issue #42: local model directory actions across DSH versions

## Problem and scope

DSH 0.2.0-rc.2 exposes `workspaces` as a workspace controller without the
legacy `pickDirectory` and `openPath` methods. The Local Models settings slot
passed that object directly to its cache buttons and MinerU directory picker.
Checking only whether the object existed allowed both reported TypeErrors.

Restore the existing cache Browse/Open and MinerU directory selection actions.
Keep manual inputs usable when a host does not provide a directory capability.
No package-version change, database migration, model migration or download is
needed for this fix.

## Verified host contracts

The DSH compatibility source is the `dsh-v0.2.0-rc.2` tag:

- Desktop selection prefers `globalThis.__DSH_DIRECTORY_PICKER__.pick()`,
  preserving the native dialog's owning window; otherwise use
  `uiWorkspace.pickDirectory()`.
- Opening uses `remote.session.openWorkspacePath({ path })`, returning a direct
  `RemoteResult<{ opened: true }>` envelope. The corresponding
  `canOpenWorkspacePath()` returns `RemoteResult<boolean>`.
- The host opener expects an absolute path and does not expand `~`.
- Older clients retain `workspaces.pickDirectory()` and
  `workspaces.openPath(path)`. Missing Cordis services return `undefined`.

Sources: [desktop picker](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/desktop/src/directory-picker.ts),
[UI picker](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-workspace/src/client/navigation.ts),
[UI opener](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-open-in-app/src/client/open-path.ts),
[session controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/api/session-controller/src/index.ts).

## Implementation

A small `DirectoryActions` adapter resolves the current services when the
settings slot supplies props. Picker preference is desktop bridge, UI workspace,
then legacy workspace. Opener preference is remote session, then legacy
workspace. Picker and opener availability are independent. Bind each method to
its service so Cordis proxy receivers remain correct. Unwrap and validate remote
results; preserve actual errors without retrying another interface.

Cache Browse changes the draft input only. Cancellation retains its value.
Cache Open checks capability first, then asks
`POST /knowledge/local-models/cache-directory` to prepare the input path. The
backend trims it, expands a home prefix, resolves an absolute path and creates
the directory if absent. Blank input uses the actual effective cache directory,
including deployment/runtime configuration and `DSH_HOME`. This explicit action
does not persist configuration, migrate models or start downloads. GET/list
requests do not create directories. Non-string HTTP paths return
`400 invalid_request`; filesystem errors reach the existing visible error area.

Missing cache capabilities show bilingual notices. MinerU receives only a
verified picker and hides its Browse buttons without one; both installation
inputs remain manually editable.

## Validation and limits

Windows / Node 24.16.0 local results:

- Focused service, adapter and button regression suite: 98 tests passed.
- Full suite: 41 files, 529 tests passed.
- Typecheck, build (through benchmark), workspace policy and package verification
  passed.
- Retrieval benchmark: primary and multi-query Hit@1/Hit@3/Recall@3 and visible
  evidence stayed at 100%; no order or budget errors.
- Production audit policy passed with the two existing, time-limited `sharp`
  exceptions; this fix changes no dependencies.

The adapter tests exercise DSH 0.2 and legacy service contracts, receiver binding,
capability absence, cancellation and failures. Button tests execute production
TSX callbacks through an existing esbuild/vm hook harness without new React/DOM
dependencies. Real HTTP/client tests create and resolve temporary directories,
verify home expansion and malformed input, and confirm configuration/model files
remain unchanged.

These tests do not certify an actual DSH 0.2 desktop native dialog or file-manager
launch. Cross-platform and Node matrix validation belongs to the existing CI;
its results must be checked on the fix commit before claiming those passes.
