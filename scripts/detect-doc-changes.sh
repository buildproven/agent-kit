#!/bin/bash
# detect-doc-changes.sh - Detect API changes that require documentation updates
# Part of CS-059: Auto-Documentation from Code Changes
#
# Usage:
#   ./detect-doc-changes.sh [--staged|--branch|--commit <sha>]
#
# Output:
#   JSON object with detected changes and docs that need updating

set -e

# Parse arguments
MODE="staged"
COMMIT_SHA=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --staged)
      MODE="staged"
      shift
      ;;
    --branch)
      MODE="branch"
      shift
      ;;
    --commit)
      [ "$#" -ge 2 ] || {
        echo "detect-doc-changes: --commit requires a value" >&2
        exit 1
      }
      MODE="commit"
      COMMIT_SHA="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Get the diff based on mode
get_diff() {
  case $MODE in
    staged)
      git diff --cached
      ;;
    branch)
      MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
      git diff "$MAIN_BRANCH"...HEAD
      ;;
    commit)
      git show "$COMMIT_SHA"
      ;;
  esac
}

# Get changed file names based on mode
get_changed_files() {
  case $MODE in
    staged)
      git diff --cached --name-only
      ;;
    branch)
      MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
      git diff "$MAIN_BRANCH"...HEAD --name-only
      ;;
    commit)
      git show --name-only --format="" "$COMMIT_SHA"
      ;;
  esac
}

# Initialize arrays for tracking
NEW_EXPORTS=()
CHANGED_SIGNATURES=()
NEW_COMMANDS=()
NEW_SKILLS=()
DOCS_TO_UPDATE=()

# Get the diff content
DIFF_CONTENT=$(get_diff)
CHANGED_FILES=$(get_changed_files)

# Pattern 1: New exports (export const|function|class|interface|type)
while IFS= read -r line; do
  if [[ -n "$line" ]]; then
    # Extract the export name
    export_name=$(echo "$line" | sed -E 's/.*export (const|function|class|interface|type) ([a-zA-Z_][a-zA-Z0-9_]*).*/\2/')
    if [[ "$export_name" != "$line" ]]; then
      NEW_EXPORTS+=("$export_name")
    fi
  fi
done < <(echo "$DIFF_CONTENT" | grep -E '^\+.*export (const|function|class|interface|type) ' | grep -v '^\+\+\+' || true)

# Pattern 2: Changed function signatures (function name( or arrow functions with types)
while IFS= read -r line; do
  if [[ -n "$line" ]]; then
    # Extract function name
    func_name=$(echo "$line" | sed -E 's/.*function ([a-zA-Z_][a-zA-Z0-9_]*)\s*\(.*/\1/' | head -1)
    if [[ "$func_name" != "$line" && -n "$func_name" ]]; then
      CHANGED_SIGNATURES+=("$func_name")
    fi
  fi
done < <(echo "$DIFF_CONTENT" | grep -E '^\+.*function [a-zA-Z_][a-zA-Z0-9_]*\s*\(' | grep -v '^\+\+\+' || true)

# Pattern 3: New command files (commands/*.md)
while IFS= read -r file; do
  if [[ "$file" =~ ^commands/.*\.md$ ]]; then
    # Check if it's a new file (not just modified)
    if ! git show HEAD:"$file" &>/dev/null 2>&1; then
      NEW_COMMANDS+=("$file")
    fi
  fi
done < <(echo "$CHANGED_FILES")

# Pattern 4: New skill files (skills/*.md)
while IFS= read -r file; do
  if [[ "$file" =~ ^skills/.*\.md$ ]]; then
    # Check if it's a new file
    if ! git show HEAD:"$file" &>/dev/null 2>&1; then
      NEW_SKILLS+=("$file")
    fi
  fi
done < <(echo "$CHANGED_FILES")

# Determine which docs need updating
if [[ ${#NEW_EXPORTS[@]} -gt 0 ]] || [[ ${#CHANGED_SIGNATURES[@]} -gt 0 ]]; then
  # Check if this appears to be a library/API project
  if [[ -f "README.md" ]]; then
    DOCS_TO_UPDATE+=("README.md (API section)")
  fi
fi

if [[ ${#NEW_COMMANDS[@]} -gt 0 ]]; then
  DOCS_TO_UPDATE+=("commands/bs/help.md")
  DOCS_TO_UPDATE+=("CLAUDE.md (if workflow changed)")
fi

if [[ ${#NEW_SKILLS[@]} -gt 0 ]]; then
  DOCS_TO_UPDATE+=("skills documentation")
  DOCS_TO_UPDATE+=("README.md (skills section)")
fi

# Check if any commands/*.md files were modified (not just new)
MODIFIED_COMMANDS=()
while IFS= read -r file; do
  if [[ "$file" =~ ^commands/.*\.md$ ]]; then
    # Check if file existed before (modified, not new)
    if git show HEAD:"$file" &>/dev/null 2>&1; then
      MODIFIED_COMMANDS+=("$file")
    fi
  fi
done < <(echo "$CHANGED_FILES")

if [[ ${#MODIFIED_COMMANDS[@]} -gt 0 ]]; then
  DOCS_TO_UPDATE+=("commands/bs/help.md (command flags may have changed)")
fi

# Calculate if doc updates are needed
DOC_UPDATE_NEEDED=false
if [[ ${#NEW_EXPORTS[@]} -gt 0 ]] || [[ ${#CHANGED_SIGNATURES[@]} -gt 0 ]] || \
   [[ ${#NEW_COMMANDS[@]} -gt 0 ]] || [[ ${#NEW_SKILLS[@]} -gt 0 ]] || \
   [[ ${#MODIFIED_COMMANDS[@]} -gt 0 ]]; then
  DOC_UPDATE_NEEDED=true
fi

# Output JSON
cat << EOF
{
  "doc_update_needed": $DOC_UPDATE_NEEDED,
  "changes": {
    "new_exports": $(printf '%s\n' "${NEW_EXPORTS[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
    "changed_signatures": $(printf '%s\n' "${CHANGED_SIGNATURES[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
    "new_commands": $(printf '%s\n' "${NEW_COMMANDS[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
    "new_skills": $(printf '%s\n' "${NEW_SKILLS[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
    "modified_commands": $(printf '%s\n' "${MODIFIED_COMMANDS[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]")
  },
  "docs_to_update": $(printf '%s\n' "${DOCS_TO_UPDATE[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
  "summary": {
    "total_api_changes": $((${#NEW_EXPORTS[@]} + ${#CHANGED_SIGNATURES[@]})),
    "total_new_commands": ${#NEW_COMMANDS[@]},
    "total_new_skills": ${#NEW_SKILLS[@]},
    "total_modified_commands": ${#MODIFIED_COMMANDS[@]}
  }
}
EOF
