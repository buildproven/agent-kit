---
name: triage
description: Runtime agent observability — pull recent Sentry errors, cluster by signature, file Linear tickets with stack traces, optionally open worktree + PR with proposed fix. Plus synthetic user-journey cron orchestration.
context: fork
# Runs unattended (forked, no user in the loop). AskUserQuestion here would
# block forever with nobody to answer it — remove the tool, don't just ask it
# nicely not to. https://code.claude.com/docs/en/skills
disallowed-tools: AskUserQuestion
tags: [observability, sentry, triage, synthetic, monitoring]
category: operations
---

# Triage — Production Errors → Linear → Worktree → PR

Production monitoring (Sentry/Datadog) feeds into agents that triage and propose fixes. You already have dev-time observability (cost tracking, trace coverage, ci-minutes audits). This skill adds **runtime** observability — what's actually happening in users' browsers and your servers.

## Prerequisites (one-time setup)

**Check these are actually available before doing anything.** This skill needs the
Sentry MCP server (for errors) and, to file tickets, the Linear MCP server. If the
`mcp__sentry__*` tools are missing, say so and stop:

> `/bs:triage` needs the Sentry MCP server, which isn't configured in this session.
> Set it up per the instructions below, then re-run.

Do not fabricate errors or file tickets against a service you cannot reach.

### 1. Sentry MCP server

```bash
# Claude Code — Sentry's hosted MCP at mcp.sentry.dev (HTTP transport)
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# Verify
/mcp
# Should show: sentry — connected
```

Auth: Sentry MCP uses OAuth — the first tool call triggers a browser flow to grant access to your org. Scoped tokens are stored in `~/.claude/.mcp-auth/`.

If Sentry MCP isn't yet stable or you prefer self-hosted: install `@sentry/mcp-server` from npm (Sentry maintains an official package) — fall back to API-token mode:

```bash
claude mcp add --transport stdio sentry \
  --env SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN \
  --env SENTRY_ORG=$SENTRY_ORG \
  -- npx -y @sentry/mcp-server
```

### 2. Linear MCP

Verify with `/mcp` — should show `linear`.

### 3. Playwright (for synthetic journeys)

Required only for `/bs:triage synthetic` mode. Install in the target project:

```bash
npm install -D @playwright/test
npx playwright install chromium
```

## Usage

`/bs:triage` — pull errors from last 24h, cluster, report top 5 by impact
`/bs:triage --window 7d` — adjust lookback
`/bs:triage --project <slug>` — scope to one Sentry project
`/bs:triage --fix <issue-id>` — open worktree, propose fix PR for a specific Sentry issue
`/bs:triage --file-tickets` — file Linear tickets for top-N clustered errors
`/bs:triage synthetic init` — generate weekly synthetic journey for a product
`/bs:triage synthetic run` — run all synthetic journeys, post results to Linear

## Default mode: triage report

1. Pull issues from Sentry MCP: `mcp__sentry__list_issues(query: "is:unresolved age:-24h", limit: 50)`
2. Cluster by `culprit` + first frame of stack trace (errors with same root frame are one cluster)
3. For each cluster, compute:
   - `count` — events in window
   - `users_affected`
   - `first_seen` / `last_seen`
   - `is_regression` (has this fingerprint been resolved before?)
4. Score: `impact = log(count) * users_affected * (is_regression ? 3 : 1)`
5. Output table: top 5 clusters with score, link to Sentry issue, suggested action

Output format (concise, direct):

```
3 clusters worth your attention (24h window):

1. TypeError: Cannot read 'plan' of undefined  [score 142]
   src/billing/usage.ts:48 — 89 events, 31 users, regression (resolved 2 weeks ago)
   → suspect: rollout of changes in #482 reverted the null guard
   → action: /bs:triage --fix SENTRY-4821

2. ChunkLoadError /assets/main-abc123.js  [score 88]
   webpack runtime — 156 events, 22 users, new
   → suspect: stale CDN cache after deploy
   → action: investigate cache headers; not a code bug

3. PostgresError "duplicate key value"  [score 34]
   src/api/signup.ts:112 — 12 events, 12 users, new
   → suspect: race on email-uniqueness check
   → action: /bs:triage --fix SENTRY-4856
```

## --fix mode (proposed-fix worktree + PR)

For a specific Sentry issue ID:

1. Pull full issue from Sentry MCP: stack trace, breadcrumbs, user context, release version
2. Find the repo + commit that shipped the regression (via release tag in Sentry)
3. Create and lock the worktree through the shared manager:
   `node <kit-scripts>/worktree-manager.js create --repo <repo> --branch fix/sentry-<issue-id> --creator bs:triage --purpose <issue-id> --lock-reason bs:triage/<issue-id>`
4. Generate and record a one-paragraph root-cause hypothesis with a bounded
   native subagent only when the task is independent. First resolve the complete
   `native-advisory` request: resolve the installed `scripts/compute-governor.js`
   symlink under the active plugin, project `.claude`, or `~/.claude` directory.
   Read `../docs/compute-governor.md` relative to that source script's directory
   and invoke `node <installed-governor> resolve <request.json>`. Use Task or
   `spawn_agent` arguments only when the decision is ready. Claude Task uses the
   returned profile and model alias, then confirms effective effort in `/tasks`.
   Reading a stack trace can continue locally if a native capability is
   unavailable. Do not replace a blocked decision with a hard-coded model.

5. Implement the minimal fix in the worktree at the normal runtime profile.
   Escalate only when the automatic Architecture Decision Gate triggers.
6. Add regression test that reproduces the error
7. Run `/bs:quality --merge`
8. Open PR with body:

```markdown
## Fixes Sentry SENTRY-4821

**Root cause** (1 sentence)
**Repro** (commands or test)
**Fix** (1 paragraph — what changed and why)
**Regression test** (path to new test)
**Blast radius** (which users / flows affected)

Closes #<linear-ticket>
```

9. Link PR back to Sentry issue (Sentry MCP `link_pr` if available, else markdown link)

## --file-tickets mode

For top-N clustered errors that aren't already linked to a Linear ticket:

1. Search Linear for existing ticket containing Sentry issue ID
2. If absent, create with template:
   ```
   Title: [triage] <error message> — <count> events, <users> users
   Description:
     - Sentry: <url>
     - First seen: <date>
     - Suggested action: <auto-fix candidate? manual investigation?>
     - Stack trace: <code block, top 5 frames>
   Labels: bug, triage, sentry
   Priority: P0 if regression+users>50, P1 if users>10, else P2
   ```
3. Add Sentry issue ID as external link on the Linear ticket
4. Report tickets created/skipped

## Synthetic user journeys

A **weekly synthetic journey** exercises signup → core action → key conversion event for every product. This catches what unit and integration tests miss: env config drift, third-party API regressions, content/copy bugs, slow degradation.

### `/bs:triage synthetic init`

For a product:

1. Read `data/idea-lock/<slug>/one-customer.md` (if present) to know the core flow
2. Ask user: "What are the 3 actions a new user takes that prove the product works? (e.g. signup, run first analysis, view result)"
3. Generate `tests/synthetic/<slug>-journey.spec.ts` using Playwright
4. Generate `.github/workflows/synthetic-<slug>.yml`:
   - Trigger: `schedule: cron: '0 10 * * 1'` (Mondays 10am UTC)
   - Manual: `workflow_dispatch`
   - Job: install, run with **retry-on-flake** (see below), only-page-on-confirmed-fail
5. Commit to a branch and open PR for review

### `/bs:triage synthetic run`

Manual invocation (mostly for CI to call):

1. Run all `tests/synthetic/*.spec.ts` in the current repo with the **retry-on-flake protocol** (3 attempts, exponential backoff: 0s → 60s → 180s).
2. Only treat a journey as failed if **all 3 attempts fail**. A single transient failure (e.g. a Stripe API blip on a Monday morning) is suppressed; an attempt that recovers within the window is logged as `recovered_after_N_attempts` but not paged.
3. Collect results.
4. Post summary to:
   - Telegram (`mcp__telegram__send_message` or fallback to gh issue comment) — **only on confirmed fail** (3/3 attempts failed).
   - Linear (one ticket per confirmed failed journey, dedupe by week).
   - `data/synthetic-history.json` (every run, including `recovered_after_N_attempts` rows so flakiness is observable over time).
5. Exit code: 0 if all journeys pass _or recover_; 1 only on confirmed fail (3/3).

### Retry-on-flake protocol

Why three attempts with backoff:

- **One attempt** is what naive synthetic monitors do. They page on every blip, train you to ignore the page, then miss the real outage.
- **Three attempts with 0/60/180s spacing** filters out:
  - Network blips (resolved in <60s)
  - Third-party API transient errors (Stripe, Vercel deploys, DNS propagation — usually resolved in <3 min)
  - Cold-start latency on serverless backends after the synthetic hits a cold instance
- **Three failures in a row across ~3 minutes** is strong evidence of a real outage or regression, not noise.

CI implementation (in the generated `.github/workflows/synthetic-<slug>.yml`):

```yaml
- name: Run synthetic journey (retry-on-flake)
  shell: bash
  run: |
    set +e
    for ATTEMPT in 1 2 3; do
      if [ "$ATTEMPT" -gt 1 ]; then
        # 0s → 60s → 180s exponential backoff
        DELAY=$((60 * (ATTEMPT - 1) ** 2))
        echo "Attempt $ATTEMPT: waiting ${DELAY}s before retry..."
        sleep "$DELAY"
      fi
      npx playwright test tests/synthetic/ --reporter=line
      EXIT=$?
      if [ "$EXIT" -eq 0 ]; then
        echo "::notice::synthetic passed on attempt $ATTEMPT"
        echo "RECOVERED_AFTER=$ATTEMPT" >> "$GITHUB_OUTPUT"
        exit 0
      fi
      echo "::warning::synthetic attempt $ATTEMPT failed (exit=$EXIT)"
    done
    echo "::error::synthetic failed all 3 attempts — confirmed outage/regression"
    exit 1
```

Output `RECOVERED_AFTER` is consumed by a downstream step that decides whether to page (it never pages on recovery, only on confirmed fail).

## Budget gate (tier / time / tokens — NOT dollars)

Per-call dollar cost is opaque and changes per plan. Gate by tier and wall-clock budget so behavior is predictable regardless of billing:

```
About to:
  1. Pull issue context           — Sentry MCP, ~5 tool calls
  2. Generate root-cause hypothesis — 1 model call (Sonnet, ~2k tokens)
  3. Implement fix + regression test — coding loop in worktree (normal runtime profile, ≤10 min)
  4. Run /bs:quality --merge       — quality tier 'auto' + Codex judge if high-risk (≤15 min)

Budget caps:
  - max wall-clock: 30 min
  - escalation: Claude Opus or a GPT Sol-class Codex power profile at high effort,
    only for an explicit irreversible architecture decision
  - max judge tier: Codex high (if changed files match harness-config.json 'high'/'critical')
  - 7-day quota delta: ≤ 2% (read from ~/.claude/plugins/claude-hud/.usage-cache.json)

Proceed? [y/N]
```

If the current 7-day quota is already ≥80%, **refuse to proceed** unless `--force-budget` is passed — protects against runaway loops eating the weekly cap. Quota is read live from `~/.claude/plugins/claude-hud/.usage-cache.json` (per memory `feedback_health_check_autofix.md`).

`--auto` for CI runs **still applies the budget caps** — it skips the interactive prompt, not the caps. Runaway protection is non-negotiable.

## Anti-patterns this skill refuses

1. **Silent fixes**: every `--fix` PR must include a regression test. Refuse to open PR without one.
2. **Linking without context**: don't file Linear tickets without stack trace + user count.
3. **Auto-closing Sentry issues** without a deploy that actually fixed them.
4. **Synthetic journeys covering the happy path only**: ask the user to include at least one failure-path check (e.g., expired-card on checkout).
5. **Triage without timebox**: refuse to run if user has >20 open `triage`-labeled Linear tickets — clear backlog first or it's a noisy signal.

## Hook integration (optional — for advanced users)

Add to `~/.claude/settings.json` PostToolUse hook:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "bash $HOME/.claude/scripts/triage-hook.sh"
    }
  ]
}
```

**Status: not implemented.** `scripts/triage-hook.sh` does not yet exist. If you add this hook line to settings.json without the script existing, Claude Code will silently swallow the missing-file error on every tool call. **Do not add the hook entry until the script ships.**

When implemented, the script will batch agent tool calls + costs into a daily summary, feeding the observability loop. Tracked separately — file a Linear ticket if you want this before the next quality cycle.

## See also

- `/bs:quality --merge` — runs before any triage-generated PR is merged
- `/bs:sentry` — fleet-wide quality sentry (different scope; this skill is per-error)

- Sentry MCP: https://mcp.sentry.dev
