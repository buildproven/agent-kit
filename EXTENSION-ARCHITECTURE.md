# Extension Architecture

agent-kit is the complete toolkit. It is designed to be extended, not forked.

## The contract

```
┌─────────────────────────────────────────┐
│  Your private overlay (optional)        │  your private config repo
│  Your CLAUDE.md, private commands,      │  submodules agent-kit
│  service integrations, secrets          │
├─────────────────────────────────────────┤
│  agent-kit (this repo, free/MIT)       │  the whole toolkit
│  Everything: quality, autonomous        │
│  workflow, strategy, domain skills      │
└─────────────────────────────────────────┘
```

agent-kit stands alone — you never need an overlay. An overlay is what you add
when you have private or personal behaviour that doesn't belong in a public repo.

The overlay adds to agent-kit. You never modify agent-kit to add personal or
project-specific behaviour, and **agent-kit never references anything above it** —
a public repo must not tell a user to run code from a path only you have.

Updates propagate automatically: a push to agent-kit can trigger a submodule bump
PR in your private overlay. No manual syncing.

---

## agent-kit (this repo, free/MIT)

Everything. Core dev commands (`/bs:dev`, `/bs:quality`, `/bs:test`), autonomous
workflow (`/bs:ralph`), strategy (`/bs:strategy`), fleet management (`/bs:sota`,
`/bs:sentry`, `/bs:steward`), domain skills (`legal`,
`monetize`, `seo`), 14 agents, hooks and CI gates.

**Install and use as-is.** Contribute back if you build something useful to
everyone.

---

## Your private overlay (optional)

A private config repo that sits on top of agent-kit. Contains:

- Your `CLAUDE.md` (preferences, team conventions, known mistakes)
- Private commands that don't belong in a public repo
- Service integrations (social posting, internal tools, etc.)
- Secrets and environment config

**Structure:**

```
your-private-config/
├── config/
│   └── CLAUDE.md          # Your preferences
├── commands/
│   └── bs/
│       └── my-command.md  # Private commands
└── install.sh             # Init submodules, then overlay private files
```

---

## Per-Project Commands

Claude Code automatically picks up `.claude/` in the current working directory alongside `~/.claude/`. Project-level commands take precedence over global ones with the same name.

```
your-project/
└── .claude/
    ├── CLAUDE.md          # Project-specific conventions
    └── commands/
        └── deploy.md      # Project-specific command
```

---

## Decision Guide

| You want to...                   | Do this                          |
| -------------------------------- | -------------------------------- |
| Use the toolkit                  | Install agent-kit                |
| Get autonomous workflow commands | Already in agent-kit             |
| Add personal preferences         | Private overlay (`CLAUDE.md`)    |
| Add a private workflow command   | Private overlay (`commands/`)    |
| Add a project-specific command   | `.claude/commands/` in that repo |
| Improve something for everyone   | PR to agent-kit                  |
