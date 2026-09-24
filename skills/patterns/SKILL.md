---
name: patterns
description: Search CLAUDE.md for patterns and best practices across all projects
user-invocable: false
---

# /bs:patterns - Search Learning Corpus

**Usage**: `/bs:patterns <keyword> [--interactive]`

Search accumulated patterns and best practices in CLAUDE.md files (global + project).

## Quick Reference

```bash
/bs:patterns "authentication"          # Search for auth patterns
/bs:patterns "deployment"              # Search for deployment patterns
/bs:patterns "bash" --interactive      # Interactive fzf search
/bs:patterns --all                     # Show all section headers
/bs:patterns "auth" --all-projects     # Search all projects (CS-072)
/bs:patterns "auth" --project my-app  # Search a specific project
/bs:patterns --deprecated              # Include deprecated patterns
/bs:patterns --since 2026-01-01        # Only patterns added since date
/bs:patterns --list-meta               # Show all patterns with metadata
/bs:patterns --list-projects           # List all registered projects
/bs:patterns --learn                   # Auto-learn patterns from codebase (CS-089)
/bs:patterns --learn --dry-run         # Preview what would be learned
```

## Pattern Metadata Schema (CS-071)

Patterns in CLAUDE.md can include metadata using HTML comment markers:

```markdown
<!-- pattern:id=P-001 added=2026-01-15 status=active source=CS-055 -->

### Pattern Name

Pattern description...

<!-- /pattern -->
```

**Fields:** `id` (P-NNN), `added` (YYYY-MM-DD), `status` (active/deprecated/experimental), `source` (CS-NNN)

## Flags

| Flag              | Description                                         |
| ----------------- | --------------------------------------------------- |
| `--interactive`   | Use fzf for interactive browsing                    |
| `--all`           | Show all section headers (no filtering)             |
| `--global`        | Search only global CLAUDE.md                        |
| `--project NAME`  | Search specific project by name (CS-072)            |
| `--all-projects`  | Search CLAUDE.md in all projects (CS-072)           |
| `--rank`          | Sort results by relevance score                     |
| `--deprecated`    | Include deprecated patterns (hidden by default)     |
| `--since DATE`    | Only show patterns added on/after DATE (YYYY-MM-DD) |
| `--status STATUS` | Filter by status: active, deprecated, experimental  |
| `--list-meta`     | List all patterns with their metadata               |
| `--list-projects` | List all registered/discovered projects (CS-072)    |
| `--no-cache`      | Bypass search index cache (CS-072)                  |
| `--refresh-cache` | Force cache refresh (CS-072)                        |
| `--learn`         | Auto-learn patterns from codebase (CS-089)          |
| `--dry-run`       | Preview what would be learned (use with `--learn`)  |

---

## Implementation

```bash
#!/usr/bin/env bash
set -euo pipefail

KEYWORD="${1:-}"
MODE="search"  # search, list, list-meta, list-projects, interactive, learn
SCOPE="both"   # both, global, project, single-project, all-projects
RANK_RESULTS=false
INCLUDE_DEPRECATED=false
SINCE_DATE=""
STATUS_FILTER=""
PROJECT_FILTER=""
USE_CACHE=true
REFRESH_CACHE=false
LEARN_DRY_RUN=false

USER_PROJECTS_DIR="${USER_PROJECTS_DIR:-$HOME/Projects}"
PROJECTS_JSON="$HOME/.claude/projects.json"
CACHE_FILE="$HOME/.claude/pattern-search-cache.json"
CACHE_TTL_MINUTES=60

GLOBAL_CLAUDE="$HOME/.claude/CLAUDE.md"
PROJECT_CLAUDE="./CLAUDE.md"

# Parse flags: --interactive, --all, --global, --project [NAME], --all-projects,
# --rank, --deprecated, --since DATE, --status STATUS, --list-meta, --list-projects,
# --no-cache, --refresh-cache, --learn, --dry-run

# Validate: search mode requires keyword
# Build FILES[] and PROJECT_NAMES[] arrays based on scope

# For single-project: check projects.json registry, fallback to direct path
# For all-projects: load registered + auto-discover ~/Projects/*/CLAUDE.md + submodule paths
```

### Core Functions

```bash
parse_pattern_metadata() {
  # Parse <!-- pattern:id=P-001 added=2026-01-15 status=active source=CS-055 -->
  # Sets: PATTERN_ID, PATTERN_ADDED, PATTERN_STATUS, PATTERN_SOURCE
}

should_include_pattern() {
  # Filter by: deprecated status, status filter, since date
}

search_patterns() {
  # grep -i -B 2 -A 10 "$keyword" "$file"
  # Calculate relevance score: match_count + 5 if keyword in header
}

search_all_projects_ranked() {
  # For each file: count matches, +10 for header matches
  # Sort by score descending, show ranked table + top 3 detailed results
}

list_all_sections() {
  # grep -E "^#{1,3} " "$file"
}

list_patterns_with_metadata() {
  # Parse pattern markers, apply filters, output table:
  # | ID | Pattern | Status | Added | Source |
}

list_all_projects() {
  # From projects.json: | Project | Path | Description | Tags |
  # Auto-discovered: find ~/Projects -maxdepth 2 -name "CLAUDE.md"
}

interactive_search() {
  # Requires fzf. Combines all files, pipes to fzf with preview
}
```

### Main Execution

```bash
case "$MODE" in
  learn)
    # CS-089: Run scripts/learn-patterns.sh [--dry-run] on current directory
    ;;
  search)
    if all-projects + rank: search_all_projects_ranked
    elif all-projects: cross-project search with section header extraction
    else: search_patterns per file
    ;;
  list)       list_all_sections per file ;;
  list-meta)  list_patterns_with_metadata per file ;;
  list-projects) list_all_projects ;;
  interactive)   interactive_search ;;
esac
```

---

## Cross-Project Search (CS-072)

```bash
/bs:patterns "authentication" --all-projects        # Search all projects
/bs:patterns "auth" --all-projects --rank           # Ranked by relevance
/bs:patterns "deployment" --project my-app         # Search a specific project
/bs:patterns --list-projects                        # List all registered projects
```

**Searches:** Global CLAUDE.md, registered projects from `~/.claude/projects.json`, auto-discovered `~/Projects/*/CLAUDE.md`, submodule CLAUDE.md files.

**Ranking:** +1 per match, +10 for header matches. Results sorted highest first.

## Auto-Learn Patterns from Codebase (CS-089)

```bash
/bs:patterns --learn                   # Generate .defensive-patterns.json
/bs:patterns --learn --dry-run         # Preview only
```

**Discovers:** Auth middleware (withAuth, requireAuth, protectedProcedure), safe parse helpers (.safeParse, safeJsonParse), public routes, error handling patterns (try/catch, Result pattern, ErrorBoundary), React callback patterns (useCallback vs inline).

## Pattern Versioning & Lifecycle (CS-071)

- **active** - Current best practice, recommended
- **experimental** - Being tested, may change
- **deprecated** - Superseded, hidden by default (use `--deprecated`)

Query by date: `/bs:patterns --list-meta --since 2026-02-01`
ID convention: `P-NNN` format, globally unique, `source` links to backlog item.

## Notes

- Case-insensitive search by default
- Context: 2 lines before, 10 lines after each match
- Searches both global and project CLAUDE.md
- Interactive mode requires fzf: `brew install fzf`
- Deprecated patterns hidden by default

---

_Part of the agent-kit knowledge management system_
