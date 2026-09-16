# Fresh mutation proof after remediation and rebase (BUI-923)

## Decision

Admit fresh current-head mutation evidence against the exact protected base
recorded by the validated rebase carry, independently of an older reusable
mutation artifact. Do not require `mutationCarry.priorHead` to equal
`baseRebaseCarry.priorHead` for this fresh-evidence path.

The two heads have different meanings. After a source fix passes mutation,
a test-only repair can advance the campaign without a new successful mutation
artifact. A subsequent rebase then records the repair as its immediate prior
head. Fresh execution against that rebase is not reuse of the older artifact.
PR #538 demonstrated this sequence: current tests caught the controlled revert,
but the validator rejected the proof solely because the historical heads differ.

## Invariants

- Artifact schema, invocation, immutable campaign base, exact current head and
  risk tier must still match.
- The fresh rebase path requires a validated rebase carry whose head matches
  the artifact and whose base matches its candidate base.
- Evidence must claim no reused artifact and zero avoided execution seconds.
- Existing valid method, mutated-path and observed-test-failure checks remain.
- Reused evidence still requires intact prior artifact hashes and identities.
- No new recovery transition, terminal edit, budget reset, gate waiver or
  operator capability is introduced. Review, CI and merge checks do not change.

## Alternatives

Keeping the equality rejects valid fresh evidence. Rewriting the old carry would
erase provenance. Waiving mutation or accepting a previous-head exception would
not prove current behavior. A new lineage framework is not needed: the existing
exact-tree rebase proof already supplies the relevant current head/base binding.

## Compatibility and rollback

No schema migration is needed. Existing direct-rebase and reuse paths retain
their fields and checks. Old runtimes continue to reject this sequence. Rollback
restores conservative rejection; it does not change prior artifacts. Deliver
the validator fix through its own protected campaign before recovering #538
through normal rebase and exact-manifest continuation.

## Verification

Extend the public mutation CLI fixture to cover source proof, test-only repair
without a new mutation artifact, protected-base advance, exact rebase, and fresh
mutation. It must fail before the validator fix and pass afterward. Keep the
direct-rebase case. Assert the two prior heads differ and that fresh evidence
uses only the live PR source, not protected-base-only files. Reject wrong head,
wrong candidate base and false reuse claims through the public recording API.
Run the affected mutation/invocation suites and normal exact-head quality gates.

The first exact-head local test gate timed out at 566 seconds: 441 tests passed
in its first command, and the separate mutation test command was incomplete.
The same-head CI completed both commands (441 plus 53 tests). This is not a
substitute for the failed local gate. The selector omitted mutation CLI coverage
for invocation-source-only changes and selected it separately when the test file
also changed. Map `quality-invocation.js` to its mutation CLI tests so the existing
coalescer retains all coverage in one run. Two public-selector regression cases
fail before this mapping and pass afterward. Because selector policy changes,
the resulting exact-head gate must execute the complete regression audit.

That audit completed in 446.21 seconds with 3,894 passing tests and one existing
date-dependent currency assertion failing. Reuse the already-reviewed test
repair from dependent PR #538: freeze Date at days 0, 30 and 31 relative to the
rubric review date and assert both score and gap. This keeps the production
scorer unchanged and avoids making this prerequisite depend on its dependent
PR. The focused scorer suite passes all 10 tests with the repaired fixture.

Architecture review: Sol/high returned CLEAN on 2026-09-16 before production
implementation. The first repository review emitted CLEAN but timed out during
completion; a bounded decision-and-validator-excerpt review completed with exit
0 and CLEAN. Neither advisory result is merge authorization.
