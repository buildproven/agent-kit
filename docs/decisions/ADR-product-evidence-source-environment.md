# ADR: Product evidence source environment

**Status:** Accepted

## Decision

The protected Product Evidence Source worker runs on the fixed Ubuntu 24.04
runner and provisions `zsh` before running the candidate suite. If the runner
does not already contain the approved package, the worker downloads the pinned
Ubuntu 24.04 `zsh` and `zsh-common` packages over HTTPS, verifies their approved
SHA-256 digests, and installs them. It then fails closed unless both package
versions and the zsh binary digest match the approved identity. The exact
environment identity is recorded as provenance. Checkout runs before this
setup, and the provenance artifact is uploaded before candidate code runs, so
checkout cleanup and candidate writes cannot alter the trusted record. The
artifact action is referenced by its immutable commit SHA. The complete
behavioral command group, including `npm ci`, is captured in its log; required
behavioral and acceptance logs are checked for existence before upload. Failed
behavioral or acceptance commands remain blocking.

## Verification

The workflow is validated by the repository's workflow contract tests and by a
manual complete regression run on the candidate head.
