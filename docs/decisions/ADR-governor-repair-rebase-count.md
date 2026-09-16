# Preserve repair counts across exact rebases

Tracking: BUI-925. Status: accepted after independent Sol/high review.

## Diagnosis

The original saved campaign reproduces `null !== 1` through
`resolveCommitCount`, without writing its manifest. Ranked hypotheses:
missing numerical bounds (refuted: all required bounds are finite), wrong Git
checkout (refuted: manifest repo and current candidate agree), and an unhandled
ancestry interval before the first carry (confirmed: exactly one repair).
The initial minimized regression had 2 failed / 6 passed; after adding design
counterexamples the baseline is 4 failed / 8 passed (12 tests, before code).
One test reproduces the public CLI's misleading missing-fields stop.

## Decision

Keep the original campaign baseline and all execution/review limits. Extend
the existing governor commit-count seam to sum ordinary ancestry intervals
between validated rebase carries. A carry itself consumes zero repair commits;
repairs before, between, and after carries retain their original count.

The caller already validates manifest carry proofs. This module consumes that
trusted chain; it does not manufacture replay proof or mutate the manifest.
For an orphaned baseline, require one unique eligible carry source: exact
identity or a descendant of the current baseline. Exact matches have no priority
over descendants; both present means ambiguity. Count
the ancestor-to-source interval, jump to its target, and repeat. Multiple
eligible sources are ambiguous and fail closed. Exact-source duplicates,
cycles, missing objects, backward/divergent intervals and a chain that cannot
reach current HEAD fail closed. Never match abbreviated carry identities.
Each interval used during orphaned-baseline recovery must be linear (no merge
commits in the ancestor-to-source or final target-to-HEAD interval); otherwise
fail closed instead of counting merged upstream history. The direct-ancestor
path remains unchanged, including its existing conservative merge counting and
ignoring unused carry metadata. The new topology validation contract applies
only to orphaned-baseline recovery. Bound traversal by carry count.

Reuse the same count proof for the existing mandatory delta-review eligibility
check, which currently demands direct ancestry from the previous review head.
This changes only its ancestry proof: all existing review-count, round-cap,
provider-time and active-time prerequisites remain. A count of zero or more
proves reachable lineage; null refuses. It does not authorize another fix or
another round. The public manifest authorization test must reproduce one
consumed repair followed by rebase and permit only the already reserved round.

## Alternatives

- Reset the baseline to current HEAD: rejected; erases consumed repairs.
- Use total commit counts: rejected; includes unrelated protected-base work.
- Require exact equality only: existing behavior; cannot resume after a repair
  followed by a rebase, despite validated exact replay.
- Create another manifest: rejected; discards campaign continuity and budgets.

## Invariants

- One repair plus two rebases still costs one repair.
- During orphaned recovery, additional linear repairs increase the count;
  protected-base commits introduced by a carry do not. Merge intervals refuse.
- Existing round, time, commit, lease and exact-head checks remain required.
- Unknown or ambiguous topology never produces a zero-cost success.
- No persisted schema change or historical artifact rewrite.

## Rollback and verification

Rollback restores conservative refusal; it must not reset campaign state.
Use real Git repositories through the existing exported commit-count interface
and public governor CLI. Cover zero/one/multiple repairs, repeated rebases,
intermediate repairs, direct history, duplicates, cycles, divergence and missing
objects. Confirm the real saved campaign returns one without changing its bytes.
Explicit scenarios: exact plus descendant sources refuse; duplicate sources
refuse; merge in an intermediate source interval refuses; merge in the final
target-to-HEAD interval refuses; direct-ancestor counting with invalid unused
carry metadata remains unchanged. Exercise both public CLI counting and the
existing manifest-bound reserved delta-review authorization and its round cap.
Run selected tests and protected quality before using this runtime to recover it.

## Architecture review history

Initial Sol/high review returned three blockers: exact-match precedence could
skip a consumed interval, merged ancestry could include unrelated upstream
commits, and the fail-closed wording overstated unchanged direct-path behavior.
The revised decision requires unique eligibility across exact and descendant
sources, refuses non-linear recovery intervals, and explicitly scopes topology
checks to orphaned recovery. Second review requested precise test scenarios and
current red counts; those are now explicit above. This third review also covers
the caller trace to mandatory delta-review eligibility. Third review returned
CLEAN before production edits. One initial CLI cap assertion used round 1,
where the existing initial-review exception correctly allows review; corrected
the fixture to round 2 rather than changing that policy.

The initial code review found a separate exact-head binding defect: the reused
count proof targeted ambient checkout HEAD instead of the manifest revision.
A public authorization regression failed (1 failed, 295 skipped) when these
heads differed. The count interface now accepts an explicit endpoint, and both
manifest review-budget callers use the bound revision. Legacy callers retain
the HEAD default. The focused recovery and authorization checks now pass
(15 passed, 294 skipped). This repair does not change campaign limits.
