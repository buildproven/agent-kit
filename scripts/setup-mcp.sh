#!/bin/bash
# =============================================================================
# Setup MCP Servers - High-Priority Claude Code Extensions
# =============================================================================
# Part of agent-kit - portable Claude Code configuration
#
# Usage:
#   ./scripts/setup-mcp.sh           # Install all recommended MCPs
#   ./scripts/setup-mcp.sh --list    # Show current MCP status
#   ./scripts/setup-mcp.sh --remove  # Remove all MCPs
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# =============================================================================
# HIGH-PRIORITY MCP SERVERS
# =============================================================================
# These are the essential MCPs for a state-of-the-art development setup
#
# Priority Tiers:
#   🔴 CRITICAL - Must have for professional development
#   🟡 RECOMMENDED - Significant productivity boost
#   🟢 OPTIONAL - Nice to have for specific workflows

declare -A MCP_SERVERS=(
    # 🔴 CRITICAL
    ["sequential-thinking"]="npx|-y|@modelcontextprotocol/server-sequential-thinking|Better problem-solving with structured thinking"
    ["playwright"]="npx|-y|@anthropic/mcp-playwright|Web automation, testing, screenshots"
    ["memory"]="npx|-y|@anthropic/mcp-memory|Persistent memory across sessions"

    # 🟡 RECOMMENDED
    ["filesystem"]="npx|-y|@anthropic/mcp-filesystem|Enhanced file operations and watching"
    ["fetch"]="npx|-y|@anthropic/mcp-fetch|Advanced web fetching with caching"

    # 🟢 OPTIONAL (uncomment if needed)
    # ["postgres"]="npx|-y|@anthropic/mcp-postgres|Direct PostgreSQL queries"
    # ["sqlite"]="npx|-y|@anthropic/mcp-sqlite|SQLite database access"
    # ["brave-search"]="npx|-y|@anthropic/mcp-brave-search|Enhanced web search"
)

# =============================================================================
# FUNCTIONS
# =============================================================================

check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v claude &> /dev/null; then
        log_error "Claude Code CLI not found. Install it first."
        exit 1
    fi

    if ! command -v npx &> /dev/null; then
        log_error "npx not found. Install Node.js first."
        exit 1
    fi

    log_success "Prerequisites OK"
}

list_mcps() {
    echo ""
    echo "============================================================"
    echo "🔌 CURRENT MCP SERVER STATUS"
    echo "============================================================"
    echo ""
    claude mcp list 2>/dev/null || echo "No MCP servers configured"
    echo ""
}

install_mcp() {
    local name="$1"
    local config="${MCP_SERVERS[$name]}"

    # Parse config (format: command|arg1|arg2|description)
    IFS='|' read -ra parts <<< "$config"
    local cmd="${parts[0]}"
    local arg1="${parts[1]}"
    local package="${parts[2]}"
    local description="${parts[3]}"

    log_info "Installing $name: $description"

    # Check if already installed
    if claude mcp list 2>/dev/null | grep -q "^$name"; then
        log_warning "$name already installed, skipping"
        return 0
    fi

    # Install MCP server (user scope for cross-project availability)
    if claude mcp add --scope user --transport stdio "$name" -- "$cmd" "$arg1" "$package" 2>/dev/null; then
        log_success "Installed: $name"
    else
        log_error "Failed to install: $name"
    fi
}

install_all_mcps() {
    echo ""
    echo "============================================================"
    echo "🔌 INSTALLING HIGH-PRIORITY MCP SERVERS"
    echo "============================================================"
    echo ""

    check_prerequisites

    for name in "${!MCP_SERVERS[@]}"; do
        install_mcp "$name"
    done

    echo ""
    log_success "MCP installation complete!"
    list_mcps
}

remove_all_mcps() {
    echo ""
    echo "============================================================"
    echo "🗑️  REMOVING ALL MCP SERVERS"
    echo "============================================================"
    echo ""

    for name in "${!MCP_SERVERS[@]}"; do
        if claude mcp remove "$name" 2>/dev/null; then
            log_success "Removed: $name"
        fi
    done

    log_success "All MCPs removed"
}

show_recommendations() {
    echo ""
    echo "============================================================"
    echo "📋 RECOMMENDED MCP SERVERS"
    echo "============================================================"
    echo ""
    echo "🔴 CRITICAL (included by default):"
    echo "   • sequential-thinking - Structured problem-solving"
    echo "   • playwright - Web automation & testing"
    echo "   • memory - Persistent context across sessions"
    echo ""
    echo "🟡 RECOMMENDED (included by default):"
    echo "   • filesystem - Enhanced file operations"
    echo "   • fetch - Advanced web fetching"
    echo ""
    echo "🟢 OPTIONAL (edit script to enable):"
    echo "   • postgres - Direct database queries"
    echo "   • sqlite - SQLite database access"
    echo "   • brave-search - Enhanced web search"
    echo ""
    echo "📖 More MCPs: https://mcpcat.io/guides/best-mcp-servers-for-claude-code/"
    echo ""
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    case "${1:-}" in
        --list)
            list_mcps
            ;;
        --remove)
            remove_all_mcps
            ;;
        --help)
            show_recommendations
            ;;
        *)
            install_all_mcps
            show_recommendations
            ;;
    esac
}

main "$@"
