# Product-evidence admission operator guide

The source bundle contains a JSON request and a JSON array of changed paths;
Git paths include deletions and both sides of renames. NUL delimiters preserve unusual filenames.
Protected producer and admission API steps use the job-scoped GitHub token
with the permissions declared in each workflow.

## Final manual provisioning

This repository contains no private key. Generate two independent Ed25519 key
pairs in an approved offline or secrets-management environment:

- Store the base64 DER PKCS#8 producer private key as the GitHub Actions secret
  `PRODUCT_EVIDENCE_PRIVATE_KEY`.
- Store the base64 DER SPKI producer public key as the repository variable
  `PRODUCT_EVIDENCE_PUBLIC_KEY`.
- Store the base64 DER PKCS#8 admission private key as the GitHub Actions
  secret `PRODUCT_ADMISSION_PRIVATE_KEY`.
- Install the matching admission public key in the operator-owned system trust
  root on every machine that can run `quality-run.js`:
  `/etc/claude-kit/product-admission-public-key` on Linux,
  `/Library/Application Support/claude-kit/product-admission-public-key` on
  macOS, or `C:\ProgramData\claude-kit\product-admission-public-key` on Windows.

Do not place either private key in a repository variable, workflow output,
artifact, log, environment file, or local project configuration.

## Recover an unavailable admission public key

Use the original public key from the approved key-management record when it is
available. If that public key is unavailable, run **Product Admission Public
Key** manually from the reviewed protected default branch. It has no inputs and
checks both the dispatch ref and workflow ref before it receives the admission
and evidence signing secrets. It checks out that protected base and runs only
inline platform crypto code.

Before installation, verify in GitHub that the successful run belongs to this
repository and reviewed workflow commit. Download the
`product-admission-public-key-<run-id>` artifact and verify its public key,
SHA-256 fingerprint, workflow commit, run ID, and run attempt against the
artifact provenance. The artifact contains the base64 DER SPKI admission and
evidence public keys and their provenance. Keep each repository's public keys
separate; the local multi-repository trust-root selection is a separate review.

Install the verified key atomically as a root-owned regular file at the fixed
trust-root path. Refuse to replace a different existing key. Keep the existing
key when rolling back this workflow change. A different key requires the
separate rotation procedure below.

## Rotation

1. Create a new producer pair and a new admission pair.
2. Update the producer public repository variable and both protected secrets.
3. Install the new admission public key at every system trust root before
   requesting new admissions.
4. Run a new exact-head admission. Old admissions fail after rotation by design.
5. Revoke the old secrets only after the new admission succeeds.
