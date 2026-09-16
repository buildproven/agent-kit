# Immutable review selection across repair rebases

Tracking: BUI-926. Status: accepted after bounded Sol/high review.

## Diagnosis

The saved contract-v2 campaign admits its reserved delta round after BUI-925,
but provider start and review-artifact verification each still require direct
Git ancestry from the original selection head. One repair followed by three
validated exact rebases preserves campaign identity but breaks that ancestry.
The public `authorizeProviderAttempt` reproduces the refusal using an in-memory
copy of the real manifest; the file bytes remain unchanged. Missing selection
fields and provider-budget exhaustion are refuted by the populated immutable
panel and unused provider capacity. Selection ancestry is the confirmed cause.

## Decision

Move the existing BUI-925 commit-interval and carry traversal into the shared
Git identity module. The governor keeps its public `resolveCommitCount` wrapper
and legacy fallback. The pure shared seam accepts a start, explicit endpoint,
and trusted carry list, and returns count plus the carries used, or null.
No manifest import, writes, provider starts, or budget changes occur there.

Keep the existing unique-source, full-SHA, linear-interval, cycle and missing
object checks. Preserve direct-ancestor semantics and ignore unused carries on
that path. On a recovery path, count ordinary repairs before/between/after
carries; a carry consumes zero repairs. Always bind to the caller's exact
endpoint, never ambient HEAD for manifest decisions.

Both contract-v2 selection consumers use this seam. Before accepting a carried
selection lineage, independently replay every used carry with the existing
`replayedTree` implementation and compare to the actual carry target tree.
Reject invalid or ambiguous proof. The original `panel.selectionHead`, agents,
domain, selection rule, policy digest, risk, and creation-time selector range
remain immutable. Artifact verification still recomputes the original selector
and validates all signed identity fields; only ancestry reachability changes.

The governor uses the count from the same seam without a new proof policy:
this extraction preserves its existing trusted-carry contract. Review coverage
continues to require contiguous canonical diff and exact-replay evidence. Do
not promote selection reachability into review coverage. The existing delta
may include conservative extra changes after a rebase; this change does not
narrow that reviewed range or claim a smaller exact diff without proof.

## Verification

- Public contract-v2 path: select original panel, record initial review, make
  one repair, record multiple exact rebases, authorize the reserved provider,
  record its delta artifact, and validate full review coverage.
- Assert selection identity, previous review artifacts, consumed repairs,
  provider usage and all limits remain unchanged except the permitted attempt.
- Reject unrelated endpoint, duplicate/ambiguous source, corrupt replay proof,
  and tampered selection identity; refusals happen before provider accounting.
- Keep BUI-925's direct, repair, merge, cycle, and explicit-endpoint tests.
- Verify a read-only copy of the real saved campaign succeeds after the fix.
- Run protected quality before using this runtime for saved delivery recovery.

## Alternatives and rollback

Changing selectionHead or reselecting the panel: rejected; rewrites identity
already signed into earlier reviews. New campaign: rejected; loses continuity.
Importing the governor into invocation: rejected; creates a circular dependency.
Copying the lineage algorithm into two review validators: rejected; repeats the
divergence that caused this failure. Moving all review machinery: out of scope.

No persisted schema migration is needed. Rollback restores conservative
refusal while preserving all historical evidence. This shared pure extraction
also removes history reasoning from the governor without broad monolith work.

The ADR-only review returned CLEAN before production changes. The new public
contract-v2 regression fails at provider start with the exact production error
(1 failed, 296 skipped), in addition to the read-only saved-manifest reproduction.

Local proof after implementation: 14 focused checks pass (296 skipped),
including provider admission, artifact verification, complete delta coverage,
and historical artifact validation after a third rebase. Negative cases reject
corrupt replay inputs, duplicate sources, unrelated endpoints, and changed
selection identity. The real saved manifest admits round 2 using an in-memory
copy without changing its bytes. One intermediate extraction dropped the cycle
check at a historical endpoint; the existing regression caught it and traversal
now retains cycle validation while returning the requested endpoint's count.
Provider completion legitimately charges elapsed time; admission itself does
not reset cumulative usage, and all provider/repair limits remain unchanged.
