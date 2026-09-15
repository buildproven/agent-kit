---
name: bs:help
standalone: true
description: "Quick reference for all /bs:* commands with flags and usage"
argument-hint: "[--full] → quick or detailed /bs:* reference"
category: maintenance
model: haiku
---

# /bs:help Command

## Model routing

Native delegation uses the shared `compute-governor` native-advisory decision.
It preserves the active coordinator. A ready decision returns model arguments
only when the current native client reports matching capability. A blocked
result never falls back silently to the runtime default; safe local work can
continue.

For Codex, use the ready `spawn_agent` model and effort arguments. For Claude,
use the ready Task profile and model alias. The profile supplies effort; check
`/tasks` for its effective model and effort. Do not change global settings.

Daily commands inherit the configured runtime default (Sonnet/medium in Claude
Code; the normal Codex profile/medium in Codex). `/bs:quality` and a triggered
ADR review may escalate a bounded adversarial pass; no command pin is a standing
Opus default.

`/bs:dev` and `/bs:plan` automatically evaluate the Architecture Decision Gate.
Only an auth/payments, durable-data, public-contract, distributed-consistency,
cross-repository, or similarly irreversible decision creates an ADR and earns a
bounded high-effort review.

Critical Claude fallback keeps every selected review role fail-closed, but a
single available model family does not discard a complete role-bound panel.

An exhausted quality provider retry can cross a legitimate descendant fix only
through an exact-new-HEAD operator override that names
`review:provider-exhaustion` and acknowledges the missing review.

Fully green protected `strict: false` delivery is autonomous through the
non-force exact-ref CAS path. During a classified Actions billing outage,
`/bs:quality approve --override-nonstrict-refcas` is the separate signed path.
It requires both missing-CI and administrator ref-mutation acknowledgements,
plus explicit acceptance that concurrent PR close or retarget state cannot
atomically cancel the update.

**Arguments received:** $ARGUMENTS

Namespaced commands are human entrypoint wrappers. Agent-visible bare skills
own executable behavior and never delegate back to a command.

For unattended loops, the runtime takes `--provider codex|claude` and reads
fresh capacity through CodexBar. Per-computer setup is in
`docs/provider-usage.md`; no hand-written usage snapshot is required.

## Instructions

**This command generates its output dynamically from command frontmatter.** Do NOT hardcode command lists.
New commands appear automatically when frontmatter is valid.

### Step 1: Extract command data

Run this bash command to extract frontmatter from all installed command files:

```bash
for f in ~/.claude/commands/bs/*.md ~/.claude/commands/cc/*.md ~/.claude/commands/gh/*.md; do
  [ -f "$f" ] || continue
  fm=$(awk 'BEGIN{n=0} /^---$/{n++; if(n==2) exit; next} n==1{print}' "$f")
  name=$(echo "$fm" | awk -F': ' '/^name:/{print $2}' | tr -d "'\"")
  desc=$(echo "$fm" | awk -F': ' '/^description:/{$1=""; sub(/^ /,""); print}' | tr -d "'\"")
  cat=$(echo "$fm" | awk -F': ' '/^category:/{print $2}' | tr -d "'\"")
  hint=$(echo "$fm" | awk -F': ' '/^argument-hint:/{$1=""; sub(/^ /,""); print}' | tr -d "'\"")
  if [ -n "$name" ] && [ -n "$desc" ]; then
    echo "CMD|${cat:-uncategorized}|${name}|${desc}|${hint}"
  fi
done
```

### Step 2: Count skills

```bash
ls ~/.claude/skills/*/SKILL.md 2>/dev/null | wc -l
```

### Step 3: Render output

Use the extracted data to generate the help output. Everything in the kit is free
and MIT — there is no paid tier and no upgrade section.

Group commands by `category` field using the display order and titles below. Omit
commands with `category: deprecated`.

**Category display order and titles:**

| category    | Display Title              |
| ----------- | -------------------------- |
| quality     | Quality & Production       |
| release     | Quality & Production       |
| development | Development Workflow       |
| workflow    | Development Workflow       |
| agents      | Agent & Session Management |
| strategy    | Strategy & Planning        |
| knowledge   | Strategy & Planning        |
| project     | Project Management         |
| maintenance | Maintenance & Setup        |
| utility     | Maintenance & Setup        |
| github      | GitHub Commands            |
| claude-code | Claude Code Commands       |

Also include this utility command (no frontmatter — hardcode this only):

| Command               | Description                             | Category            |
| --------------------- | --------------------------------------- | ------------------- |
| `/cc:update-claudemd` | Update CLAUDE.md with session learnings | Strategy & Planning |

---

## If arguments contain "--full"

For each command, render a detailed section:

```
### /<name>

<description>

Usage: `/<name> <argument-hint>`
```

After all commands, render the Archived/Removed section.

## Else (no --full flag)

For each category, render a table:

```
## <Category Title>

| Command | Purpose |
| ------- | ------- |
| `/<name>` | <description> |
```

After all tables, render the Skills section.

---

## Skills section (always render, after commands)

```
## Skills (<count> total)

Invoked naturally — Claude Code or Codex picks the right skill from context.

**Full reference**: `/bs:help --full`
**Workflow guide**: `/bs:workflow`
```

---

## Archived/Removed Commands (include in --full only)

### Quality Commands (Replaced by /bs:quality)

`/bs:quality` uses one exact-manifest deterministic runner for gates, bounded
review, resume, optional protected merge, and terminal telemetry.
The `engineering` claim requires protected-base policy and proves only the
normal engineering controls. It never marks product acceptance complete.
Product delivery claims also require protected-producer receipts bound to the
numeric repository ID, exact HEAD, requirements, and artifact. Caller-authored
digests and candidate-worker verification are not admission evidence.
Product merges stop at the typed `product-admission` capability unless a fresh
protected verifier supplies admission evidence; local preflight cannot merge.
An exact envelope that exceeds the primary provider's input limit goes once to
the configured fallback; it is not truncated or replayed to the same provider.
If review-check publication is unavailable, quality waits for exact-head CI
before it signs local review evidence instead of failing while CI is pending.
Oversized Claude fallback prompts are streamed through standard input, so host
argument-list limits cannot turn the fallback into an inconclusive review.

| Old Command           | Replacement                      |
| --------------------- | -------------------------------- |
| `/bs:ready`           | `/bs:quality` (default is 95%)   |
| `/bs:ready --merge`   | `/bs:quality --merge`            |
| `/bs:perfect`         | `/bs:quality --level 98`         |
| `/bs:perfect --merge` | `/bs:quality --level 98 --merge` |
| `/bs:pilot`           | Removed                          |

### Release Prep (now a Skill)

| Old Command | Replacement                                               |
| ----------- | --------------------------------------------------------- |
| `/bs:scrub` | `/bs:scrub` still works — now backed by the `scrub` skill |
