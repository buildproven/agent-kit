# ADR: V-cycle creator control plane

- Status: Accepted
- Date: 2026-08-20
- Decision owner: agent-kit

## Context

The existing Ralph material defines a bounded delivery graph, but the shell
runner correctly refuses to implement work. It has no durable product contract
that links discovery, requirements, architecture, build, verification, and
release evidence. A provider must not be allowed to mark a product complete
from a conversational claim or from a passing unrelated gate.

The creator needs a small, local control-plane interface. It must persist only
redacted workflow metadata, bind each phase to the checked-out Git head, and
use the existing Compute Governor and provider runner rather than duplicating
model routing or provider execution logic.

## Decision

Add `scripts/vcycle-creator.js` as the single control-plane interface for a
product delivery cycle. Its public commands are:

1. `init` creates a versioned cycle state from a product brief and repository
   identity.
2. `plan` validates, snapshots, and hashes a versioned V-cycle traceability
   matrix before any provider work.
3. `advance` records one typed phase result and its evidence digest. It rejects
   out-of-order phases, stale candidate evidence, unknown evidence, and
   terminal cycles.
4. `status` returns the current phase, required next action, and incomplete
   verification obligations as JSON.
5. `record-build` records a clean, committed descendant candidate for `BUILD`.
6. `verify` runs one named, non-mutating gate from the immutable gate contract
   and records its receipt inside creator-owned cycle state.

The first delivery slice provides the deterministic state machine, immutable
traceability baseline, and deterministic verification receipts. It does not
publish, deploy, modify Linear, or invoke a provider. Provider execution is
deliberately outside this release: the current same-user provider runner does
not provide an OS-enforced boundary around creator state. A future adapter may
run only after it uses a separate identity or an OS-enforced sandbox that denies
creator-state access. It still cannot assert that a phase passed; it may only
create source changes or artefacts that the control plane subsequently verifies.

The traceability matrix has a version, non-empty unique requirement IDs,
left-side artefact references, and right-side verification obligations. Every
requirement ID must map to at least one `RELEASE_VERIFY` obligation, and every
mandatory verification phase (`UNIT_VERIFY`, `SYSTEM_VERIFY`, and
`RELEASE_VERIFY`) must have at least one obligation. `plan` stores a canonical
snapshot and SHA-256 in cycle state. All later operations read that snapshot;
editing the input matrix does not alter an active cycle.

The cycle phases are `DISCOVER`, `REQUIREMENTS`, `ARCHITECTURE`, `BUILD`,
`UNIT_VERIFY`, `SYSTEM_VERIFY`, `RELEASE_VERIFY`, and `COMPLETE`. Build and
release verification are blocked until their corresponding left-side V-cycle
artefacts have evidence. `COMPLETE` requires a successful release-verification
record on the exact current candidate head.

`BUILD` is the only phase that may advance the candidate revision. Its evidence
must name the pre-build head and the clean, committed post-build candidate head.
`advance` verifies that the post-build head is a descendant of the prior
candidate, then atomically changes `candidateHead` and clears downstream
verification records. All verification phases then require typed successful
evidence bound to that candidate. A changed head outside this controlled
transition is rejected. This supports a provider handoff followed by a normal
commit without treating uncommitted changes as verification evidence.

`advance` accepts only deterministic receipts made by the creator. It never
accepts a receipt path or a caller-provided success result. `verify` resolves a
named gate from the immutable gate contract that `plan` derives from the
repository's existing quality configuration. The initial allowed gates are
`lint`, `test`, and `security`; the contract rejects shell strings, `gh`,
publish, deploy, package-install, and any executable not in that resolved
contract. `verify` captures its exit status and redacted output digest, then
atomically writes the receipt directly into creator-owned cycle state with the
cycle ID, obligation ID, candidate head, exact command, start/end times, and
result. It verifies that the repository is clean before and after execution.
`advance` finds that internal receipt by obligation ID and validates its digest,
obligation coverage, clean-tree observation, and candidate binding; it does
not accept a caller-supplied `passed` boolean as proof.

Creator state and its internal receipts live outside the target worktree in a
mode-0700 cycle directory. The initial release has no provider adapter, so no
untrusted provider process receives the operator's filesystem authority. A
human operator with local filesystem authority is not an adversary in this
local control-plane model.

Build evidence is the special receipt made by `record-build`. It has both
`preBuildHead` and `postBuildHead`; the former must equal the persisted
candidate and the latter must be its clean, committed descendant. Its record
also contains the committed tree ID for the post-build head. Non-build receipts
contain the current candidate head and its tree ID. `advance` validates these
bindings and persists each receipt SHA-256. A digest is an integrity record,
not success proof by itself.

`record-build` also compares the new candidate's gate-source files with the
gate contract snapshot. If `package.json`, lockfiles, `.quality-gates.json`, or
the repository-owned test-impact policy changes, it moves the cycle to
`REPLAN_REQUIRED` and permits no verification receipt. `replan` requires a
clean committed candidate, revalidates the immutable requirement matrix, takes
a new candidate-bound gate contract snapshot, and clears all verification
receipts. This keeps the requirement baseline stable while making executable
verification policy explicit for every candidate.

Failed verification receipts are recorded rather than discarded. `advance`
accepts a schema-valid creator receipt with a non-zero exit status only to move
from `UNIT_VERIFY`, `SYSTEM_VERIFY`, or `RELEASE_VERIFY` back to `BUILD`, record
a rework reason, and clear only later verification successes. A successful
receipt is required to advance to the next verification phase. The next build
may create a committed descendant candidate through the same two-head build
record. This preserves the failure trail and makes a fix-and-retest cycle
explicit rather than an undocumented exception.

## Invariants

- State is stored below an explicit caller-selected evidence directory, never
  in source control by default.
- Each transition records the candidate head. Only a successful `BUILD`
  transition may move it, and it clears all downstream verification evidence.
- `advance` reads only creator-owned internal receipts, never an evidence path
  supplied by a caller or provider. Their immutable obligation, candidate/tree
  binding, exit status, and SHA-256 digest are validated before state changes.
  Build records bind both its pre-build and post-build candidate heads.
- Verification runs require a clean worktree before and after execution. A
  dirty worktree fails closed, so a receipt cannot describe a different tree
  from its recorded candidate commit.
- Completion requires successful receipts that cover every requirement in the
  immutable matrix baseline. Missing or extra requirement IDs are visible
  validation failures, not a best-effort status.
- A build that changes executable gate sources enters `REPLAN_REQUIRED`; only a
  clean, committed candidate can take the next gate-contract snapshot.
- The creator does not call GitHub, publish, deploy, spend money, or claim a
  quality or provider result that it did not record.
- The interface returns JSON on success and a clear non-zero error on invalid
  state. It has no silent fallback.

## Alternatives considered

- Extend `ralph-next-run.sh`: rejected because shell orchestration already has
  a legacy placeholder implementation and would mix product evidence policy
  with backlog scheduling.
- Store the state in Linear: rejected because product evidence must work
  without network access and must bind to a local exact head before external
  synchronization.
- Let a provider own the V-cycle state: rejected because scheduling, state
  transitions, validation, and delivery authority must remain deterministic.

## Rollback

The first slice creates no external state. Stop using the command and retain
the evidence directory for inspection. Later execution adapters remain opt-in
and can be removed without changing the state schema.

## Verification

- Behavioral tests create a temporary Git repository and exercise the public
  CLI through the normal V-cycle and rejection cases.
- Tests prove out-of-order transition, uncontrolled changed-head reuse,
  dirty-tree verification, caller-provided receipt rejection, disallowed gate
  rejection, incomplete requirement coverage, and premature completion
  failures. They also prove that a committed descendant build candidate resets
  verification obligations and that a creator-recorded failed verification
  returns the cycle to `BUILD` for a new candidate.
- Tests prove that changed gate sources block verification until `replan`
  creates a new candidate-bound contract, and that the initial release exposes
  no provider-execution command.
- `npm run lint`, focused Vitest tests, and the repository quality workflow
  validate the delivered change.

## Implemented interface

The matrix schema is version 1. It contains top-level `artifacts` entries with
`phase` and `reference`, plus `requirements` entries with unique IDs. Each
requirement contains `obligations` with unique IDs, a mandatory verification
phase, and one of the `lint`, `test`, or `security` gates.

The public CLI accepts only explicit paths and identities:

```text
vcycle-creator.js init --repo <root> --evidence-dir <dir> --brief <file>
vcycle-creator.js advance --cycle <dir> --phase <phase> --evidence <file>
vcycle-creator.js plan --cycle <dir> --matrix <file>
vcycle-creator.js record-build --cycle <dir>
vcycle-creator.js verify --cycle <dir> --obligation <id>
vcycle-creator.js replan --cycle <dir>
vcycle-creator.js status --cycle <dir>
```

`--evidence` applies only to left-side phases. Build and verification advances
resolve creator-owned receipts from cycle state and accept no receipt path or
caller-provided result. `plan` binds the matrix exactly once. If a clean
descendant commit appears during verification, `status` routes recovery through
`record-build`; dirty or unrelated revisions remain blocked.
