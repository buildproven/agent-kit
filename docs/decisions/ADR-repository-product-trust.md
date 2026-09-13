# ADR: Repository-scoped product trust

Status: accepted. Independent architecture review: Sol/high, clean.

## Cause

The local verifier selects one fixed producer key and one fixed admission key
for every repository. Distinct repositories provision independent signing keys.
A host cannot verify both without repeatedly replacing its global trust key.
Observed on 2026-09-11: the two repository producer fingerprints and the local
producer fingerprint all differ; the local admission key is absent.

## Decision

Extend the existing product-evidence trust reader, reused by product-admission,
with an optional root-owned `product-trust.json` adjacent to the current fixed
platform trust files. No environment variable, CLI flag, candidate file or
receipt can choose its path. Schema version 1 contains `repositories`, keyed by
canonical positive decimal GitHub numeric repository ID. Each row binds the
canonical GitHub owner/name plus separate producer and admission Ed25519 SPKI
public keys. Validate exact fields, canonical base64, Ed25519 type and unique
IDs/names; private keys are forbidden by the schema. Every decoded SPKI
fingerprint must be unique across all rows and both purposes. A producer key
cannot also authorize admission, and a registered key cannot span repositories.

Select by the expected repository ID and name supplied by the existing trusted
quality context, before reading any envelope identity. The selected purpose is
fixed by the verifier call: producer for product receipts, admission for the
admission envelope. Receipt repository, ID, issuer, signature and all other
bindings still have to match. No key search across entries or trust-on-first-use.

If the registry does not exist, preserve the existing singleton behavior for
legacy installations and isolated protected workers. If a registry exists,
missing entries, mismatched name/ID, malformed data, wrong ownership or unsafe
permissions fail closed. Never fall back to singleton after a registry error.
On POSIX require a root-owned regular registry file and root-owned directory,
with no group/other write permission and no symlink; open without following symlinks or waiting on a FIFO, validate the descriptor,
then compare its identity against lstat and read through the descriptor to reject
replacement races. On platforms without a
supported ownership check, registry mode fails explicitly until a native
permission verifier exists; existing legacy behavior remains available.

Reuse the protected no-input commissioning workflow to export both public keys
and fingerprints from the existing GitHub secrets. Verify the exact reviewed
workflow/default-branch commit, repository numeric ID, run ID/attempt, successful
run and artifact digest independently through GitHub before constructing a row.
Never read private GitHub secret values on the operator host. The privileged installer receives an explicit expected SHA-256 digest of the
verified registry. After entering privilege, it reads the staging file once,
checks that digest and revalidates the exact bytes/schema before installation.
It rejects symlinked or unsafe fixed parent/target paths. It writes a new
root-owned 0644 file with exclusive creation in the fixed parent, fsyncs it,
atomically renames it to the fixed registry path, then fsyncs the directory.
A user-writable staging change after verification cannot satisfy the expected
digest. The reviewed installer itself is run from the exact merged revision.
Install the full verified registry through this one privileged boundary. Preserve the old
singleton files. Refuse to replace any existing row with different keys without
a separate explicit rotation decision. Same-key installation is idempotent.

## Alternatives

- Rotate both repositories onto one key: rejected; unnecessary rotation couples
  independent signing identities and cannot preserve existing receipts.
- Per-request key path or key embedded in receipts: rejected; candidate-controlled
  trust defeats the signature boundary.
- Repeated global key replacement: rejected; concurrent repositories would race.
- Separate new verifier: rejected; retain the existing receipt and admission APIs.

## Invariants and rollback

Expected trusted repository identity selects keys; envelope content never does.
Only fixed system files supply production trust. Purpose separation and every
existing exact-head/evidence binding remain mandatory. Test-only injected key
objects remain internal library dependencies; no production CLI accepts them.
Rollback removes only the newly installed registry after preserving a verified
backup; old singleton files are unchanged. No private material is written.

## Verification

At the existing public verification seam, verify two independently signed
repositories in one process without key replacement. Reject cross-repository
keys, wrong purpose, duplicate fingerprints across purposes/repos, altered
expected ID/name, unknown entries, malformed or
private key material, unprivileged/group-writable/symlinked registry and file
replacement. Legacy absent-registry fixtures retain existing behavior. A
malformed present registry cannot invoke singleton fallback. Exercise exact
producer receipt and remote admission check verification, then both protected
commissioning runs and actual local admission for the exact candidate heads.

Installer tests reject a staging-byte change after digest capture, existing
symlink/unsafe target and malformed registry after privilege entry. They verify
atomic same-directory install, root ownership, exact readback and idempotence.
