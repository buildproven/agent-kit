#!/usr/bin/env bash
# generate-changelog.sh — Auto-generate CHANGELOG entries from conventional commits
#
# Usage:
#   ./scripts/generate-changelog.sh                    # Unreleased changes since last tag
#   ./scripts/generate-changelog.sh --since v4.8.0     # Changes since specific tag
#   ./scripts/generate-changelog.sh --apply            # Write directly to CHANGELOG.md
#   ./scripts/generate-changelog.sh --full             # Full changelog from all tags
#   ./scripts/generate-changelog.sh --dry-run          # Preview without writing (default)
#
# Requires: git, conventional commit messages (feat:, fix:, docs:, etc.)
# Works in any repo with conventional commits — not specific to agent-kit.

set -euo pipefail

# Defaults
MODE="dry-run"
SINCE_TAG=""
FULL_MODE=false
CHANGELOG_FILE="CHANGELOG.md"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      SINCE_TAG="$2"
      if [[ ! "$SINCE_TAG" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
        echo "Invalid --since value: $SINCE_TAG" >&2; exit 1
      fi
      shift 2 ;;
    --apply) MODE="apply"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --full) FULL_MODE=true; shift ;;
    --file) CHANGELOG_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: generate-changelog.sh [--since TAG] [--apply] [--full] [--file PATH]"
      exit 0
      ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# Ensure we're in a git repo
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Not in a git repo"; exit 1; }
cd "$GIT_ROOT"

# Find the range of commits to process
if [ -n "$SINCE_TAG" ]; then
  RANGE="${SINCE_TAG}..HEAD"
elif [ "$FULL_MODE" = true ]; then
  RANGE=""
else
  # Find latest tag
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  if [ -n "$LATEST_TAG" ]; then
    RANGE="${LATEST_TAG}..HEAD"
  else
    RANGE=""
  fi
fi

# Temp files for collecting commits by type (Bash 3.2 compatible — no associative arrays)
TMPDIR_CL=$(mktemp -d)
touch "$TMPDIR_CL/feat" "$TMPDIR_CL/fix" "$TMPDIR_CL/docs" "$TMPDIR_CL/refactor" "$TMPDIR_CL/perf" "$TMPDIR_CL/other"
cleanup_tmpdir() {
  rm -f \
    "$TMPDIR_CL/feat" \
    "$TMPDIR_CL/fix" \
    "$TMPDIR_CL/docs" \
    "$TMPDIR_CL/refactor" \
    "$TMPDIR_CL/perf" \
    "$TMPDIR_CL/other" \
    "$TMPDIR_CL/commits"
  rmdir "$TMPDIR_CL" 2>/dev/null || true
}
trap cleanup_tmpdir EXIT

# Write commits to temp file first, then process (avoids subshell pipe issue)
if [ -n "$RANGE" ]; then
  git log "$RANGE" --pretty=format:%s --no-merges 2>/dev/null > "$TMPDIR_CL/commits"
else
  git log --pretty=format:%s --no-merges 2>/dev/null > "$TMPDIR_CL/commits"
fi

while IFS= read -r line; do
  [ -z "$line" ] && continue

  # Extract type using case statement (Bash 3.2 + macOS compatible)
  TYPE=""
  case "$line" in
    feat*) TYPE="feat" ;;
    fix*) TYPE="fix" ;;
    docs*) TYPE="docs" ;;
    refactor*) TYPE="refactor" ;;
    perf*) TYPE="perf" ;;
    chore*) TYPE="chore" ;;
    build*) TYPE="build" ;;
    ci*) TYPE="ci" ;;
    test*) TYPE="test" ;;
    style*) TYPE="style" ;;
    revert*) TYPE="revert" ;;
  esac
  [ -z "$TYPE" ] && continue

  # Extract scope (between parentheses after type) if present
  SCOPE=""
  REST="${line#"$TYPE"}"
  case "$REST" in
    "("*) SCOPE="${REST#\(}"; SCOPE="${SCOPE%%\)*}" ;;
  esac

  # Extract message (everything after "type:" or "type(scope):")
  MSG=$(echo "$line" | sed -E 's/^[a-z]+(\([^)]*\))?!?: *//')

  # Clean up: remove PR references like (#99)
  MSG=$(echo "$MSG" | sed 's/ (#[0-9]*)$//')

  # Format with scope
  if [ -n "$SCOPE" ]; then
    ENTRY="- **${SCOPE}:** ${MSG}"
  else
    ENTRY="- ${MSG}"
  fi

  case "$TYPE" in
    feat) echo "$ENTRY" >> "$TMPDIR_CL/feat" ;;
    fix) echo "$ENTRY" >> "$TMPDIR_CL/fix" ;;
    docs) echo "$ENTRY" >> "$TMPDIR_CL/docs" ;;
    refactor) echo "$ENTRY" >> "$TMPDIR_CL/refactor" ;;
    perf) echo "$ENTRY" >> "$TMPDIR_CL/perf" ;;
    *) echo "$ENTRY" >> "$TMPDIR_CL/other" ;;
  esac
done < "$TMPDIR_CL/commits"

# Build output
OUTPUT=""
TOTAL=0

if [ -s "$TMPDIR_CL/feat" ]; then
  COUNT=$(wc -l < "$TMPDIR_CL/feat" | tr -d ' ')
  OUTPUT+=$'\n### Added\n\n'
  OUTPUT+=$(cat "$TMPDIR_CL/feat")$'\n'
  TOTAL=$((TOTAL + COUNT))
fi

if [ -s "$TMPDIR_CL/fix" ]; then
  COUNT=$(wc -l < "$TMPDIR_CL/fix" | tr -d ' ')
  OUTPUT+=$'\n### Fixed\n\n'
  OUTPUT+=$(cat "$TMPDIR_CL/fix")$'\n'
  TOTAL=$((TOTAL + COUNT))
fi

if [ -s "$TMPDIR_CL/refactor" ]; then
  COUNT=$(wc -l < "$TMPDIR_CL/refactor" | tr -d ' ')
  OUTPUT+=$'\n### Changed\n\n'
  OUTPUT+=$(cat "$TMPDIR_CL/refactor")$'\n'
  TOTAL=$((TOTAL + COUNT))
fi

if [ -s "$TMPDIR_CL/perf" ]; then
  COUNT=$(wc -l < "$TMPDIR_CL/perf" | tr -d ' ')
  OUTPUT+=$'\n### Performance\n\n'
  OUTPUT+=$(cat "$TMPDIR_CL/perf")$'\n'
  TOTAL=$((TOTAL + COUNT))
fi

if [ -s "$TMPDIR_CL/docs" ]; then
  COUNT=$(wc -l < "$TMPDIR_CL/docs" | tr -d ' ')
  OUTPUT+=$'\n### Documentation\n\n'
  OUTPUT+=$(cat "$TMPDIR_CL/docs")$'\n'
  TOTAL=$((TOTAL + COUNT))
fi

# Print results
if [ $TOTAL -eq 0 ]; then
  echo "No conventional commits found in range."
  exit 0
fi

echo "## [Unreleased]"
echo ""
echo "$OUTPUT"
echo "---"
echo "Generated: $(date +%Y-%m-%d) | ${TOTAL} entries from conventional commits"

# Apply mode: write to CHANGELOG.md
if [ "$MODE" = "apply" ]; then
  if [ ! -f "$CHANGELOG_FILE" ]; then
    echo "# Changelog" > "$CHANGELOG_FILE"
    echo "" >> "$CHANGELOG_FILE"
    echo "All notable changes to this project will be documented in this file." >> "$CHANGELOG_FILE"
    echo "" >> "$CHANGELOG_FILE"
  fi

  # Check if [Unreleased] section exists
  if grep -q '## \[Unreleased\]' "$CHANGELOG_FILE"; then
    # Replace existing Unreleased section content (between [Unreleased] and next ## heading)
    # Use a temp file for safe replacement
    TEMP_FILE=$(mktemp)
    awk -v new_content="$OUTPUT" '
      /^## \[Unreleased\]/ { print; print new_content; skip=1; next }
      skip && /^## \[/ { skip=0 }
      !skip { print }
    ' "$CHANGELOG_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$CHANGELOG_FILE"
  else
    # Insert Unreleased section after the header
    TEMP_FILE=$(mktemp)
    awk -v section="## [Unreleased]\n${OUTPUT}" '
      NR==1 { print; next }
      NR==2 && /^$/ { print; print section; next }
      { print }
    ' "$CHANGELOG_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$CHANGELOG_FILE"
  fi

  echo ""
  echo "Updated $CHANGELOG_FILE with ${TOTAL} entries."
fi
