# ADR: Certify harness changes from a frozen baseline

## Status

Accepted for the agent-kit bootstrap. Agent-setup certification is a later
dependent change: it must run from a frozen agent-setup baseline after that
baseline pins the certified agent-kit release.

## Decision

Harness changes in `agent-kit` and dependent `agent-setup` must be built,
tested, reviewed, and merged by a certification runtime pinned to an already
merged baseline. Candidate harness source can be executed as the subject of
tests, but it must not provide the orchestration, policy, lease recovery, or
merge code that certifies that same candidate.

The agent-kit bootstrap interface is one explicit request:

```text
certify --baseline <immutable-kit-sha> --candidate <kit-pr,head> --claim engineering
```

It records the baseline digest, candidate/base/head identities, fixed native
gate commands, independent-review artifacts, GitHub required-check state, and
the exact merge read-back. It returns one terminal state: `MERGED`,
`NEEDS_FIX`, `WAITING_GITHUB`, `RECOVERABLE`, or `BLOCKED_EXTERNAL`.

## Invariants

1. Candidate source never supplies the certification runner or merge logic.
2. A candidate can change only after a new exact-head certification request.
3. Native gate commands and their timeouts come from the frozen baseline,
   never from the candidate branch.
4. Review artifacts bind the baseline digest and candidate base/head/diff.
5. A non-running terminal campaign is recoverable only after PID/process-group,
   PR, head, and merge-outcome checks prove there is no live or ambiguous owner.
6. `engineering` is explicit by default for harness work. It proves engineering
   delivery only; it never claims product admission.
7. The receipt path is outside the candidate checkout and is new. Candidate code
   cannot replace, redirect, or reuse certification evidence.
8. Agent-setup updates its `core` pin only after the certified agent-kit release
   is merged and tagged. Its own certification runs from a frozen setup baseline.

## Alternatives considered

Use the candidate harness for its own merge. Rejected: a broken recovery,
status, policy, or merge implementation can self-certify.

Use only GitHub CI. Rejected: CI can run candidate-controlled workflow and
does not provide independent local recovery or reviewer provenance.

Build a second permanent harness. Rejected: duplicated policy would recreate
the current divergence and maintenance cost.

## Rollback

The baseline runtime is read-only with respect to candidate policy. If a
certification defect is found, preserve its receipt, stop before merge, and
pin the preceding merged baseline for the replacement run. Candidate branches
and evidence remain intact.

## Verification

- Red-capable test: candidate attempts to select a different gate or merge
  command; certification rejects it.
- Red-capable test: a dead old owner can transfer only after all liveness and
  exact-identity checks pass.
- Red-capable test: a live process, changed PR head, or ambiguous merge blocks
  recovery.
- Test: omitted claim becomes `engineering`; product admission remains absent.
- Test: status always returns a terminal state and next action.
- Independent review uses artifacts generated from the frozen baseline.
- A controlled agent-kit change passes without invoking candidate certification
  code as policy or orchestration.
