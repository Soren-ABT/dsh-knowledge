# dsh-knowledge 0.3.6 Release Hardening Design

Date: 2026-08-30

## Objective

Prepare `dsh-knowledge` 0.3.6 as a release-ready, better-governed open-source
plugin without publishing it, tagging it, creating a GitHub Release, replying
to an issue, or closing an issue. The work covers six outcomes:

1. an explicit, machine-enforced decision for the current production
   dependency advisory;
2. continuous integration across the supported Node and operating-system
   boundaries;
3. a packed-tarball smoke test through the official DSH plugin installation
   path;
4. versioned release notes and a repeatable local release preflight;
5. minimal contributor, security, issue, and pull-request governance; and
6. a deterministic public retrieval benchmark with committed baselines.

This work deliberately pauses feature expansion. Its purpose is to make the
existing feature set easier to trust, reproduce, review, and release.

## Authorization Boundary

The implementation may edit, test, build, pack, commit, and push only when the
user separately requests the corresponding Git operation. This design does
not authorize any of the following external effects:

- publishing `dsh-knowledge@0.3.6` to npm;
- creating or pushing a `v0.3.6` tag;
- creating a GitHub Release;
- posting to or closing GitHub issue #5; or
- enabling npm Trusted Publishing.

The repository will instead contain copy-ready release notes and an issue
reply. The maintainer remains the final publisher and responder.

## Security Audit Policy

### Current advisory

`pnpm audit --prod` reports `GHSA-f88m-g3jw-g9cj` through this dependency
path:

```text
dsh-knowledge -> @huggingface/transformers@3.7.0 -> sharp@0.34.1
```

The advisory affects libvips inherited by `sharp` versions below 0.35.0.
Transformers 3.x constrains `sharp` to `^0.34.x`; even the current
Transformers 4.x line still constrains it below 0.35. A package-local pnpm or
npm override would only affect this repository as the dependency root and
would not reliably propagate into a user's DSH profile. It would therefore
create a misleading green audit without fixing the installed plugin.

### Decision

Keep the proven `@huggingface/transformers@3.7.0` and
`onnxruntime-node@1.21.0` runtime pair for 0.3.6 and record a narrow,
time-bounded exception for exactly `GHSA-f88m-g3jw-g9cj`.

The reachability argument is specific rather than generic: the plugin's
Transformers worker invokes text feature-extraction and text-classification
pipelines for embedding and reranking. User-controlled document images are
handled by the PDF/OCR pipeline, not passed through the Transformers `sharp`
image path. The exception does not claim that the upstream vulnerable version
is safe in every use; it states that the vulnerable image-processing path is
not part of this plugin's supported Transformers execution path.

The exception will be documented in `SECURITY.md` with:

- the exact advisory ID and dependency path;
- the reachability analysis;
- the reason forced overrides and an unmaintained fork were rejected;
- a review deadline of 2026-09-30; and
- removal criteria: an upstream Transformers release compatible with
  `sharp >= 0.35.0`, or evidence that the vulnerable path is reachable here.

### Machine enforcement

Add a production audit wrapper that executes `pnpm audit --prod --json` and
fails when:

- any critical vulnerability exists;
- any high vulnerability other than the single approved advisory exists;
- the approved advisory appears through an unexpected dependency path; or
- the exception has passed its review deadline.

It prints the approved exception prominently so a green CI result cannot be
mistaken for a vulnerability-free dependency tree. The script is used by both
CI and the release preflight.

## Continuous Integration

The CI follows the strongest patterns observed in mature DSH community
plugins: pin the DSH compatibility anchor, separate source checks from real
mounting, test the exact Node floor, cover Windows explicitly, and validate the
packed artifact rather than only the source checkout.

### Compatibility anchor

The plugin currently develops against DeepSeek Harness commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. CI checks out that exact commit.
The workflow checks this repository out as `$GITHUB_WORKSPACE/dsh-knowledge`
and DSH as `$GITHUB_WORKSPACE/dsh`, satisfying the repository's existing
`link:../dsh/...` development dependencies. It runs DSH's `build:lib` before
installing and checking the plugin; a full DSH application build is not needed
for the source-quality lanes.

Add `"packageManager": "pnpm@11.7.0"` to the plugin package and use
`actions/checkout@v4`, `pnpm/action-setup@v4`, and `actions/setup-node@v4`.
The package field is the pnpm version source of truth; the workflow does not
declare a conflicting pnpm version separately.

The pinned commit is a compatibility contract, not an assertion that newer
DSH commits are unsupported. Upgrading the anchor is a deliberate maintenance
change accompanied by tests and release notes.

### Job 1: quality

Run on Ubuntu for Node 22.19.0 and Node 24. It performs:

1. plugin and pinned DSH checkout;
2. frozen dependency installation;
3. TypeScript type checking;
4. all Vitest tests;
5. the production dependency audit policy;
6. production build;
7. package-content verification; and
8. the deterministic retrieval benchmark.

Node 22.19.0 is exact because it is the declared runtime floor. A floating
`22` would only test the newest Node 22 and could miss reliance on APIs newer
than the floor.

### Job 2: native platform

Run on Ubuntu, Windows, and macOS with Node 24. This lane installs the real
native dependency tree and runs type checking, tests, and build. It does not
download the 600 MB embedding model or OCR weights. Existing tests exercise
SQLite, parsing, workers, lifecycle logic, and platform-specific path
behavior without requiring those downloads.

This lane complements rather than duplicates the Node-version lane: Node
compatibility is checked twice on one platform, while native installation and
path semantics are checked once on each supported platform.

### Job 3: packed DSH smoke

Run on Ubuntu and Windows with Node 24. It:

1. builds and packs the plugin into a tarball;
2. installs the pinned public DSH CLI `@deepseek-ai/dsh@0.1.1-rc.2`;
3. creates an isolated temporary DSH home/profile;
4. installs the tarball using `dsh plugin --profile <name> add <tarball>`;
5. starts DSH with telemetry disabled and browser opening disabled;
6. uses lexical-only configuration, so no model or API key is required;
7. verifies the plugin mounts, its HTTP surface responds, and its tool/plugin
   registrations do not crash startup;
8. shuts DSH down and verifies clean process termination; and
9. removes the plugin through the official CLI to check the reverse path.

The smoke harness has bounded startup and shutdown deadlines, captures logs on
failure, and never silently skips because a DSH binary is unavailable.

### Workflow behavior

The workflow runs on pushes to `main`, pull requests, and manual dispatch.
Superseded pull-request runs are cancelled; push runs are not. Jobs use
read-only repository permissions, disable DSH telemetry, and do not require
secrets. npm publishing belongs outside this CI.

## Packed Artifact Verification

A portable verifier creates the npm tarball and checks the consumer-visible
contract:

- every declared `exports` entry exists;
- every declared type entry exists;
- `cordis.patch.yml`, `dsh.plugin.json`, license, readmes, changelog, and
  scripts are present;
- source files, tests, local caches, historical `.tgz` files, and machine
  paths are absent;
- package name and version match the expected release metadata; and
- the tarball can be unpacked and its Node entry imported in the prepared DSH
  environment.

The verifier uses a temporary directory and deletes it after completion. It
does not write a tarball into the repository root.

## Release Preparation

### Version and changelog

Set `package.json` and the lockfile to version 0.3.6. Convert the current
`Unreleased — knowledge retrieval hardening` changelog section into:

```text
0.3.6 — 2026-08-30
```

The section covers strict enabled-base scope, proactive-context hardening,
multi-query RRF, one-shot reranking, destructive approval, paged tool output,
CI, the audit policy, governance, and reproducible benchmarks.

### Release copy

Add `docs/releases/v0.3.6.md` as copy-ready GitHub Release text. It includes:

- user-visible changes;
- security and behavior notes;
- compatibility and installation notes;
- verification evidence; and
- the explicit distinction between the fixed issue #5 behavior already
  released in 0.3.5 and the new 0.3.6 retrieval/engineering changes.

### Local release preflight

Add `npm run release:check`. It validates, in order:

1. version and changelog consistency;
2. security audit policy;
3. type checking and all tests;
4. deterministic benchmark thresholds;
5. build and packed-artifact verification; and
6. clean tracked working state when used for final publishing.

The command never tags, pushes, publishes, opens a browser, creates a GitHub
Release, or changes npm dist-tags. The maintainer can run it immediately
before the existing manual publish flow.

## Issue #5 Reply Draft

Add `docs/issues/issue-5-resolution.md`, written as a concise maintainer reply
that can be pasted without editing. It states that 0.3.5 fixed the issue by
keeping the worker alive while disposing its ONNX sessions, serialized release
and reload operations, corrected misleading error classification, and added
regression coverage. It reports the real Qwen3 release/reload validation and
asks the reporter to confirm behavior on Linux. It does not claim the reporter
has confirmed the result, and the file itself performs no GitHub action.

## Open-Source Governance

Add only the files that materially improve contribution and security handling:

- `CONTRIBUTING.md`: supported Node/pnpm versions, adjacent DSH checkout
  layout, frozen install, build/test/benchmark commands, platform-sensitive
  changes, pull-request expectations, and release boundaries;
- `SECURITY.md`: supported release line, GitHub's private vulnerability-report
  URL (`/security/advisories/new`), a warning not to disclose exploit details
  in a public issue, the expected response process, and the exact audit
  exception;
- `.github/ISSUE_TEMPLATE/bug_report.yml`: version, DSH version/commit,
  operating system/architecture, Node version, embedding mode, reproduction,
  logs, and confirmation that secrets were removed;
- `.github/ISSUE_TEMPLATE/feature_request.yml`: problem, intended users,
  proposed behavior, alternatives, and compatibility impact; and
- `.github/pull_request_template.md`: scope, tests, platform impact, security,
  documentation, and release-note checklist.

Do not add CODEOWNERS, a code of conduct, discussions automation, or a bot-only
triage system in this change. The project currently has one maintainer; these
would add ceremony without resolving an observed bottleneck.

## Deterministic Retrieval Benchmark

### Dataset

Commit a synthetic, copyright-safe corpus of 24 documents, split evenly
between Chinese and English. The corpus contains:

- exact and paraphrased facts;
- intentionally similar titles and distractor documents;
- title-only and heading-only clues;
- cross-base ambiguity;
- long documents with answer-bearing middle chunks; and
- unrelated noise.

Commit 40 questions. Each question declares its expected base,
expected document or documents, and evaluation depth. No personal data,
third-party documents, or model-generated claims presented as real facts are
included.

### Runner

The benchmark mounts `KnowledgeService` directly against a temporary store and
imports the committed corpus. Its required CI mode is lexical-only and needs no
network, model weights, DSH server, or API key. It evaluates both primary-query
retrieval and committed multi-query variants so the RRF path is covered.

Optional real-system evaluators remain separate: the existing
`eval-retrieval.mjs` and `eval-rag.mjs` continue to target a running DSH service
and private user corpora.

### Metrics and gates

Report:

- Hit@1;
- Hit@3;
- Recall@3;
- mean reciprocal rank;
- sentence-level context recall;
- p50 and p95 elapsed time; and
- process resident-set size before and after the run.

Quality metrics are deterministic gates. Timing and RSS are informational
because shared CI hosts are noisy. A regression output identifies every failed
question, its expected source, and the observed top results.

### Baselines

Add:

- `benchmarks/baseline.json`, the machine-readable expected result and quality
  thresholds;
- `benchmarks/README.md`, describing the corpus, environment, metrics, current
  result, limitations, and reproduction commands; and
- package scripts `benchmark`, `benchmark:json`, and
  `benchmark:update-baseline`.

Normal benchmark execution never modifies tracked files. Updating the baseline
requires the explicit update command. A baseline update must be reviewable as
a normal diff and accompanied by an explanation when a quality threshold is
lowered.

## Error Handling and Diagnostics

- CI commands fail with actionable messages rather than only exit codes.
- Network-bound DSH checkout/install failures are distinct from plugin test
  failures.
- The packed smoke test always prints captured startup logs on timeout.
- Security audit output distinguishes accepted risk from unexpected risk.
- Benchmark failures list question-level retrieval evidence.
- Temporary profiles, tarballs, and stores are removed even after failure.

## Acceptance Criteria

The implementation is complete when:

1. the local typecheck, 196 existing tests, new tests, build, audit policy,
   package verifier, and deterministic benchmark pass;
2. workflow syntax is validated and the committed CI defines the approved
   Node, OS, and packed-smoke lanes;
3. the packed smoke succeeds locally where the pinned DSH CLI is available,
   or a clearly documented external-environment limitation is reported without
   weakening the required CI lane;
4. `pnpm audit --prod` still exposes the upstream advisory while the wrapper
   accepts only that exact, documented, unexpired exception;
5. package and lockfile versions are 0.3.6 and release metadata is consistent;
6. release notes and the issue #5 reply are copy-ready but no external release
   or issue action has occurred;
7. governance files contain no placeholder contact or policy text; and
8. the tracked working tree contains only the intended implementation changes
   before the implementation commit.
