# Test-remediation mutation and phase-correct recovery (BUI-922)

## Decision and requirements

Routine test-only remediation must produce fresh automated failure evidence,
not ask the operator to assess manual test logs. Preserve the public runner's
exact-manifest interface and fail-closed merge contract.

When a descendant changes only tests, replay the exact previously killed
revert-diff mutation (path and candidate base) in the detached current-head
sandbox. Validate prior artifact hash, campaign identity and source ancestry;
require one recorded killed path and unchanged subject bytes. Do not substitute
another candidate if the replay stays green. Record fresh current-head proof
with prior artifact provenance and zero claimed execution savings. Existing
green baseline and observed test-failure requirements remain in force. A standalone test-only
patch with no mutable subject remains blocked; supporting arbitrary new
mutation subjects is outside this repair.

A pre-review mutation failure needs a typed, phase-correct recovery path.
Record the failed mutation phase as terminal evidence. Resume only when the
same identity has a valid explicit mutation:missing capability. Do not
automatically retry arbitrary failed gates or admit a runtime policy change.

These are two distinct paths. Ordinary automated test-only remediation MUST
replay and kill the prior mutation, and weakened tests MUST block. The already
supported explicit operator exception intentionally accepts missing mutation
proof; BUI-922 restores its broken continuation, not changes its scope. That
exception is NOT routine automation and must remain visibly recorded as an
override, never reported as successful mutation proof. It does not waive review
or CI. Requiring a fresh kill after explicit acceptance would contradict the
operator's named decision and the existing mutation:missing contract.

Recovery archives the prior failure, increments the terminal epoch, preserves
all budgets, gate results and review checkpoints, and enters the unfinished
campaign phases. It must not jump directly to merge. Delta review and CI remain
required. Absent, expired, wrong-head, invalid-signature and unrelated approvals
cannot reopen the failure. Validate inside the manifest lock and use existing
runner ownership and repository lease fences.

Atomically retain a `recovering` terminal sentinel with recovery kind
`accepted-mutation-failure`, current head, incremented epoch and approval
artifact digest. Older runners must remain terminal. A later current runner
must revalidate the same capability, ownership and gates before re-entering;
expired or replaced approval refuses recovery. An active provider/gate refuses
the transition. Epoch fencing rejects stale terminal writers.

This explicitly amends invariant 6 of ADR-recoverable-terminal-capability-resume:
only `blocked` with failureCode `mutation-failed` (or the narrowly matched
legacy mutation detail plus exact-head mutation orchestration phase) may use
this transition. Lint, test, security, provider and other gate failures remain
immutable under this transition.

Mutation-only approval must not suppress review authorization: require full
contiguous review coverage at merge and retain actual review evidence and lead
counts. Check capability signature and expiry wherever mutation acceptance is
consumed; a matching string and head alone are insufficient.

## Alternatives

- Blanket test-only exemption: rejected; weakened tests could pass unnoticed.
- Reuse prior red evidence without execution: rejected; changed tests can lose
  the behavior that previously caught the mutation.
- Restart campaign or erase terminal state: rejected; destroys audit and budgets.
- Manual phase sequencing: rejected; duplicates runner policy in the caller.

## Compatibility and rollback

New failures carry typed mutation metadata. For an existing legacy failure,
recognize only the exact runner-generated mutation failure detail, require the
same exact-head signed capability and successful required gates, and retain
the original failure in history. Never accept free-form prose as approval.
Older runtimes continue to refuse recovery. No schema deletion or migration of
unrelated manifests is required. Reverting this change restores refusal.

## Verification

The harness must pursue quality, speed, token efficiency and autonomy together:

- Quality: weakened assertions cannot obtain fresh passing mutation evidence;
  exact-head review and CI remain mandatory unless separately authorized.
- Speed: replay one known killed subject, reuse valid gate/review evidence,
  and keep existing execution limits instead of starting a new campaign.
- Token efficiency: mutation planning and recovery are deterministic; neither
  requires another model call or a repeated full-diff review.
- Autonomy: ordinary test-only repairs continue without an operator decision;
  agents settle routine technical and prerequisite sequencing decisions.

These are acceptance criteria for this repair, not proof that the whole harness
is state of the art. System-level claims require comparable task outcomes,
escaped-defect rate, active duration, token use and human-intervention counts.

Use CLI mutation fixtures to prove a source fix followed by test-only repair
gets fresh red evidence; weakened tests and standalone test-only patches fail.
Use real invocation capability validation plus runner phase integration tests
to prove only the accepted mutation failure reopens, still runs delta review,
retains failed history/budgets and does not retry unrelated failures. Test
expired/wrong-head/missing approval, repeat resume, and ownership boundaries.
Run controlled source reverts and quote passing and failing test counts.

Design review: first bounded attempt timed out. Second completed with three
leads: sentinel and invariant amendment incorporated above; recovery-only
approval refuted because it changes the operator's existing named exception.
The two paths and their different evidence claims are now explicit. Sol/high
re-review completed CLEAN on 2026-09-16 before production implementation.
