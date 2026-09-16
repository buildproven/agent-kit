# PR-scoped campaign ownership and repository-scoped merge exclusion

Tracking: BUI-919 and BUI-920. Status: accepted after bounded Sol/high ADR review.

The initial source-heavy review timed out without a verdict. The subsequent
ADR-only review returned CLEAN before production implementation. Public
same-repository, different-PR ownership test fails on the protected baseline
(1 failed /58 skipped); it reproduces the serialization defect directly.

## Requirements and diagnosis

Two different PRs in one repository must be able to run exact-head gates and
reviews concurrently. Two campaigns for the same PR must remain mutually
exclusive. Ref mutations and ambiguous ref outcomes must remain serialized.
Preserve campaign manifests, consumed budgets, evidence, tokens and recovery
history. No GitHub plan change, merge queue, batch evidence, weaker test plan,
or cross-PR evidence reuse is part of this change.

The existing `quality-repo-lease.js` already has a long-lived `.lease`, a short
`.metadata-guard`, and a short `.merge-guard`. `pathsFor` keys all three by the
repository. Gate and review writers require the long-lived token/generation
through `withManifestLock`; removing bootstrap acquisition loses stale-writer
fencing. The problem is the scope of ownership, not a missing lock primitive.

## Decision

Reuse the current lease protocol. Scope the long-lived ownership path by
normalized repository identity and positive PR number. The merge guard and
protocol/namespace transaction guard retain their repository paths. Worktree
ownership and compute admission still apply independently.

### Wiring correction: metadata locking also needs the PR scope

Source tracing found `gate-run -> mutate -> withManifestLock ->
withManifestMutation -> withMetadataGuard` holds the metadata guard while
`runGate/executeGate` waits for the test child. A lease-path-only split still
serializes gates. A public two-process fenced-callback overlap test covers this.

For scoped campaigns, reuse the same metadata-guard primitive at a PR-scoped
path for manifest mutation and execution. Legacy credentials retain the old
repository metadata path. The scoped guard stays held across gate callbacks,
so recovery/token rotation for that PR cannot race a writer. Other PRs can run.

Ownership acquisition/replacement/release, protocol activation/rollback, and
merge-guard publication/cleanup additionally take the original repository
transaction guard for their short namespace changes. Lock order is always PR
guard then repository transaction guard, never the reverse. Legacy operations
already holding the repository guard do not acquire a PR guard during upgrade;
their credential transition finishes entirely within that repository transaction
before new scoped operations start. Existing reentrant guard detection must
recognize the correct held path, not bypass a missing guard after scope changes.

No gate/provider callback or network ref update runs under the repository
transaction guard in scoped mode. Rollback requires every scoped owner record
released and no merge guard, checks/removes only validated owner records, and
never deletes a PR metadata guard held by another process. A concurrent new
acquisition must wait for the repository transaction and recheck the protocol
marker before publishing an active owner. Ref mutation retains its shared merge
guard and all existing exact-head/protection checks. The bounded ADR correction
review returned CLEAN before its lock-scope implementation. The overlap test
failed before that correction (1 failed /64 skipped); after it all 65 lease
tests pass, including the real legacy-runtime compatibility tests.

Further public tests cover actual `gate-run` overlap with separate exact-head
success records and charged execution budgets; concurrent `performMerge` calls
reach the simulated remote ref writer only once, for both confirmed and unknown
outcomes. Unknown outcomes retain the shared guard when unrelated ownership is
released. Activation crashes before and after marker publication recover through
the real prior runtime without admitting incompatible writers.

Marker validation applies before every scoped mutation and recovery, including a
successor without a credential. Five regression cases failed before marker and
released-owner recovery corrections; a further four stale-successor cases failed
before validating the marker from an existing scoped record. Released owners can
only reacquire through the normal higher-generation ownership path, not recovery.
Test setup failures (error-text expectations and cleanup masking the stale-token
regression) were corrected before recording those behavioral red counts.

Persist an explicit PR scope/version in new lease credentials and owner
records. Derive paths from validated identity and persisted scope, never an
arbitrary path in a manifest. A shared selector handles acquisition, verification,
renewal, fenced manifest mutation, recovery, status and release. Scope must not
change during verification or silently fall back when a scoped record is missing.
New credentials use `scope: pull-request-v2`; the compatibility marker uses
schema version 2. Released scoped owner records stay as durable receipts until
reacquisition or explicit protocol rollback. Reacquisition atomically replaces
that record with a higher-generation pending owner, then updates its manifest.
Thus a missing record cannot be recreated solely from an old token, and a crash
does not erase the proof of release. Status reports `released`, not `missing`,
and never reports a released owner as active. Legacy scoped transitions retain
the previous credential in the manifest history; budgets and evidence do not move.
Same-PR collision, token rotation, dead-owner rules and exact tuple matching
remain unchanged. Distinct PRs receive distinct credentials and can run gates.

The shared merge guard remains the only ref-update exclusion boundary. It binds
repository, PR, exact head/base, token and existing mode/protection/check intent.
The ref-update path repeats all current live checks and expected-old-SHA checks
inside that guard. A base that moved requires normal exact-head recovery, not
automatic evidence reuse. Unknown outcomes quarantine that repository's merge
guard, but do not stop independent PR gates.

Every guard cleanup must prove it owns that guard. In particular, acquisition's
released/orphaned-lease cleanup currently removes a repository merge guard
without an owner match. Replace that assumption before enabling PR ownership.
Ordinary release/recovery of PR A must not remove, rotate, or treat PR B's merge
guard as A's. A's own started/unknown request stays quarantined. A foreign guard
may prevent another merge, not unrelated ownership acquisition or gate writes.

## Mixed-version transition

Old runtimes know only the repository lease and can remove guards in their
orphan/released cleanup path. Merely adding PR paths would therefore be unsafe.

Use the existing repository lease location as a durable protocol marker after
legacy ownership drains. The marker has a new schema version, not an ordinary
released owner. The supported legacy reader rejects unknown schema versions
before orphan cleanup or mutation. This fences old clients using the same
repository metadata guard; no new lock framework is needed.

Under that metadata guard, activation requires no active/rotation-pending legacy
owner and no unresolved merge guard. If a legacy campaign is active, preserve
its current mode and allow its exact-token resume; new PR-scoped admission waits
with an actionable legacy-owner message. Never seize or migrate a live legacy
owner. Clean up a released legacy owner only through its existing proved owner
and remote-outcome rules, then atomically publish the marker. A crash before or
during marker publication fails closed and has a documented exact-state recovery.

After activation, an inactive saved legacy campaign may reacquire ownership at
its PR path through ordinary same-manifest bootstrap. Record that credential
transition explicitly; keep invocation ID, start head, all evidence and all
budget history. Never reinterpret a missing scoped lease as permission to
recreate it from a presented token. Existing stale-writer checks still apply.

Unknown marker/scope versions, malformed records, symlinks, or inconsistent
repository/PR identity fail closed. A legacy runtime attempting acquire, verify,
recover, release or merge against the marker must leave marker, PR records and
any merge guard byte-for-byte unchanged.

## Rollback

Code rollback alone must refuse scoped campaigns instead of reverting to
repository ownership. Keep the protocol marker until all scoped owners are
released and the merge guard is absent. A bounded explicit protocol rollback
operation, under the shared metadata guard, may then remove only that marker.
It preserves campaign artifacts and audit history. Concurrent activation or
legacy admission must serialize on the same guard. No directory-wide deletion,
manual token rewriting, or automatic downgrade is permitted.

## Evidence required before acceptance

Local candidate checkpoint, 2026-09-16: 536 tests across the seven selected
lease/invocation/merge/runner suites passed (371.37 seconds). Command-reference
check and changed-source lint passed. Merge fixtures now carry the same required
positive PR identity as production bootstrap. The released-status expectation
now checks the retained receipt and refuses stale-owner recovery guidance.
This is local evidence only; protected quality, CI and rollout remain required.

- Two public bootstrap/lease paths for distinct PRs acquire and run concurrent
  gated work; same-PR ownership still refuses another owner.
- Tokens cannot cross PRs, and rotated tokens cannot write either manifest.
- Concurrent merge attempts: only one reaches the ref writer; stale base is
  rejected and unknown outcome keeps exclusion until exact reconciliation.
- Releasing/recovering/orphan-cleaning A while B owns a merge guard preserves
  B's guard bytes and lets B finish. A's own ambiguous request remains blocked.
- Test both mixed-version orders using the prior runtime, not a mock imitation:
  legacy active first, and scoped activation first. Include released/orphaned
  legacy records, stale credentials and a live foreign merge guard.
- Crash at marker publication and token-rotation write boundaries; resume the
  exact manifest without lost history, extra budget, or duplicate ref writes.
- Rollback refuses active ownership/merge state, and succeeds only after drain;
  legacy runtime can then start normally while saved artifacts remain intact.
- Re-run full lease/merge/invocation gates and red-capable concurrency tests.
  Measure concurrent wall time separately from summed active execution; do not
  claim fleet speed or SOTA from unit tests alone.

## Alternatives

Removing bootstrap ownership loses writer fencing. Per-PR merge guards allow
ref races. A second independent lease framework duplicates recovery machinery.
GitHub merge queue does not cover all fleet repository/account shapes. Batching
changes evidence semantics and is unnecessary for this scope. All are rejected.
