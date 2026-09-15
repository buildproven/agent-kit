#!/usr/bin/env bash
# Checks that every command listed in commands/README.md exists as a file under commands/.
# Exits 1 if phantom commands are found.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
README="$REPO_ROOT/commands/README.md"

# Collect commands from table rows only (lines starting with |).
# Match the pattern: | `/some:command` | — must have at least one letter after the slash.
missing=()
while IFS= read -r cmd; do
  # Strip leading slash, convert colon to slash for path lookup (e.g. /bs:dev -> bs/dev.md)
  # Also handle top-level commands like /update-claudemd -> update-claudemd.md
  # and bs:scrub which lives at bs:scrub.md (colon in filename)
  stripped="${cmd#/}"

  # Try colon-in-filename form first (e.g. bs:scrub.md)
  if [[ -f "$REPO_ROOT/commands/${stripped}.md" ]]; then
    continue
  fi

  # Try slash-separated form (e.g. bs/dev.md)
  slash_path="${stripped/://}"
  slash_path="${slash_path/:/\/}"
  if [[ -f "$REPO_ROOT/commands/${slash_path}.md" ]]; then
    continue
  fi

  # Top-level command (no prefix)
  if [[ -f "$REPO_ROOT/commands/${stripped}.md" ]]; then
    continue
  fi

  missing+=("$cmd")
done < <(grep '^|' "$README" | grep -oE '`/[a-z][a-z:_-]+`' | tr -d '`' | sort -u)

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: commands/README.md lists commands that don't exist:" >&2
  for m in "${missing[@]}"; do
    echo "  $m" >&2
  done
  echo "" >&2
  echo "Either add the missing command files or remove the entries from commands/README.md." >&2
  exit 1
fi

echo "OK: all commands listed in commands/README.md exist."
