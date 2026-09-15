# BUI-836: Protected product-evidence admission

## Problem

The quality runner can verify candidate-supplied signed product receipts, but it
correctly refuses to use that preflight as merge authority. No protected worker
creates receipts or publishes an admission for the exact candidate HEAD.

## Requirements

- A source workflow runs only fixed commands and has no signing secret.
- A producer workflow runs from the protected default branch, validates source
  workflow and pull-request identity, and signs raw artifacts with a private
  Ed25519 producer key.
- A separate admission workflow installs the fixed producer public key,
  reruns the verifier without candidate checkout, signs an exact-head admission
  with a separate admission key, and publishes a `product-admission` check.
- The quality runner accepts only the valid signed admission bound to its
  repository ID, HEAD, and selected PRD/task digest.

## Delivery classification

- Delivery: protected-infrastructure-bootstrap

## Acceptance

- Forks, stale heads, altered artifacts, alternate commands, missing keys,
  wrong repository identity, invalid signatures, and replay to another head
  fail closed.
- The producer and admission workers never expose their private keys to code
  checked out from a candidate PR.
- The only manual completion step is operator key provisioning described in
  the setup guide.
