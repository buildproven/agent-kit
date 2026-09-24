#!/bin/bash
# =============================================================================
# Install Claude Commands to Any Repo
# =============================================================================
# Makes your /bs:* and /gh:* commands available in any project
#
# Usage:
#   # From within any repo:
#   curl -sL https://raw.githubusercontent.com/buildproven/agent-kit/main/scripts/install-commands-to-repo.sh | bash
#
#   # Or if agent-kit is cloned locally:
#   /path/to/agent-kit/scripts/install-commands-to-repo.sh
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${BLUE}→${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

echo ""
echo "🔧 Installing Claude Code Commands"
echo "============================================================"
echo ""

# Detect if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Not in a git repository. Please run this from within a repo."
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
COMMANDS_DIR="$REPO_ROOT/.claude/commands"

log "Installing commands to: $COMMANDS_DIR"

# Create .claude/commands directory
mkdir -p "$COMMANDS_DIR"

# Find the source commands directory
if [[ -d "$HOME/Projects/agent-kit/commands" ]]; then
    SOURCE_DIR="$HOME/Projects/agent-kit/commands"
elif [[ -d "$(dirname "$0")/../commands" ]]; then
    SOURCE_DIR="$(cd "$(dirname "$0")/../commands" && pwd)"
else
    echo "❌ Cannot find agent-kit commands directory"
    echo ""
    echo "Clone it first:"
    echo "  git clone YOUR-REPO ~/Projects/agent-kit"
    exit 1
fi

log "Copying from: $SOURCE_DIR"
echo ""

# Copy command directories
for dir in bs gh cc; do
    if [[ -d "$SOURCE_DIR/$dir" ]]; then
        log "Installing /$dir:* commands..."
        cp -r "$SOURCE_DIR/$dir" "$COMMANDS_DIR/"
        COUNT=$(find "$COMMANDS_DIR/$dir" -name "*.md" | wc -l | tr -d ' ')
        success "Installed $COUNT /$dir:* commands"
    fi
done

# Copy README if exists
if [[ -f "$SOURCE_DIR/README.md" ]]; then
    cp "$SOURCE_DIR/README.md" "$COMMANDS_DIR/"
fi

echo ""
echo "============================================================"
success "Installation complete!"
echo "============================================================"
echo ""
echo "📋 What's installed:"
echo "   • $(find "$COMMANDS_DIR/bs" -name "*.md" 2>/dev/null | wc -l | tr -d ' ') /bs:* commands (dev, build, ship, etc.)"
echo "   • $(find "$COMMANDS_DIR/gh" -name "*.md" 2>/dev/null | wc -l | tr -d ' ') /gh:* commands (fix-issue)"
echo "   • $(find "$COMMANDS_DIR/cc" -name "*.md" 2>/dev/null | wc -l | tr -d ' ') /cc:* commands (create-command, optimize)"
echo ""
echo "🔄 Next steps:"
echo "   1. Test commands: /bs:help"
echo "   2. Commit to git: git add .claude && git commit -m 'Add Claude commands'"
echo "   3. Push: git push"
echo ""
echo "✨ Commands will now work in this repo on any computer!"
echo ""
