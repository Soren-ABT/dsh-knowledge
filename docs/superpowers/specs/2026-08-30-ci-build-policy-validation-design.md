# CI build-policy validation design

## Problem

The first clean GitHub Actions run for the 0.3.6 release hardening failed in
all seven matrix jobs before type checking or tests. A clean pnpm 11.7.0
installation reproduced `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.25.12`.
The repository's `pnpm-workspace.yaml` left `allowBuilds.esbuild` as the string
`set this to true or false` instead of an explicit boolean. Existing local
`node_modules` concealed the error.

## Goals

- Approve the required esbuild install script explicitly.
- Detect non-boolean or missing decisions before dependency installation.
- Use the same policy in CI and the local release gate.
- Keep CI stable across frequent releases: publishing cadence may trigger more
  runs, but it must not require recurring CI repairs when source and pinned
  inputs have not changed.
- Preserve the existing pinned pnpm version, DSH compatibility commit, frozen
  lockfile, and operating-system matrix.

## Design

Change `allowBuilds.esbuild` to `true`. Add a zero-dependency Node.js verifier
that reads `pnpm-workspace.yaml` before package installation. It will accept
only boolean values in the `allowBuilds` mapping and require explicit entries
for esbuild, onnxruntime-node, protobufjs, sharp, and tesseract.js. The expected
decisions are esbuild, onnxruntime-node, protobufjs, and sharp enabled, with
tesseract.js disabled.

The verifier will expose a self-test mode with accepted and rejected fixtures,
so its parser and policy can be checked without npm dependencies. Add npm
scripts for the policy check and self-test. Every CI job will run the verifier
immediately after checkout and before plugin dependency installation. The
maintainer's `release:check` command will run both the self-test and live policy
check before its existing security, type, test, benchmark, build, and package
checks.

The CI workflow will not rewrite `pnpm-workspace.yaml` or bypass pnpm's build
policy. The committed repository configuration remains the single source of
truth.

## Verification

1. Run the verifier self-test and live repository check.
2. Clone the plugin into a clean sibling directory with no `node_modules` and
   run `pnpm@11.7.0 install --frozen-lockfile`.
3. Run the complete `npm run release:check` gate from a clean tracked tree.
4. Commit and push the implementation, then observe every GitHub Actions matrix
   job until the workflow reaches a terminal state.

No npm publication, Git tag, or GitHub Release is part of this change.
