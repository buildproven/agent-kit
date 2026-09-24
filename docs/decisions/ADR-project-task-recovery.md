# ADR: Wake an existing quality campaign without a second task runner

Status: accepted after Sol/high focused re-review, 2026-09-24.
Scope: BUI-969, one recovery slice under BUI-921 / agent-setup PR #835,
not all A2–A7.

Review outcome: APPROVE. The accepted contract includes the concrete deadline
and race rules below. This is architecture approval, not implementation or
delivery evidence. Review artifact: recovery-final-design-review.log in the
session's isolated review directory; the decision and conditions are retained
here so the temporary artifact is not the only record.

## Implementation checkpoint — 2026-09-24

The optional runner deadline is implemented locally, not yet reviewed or merged.
The public CLI orchestration suite passes 80/80 tests (32.90 seconds). The
original active-review probe failed after its six-second test timeout; with the
deadline implementation it stops at the requested three-second deadline. Cases
cover pre-expired no-write behavior, ordinary completion before expiry, active
review termination including ignored SIGTERM, preserved active-execution/owner
records, and invalid UTC/calendar inputs. ESLint has zero errors; existing
complexity warnings remain. This suite uses the actual runner and ownership
code with a fixture invocation library. It does not prove real-manifest recovery
or launchd wake-up. Registration, reconciliation, scheduling and the real
crash/re-entry acceptance test below remain unimplemented.

## Problem and rejected first design

The autonomous runtime exposes admission, release, handoff and synchronous
fresh-launch; its public CLI rejects reconcile. Overnight-loop resets its
deadline and attempt count on each launch. A timer alone is not bounded recovery.

Sol/high rejected the first generic-command design on 2026-09-24: an ended
process does not prove an external effect did not occur, argument strings do not
bind script contents, exit codes have no universal typed meaning, and a generic
timer fixture does not prove the real workflow. Do not implement that runner.

## Decision: one typed adapter, existing state and ownership

Add reconcile-quality to autonomous-loop-runtime. It accepts only a host-created
wake registration for one existing quality manifest. It cannot create a campaign,
change provider policy or scope, renew budgets, run arbitrary commands, or accept
model output as a verdict. Builder recovery remains a separate required slice.

A private registration binds schema version, canonical manifest path, invocation
ID, repository key, canonical target, original creation time, absolute wake
deadline and installed controller revision. The deadline cannot exceed the
original manifest lifecycle expiry. Identical registration is read-only; changed
identity or a later deadline under the same ID refuses. Stop at that deadline
even if launchd continues firing. Candidate code cannot create registrations.

The only action is the matching released quality-run.js --manifest invocation.
Use a fixed argument vector. Validate identity through the existing quality
library before each invocation. Pin the controller Git revision and require
tracked controller files clean; a moved/dirty controller blocks until explicit
registration for the new installed release. Node and the dependency lock belong
to that installed controller. Target and manifest are intentionally mutable
under existing exact-head transition rules, not frozen snapshots. This is
trusted local lifecycle management, not hostile same-user confinement or
repository-gate confidentiality. BUI-743 stays open.

Reuse quality-run's campaign/child exclusion. Do not acquire another campaign
lock, delete locks, infer death from age or kill processes. Its existing
PID/host/nonce and child-group protocol decides whether a runner can begin;
PID presence is conservatively live, not a claimed kernel start-identity proof.
Live or ambiguous owners must prevent duplicate execution. If the crash probe finds a defect
there, fix that layer separately, not with another ownership state machine.

## Results and recovery

Read the runner's versioned final result and corresponding saved manifest;
require matching campaign/repository/head identity. Exit zero alone is not
completion. Complete means this campaign ended, not product acceptance.
Work-required durably pauses for verification/remediation. Provider exhaustion,
credentials, deterministic failures and external capability remain explicit
blocks. A timer never fabricates a verdict or retries an exhausted review.

Re-enter an interrupted campaign only through the existing supported recovery
path, preserving original provider usage, attempts, findings and gate evidence.
Do not manufacture a new campaign or head. Real authorized descendants may
rearm deterministic checks under existing policy, with history retained; the
wake deadline never rearms.

After a crash with a missing final result, do not infer that an external action
failed. The existing quality runtime must reconcile persisted phase and remote
exact-head outcome before proceeding. If it cannot establish a safe outcome,
preserve UNKNOWN/BLOCKED rather than replay. No arbitrary provider or publishing
command is retried by this adapter. Completed, blocked, cancelled, expired and
work-required registrations are read-only no-ops on later ticks. Reactivation
after a resolved block requires the existing explicit supported recovery
transition; the timer cannot grant it.

## Wake-up, verification and rollback

Render one project-specific macOS launchd plist with an absolute registration
path and no credentials. Periodic invocation supplies wake-up, not authority.
Each invocation is bounded by the registration and existing execution deadlines.

The acceptance test installs a temporary uniquely named user job and isolated
fixture repository. Kill its first coordinator; launchd must invoke the adapter
again without a second test/user launch. Use actual quality-run, manifest and
ownership implementations; only remote GitHub/provider boundaries may be
doubles. Delay exact-head CI and require completion or the original deadline
block. Count gate/provider calls and verify evidence/budget preservation.
Also prove live-owner refusal, ambiguous-owner block and terminal no-op ticks.
Verify all owned processes ended, then remove only the exact temporary job/files.

Production activation is a separate deployment action. Do not modify existing
launchd labels. This cannot restart a ChatGPT conversation. Builder/overnight
restart, fresh-launch routing and sandbox authentication remain required before
the full goal is complete; do not certify them from this narrower proof.

Rollback removes only the exact launchd job and retains registration, manifest
and history. Manual use of the unchanged quality runner stays available. No
existing command/state migration or deletion.

Existing controller 47d7709 probes: six recovery/owner/CI-intent/handoff cases and
two campaign/gate reuse cases passed. These are component evidence, not automatic
wake proof. Public autonomous-loop-runtime.js reconcile returns INVALID_COMMAND.

## Concrete recovery sequence and deadline interface

Sol/high's focused review identified the missing deadline contract and a race
between execution reconciliation and owner removal. These are resolved here;
its broader-builder warning is retained as a separate acceptance obligation.

Before automated recovery, snapshot the owner file's inode, nonce, schema,
host, PID and v2 child PID/group, with the current exact manifest head. Prove
the owner PID is absent (the owner file remains present), the v2 child/group
are absent, and the active-execution timeout has elapsed. A live process waits;
an ambiguous/legacy record blocks. Missing owner files use normal acquisition,
never reconstruction. Readiness or old timestamps are not death evidence.

Use the existing lease-authenticated advanceManifest transaction to reconcile
expired execution. Then reread manifest and owner. Require the same registration,
head, host, inode and nonce, null activeExecution and still-absent processes
before invoking reconcileRunner with that exact snapshot. A changed observation
returns typed busy/unknown and ends the tick; do not launch from stale evidence.
Only then invoke the pinned runner; normal acquisition arbitrates other ticks.

Add one optional supported quality-run input, --stop-at <UTC timestamp>, and a
matching runManifest stopAt option. It is an immutable outer absolute deadline,
never a new execution allowance. The adapter passes its registered deadline.
No new child/provider invocation starts at or after stopAt. Every child wait
and recovery/CI wait is capped by its remaining time. Expiry uses the runner's
existing owned-process-group termination, not a kill of an outer shell alone.
Return typed deadline completion only after owned-group absence is proved;
otherwise preserve the ownership record and return quiescence-unknown/blocked.
The result must never mean successful campaign or product completion.

The optional input cannot relax any existing phase/provider/governor limit.
Existing callers without it retain current behavior. Re-entry from a wake job
always uses the original registered stopAt, including after descendant heads.
Tests cover no child launch after expiry, bounded running child termination,
unknown-group preservation, and unchanged existing callers, followed by the
real launchd integration described above.

Arbitrary builder/provider restart remains UNVERIFIED by this coordinator-only
acceptance and is still required by the parent goal.
