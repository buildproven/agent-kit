# CI-repair review-coverage carry (BUI-947)

## Decision

Permit one autonomous review-coverage carry for a descendant that repairs an
exact-head failed required CI check using only test or fixture files. The carry
does not waive validation. It reuses the preceding completed provider review of
the unchanged production diff, then requires fresh exact-head gates, mutation
proof, required CI, merge authority, and read-back.

The runner must create a durable, identity-bound carry record only when all of
the following are true:

- The previous reviewed head has complete contiguous review coverage under the
  current risk, panel, and review-policy identities.
- That exact head has a recorded failed required check from the same campaign.
- The prior reviewed head is an ancestor of the candidate and every changed
  path is a repository test or fixture path.
- The candidate has current successful required gates and valid current-head
  mutation evidence.
- No previous CI-repair carry exists in the campaign.

The carry records both heads, the changed-path digest, the failed-check
identity, and the previous review evidence digest. Review coverage accepts the
carry only after it revalidates all of those facts from Git and stored evidence.
It never consumes another provider authorization or turns the repair into a
policy exemption.

## Rejected alternatives

- Start a third review: rejected. The bounded review cap correctly prevents an
  unbounded loop, and a test/fixture-only repair cannot change the reviewed
  production diff.
- Trust any test-only commit: rejected. It must be causally linked to a failed
  exact-head required check and have fresh red-capable mutation evidence.
- Waive mutation or CI: rejected. A portable fixture repair can weaken a test;
  it must prove the current test still kills the prior source mutation and must
  pass protected CI.
- Add a PR-specific override: rejected. The decision belongs to the quality
  state machine and applies only through deterministic predicates.

## Compatibility and recovery

Existing manifests remain unchanged. The runner may reopen only its typed
`review-authorize` terminal failure when it can create this carry for the exact
descendant; other terminal failures remain terminal. The prior terminal record,
provider budget, lease, and review artifacts remain immutable.

## Verification

Integration tests must prove that a two-round reviewed campaign with a
test-only, CI-linked repair merges without a third provider start, after fresh
gates, mutation proof, and CI. Tests must also prove refusal for a production,
workflow, policy, or unlinked test-only delta; absent/failed mutation proof;
missing or wrong-head CI failure; stale prior review; non-ancestor history; and
a second carry attempt.
