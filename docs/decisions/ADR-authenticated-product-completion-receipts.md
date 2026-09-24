# ADR: Authenticated product-completion receipts

Status: Accepted

## Decision

Product-completion evidence must use a signed version 2 receipt. The runtime is
verifier-only. It does not provide a signing command and never receives a
private key. An operator-owned producer must independently execute the
allowlisted command or inspect platform-attested job conclusions and artifact
provenance before it signs the receipt. Candidate-supplied result fields are
not evidence. CI signing and admission verification must run on separate fresh,
protected workers or services that never execute candidate code. A post-job on
the candidate worker is not protected, even when the signing step itself does
not run candidate code. The producer signs its fresh-worker isolation,
issuer-owned execution, and platform run identity with the exact repository
name and immutable GitHub numeric repository ID, HEAD, requirements digest,
environment or deployment identity, and artifact digest. The admission
verifier uses a trusted installed verifier, schema, and Ed25519 public key from
a system-owned absolute
trust-root file:
`/Library/Application Support/agent-kit/product-evidence-public-key` on macOS,
`/etc/agent-kit/product-evidence-public-key` on Linux, and
`C:\ProgramData\agent-kit\product-evidence-public-key` on Windows. Unsupported
platforms fail closed. A repository path, command option, home directory, or
environment variable cannot replace that key.

The signed payload binds the issuer, GitHub repository name and immutable
numeric repository ID, exact candidate HEAD, requirements digest, receipt kind,
observation time, command or evidence source, result, protected provenance,
environment, and a referenced artifact path and SHA-256 digest.
The requirements digest is SHA-256 over the UTF-8 bytes of the exact JSON
`{"prdSha256":"<digest>","tasksSha256":"<digest>"}`. Each inner digest is
SHA-256 over the exact bytes of its selected file. Hosted and validated
receipts also bind a deployment identity. The evidence index names
one expected environment and deployment identity. Every receipt in a hosted or
validated claim must match both values, so evidence from separate deployments
cannot be combined.

The exact envelope and per-kind payload members, types, constants, required
fields, and unknown-field policy are in
`scripts/schemas/product-evidence-receipt-v2.schema.json`. The exact evidence
index is in
`scripts/schemas/product-delivery-evidence-index-v2.schema.json`. Repository
Repository display identity is the case-preserving GitHub `owner/repository`
name. Security identity is GitHub's numeric repository ID represented as a
decimal string. `head` is a lowercase 40-character Git object ID. Receipt and
artifact paths are relative
to the evidence-index directory; lexical traversal, absolute paths, symlinks,
and resolved paths outside that directory fail. A successful result is the
literal string `passed`.

`product-evidence.js` owns receipt verification. `product-completion.js` asks it
to verify a receipt and does not know signature details. Candidate-worker or
local verification is a fail-closed preflight only. Admission-grade acceptance
must rerun the installed verifier on the protected worker described above.
The local runner never converts that preflight result into merge authority. A
product-claim merge returns the typed `product-admission` external-capability
state until a protected admission service is available. Contract-only changes
can still merge through the normal exact-head quality path.
Verification
fails when the trust key is absent, the signature is invalid, the repository,
HEAD, or requirements digest differs, the result is not successful, or the
artifact is missing, escapes the evidence directory, or has a different digest.

The quality manifest records the SHA-256 digest of the delivery-evidence index
for the current HEAD. The runner rejects a same-HEAD change. When an authorized
campaign transition advances to a descendant HEAD, that transaction archives
the prior binding and records the new index digest. The renewed receipts must
bind the new HEAD and requirements digest before the campaign can continue.

The receipt wire format is UTF-8 JSON with exactly two envelope keys:
`payload` and `signature`. The signature is Ed25519 over the RFC 8785 JSON
Canonicalization Scheme bytes of `payload`. Non-I-JSON values, including lone
Unicode surrogates and non-finite numbers, fail before verification. The
signature is unpadded base64url. The trust-root file contains one base64-encoded
DER SubjectPublicKeyInfo Ed25519 public key followed by an optional newline.
`signature` is outside the signed payload. Unknown payload or envelope keys
fail closed. The receipt digest in the evidence index is SHA-256 over the exact
receipt file bytes. A fixed public key, receipt, canonical payload, and
signature conformance vector is in
`scripts/schemas/product-evidence-v2-conformance.json`.

## Alternatives

- Keep caller-supplied receipt digests. Rejected because the caller controls
  both the receipt and digest.
- Trust GitHub check metadata only. Rejected because local behavioral and
  acceptance evidence can exist before a GitHub run.
- Put a public key in the repository. Rejected because a candidate branch could
  replace its own trust anchor.

## Invariants

- The private key stays outside the repository.
- The receipt producer is outside this runtime and independently verifies the
  represented result before signing. Candidate code never shares its worker or
  secret with the producer or admission verifier.
- The verifier receives only the public key from the fixed operator-owned trust
  root. Candidate inputs cannot select another key.
- A receipt cannot move between numeric repository identities, candidate
  heads, requirements, kinds, or artifacts.
- Evidence index changes require a HEAD-advance transaction; remediation can
  renew evidence without creating a new campaign.
- A digest authenticates the referenced artifact, not only the receipt wrapper.
- Local, hosted, and real-user claims remain separate evidence levels.
- Hosted and validated receipt chains use one environment and one deployment
  identity throughout.
- Behavioral and acceptance receipts omit `deploymentIdentity` for a local
  claim and must include the selected deployment identity for hosted or
  validated claims.

## Rollback

Revert the receipt verifier and manifest field together. Version 1 receipts
remain invalid after this change; rollback must restore their old acceptance
explicitly.

## Verification

Public-interface tests must reject unsigned receipts, an untrusted signer,
wrong repository name or numeric ID, wrong HEAD, a different PRD or task set, a
missing or changed artifact, an unsuccessful result, unprotected provenance,
mixed deployment identities, and a same-HEAD evidence-index change. They must
accept a valid signed receipt, rotate the index digest only on HEAD advance,
verify the published schema and conformance vector, reject invalid Unicode and
path/symlink escapes, and keep hosted and real-user gates separate.
