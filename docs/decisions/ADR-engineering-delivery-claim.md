# Separate engineering delivery from product acceptance

Status: accepted after independent architecture review.

## Problem

The quality runtime treats every product-affecting source change as a claim that
the changed product is locally usable. Runtime repairs therefore require signed
product receipts before the repaired receipt producer can merge. This creates a
bootstrap cycle. It also confuses two facts: an engineering revision can pass its
quality and merge controls while whole-product acceptance remains incomplete.

## Decision

Add a protected-base delivery policy with schema version 1. It may enable the
`engineering` delivery claim. The claim means only that an exact revision passed
the repository's deterministic gates, independent review, required CI, freshness,
and merge-authority checks. It never satisfies `local-product`, `hosted`, or
`validated`, never completes a product task, and never supplies a receipt.

The policy landed inert before this consumer. The runtime reads it from the
exact protected base revision recorded in the campaign. Candidate-only policy is
not authority. Missing, disabled, malformed, unrecognized, stale, or unreadable
policy rejects the engineering claim and keeps the existing claim rules.

The policy contains an explicit enabled flag, claim name, required engineering
controls, and product-acceptance result. Validation uses an exact closed schema:
unknown or missing fields fail. The accepted controls are the complete fixed set:
`deterministic-gates`, `independent-review`, `required-ci`, `base-freshness`, and
`merge-authority`. The product result is `not-established`.

The consumer re-reads the same policy from the protected base during
final merge authorization. Base movement is handled by the existing freshness
gate and cannot silently change authority within a campaign. Disabling or
removing the policy on a later base revokes it for new campaigns.

## Alternatives

- Classify runtime changes as contract documentation. Rejected because source
  behavior changes and the claim would be false.
- Treat engineering quality as local product acceptance. Rejected because tests
  and review do not prove installed or user-visible behavior.
- Remove signed product claims. Rejected because those claims remain useful for
  the stronger product states they describe.

## Rollout and rollback

The inert protected policy and this ADR merged first through the contract path.
The base-bound consumer adds the CLI claim, closed-schema tests, candidate-only
and revoked-policy tests, and merge-time re-read. It activates no installation
or hosted state. Roll back by disabling the claim in a reviewed policy change;
existing audit records retain the policy revision they used.
