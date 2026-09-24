# Exact-tree campaign carry after a main merge (BUI-973)

Status: accepted after independent design review; delivery verification pending.

## Requirement and cause

An interrupted campaign must survive integration of a separately reviewed
upstream fix without rewriting the published branch or losing campaign history.
PR #651 integrated #652 by a normal merge. Its unchanged candidate patch has a
new protected base, but `advanceHead` proves base replay only for non-descendant
heads. A merge is a descendant, so final identity validation refuses it.

## Decision

Reuse the existing binary-patch replay and exact-tree comparison when either
the head is not a descendant or its merge-base differs from the effective
bound base. Record the existing base/review carry only when that comparison
succeeds. Do not add a new schema, authority, replay algorithm, or bypass.
Ordinary descendant changes on the same base retain their current behavior.

The effective bound base and replay's prior base are the same commit. An
existing carry remains applicable when its head is an ancestor of the prior
head, including intervening ordinary content commits. This is already the
`isAncestorOf(root, carried.head, priorHead)` rule in `isRebaseOnlyReplay`.
Do not replace it with an exact-head equality check. The existing merge lease
must still compare the carried base with the live protected remote base;
a local base reference alone cannot authorize integration.

The history shape is not the trust condition. The prior candidate patch,
replayed on the new protected base, must produce exactly the candidate tree.
A changed patch, conflict resolution that changes candidate content, failed
replay, or unknown base is refused. Separate such content changes from the
base integration before retrying through the supported workflow.

Commit and advance a base-only integration before making new candidate edits.
A combined integration-plus-content push is intentionally not accepted as a
review carry; refusal must leave the campaign unchanged. This slice does not
add a new recovery grant for that combined shape.

## Invariants

- Keep the original invocation ID, namespace, immutable creation base, failed
  terminal history, and cumulative provider accounting.
- Preserve existing active-owner and active-execution refusal checks.
- Use the established carry path to rebind the effective base and lease;
  validate identity again in the same manifest transaction.
- Invalidate exact-head human approval. Carry does not grant new permission.
- Require existing current-head tests, review coverage, freshness, and CI.
  This does not authorize force-push or convert failed proof to success.

## Alternatives and rollback

Force-rebase the published PR: unnecessary history rewriting and a separate
authority boundary. Restart the campaign: loses the intended continuity.
Accept every descendant merge: unsafe because ancestry does not prove content.
Keep rejecting merges: prevents ordinary non-force integration.

Rollback is a normal revert. Older readers understand the existing carry
schema; no durable data migration or automatic cleanup is introduced.

## Verification

Exercise the public `advance` command. A normal merge must reproduce the old
base-identity failure before the fix. Both rebase and merge must then prove
two successive exact-tree carries and invalidate approval. Add a changed-patch
merge control that fails without modifying the manifest. Run existing
invocation/rebase/lease coverage and independent exact-head delivery review.

## Independent design review

Claude Opus 5.5, high effort, native tools disabled, reviewed the proposed
decision on 2026-09-24. The conditional concern was whether carry applicability
required head equality. Source inspection refutes that condition: it uses
ancestry. The clarification above and an intervening-content regression retain
that invariant. No other blocking design defect was reported. This is advisory
design evidence, not signed merge approval. Two prior Sol/high attempts timed
out without a verdict and are not counted as approvals.

Retain the existing mandatory current-head gate, CI, remote-base, ownership and
budget checks. Test unchanged manifest bytes on failed replay. Evidence reuse
must remain governed by the existing exact command/source/tree contract, not
by ancestry alone. No blanket pass is introduced for multiple-base or
non-monotonic history; those require explicit refusal or separate proof.
