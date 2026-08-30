# Contributing to dsh-knowledge

Thanks for improving dsh-knowledge. The plugin follows DeepSeek Harness (DSH)
closely, so a reproducible DSH compatibility anchor is part of the development
environment rather than an optional extra.

## Development setup

Use Node.js 22.19.0 or Node.js 24 and pnpm 11.7.0. Check out the repositories
as siblings because the development dependencies use `link:../dsh/...`:

```text
workspace/
├── dsh/
└── dsh-knowledge/
```

The compatibility anchor for 0.3.6 is DSH commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh
git -C dsh checkout b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
git clone https://github.com/Soren-ABT/dsh-knowledge.git dsh-knowledge
cd dsh
pnpm install --frozen-lockfile
pnpm run build:lib
cd ../dsh-knowledge
pnpm install --frozen-lockfile
```

## Required checks

Run the checks relevant to your change before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
npm run benchmark
npm run audit:prod
npm run verify:package
```

`npm run release:check` is the maintainer's final, non-publishing release gate.
It expects a clean Git working tree and never creates a tag, pushes, or
publishes to npm.

Changes involving paths, workers, native dependencies, OCR, SQLite, process
lifecycle, or installation must be tested on both Windows and Linux. Do not
download model weights in ordinary automated tests; isolate real-model checks
as an explicitly documented validation step.

## Pull requests

- Keep each pull request focused on one problem.
- Add regression coverage for behavior changes and bug fixes.
- Update both English and Chinese user documentation when user-visible
  behavior changes.
- Explain compatibility, security, storage migration, and release-note impact.
- Do not commit generated tarballs, model files, caches, credentials, or local
  DSH profiles.
- Treat lower retrieval benchmark scores as a behavior change that requires an
  explanation, not as a baseline file to update silently.

The maintainer performs npm publication and GitHub Release creation manually.
A pull request must not add credentials or publish from an untrusted context.
