# ADR: Repository-scoped quality merge lease

## Status

Accepted for BUI-572 after an independent high-reasoning architecture review
found no unresolved correctness defect.

The BUI-709 recovery amendment below is accepted after an independent
high-reasoning architecture review found no unresolved correctness defect.

The protected non-strict amendment below is accepted. A final independent
Claude Opus 5 high-reasoning review of exact implementation head
`7a0d712c038397d6713ba8f03c2157daf7e5fff7` found no unresolved material
authorization, recovery, or race defect after all review findings were fixed.

## Context

BuildProven protects `main` with strict required status checks. That is the
correct safety boundary: a pull request may merge only after its exact head is
tested against the current protected base. GitHub's native merge queue is not
available for this private repository on its current organization plan, and
dropping strict freshness would restore stale-base merge risk.

The quality runtime currently owns only a branch worktree lock. Two campaigns
for different branches in the same repository can therefore run concurrently,
both pass against one base, and race to merge. The first merge advances `main`;
the loser becomes behind and must rebase and repeat CI. A fast fleet can make
the same campaign lose repeatedly.

The scarce resource is not repository-wide testing. Independent branches may
run local checks and review concurrently. The scarce resource is a stable
protected base from the moment a merge campaign binds its evidence until that
campaign merges or terminates.

## Decision

Add a repository-scoped merge lease to the public quality runtime.

1. Every fresh `--merge` campaign creates its immutable invocation manifest,
   then acquires the lease before any deterministic gate or provider call.
   Review-only campaigns do not acquire it.
2. The lease is keyed by normalized protected GitHub repository identity, not a
   checkout path. Independent clones and linked worktrees on the same operator
   host therefore serialize, while unrelated remote repositories remain
   parallel. The Git common directory remains owner-validation metadata only.
3. Acquisition is atomic and bounded. A contender waits for the current owner
   to merge or reach an explicit terminal state. Timeout reports the exact
   owner, pull request, branch, manifest, and recovery command; it never steals
   a live lease or weakens freshness.
4. Immediately after acquisition, fresh bootstrap refreshes the protected base. If
   it differs from the manifest's bound base, bootstrap stops before running
   tests and retains the lease. The owner rebases onto that exact base, pushes,
   and resumes the same manifest. Resume first captures the live protected base
   while the lease is held, then runs the existing `advance` transition so its
   exact replay proof can persist `baseRebaseCarry` and update `baseHeadSha`, and
   only then compares that updated anchor with the captured base. A mismatch at
   that point stops again. This ordering binds the new head/base without granting
   a fresh provider or gate budget. Because the campaign still owns the lease,
   no other quality merge can move the base during revalidation.
5. Manifest resume reacquires idempotently only when the complete owner tuple
   matches: normalized repository identity, invocation ID, canonical manifest
   path, canonical Git common directory, and manifest fencing token. An equal
   deterministic invocation ID from another clone is a collision, not the
   owner. Resume renews the lease and follows the ordered transition above.
6. Acquisition creates a random fencing token and persists the same token in
   the lease record and invocation manifest. Bootstrap/resume, every long gate,
   mutation check, provider review, CI wait, stamp publication, and final merge
   authorization receive that token as an immutable per-process credential and
   validate the presented value before and after their phase. A phase never
   reloads its credential from the mutable manifest; a suspended old process
   therefore continues presenting the old value after recovery rotates shared
   state and is fenced. Every manifest mutation for a merge campaign—including
   governor accounting, evidence publication, terminal-state recording, and
   lease resumability/disposition—first acquires the repository metadata guard,
   then the manifest mutation lock, and validates that pinned credential while
   holding both immediately before its atomic write.
   Phase entry/exit checks supplement this mutation boundary; they do not
   replace it. Post-merge cleanup uses the same phase-pinned credential and
   surfaces fencing rejection; it never replaces an inherited credential from
   the mutable manifest. The remote
   merge is additionally enclosed by a repository-scoped operation guard. The
   owner acquires that guard atomically with its final token validation, then
   revalidates the live base while holding it, performs the synchronous GitHub
   merge, and releases the guard under the same metadata linearization point
   only after authoritative read-back. A guarded admin merge records that fact
   and its validated CI-billing-waiver reason so an ambiguous quarantine keeps
   its audit context. Recovery
   checks for the same guard while holding the metadata guard, so token rotation
   and entry into the merge critical section have one linearized order. No local
   token check is mistaken for server fencing.
7. Lease lifecycle is explicit and separate from the manifest's write-once
   `terminalState`. The lease record has `active`, `rotation-pending`, and
   `released` dispositions. An observed and verified remote PR merge releases
   an exact active lease even if an earlier diagnostic terminal state remains
   `blocked`; that historical outcome is never relabelled. Explicitly
   non-reenterable outcomes and `verified-unmerged` also release. Parsed
   provider output that is incomplete or violates the review contract remains
   resumable while the governor has an authorized same-range retry. Only a
   `provider-incomplete` terminal state recorded after that bounded retry is
   exhausted is non-reenterable and releases immediately. A
   blocked, interrupted, or timed-out campaign retains the lease for exact
   manifest resumption and eventually requires the explicit stale-owner
   recovery path if abandoned. Release decisions never infer merge success
   merely from a terminal label.
8. Crash recovery is conservative. Lease state lives outside versioned files
   in one fixed per-operator namespace derived from the operating-system account
   record for the effective UID (Node `os.userInfo()`, not `HOME`,
   `XDG_STATE_HOME`, or another caller environment variable), plus
   `.local/state/agent-kit/repository-leases`. `TMPDIR`, checkout location, and
   caller environment cannot select another production namespace; canonical account home,
   owner UID, and directory modes are validated before use. A different invocation may
   reclaim automatically only from a final owner manifest. A six-hour-old
   resumable owner is reported as stale but requires an explicit recovery
   command explicitly confirming the current owner; credentials are never
   printed in status or command output. The lease record is authoritative
   and token acquisition/rotation uses a recoverable state machine: create the
   record as `rotation-pending` with old/new token metadata, persist the new
   token and generation to the exact manifest under its lock, then atomically
   publish the record as `active`. Verification denies all work while a record
   is pending. The exact owner may reconcile a pending initial acquisition;
   explicit recovery may reconcile a pending rotation after proving the
   manifest contains either its recorded old or new generation. Automated tests
   may use a repository-local namespace only when the manifest has a reserved
   `vitest/<hash>` repository identity, the checkout is below the temporary
   directory, and a non-symlink sentinel binds that checkout to the manifest's
   repository key. Ambient test variables alone cannot redirect a real
   repository lease. Any other
   combination fails closed with a repair command. Recovery checks and rotates
   under the metadata guard, which fences any suspended old process that has
   not entered the merge critical section. An unsafe, malformed,
   symlinked, cross-repository, or recent owner fails closed.
9. Authoritative merge reconciliation is repository-scoped and survives removal
   of the campaign's linked worktree. The immutable manifest records the
   canonical Git common directory at campaign creation; recovery compares that
   existing directory, manifest path, invocation, pull request, head ref, and
   repository identity with the active lease record. GitHub read-back uses the
   explicit protected repository and pull request from the manifest and does
   not use the vanished checkout as ambient identity. Ordinary active phases
   still validate the live worktree exactly; only the explicit terminal
   reconciliation path may use recorded repository identity after that
   worktree is gone. A missing shared Git directory, mismatched owner tuple, or
   ambiguous GitHub result remains quarantined.
10. An incomplete provider-failure attestation is durable audit evidence, not
    a successful review checkpoint. A bounded, governor-authorized retry may
    review the same exact `from..to` range without advancing HEAD. Its artifacts
    use a distinct attempt directory; the incomplete artifact remains in the
    manifest and signed evidence chain. A later complete attestation for that
    same range supersedes the incomplete attestation only for contiguous merge
    coverage and final review status. It does not erase partial findings,
    provider usage, or failure metadata, and a second incomplete result remains
    blocking. This retry contract is distinct from a completed critical review
    that truthfully records incomplete model-family diversity. Default-governed
    campaigns reserve both provider starts and cumulative provider execution
    time for the retry; an explicit operator provider-time cap remains
    authoritative and may stop it fail-closed. A legacy manifest without cap
    provenance is treated as operator-owned and is never expanded on resume.
    Provider-start capacity is keyed by review-attempt generation as well as
    round. An initial primary/fallback path therefore cannot consume the
    separately funded same-range retry before an incomplete attestation exists;
    schema-v2 plans migrate by splitting their already-reserved round allowance
    evenly without increasing the absolute start or time caps.
11. New campaigns keep the reviewed pull-request head immutable and publish
    signed `quality-review-evidence` on that exact commit. The check-run payload
    binds the review, base, risk tier, deterministic findings, selected
    reviewers, and v2 policy/diff evidence. Publication is idempotent, so an
    interrupted run can resume without an empty commit or force-push. Required
    CI remains tied to that same candidate SHA: publication resolves required
    contexts and GitHub App IDs from classic branch protection and effective
    rulesets, maps missing contexts to the candidate's Actions workflow, and
    waits on exact-head check-runs. Final authorization verifies the signed
    evidence and required checks from the exact candidate, never the PR rollup.
    Missing mappings, unavailable required contexts, wrong-app checks,
    unsuccessful conclusions, and timeouts fail closed; no status is
    synthesized and no protection is bypassed. Existing campaigns with a
    persisted empty stamp remain supported through the legacy path so they can
    finish without creating another stamp. A classic protection read may be
    empty only for GitHub's explicit `404 Branch not protected` response.
    Ruleset reads and every other API failure remain hard errors, so a partial
    observation cannot silently shrink the required set. A plan-proven
    unprotectable repository has no required-context source, so it retains the
    separate all-registered-PR-check waiter and final guard.

## Protected non-strict ref-CAS amendment

### Problem

Some protected repositories deliberately require exact-head status checks with
GitHub's `strict` option disabled. The current authorizer blocks every normal
merge because GitHub supplies no atomic base boundary. The fleet policy retains
that setting, so green CI alone cannot complete delivery. The same problem also
blocks the separately signed billing-outage path after the operator has accepted
unavailable CI for one exact PR and head.

A pull-request merge accepts an expected head SHA but no expected base SHA. A
local lease and final read cannot make that operation atomic against another
host. GitHub's Git-reference API does provide the missing server primitive: a
non-force update succeeds only when it is a fast-forward. The exact reviewed
head already exists on the remote and must descend from the manifest's exact
base. Updating the base ref to that head with `force: false` therefore acts as a
server-side compare-and-swap. Any intervening divergent base advance returns a
conflict. GitHub documents both the
[non-force update contract](https://docs.github.com/en/rest/git/refs#update-a-reference)
and that a pull request is marked merged when its head becomes reachable from
its base through an
[indirect merge](https://docs.github.com/en/pull-requests/reference/pull-request-merges#indirect-merges).

An empirical conformance probe on 2026-08-21 created one temporary branch at
`122419a3c76f1c5f4eb28e5ec7998ccbd64ae9fa`, fast-forwarded it to competing
commit `77284a17c5d2a2ea25ae5827a73577c3eb0e34fa`, then requested a divergent
update to `5ae6f3572cd2e60f04cf28c47abe41795b287c48` with `force: false`. GitHub
returned HTTP 422 with `Update is not a fast forward`; read-back retained the
competing SHA. The exact probe ref was deleted and its absence verified. This
observed contract is a required regression fixture; an unexpected response is
ambiguous and quarantined, never normalized to success.

A second probe used the exact operational shape: a temporary classic-protected
branch with one unsatisfied GitHub Actions-bound required check, `strict: false`,
and administrator enforcement disabled. The authenticated administrator's
`force: false` fast-forward to
`77284a17c5d2a2ea25ae5827a73577c3eb0e34fa` returned HTTP 200 despite the
missing check. A divergent update to
`5ae6f3572cd2e60f04cf28c47abe41795b287c48` returned the same exact HTTP 422
non-fast-forward message and retained the competing SHA. The temporary
protection and exact branch were deleted, and branch absence was verified.

### Decision

Add `protected-nonstrict-ref-cas` as an explicit merge mode.
It uses the existing repository lease and merge-operation guard, but replaces
the administrator pull-request merge request with one non-force Git-reference
update to the exact reviewed head. A clean campaign with autonomous merge
authority uses this transaction without a per-PR human prompt only when the
repository commits
`scorePolicy.protectedNonstrictRefCas="accept-non-atomic-pr-state"`. That
policy is the durable owner acceptance that a concurrent PR close or retarget
cannot be atomically bound to the ref update. Resolve it only from the exact
protected-base commit, persist the source SHA, and re-read that revision at the
mutation boundary. Resolve `mergeAuthority` from the same base revision; a
candidate-head policy change cannot authorize itself or remove base-owned
manual governance. The
lease still rechecks complete review and gates, green required CI, the closed
protection contract,
exact identity, conversations, and ancestry. An outage or incomplete review
still requires the signed ref-CAS capability and its exact condition evidence.
Separate single-scope capabilities cannot overwrite each other safely.

1. Read the complete classic branch-protection and effective-rules responses
   with separate exit status and body capture. The first implementation accepts
   only one complete classic rule with non-empty required checks, explicit
   `strict: false`, no effective rulesets, unlocked base, no required commit
   signatures, no push restrictions, and no required human approval. Required
   conversation resolution is allowed only when a complete, unpaginated
   GraphQL read of the exact pull request proves every review thread resolved
   immediately before the guarded mutation. A missing connection, pagination,
   query error, or unresolved thread blocks. Required linear history is allowed
   because the
   base moves directly to its descendant head without a merge commit. A review
   object is allowed only when `required_approving_review_count` is zero,
   `require_code_owner_reviews` and `require_last_push_approval` are false,
   dismissal restrictions and bypass allowances are absent or empty, and every
   remaining subfield has a recognized inert value. `dismiss_stale_reviews` can
   be either boolean because no approval exists to dismiss. `allow_force_pushes`,
   `allow_deletions`, and `block_creations` must be explicitly disabled;
   `allow_fork_syncing` must be absent or explicitly disabled. Validate every
   known protection field from a closed schema; an unknown field, missing field,
   empty check set, API error, pagination, ruleset, or unsupported protection
   remains blocked.
2. Require the authenticated actor to be a repository administrator and require
   classic administrator enforcement to be explicitly disabled. Candidate
   files, environment variables, and capabilities for another scope cannot
   select this mode.
3. Require the remote pull request to be open and to match the manifest's
   repository, number, base ref, head ref, base SHA, and head SHA. Prove with
   `git merge-base --is-ancestor` that the exact head is a descendant of the
   exact base. After acquiring the merge-operation guard, re-read the live base
   ref and require exact equality with the manifest base immediately before the
   update call. Re-read the complete protection contract and compare its digest
   in that same guarded pre-request phase.
4. Add a distinct signed `operator-nonstrict-refcas-override` capability for
   exception cases. The wrapper flag requires the exact accepted conditions `ci:failed`,
   `base:protected-nonstrict`, and `pr:non-atomic-state`; separate
   acknowledgements for unavailable CI, the administrator ref mutation, and
   the close/retarget race; the exact PR/head/base/invocation identity,
   and failed-job evidence proving no runner and no steps. An existing
   `operator-ci-billing-override` cannot satisfy this scope. The new scope does
   not accept a present signature, human review, restriction, lock, or other
   non-CI requirement; the closed classifier must prove those requirements
   absent. A required-conversation rule is satisfied only by the separate
   complete live thread proof above; the capability never stands in for it. The
   authorizer still resolves and
   records the configured required-check names and App bindings so the exception
   cannot silently widen to another check contract. Every waived required check
   must be bound to the GitHub Actions App; a check owned by another App blocks
   the outage path. The signed capability carries the complete ordered
   check/App binding. This is signed authority for direct immutable-head
   integration. The immediate open-PR check reduces accidental use but is not
   an atomic promise that a concurrent close or retarget can cancel the ref
   update. The final repository mutation boundary independently
   reloads and revalidates the capability signature, expiry with enough time
   for the bounded request, scope, exact PR/head/base/invocation,
   CI evidence digest, protection digest, and check/App binding. Caller-provided
   merge-mode flags cannot select ref-CAS by themselves. CI remains unavailable,
   never green. Capability issuance rejects a TTL shorter than the bounded ref
   request reserve. Without that capability, this mode is unreachable.
5. While holding the merge-operation guard, call GitHub's update-reference API
   for the exact base ref, exact head SHA, and `force: false`. Do not force-push,
   disable hooks, synthesize a commit, or use a caller-selected ref. When GitHub
   returns the exact observed HTTP 422 JSON message
   `Update is not a fast forward`, treat that server response as authoritative
   proof that this ref-update request was rejected without mutation. Read back
   the exact PR and ref to detect a concurrent integration of the same head. If
   the exact head is already integrated, record that outcome. Otherwise record
   `request-rejected-stale-base` with the exact HTTP status and message in the
   repository lease, release only the merge-operation guard, and
   retain the repository lease and resumable campaign for base refresh and
   revalidation. This is not a manifest terminal state, and a negative
   reachability observation is not used as terminal proof. HTTP
   409, every other 422 body, malformed output, timeout, and transport or server
   failure remain quarantined until remote read-back proves the exact head
   reachable from the base and the PR merged, or the operator recovery flow
   closes the exact PR without merge. Successful or recovered integration requires
   both that the exact head is reachable from the live base and that GitHub marks
   the exact PR and head merged. This proves the reviewed change landed; it does
   not attribute the write to this process. GitHub's indirect `merged` state is
   lifecycle evidence only; it is not independent protection evidence.
   The response classifier accepts exactly one complete HTTP response block.
   Multiple response blocks, including a `200` followed by a `422`, are
   ambiguous. The safe 422 classification also requires a non-zero synchronous
   client exit. Before releasing the short guard, read-back must succeed and
   prove the same exact PR remains open on the same head and base; unavailable,
   retargeted, closed, or otherwise changed read-back remains quarantined.
   After an accepted update, poll bounded exact PR and ref read-back because
   GitHub can expose the indirect merged state after the ref update response.
   Release the lease only when that bounded read-back proves integration. If it
   does not converge, retain the ambiguous quarantine for reconciliation.
6. Persist merge mode, protection digest, required check/App bindings, CI
   evidence digest, base SHA, head SHA, administrator mode, and billing-waiver
   reason in the merge-operation guard. Persist the ref-CAS campaign intent in
   the longer-lived repository lease before the operation starts, so releasing
   the short guard after an authoritative rejection does not downgrade later
   reconciliation to generic PR state. Terminal evidence and recovery retain
   those values. Exact merged-branch cleanup remains separate
   because indirect merge behavior need not apply repository branch-deletion
   settings.
7. Ref-CAS deliberately lands the reviewed branch history instead of creating a
   squash commit. It is valid only for an immutable-head campaign whose remote
   head is the manifest head and whose exact base is its ancestor. It never falls
   back to the strict squash path after its operation guard is created. A legacy
   stamp campaign or a repository that forbids this history shape remains
   blocked.
8. The full protection digest recheck is best-effort against administrator or
   infrastructure changes; GitHub exposes no protection-version CAS. A tighter
   rule can make the ref update fail. A looser rule cannot widen the signed
   outage capability, manifest identity, required-check contract, or non-force
   base update. Any observed unknown field or digest drift before request blocks;
   it is never merely recorded. The exact signed administrator-bypass capability
   accepts the residual post-read race for this one outage merge. Record it
   rather than claiming it is fenced.
9. Ref-CAS recovery has its own explicit release case. It requires the persisted
   mode and identity, proof that the exact head is an ancestor of or equal to the
   live base, and GitHub's merged state for that exact PR/head. The ancestry
   proof uses GitHub's compare API with the exact head as the comparison base and
   the live base SHA as the comparison head; only `ahead` or `identical` is
   accepted. It never depends on a local object store or linked worktree. It
   records `integrated-exact-head`, not
   that this process performed the write. A manual integration of the same exact
   reviewed head is therefore reconciled honestly; any different head, closed
   unmerged PR, or unreachable head remains a distinct terminal outcome. The
   exact observed non-fast-forward rejection is a separate authoritative
   no-mutation outcome for only that operation attempt. It releases the short
   operation guard only when the guard is a ref-CAS guard and the release call
   atomically records the exact HTTP 422 status and message in the lease. A
   generic or caller-asserted release remains quarantined. After this release,
   a new guard may refresh the ref-CAS head and base but cannot downgrade the
   persisted campaign intent to a generic merge mode. Guard acquire and release
   are internal mutation operations, not public CLI commands. The `not-started`
   release is valid only while the guard still proves no request started. It
   never releases the campaign lease, closes the pull
   request, or writes a non-reenterable manifest terminal state.
10. Add a ref-CAS-specific administrator proof alongside, not instead of, the
    strict proof. It requires the selected classic protection digest, explicit
    `strict: false`, explicit `enforce_admins: false`, repository administrator
    permission, and the new capability scope. The strict path retains its
    existing `ADMIN_BASE_SOURCE == ATOMIC_BASE_SOURCE` equality unchanged.
11. Branch deletion is forbidden until the operation guard records an
    authoritative terminal outcome. Cleanup then rechecks that the exact head is
    an ancestor of or equal to the live base through the same server compare
    before deleting only the exact PR head ref.

### Classification decision table

| Gate                  | Strict               | Protected non-strict ref-CAS                       | Plan-unprotectable           |
| --------------------- | -------------------- | -------------------------------------------------- | ---------------------------- |
| Exact required checks | Required             | Names and App bindings recorded                    | All registered checks        |
| Billing outage        | Signed CI capability | Add signed CI condition and exact evidence         | Existing plan-limited policy |
| Human merge authority | Configured policy    | Autonomous when fully green; signed for exceptions | Configured policy            |
| Base mutation         | PR merge API         | Non-force ref update to existing head              | PR merge API                 |
| Freshness claim       | GitHub strict        | GitHub fast-forward CAS                            | Non-atomic                   |
| Admin bypass proof    | Billing outage only  | Exact classic admin bypass                         | Existing policy              |

Both the authorizer and stamp preflight explicitly allowlist all three modes.
No `!= unprotectable` test may stand in for a decision in this table.
The implementation updates both closed preflight value lists and replaces every
negative-space protection branch in billing admission, required-check choice,
human authority, administrator proof, protection recheck, and final mutation
with an explicit case for each mode.
The new preflight value is exactly `protected-nonstrict-ref-cas`; required-check
waiting is skipped only when that capability also binds the exact outage
condition and artifact.

### Invariants

- Review, deterministic gates, mutation evidence, check names, and App bindings
  remain bound to the exact remote head. Green CI is still enforced. Only the
  signed outage form, not GitHub, authorizes proceeding without remote success.
- Only a complete supported protection response can select ref-CAS; ambiguity
  or an unsupported protection blocks.
- The ref update is never forced and can target only the manifest base ref with
  the exact manifest head.
- A billing-outage ref-CAS remains authorized only by the exact ref-CAS
  capability and exact outage evidence. A green-CI capability cannot waive CI,
  and an older CI-only capability cannot be reinterpreted.
- Revalidate the bound CI evidence artifact at the final mutation boundary.
  Missing, changed, or invalid evidence blocks the ref update even when the
  signed capability itself is otherwise valid.
- Successful read-back proves the exact head is reachable from the live base.
  GitHub's merged PR state is required for lifecycle completion but is not
  counted as a second protection proof or proof of the performing actor.

### Alternatives

- Accept a client-only non-atomic merge: rejected after Claude review identified
  authority, downgrade, evidence-binding, and recheck defects.
- Add a base-freshness CI job: improves server evidence but is still non-atomic
  at merge and cannot run during the hosted-CI outage.
- Enable GitHub strict freshness everywhere: strong, but conflicts with the
  confirmed fleet policy that retains `strict: false`.
- Use a merge queue: strong, but unavailable in some repositories and dependent
  on hosted CI.
- Use an unchecked ref-CAS for normal protected merges: rejected. The accepted
  autonomous green path requires the repository's explicit cancellation-risk
  policy and repeats review, gate, required-check/App, protection, conversation,
  identity, and ancestry checks at the mutation boundary. Any missing policy or
  exceptional evidence still needs exact signed authority.
- Push directly with Git or disable hooks: rejected. The GitHub ref API exposes
  the required non-force operation without weakening local push guards.

### Rollback and verification

Stop admission of new ref-CAS operations, retain reconciliation support until
every persisted ref-CAS merge guard reaches an authoritative outcome, and only
then remove the mode. Enabling strict freshness routes new campaigns to the
existing strict path but does not rewrite an in-flight guard.

Behavioral tests use the public merge CLI and independent mocked GitHub state.
They prove signed green-CI and outage success plus unsigned non-strict rejection; explicit
`force: false`; exact ref, base, and head binding; ancestor rejection; base race
conflict; indirect merge
read-back; protection digest drift; resolved and unresolved conversation
requirements; empty, malformed, failed, paginated, or
ruleset responses; unsupported protections; wrong App binding; stale or wrong
capability; and merge-guard recovery. The complete suite and a second clean
Claude architecture review are required before implementation is accepted.

## Lease record

The atomic lock directory contains one non-symlink JSON owner record:

- schema version;
- invocation ID and exact manifest path;
- normalized protected GitHub repository identity and canonical Git common
  directory;
- repository, pull request, and head branch;
- acquisition timestamp, authenticated `renewedAt`, monotonically increasing
  token generation, random fencing token, lifecycle disposition, and pending
  rotation metadata when applicable.

Every successful owner verification renews `renewedAt` with an atomic rewrite
of the authoritative lease record. Staleness is measured from `renewedAt`, not
initial acquisition, so a live campaign older than six hours is not reclaimable.
The manifest copy is a fenced credential, not the source of ownership truth.

Acquisition, renewal, rotation, reconciliation, and release all execute under
one short repository-scoped metadata guard. That guard is the linearization
point for reading and replacing lease generations; no code may write a lease
record outside it. Its crash recovery may reclaim only a guard whose recorded
process identity (PID plus process start identity and random nonce) is provably
absent, because metadata critical sections perform no external side effect.
Dead-owner reclamation is itself serialized by a non-recovering sibling claim;
after acquiring that claim, the reclaimer compares the complete observed guard
generation immediately before the atomic rename. A concurrent reclaimer can
therefore never rename a newly acquired guard. A crash before the rename leaves
a visible recovery claim and fails closed for operator repair; a crash after the
rename cannot admit two owners. This prevents a stale renewal from overwriting
a newer recovery generation. The mandatory global order for any path needing both
locks is metadata guard first, manifest lock second; no manifest-locked path may
attempt to acquire the metadata guard.

Release compares all identity fields, then atomically renames the validated
lease directory to a unique tombstone outside the acquisition namespace. A
new owner may acquire immediately after that rename. Cleanup unlinks the exact
non-symlink owner record and removes the exact empty tombstone directory. A
crash before the rename leaves the original recoverable lease intact; a crash
after it can leave only an inert tombstone that cannot block acquisition. It
never recursively deletes a path or follows a symlink.

The merge operation guard uses the same defensive record rules and atomic
directory acquisition. If the owner-record write fails, the creator removes
only its exact empty/partial guard; a contender whose incumbent disappears
before owner read simply retries. Its record includes the holding process,
exact PR, head, base, admin mode/reason, and request start. A contender or
recovery command never steals the guard.
Parent death alone is insufficient: ambiguous recovery reconciles the exact
PR/head and protected-base state. A deadline, safety margin, or stable negative
observation is never treated as proof that an accepted request cannot complete. The
guard is released only after GitHub exposes an authoritative terminal fact:
either the exact head is merged, the PR is closed without merge by the
operator recovery flow, which server-side prevents that request from later
merging, or the ref API returns the amendment's exact observed
`Update is not a fast forward` rejection. That exact rejection proves only
that the synchronous ref-update attempt did not mutate the base; it releases
the short operation guard while the repository lease and resumable campaign
remain active. Any other open-PR ambiguity, inconsistent, changing, or unavailable remote
state remains quarantined and blocks repository merges for operator resolution.
Status names the quarantined exact head and whether the remote request began;
the merge failure prints the explicit authoritative-reconciliation command.
That command proves the current on-disk owner with the exact invocation ID and
pull request, so it remains usable after the crashed merge process loses its
pinned credential. It still releases nothing unless GitHub proves the exact
head merged or the exact pull request closed without merge.
Post-merge cleanup treats a `false` authoritative reconciliation result as an
unreleased lease and prints that condition instead of discarding boolean output.
Missing, malformed, symlinked, or unverifiable identity
also fails closed. This conservative recovery applies only to the short merge
critical section, not to the campaign lease or its six-hour policy.

## Invariants

- Strict branch protection, required CI, exact-head review, mutation evidence,
  signed trailers, and live-base authorization remain unchanged.
- At most one active merge campaign on the operator host owns a lease for a
  protected GitHub repository. A local lease cannot coordinate another host;
  cross-host enforcement still requires GitHub native merge queue.
- Different repositories and review-only campaigns remain parallel.
- Waiting does not create a new quality invocation or replenish execution
  budgets.
- A base change is detected before expensive gates and becomes a visible
  rebase-and-resume requirement, never an implicit merge or silent retry.
- A failed or crashed owner cannot be guessed dead while its manifest is recent,
  and an explicitly reclaimed owner cannot pass the next fencing check.
- Removing a campaign worktree cannot make an otherwise authoritative merged or
  closed-unmerged GitHub outcome unreconcilable while its shared repository and
  exact lease identity remain available.
- Parser, timeout, and provider failures cannot consume the documented retry by
  making an incomplete attestation look like successful HEAD coverage; only a
  complete attestation advances the review checkpoint.
- Direct or break-glass merges outside quality remain visible policy violations;
  the lease does not pretend it can serialize actors that bypass the workflow.
- New evidence is never merge-authorized from reviewed-head CI or a PR-level
  rollup; every required context must be successful from its required GitHub App
  on the exact reviewed candidate SHA, and the signed evidence must verify for
  that same SHA. Legacy stamped campaigns apply the same rule to their persisted
  stamp SHA.

## Verification

- Concurrent acquisition tests prove exactly one owner and bounded waiting.
- Same-invocation acquisition is idempotent; a different invocation cannot
  release it.
- An independent clone with the same deterministic invocation ID but a
  different manifest/common-directory tuple is rejected as a collision.
- Six-hour-stale resumable owners require explicit confirmation of the recorded
  invocation ID and pull request before recovery reads and rotates its internal
  credential;
  recent, malformed, symlinked, missing, and cross-repository owners fail
  closed.
- Fresh bootstrap and manifest resume both acquire the lease for `--merge` and
  skip it for review-only work.
- A base movement after manifest creation stops before gates, retains ownership,
  and prints the exact rebase/resume recovery path. The integration test then
  rebases, resumes, persists rebase carry before comparing the captured base,
  and proceeds without a second deadlock.
- Final terminal-state and successful-merge paths release the exact lease even
  when ordinary worktree cleanup cannot complete because the primary checkout
  is dirty; resumable terminal states retain it.
- Reclamation changes the fencing token, and stale owners fail validation after
  gates, review, CI, stamp publication, and immediately before merge.
- Phase tests suspend a process, rotate the shared token, and prove its pinned
  old credential fails even though the manifest now contains the new token.
- Recovery and merge-guard acquisition share the metadata linearization point;
  merge-guard release does too, and tests prove a rotated token cannot enter or
  dismantle the remote merge boundary.
- Release disappears from the acquisition namespace in one rename. Fault
  injection before and after that rename proves neither state creates an
  ownerless blocking lease.
- Pending initial acquisition and recovery rotation reconcile only for the
  exact owner tuple; contenders remain fenced and no pending generation is
  accepted by verification.
- A campaign older than six hours that continues successful fenced phase checks
  renews `renewedAt` and remains unrecoverable. Exhausted-timeout and
  blocked-resume-then-merge paths verify explicit lease disposition without
  rewriting the first terminal cause.
- Concurrent renewal/rotation tests prove the metadata guard prevents an old
  generation from being republished. Different `TMPDIR` values still contend
  in the same fixed operator namespace.
- Dead metadata-guard recovery serializes concurrent contenders, distinguishes
  PID reuse by process start identity, and never removes a replacement guard.
- Opposing manifest-mutation and recovery processes acquire metadata then
  manifest locks and complete without deadlock; a lock-order tripwire rejects
  any reverse-order caller.
- Merge-guard crash tests leave the guard quarantined until the entire process
  group is absent and GitHub proves the exact head merged or the operator closes
  the PR without merge. Time and negative observations alone never admit
  another campaign. The reconciliation regression test removes the process
  credential and proves the explicit invocation/PR confirmation path remains
  available. A second regression test removes the exact linked worktree before
  reconciliation and proves the same exact-owner/remote-outcome checks release
  the lease without recreating that path.
- A provider-retry regression records an incomplete attestation, reuses the
  governor-authorized same-HEAD range in a distinct artifact directory, records
  a complete retry, and proves the incomplete evidence remains auditable while
  final coverage becomes complete. A double-incomplete retry remains
  incomplete and merge-blocking.
- Full repository verification, mutation evidence, protected CI, and
  exact-head review pass before release.
- Exact-candidate CI regressions prove missing exact-head checks dispatch the
  corresponding workflow once, wrong-app and stale failed runs do not authorize,
  and final authorization reads exact candidate check-runs rather than PR-level
  check aggregation. A compatibility regression covers interrupted legacy
  stamped campaigns.

## Consequences

A repository with many merge-ready pull requests intentionally trades some
parallel campaign latency for bounded progress and eliminates repeated full-CI
losses. A campaign that becomes stale while holding the lease pauses that
repository's quality merges until the six-hour threshold and explicit fenced
recovery; status output names the owner and recovery path, and unrelated
repositories continue normally.

If GitHub native merge queue becomes available, it should replace this lease.
The queue can serialize speculative merge commits server-side and also covers
actors that do not share one local quality runtime.
