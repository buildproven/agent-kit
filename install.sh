#!/bin/bash
# =============================================================================
# agent-kit installer
# =============================================================================
# Usage:
#   curl -sL https://raw.githubusercontent.com/buildproven/agent-kit/main/install.sh | bash
#
# Or clone and run:
#   git clone https://github.com/buildproven/agent-kit.git ~/Projects/agent-kit
#   ~/Projects/agent-kit/install.sh
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${BLUE}→${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

REPO_URL="https://github.com/buildproven/agent-kit.git"
PROJECT_DIR="${AGENT_KIT_DIR:-$HOME/Projects/agent-kit}"
CLAUDE_DIR="$HOME/.claude"
CODEX_DIR="$HOME/.codex"

echo ""
echo "agent-kit installer"
echo "============================================================"
echo ""

# Clone if not already present
if [[ ! -d "$PROJECT_DIR" ]]; then
    log "Cloning agent-kit..."
    mkdir -p "$(dirname "$PROJECT_DIR")"
    git clone "$REPO_URL" "$PROJECT_DIR"
    success "Cloned to $PROJECT_DIR"
else
    log "Found existing install at $PROJECT_DIR"
    # Re-running the curl|bash installer against an existing checkout only
    # downloads the latest install.sh — it does not update PROJECT_DIR. A
    # checkout from before claude-link-manifest.sh existed (pre PR #149)
    # would otherwise abort at the `source` below under set -e. Bring the
    # checkout current so the manifest this install.sh depends on is there.
    # Never touch a dirty working tree — a re-run must not silently pull
    # upstream changes on top of a user's uncommitted local edits.
    if [[ -d "$PROJECT_DIR/.git" ]]; then
        if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then
            warn "Local changes in $PROJECT_DIR — skipping auto-pull"
        elif ! git -C "$PROJECT_DIR" pull --ff-only >/dev/null 2>&1; then
            warn "Could not fast-forward $PROJECT_DIR — continuing with checkout as-is"
        fi
    fi
fi

# Ensure ~/.claude exists
mkdir -p "$CLAUDE_DIR"
mkdir -p "$CODEX_DIR"

# Keep first-run installation and later /bs:sync repair on one declared
# surface. The manifest is deliberately shell-native so this curl|bash
# installer has no JSON-parser dependency before Node tooling is installed.
if [[ -f "$PROJECT_DIR/scripts/claude-link-manifest.sh" ]]; then
    # shellcheck source=scripts/claude-link-manifest.sh
    source "$PROJECT_DIR/scripts/claude-link-manifest.sh"
else
    # Compatible fallback for a checkout the pull above couldn't update
    # (e.g. offline, diverged history, or a non-git PROJECT_DIR) — this is
    # the pre-PR-#149 link list, kept identical to CLAUDE_LINK_DIRS/FILES.
    warn "scripts/claude-link-manifest.sh not found — using built-in fallback link list"
    CLAUDE_LINK_DIRS=(commands skills agents scripts)
    CLAUDE_LINK_FILES=(
        "settings.json:config/settings.json"
        "CLAUDE.md:config/CLAUDE.md"
    )
fi

# Symlink commands, skills, agents, scripts.
# `scripts` is load-bearing: config/settings.json wires command hooks to
# $HOME/.claude/scripts/*.sh. Omit it and every hook silently no-ops.
for dir in "${CLAUDE_LINK_DIRS[@]}"; do
    src="$PROJECT_DIR/$dir"
    dest="$CLAUDE_DIR/$dir"
    if [[ -d "$src" ]]; then
        if [[ -L "$dest" ]]; then
            rm "$dest"
        elif [[ -d "$dest" ]]; then
            warn "$dest exists and is not a symlink — skipping (merge manually)"
            continue
        fi
        ln -s "$src" "$dest"
        success "Linked ~/.claude/$dir → $src"
    fi
done

# Single-file links are intentionally non-destructive: operators often have
# their own settings or instructions, unlike the kit-owned directory links.
for link in "${CLAUDE_LINK_FILES[@]}"; do
    dest_name="${link%%:*}"
    src_rel="${link##*:}"
    src="$PROJECT_DIR/$src_rel"
    dest="$CLAUDE_DIR/$dest_name"
    if [[ -f "$src" ]]; then
        if [[ ! -f "$dest" && ! -L "$dest" ]]; then
            ln -s "$src" "$dest"
            success "Linked ~/.claude/$dest_name"
        else
            warn "~/.claude/$dest_name already exists — skipping (merge manually if needed)"
        fi
    fi
done

# Install native Codex skills. Custom prompts remain a compatibility surface,
# but Agent Skills are the supported reusable-workflow format.
bash "$PROJECT_DIR/scripts/setup-codex-skills.sh"
success "Installed curated native Codex skills"

# Codex and Claude read the exact same instruction source.
CODEX_AGENTS="$CODEX_DIR/AGENTS.md"
if [[ ! -e "$CODEX_AGENTS" && ! -L "$CODEX_AGENTS" ]]; then
    ln -s "$PROJECT_DIR/config/CLAUDE.md" "$CODEX_AGENTS"
    success "Linked ~/.codex/AGENTS.md → config/CLAUDE.md"
else
    warn "~/.codex/AGENTS.md already exists — skipping (merge manually if needed)"
fi

# Install a provider-neutral default without overwriting operator policy.
PROVIDER_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/buildproven/agent-providers.json"
if [[ ! -e "$PROVIDER_CONFIG" ]]; then
    mkdir -p "$(dirname "$PROVIDER_CONFIG")"
    cp "$PROJECT_DIR/config/provider-policy.json" "$PROVIDER_CONFIG"
    success "Installed provider policy: primary=auto fallback=none"
fi

echo ""
echo "============================================================"
success "Installation complete!"
echo ""
echo "Restart Claude Code or Codex to apply changes."
echo ""
echo "Next steps:"
echo "  • Edit ~/.claude/CLAUDE.md to match your workflow"
echo "  • Run /bs:help inside Claude Code to see all commands"
echo ""
