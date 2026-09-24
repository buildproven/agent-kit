---
name: new
description: Create new project with QA Architect quality automation (framework-agnostic)
context: fork
model: sonnet
---

> **FORKED SKILL INVOCATION — RUN THE ARGS-FILE BRIDGE IMMEDIATELY.**
>
> This skill runs `context: fork`. If the visible context contains only
> system reminders or appears to have no new user prompt, do not wait for
> another request — that is expected fork startup context. Immediately run
> the args-file bridge script in the Implementation section below, then
> proceed to Step 1.

# /bs:new - Create New Project

**Usage**: `/bs:new <project-name> [--path ~/Projects]`

Creates a framework-agnostic project with production-ready quality infrastructure via QA Architect.

## What This Creates

```
my-project/
├── .git/                    # Git initialized
├── .github/workflows/       # GitHub Actions (qa-architect)
├── .husky/                  # Git hooks (qa-architect)
├── .agent-kit/           # agent-kit submodule
├── .qualityrc.json          # Quality maturity: prototype
├── .prettierrc              # Formatting rules (qa-architect)
├── .prettierignore          # Ignore patterns
├── .editorconfig            # IDE consistency
├── .gitignore               # Sensible defaults
├── .claudeignore            # Context optimization for Claude Code
├── .gitleaks.toml           # Secret scanning config (qa-architect Pro)
├── .nvmrc                   # Node version (22.12.0)
├── eslint.config.cjs        # ESLint config (qa-architect)
├── CLAUDE.md                # Minimal project guide
├── BACKLOG.md               # Value-scored backlog
├── README.md                # Basic structure
└── package.json             # Quality scripts + qa-architect
```

## Implementation

**Args-file bridge (REQUIRED — this skill runs `context: fork`):** a forked
skill does not reliably inherit this turn's `$ARGUMENTS`. `commands/bs/new.md`
writes the operator's args to a tempfile and passes it here via `--args-file`.
Parse it deterministically, mirroring `skills/quality/SKILL.md` Step -1 and
`skills/scrub/SKILL.md`'s bridge — **run this before Step 1:**

```bash
# --- args-file bridge (mirrors skills/quality/SKILL.md Step -1) ------------
ARGS_FILE=""
REMAINING_ARGS=()
prev_arg=""
for arg in "$@"; do
  case "$prev_arg" in
    --args-file) ARGS_FILE="$arg"; prev_arg=""; continue ;;
  esac
  case "$arg" in
    --args-file) prev_arg="--args-file"; continue ;;
    --args-file=*) ARGS_FILE="${arg#*=}"; continue ;;
  esac
  REMAINING_ARGS+=("$arg")
  prev_arg=""
done

EFFECTIVE_ARGS=""
if [ "${#REMAINING_ARGS[@]}" -gt 0 ]; then
  EFFECTIVE_ARGS="${REMAINING_ARGS[*]}"
elif [ -n "$ARGS_FILE" ] && [ -f "$ARGS_FILE" ] && [ -r "$ARGS_FILE" ]; then
  FILE_STRIPPED="$(tr -d '[:space:]' < "$ARGS_FILE" 2>/dev/null)"
  [ -n "$FILE_STRIPPED" ] && EFFECTIVE_ARGS="$(cat "$ARGS_FILE")"
fi

# Cleanup: only unlink files inside the expected bs-new-args.*/args.txt
# pattern written by commands/bs/new.md — never an arbitrary --args-file path.
case "$ARGS_FILE" in
  */bs-new-args.*/args.txt)
    rm -f "$ARGS_FILE"
    ARGS_PARENT=$(dirname "$ARGS_FILE")
    case "$ARGS_PARENT" in
      */bs-new-args.*) rmdir "$ARGS_PARENT" 2>/dev/null || true ;;
    esac
    ;;
esac

echo "EFFECTIVE_ARGS=$EFFECTIVE_ARGS"
```

If `$EFFECTIVE_ARGS` is non-empty, use it (whitespace-separated
`project-name` then `--path <dir>`) to pre-fill Step 1's questions. If it's
empty — file missing/unreadable/empty, args-file absent, and no remaining
args either — that's fine here (unlike `scrub`, see below): ask
interactively as normal (Step 1 already does this for a bare `/bs:new`).

**Deliberately soft-fail, unlike `scrub`'s hard-fail bridge**: `new` only
creates a brand-new, non-existent directory (Step 2 refuses to overwrite
an existing path) and gathers the rest of its inputs interactively either
way, so a lost args-file just means the operator re-answers questions it
would have pre-filled — never a wrong-target or destructive outcome. This
is why `new` falls back instead of aborting like `scrub`'s bridge does;
the two skills have different failure costs, not an inconsistent
implementation of the same contract.

### Step 1: Gather Info

```markdown
Creating new project: <project-name>

**Quick setup questions:**

1. **Location?** (default: ~/Projects/<project-name>)
2. **Description?** (1 sentence - for README/CLAUDE.md)
3. **License?** (MIT/proprietary)
4. **GitHub repo?** (default: yes, private)
   - **private** (default): `gh repo create <project-name> --private`
   - **public**: `gh repo create <project-name> --public`
   - **none**: Skip GitHub repo creation (local only)
5. **QA Architect workflow tier?**
   - **minimal** (default): Single Node 22, weekly security (~$0-5/mo)
   - **standard**: Matrix on main, weekly security (~$5-20/mo)
   - **comprehensive**: Matrix every commit, inline security (~$100-350/mo)
```

### Step 2: Create Directory Structure

```bash
PROJECT_PATH="${PATH:-$HOME/Projects}/<project-name>"

# Check if exists
if [[ -d "$PROJECT_PATH" ]]; then
  echo "❌ Project already exists: $PROJECT_PATH"
  exit 1
fi

mkdir -p "$PROJECT_PATH"
cd "$PROJECT_PATH"

echo "📁 Created: $PROJECT_PATH"
```

### Step 3: Initialize Git

```bash
git init
echo "✅ Git initialized"
```

### Step 4: Add agent-kit Submodule

```bash
# Add submodule
git submodule add https://github.com/buildproven/agent-kit.git .agent-kit

# Create symlink to make commands available
ln -s .agent-kit ~/.claude 2>/dev/null || true

echo "✅ Added agent-kit submodule"
```

### Step 5: Create .qualityrc.json

```json
{
  "version": "0.1.0",
  "maturity": "prototype",
  "detected": {
    "level": "prototype",
    "sourceFiles": 0,
    "testFiles": 0,
    "hasDocumentation": false,
    "hasDependencies": false,
    "detectedAt": "2026-01-08T00:00:00.000Z"
  },
  "checks": {
    "prettier": {
      "enabled": true,
      "required": true
    },
    "eslint": {
      "enabled": "auto",
      "required": false
    },
    "stylelint": {
      "enabled": "auto",
      "required": false
    },
    "tests": {
      "enabled": "auto",
      "required": false
    },
    "coverage": {
      "enabled": false,
      "required": false,
      "threshold": 50
    },
    "security-audit": {
      "enabled": "auto",
      "required": false
    },
    "documentation": {
      "enabled": false,
      "required": false
    },
    "lighthouse": {
      "enabled": false,
      "required": false
    }
  }
}
```

### Step 6: Create .gitignore

```gitignore
# Dependencies
node_modules/
.pnp
.pnp.js

# Testing
coverage/
.nyc_output

# Build outputs
dist/
build/
out/
.next/
.vercel/
.turbo/

# Misc
.DS_Store
*.pem
.env
.env.local
.env.*.local
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# OS
Thumbs.db
```

### Step 6.5: Create .claudeignore

```
# Dependencies (large, low signal for Claude)
node_modules/
.pnp.*

# Build output
.next/
out/
dist/
build/
.vercel/
.netlify/

# Coverage & test artifacts
coverage/
.nyc_output/
test-results/
playwright-report/

# Lock files
package-lock.json
pnpm-lock.yaml
yarn.lock

# Caches
.cache/
.turbo/
.eslintcache
*.tsbuildinfo

# Generated
*.min.js
*.min.css
*.map

# OS / IDE
.DS_Store
Thumbs.db
.idea/
.vscode/settings.json

# Secrets
.env
.env.*
!.env.example
```

### Step 7: Create package.json

```json
{
  "name": "<project-name>",
  "version": "0.1.0",
  "private": true,
  "description": "<description>",
  "scripts": {
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {},
  "engines": {
    "node": ">=20"
  }
}
```

### Step 8: Create CLAUDE.md

````markdown
# <project-name> - Claude Guide

> <description>

## Project Status

**Stage:** Early exploration
**Stack:** TBD (choose framework/language)
**Quality Maturity:** Prototype

## Commands

```bash
# Quality checks (QA Architect)
npm run lint                # ESLint
npm run lint:fix            # ESLint with auto-fix
npm run format              # Prettier formatting
npm run format:check        # Check formatting
npm run quality:check       # Run all checks
npm run quality:fix         # Auto-fix all issues

# Testing (add when you add tests)
npm test                    # Run tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
```
````

_Quality infrastructure from agent-kit. Global rules in `~/.claude/CLAUDE.md`._

````

### Step 9: Create BACKLOG.md

```markdown
# Backlog

## 🔥 High Value - Next Up

| ID | Feature | Value Drivers (Rev/Ret/Diff) | Effort | Status |
|----|---------|------------------------------|--------|--------|
| - | Choose tech stack | Foundation for everything | S | 🎯 Next |
| - | Setup dev environment | Enables development | S | Pending |

## 📊 Medium Value - Worth Doing

| ID | Feature | Value Drivers | Effort | Status |
|----|---------|---------------|--------|--------|
| - | Add CI/CD | Quality automation | M | Pending |

## 📚 Low Value - When Needed

| ID | Feature | Value Drivers | Effort | Status |
|----|---------|---------------|--------|--------|

## Completed ✅

| ID | Feature | Completed |
|----|---------|-----------|
| - | Quality infrastructure | 2026-01-08 |

**Effort:** S (<4h) | M (4-16h) | L (16-40h) | XL (40h+)
**Value:** Revenue + Retention + Differentiation (1-5 each)
**Priority:** Value ÷ Effort = ROI Score
````

### Step 10: Create README.md

````markdown
# <project-name>

> <description>

## Status

🚧 **Early Stage** - Exploring and choosing tech stack

## Setup

```bash
# Install dependencies
npm install

# Format code
npm run format

# Run checks
npm run quality:check
```
````

## License

<license>
```

### Step 11: Run QA Architect

Now integrate qa-architect for full quality automation (ESLint, Husky, lint-staged, GitHub Actions):

```bash
# Run qa-architect with chosen workflow tier
WORKFLOW_TIER="${workflow_tier:-minimal}"  # Default to minimal if not specified

echo "🔧 Installing QA Architect (workflow: $WORKFLOW_TIER)..."

npx create-qa-architect@latest --workflow-$WORKFLOW_TIER

echo "✅ QA Architect installed with $WORKFLOW_TIER workflow"
```

**Workflow tiers:**

- **minimal**: Single Node 22, weekly security, path filters (~$0-5/mo)
- **standard**: Matrix on main only, weekly security (~$5-20/mo)
- **comprehensive**: Matrix every commit, inline security (~$100-350/mo)

### Step 12: Install & Commit

```bash
# Install dependencies (qa-architect already ran npm install)
echo "✅ Dependencies installed by QA Architect"

# Initial commit
git add .
git commit -m "chore: initial project setup with quality infrastructure

- Quality maturity: prototype
- QA Architect (workflow: $WORKFLOW_TIER)
- ESLint + Prettier + Stylelint
- Husky + lint-staged pre-commit hooks
- GitHub Actions quality workflow
- agent-kit submodule
- Secret scanning config
- Basic project structure

Co-Authored-By: Claude <noreply@anthropic.com>"

echo "✅ Initial commit created"
```

### Step 13: Create GitHub Repository & Push

```bash
# Skip if user chose "none" for GitHub repo
if [[ "$GITHUB_REPO" != "none" ]]; then
  VISIBILITY="${GITHUB_REPO:-private}"  # Default to private

  echo "🔗 Creating GitHub repository..."

  # Create repo and set as remote
  gh repo create <project-name> --$VISIBILITY --source=. --remote=origin --description "<description>"

  # Rename default branch to main if needed
  git branch -M main

  # Push initial commit
  git push -u origin main

  echo "✅ GitHub repository created: https://github.com/$(gh api user --jq .login)/<project-name>"
else
  echo "ℹ️  Skipping GitHub repo creation (local only)"
  echo "   Create later with: gh repo create <project-name> --private --source=. --remote=origin"
fi
```

### Step 14: Summary

Print: project path, GitHub URL (or "local only"), quality maturity (prototype), workflow tier, and next step: `cd <path>` → `/bs:dev <feature>`.

## Quality Maturity Progression

| Maturity       | Checks                    | When                 |
| -------------- | ------------------------- | -------------------- |
| **Prototype**  | Prettier only             | 0-10 files           |
| **MVP**        | + ESLint + tests          | 11-50 files          |
| **Beta**       | + 50% coverage            | 51-150 files + tests |
| **Production** | + 80% coverage + security | 150+ files + docs    |
