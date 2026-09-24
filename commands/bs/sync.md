---
name: bs:sync
standalone: true
description: "Check/repair Claude config symlinks (agent-kit → ~/.claude)"
argument-hint: "/bs:sync --mode check → verify symlinks | repair → fix broken"
category: maintenance
model: haiku
---

# /sync: Claude Setup Synchronization

**Usage**: `/bs:sync [--mode check|repair]`

Verifies and repairs the symlinks that connect this repo to `~/.claude/`.

This matters more than it looks: `config/settings.json` wires 14 hooks to
`$HOME/.claude/scripts/*.sh`. If `scripts/` is not linked, **every hook silently
no-ops** — no error, no output, just no safety rails. `--check` catches exactly that.

## Resolve the sync script

The kit may be installed via `install.sh`, as a plugin, or cloned anywhere. Resolve
rather than assume:

```bash
SYNC=""
for c in \
  "${CLAUDE_KIT_ROOT:-}/scripts/setup-claude-sync.sh" \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/setup-claude-sync.sh" \
  "$HOME/.claude/scripts/setup-claude-sync.sh" \
  "$(git rev-parse --show-toplevel 2>/dev/null)/scripts/setup-claude-sync.sh"; do
  if [ -n "$c" ] && [ -f "$c" ]; then SYNC="$c"; break; fi
done
[ -n "$SYNC" ] || { echo "bs:sync: cannot locate setup-claude-sync.sh" >&2; exit 1; }
```

## Modes

### Check (default)

```bash
"$SYNC" --check
```

Verifies, and exits non-zero if anything is wrong:

- `~/.claude/{commands,skills,agents,scripts}/` → repo directories
- `~/.claude/settings.json` → `config/settings.json`
- `~/.claude/CLAUDE.md` → `config/CLAUDE.md`
- every hook script named in `settings.json` actually resolves

### Repair

```bash
"$SYNC" --repair
```

Creates or replaces broken links, then re-verifies. Never clobbers a real file or
directory you own — if `~/.claude/<x>` exists and is not one of our symlinks, it warns
and skips rather than deleting your work.

---

## Quick Reference

```bash
/bs:sync --mode check    # health check (exit 1 if broken)
/bs:sync --mode repair   # fix broken links
```

## New Computer Setup

```bash
git clone https://github.com/buildproven/agent-kit.git ~/Projects/agent-kit
cd ~/Projects/agent-kit
./install.sh
```
