#!/usr/bin/env bash
# CS-112: Setup Smoke Test Script
# Verifies that agent-kit installation is complete and functional.
# Run after install.sh or after system updates.
#
# CS-139: --ci flag for headless CI validation on Linux/Ubuntu.
# In CI mode, skips host-specific checks (symlinks, MCP, Claude CLI)
# and runs portable checks: bash -n, frontmatter, commands/skills, macOS deps.
#
# Usage:
#   scripts/test-setup.sh          # Full local check
#   scripts/test-setup.sh --ci     # CI-safe headless check

set -euo pipefail

CI_MODE=false
SETUP_REPO=""

for arg in "$@"; do
  case "$arg" in
    --ci) CI_MODE=true ;;
    *) [ -z "$SETUP_REPO" ] && SETUP_REPO="$arg" ;;
  esac
done

SETUP_REPO="${SETUP_REPO:-$(cd "$(dirname "$0")/.." && pwd -P)}"
PASS=0
FAIL=0
WARN=0

if [ "$CI_MODE" = true ]; then
  echo "Setup Smoke Test (CI mode)"
else
  echo "Setup Smoke Test"
fi
echo "================"
echo "Repo: $SETUP_REPO"
echo ""

check_pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
check_fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }
check_warn() { echo "  [WARN] $1"; WARN=$((WARN + 1)); }

# --- 1. Symlinks (skip in CI — no ~/.claude on runners) ---
if [ "$CI_MODE" = false ]; then
  echo "1. Symlinks"

  for link in commands skills; do
    target="$HOME/.claude/$link"
    expected="$SETUP_REPO/$link"
    if [ -L "$target" ]; then
      actual=$(readlink "$target")
      if [ "$actual" = "$expected" ]; then
        check_pass "$link symlink OK"
      else
        check_fail "$link symlink points to $actual (expected $expected)"
      fi
    else
      check_fail "$link symlink missing at $target"
    fi
  done

  # Config files
  for cfg in CLAUDE.md settings.json; do
    target="$HOME/.claude/$cfg"
    expected="$SETUP_REPO/config/$cfg"
    if [ -L "$target" ]; then
      actual=$(readlink "$target")
      if [ "$actual" = "$expected" ]; then
        check_pass "$cfg symlink OK"
      else
        check_fail "$cfg symlink points to $actual (expected $expected)"
      fi
    else
      check_fail "$cfg symlink missing at $target"
    fi
  done

  echo ""
fi

# --- 1b. Symlink targets exist (CI-safe — validates repo structure) ---
if [ "$CI_MODE" = true ]; then
  echo "1. Repo Structure (symlink targets)"

  for dir in commands skills; do
    if [ -d "$SETUP_REPO/$dir" ]; then
      check_pass "$dir/ directory exists"
    else
      check_fail "$dir/ directory missing"
    fi
  done

  for cfg in CLAUDE.md settings.json; do
    if [ -f "$SETUP_REPO/config/$cfg" ]; then
      check_pass "config/$cfg exists"
    else
      check_fail "config/$cfg missing"
    fi
  done

  echo ""
fi

# --- 2. Required tools ---
if [ "$CI_MODE" = false ]; then
  echo "2. Required Tools"

  for tool in node npm python3 git gh jq; do
    if command -v "$tool" &>/dev/null; then
      ver=$("$tool" --version 2>/dev/null | head -1 || echo "unknown")
      check_pass "$tool ($ver)"
    else
      check_fail "$tool not installed"
    fi
  done

  # Optional but recommended
  for tool in gitleaks pnpm; do
    if command -v "$tool" &>/dev/null; then
      check_pass "$tool installed (optional)"
    else
      check_warn "$tool not installed (recommended: brew install $tool)"
    fi
  done

  echo ""
fi

# --- 3. Git hooks ---
echo "3. Git Hooks"

if [ -d "$SETUP_REPO/.husky" ]; then
  for hook in pre-commit pre-push; do
    if [ -f "$SETUP_REPO/.husky/$hook" ]; then
      if [ -x "$SETUP_REPO/.husky/$hook" ] || [ -r "$SETUP_REPO/.husky/$hook" ]; then
        check_pass "$hook hook exists"
      else
        check_warn "$hook hook not executable"
      fi
    else
      check_warn "$hook hook not found"
    fi
  done
else
  check_warn ".husky directory not found"
fi

echo ""

# --- 4. MCP Servers (skip in CI) ---
if [ "$CI_MODE" = false ]; then
  echo "4. MCP Servers"

  CLAUDE_JSON="$HOME/.claude.json"
  if [ -f "$CLAUDE_JSON" ]; then
    SERVER_COUNT=$(python3 -c "import json; data=json.load(open('$CLAUDE_JSON')); print(len(data.get('mcpServers', {})))" 2>/dev/null || echo "0")
    if [ "$SERVER_COUNT" -gt 0 ]; then
      check_pass "$SERVER_COUNT MCP servers configured"
    else
      check_warn "No MCP servers configured in ~/.claude.json"
    fi
  else
    check_fail "~/.claude.json not found"
  fi

  echo ""
fi

# --- 5. Commands and Skills ---
echo "5. Commands & Skills"

CMD_COUNT=$(find "$SETUP_REPO/commands" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
SKILL_COUNT=$(find "$SETUP_REPO/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')

if [ "$CMD_COUNT" -gt 0 ]; then
  check_pass "$CMD_COUNT commands found"
else
  check_fail "No commands found"
fi

if [ "$SKILL_COUNT" -gt 0 ]; then
  check_pass "$SKILL_COUNT skills found"
else
  check_warn "No skills found"
fi

echo ""

# --- 6. Claude Code (skip in CI) ---
if [ "$CI_MODE" = false ]; then
  echo "6. Claude Code"

  if command -v claude &>/dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null | head -1 || echo "unknown")
    check_pass "Claude Code installed ($CLAUDE_VER)"
  else
    check_warn "Claude Code CLI not found in PATH"
  fi

  echo ""
fi

# --- 7. Shell Script Syntax (bash -n on all .sh files) ---
echo "7. Shell Script Syntax"

SYNTAX_FAIL=0
SYNTAX_PASS=0
while IFS= read -r script; do
  rel="${script#$SETUP_REPO/}"
  if bash -n "$script" 2>/dev/null; then
    SYNTAX_PASS=$((SYNTAX_PASS + 1))
  else
    echo "    syntax error: $rel"
    SYNTAX_FAIL=$((SYNTAX_FAIL + 1))
  fi
done < <(find "$SETUP_REPO/scripts" -name "*.sh" -type f 2>/dev/null)

if [ "$SYNTAX_FAIL" -gt 0 ]; then
  check_fail "bash -n: $SYNTAX_FAIL scripts have syntax errors"
else
  check_pass "bash -n: all $SYNTAX_PASS scripts parse OK"
fi

echo ""

# --- 8. Shell Script Lint ---
echo "8. Shell Script Lint"

LINT_SCRIPT="$SETUP_REPO/scripts/lint-scripts.sh"
if [ -f "$LINT_SCRIPT" ]; then
  LINT_OUTPUT=$(bash "$LINT_SCRIPT" "$SETUP_REPO" 2>&1) || true
  LINT_FAILS=$(echo "$LINT_OUTPUT" | grep -c '\[FAIL\]' || true)
  LINT_WARNS=$(echo "$LINT_OUTPUT" | grep -c '\[WARN\]' || true)
  LINT_PASSES=$(echo "$LINT_OUTPUT" | grep -c '\[PASS\]' || true)
  if [ "$LINT_FAILS" -gt 0 ]; then
    check_fail "Shell lint: $LINT_FAILS failures (run scripts/lint-scripts.sh for details)"
  elif [ "$LINT_WARNS" -gt 0 ]; then
    check_pass "Shell lint: $LINT_PASSES passed, $LINT_WARNS warnings"
  else
    check_pass "Shell lint: all checks passed"
  fi
else
  check_warn "lint-scripts.sh not found"
fi

echo ""

# --- 9. Command Frontmatter Validation ---
echo "9. Command Frontmatter"

FM_SCRIPT="$SETUP_REPO/scripts/validate-command-frontmatter.sh"
if [ -f "$FM_SCRIPT" ]; then
  FM_OUTPUT=$(bash "$FM_SCRIPT" "$SETUP_REPO/commands" 2>&1) || true
  FM_FAILS=$(echo "$FM_OUTPUT" | grep -c '\[FAIL\]' || true)
  if [ "$FM_FAILS" -gt 0 ]; then
    check_fail "Frontmatter: $FM_FAILS commands missing required fields"
  else
    check_pass "Frontmatter: all commands valid"
  fi
else
  check_warn "validate-command-frontmatter.sh not found"
fi

echo ""

# --- 10. macOS-Only Dependencies in Core Paths (CI warning) ---
echo "10. Platform Portability"

MACOS_CMDS="pbcopy|pbpaste|osascript|defaults |diskutil|hdiutil|sw_vers|dscl|launchctl"
CORE_SCRIPTS="$SETUP_REPO/scripts/lint-scripts.sh $SETUP_REPO/scripts/validate-command-frontmatter.sh $SETUP_REPO/scripts/pattern-check.sh $SETUP_REPO/scripts/setup-claude-sync.sh"
MACOS_HITS=0

for script in $CORE_SCRIPTS; do
  [ -f "$script" ] || continue
  rel="${script#$SETUP_REPO/}"
  hits=$(grep -cE "$MACOS_CMDS" "$script" 2>/dev/null || true)
  if [ "$hits" -gt 0 ]; then
    check_warn "$rel uses macOS-only commands ($hits occurrences)"
    MACOS_HITS=$((MACOS_HITS + hits))
  fi
done

if [ "$MACOS_HITS" -eq 0 ]; then
  check_pass "Core scripts have no macOS-only dependencies"
fi

# Broader scan excluding this script (non-blocking)
ALL_MACOS=$(grep -rlE "$MACOS_CMDS" "$SETUP_REPO/scripts/"*.sh 2>/dev/null | grep -vc 'test-setup.sh' || true)
if [ "$ALL_MACOS" -gt 0 ]; then
  check_warn "$ALL_MACOS total scripts reference macOS-specific commands (non-blocking)"
fi

echo ""

# --- Summary ---
echo "========================="
echo "Results: $PASS passed, $FAIL failed, $WARN warnings"
echo ""

if [ "$FAIL" -gt 0 ]; then
  if [ "$CI_MODE" = true ]; then
    echo "CI smoke test failed. See failures above."
  else
    echo "Some checks failed. Run install.sh to fix."
  fi
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "All critical checks passed. Warnings are non-blocking."
  exit 0
else
  echo "All checks passed!"
  exit 0
fi
