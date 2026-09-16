# ADR: Recover same-HEAD terminal merge blocks with a signed capability

## Status

Accepted for BUI-795 and amended for BUI-801. Implementation must receive a
bounded adversarial review before merge.

## Context

Quality persists one write-once `terminalState` to prevent cleanup and signal
races from relabeling a campaign. That correctly protects completed, stale,
gate-failed, and review-failed outcomes. It also prevents the documented
same-manifest recovery path when an external condition changes after a merge
admission block. In particular, an exact-head Actions billing failure can be
classified later and a signed capability can be attached, but the public runner
returns the cached `blocked` state before it evaluates that capability.

The direct merge phase already validates the signed capability, exact PR/base/
HEAD identity, review coverage, deterministic gates, and merge lease. The
public runner must reach that phase without making ordinary terminal states
re-enterable.

## Decision

Add one recovery transition owned by `quality-invocation.js` and called only by
the public runner before its terminal short-circuit.

The transition is eligible only when all of these conditions hold:

1. The campaign is a merge campaign and its current terminal state is `blocked`.
2. The terminal record is for the current exact HEAD.
3. The terminal record carries a persisted, typed `mergeAdmissionCondition`
   that was written atomically with the blocked terminal state by the merge-
   admission boundary. The admission evidence and terminal record share the
   current terminal epoch and one unique merge-attempt ID. A pending HEAD-only
   admission record is never copied into a later terminal cause. The condition
   must be one of the exact condition IDs in the signed
   capability: `ci:failed` for the billing path, or
   `base:protected-nonstrict` and `pr:non-atomic-state` for ref-CAS. Generic
   shell exit text is never an admission predicate.
4. The manifest has a currently valid, exact-identity signed capability with
   either the CI-billing scope or the protected non-strict ref-CAS scope.
5. Exact-head deterministic gate and review evidence remains valid.

On success, append the original terminal record to `terminalHistory` with a
`superseded-by-capability` disposition and a new recovery event that identifies
the signed scope. Replace the active state with a fenced `recovering` sentinel;
do not leave an open terminal slot. The transition increments the manifest's
`terminalEpoch`. Every runner-owned terminal writer carries the epoch it read at
startup, and the recorder rejects a stale epoch. The new runner alone treats a
matching `recovering` sentinel as resumable; all prior runners still short-
circuit on it. The existing deterministic phases reuse exact-head evidence and
then proceed to normal merge authorization. No provider, gate, or review budget
is reset.

All other terminal states remain immutable. Invalid, expired, wrong-PR,
wrong-base, wrong-HEAD, incomplete-condition, gate-failed, review-incomplete,
stale, and merged campaigns refuse recovery.

A separate fix-round rule applies when HEAD advances. A `blocked` record bound
to the prior head is archived only after the runtime proves that the new head
is its descendant or an accepted rebase-only replay. The runtime increments
the terminal epoch, clears the prior merge-admission block, and reruns the
required descendant evidence. This is not same-head capability recovery, and
it does not reopen any other terminal class. The same reconciliation repairs a
legacy manifest whose current head advanced before its prior-head block was
cleared.

The active execution deadline is also exact-HEAD scoped. A proven descendant
archives the prior head's active and gate usage and receives a complete active
gate allowance. Provider seconds, provider attempts, review rounds, and fix
count stay cumulative across the campaign lineage. This lets the fixed head
run its required deterministic suite without minting additional model capacity
or weakening the 15-minute deadline for any one revision.

A separate same-HEAD resolution applies when the only terminal admission
condition is `ci:failed` and GitHub later reports current green CI for the exact
open PR and HEAD. The runtime reads the PR and all registered checks itself. It
requires at least one check and accepts only `SUCCESS`, `SKIPPED`, or `NEUTRAL`.
It then archives the original terminal record as `resolved-by-green-ci`, records
the check count and exact HEAD, increments the terminal epoch, and clears only
the matching CI admission block. It does not reset gates, reviews, counters, or
budgets. Any other terminal condition still requires its existing signed
capability or remains terminal. Final merge authorization reads the live PR,
HEAD, base, and CI again, so this resolution cannot authorize a merge by itself.

## Alternatives

### Make every blocked campaign resumable

Rejected. A signed capability for CI cannot authorize a failed test, stale
identity, malformed evidence, or code finding.

### Require a no-op descendant commit

Rejected. It changes PR history solely to work around runtime state and forces
unnecessary gate/review work.

### Call the merge script directly after approval

Rejected as the public recovery contract. It duplicates orchestration routing
at callers and leaves the public runner inconsistent with its documented resume
command.

## Invariants

1. Terminal history is append-only.
2. A terminal write is accepted only for the current terminal epoch. Recovery
   cannot let a pre-recovery writer overwrite its later result.
3. A capability is exact to repository, invocation, PR, base, and HEAD.
4. Recovery cannot mutate or waive existing gate/review evidence.
5. Recovery never resets counters, provider attempts, or active-time budget.
6. Merged, superseded, interrupted, provider-incomplete, provider-contract,
   gate-failed, and identity-failed campaigns do not reopen through this
   merge-admission transition. BUI-922 adds a separate, narrowly typed
   [accepted mutation-failure transition](ADR-test-remediation-mutation-recovery.md)
   that resumes unfinished phases and does not waive review or CI.
7. The only merge authority remains `quality-stamp-and-merge.sh`.
8. Telemetry records each terminal state once per terminal epoch. Legacy
   records without an epoch are epoch zero; later recovery outcomes cannot be
   collapsed into an earlier terminal event with the same state name.
9. Exit status 2 from CI budget admission means a valid policy denial. Policy
   validation, provider, parse, and internal failures use exit status 1 and are
   not eligible for billing-denial recovery.
10. A proven descendant may supersede only a prior-head `blocked` record. The
    prior record stays in terminal history, and the epoch advance fences every
    writer from the old head.
11. Every exact head has one active execution allowance. Head advancement
    archives prior gate usage but never resets provider usage, provider starts,
    review rounds, or fix-count limits.
12. Repository gate processes do not inherit the outer terminal epoch,
    repository lease credential, or review and approval signing keys. Those
    values remain available only to runner-owned orchestration processes.
13. A resolved CI admission block requires an open PR at the persisted exact
    HEAD and at least one current registered green check. The final merge gate
    revalidates that external evidence before mutation.

## Rollback

The transition is additive. A recovered campaign retains its `recovering`
sentinel until a new epoch-bound outcome replaces it, so a rollback restores
the prior runner's terminal short-circuit even if a process stops between
recovery and merge. No existing manifest is rewritten until a signed recovery
is actually used.

## Verification

- A merge-admission block with a valid exact CI-billing capability resumes the
  same manifest and merges without rerunning successful gates or review.
- A valid protected non-strict capability has the same behavior.
- Expired, wrong-identity, incomplete, wrong-scope, non-merge, non-merge-detail,
  gate-failed, provider-incomplete, merged, and stale terminal states remain
  terminal.
- The original terminal record and recovery event persist in `terminalHistory`.
- A stale pre-recovery terminal writer cannot overwrite the recovery result;
  an old runner treats an interrupted recovery as terminal.
- A malformed CI policy and a provider failure cannot produce `ci:failed`.
- A stale pending admission record cannot attach to a later gate failure.
