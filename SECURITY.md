# Security Policy

## Supported versions

Security fixes are provided for the latest npm release. Users should reproduce
an issue on the latest release before reporting it when practical.

## Reporting a vulnerability

Use GitHub's private vulnerability report flow:

<https://github.com/Soren-ABT/dsh-knowledge/security/advisories/new>

Do not publish exploit details, credentials, private document content, or
unredacted logs in a public issue. Include the affected version, DSH version or
commit, operating system and architecture, reproduction conditions, impact,
and any proposed mitigation. If GitHub's private form is unavailable, open a
minimal public issue requesting a private contact channel without including
the sensitive details.

The maintainer will acknowledge a report, assess reachability and severity,
coordinate a fix when warranted, and credit the reporter unless anonymity is
requested. No response-time guarantee is made for this volunteer-maintained
project.

## Production dependency auditing

As of 2026-10-08, the repository uses `@huggingface/transformers@4.3.1`, whose
published dependency range permits `sharp ^0.35.4`. The lockfile resolves
`sharp@0.35.5`, which fixes all three previously reported high-severity sharp
advisories:

- [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
  (libvips; fixed in sharp 0.35.0);
- [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
  (libheif; fixed in sharp 0.35.4); and
- [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
  (librsvg; fixed in sharp 0.35.5).

The previous sharp exceptions have been removed. Every high or critical
production advisory fails CI, including the previously accepted advisories.
The audit also fails if its process fails or its JSON report is incomplete or
inconsistent. Moderate and lower-severity advisories remain visible in the
underlying `pnpm audit --prod` report and do not pass as accepted exceptions.

Local embedding uses the text feature-extraction pipeline, and local reranking
uses text tokenization and cross-encoder logits. Document images use the
separate PDF/OCR pipeline. This reachability assessment does not exempt sharp
or any other package from the production audit.

Published npm packages do not impose this repository's lockfile on a user's
DSH profile. An existing profile lockfile can retain `sharp@0.35.4` within the
upstream range, or another plugin can introduce an older sharp version. After
upgrading, refresh and audit the profile's actual dependency graph and ensure
that every installed sharp is at least 0.35.5. A repository-only dependency
override would not guarantee this for downstream profiles.

Run the policy in this repository with:

```bash
npm run audit:prod
```

Inspect all reported severities with `pnpm audit --prod`. The checked-in
lockfile records the tested dependency versions; use `pnpm install
--frozen-lockfile` in CI to reproduce them.
