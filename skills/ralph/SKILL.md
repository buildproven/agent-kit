---
name: ralph
description: "Autonomous backlog execution with reflection, evidence, worktree isolation, and /bs:quality --merge"
disallowed-tools: AskUserQuestion
tags: [workflow, autonomous, backlog, graph, evaluation]
category: development
---

# Ralph — bounded backlog loop

**Usage**: `/bs:ralph [--target-dir <path>] [--inline] [--until "N items"] [--scope all|feature|bug|effort:S|effort:M] [--section all|high|medium|low] [--quality auto|95|98] [--classic] [--parallel] [--reflect-depth standard|deep] [--speculate auto|always|never] [--score-threshold 0.7] [--evidence-dir .claude/ralph-next] [--max-retries N] [--max-ci-retries M] [--max-quality-minutes N] [--no-compact] [--dry-run]`

**Defaults**: 10 items, Linear backlog plus any detected inline list, all
scopes/sections, automatic quality, standard reflection, speculation `auto`,
score threshold `0.7`, and a 45-minute aggregate quality budget.

This entrypoint is intentionally short. The full implementation examples,
failure matrix, parser rules, and compatibility history live in
[`reference.md`](reference.md). Read only the section needed for the current
state; do not copy the reference into another playbook.

## Non-negotiable contract

- You are the orchestrator. Drive exactly `PICK → IMPLEMENT → QUALITY →
REFLECT → DECIDE`; `INIT`, `BLOCK`, `SPLIT`, and `SPECULATE` are explicit
  transitions, not informal retries.
- Before unattended work, run `scripts/autonomous-loop-runtime.js admit` with
  the long-lived loop's owner PID and `--provider codex|claude` matching the
  executing provider. The bundled adapter queries CodexBar; see
  `../../docs/provider-usage.md` for per-computer setup. Never expose credentials or raw usage data;
  state belongs under `$XDG_STATE_HOME/claude-kit/autonomous-loops/`.
- Each item gets a fresh provider process and an isolated feature branch or
  worktree. Inline items are ephemeral and never update Linear.
- `QUALITY` is mandatory before a Linear item can be completed. Run one
  `/bs:quality --merge --level <auto|95|98>` per attempt; never run concurrent
  quality campaigns on the same branch/worktree.
- A failed quality gate is never a pass. Use the failure-class retry budget;
  after the bounded retry/split/speculate path, quarantine the item and leave
  the evidence visible.
- Stop after eight state transitions for one item. Respect `--until`,
  `--max-retries`, `--max-ci-retries`, `--max-quality-minutes`, and the
  context-break handoff reported by `autonomous-loop-runtime.js`.

## State flow

```text
INIT → PICK → IMPLEMENT → QUALITY → REFLECT → DECIDE
  ↑      │                                      │
  └──────┴────────────── BLOCK ←───────────────┘
                         │
              SPLIT / SPECULATE → PICK or QUALITY
```

`DECIDE` may mark an item done only after quality passes and the trajectory
score is recorded. A low score is diagnostic; it cannot override a hard gate.
After an exact-head merge, run `product-completion.js next` against the
governing PRD and tasks: contract-done selects the next implementation task;
implementation-done selects the next implementation task or reports a hosted
gate; product-done is valid only when no required task remains. Empty or
malformed PRD evidence is `UNVERIFIED`, never success. At session end,
finalize state and promote only bounded, actionable learnings.

## Start safely

Resolve the runtime from `CLAUDE_KIT_ROOT`, `CLAUDE_PLUGIN_ROOT`, or the
installed `~/.claude/scripts` symlink. Resolve `--target-dir` before any git
operation; if no target is supplied, require the current directory to be a git
root. Initialize `.claude/ralph-next`, parse inline items with
`scripts/inline-list-parser.js`, and use Linear directly when the repository has
no `BACKLOG.md`. For a dry run, print the selected queue and stop.

```bash
RUNTIME="${CLAUDE_KIT_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}}/scripts"
[ -f "$RUNTIME/ralph-next-run.sh" ] || { echo "ralph runtime not found" >&2; exit 1; }
bash "$RUNTIME/ralph-next-run.sh" init --evidence-dir .claude/ralph-next \
  --until "${UNTIL_CONDITION:-10 items}" --scope "${SCOPE_FILTER:-all}" \
  --section "${SECTION_FILTER:-all}" --quality "${QUALITY_LEVEL:-auto}" \
  --max-retries "${MAX_RETRIES:-3}" --max-ci-retries "${MAX_CI_RETRIES:-2}"
```

Use [`reference.md`](reference.md) for target resolution, inline/Linear queue
merging, parallel independence rules, trajectory scoring, retry routing,
quality evidence commands, context-break handoff, and the finalization checklist.
The executable runner remains the source of truth for state persistence and
completion checks.

## Evidence and completion

Persist `PICK`, `IMPLEMENT`, `QUALITY`, `REFLECT`, and `DECIDE` transitions in
`.claude/ralph-next/trajectory-log.jsonl`; store item evidence under
`.claude/ralph-next/evidence/`. Record quality and CI outcomes before updating
Linear. At the end run:

```bash
bash "$RUNTIME/ralph-next-run.sh" finalize --evidence-dir .claude/ralph-next
```

Validate the runtime with `bash scripts/test-ralph-next.sh` and the repository's
authoritative `scripts/verify` gate. Do not compact and continue after a
`context-break` response requiring a fresh launch.
