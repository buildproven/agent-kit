# Deterministic Quality-Run Orchestrator

## Decision

Replace the model-sequenced portions of the quality workflow with one
deterministic runner. The runner owns target bootstrap, risk selection, gates,
review dispatch, authorization, merge, cleanup, and terminal telemetry. A
model is used only where judgment is the product: classifying identity-checked
findings and choosing a remediation patch.

This design is implemented by `scripts/quality-run.js` for BUI-791. The
existing manifest and individual scripts remain the compatibility boundary;
the public runner now owns their order, resume rules, and typed outcome.

## Contract

`quality-run` receives exactly one of two inputs:

- a new, validated quality invocation; or
- `--manifest <exact-path>` to resume that exact campaign.

It never discovers a campaign by session, glob, timestamp, environment
inheritance, or a “latest” pointer. The manifest is the complete state machine
and every phase records an identity-bound result before the next one begins.

An optional `--stop-at <UTC timestamp>` bounds one runner invocation by an
absolute deadline. `runManifest` accepts the same deadline through `stopAt`.
The value does not extend any campaign or provider budget. An already expired
deadline starts no work and leaves the manifest unchanged. During execution,
expiry kills the owned process group, prevents further child launches, and
returns `blocked` with reason `stop-at-expired`. The result reports whether
process quiescence was confirmed or remains unknown. It never reports campaign
success from deadline expiry. Existing active-execution and ownership evidence
is retained for the supported reconciliation path; expiry does not reset it.
If the OS refuses group termination, the runner reports the termination error,
disconnects its output pipes and retains ownership of the possibly live child.
It returns a blocked result without waiting indefinitely or claiming the child
was stopped. With a deadline, a separate POSIX group supervisor also bounds
synchronous metadata checks. Each supervisor signals only its own live group;
payload execution starts after the nested ownership record is saved. Worker
death cancels its foreground group. A blocked invocation can leave the durable
campaign in its prior nonterminal state: expiry does not run a potentially
blocking metadata transaction just to write a terminal marker. The existing
recovery path must reconcile that preserved evidence before more work starts.
Nested `quality-run-bounded.sh` calls inherit the supervisor deadline and use
the same parent-disconnect cancellation path. Their own phase cap can shorten,
but cannot extend, the inherited deadline. Calls outside supervised execution
keep the existing standalone wrapper behavior.
Calls without the option retain their existing behavior. Automatic wake
registration and scheduling are separate from this runner input.

```
bootstrap → policy → gates → review → lead disposition → [remediate → gates → verify] → authorize/merge → telemetry
```

Terminal outcomes are `merged`, `reviewed`, `blocked`, and `failed`. A
`work-required` result pauses only for identity-bound lead verification or the
one permitted remediation commit; resuming the same manifest advances a valid
descendant HEAD and continues through delta review. `action-required` remains
reserved for external authority. Cleanup and telemetry run from a `finally`
path and cannot convert a successful merge into a failure or an invalid
campaign into success.

An orphaned manifest file lock can recover only when the current process holds
the exact repository metadata guard and the recorded local owner PID is
confirmed dead. The recovery compares the lock identity and bytes again before
replacement. Active, remote, malformed, and uncertain owners remain blocked.
See [the lock recovery decision](decisions/ADR-quality-dead-manifest-lock.md).

A host interruption is recoverable through the same exact manifest. Recovery
requires the exact repository lease and no active execution owner. It preserves
prior reviews, findings, provider use, and budgets, then continues only the
unfinished exact-head phases. If HEAD advanced, the runner archives the stale
interruption and reruns descendant-bound gates, mutation evidence, and review.

Base integration must preserve exact-tree replay evidence, whether history is
rebased or merged. See [the main-merge carry decision](decisions/ADR-main-merge-campaign-carry.md).

Test-only remediation replays the prior killed source mutation in a fresh
current-head sandbox. It must not substitute another candidate or report saved
execution time. A weakened test remains blocked. Separately, a valid explicit
`mutation:missing` exception can reopen only a mutation-phase failure through
an epoch-fenced `recovering` state. The runner continues unfinished review and
CI; it never jumps from that exception directly to merge. See
[the mutation recovery decision](decisions/ADR-test-remediation-mutation-recovery.md).

When required CI fails after completed review coverage, one later descendant
may carry that coverage only for a test-or-fixture-only repair. The runner
requires the failed exact reviewed head, a valid ancestor relation, fresh
current-head gates and mutation proof, and fresh required CI. It records the
carry and never starts another provider round. Production, workflow, policy,
model, or review-configuration changes are not eligible. See
[the CI-repair carry decision](decisions/ADR-ci-repair-review-coverage-carry.md).

## Phase ownership

### Validation cost (BUI-932)

Every delivery claim, including the default `contract` claim, receives input
preflight before risk, panel selection, deterministic gates, or review start.
Missing contract inputs and stale evidence identity must not consume those
execution budgets (BUI-952). For a contract with complete inputs, the full
verifier runs once after gates, not during preflight too. Preflight does not
replace the post-gate check or protected merge admission, and it does not
change the default claim or engineering policy. Product claim admission keeps
its existing full preflight.

The builder owns focused red/green checks during editing. The campaign owns
final local validation of the exact candidate. Do not run an extra full suite
before handing off to it. On interruption, inspect the saved manifest and
execution owner; resume that campaign, not a second copy. Missing console
output is not evidence that a recorded gate needs to run again.

The repository test-impact policy has no automatic full-suite fallback.
Unknown coverage is an actionable mapping defect. Add a mapping grounded in
tests that execute the changed behavior. Dependency, release-package, runner,
and selector-policy changes retain explicit complete-audit rules. CI remains
independent and required; normal PR CI can overlap local execution.

The initial regression cases are the bounded provider wrapper and the product
public-key workflow. Both selected `npm test` before this change despite
existing behavioral coverage. Their tests must select focused commands, while
unknown shell paths must remain `unmapped` and audit-trigger paths must still
select `npm test`. This is a repository-policy fix, not a new cache or a change
to the shared planner API.

### Orchestrator test scope (BUI-953)

An edit confined to `quality-run.js`, its public orchestration tests, or this
document selects `quality-run.test.js`. That suite copies and executes the actual
runner. The invocation suite's `quality-run.js` references create synthetic
runtime files to test digest/identity handling; they do not execute this runner.
The release approval and merge suites test separate scripts. Changes to those
dependencies, ownership, engineering policy, or mixed diffs keep their existing
broader mappings. Selector/configuration changes still require a complete audit.

### Release CI overlap (BUI-933)

For an exact same-repository release-please candidate, the runner starts the
already-held GitHub quality workflow after immutable target, risk and panel
validation, before local gates. This overlaps independent CI with local work.
The starter cannot dispatch a workflow. It approves only one held
`pull_request` quality workflow whose repository, PR, base, release branch,
head SHA and GitHub Actions identity match the manifest. Normal branches do
nothing. Merge still waits for the required exact-head check after local gates
and review; early approval is scheduling only, never merge evidence.

Campaign ownership and its metadata guard are scoped to repository plus PR.
Different PRs can execute gates concurrently; the same PR still has one owner.
The repository merge guard remains held across the actual ref request and its
read-back. Unknown outcomes keep that guard quarantined, without blocking
independent PR gates. All evidence and execution charges remain exact-head and
per-campaign. See [the ownership decision](decisions/ADR-pr-scoped-quality-ownership.md).

Existing active legacy campaigns must drain before scoped admission. Resume them
with their exact saved manifest. Never delete their lease or rewrite credentials.
After activation, older runtimes fail closed on the protocol marker. For an
explicit code rollback, first release all scoped campaigns through normal
terminal handling and reconcile any merge outcome, then run the current runtime:

```bash
node scripts/quality-repo-lease.js rollback-protocol --manifest /exact/saved/invocation.json
```

This command refuses active owners and merge guards. It removes only validated
released owner receipts and the protocol marker, while preserving manifests,
budgets, evidence and history. A missing or changed marker with scoped ownership
is a recovery error, not permission to restart or downgrade.

| Phase            | Deterministic runner responsibility                                                    | Model responsibility                                        |
| ---------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Bootstrap        | Resolve the exact target, create/advance manifest, acquire worktree ownership          | None                                                        |
| Policy           | Resolve risk, provider policy, deadline, and immutable required gates                  | None                                                        |
| Gates            | Execute revision-bound argv gates and persist results                                  | None                                                        |
| Review           | Enforce governor budget, dispatch provider, validate artifact identity                 | None                                                        |
| Lead disposition | Construct the identity-bound lead input and validate its advisory disposition artifact | Verify each lead against source and deterministic execution |
| Remediate        | Verify the governor allows one fix round; advance manifest after a commit              | Produce the bounded patch and explain unresolved findings   |
| Merge            | Verify coverage, CI, authorization, and merge; perform worktree-aware cleanup          | None                                                        |
| Telemetry        | Write exactly one terminal record                                                      | None                                                        |

The runner must fail closed when state is unreadable, a phase result does not
match the current revision, a provider result is malformed, or a model omits a
required finding disposition.

## Migration plan

1. **Complete:** extract a `quality-run` command that invokes the existing bootstrap,
   selection, gate, review, stamp/merge, and telemetry scripts in this order.
   It writes phase transitions to the existing invocation manifest.
2. **Complete:** make the quality skill a short handoff: create/resume the manifest, invoke
   the runner, and present lead-verification/remediation work only when the
   runner explicitly pauses at that phase. The compatibility `judge` command
   records economics; it does not grant or deny merge authority.
3. Add end-to-end fixtures for success, invalid governor state, stale review,
   blocking findings, CI failure, and post-merge cleanup. The old prose path
   remains available only until those fixtures prove behavioral equivalence.
4. Remove duplicate shell-resolution blocks and retire phase-by-phase model
   instructions once the runner is the only executor.

The runner should execute in a fresh, narrowly scoped process or agent. It
must not inherit a long-lived parent conversation merely to obtain a target
directory and manifest path.
