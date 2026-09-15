---
name: ralph
description: "Autonomous backlog execution with reflection, evidence, worktree isolation, and /bs:quality --merge"
# Runs unattended (forked, no user in the loop). AskUserQuestion here would
# block forever with nobody to answer it — remove the tool, don't just ask it
# nicely not to. https://code.claude.com/docs/en/skills
disallowed-tools: AskUserQuestion
tags: [workflow, autonomous, backlog, graph, evaluation]
category: development
---

> On-demand reference for the Ralph entrypoint. The contract and state flow
> that must survive compaction are in `SKILL.md`; this file contains the detailed
> mechanics and historical rationale.

# Ralph — Graph-Orchestrated Backlog Loop

**Usage**: `/bs:ralph [--target-dir <path>] [--inline] [--until "N items"] [--scope all|feature|bug|effort:S|effort:M] [--section all|high|medium|low] [--quality auto|95|98] [--classic] [--wt] [--parallel] [--reflect-depth standard|deep] [--speculate auto|always|never] [--score-threshold 0.7] [--evidence-dir .claude/ralph-next] [--max-retries N] [--max-ci-retries M] [--max-quality-minutes N] [--no-compact] [--dry-run]`

**Defaults**: 10 items, all scopes, all sections, auto quality, standard reflect depth, speculate auto, score threshold 0.7

**Backlog sources (Linear OR inline OR both):**

1. **Linear** — `mcp__linear__list_issues(filter: { state: { name: { eq: "Backlog" } } }, orderBy: "priority", first: 1)`; mark done with `mcp__linear__update_issue(id, stateId)`.
2. **Inline** — markdown bullets / numbered items in `$ARGUMENTS` are auto-detected and synthesized into ephemeral backlog items (not written to Linear).
3. **Both** — when both are present, the inline list is appended to the Linear queue **for this run only** and gets the same state-machine treatment.

`--inline` forces inline-list interpretation if auto-detection misfires.

State machine: `PICK -> IMPLEMENT -> QUALITY -> REFLECT -> DECIDE`

**Arguments received:** $ARGUMENTS

## Fresh-campaign and budget contract

Do not fork this long-running loop from the caller's transcript. The initial
invocation runs in its current session; unattended runners start one fresh,
non-persistent provider process per item through `scripts/provider-run.sh`.
That runner uses `codex exec --ephemeral` or Claude's
`--no-session-persistence`, so an item receives only its explicit prompt and
the persisted backlog/quality state—not its parent's session history.
The unattended launcher also passes conservative execution facts through the
[Compute Governor](../../docs/compute-governor.md), which persists the exact
provider/model/effort plan before launch. It never claims localization or
targeted proof that the caller has not established.

Before an unattended run, acquire operator-scoped admission with
`scripts/autonomous-loop-runtime.js admit`. Its launcher **must** pass the
long-lived loop's `--owner-pid` (Bash: `"$$"`), never the short-lived `node`
child. Pass `--provider codex` or `--provider claude`, matching the provider
that will execute the loop. The bundled adapter queries CodexBar with local
authentication and validates evidence freshness. Install CodexBar on each
computer as described in `../../docs/provider-usage.md`. It prints only:

```json
{ "provider": "codex", "windows": { "primary": 12, "secondary": 18 } }
```

The default gate refuses a new loop at 70% on any reported window, refuses a third
loop across all repositories for the operator, and records only sanitized
percentages/outcomes under `$XDG_STATE_HOME/claude-kit/autonomous-loops/`.
Never put account credentials, raw usage responses, or that telemetry in a
repository.

## Governed provider launch

When interactive Ralph has inspected an item, write a schema-v2 phase request
that states its policy-known caller, canonical phase, planned paths, protected
surfaces, scope, ambiguity, and targeted deterministic proof. The governor
derives access and keeps execution at the reliable `standard` baseline unless a
protected floor requires `critical`. The unattended shell launcher cannot infer
paths safely, so it declares repository-wide planned scope; newly discovered
protected paths still stop before handoff. Resolve the request through the kit's
Compute Governor:

```bash
node "$SCRIPT_DIR/compute-governor.js" resolve-phase-execution \
  "$EVIDENCE_DIR/item-phase-request.json" \
  "$EVIDENCE_DIR/item-prompt.md" \
  "$TARGET_DIR" \
  > "$EVIDENCE_DIR/item-plan.json"
```

The plan is a proposed route. `economy-*` remains a calibration candidate until
the configured evidence promotes it; protected work may never be routed below
its safety floor. Launch the fresh child through the plan, never by inheriting
the current session model or effort:

```bash
bash "$SCRIPT_DIR/provider-run.sh" \
  --prompt-file "$EVIDENCE_DIR/item-prompt.md" \
  --phase-request "$EVIDENCE_DIR/item-phase-request.json" \
  --caller interactive-ralph \
  --provider codex \
  --fallback none \
  --target-dir "$TARGET_DIR" \
  --output-dir "$EVIDENCE_DIR/provider-output"
```

`provider-run.sh` resolves and validates the plan before spawning Codex, pins
model/effort, derives sandbox access, and writes a redacted schema-v2
`run-record.json`. Claude remains on the legacy v1 path until its phase adapter
has an OS-enforced sandbox.
An unsupported or mismatched plan is a launch failure; do not silently fall
back to the interactive model. Two matching failures are a concrete escalation
trigger. A model asking for more compute is not.

For corrupt admission state, stop that loop and use its exact ID (or the
64-character filename hash) for this audited repair. It refuses readable
records, so cannot silently free a live loop:

```bash
node "$AUTONOMOUS_RUNTIME" repair \
  --id "$LOOP_ID" \
  --confirm remove-corrupt-record
```

After each completed item, if the runtime reports observed transcript/context
tokens at or above `RALPH_CONTEXT_CAP_TOKENS` (default 80000), atomically mark
the exact state file for a fresh handoff:

```bash
AUTONOMOUS_RUNTIME="$(dirname "$SCRIPT")/autonomous-loop-runtime.js"
node "$AUTONOMOUS_RUNTIME" context-break \
  --state "$EVIDENCE_DIR/state.json" \
  --observed-tokens "$OBSERVED_CONTEXT_TOKENS" \
  --cap-tokens "${RALPH_CONTEXT_CAP_TOKENS:-80000}"
```

When that returns `"breakRequired":true`, stop this campaign after state is
written; do not compact and continue. Launch a new process through
`autonomous-loop-runtime.js fresh-launch` with the state file and target
directory. The new agent reads only that handoff and resumes remaining items.

## Execution

**YOU are the orchestrator.** The shell script provides utilities for quality checks, state tracking, and backlog updates. YOU drive the PICK→IMPLEMENT→QUALITY→REFLECT→DECIDE loop.

```bash
# Resolve the kit root rather than assuming a checkout location. The last
# candidate is the installed symlink (install.sh links scripts/ into ~/.claude),
# so this works for a plain `./install.sh` user with no env vars set.
for c in \
  "${CLAUDE_KIT_ROOT:-}/scripts/ralph-next-run.sh" \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/ralph-next-run.sh" \
  "$HOME/.claude/scripts/ralph-next-run.sh"; do
  if [ -n "$c" ] && [ -f "$c" ]; then SCRIPT="$c"; break; fi
done
[ -n "${SCRIPT:-}" ] || { echo "ralph: cannot locate ralph-next-run.sh" >&2; exit 1; }
EVIDENCE_DIR=".claude/ralph-next"
```

### Inline-backlog detection (auto)

Before talking to Linear, check whether `$ARGUMENTS` contains an inline markdown list.
The parser ships with claude-kit; resolve via several candidates so this works whether
ralph is invoked from claude-kit (parser at `scripts/`) or a downstream consumer.

```bash
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

if [[ -n "$PARSER" ]]; then
  LIST_JSON=$(printf '%s' "$ARGUMENTS" | node "$PARSER" 2>/dev/null || echo '{"isList":false,"items":[],"slugs":[]}')
else
  LIST_JSON='{"isList":false,"items":[],"slugs":[]}'
fi
INLINE_IS_LIST=$(echo "$LIST_JSON" | jq -r '.isList')

# Explicit override
if [[ "$ARGUMENTS" == *"--inline"* ]]; then INLINE_IS_LIST=true; fi
```

Detection rules (see `scripts/inline-list-parser.js` in claude-kit for the canonical
implementation and `scripts/__tests__/inline-list-parser.test.js` for tests):

- Requires **2+** items. A single bullet is treated as a normal task description.
- Accepts `-`, `*`, `+`, `1.`, `1)` styles. Mixed styles within one list are fine.
- Continuation/nested-detail lines are folded back into the preceding item.
- Inline dashes in a single-line task are NOT treated as bullets.

**Ephemeral items shape** — each inline item becomes:

```json
{
  "id": "INLINE-<n>",
  "description": "<full item text>",
  "type": "feature",
  "effort": "M",
  "score": 0.5,
  "source": "inline"
}
```

When both Linear and inline are present, the merged queue is `linear_items ++ inline_items`
for this run only. Inline items are NEVER written back to Linear; completion of an inline
item just marks the item Done in the ephemeral queue.

### Linear mode (repos without BACKLOG.md)

Repos that have migrated to Linear (no `BACKLOG.md` in repo root) run in **Linear-only mode**. The orchestrator must drive backlog operations via Linear MCP directly — the legacy `pick-items` / `complete-item` / `block-item` script subcommands require BACKLOG.md and will exit 0 with a "Linear-only mode" warning.

**Safe to call in any mode:** `init`, `log-traj`, `update-item`, `finalize`, `list-completed-ids`, `run-quality`, `write-quality-evidence`

**Linear-only replacements:**

| Legacy subcommand | Linear MCP replacement          |
| ----------------- | ------------------------------- |
| `pick-items`      | list Backlog issues by priority |
| `complete-item`   | update issue state to Done      |
| `block-item`      | add the `blocked` label         |

Trajectory logging (`log-traj`) and state updates (`update-item`) continue to work normally and should still be called for evidence-mode runs.

## Flags

| Flag                    | Default                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target-dir`          | **inherit cwd**        | Target repo path. Required when invoked from a forked context whose cwd is a harness scratch dir. Falls back to `$BS_RALPH_TARGET_DIR` if set.                                                                                                                                                                                                                                                                                                                                                |
| `--inline`              | **disabled**           | Force inline-list interpretation of `$ARGUMENTS` (otherwise auto-detected for 2+ bullets)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--until`               | **"10 items"**         | Stop condition: `"N items"`, `"N hours"`, `"checkpoint:name"`, `"item:SN-123"`, `"empty"`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--scope`               | **all**                | Filter by type: `all`, `feature`, `bug`, `effort:S`, `effort:M`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--section`             | **all**                | Filter by backlog section: `all`, `high`, `medium`, `low`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--quality`             | **auto**               | Quality level passed to `/bs:quality --merge --level`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--classic`             | **disabled**           | Simplified mode: skip reflection/evidence/speculate, just PICK→IMPLEMENT→QUALITY loop                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--reflect-depth`       | **standard**           | `standard` = classify + score, `deep` = include extra root-cause search before decide                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--speculate`           | **auto**               | `auto` triggers on effort:M+ or retry>=2, `always` enables every routed speculate, `never` disables                                                                                                                                                                                                                                                                                                                                                                                           |
| `--score-threshold`     | **0.7**                | Minimum trajectory score to label PASS when quality passes                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--evidence-dir`        | **.claude/ralph-next** | Base path for next-mode state/evidence logs                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--max-retries`         | **3**                  | Generic retry cap (also bounded by failure-class budgets)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--max-ci-retries`      | **2**                  | CI recovery attempts after PR creation                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--max-quality-minutes` | **45**                 | **Aggregate** wall-clock budget for all quality runs across the whole ralph loop. Each `/bs:quality --merge` is individually bounded (~4–12 min), but N items multiply that; when the total is exhausted, stop entering QUALITY for new items and route the remainder to `BLOCK` as `SWEEP_BUDGET_EXHAUSTED`. Distinct from `--until "N hours"` (which bounds the entire loop including implement/reflect); this bounds only the quality-run time so one slow campaign can't consume the run. |
| `--no-compact`          | **disabled**           | Skip `/compact` between items                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--parallel`            | **disabled**           | Process up to MAX_TEAMMATES (5) independent items simultaneously via background worktree agents                                                                                                                                                                                                                                                                                                                                                                                               |
| `--dry-run`             | **disabled**           | Show selected items and routing plan without execution                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## State Graph

```text
INIT -> PICK -> IMPLEMENT -> QUALITY -> REFLECT -> DECIDE
  ^       |                                        |
  |       +-------------------------------> END    |
  |                                                |
  +---- PICK <- BLOCK <- DECIDE -> SPLIT -> PICK <-+
                           |
                           +-> SPECULATE -> QUALITY
```

**Loop guard:** hard cap of **8 state transitions per item**. If exceeded, route item to `BLOCK`.

## State Responsibilities

| State       | Action                                                                                                          | Exit               |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| `INIT`      | Parse, initialise evidence, enforce git hygiene, preload learnings, detect inline items.                        | `PICK`             |
| `PICK`      | Select a matching unblocked item. On exhausted quality budget, block the remainder as `SWEEP_BUDGET_EXHAUSTED`. | `IMPLEMENT`/`END`  |
| `IMPLEMENT` | Isolated branch; apply relevant prior learning.                                                                 | `QUALITY`          |
| `QUALITY`   | Time `/bs:quality --merge --level <quality>`, record CI/merge result and aggregate budget.                      | `REFLECT`/`DECIDE` |
| `REFLECT`   | Classify, score, and write evidence.                                                                            | `DECIDE`           |
| `DECIDE`    | Apply hard gate, retry matrix, and budgets.                                                                     | next route         |
| `SPLIT`     | Create child items; inline children stay ephemeral.                                                             | `PICK`             |
| `SPECULATE` | Two isolated strategies; first passing branch wins.                                                             | `QUALITY`/`BLOCK`  |
| `BLOCK`     | Quarantine; file a recovery issue only for Linear items.                                                        | `PICK`             |
| `END`       | Promote learnings and write session stats.                                                                      | terminal           |

## Trajectory Evaluation

### Stage A - Hard Quality Gate

If `/bs:quality` fails, the item cannot be PASS or MARGINAL. Score is still logged for diagnostics, but routing is based on failure type.

### Stage B - Score Banding (only after Stage A pass)

```text
score = (quality_coverage * 0.4) + (first_attempt * 0.2) + (duration_ratio * 0.2) + (learning_value * 0.2)
```

| Component          | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| `quality_coverage` | `passed_checks / applicable_checks` (handles N/A checks) |
| `first_attempt`    | `1.0 / (1 + retries)`                                    |
| `duration_ratio`   | `clamp(estimated_minutes / actual_minutes, 0, 1)`        |
| `learning_value`   | 0.2 base + 0.4 patterns + 0.4 gotchas                    |

**Thresholds:** `>= score-threshold` => PASS | `0.4-0.69` => MARGINAL | `<0.4` => FAIL | Effort `L` may use 0.6 warning threshold

## Failure-Class Retry Matrix

| Failure Type             | 1st                      | 2nd                           | 3rd                | Budget |
| ------------------------ | ------------------------ | ----------------------------- | ------------------ | ------ |
| `lint`                   | Retry auto-fix           | Retry targeted fix            | Block              | 2      |
| `typecheck`              | Retry targeted fix       | Retry broader refactor        | Block              | 2      |
| `import`                 | Retry export/path fix    | Retry config alias fix        | Block              | 2      |
| `test`                   | Retry targeted test+impl | Split into subtasks           | Speculate -> Block | 3      |
| `build:code`             | Retry code fix           | Split module                  | Block              | 2      |
| `build:config`           | Retry config fix         | Escalate backlog item         | -                  | 1      |
| `security:critical-high` | Escalate immediately     | -                             | -                  | 0      |
| `security:moderate-low`  | Retry guided fix         | Escalate backlog item         | -                  | 1      |
| `flaky-test`             | Rerun + stabilize        | Quarantine + annotate         | Block              | 1      |
| `env/tooling`            | Cache clear + reinstall  | Fresh bootstrap retry         | Block              | 2      |
| `oom/resource`           | Reduce concurrency retry | Split scope                   | Block              | 2      |
| `timeout`                | Split scope              | Speculate simplified approach | Block              | 2      |
| `merge-conflict`         | Rebase + resolve         | Escalate manual conflict      | -                  | 1      |

## Backward Compatibility Contract

Use exactly one `/bs:quality --merge --level [auto|95|98]` per attempt and never
concurrently on the same branch/worktree. `--classic` never writes next-mode
state; parallel work uses worktrees; inline items never write to Linear.

## Implementation

### Step -1: Resolve Target Repo (forked-context safety)

```bash
# Pre-parse --target-dir <path> (or --target-dir=<path>, --target <path>) so the
# skill can be pointed at a specific repo when invoked from a forked context
# whose own cwd is a harness scratch dir, not the target repo. Without this
# the subsequent `git checkout main && git pull` runs against whatever happens
# to be the agent's cwd — silently mutating the wrong tree (or failing because
# there's no git repo there at all). Mirrors the pattern from skills/quality.
TARGET_DIR=""
prev_arg=""
for arg in "$@"; do
  case "$prev_arg" in
    --target-dir|--target) TARGET_DIR="$arg" ;;
  esac
  case "$arg" in
    --target-dir=*|--target=*) TARGET_DIR="${arg#*=}" ;;
  esac
  prev_arg="$arg"
done

# Precedence: explicit --target-dir > $BS_RALPH_TARGET_DIR > cwd.
# The env var lets a spawning agent harness export the target once and have
# every forked /bs:ralph invocation pick it up — same convention as quality's
# $BS_QUALITY_TARGET_DIR (PR #22).
TARGET_DIR_SOURCE=""
if [ -n "$TARGET_DIR" ]; then
  TARGET_DIR_SOURCE="--target-dir"
elif [ -n "${BS_RALPH_TARGET_DIR:-}" ]; then
  TARGET_DIR="$BS_RALPH_TARGET_DIR"
  TARGET_DIR_SOURCE="\$BS_RALPH_TARGET_DIR"
fi

if [ -n "$TARGET_DIR" ]; then
  TARGET_DIR="${TARGET_DIR/#\~/$HOME}"
  if [ ! -d "$TARGET_DIR" ]; then
    echo "❌ target dir does not exist (source=$TARGET_DIR_SOURCE): $TARGET_DIR"
    exit 1
  fi
  echo "[ralph] target-dir=$TARGET_DIR (source=$TARGET_DIR_SOURCE)"
  cd "$TARGET_DIR" || { echo "❌ failed to cd to target dir: $TARGET_DIR"; exit 1; }
fi

GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$GIT_ROOT" ]; then
  echo "❌ /bs:ralph could not resolve a git root from $(pwd)."
  echo "   Pass --target-dir <path> or set \$BS_RALPH_TARGET_DIR when invoking from a forked context."
  exit 1
fi
cd "$GIT_ROOT" || exit 1
```

### Step 0: Parse Arguments and Bootstrap

Parse `$ARGUMENTS` and extract:

```
UNTIL_CONDITION  (default: "10 items")
SCOPE_FILTER     (default: "all")
SECTION_FILTER   (default: "all")
QUALITY_LEVEL    (default: "auto")
REFLECT_DEPTH    (default: "standard")
SPECULATE_MODE   (default: "auto")
SCORE_THRESHOLD  (default: "0.7")
MAX_RETRIES      (default: 3)
MAX_CI_RETRIES   (default: 2)
DRY_RUN          (default: false)
PARALLEL         (default: false; "--parallel" enables)
EVIDENCE_DIR     (default: ".claude/ralph-next")
MODE             (default: "next"; "--classic" sets "classic")
INLINE_IS_LIST   (auto-detected; "--inline" forces true)
```

**Classic mode**: PICK→IMPLEMENT→QUALITY only; no reflection, evidence, or
speculation. Branch, quality, merge, and inline handling remain unchanged.

```bash
bash "$SCRIPT" init \
  --evidence-dir "$EVIDENCE_DIR" \
  --until "$UNTIL_CONDITION" --scope "$SCOPE_FILTER" \
  --section "$SECTION_FILTER" --quality "$QUALITY_LEVEL" \
  --reflect-depth "$REFLECT_DEPTH" --speculate "$SPECULATE_MODE" \
  --score-threshold "$SCORE_THRESHOLD" \
  --max-retries "$MAX_RETRIES" --max-ci-retries "$MAX_CI_RETRIES"

linear_items_json=$(bash "$SCRIPT" pick-items --evidence-dir "$EVIDENCE_DIR")

# Synthesize ephemeral items from inline list if detected
if [ "$INLINE_IS_LIST" = "true" ]; then
  inline_items_json=$(echo "$LIST_JSON" | jq -c '
    [ .items as $items | .slugs as $slugs |
      range(0; ($items | length)) |
      { id: ("INLINE-" + ((. + 1) | tostring)),
        description: $items[.],
        slug: $slugs[.],
        type: "feature",
        effort: "M",
        score: 0.5,
        source: "inline" } ]
  ')
else
  inline_items_json='[]'
fi

# Merge: Linear items first (priority order), then inline items appended
items_json=$(jq -c -s '.[0] + .[1]' <(echo "$linear_items_json") <(echo "$inline_items_json"))
item_count=$(echo "$items_json" | jq 'length')
```

If `item_count` is 0: print "No pending items matched filters (and no inline list provided)" and stop.

**Dry run**: If `--dry-run`, print the item table and stop:

```bash
echo "$items_json" | jq -r '.[] | "- \(.id) [\(.type)] [effort:\(.effort)] [score:\(.score)] [source:\(.source // "linear")] \(.description)"'
```

**SOTA staleness check (auto-run if >7 days stale):**

```bash
# Must match where the SOTA skill actually writes: `.claude/sota-history.json`
# in the current project. This previously read "$SETUP_REPO/data/..." — a
# variable nothing in this repo defines — so the path collapsed to
# "/data/sota-history.json", the file was never found, and the "history
# missing" branch fired on EVERY run. The staleness check could therefore
# never observe a fresh SOTA run, which is the one thing it exists to do.
SOTA_HISTORY=".claude/sota-history.json"
if [ -f "$SOTA_HISTORY" ]; then
  LAST_DATE=$(jq -r '.lastUpdated // empty' "$SOTA_HISTORY")
  if [ -n "$LAST_DATE" ]; then
    LAST_EPOCH=$(date -j -f "%Y-%m-%d" "${LAST_DATE%T*}" "+%s" 2>/dev/null || date -d "$LAST_DATE" "+%s")
    DAYS_AGO=$(( ($(date "+%s") - LAST_EPOCH) / 86400 ))
    if [ "$DAYS_AGO" -gt 7 ]; then
      echo "⚠️  SOTA last run ${DAYS_AGO} days ago — run the SOTA skill before the main loop"
    fi
  else
    echo "⚠️  SOTA never run — run the SOTA skill before the main loop"
  fi
else
  echo "⚠️  SOTA history missing — run the SOTA skill before the main loop"
fi
```

If SOTA is stale, invoke it before the loop; skip for `--dry-run` or all-inline runs.

### Step 1: Git Hygiene

```bash
git checkout main && git pull && git fetch --prune
git branch --merged main | grep -v 'main' | xargs -r git branch -d
git branch -vv | grep ': gone]' | awk '{print $1}' | xargs -r git branch -D
gh api repos/:owner/:repo --jq '.delete_branch_on_merge' | grep -q true || gh api repos/:owner/:repo -X PATCH -f delete_branch_on_merge=true > /dev/null
```

### Step 1.5: Parallel Execution (--parallel flag)

If `PARALLEL` is true, bypass the sequential graph loop and run independent items concurrently.

**Independence detection:** Before spawning parallel workers, classify items as independent or serial.

```
SERIAL_FILES = ["package.json", "tsconfig.json", "CLAUDE.md", "settings.json",
                "eslint.config.cjs", ".eslintrc.*", "tailwind.config.*",
                "next.config.*", "vercel.json", ".github/workflows/*"]
MAX_TEAMMATES = 5

# For each item, extract file path references from title + description
# Independence rules:
#   1. If item references any SERIAL_FILES -> must run serially
#   2. If two items reference overlapping files/directories -> must run serially
#   3. If item has no detectable file references -> treat as independent (optimistic)
#   4. Items touching completely different directories = independent
```

**Spawn parallel workers:** Each independent item gets its own background Agent with worktree isolation. **Inline items follow the same rules — they get worktree isolation per the parallel-agents-worktree policy.**

**Wait and aggregate:** After all workers complete, collect results and update Linear state (for Linear-sourced items only — inline items stay in the ephemeral queue and are reported in the session summary).

**Serial fallback:** After the parallel batch, process `serial_items` using the normal sequential graph loop.

If `--parallel` is not set, skip this step entirely and proceed to Step 2.

### Step 2: Main Graph Loop

Iterate through items in `items_json`. For each item track:

- `attempts=0`, `transitions=2` (PICK + IMPLEMENT already logged)
- `last_failure_type`, `same_failure_streak`, `final_decision`

#### PICK State

```bash
item_id=$(echo "$item" | jq -r '.id')
item_desc=$(echo "$item" | jq -r '.description')
item_type=$(echo "$item" | jq -r '.type')
item_effort=$(echo "$item" | jq -r '.effort')
item_source=$(echo "$item" | jq -r '.source // "linear"')

bash "$SCRIPT" log-traj "$item_id" PICK "{\"mode\":\"next\",\"source\":\"$item_source\"}" --evidence-dir "$EVIDENCE_DIR"
```

#### IMPLEMENT State — **YOU do this work**

1. **Create a feature branch** (use `--wt` flag for worktree isolation; mandatory for inline items per the parallel-agents-worktree rule)
2. **Read and understand the item** — read relevant source files, understand the codebase
3. **Implement using your tools:** Use Read, Edit, Write, Bash as needed
4. **Commit and create PR with auto-merge**
5. **Log the transition**

#### QUALITY State

**MANDATORY: This state MUST run before `complete-item` is called.**

```bash
attempts=$((attempts + 1))
/bs:quality --merge --level "$QUALITY_LEVEL"
quality_exit=$?
quality_passed=$([ $quality_exit -eq 0 ] && echo true || echo false)
failure_type=$([ $quality_exit -ne 0 ] && echo "quality" || echo "")

bash "$SCRIPT" write-quality-evidence "$item_id" "$attempts" "$quality_passed" "$failure_type" \
  --evidence-dir "$EVIDENCE_DIR"
```

#### REFLECT State

Compute trajectory score, classify failure, write evidence:

```
quality_coverage = 1 if quality_passed else 0
first_attempt    = 1 / attempts
duration_ratio   = 1.0 if first attempt, 0.7 if retry
learning_value   = 0.6 if quality_passed, 0.2 otherwise
score = (quality_coverage * 0.4) + (first_attempt * 0.2) + (duration_ratio * 0.2) + (learning_value * 0.2)
```

#### DECIDE State

Apply Stage A (hard gate), then Stage B (scoring) using the Failure-Class Retry Matrix.

**Transition guard**: If `transitions >= 8`, force `decision=block`.

- **pass/marginal**: complete item, update Linear to Done, compact, next PICK
- **retry**: fix failure within budget, back to IMPLEMENT
- **speculate**: run 2 isolated worktree strategies in parallel; first passing wins
- **split**: create 2–3 child Linear issues, mark parent as `split-parent`
- **block**: quarantine item, continue to next PICK

### Step 3: Session End

```bash
bash "$SCRIPT" finalize --evidence-dir "$EVIDENCE_DIR"
```

Print summary: items completed, items blocked, average trajectory score.

Sync evidence files, promote learnings to `docs/session-learnings.md`, sync learning index.

#### Anti-drift rule for learnings promotion

Before appending to `docs/session-learnings.md` (or any CLAUDE.md / agent-learning file), capture the current size:

```bash
wc -l docs/session-learnings.md
```

**Net change must be ≤ +10 lines per session.** For every addition, name one existing line to narrow, consolidate, or remove. Vague accommodations accumulate into soup — without this constraint, learnings files grow unbounded and stop being read.

Only promote insights with a clear process implication: "stop doing X because we hit Y" or "always do X before Y because Z." Skip "keep doing" confirmations of rules already present. If a section keeps growing across sessions, that is the signal to split it into a dedicated doc, not to keep appending.

If proposed additions exceed +10 net lines, revise to consolidate before committing.

## Automation Running Underneath

Each item's push/PR triggers automatically:

- **Pre-push hook**: format, lint, security scan, gitleaks, pattern checks
- **Harness Gate CI**: risk-tiered checks on every PR
- **Stop hook**: validates output quality (no console.log, TODO, `any`, debugger)

## Files Produced

- `.claude/ralph-next/state.json`
- `.claude/ralph-next/trajectory-log.jsonl`
- `.claude/ralph-next/evidence/<ITEM_ID>.json`
- `.claude/session-learnings.md`

## Examples

```bash
/bs:ralph
/bs:ralph --until "3 items" --score-threshold 0.75
/bs:ralph --scope bug --speculate never
/bs:ralph --reflect-depth deep --until "2 hours"
/bs:ralph --classic --until "3 items"
/bs:ralph --dry-run
/bs:ralph --parallel --until "5 items"
```

## Validation

```bash
bash scripts/test-ralph-next.sh
```
