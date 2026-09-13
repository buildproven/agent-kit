---
name: dev
description: Start development work (features, bugs, refactoring, experiments)
---

# /bs:dev - Start Development Work

**Usage**: `/bs:dev <name|inline-list> [--fix|--refactor|--experiment] [--with-tests] [--tdd] [--wt] [--parallel "task1,task2,task3"] [--list] [--sequential] [--max=N] [--teams] [--next] [--alt] [--no-ship]`

Generic command for all development work. Auto-detects branch type or use flags.

**Quick start with backlog:**

```bash
/bs:dev --next    # Auto-picks highest-priority item from Linear
```

## Auto-Detection

- `fix-*`, `bugfix-*`, `hotfix-*` → `fix/`
- `refactor-*` → `refactor/`
- `experiment-*`, `exp-*`, `test-*` → `experiment/`
- Everything else → `feature/`

## Flags (Override Auto-Detection)

```bash
/bs:dev login-bug --fix        # fix/login-bug
/bs:dev auth --refactor        # refactor/auth
/bs:dev ai --experiment        # experiment/ai
```

## Implementation

### Step 0a: Ensure Working Directory is Git Root

```bash
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$GIT_ROOT" ]]; then echo "❌ Not in a git repository"; exit 1; fi
cd "$GIT_ROOT"
echo "📂 Working directory: $GIT_ROOT"
```

### Step 0b: Branch Hygiene - Ensure Clean State

**Critical:** Before creating any feature branch, clean up stale branches to prevent working from wrong state.

```bash
# Refresh remote lifecycle evidence without checking out, editing, or
# fast-forwarding the inspection-only primary checkout.
git fetch --prune

# Resolve the one shared lifecycle implementation. It may prune missing
# registrations here, but it never removes active, dirty, locked, open-PR,
# unpushed, or inconclusive worktrees.
WORKTREE_MANAGER=$(for candidate in \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/worktree-manager.js" \
  "${CLAUDE_KIT_ROOT:-}/scripts/worktree-manager.js" \
  "$HOME/.claude/scripts/worktree-manager.js" \
  "$GIT_ROOT/scripts/worktree-manager.js"; do
  [ -f "$candidate" ] && { printf '%s\n' "$candidate"; break; }
done)
[ -n "$WORKTREE_MANAGER" ] || {
  echo "❌ worktree-manager.js is required; run the kit sync/install workflow."
  exit 1
}
node "$WORKTREE_MANAGER" reconcile --repo "$GIT_ROOT" --repair-stale >/dev/null

# Ensure repo auto-deletes PR branches on merge
gh api repos/:owner/:repo --jq '.delete_branch_on_merge' | grep -q true || gh api repos/:owner/:repo -X PATCH -f delete_branch_on_merge=true > /dev/null

echo "✅ Branch hygiene complete"
```

### Step 0c: Auto-Pick from Backlog (--next flag)

If `--next` flag is provided, automatically select the highest-priority item from Linear.

**`--next` requires the Linear MCP server.** If the `mcp__linear__*` tools are not
available in this session, say so and stop — do not guess at a task:

> `--next` needs the Linear MCP server, which isn't configured. Either set it up
> (https://linear.app/docs/mcp), or name the task directly: `/bs:dev "<what to build>"`.

Otherwise, select the highest-priority item:

```bash
# Primary: use Linear MCP
# mcp__linear__list_issues(
#   filter: { state: { name: { eq: "Backlog" } } },
#   orderBy: "priority",
#   first: 1
# )
# → extract identifier (e.g. PROJ-123), title, description
# → set NAME = identifier, ITEM_DESC = title
```

**Usage examples:**

```bash
/bs:dev --next                    # Auto-picks highest-priority Linear item
/bs:dev --next --experiment       # Auto-pick + experiment branch type
```

### Step 0d: Inline-List Detection (auto)

Before treating `$ARGUMENTS` as a single task name, detect whether it contains an inline
markdown task list. If yes, switch to **list mode** (Step 9 below).

```bash
# Locate the parser. It ships with claude-kit; resolve via several candidates so
# this works whether dev/ralph are invoked from claude-kit (vendored
# at core/), or a downstream consumer.
resolve_parser() {
  local candidates=(
    "${CLAUDE_PLUGIN_ROOT:-}/scripts/inline-list-parser.js"
    "${KIT_REPO:-}/scripts/inline-list-parser.js"
    "$(git rev-parse --show-toplevel 2>/dev/null)/core/core/scripts/inline-list-parser.js"
    "$(git rev-parse --show-toplevel 2>/dev/null)/core/scripts/inline-list-parser.js"
    "$(git rev-parse --show-toplevel 2>/dev/null)/scripts/inline-list-parser.js"
    "$HOME/.claude/scripts/inline-list-parser.js"
  )
  for p in "${candidates[@]}"; do
    [[ -n "$p" && -f "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}
PARSER=$(resolve_parser)

# Pipe full arguments to the parser; it returns JSON { isList, items[], slugs[] }
if [[ -n "$PARSER" ]]; then
  LIST_JSON=$(printf '%s' "$ARGUMENTS" | node "$PARSER" 2>/dev/null || echo '{"isList":false,"items":[],"slugs":[]}')
else
  LIST_JSON='{"isList":false,"items":[],"slugs":[]}'
fi
IS_LIST=$(echo "$LIST_JSON" | jq -r '.isList')

# `--list` forces list mode; `--sequential` and `--max=N` configure fan-out
if [[ "$ARGUMENTS" == *"--list"* ]]; then IS_LIST=true; fi
```

Detection rules (see `scripts/inline-list-parser.js` in claude-kit for the canonical
implementation and `scripts/__tests__/inline-list-parser.test.js` for the test suite):

- Requires **2+** items. A single bullet is treated as a normal task description.
- Accepts `-`, `*`, `+`, `1.`, `1)` styles. Mixed styles within one list are fine.
- Lines without an item prefix are folded into the preceding item as nested detail.
- A single line containing an inline dash (e.g. `fix logging - timestamps wrong`)
  is NOT a list.

If `IS_LIST=true`, skip Steps 1–7 and jump to **Step 9: Inline-List Mode**. Otherwise
continue with the normal single-task flow.

### Step 1: Detect Branch Type

```bash
# Parse input
NAME="$1"
TYPE="feature"  # default

# Check flags first
if [[ "$@" == *"--fix"* ]]; then
  TYPE="fix"
elif [[ "$@" == *"--refactor"* ]]; then
  TYPE="refactor"
elif [[ "$@" == *"--experiment"* ]]; then
  TYPE="experiment"
# Auto-detect from name
elif [[ "$NAME" =~ ^(fix|bugfix|hotfix)- ]]; then
  TYPE="fix"
  NAME="${NAME#*-}"  # Remove prefix
elif [[ "$NAME" =~ ^refactor- ]]; then
  TYPE="refactor"
  NAME="${NAME#refactor-}"
elif [[ "$NAME" =~ ^(experiment|exp|test)- ]]; then
  TYPE="experiment"
  NAME="${NAME#*-}"
fi

BRANCH_NAME="${TYPE}/${NAME}"
```

### Step 2: Create Branch

```bash
# Always create a canonical linked worktree. `--wt` remains accepted as a
# backward-compatible no-op; isolation is now the default and only mode.
INVOCATION_ID="bs:dev/${BRANCH_NAME}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
CREATE_JSON=$(node "$WORKTREE_MANAGER" create \
  --repo "$GIT_ROOT" \
  --branch "$BRANCH_NAME" \
  --creator "bs:dev" \
  --purpose "$NAME" \
  --invocation "$INVOCATION_ID" \
  --lock-reason "$INVOCATION_ID")
WORKTREE_DIR=$(printf '%s' "$CREATE_JSON" | jq -er '.worktreePath')
cd "$WORKTREE_DIR"
echo "✅ Created worktree: $WORKTREE_DIR (branch: $BRANCH_NAME)"
echo "📂 Working directory changed to: $(pwd)"
# /bs:quality takes ownership during merge. Otherwise release this exact
# invocation with worktree-manager unlock before explicit cleanup.

# Initialize HUD state for live dashboard display (CS-061).
# Optional: if the script can't be resolved, skip the HUD rather than failing.
for c in \
  "${CLAUDE_KIT_ROOT:-}/scripts/hud-update.sh" \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/hud-update.sh" \
  "$HOME/.claude/scripts/hud-update.sh"; do
  if [ -n "$c" ] && [ -f "$c" ]; then HUD_SCRIPT="$c"; break; fi
done
if [ -n "${HUD_SCRIPT:-}" ]; then
  "$HUD_SCRIPT" --start --command "/bs:dev" --item "$NAME" --status "running"
fi
```

### Step 3: Gather Requirements

Ask for feature behavior, technical constraints, and dependencies. For a bug,
ask for actual/expected behavior, reproduction, and errors.

Then invoke the `diagnosing-bugs` skill. Do not propose or implement a fix
until there is one red-capable command that reproduces the user's exact
symptom, unless the skill's documented blocked path applies.

Then load the `codebase-design` skill and name the interface/seam being
improved. Refactors must deepen a real module or remove accidental complexity;
do not introduce pass-through abstractions.

For an experiment, establish its hypothesis, measurement, and success criteria.

### Step 4: Assess Complexity

Use sequential thinking to analyze: file impact, approach options, architectural implications, dependencies, unknowns. Output: tier + rationale.

**Tiers:**

- **Simple**: 1-2 files, obvious approach, no architectural decisions
- **Medium**: 3-5 files, clear approach, some unknowns requiring exploration
- **Complex**: 6+ files OR architectural decisions OR multiple approaches OR many unknowns

### Step 4.25: Architecture Decision Gate (automatic)

For every task, evaluate this checklist before implementation. This is a
classification step, not a reason to use a stronger model for routine work:

- Does it change authentication, authorization, billing, or payments?
- Does it create, migrate, retain, or delete durable data?
- Does it introduce or break a public API, event schema, or external contract?
- Does it affect distributed consistency, retries, or failure ownership?
- Does it create a cross-repository dependency or another expensive-to-reverse boundary?

If all answers are **no**, record `Architecture decision: none required` in the
plan or task summary and continue at the normal medium-effort runtime profile.

If any answer is **yes**, automatically load `codebase-design`, write a short
ADR at `docs/decisions/ADR-<slug>.md`, and link it from the plan/PRD before
coding. The ADR must state the decision, alternatives, invariants, migration or
rollback, and verification. Draft it at the normal profile; run a bounded
adversarial review of the ADR at high effort (Opus in Claude Code or the
configured Codex power profile: `codex --profile power -c
'model_reasoning_effort="high"' review --uncommitted`) before implementing the
irreversible boundary. `--uncommitted` makes the newly written, not-yet-committed
ADR the review subject. Configure `power` to a current high-end model.

This is fail-closed: do not begin implementation while the ADR review has a
blocking finding, an unresolved question, malformed/inconclusive output, or a
provider failure. Revise the ADR, re-run the review, and record the clean result
in the ADR before proceeding. Large but reversible refactors do not satisfy this
trigger by size alone.

### Step 4.5: Auto-detect Parallelizable Subtasks (CS-164)

**Runs automatically when complexity = Complex.** Skipped for Simple/Medium — those run sequentially.

For a complex task, identify independently named components, predict their file
overlap, and offer parallel work only when there are at least two substantial
(>30-minute) components with at most one shared file. Show the parallel and
dependent sequential groups, then dispatch the already authorized work. Do not
infer parallelism from vague multi-area work.

### Step 5: Plan Based on Complexity

**For SIMPLE tasks:** Grep/Glob to find relevant files → TodoWrite 3-5 tasks → implement.

**MEDIUM:** explore files/patterns/dependencies, then create a specific todo.

**COMPLEX:** interview only when requested; establish
scope/constraints/edges/success/non-goals, compare approaches in plan mode, and
apply the automatic Architecture Decision Gate above. Continue automatically
with the recommended reversible approach; ask only when a material product
choice cannot be inferred safely. Re-plan if scope changes.

### Step 5.5: TDD — Write Failing Tests First (--tdd flag only)

Name the public interface and test seam first. Write one behavioral test from
the spec/acceptance criteria, verify RED for the intended reason (not an import
or setup error), implement the smallest vertical slice until GREEN, then
repeat. Expected values must come from the spec, a worked example, or another
independent oracle—not from recomputing the implementation.

### Step 6: Explore Before Implementing (Medium/Complex)

Check `docs/dev_guide/CONVENTIONS.md` first if present. Use direct tools for
small lookups. Delegate only a bounded independent task that justifies its
context and coordination cost, when current instructions permit delegation.

### Step 7: Development

Use TodoWrite to track tasks. Read files before editing. Follow project conventions. Test incrementally. Break at < 50 turns: `/bs:dev` → automatic quality/merge → `/clear`.

### Step 7.5: Auto-Generate Tests (--with-tests flag only)

Default: test quality is reviewed during `/bs:quality`. With `--with-tests`,
spawn a subagent to identify changed behavior and the highest existing public
seam that observes it. Add or update the smallest behavioral tests at that
seam. Do not create one test file per changed source file or test private
implementation details merely to satisfy a file-count heuristic. Run the
smallest evidence-backed affected set. Use the repository's committed
test-impact map when the test runner cannot infer dependencies; an unmapped
path is a mapping defect, not an automatic full-suite instruction. Complete
regression is reserved for a scheduled/release audit or an explicit risk-based
exception.

### Step 8: Autonomous delivery handoff

**Default: implementation is not terminal. Ship the exact candidate.**

Successful implementation releases the `bs:dev` ownership lock, then hands the
same worktree directly to the provider-neutral `quality` skill with `--merge`.
Do not return a completion message and wait for the user to start quality: that
gap is how verified local commits were repeatedly left unpushed and unreviewed.
A crashed or incomplete run leaves the lock as evidence and must not be taken
over automatically:

```bash
node "$WORKTREE_MANAGER" unlock \
  --repo "$WORKTREE_DIR" \
  --branch "$BRANCH_NAME" \
  --owner "$INVOCATION_ID" \
  --terminal
```

Unless the user supplied `--no-ship`, immediately invoke the `quality` skill as
if the user had run:

```text
/bs:quality --merge --target-dir "$WORKTREE_DIR"
```

Carry its result through PR creation, exact-head gates, review, merge, and safe
cleanup under the repository's normal authority policy. Provider exhaustion is
handled by quality's bounded fallback contract; it is not a reason to leave the
candidate at the handoff boundary. A real gate failure or missing authority
still blocks visibly.

`--no-ship` is the explicit escape hatch for a local experiment or a user who
asked for implementation only. In that mode, stop after releasing the terminal
lock and report the branch plus focused test evidence. Never infer `--no-ship`
from `--experiment` alone.

After exact-head merge, run the product-continuation audit when the governing
PRD and task list are present. This is separate from quality: it determines
what product behavior remains, not whether the merged revision is correct.

```bash
node "$QUALITY_SCRIPTS_DIR/product-completion.js" next \
  --prd "<governing-prd>" --tasks "<governing-task-list>"
```

- `next-implementation`: create the next safe worktree and continue.
- `external-gate`: report the named hosted or real-user validation gate.
- `product-done`: report completion only after every required task is complete.
- `UNVERIFIED`: stop the completion claim and repair malformed or empty PRD evidence.

After quality and this audit return, provide the terminal result:

```markdown
🎯 TASK COMPLETE

**Summary:**

- ✅ [Feature/fix description]
- Files changed: [count]
- Tests: [added/updated/passing]
- Documentation: [updated if needed]

**Branch:** $BRANCH_NAME
**Delivery:** [merged PR URL | concrete blocking gate | local-only (--no-ship)]

Use `/clear` after shipping to start fresh for next feature.
```

```bash
# Update HUD: Development complete, ready for quality (CS-061)
if [ -f "$HUD_SCRIPT" ]; then
  "$HUD_SCRIPT" --step "Dev complete" --status "idle"
fi
```

### Step 9: Inline-List Mode (multi-task fan-out)

Triggered when Step 0d sets `IS_LIST=true` (or `--list` is passed explicitly).

**Goal:** turn an inline markdown list of tasks into N parallel background agents,
each in its own worktree with its own feature branch, then summarize the resulting PRs.

**9.1 — Parse args**

```bash
MAX_PARALLEL=4
SEQUENTIAL=false
for tok in $ARGUMENTS; do
  case "$tok" in
    --max=*)      MAX_PARALLEL="${tok#*=}" ;;
    --sequential) SEQUENTIAL=true ;;
  esac
done
ITEMS_JSON=$(echo "$LIST_JSON" | jq -c '.')
ITEM_COUNT=$(echo "$LIST_JSON" | jq '.items | length')
```

**9.2 — Show the plan**

Print a table of items + slugs + planned branch names, then dispatch the
already authorized tasks. Honor `--max` (default 4) and warn if the user
requested more than 6 (per the "Cap 4-6 agents" rule).

**9.3 — Spawn agents (parallel by default)**

For each item, pre-create and lock its canonical target with
`worktree-manager create`, then spawn a background agent naming its exact task,
branch, and target. It must use only that worktree; infer, assess, explore,
implement with TodoWrite; release its exact lock; run
`/bs:quality --merge --target-dir TARGET_DIR`; and return branch, PR, and
passed/failed/blocked status.

If `--sequential`, await each agent before spawning the next.
If parallel, run up to MAX_PARALLEL concurrently, draining as they finish.

**9.4 — Aggregate and report**

After all agents complete, print a summary table:

```markdown
| Task                      | Branch                       | PR # | Status  |
| ------------------------- | ---------------------------- | ---- | ------- |
| add dark mode toggle      | feature/add-dark-mode-…      | #123 | merged  |
| fix login redirect safari | feature/fix-login-redirect-… | #124 | open    |
| refactor auth middleware  | feature/refactor-auth-…      | -    | blocked |
```

Plus a short prose summary: total tasks, merged, open, blocked. Suggest follow-ups
for any blocked items.

## Flags

`--next` picks Linear's top backlog item; `--tdd` and `--with-tests` enable
test-first/test-generation; `--fix`, `--refactor`, and `--experiment` select
the branch type; `--base` selects its base. `--parallel`, `--teams`,
`--no-teams`, and `--merge` control parallel delivery. `--list`, `--sequential`,
and `--max=N` control inline fan-out. `--interview` forces discovery; `--alt`
requests a second opinion. `--skip-branch` is unsupported: worktree isolation
is mandatory.

## --alt: Second Opinion Mode

With `--alt`, resolve `scripts/ensemble-runner.js` using the parser's candidate
order, then before implementation run it with the task, decision “Choose
implementation approach before coding”, providers `claude,codex`, parallel
scorecard mode, and rubric `implementation risk,complexity,maintainability,
migration cost,speed`. Present both plans; if unavailable, note the skipped
pass and continue with the local plan.

## Parallel Execution Mode

**Usage**: `/bs:dev --parallel "task1,task2,task3"`

Parse tasks → conflict analysis → show plan → spawn background agents (each in isolated worktree) → quality loop → PR → merge (if `--merge`).

### Implementation

Pre-create each canonical linked worktree with `worktree-manager`; never use a
harness-native worktree. Each worker must use only its assigned target and
branch, infer requirements, assess/explore, implement with TodoWrite, release
its exact lock at terminal handoff, run the full quality loop, and report a PR.
Only the revision-bound quality path may merge it.

### Backlog Update (After All Agents Complete)

When using `--parallel --merge`, mark completed items Done in Linear via `mcp__linear__update_issue(id, stateId)`.

### Conflict Detection and Grouping

Use Sequential Thinking to predict file impact per task. Group into **parallel**
(no conflicts) and **sequential** (shared files), then execute the already
authorized plan.

### Agent Teams Mode (`--teams`) (CS-104)

Best for 3+ independent features with tmux visibility. Default is Task subagents (faster).

```bash
if [ "$TEAMS" = true ]; then
  TeamCreate(team_name: "dev-parallel", description: "Parallel feature development")
  # TaskCreate per task; spawn one teammate per task (max 5): claim → branch → explore → implement → /bs:quality --merge → report
  # Lead monitors TaskList; pause conflicting tasks; after all complete: mark Done in Linear, TeamDelete()
fi
```

**Safety:** Limit to 3-5 parallel agents. Don't use for tasks with unclear requirements or sequential dependencies.
