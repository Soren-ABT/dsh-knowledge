# Python discovery amendment

Approved by the user: automatic discovery plus manual interpreter selection,
without modifying existing environments. This replaces the 3.12-only preview.

- Discover bounded candidates from PATH, Windows launcher, Conda registration,
  and conventional install locations. No whole-disk scan or automatic bootstrap.
- Probe with fixed argument arrays, isolated/no-site Python flags, output limits
  and timeouts. Report executable, version, implementation, bitness, architecture,
  venv/ensurepip availability and stable incompatibility codes.
- Candidate eligibility: stable CPython 3.10–3.14, 64-bit, ordinary GIL build,
  venv and ensurepip present. This is not a dependency or inference guarantee.
- Selection remains explicit. Manual absolute Python executable paths are allowed
  behind the existing loopback management guard; shell commands are not accepted.
- Bind the selected interpreter fingerprint to the preflight plan. Reprobe before
  installing; reject disappearance or identity/version changes instead of choosing
  another interpreter silently. Only create a new managed venv.
- Expose separate validation milestones: interpreter eligibility, managed venv
  verification, dependency installation, synthetic parse. Errors retain their phase.
- Test version boundaries, output errors, path validation, discovery deduplication,
  bounded processes, plan binding and changed interpreters. Run local discovery,
  but do not install dependencies or models as part of this amendment's tests.

Implementation checklist: discovery module → service/API binding → runtime
validation → bilingual UI → hermetic tests and read-only local detection.
The writing-plans skill is unavailable; this focused checklist is the fallback.
# Validation checkpoint

Implementation verified locally: 442 tests across 35 files pass; typecheck,
build, package verification and release metadata verification pass.
Read-only discovery on the development Windows host found six interpreters:
five passed interpreter prerequisites (three 3.13 installations, one 3.12,
one 3.10); Python 3.8 was rejected. This is not dependency or inference acceptance.
No Python packages or model weights were installed. Browser visual verification,
actual managed MinerU inference, and cross-platform acceptance remain pending.
