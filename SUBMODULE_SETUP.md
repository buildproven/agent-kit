# Using Commands Everywhere with Submodules

This approach creates a **single source of truth** that works in Web UI, CLI, and for all teammates.

## Why Submodules?

| Approach                 | Web UI | CLI | Single Source | Updates     |
| ------------------------ | ------ | --- | ------------- | ----------- |
| Copy files               | ✅     | ✅  | ❌            | Manual copy |
| Symlink to absolute path | ❌     | ⚠️  | ✅            | Auto        |
| **Submodule + Symlink**  | ✅     | ✅  | ✅            | Auto        |

## Quick Setup

### In Any Repo

```bash
# Run the install script
bash <(curl -sL https://raw.githubusercontent.com/buildproven/agent-kit/main/scripts/install-via-submodule.sh)

# Commit and push
git commit -m "Add Claude commands via submodule"
git push
```

That's it! Commands now work everywhere.

## What Gets Created

```
your-repo/
├── .agent-kit/                ← Submodule (agent-kit repo)
│   ├── commands/
│   │   ├── bs/
│   │   ├── gh/
│   │   └── cc/
│   ├── config/
│   ├── scripts/
│   └── skills/
│
├── .claude/                    ← Symlinks to submodule
│   ├── commands → ../.agent-kit/commands
│   ├── CLAUDE.md → ../.agent-kit/config/CLAUDE.md
│   ├── scripts → ../.agent-kit/scripts
│   └── skills → ../.agent-kit/skills
│
└── .gitmodules                 ← Git submodule config
```

## How It Works

### When You Clone the Repo

```bash
git clone your-repo
cd your-repo

# Initialize submodules (brings in agent-kit)
git submodule update --init --recursive

# Symlinks now work! .claude/commands points to .agent-kit/commands
# Try: /bs:help
```

### In Claude Code Web UI

1. Open the repo
2. Web UI automatically clones submodules
3. Symlinks resolve correctly
4. Commands work! ✨

### For Teammates

Everyone gets the same setup:

```bash
git clone your-repo
git submodule update --init --recursive
# Done! Commands work
```

## Updating Commands

### Pull Latest Commands

```bash
cd .agent-kit
git pull origin main
cd ..

# Commit the submodule update
git add .agent-kit
git commit -m "Update Claude commands to latest"
git push
```

### Edit Commands Directly

```bash
cd .agent-kit

# Make changes to commands
vim commands/bs/dev.md

# Commit to agent-kit
git add commands/bs/dev.md
git commit -m "Update bs:dev command"
git push

# Back to main repo, update submodule reference
cd ..
git add .agent-kit
git commit -m "Update Claude commands"
git push
```

## Benefits

✅ **Single Source of Truth**

- All repos use the same agent-kit
- Update once, applies everywhere

✅ **Works Everywhere**

- Web UI ✓
- CLI ✓
- Mac/Windows/Linux ✓

✅ **Team Friendly**

- Everyone gets same commands
- No manual copying
- Updates via `git pull`

✅ **Version Controlled**

- Track which version of commands each repo uses
- Roll back if needed
- Clear history of changes

## Common Tasks

### Add Commands to New Repo

```bash
cd new-repo
bash <(curl -sL https://raw.githubusercontent.com/buildproven/agent-kit/main/scripts/install-via-submodule.sh)
git commit -m "Add Claude commands via submodule"
git push
```

### Update Commands in All Repos

```bash
# In each repo:
cd .agent-kit && git pull && cd ..
git add .agent-kit
git commit -m "Update commands"
git push
```

### Remove Commands from Repo

```bash
git submodule deinit .agent-kit
git rm .agent-kit
rm -rf .claude
git commit -m "Remove Claude commands"
```

### Use Different Version of Commands

```bash
cd .agent-kit
git checkout v1.0.0  # or specific commit
cd ..
git add .agent-kit
git commit -m "Pin commands to v1.0.0"
```

## Troubleshooting

### Commands Not Found

```bash
# Update submodules
git submodule update --init --recursive

# Verify symlink
ls -la .claude/commands
# Should show: commands -> ../.agent-kit/commands

# Check submodule status
git submodule status
```

### Submodule Not Cloning

```bash
# Manual init
git submodule init
git submodule update

# Or force update
git submodule update --init --recursive --force
```

### Symlink Broken

```bash
# Remove and recreate
rm .claude/commands
ln -s ../.agent-kit/commands .claude/commands
git add .claude/commands
git commit -m "Fix commands symlink"
```

## FAQ

**Q: Will this slow down git clone?**
A: Slightly (~1-2s), but submodules are small.

**Q: Can I use a specific branch?**
A: Yes! Edit `.gitmodules` to specify branch.

**Q: What if I want to modify commands per-repo?**
A: Create `.claude/commands-local/` for repo-specific commands.

**Q: Does this work with private repos?**
A: Yes, as long as you have access to agent-kit.

**Q: Can I use this with the CLI setup too?**
A: Yes! They work together. CLI uses `~/.claude/`, submodule works in repos.

## Advanced: Custom Submodule URL

Set your own repo URL:

```bash
export AGENT_KIT_REPO="https://github.com/buildproven/your-agent-kit.git"
bash <(curl -sL https://raw.githubusercontent.com/buildproven/agent-kit/main/scripts/install-via-submodule.sh)
```

Or edit the script to change the default.

## Comparison to Other Approaches

### Copy Files (Simple)

```
Pro: Simple, no dependencies
Con: Updates require manual copying
```

### Symlink to Absolute Path (Fragile)

```
Pro: Single source
Con: Breaks in Web UI, breaks for teammates
```

### Submodule + Symlink (Recommended)

```
Pro: Single source, works everywhere, team-friendly
Con: Slightly more complex git setup
```

## Summary

**Use submodules when:**

- Working in teams
- Using Web UI frequently
- Want automatic command updates
- Need consistency across repos

**Use file copying when:**

- Solo developer
- CLI-only workflow
- Don't need updates
- Want simplest setup

For most users, **submodules are the best approach** for using commands everywhere.
