---
name: recover-quality
title: "Recover Quality"
description: Comprehensive audit + fix for quality regression across all repos; integrates learnings into CLAUDE.md
context: fork
user-invocable: false
# Runs unattended (forked, no user in the loop). AskUserQuestion here would
# block forever with nobody to answer it — remove the tool, don't just ask it
# nicely not to. https://code.claude.com/docs/en/skills
disallowed-tools: AskUserQuestion
---

# /bs:recover-quality — Quality System Recovery & Learnings Integration

**Goal**: Audit your last 3 months of work across all repos, identify quality failure patterns, establish systemic fixes, and encode learnings into CLAUDE.md so they stick.

> **Completion condition (for `/goal`-driven runs):**
> `/goal all quality failure patterns are identified, systemic fixes are applied, and CLAUDE.md is updated with learnings`

## Phase 1: Audit & Analysis

### Analyze Work Patterns (Last 3 Months)

```bash
# Scan all repos for:
# 1. Commits with "fix:" that mention pre-existing issues (symptom: multiple fixes to same code)
# 2. Codex review findings (issues found after merge)
# 3. Linter/test failures that should have been caught upstream
# 4. PRs merged without /bs:quality --merge

# Use find instead of **/* glob (bash 3.2 on macOS requires shopt -s globstar).
while IFS= read -r repo; do
  [ -d "$repo/.git" ] || continue
  name=$(basename "$repo")
  echo "=== $name ==="

  # Last 3 months of commit messages
  cd "$repo" 2>/dev/null || continue
  git log --oneline --since="3 months ago" 2>/dev/null | head -15
done < <(find ~/Projects -maxdepth 2 -mindepth 2 -type d 2>/dev/null)
```

### Identify Failure Categories

**Category A: Symptom vs Root Cause**

- `fix: update pattern-check.sh path` (appears 12x across repos)
- Root cause: central scripts moved, downstream refs not updated
- Fix level: should've been caught by `/bs:sync` or CI

**Category B: Quality Gate Bypasses**

- Multiple repos: `#(no-verify)` commits, ESLint disables, commented-out tests
- Root cause: time pressure, unclear importance of gates
- Fix level: make gates faster and more selective

**Category C: Testing Gaps**

- Regression tests missing for fixes marked `fix: PROJ-123`
- Root cause: test generation not automatic, no checklist
- Fix level: system refactor

**Category D: Planning Skips**

- Small PRs merged without `/bs:quality --merge` review
- Root cause: false confidence on "simple" changes
- Fix level: enforce via git hooks

---

## Phase 2: Systemic Fixes

**Status: these are templates, not existing infrastructure.** Neither
`~/.claude/hooks/pre-commit` nor `scripts/auto-regression-test.sh` exists until
this phase writes them. Generate each file from the snippet below when Phase 2
runs; do not assume either is already wired up on a fresh recovery pass.

### Fix 1: Pre-Commit Quality Gate (Prevents Category D)

**File**: `~/.claude/hooks/pre-commit`

```bash
#!/bin/bash
set -e

# Skip if running quality gates already
[ "$RUNNING_QUALITY_CHECK" = "1" ] && exit 0

# Detect if this is a multi-file change across boundaries
FILES=$(git diff --cached --name-only)
FILE_COUNT=$(echo "$FILES" | wc -l)

# If changing >3 files or touching config, require quality review record
if [ "$FILE_COUNT" -gt 3 ] || echo "$FILES" | grep -qE "(package\.json|settings\.json|eslint|tsconfig)"; then
  if ! git log -1 --format=%B | grep -q "Reviewed-By:"; then
    echo "❌ Multi-file or config changes require /bs:quality review."
    echo "   Run: /bs:quality --merge"
    exit 1
  fi
fi

exit 0
```

### Fix 2: Automated Regression Test Generation (Prevents Category C)

**File**: `scripts/auto-regression-test.sh`

When a `fix:` commit is pushed, automatically generate a regression test template:

```bash
#!/bin/bash
# Generates regression test template for fix: commits

COMMIT_MSG=$(git log --oneline -1)
if echo "$COMMIT_MSG" | grep -qE "fix:|Fix [A-Z]{2,}-[0-9]+"; then
  ISSUE=$(echo "$COMMIT_MSG" | grep -oE "[A-Z]{2,}-[0-9]+" | head -1)
  if [ -n "$ISSUE" ]; then
    cat > "test/regression-$ISSUE.test.js" << 'EOF'
/**
 * Regression test for $ISSUE
 * Verifies the fix holds under:
 * - Normal load
 * - Edge cases from original report
 * - Related code paths
 */

describe('Regression: $ISSUE', () => {
  test('should NOT regress', () => {
    // TODO: Add test case that reproduces original bug
    // This ensures the fix doesn't get accidentally reverted
    expect(true).toBe(true); // Placeholder
  });
});
EOF
    echo "✅ Regression test template created: test/regression-$ISSUE.test.js"
  fi
fi
```

### Fix 3: Root Cause Analysis Checklist (Prevents Category A & B)

**Enforce in CLAUDE.md** (see Phase 3):

When fixing an issue, ALWAYS ask:

1. Is this a symptom fix or root cause fix?
2. Could this same issue appear in other repos/layers?
3. What test would prevent this regression?
4. Should this fix live in shared config (the kit) or here?

---

## Phase 3: CLAUDE.md Learnings Integration

Add these sections to `config/CLAUDE.md`:

### New: Root Cause Checklist (Mandatory for All Fixes)

```markdown
## Root Cause Analysis — Before Committing Any Fix

Every fix (bug, lint error, test failure, CI error) must answer these:

1. **Symptom vs Root Cause**: Is this fixing the broken thing, or fixing the thing that broke it?
   - Example (Category A): Moving pattern-check.sh path is a symptom. Root cause: downstream repos hardcoded paths instead of dereferencing from `agent-kit/scripts/`.
   - If your answer is "symptom," STOP and find the root cause first.

2. **Scope of Impact**: Could this issue exist in other repos/layers?
   - Scan other repos for the same pattern: `grep -r "pattern-check" ~/Projects/ 2>/dev/null`
   - If found in 2+ places, the root cause is in shared infrastructure (the kit)

3. **Test Preventability**: What test would catch this regression if someone reverted your fix?
   - "Script path validation" test? "Lint rule compliance" test? "Type safety" test?
   - If you can't name the test, the fix is incomplete.

4. **Layer Correctness**: Where should this fix live?
   - **Shared layer** (the kit, .github, shared config): if it prevents this issue globally
   - **This repo**: if it's specific to local architecture
   - **Upstream dependency**: if it's a bug in a library or external service
   - Committing a fix at the wrong layer compounds technical debt.

5. **Graceful Degradation**: What happens when this code is under load/neglect/partial failure?
   - If the answer is "it breaks," design a fallback or fail loudly.
   - Silent degradation is the worst failure mode.

**The gate**: If you can't articulate all 5 answers, the fix is not ready for commit.
```

### New: Quality Gate Workflow (Prevents Category D)

````markdown
## Quality Gate Workflow — MANDATORY for All PRs

**No PR gets merged without evidence that gates have been run.**

1. **Develop on feature branch** — never commit to main/master
2. **Local checks** — before opening PR:
   ```bash
   npm run lint && npm run test && npm run type-check
   ```
````

3. **Open PR immediately** — even if not ready for review
4. **Run /bs:quality --merge** — tier-aware review (2/4/6 agents) + Codex at medium+
   - This stamps SHA-bound `Reviewed-By: quality` and the actual provider (`Reviewed-By: claude|codex`)
   - **Policy:** both matching trailers are required before merge; stale HEAD/base evidence is rejected.
5. **Wait for findings** — if findings, create new commit (do NOT amend)
6. **Re-run /bs:quality --merge** until no findings
7. **Merge** — only after matching `Reviewed-By: quality` and provider trailers appear

**Why not amend?**: Amended commits hide the review history. Future readers can't see what issues were found and how they were fixed.

**Exception**: Config-only changes (README, docs, non-code) in low-risk repos may use `gh pr merge` directly, if your project's policy allows it.

````

### New: Testing Strategy (Prevents Category C)

```markdown
## Automatic Test Generation — For All Fixes

When you commit a `fix:` that addresses an issue:

1. **Regression test**: Template auto-generated by pre-commit hook
   - Location: `test/regression-ISSUE-NUMBER.test.js`
   - Purpose: Verify the specific bug doesn't return
   - Minimum: Can you reproduce the original bug in code form?

2. **Integration test**: Added only if the fix touches an API boundary
   - Example: Changed how a function is called? Add a test that exercises the old + new calling patterns

3. **Edge cases**: Name 3 edge cases your fix could have missed
   - Add tests for at least 1 of them
   - Add TODOs for the other 2 with explanation why they're deferred

**The bar**: A fix without a regression test is incomplete. Make it a habit: `git add fix && git add regression-test && git commit`.
````

### New: Config File Governance (Prevents Category A Repeats)

````markdown
## Shared Config Management — Prevent Broken Refs

**Pattern-check.sh incident**: This script moved from `agent-kit/bin/` to `agent-kit/scripts/`, breaking 15+ refs across repos.

**Policy**:

- **Source of truth**: Always lives in the shared kit, never a downstream copy
- **Downstream refs**: Use one of:
  - **Environment variable**: `export PATTERN_CHECK="$HOME/.claude/scripts/pattern-check.sh"` (resolves via install symlink)
  - **Symlink**: In each repo, `ln -s ../agent-kit/scripts/pattern-check.sh ./bin/`
  - **Script wrapper**: Never hardcode paths; call a shared function that resolves the path
- **CI check**: Pre-commit hook must validate all refs to the shared kit resolve correctly

**Implementation**: Add to global pre-commit:

```bash
# Validate no hardcoded paths to the shared config repo
if git diff --cached | grep -E "agent-kit/scripts|agent-kit/commands" | grep -v "\.sh:|export "; then
  echo "❌ Hardcoded path to the shared config repo detected. Use env var or symlink instead."
  exit 1
fi
```
````

````

---

## Phase 4: Implementation Tasks

Create tasks for each fix. Run in parallel if possible:

1. **Task: Update global CLAUDE.md** — add all learnings sections
   - Estimate: 30 min
   - Blocker: none

2. **Task: Add pre-commit hook** — root cause checklist enforcement
   - Estimate: 20 min
   - Blocker: Task 1

3. **Task: Audit and fix all pattern-check.sh refs** — resolve Category A
   - Estimate: 45 min
   - Command: `grep -r "pattern-check.sh" ~/Projects/ --include="*.sh" --include="*.yaml" --include="*.json" 2>/dev/null`
   - For each ref found: convert to env var or symlink
   - Blocker: none (parallel with others)

4. **Task: Add regression test templates to 3 recent fix: commits** — test Category C
   - Estimate: 30 min
   - Blocker: none (parallel)

5. **Task: Verify /bs:quality --merge workflow** — enforce Category D
   - Check: Recent PRs have Reviewed-By trailers
   - If not: investigate why
   - Estimate: 20 min
   - Blocker: Task 1

---

## Phase 5: Evidence & Integration

### Verification Checklist

- [ ] CLAUDE.md updated with all learnings (5 new sections)
- [ ] Pre-commit hooks installed and test-passed
- [ ] All pattern-check.sh refs converted to env var / symlink
- [ ] Regression test templates added to 3+ repos
- [ ] `/bs:quality --merge` workflow documented and tested
- [ ] One full PR reviewed using new workflow end-to-end
- [ ] All changes committed and pushed with Reviewed-By trailers

### Success Criteria

After this session:
1. **No more symptom fixes**: Every fix includes root cause analysis
2. **No more silent failures**: All fixes have regression tests or TODOs explaining why not
3. **No more bypassed gates**: All PRs require Reviewed-By trailer
4. **No more broken refs**: Shared config uses env vars or symlinks
5. **Codex reviews cleaner**: Fewer findings per PR (target: <3 findings after retraining)

### Future Automates

Once stable, add to CI/CD:
```yaml
# .github/workflows/quality-gate.yml
on: [pull_request]
jobs:
  enforce-quality:
    - Run /bs:quality --merge
    - Block merge if no Reviewed-By trailer
    - Run regression test suite (all test/regression-*.test.js)
    - Fail if any hardcoded ref to the shared config repo is found
````

---

## How to Invoke

```bash
/bs:recover-quality              # Full audit + fix cycle (60-90 min)
/bs:recover-quality --audit-only # Phase 1 only (20 min)
/bs:recover-quality --fix-only   # Phase 2-3 only, skip audit (40 min)
```
