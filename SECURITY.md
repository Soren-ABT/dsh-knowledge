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

## Accepted production dependency risk

As of 2026-08-30, `pnpm audit --prod` reports the high-severity advisory
`GHSA-f88m-g3jw-g9cj` through:

```text
dsh-knowledge -> @huggingface/transformers@3.7.0 -> sharp@0.34.1
```

The advisory concerns libvips behavior inherited by `sharp < 0.35.0`. This is
an explicit, narrow exception rather than a claim that the upstream version is
generally safe:

- dsh-knowledge uses Transformers for text feature-extraction and text
  classification (embedding and reranking);
- user-controlled document images go through the PDF/OCR pipeline and are not
  passed to the Transformers `sharp` image path;
- Transformers 3.x and the current 4.x line constrain sharp below 0.35;
- a package-local dependency override would not reliably propagate into the
  user's DSH profile; and
- maintaining an unreviewed Transformers fork would add greater supply-chain
  risk for this release.

The repository's audit policy permits only this advisory, only through the
expected Transformers-to-sharp path, and only until **2026-09-30**. Any other
high or critical production advisory fails CI. The exception must be removed
earlier if the path becomes reachable or upstream publishes a compatible sharp
upgrade.

Run the policy locally with:

```bash
npm run audit:prod
```
