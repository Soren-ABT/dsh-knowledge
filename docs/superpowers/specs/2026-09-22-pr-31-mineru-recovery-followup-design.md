# PR #31 MinerU recovery follow-up

## Scope and outcome

Append a maintainer fix to PR #31 for Issue #30. Preserve the contributor's recovery behavior: reindex and genuinely interrupted imports use the configured MinerU processor for PDFs, then fall back to local parsing. Do not change processor selection, merge the PR, close the issue, or publish a release in this work.

## Failure reporting

`sourceTextOf` may fall back from a live `sourcePath` to a stored raw copy, then to persisted text or chunks. It must retain the failure reason of each attempted parse. When no usable text remains, reindex must throw an actionable error containing the MinerU and local-parser reasons rather than replacing them with the generic “no source text” error. If persisted text or chunks are usable, reindex may succeed and parsing failures remain warnings. Do not expose API keys or document contents in the error.

## Startup recovery

A document explicitly marked `errorCode: 'parse_failed'` is a completed failed import, not an interrupted one. Both durable and in-memory `recoverInterruptedImports` implementations must exclude it from automatic resume, including the raw-file-only placeholder case. A user-initiated reindex remains the retry path. Documents marked `incomplete` by an interrupted ingest, without that explicit parse failure, continue to resume at startup.

## Avoid duplicate remote work

During one reindex, if parsing the live `sourcePath` fails and its bytes equal the cached raw bytes, do not send the same PDF to MinerU a second time. Continue to persisted text or chunks, or report the retained failure if neither exists. If the live source and cached raw differ, the cached copy may be attempted as a distinct recovery source. A later explicit reindex may retry MinerU normally.

## Verification and delivery

Add regressions for: both parser failures surfaced through reindex; failed imports not retried on startup; interrupted imports still resumed; identical path/cache bytes cause one MinerU request; distinct source/cache fallback remains functional. Run focused tests, typecheck, full Vitest, build and release/package verification. Push the maintainer commit to PR #31's contributor branch only if repository permissions and GitHub branch state still allow it; otherwise create a maintainer follow-up branch/PR without altering the contributor's commit. Wait for required CI to pass before recommending merge.
