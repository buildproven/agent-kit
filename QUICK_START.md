# Quick Start: Add Commands to Any Repo

Use this guide to add the `/bs:*` commands to any repository.

> **Prefer the plugin.** For most people, `/plugin marketplace add buildproven/agent-kit`
> then `/plugin install bs@buildproven` is simpler than the submodule flow below.
> Use this guide when you want the commands vendored into a specific repo (so
> teammates and the Web UI pick them up automatically).

## Prerequisites

Git, and a repo you can push to. agent-kit is a public MIT repo, so cloning it
needs no credentials.

## Add Commands to a New Repo

**In Codespaces, local CLI, or any git environment:**

```bash
# 1. Navigate to your repo
cd /path/to/your-repo

# 2. Add agent-kit as a submodule
git submodule add https://github.com/buildproven/agent-kit.git .agent-kit

# 3. Create symlinks
mkdir -p .claude
ln -s ../.agent-kit/commands .claude/commands
ln -s ../.agent-kit/scripts .claude/scripts
ln -s ../.agent-kit/skills .claude/skills

# NOTE: Do NOT symlink CLAUDE.md - each repo should have its own

# 4. Verify it worked
ls -la .claude/commands/bs/

# 5. Commit and push
git add .gitmodules .agent-kit .claude
git commit -m "Add Claude commands via submodule"
git push
```

**That's it!** Commands now work in Web UI and CLI for this repo.

## After Setup

**Commands available:**

- `/bs:dev` - Start development work
- `/bs:quality` - Autonomous quality loop (95% or 98%)
- Natural-language `diagnosing-bugs` and `codebase-design` skills for
  evidence-first fixes and deep-module refactors
- `/bs:help` - See all commands
- And 30+ more!

**Test it:**
Open the repo in Claude Code Web UI and try `/bs:help`

## Update Commands in All Repos

When you update agent-kit:

```bash
# In any repo using the submodule
cd your-repo
cd .agent-kit
git pull origin main
cd ..
git add .agent-kit
git commit -m "Update Claude commands"
git push
```

## Troubleshooting

**Submodule not cloning?**

```bash
git submodule update --init --recursive
```

**Symlinks broken?**

```bash
ls -la .claude/
# Should show symlinks pointing to ../.agent-kit/
```

**Commands not showing in Web UI?**

- Make sure you pushed the commit to GitHub
- Close and reopen the repo in Web UI
- Check that submodule cloned: `ls .agent-kit/`

## One-Liner (Copy-Paste)

```bash
git submodule add https://github.com/buildproven/agent-kit.git .agent-kit && mkdir -p .claude && ln -s ../.agent-kit/commands .claude/commands && ln -s ../.agent-kit/scripts .claude/scripts && ln -s ../.agent-kit/skills .claude/skills && git add .gitmodules .agent-kit .claude && git commit -m "Add Claude commands via submodule" && git push
```

## What Gets Added

```
your-repo/
├── .agent-kit/          # Submodule (agent-kit)
│   ├── commands/
│   ├── config/
│   ├── scripts/
│   └── skills/
│
├── .claude/
│   ├── CLAUDE.md           # Repo-specific (DO NOT symlink)
│   ├── commands → ../.agent-kit/commands
│   ├── scripts → ../.agent-kit/scripts
│   └── skills → ../.agent-kit/skills
│
└── .gitmodules             # Git submodule config
```

## Benefits

✅ Single source of truth (update once, applies everywhere)
✅ Works in Web UI, CLI, and for teammates
✅ Easy updates via `git pull` in submodule
✅ Public HTTPS clone — no credentials needed for the submodule

---

**Need help?** Check `SUBMODULE_SETUP.md` for detailed explanation.
