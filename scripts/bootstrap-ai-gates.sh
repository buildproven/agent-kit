#!/bin/bash
# =============================================================================
# Bootstrap AI Quality Gates
# =============================================================================
# Adds SOTA quality gates to any Node.js/TypeScript project:
#   1. Knip (dead code detection)
#   2. AI pattern checks (defensive coding patterns)
#   3. ESLint complexity + max-depth rules
#   4. Import verification (eslint-plugin-n)
#   5. Pre-push hook (pattern-check + dead code)
#   6. Pre-commit hook (pattern-check on staged files)
#   7. Semgrep security scan (defensive-patterns.yaml)
#   8. License compliance (permissive-only allowlist)
#
# USAGE:
#   cd ~/Projects/my-project
#   bash ~/Projects/agent-kit/scripts/bootstrap-ai-gates.sh
#
#   Or with options:
#   bash ~/Projects/agent-kit/scripts/bootstrap-ai-gates.sh --dry-run
#   bash ~/Projects/agent-kit/scripts/bootstrap-ai-gates.sh --skip-install
#
# IDEMPOTENT: Safe to run multiple times. Existing configs are preserved.
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Source directory (where agent-kit lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_SETUP_DIR="$(dirname "$SCRIPT_DIR")"

# Target directory (the project we're bootstrapping)
TARGET_DIR="$(pwd)"
PROJECT_NAME="$(basename "$TARGET_DIR")"

# Options
DRY_RUN=false
SKIP_INSTALL=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--dry-run] [--skip-install]"
      echo ""
      echo "Run from the target project directory."
      echo "  --dry-run       Show what would be done without doing it"
      echo "  --skip-install  Skip npm install (just copy configs)"
      exit 0
      ;;
  esac
done

# Tracking
CHANGES=0
SKIPPED=0

log_info()  { echo -e "${BLUE}[info]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[done]${NC} $*"; CHANGES=$((CHANGES + 1)); }
log_skip()  { echo -e "${YELLOW}[skip]${NC} $*"; SKIPPED=$((SKIPPED + 1)); }
log_warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
log_err()   { echo -e "${RED}[error]${NC} $*"; }

# ---- Preflight checks ----

if [[ ! -f "$TARGET_DIR/package.json" ]]; then
  log_err "No package.json found in $TARGET_DIR — not a Node.js project"
  exit 1
fi

if [[ "$TARGET_DIR" == "$CLAUDE_SETUP_DIR" ]]; then
  log_err "Cannot bootstrap agent-kit itself (it already has all gates)"
  exit 1
fi

echo ""
echo -e "${BOLD}Bootstrapping AI quality gates for: ${GREEN}$PROJECT_NAME${NC}"
echo -e "Target: $TARGET_DIR"
echo ""

# Detect package manager
PKG_MGR="npm"
if [[ -f "$TARGET_DIR/pnpm-lock.yaml" ]]; then
  PKG_MGR="pnpm"
elif [[ -f "$TARGET_DIR/yarn.lock" ]]; then
  PKG_MGR="yarn"
fi
log_info "Package manager: $PKG_MGR"

# ---- Gate 1: Knip (dead code detection) ----

echo ""
echo -e "${BOLD}Gate 1: Knip (dead code detection)${NC}"

# Install knip
if grep -q '"knip"' "$TARGET_DIR/package.json" 2>/dev/null; then
  log_skip "knip already in package.json"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would install knip"
  elif [[ "$SKIP_INSTALL" == "true" ]]; then
    log_warn "Skipping knip install (--skip-install)"
  else
    log_info "Installing knip..."
    case $PKG_MGR in
      pnpm) pnpm add -D knip ;;
      yarn) yarn add -D knip ;;
      *)    npm install -D knip ;;
    esac
    log_ok "knip installed"
  fi
fi

# Create knip.config.js if missing
if [[ -f "$TARGET_DIR/knip.config.js" ]] || [[ -f "$TARGET_DIR/knip.json" ]] || [[ -f "$TARGET_DIR/knip.ts" ]]; then
  log_skip "knip config already exists"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would create knip.config.js"
  else
    # Detect entry points for this project
    ENTRIES=()
    [[ -d "$TARGET_DIR/src" ]] && ENTRIES+=("'src/index.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/app" ]] && ENTRIES+=("'app/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/pages" ]] && ENTRIES+=("'pages/**/*.{ts,tsx,js,jsx}'")
    [[ -f "$TARGET_DIR/index.ts" ]] && ENTRIES+=("'index.{ts,tsx,js,jsx}'")
    [[ -f "$TARGET_DIR/index.js" ]] && ENTRIES+=("'index.{ts,tsx,js,jsx}'")

    # Detect project dirs
    PROJECTS=()
    [[ -d "$TARGET_DIR/src" ]] && PROJECTS+=("'src/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/app" ]] && PROJECTS+=("'app/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/lib" ]] && PROJECTS+=("'lib/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/pages" ]] && PROJECTS+=("'pages/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/components" ]] && PROJECTS+=("'components/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/utils" ]] && PROJECTS+=("'utils/**/*.{ts,tsx,js,jsx}'")
    [[ -d "$TARGET_DIR/scripts" ]] && PROJECTS+=("'scripts/**/*.{js,mjs,cjs}'")

    # Build ignore list
    IGNORES="'**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'"

    # Next.js projects get next plugin
    IS_NEXT=false
    if grep -q '"next"' "$TARGET_DIR/package.json" 2>/dev/null; then
      IS_NEXT=true
    fi

    # Default entries if none detected
    if [[ ${#ENTRIES[@]} -eq 0 ]]; then
      ENTRIES=("'src/**/*.{ts,tsx,js,jsx}'")
    fi
    if [[ ${#PROJECTS[@]} -eq 0 ]]; then
      PROJECTS=("'**/*.{ts,tsx,js,jsx}'")
    fi

    ENTRY_STR=$(printf ", %s" "${ENTRIES[@]}")
    ENTRY_STR="${ENTRY_STR:2}"
    PROJECT_STR=$(printf ", %s" "${PROJECTS[@]}")
    PROJECT_STR="${PROJECT_STR:2}"

    cat > "$TARGET_DIR/knip.config.js" << KNIPEOF
// knip.config.js — Dead code detection
// Docs: https://knip.dev/overview/configuration
module.exports = {
  entry: [${ENTRY_STR}],
  project: [${PROJECT_STR}],
  ignore: [${IGNORES}],
  ignoreDependencies: [],
  ignoreBinaries: [],
}
KNIPEOF

    log_ok "Created knip.config.js (review entry/project paths)"
  fi
fi

# Add dead-code script to package.json
if grep -q '"dead-code"' "$TARGET_DIR/package.json" 2>/dev/null; then
  log_skip "dead-code script already in package.json"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would add dead-code script"
  else
    # Use node to safely add to package.json scripts
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      if (!pkg.scripts) pkg.scripts = {};
      pkg.scripts['dead-code'] = 'knip --no-exit-code || echo \"Dead code found (non-blocking)\"';
      pkg.scripts['dead-code:strict'] = 'knip';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "Added dead-code scripts to package.json"
  fi
fi

# ---- Gate 2: AI pattern checks ----

echo ""
echo -e "${BOLD}Gate 2: AI pattern checks (defensive coding)${NC}"

# Copy pattern-check.sh
if [[ -f "$TARGET_DIR/scripts/pattern-check.sh" ]]; then
  log_skip "scripts/pattern-check.sh already exists"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would copy pattern-check.sh"
  else
    mkdir -p "$TARGET_DIR/scripts"
    cp "$CLAUDE_SETUP_DIR/scripts/pattern-check.sh" "$TARGET_DIR/scripts/pattern-check.sh"
    chmod +x "$TARGET_DIR/scripts/pattern-check.sh"
    log_ok "Copied pattern-check.sh"
  fi
fi

# Create .defensive-patterns.json with sensible defaults
if [[ -f "$TARGET_DIR/.defensive-patterns.json" ]]; then
  log_skip ".defensive-patterns.json already exists"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would create .defensive-patterns.json"
  else
    cat > "$TARGET_DIR/.defensive-patterns.json" << 'PATEOF'
{
  "description": "Defensive pattern configuration",
  "authMiddleware": ["withAuth", "requireAuth", "authenticate", "getSession", "getServerSession", "clerkMiddleware", "auth"],
  "safeParseHelpers": ["safeJsonParse", "safeParse", ".safeParse"],
  "publicRoutes": [],
  "excludePaths": ["**/test/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"],
  "disabled": []
}
PATEOF
    log_ok "Created .defensive-patterns.json"
  fi
fi

# Add pattern-check script to package.json
if grep -q '"pattern-check"' "$TARGET_DIR/package.json" 2>/dev/null; then
  log_skip "pattern-check script already in package.json"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would add pattern-check script"
  else
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      if (!pkg.scripts) pkg.scripts = {};
      pkg.scripts['pattern-check'] = 'bash scripts/pattern-check.sh';
      pkg.scripts['test:patterns'] = 'bash scripts/pattern-check.sh --all';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "Added pattern-check scripts to package.json"
  fi
fi

# ---- Gate 3: ESLint complexity + max-depth rules ----

echo ""
echo -e "${BOLD}Gate 3: ESLint complexity + max-depth rules${NC}"

# Find the eslint config file
ESLINT_CONFIG=""
for candidate in eslint.config.cjs eslint.config.mjs eslint.config.js; do
  if [[ -f "$TARGET_DIR/$candidate" ]]; then
    ESLINT_CONFIG="$candidate"
    break
  fi
done

if [[ -z "$ESLINT_CONFIG" ]]; then
  log_warn "No flat ESLint config found — skipping complexity rules"
  log_info "Create an eslint.config.cjs first, then re-run this script"
else
  # Check if complexity rules already exist
  if grep -q "complexity" "$TARGET_DIR/$ESLINT_CONFIG" 2>/dev/null; then
    log_skip "Complexity rules already in $ESLINT_CONFIG"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would add complexity rules to $ESLINT_CONFIG"
    else
      # Inject complexity rules into baseRules object
      # Strategy: find the baseRules object and add our rules
      if grep -q "baseRules" "$TARGET_DIR/$ESLINT_CONFIG" 2>/dev/null; then
        # Has baseRules — inject after the opening brace
        node -e "
          const fs = require('fs');
          let content = fs.readFileSync('$ESLINT_CONFIG', 'utf8');

          // Find 'const baseRules = {' and inject after it
          const marker = /const baseRules\s*=\s*\{/;
          if (marker.test(content)) {
            content = content.replace(marker, (match) =>
              match + '\n  // Complexity gates (AI quality)\n  complexity: [\"warn\", 15],\n  \"max-depth\": [\"warn\", 4],\n  \"max-params\": [\"warn\", 5],\n'
            );
            fs.writeFileSync('$ESLINT_CONFIG', content);
            console.log('Injected into baseRules');
          } else {
            console.log('baseRules not found — manual edit needed');
            process.exit(1);
          }
        "
        log_ok "Added complexity/max-depth/max-params rules to $ESLINT_CONFIG"
      else
        # No baseRules — inject a new config block before module.exports
        node -e "
          const fs = require('fs');
          let content = fs.readFileSync('$ESLINT_CONFIG', 'utf8');

          const complexityBlock = \`
// Complexity gates (AI quality)
configs.push({
  files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
  rules: {
    complexity: ['warn', 15],
    'max-depth': ['warn', 4],
    'max-params': ['warn', 5],
  },
})

\`;

          // Insert before module.exports
          content = content.replace(/(module\.exports|export default)/, complexityBlock + '\$1');
          fs.writeFileSync('$ESLINT_CONFIG', content);
        "
        log_ok "Added complexity config block to $ESLINT_CONFIG"
      fi
    fi
  fi
fi

# ---- Gate 4: Import verification (eslint-plugin-n) ----

echo ""
echo -e "${BOLD}Gate 4: Import verification (eslint-plugin-n)${NC}"

# Only add for non-Next.js projects (Next.js handles imports via its own resolver)
HAS_NEXT=false
if grep -q '"next"' "$TARGET_DIR/package.json" 2>/dev/null; then
  HAS_NEXT=true
fi

if [[ "$HAS_NEXT" == "true" ]]; then
  log_skip "Next.js project — import verification handled by Next.js build"
else
  if grep -q '"eslint-plugin-n"' "$TARGET_DIR/package.json" 2>/dev/null; then
    log_skip "eslint-plugin-n already in package.json"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would install eslint-plugin-n"
    elif [[ "$SKIP_INSTALL" == "true" ]]; then
      log_warn "Skipping eslint-plugin-n install (--skip-install)"
    else
      log_info "Installing eslint-plugin-n..."
      case $PKG_MGR in
        pnpm) pnpm add -D eslint-plugin-n ;;
        yarn) yarn add -D eslint-plugin-n ;;
        *)    npm install -D eslint-plugin-n ;;
      esac
      log_ok "eslint-plugin-n installed"
    fi
  fi

  # Add to ESLint config if we have one
  if [[ -n "$ESLINT_CONFIG" ]]; then
    if grep -q "eslint-plugin-n" "$TARGET_DIR/$ESLINT_CONFIG" 2>/dev/null; then
      log_skip "eslint-plugin-n already configured in $ESLINT_CONFIG"
    else
      if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[dry-run] Would add eslint-plugin-n to $ESLINT_CONFIG"
      else
        node -e "
          const fs = require('fs');
          let content = fs.readFileSync('$ESLINT_CONFIG', 'utf8');

          const nBlock = \`
// Import verification (eslint-plugin-n)
let nPlugin = null
try {
  nPlugin = require('eslint-plugin-n')
} catch {
  // eslint-plugin-n not installed
}

if (nPlugin) {
  configs.push({
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { n: nPlugin },
    rules: {
      'n/no-missing-require': 'error',
      'n/no-missing-import': 'off', // Often handled by bundlers
      'n/no-unpublished-require': 'off',
    },
  })
}

\`;

          // Insert before module.exports
          content = content.replace(/(module\.exports|export default)/, nBlock + '\$1');
          fs.writeFileSync('$ESLINT_CONFIG', content);
        "
        log_ok "Added eslint-plugin-n config to $ESLINT_CONFIG"
      fi
    fi
  fi
fi

# ---- Gate 5: Wire into pre-push hook ----

echo ""
echo -e "${BOLD}Gate 5: Pre-push hook integration${NC}"

PRE_PUSH="$TARGET_DIR/.husky/pre-push"

if [[ ! -f "$PRE_PUSH" ]]; then
  log_warn "No .husky/pre-push found — skipping hook integration"
  log_info "Run 'npx husky init' first, then re-run this script"
else
  # Add pattern-check to pre-push if missing
  if grep -q "pattern-check" "$PRE_PUSH" 2>/dev/null; then
    log_skip "pattern-check already in pre-push hook"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would add pattern-check to pre-push"
    else
      cat >> "$PRE_PUSH" << 'HOOKEOF'

# AI pattern checks (defensive coding)
if [ -f "scripts/pattern-check.sh" ]; then
  echo "  Running AI pattern checks..."
  bash scripts/pattern-check.sh --all || {
    echo "Pattern check failed!"
    exit 1
  }
fi
HOOKEOF
      log_ok "Added pattern-check to pre-push hook"
    fi
  fi

  # Add dead-code check to pre-push if missing
  if grep -q "knip" "$PRE_PUSH" 2>/dev/null; then
    log_skip "dead-code check already in pre-push hook"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would add dead-code check to pre-push"
    else
      cat >> "$PRE_PUSH" << 'HOOKEOF'

# Dead code detection (knip) — non-blocking warning
if command -v npx &> /dev/null && grep -q '"knip"' package.json 2>/dev/null; then
  echo "  Checking for dead code..."
  npx knip --no-exit-code 2>/dev/null || true
fi
HOOKEOF
      log_ok "Added dead-code check to pre-push hook (non-blocking)"
    fi
  fi
fi

# ---- Gate 6: Wire pattern-check into pre-commit hook ----

echo ""
echo -e "${BOLD}Gate 6: Pre-commit hook integration${NC}"

PRE_COMMIT="$TARGET_DIR/.husky/pre-commit"

if [[ ! -f "$PRE_COMMIT" ]]; then
  log_skip "No .husky/pre-commit found"
else
  if grep -q "pattern-check" "$PRE_COMMIT" 2>/dev/null; then
    log_skip "pattern-check already in pre-commit hook"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would add pattern-check to pre-commit"
    else
      cat >> "$PRE_COMMIT" << 'HOOKEOF'

# Defensive pattern analysis on staged files
if [ -f "./scripts/pattern-check.sh" ]; then
  echo "Running defensive pattern analysis..."
  ./scripts/pattern-check.sh
fi
HOOKEOF
      log_ok "Added pattern-check to pre-commit hook"
    fi
  fi
fi

# ---- Gate 7: Semgrep security scan ----

echo ""
echo -e "${BOLD}Gate 7: Semgrep security scan${NC}"

# Copy .semgrep/defensive-patterns.yaml
if [[ -f "$TARGET_DIR/.semgrep/defensive-patterns.yaml" ]]; then
  log_skip ".semgrep/defensive-patterns.yaml already exists"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would copy .semgrep/defensive-patterns.yaml"
  else
    mkdir -p "$TARGET_DIR/.semgrep"
    cp "$CLAUDE_SETUP_DIR/.semgrep/defensive-patterns.yaml" "$TARGET_DIR/.semgrep/defensive-patterns.yaml"
    log_ok "Copied .semgrep/defensive-patterns.yaml"
  fi
fi

# Copy scripts/run-semgrep.sh
if [[ -f "$TARGET_DIR/scripts/run-semgrep.sh" ]]; then
  log_skip "scripts/run-semgrep.sh already exists"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would copy run-semgrep.sh"
  else
    mkdir -p "$TARGET_DIR/scripts"
    cp "$CLAUDE_SETUP_DIR/scripts/run-semgrep.sh" "$TARGET_DIR/scripts/run-semgrep.sh"
    chmod +x "$TARGET_DIR/scripts/run-semgrep.sh"
    log_ok "Copied run-semgrep.sh"
  fi
fi

# Add security:scan scripts to package.json
if grep -q '"security:scan"' "$TARGET_DIR/package.json" 2>/dev/null; then
  log_skip "security:scan script already in package.json"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would add security:scan scripts"
  else
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      if (!pkg.scripts) pkg.scripts = {};
      pkg.scripts['security:scan'] = 'bash scripts/run-semgrep.sh';
      pkg.scripts['security:scan:ci'] = 'bash scripts/run-semgrep.sh --ci';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "Added security:scan scripts to package.json"
  fi
fi

# Wire Semgrep into pre-push hook (non-blocking)
if [[ -f "$PRE_PUSH" ]]; then
  if grep -q "run-semgrep" "$PRE_PUSH" 2>/dev/null; then
    log_skip "Semgrep already in pre-push hook"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would add Semgrep to pre-push hook"
    else
      cat >> "$PRE_PUSH" << 'HOOKEOF'

# Security scan (semgrep if installed, pattern-check fallback) — non-blocking unless SEMGREP_STRICT=1
if [ -f "scripts/run-semgrep.sh" ]; then
  echo "  Running security scan..."
  if [ "${SEMGREP_STRICT:-0}" = "1" ]; then
    bash scripts/run-semgrep.sh --ci || {
      echo "Security scan found issues!"
      exit 1
    }
  else
    bash scripts/run-semgrep.sh || true
  fi
fi
HOOKEOF
      log_ok "Added Semgrep to pre-push hook (non-blocking)"
    fi
  fi
else
  log_warn "No .husky/pre-push found — skipping Semgrep hook integration"
fi

# ---- Gate 8: License compliance ----

echo ""
echo -e "${BOLD}Gate 8: License compliance${NC}"

# Install license-checker-rseidelsohn (maintained fork; the original
# license-checker's dependency chain has an unfixable transitive brace-expansion
# advisory — see BUI-473)
if grep -q '"license-checker-rseidelsohn"' "$TARGET_DIR/package.json" 2>/dev/null; then
  log_skip "license-checker-rseidelsohn already in package.json"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would install license-checker-rseidelsohn"
  elif [[ "$SKIP_INSTALL" == "true" ]]; then
    log_warn "Skipping license-checker-rseidelsohn install (--skip-install)"
  else
    log_info "Installing license-checker-rseidelsohn..."
    case $PKG_MGR in
      pnpm) pnpm add -D license-checker-rseidelsohn ;;
      yarn) yarn add -D license-checker-rseidelsohn ;;
      *)    npm install -D license-checker-rseidelsohn ;;
    esac
    log_ok "license-checker-rseidelsohn installed"
  fi
fi

# Add license:check script to package.json
if grep -q '"license:check"' "$TARGET_DIR/package.json" 2>/dev/null; then
  log_skip "license:check script already in package.json"
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would add license:check script"
  else
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      if (!pkg.scripts) pkg.scripts = {};
      pkg.scripts['license:check'] = 'license-checker-rseidelsohn --onlyAllow \"MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;0BSD;BlueOak-1.0.0;CC0-1.0;CC-BY-3.0;CC-BY-4.0;Unlicense;Python-2.0;MPL-2.0\" --excludePrivatePackages';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "Added license:check script to package.json"
  fi
fi

# ---- Summary ----

echo ""
echo "==========================================="
echo -e "${BOLD}Bootstrap complete for: ${GREEN}$PROJECT_NAME${NC}"
echo -e "  ${GREEN}$CHANGES changes applied${NC}"
echo -e "  ${YELLOW}$SKIPPED items skipped (already present)${NC}"
echo ""

if [[ $CHANGES -gt 0 ]]; then
  echo -e "${BLUE}Verification steps:${NC}"
  echo "  1. npm run dead-code        # Knip dead code scan"
  echo "  2. npm run lint              # ESLint with complexity rules"
  echo "  3. npm run pattern-check     # Defensive pattern check"
  echo "  4. npm run test:patterns     # Full pattern scan (--all)"
  echo "  5. npm run security:scan     # Semgrep security scan"
  echo "  6. npm run license:check     # License compliance check"
  echo ""
  echo -e "${YELLOW}Review & commit:${NC}"
  echo "  cd $TARGET_DIR"
  echo "  git diff"
  echo "  git add -A && git commit -m 'chore: add AI quality gates (knip, patterns, complexity, semgrep, license)'"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo -e "${YELLOW}This was a dry run. No changes were made.${NC}"
  echo "Remove --dry-run to apply changes."
fi
