# claude-kit

**A Claude Code + Codex toolkit whose quality gate reads your diff, scores its risk, and
scales its own review depth to match.**

A doc typo gets a light pass. A change to `.github/workflows/` pins a security floor
and escalates review to maximum effort — however innocuous the diff looks. One logic
file taints a mixed changeset.

That is not a prompt saying "please be thorough". It is
[`risk-score.js`](scripts/risk-score.js) (537 lines), a
[run governor](scripts/quality-run-governor.js) that caps runaway review loops and
fails _closed_, and a target resolver — **thousands of behavioral tests with
over 85% line and 75% branch coverage**.

Plus autonomous backlog execution, multi-LLM strategy panels, active-repo fleet
auditing, native Codex skills, and 14 specialist agents.

**Everything is here.** One repo, no paid tier, nothing held back. The kit is MIT;
one substantially modified skill retains its upstream Apache-2.0 license.

## What's inside

| Dir         | Contents                                                           |
| ----------- | ------------------------------------------------------------------ |
| `commands/` | 25 curated `/bs:*`, `/gh:*`, and `/cc:*` entry points              |
| `skills/`   | 33 skills — quality, autonomous workflow, strategy, design, domain |
| `agents/`   | 17 specialist agents                                               |
| `scripts/`  | Hooks, lint, quality governor, provider-neutral review companions  |
| `config/`   | Instructions, provider policy, Codex skills, fleet and MCP schemas |

## What this is (and isn't)

Between January and July 2026 Anthropic shipped, natively and for free, a large
chunk of the orchestration layer toolkits like this used to hand-roll: background
subagents that auto-commit, push and open a draft PR (2.1.198); agent teams; the
Workflow tool; worktree isolation; automatic memory; `/loop` + cron + Routines;
`/code-review ultra`; and `/usage`.

So this kit doesn't reimplement any of it — the redundant parts were deleted (see
[the table below](#removed--claude-code-now-does-these-natively)). What remains is
the part the platform doesn't ship: opinionated workflow, and domain judgment
(`legal`, `seo`, `review-content`, and the
strategy panels).

## Prerequisites

|                                   | Needed for                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **git**                           | everything                                                                                                                                                  |
| **Node 24+**                      | quality-gate scripts (`package.json` engines)                                                                                                               |
| **python3**                       | `csc_lint.py` (the command/skill linter)                                                                                                                    |
| **jq** _(recommended)_            | the hooks; they degrade to `grep` without it, less reliably                                                                                                 |
| **gh** _(optional)_               | PR-aware features in `/bs:quality`, `/bs:status`                                                                                                            |
| **acpx** _(optional)_             | Ensemble workflows — every provider is invoked through it                                                                                                   |
| Native provider CLIs _(optional)_ | Required only for providers you request explicitly. Gemini currently needs `@google/gemini-cli` plus API-key auth; `acpx` does not yet support Antigravity. |

Some skills also need an MCP server and will tell you so rather than failing
quietly: `/bs:backlog` and `/bs:dev --next` need **Linear**; `/bs:triage` needs
**Sentry**.

### Choose the primary agent

Model-using workflows can run from either Codex or Claude Code. One shared policy
selects the primary and a quota/authentication/timeout fallback:

```bash
bash ~/.claude/scripts/provider-config.sh --primary codex --fallback claude
```

Reverse the two values for Claude-primary, or use `--fallback none`. HTTP 429 and
weekly-limit responses are surfaced immediately instead of being misreported as
timeouts. Quality re-review rounds inspect only commits added since the previous
successful review.

The interactive builder model stays under your control. Quality launches a
separate bounded Codex reviewer at Luna for low risk, Terra for medium/high,
and Sol for critical; starting on a stronger model does not silently downshift
the active session. Claude agents inherit the selected Claude session model.
The provider-neutral [assurance contract](docs/quality-assurance-contract.md)
documents exact-revision evidence, conservative test impact, and cache reuse.

**macOS-only:** the desktop-notification hooks use `osascript`. On Linux/WSL they
are skipped — everything else works.

## Quick start

Install as a Claude Code plugin:

```
/plugin marketplace add buildproven/claude-kit
/plugin install bs@buildproven
```

That's it. No symlinks, no `curl | bash`, no clobbering your `~/.claude`.

### Everything is namespaced `/bs:*`

Because the plugin is named `bs`, every skill it ships is addressed with a `bs:`
prefix — `/bs:quality`, `/bs:ralph`, `/bs:strategy`. This is real namespacing
enforced by Claude Code, not a naming convention:

- **Nothing collides with a built-in.** Before this, the kit shipped bare skills
  called `cost`, `review`, `status`, `resume`, `context` and `tasks` — all of
  which _shadowed_ Anthropic's own `/cost`, `/review`, `/status`, `/resume`,
  `/context` and `/tasks`. Personal skills beat bundled ones, so typing `/cost`
  silently ran the kit's version instead of Claude Code's.
- **You can always tell what's yours.** If it has a `bs:` prefix, it came from
  this kit.

<details>
<summary>Legacy install (symlinks) — still works, not recommended</summary>

```bash
git clone https://github.com/buildproven/claude-kit.git ~/Projects/claude-kit
cd ~/Projects/claude-kit
./install.sh
```

This symlinks `commands/`, `skills/`, `agents/` and `scripts/` into `~/.claude/`,
installs the curated native Codex skills under `~/.agents/skills`, and points
`~/.codex/AGENTS.md` at the same instruction source.
`scripts/` is load-bearing — `config/settings.json` wires 18 command hooks to
`$HOME/.claude/scripts/*.sh`, so without it every hook silently no-ops. It works,
but skills land unprefixed, so they can shadow Claude Code built-ins. Prefer the
plugin.

Fresh headless provider runs can use the [Compute Governor](docs/compute-governor.md)
to resolve and persist a phase-aware model, effort, access, and exact-HEAD plan
without changing the interactive builder session. V2 keeps ordinary work on the
reliable standard route, raises protected work to critical, and fails closed for
capabilities whose sandbox or telemetry is not yet proven.

Quality campaigns use the [deterministic quality runner](scripts/quality-run.js)
after bootstrap. One exact manifest drives gates, bounded review, resume,
optional protected merge, and terminal telemetry without model-sequenced phase
calls.

</details>

## Core commands

```text
/bs:dev         Start a feature with complexity-appropriate planning
/bs:quality     Provider-neutral quality loop (tier-aware, quota fallback, break-glass)
/bs:test        Run tests with auto-detected framework
/bs:plan        Structured spec before complex work
/bs:new         Bootstrap a new project
/bs:help        Full command reference
/bs:workflow    Daily workflow guide
/bs:status      Project catch-up summary
/bs:deps        Dependency health (outdated, audit, upgrade)
/bs:sync        Verify and repair config symlinks
/bs:scrub       Prep a project for public release
/gh:fix-issue   Full issue workflow: analyze → branch → fix → test → PR
/cc:create-command  Scaffold a new slash command
```

### Autonomous workflow & strategy

```text
/bs:ralph       Autonomous backlog execution — pick, implement, test, reflect, repeat
/bs:strategy    Multi-LLM strategy panel (Claude + Codex + Gemini, via API keys)
/bs:review      Collaborative artifact review (PDFs, landing pages, emails, docs)
/bs:backlog     Value-prioritized backlog
/bs:steward     Fleet-wide hygiene, currency and quality across all repos
/bs:triage      Sentry errors → cluster → Linear tickets → fix PR
```

For bounded unattended runs, `scripts/overnight-loop.sh` selects one exact issue
from a named Linear project, invokes Ralph through the shared provider runner with a hard
wall-clock deadline, and accepts completion only when the reviewed merge receipt
and Linear `Done` state agree. It requires `LINEAR_API_KEY` and an explicit
`--linear-project`; target, item, and hour caps are configurable and default to
the current directory, 8 items, and 8 hours. Run with `--dry-run` first to validate
scope without launching Ralph. Add `--provider codex --fallback claude` (or the
reverse) to override the shared policy for a run.

An unfinished item at the wall deadline or a usage reset beyond that deadline
returns nonzero and persists its terminal reason. Provider timeouts stop the
attempt without a generic retry. A successful `max-items` stop proves only that
the requested item cap was reached; it does not prove the backlog or product is
complete. Inspect `currentIssue` and `terminalReason` in the saved status.

For product work that needs explicit V-cycle traceability,
[`scripts/vcycle-creator.js`](scripts/vcycle-creator.js) provides a local,
provider-free control plane. It snapshots requirements and verification gates,
allows only a clean committed build to move the candidate revision, executes
non-mutating gates itself, and refuses completion without exact-candidate
receipts. State stays in an explicit mode-0700 evidence directory outside the
target repository. See the
[`V-cycle creator ADR`](docs/decisions/ADR-vcycle-creator.md) for its versioned
matrix and command contract.

For ongoing maintenance, copy `config/fleet.example.json` to
`${XDG_CONFIG_HOME:-~/.config}/buildproven/fleet.json`, set GitHub owners and local
roots, then run `/bs:steward audit`. `fix` mode creates isolated worktrees and
requires normal PR quality gates; it refuses dirty or locally-ahead repositories.

For MCP parity, keep a private manifest shaped like `config/mcp.example.json` and
run `python3 scripts/mcp-sync.py --manifest <path>`. Use `--force` to converge
changed definitions and `--login` for OAuth. Credential-bearing stdio servers
should use a private wrapper that loads environment variables; never place secrets
in the manifest.

### Domain intelligence

Skills, invoked in conversation: `hotfix`, `prd`, `legal`, `seo`,
`review-content`, `agent-browser`.

Agents: `business-panel-experts`, `competitive-analyst`, `critic`,
`github-issue-fixer`, `command-creator`, `seo-specialist`.

### Removed — Claude Code now does these natively

Don't reimplement what the platform ships. As of 2.1.210:

| Was                                        | Use instead                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `/bs:cost`                                 | `/usage` — per-category cost (skills, subagents, plugins, per-MCP)     |
| `/gh:review-pr`                            | `/code-review ultra` — cloud multi-agent review, `--comment`/`--fix`   |
| `/cc:optimize`                             | `/usage` + `fallbackModel` + `/effort`                                 |
| `/bs:session`, `/bs:resume`, `/bs:context` | Automatic memory + `/rewind` (resumes from before `/clear`) + `/recap` |
| `/bs:agent-new`, `/bs:agent-run`           | Edit `.claude/agents/` directly; `claude agents` to view               |
| `/bs:dashboard`                            | `claude agents` + Monitor + `agent_completed` hooks + mobile push      |

## Skills

Skills auto-invoke from natural language in Claude Code and install natively for
Codex from a curated allowlist. Internal implementation skills use
`user-invocable: false` so the user-facing surface stays small.

**Engineering** — `quality` (tier-aware provider review + quota fallback),
`diagnosing-bugs`, `codebase-design`, `test-strategy`, `error-handling`,
`api-conventions`, `recover`, `scrub`, `deps`, `status`, `workflow`

**Build quality** — `frontend-design` (Apache 2.0 + attributed MIT-derived
guidance), `ui-reviewer`

**Autonomous & strategy** — `ralph`, `strategy`, `review`, `prd`, `backlog`,
`sota`, `steward`, `triage`, `patterns`, `recover-quality`, `verify-claim`

**Domain** — `legal`, `seo`, `review-content`,
`agent-browser`

Just ask: `"Run the quality skill"` or `"Review this artifact"`.

## Agents

14 specialists. The active agent picks the right one, or name it directly.

**Engineering** — `code-reviewer`, `security-auditor`, `accessibility-tester`,
`architect-reviewer`, `performance-engineer`, `postgres-pro`, `prompt-engineer`,
`refactoring-specialist`

**Strategy & domain** — `business-panel-experts` (Christensen, Porter, Drucker,
Godin, Kim & Mauborgne, Collins, Taleb, Meadows), `competitive-analyst`,
`critic`, `seo-specialist`, `github-issue-fixer`, `command-creator`

## Extend

See [EXTENSION-ARCHITECTURE.md](EXTENSION-ARCHITECTURE.md) for how to layer
private commands and preferences on top without forking.

## Customize

1. Copy `config/CLAUDE.md` and tune it to your workflow; expose the same file as
   `AGENTS.md` so Claude Code and Codex receive identical instructions.
2. Edit `config/settings.json` for permissions, hooks, and model routing.
3. Add your own commands, skills, or agents in a private overlay repo that submodules this one.

### Optional: status line

`config/settings.json` ships without a `statusLine` so nothing breaks out of the box. For a status line showing model, git, context, cost, and usage timer, install [claude-hud](https://www.npmjs.com/package/claude-hud) — it writes its own `statusLine` config:

```bash
npx claude-hud@latest
```

### Optional: OpenTelemetry

Claude Code supports opt-in OpenTelemetry for shared dashboards and fleet-level
usage monitoring. This kit leaves telemetry disabled by default; configure it with
Anthropic's [monitoring and usage documentation](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage)
when you control the collector and data policy. For local usage, use `/usage`.

## Upstream skills

`webapp-testing` is intentionally not vendored: use Anthropic's maintained
[webapp-testing skill](https://github.com/anthropics/skills/tree/main/skills/webapp-testing)
directly. `frontend-design` remains here because it includes substantial kit-specific
guidance and original datasets; its attribution and modification notice are in
[NOTICE](NOTICE).

## License

MIT, except `skills/frontend-design/SKILL.md`, which is a substantially modified
Apache-2.0 work with additional MIT-licensed adaptations. See
[LICENSE](LICENSE), [NOTICE](NOTICE), and the license files in that skill.
