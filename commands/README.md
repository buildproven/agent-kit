---
name: README
description: BS Commands — public command reference for agent-kit
tags: [help, reference, overview]
category: meta
model: haiku
---

# BS Commands

Public command reference for the curated `agent-kit` surface.

Commands use prefixes: `/bs:` (workflow), `/gh:` (GitHub), `/cc:` (Claude Code), or no prefix (utilities).

## Development & Quality

| Command        | Purpose                       | When to Use                |
| -------------- | ----------------------------- | -------------------------- |
| `/bs:new`      | Create a new project scaffold | Starting a greenfield repo |
| `/bs:dev`      | Start feature development     | Beginning implementation   |
| `/bs:plan`     | Structure a larger task       | Ambiguous or multi-step    |
| `/bs:prd`      | Carson-pattern PRD + tasks    | Work spanning >1 day       |
| `/bs:test`     | Run tests with defaults       | During implementation      |
| `/bs:quality`  | Run the quality loop          | Before PR or merge         |
| `/bs:workflow` | Show the daily workflow       | Quick lookup               |

## Maintenance & Status

| Command       | Purpose                      | When to Use         |
| ------------- | ---------------------------- | ------------------- |
| `/bs:sync`    | Verify or repair setup links | Local setup health  |
| `/bs:status`  | Show project status          | Quick catch-up      |
| `/bs:help`    | Show all commands            | Reference           |
| `/bs:scrub`   | Prepare a repo for release   | OSS, giveaway, sell |
| `/bs:steward` | Audit or repair active repos | Fleet convergence   |

## Utilities

| Command               | Purpose                            |
| --------------------- | ---------------------------------- |
| `/cc:update-claudemd` | Capture learnings into `CLAUDE.md` |
| `/gh:fix-issue`       | Work a GitHub issue                |
| `/cc:create-command`  | Create a new command               |

## Notes

- This repo is the public core.
- Heavy or auto-invoked implementation lives in skills; commands stay thin.
- Product, posting, sales, and private operator workflows are intentionally excluded.
- The authoritative command set is whatever exists under `commands/`.
