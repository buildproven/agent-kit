# Quality Checklist — Exit Criteria & Agent Validation

## Tier-aware Exit Criteria (level auto)

Review depth scales with the resolved risk tier (see `reference.md` §Quality Levels). The configured primary can be Claude or Codex; fallback is availability-only. Other gates apply at every tier.

| Gate                                        | low | medium | high | critical |
| ------------------------------------------- | --- | ------ | ---- | -------- |
| Behavioral test evidence + suite passes     | ✓   | ✓      | ✓    | ✓        |
| ESLint / TypeScript / build clean           | ✓   | ✓      | ✓    | ✓        |
| Defensive pattern analysis                  | ✓   | ✓      | ✓    | ✓        |
| Signed exact-head policy exemption          | ✓   |        |      |          |
| Domain-selected AI reviewers                | 0   | 1      | 1    | 2        |
| Every selected reviewer is accounted for    |     | ✓      | ✓    | ✓        |
| AI lead/status evidence is signed           |     | ✓      | ✓    | ✓        |
| `Reviewed-By: quality` signed authorization | ✓   | ✓      | ✓    | ✓        |

## Required execution evidence

Levels 95 and 98 raise the minimum risk score; they do not start separate full
panels or guarantee percentage-quality scores. The persisted manifest chooses
the required gates and reviewer coverage.

- Tests: the selected affected plan passes; full audits run only when selected.
- Lint, types, build, patterns and security: all applicable persisted gates pass.
- Review: exact-head signed coverage and truthful complete/incomplete status.
- Remediation: verified defects, one bounded batch and permitted delta review.
- Merge: required CI, authority, product admission and exact-head proof.
- Completion: report the actual outcome. A review or score cannot mark Linear
  Done without the required delivery evidence.

Provider output is validated by the runtime's schemas and identity checks.
Do not add manual minimum-character checks, fixed section templates or another
provider retry outside the shared ledger. Accessibility/performance requirements
belong to the task's acceptance criteria and applicable gates, not an unrelated
mandatory panel for every repository.

## AI Lead Validation

- Reviewer agreement does not promote severity. Roles that share a model,
  context, or provider are complementary coverage, not independent votes.
- Detector severity is advisory. Every lead must include a changed file and
  line, an expected-versus-actual failure scenario, and a proposed deterministic
  verification path.
- A lead blocks only after conversion into a failing allowlisted gate,
  regression test, or executable static rule.

### Suppression Rules (NEVER report these)

- Import ordering suggestions
- Variable naming preferences (unless misleading)
- "Consider using X pattern" without a concrete bug
- Comments about unchanged code
- Suggestions that increase complexity without fixing a bug
- "LGTM" or "no issues found" padding

### Output Requirements

- Signed evidence includes lead count, source attribution, review status, and
  files reviewed.
- Every lead remains auditable even when refuted or unproved.
- Empty discovery means only that the bounded run emitted no leads; it is not a
  correctness claim.

## Audit Scoring (--audit mode)

Score starts at 100, deductions:

| Category | Check              | Deduction |
| -------- | ------------------ | --------- |
| Code     | Tests fail         | -30       |
| Code     | Lint errors        | -15       |
| Code     | Type errors        | -15       |
| Code     | Build fails        | -30       |
| Security | npm audit critical | -25       |
| Security | Hardcoded secrets  | -30       |
| Docs     | No README          | -10       |
| Docs     | No ARCHITECTURE.md | -5        |
| Deploy   | No deploy config   | -5        |
| Deploy   | No .env.example    | -3        |
| Deploy   | No CI workflow     | -5        |

### Score Thresholds

- > =90: READY TO SHIP
- > =70: ALMOST READY
- > =50: NEEDS WORK
- <50: NOT READY

## Test Quality Validation

### Red Flags in Generated Tests

- Tests that only check "renders without crashing"
- Assertions that don't test behavior (e.g., `expect(true).toBe(true)`)
- Missing edge case coverage
- No error path testing
- Snapshot-only tests without behavioral assertions

### Minimum Test Requirements

- Changed behavior is exercised through a public interface
- The test would fail if the behavior regressed
- Expected values come from an independent source of truth
- Relevant failure/recovery paths are covered
- Test descriptions explain the scenario, not the implementation
