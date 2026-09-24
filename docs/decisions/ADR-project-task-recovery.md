# ADR: Wake an existing quality campaign without a second task runner

Status: accepted after Sol/high focused re-review, 2026-09-24.
Scope: BUI-969, one recovery slice under BUI-921,
not all A2–A7.

Review outcome: APPROVE. The accepted contract includes the concrete deadline
and race rules below. This is architecture approval, not implementation or
delivery evidence. Review artifact: recovery-final-design-review.log in the
session's isolated review directory; the decision and conditions are retained
here so the temporary artifact is not the only record.

## Implementation checkpoint — 2026-09-24

Latest deadline audit: **incomplete**. Pushed head `96b7d5d` passes CI, but
a new public wake CLI regression with a two-second registered deadline and a
stalled Git boundary takes 5.06 seconds. The test fails its four-second bound
(one failed, 25 skipped; 5.57 seconds). Synchronous metadata validation blocks
the runner's event loop; child-phase timers cannot bound the whole tick.

Two focused architecture reviews rejected an outer watchdog that signals
children from saved owner records. Publication-before-execution, PID reuse,
descriptor inheritance and stopped-worker cleanup need explicit handling.
Do not implement that rejected design or treat its review as approval.

The replacement received focused Sol/high architecture approval after confirming
the existing ownership split: the top-level worker PID/nonce never changes
between phases; only its nested child identifies a phase supervisor. A live
top-level worker always prevents recovery, even between child groups. The
implementation must retain and test that exclusion. Review decision: APPROVE;
implementation and delivery remain unreviewed.

The replacement is a small self-owned process-group supervisor:
each supervisor keeps an asynchronous deadline outside its payload, starts the
payload only after ownership publication, and signals only its own live group.
The same boundary would supervise metadata reconciliation and phase commands.
This removes file-derived kill authority, PID scans and experimental execve.
The implementation is now local, not deployed or independently reviewed.
The original metadata regression passes (one passed, 25 skipped; 2.36 seconds).
Its first combined run passed 120 tests and failed one: signal-denial reporting
lost the original EPERM code. The corrected focused suite passed 5/5 (4.05
seconds), preserving the error and unknown-quiescence result. The next combined
run passed 125 tests; its old launchd expectation failed because coordinator
death now cancels, rather than leaves running, the gate. The updated native
probe passed (16.59 seconds): automatic ticks preserve pending execution,
run the gate exactly once, observe its group absent, and stop at the original
registration deadline without claiming campaign completion. The temporary job
is removed. No production job has been installed.
The final local combined runner/wake/runtime run passes **127/127** in 47.68
seconds, including the opt-in native launchd probe. Focused coverage also proves
parent-disconnect cancellation, no payload before successful ownership
publication, exact arguments, normal target exit codes, same-group descendant
cleanup and an event-loop-blocking payload deadline. ESLint reports zero errors
(existing and new complexity warnings remain); `git diff --check` passes.
Required tests include parent disconnect, publication ordering, same-group
descendant cleanup, structured exit results and the existing native wake proof.
Delayed-CI acceptance and final independent review remain required.

### Approved supervisor boundary

Each detached supervisor is its own live POSIX group leader. It keeps the
absolute deadline on its event loop; the payload runs non-detached in that
group. Only the supervisor signals its group, using its own PID. No watchdog
signals a PID obtained from a durable file. Normal target exit also cleans
same-group descendants before the parent can accept its result.

The parent fsyncs the nested child ownership record before sending the private
IPC start message. Disconnect before start cannot execute the payload;
disconnect afterward cancels the group. Payload IPC, when needed for the wake
result, is a fresh channel, not an inherited endpoint of the parent's channel.
The top-level campaign owner remains the reconciliation worker for its whole
run. Its live PID excludes a second wake even between phases.

Target results travel separately from stdout. The supervisor waits for its
result-send callback, then self-kills; a short fallback bounds IPC delivery.
Missing results, failed signals and groups not proved absent are incomplete,
never success. An outer observer may detach after a bounded cleanup allowance
but never signals a stale PID. Wake expiry also checks retained nested campaign
ownership before claiming quiescence. This is cooperative POSIX supervision,
not malicious-daemon containment, hard real-time scheduling, or cancellation of
an already accepted remote side effect.

This replaces the rejected external-signaler designs and avoids experimental
execve, PID scans, a new lease or a new campaign state schema. Rollback removes
the new boundary before activation and keeps registrations/history intact.
Standalone quality-run metadata supervision, explicit between-phase exclusion
coverage, delayed-CI acceptance and final exact-head review remain unfinished;
do not infer their completion from the wake deadline regression.

The optional runner deadline is implemented locally, not yet reviewed or merged.
The public CLI orchestration suite passes 80/80 tests (32.90 seconds). The
original active-review probe failed after its six-second test timeout; with the
deadline implementation it stops at the requested three-second deadline. Cases
cover pre-expired no-write behavior, ordinary completion before expiry, active
review termination including ignored SIGTERM, preserved active-execution/owner
records, and invalid UTC/calendar inputs. ESLint has zero errors; existing
complexity warnings remain. This suite uses the actual runner and ownership
code with a fixture invocation library. It does not prove real-manifest recovery
or launchd wake-up.

Host registration is now implemented locally through `register-quality`. Eight
CLI tests use real Git repositories and the real manifest loader/identity check.
They prove private state, fixed identity/deadline, no campaign mutation,
read-only repeated registration, clean controller binding, and refusal of
symlinked/shared/repository-contained state. These plus the existing autonomous
runtime tests pass 21/21 (2.78 seconds). The controller in these registration
tests is deliberately a registration-only fixture, not an execution proof.
Reconciliation is implemented locally through `reconcile-quality
--registration <path>`. The combined registration/recovery/runtime suites pass
33/33 tests (10.26 seconds). Two tests use a committed fixture controller with
the candidate adapter, real invocation library and real runner: dead idle-owner recovery and dead
expired-execution recovery both reach the exact missing-product-input block.
The latter charges one second of expired gate execution exactly once and keeps
provider usage at zero. Live owners/children, remote and legacy owners, missing
child identity, pending execution deadlines, terminal campaigns, changed
identities and expired wake deadlines do not dispatch work. These are local
component proofs. The native launchd crash probe now also passes (12.42 seconds):
an isolated job starts a real campaign and gate; the test kills its coordinator;
launchd wakes the same registration; the wake reports the still-live child and
does not duplicate the gate; the deliberately failing gate leaves the campaign
blocked with zero provider usage. The gate counter remains exactly one. The
temporary job is booted out and absence is verified. This proves scheduled
crash wake-up and failure preservation, not successful delayed-CI completion.
The combined runner/wake/runtime suite now passes 119/119 tests (40.10 seconds),
including the opt-in native launchd case. A deterministic Git-boundary fault
replaces ownership after execution reconciliation: the tick returns busy,
preserves the replacement owner, charges the expired gate once, and starts no
runner phase. A denied process-group kill originally kept the runner's output
pipes alive past its deadline (red: six-second test timeout). The fix detaches
those pipes, returns blocked with `quiescence: unknown` and `terminationError:
EPERM`, and retains child ownership (green: 3.17 seconds for a three-second
deadline). It does not claim that an unkillable child stopped.
Product verification and protected-admission subprocesses also now use the
owned execution boundary rather than synchronous child calls. A hanging
verifier reproduced a six-second test timeout before the change. Verifier and
admission deadline probes both pass afterward, and verifier output stays
privately captured. The orchestration suite passed 82/82 before the additional
admission case; the two targeted deadline cases then passed in 6.26 seconds.
The remaining delayed-CI acceptance below is unfinished. Read-only synchronous
Git metadata helpers still need a worst-case deadline audit; do not claim a
strict end-to-end wall-clock bound from the owned-child tests alone. No
production wake job has been installed.

Recovery dispatch must execute from the registered controller's own runtime.
It uses fixed imports, not dynamic loading of paths from registration data.
After execution it rechecks registration and campaign identity; a complete
result requires a matching terminal record. The adapter does not accept an exit
code alone as proof of completion.

Pause persistence reuses the runner's existing exact-head orchestration record.
`work-required` and `action-required` are read-only pauses on later ticks; a wake
cannot grant the missing decision or external capability. No second result
state machine or pause store is added. Explicit supported runner re-entry owns
resumption after that work or authority is supplied.

The host entry point is:

```bash
node scripts/autonomous-loop-runtime.js register-quality \
  --manifest /absolute/path/to/invocation.json \
  --stop-at 2026-09-24T03:00:00.000Z
```

Use the actual intended deadline, not the example timestamp. The default
controller is the checkout containing the runtime; `--controller` selects a
different installed controller repository. Its clean Git revision, Node path
and version, and dependency-lock digest are retained. The default registration
directory is the operator's autonomous-loop state directory under
`quality-wakes`; `--state-dir` selects an isolated host state directory. It must
be private and outside both repositories. Registration does not start work.

`render-quality-wake --registration <path> [--interval-seconds 30]` returns a
project-specific launchd label and plist as JSON. It does not install or start a
job. The plist uses an absolute Node path and registered controller runtime,
explicit argument vector, periodic interval, private-state log paths, and a
bounded executable search path. It contains no provider credentials. macOS
`plutil -lint` validates the generated plist. Production bootstrap remains a
separate deployment action. The native test is opt-in on macOS:

```bash
BS_QUALITY_WAKE_LAUNCHD_TEST=1 npx vitest run \
  scripts/__tests__/quality-wake.test.js -t 'launchd wakes'
```

Tick exit zero means a typed result was returned, not that delivery succeeded.
Consumers must inspect `status`, campaign identity and matching manifest state.

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
