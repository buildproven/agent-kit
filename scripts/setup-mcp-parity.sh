#!/usr/bin/env bash
# Install one lean MCP capability profile across Claude Code and Codex.
set -euo pipefail

# SETUP_REPO must be the OVERLAY root, not wherever this script's own copy is
# checked out — config/mcp.json only exists at the overlay root (there is no
# core/config/mcp.json unless an overlay provides one), so a $BASH_SOURCE-
# relative default breaks silently when this file ships from core/scripts/
# inside the kit submodule. Resolve through the installed symlink target
# instead (see setup-codex-skill-profile.sh for the same fix pattern).
#
# The resolved path ends in .../scripts/setup-mcp-parity.sh either way, but
# the overlay root is one level further up when this copy lives inside an
# embedded core/ submodule than when the kit repo is used standalone (its own
# scripts/ dir sits directly under its repo root). Detect embedding by
# preferring an overlay-level config/mcp.json one level higher, since that
# file only ever exists at the true overlay root.
SETUP_MCP_PARITY_REAL_PATH="$(python3 - "${BASH_SOURCE[0]}" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).resolve(strict=True))
PY
)"
SETUP_MCP_PARITY_SCRIPTS_DIR="$(cd "$(dirname "$SETUP_MCP_PARITY_REAL_PATH")" && pwd -P)"
SETUP_MCP_PARITY_ONE_UP="$(cd "$SETUP_MCP_PARITY_SCRIPTS_DIR/.." && pwd -P)"
if [ -z "${SETUP_REPO:-}" ] && [ -f "$SETUP_MCP_PARITY_ONE_UP/../config/mcp.json" ]; then
  SETUP_REPO="$(cd "$SETUP_MCP_PARITY_ONE_UP/.." && pwd -P)"
fi
SETUP_REPO="${SETUP_REPO:-$SETUP_MCP_PARITY_ONE_UP}"
MANIFEST="$SETUP_REPO/config/mcp.json"
PROFILE=""
LOGIN=0
FORCE=0
CHECK=0
CACHE_LOCK_OWNED=0
CACHE_ELIGIBLE=0
SELECTED_MANIFEST=""
MCP_LOCK_OWNER_TEMP=""

cleanup() {
  if [ -n "$SELECTED_MANIFEST" ]; then
    rm -f "$SELECTED_MANIFEST"
  fi
  if [ -n "$MCP_LOCK_OWNER_TEMP" ]; then
    rm -f "$MCP_LOCK_OWNER_TEMP"
  fi
  if [ "$CACHE_LOCK_OWNED" -eq 1 ]; then
    rm -f "$MCP_CACHE_LOCK/owner"
    rmdir "$MCP_CACHE_LOCK" 2>/dev/null || true
  fi
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || { echo "--profile requires a value" >&2; exit 2; }
      PROFILE="$2"
      shift
      ;;
    --login) LOGIN=1 ;;
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    *) echo "usage: setup-mcp-parity.sh [--profile NAME] [--force] [--login] [--check]" >&2; exit 2 ;;
  esac
  shift
done

if [ "$CHECK" -eq 1 ] && { [ "$LOGIN" -eq 1 ] || [ "$FORCE" -eq 1 ]; }; then
  echo "--check cannot be combined with --force or --login" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
jq -e '
  . as $manifest |
  (.servers | type == "array") and
  (.profiles | type == "object") and
  ([.servers[].name] | length == (unique | length)) and
  ([.profiles[]][] | all(. as $name | [$manifest.servers[].name] | index($name) != null))
' "$MANIFEST" >/dev/null || {
  echo "invalid MCP manifest/profile configuration" >&2
  exit 1
}

if [ -z "$PROFILE" ]; then
  PROFILE="$(jq -r '.defaultProfile' "$MANIFEST")"
fi
jq -e --arg profile "$PROFILE" '.profiles[$profile] | type == "array"' "$MANIFEST" >/dev/null || {
  echo "unknown MCP profile: $PROFILE" >&2
  exit 2
}

for client in claude codex; do
  command -v "$client" >/dev/null 2>&1 || {
    echo "$client CLI is required for MCP profile sync" >&2
    exit 1
  }
done

MCP_SYNC_PY="$(dirname "$SETUP_MCP_PARITY_REAL_PATH")/mcp-sync.py"
MCP_CACHE_HELPER="$(dirname "$SETUP_MCP_PARITY_REAL_PATH")/mcp-parity-cache.py"
# shellcheck source=lib/state-dir-name.sh
source "$SETUP_MCP_PARITY_SCRIPTS_DIR/lib/state-dir-name.sh"
MCP_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
MCP_CACHE_DIR="$MCP_STATE_HOME/$(state_dir_name "$MCP_STATE_HOME")"
MCP_PROFILE_KEY="$(printf '%s' "$PROFILE" | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
MCP_CACHE="$MCP_CACHE_DIR/mcp-parity-$MCP_PROFILE_KEY.json"
MCP_CACHE_LOCK="$MCP_CACHE.lock"
MCP_CLAUDE_CONFIG="$HOME/.claude.json"
MCP_CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
MCP_CLAUDE_BIN="$(command -v claude)"
MCP_CODEX_BIN="$(command -v codex)"
MCP_CACHE_ARGS=(
  --cache "$MCP_CACHE"
  --profile "$PROFILE"
  --source "$MANIFEST"
  --source "$SETUP_MCP_PARITY_REAL_PATH"
  --source "$MCP_SYNC_PY"
  --source "$MCP_CACHE_HELPER"
  --client-config "$MCP_CLAUDE_CONFIG"
  --client-config "$MCP_CODEX_CONFIG"
  --client-executable "$MCP_CLAUDE_BIN"
  --client-executable "$MCP_CODEX_BIN"
)

process_start_identity() {
  ps -o lstart= -p "$1" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

if [ "$LOGIN" -eq 0 ] && [ "$FORCE" -eq 0 ] && [ "$CHECK" -eq 0 ]; then
  CACHE_ELIGIBLE=1
  missing_owner_seen=0
  python3 "$MCP_CACHE_HELPER" prepare "${MCP_CACHE_ARGS[@]}"
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if mkdir "$MCP_CACHE_LOCK" 2>/dev/null; then
      lock_owner_started="$(process_start_identity "$$")"
      if [ -z "$lock_owner_started" ]; then
        rmdir "$MCP_CACHE_LOCK" 2>/dev/null || true
        echo "unable to establish MCP parity cache lock owner identity" >&2
        exit 1
      fi
      MCP_LOCK_OWNER_TEMP="$MCP_CACHE_LOCK/.owner.$$"
      printf '%s\n%s\n' "$$" "$lock_owner_started" > "$MCP_LOCK_OWNER_TEMP"
      mv "$MCP_LOCK_OWNER_TEMP" "$MCP_CACHE_LOCK/owner"
      MCP_LOCK_OWNER_TEMP=""
      CACHE_LOCK_OWNED=1
      break
    fi
    if [ ! -f "$MCP_CACHE_LOCK/owner" ] && [ "$missing_owner_seen" -eq 0 ]; then
      missing_owner_seen=1
      sleep 1
      continue
    fi
    lock_owner="$(sed -n '1p' "$MCP_CACHE_LOCK/owner" 2>/dev/null || true)"
    lock_owner_started="$(sed -n '2p' "$MCP_CACHE_LOCK/owner" 2>/dev/null || true)"
    current_owner_started=""
    if [[ "$lock_owner" =~ ^[1-9][0-9]*$ ]]; then
      current_owner_started="$(process_start_identity "$lock_owner")"
    fi
    if [ -z "$current_owner_started" ] || [ "$current_owner_started" != "$lock_owner_started" ]; then
      stale_lock="$MCP_CACHE_LOCK.stale.$$"
      if mv "$MCP_CACHE_LOCK" "$stale_lock" 2>/dev/null; then
        rm -f "$stale_lock/owner"
        find "$stale_lock" -maxdepth 1 -type f -name '.owner.*' -delete
        rmdir "$stale_lock" 2>/dev/null || true
      fi
      missing_owner_seen=0
      continue
    fi
    missing_owner_seen=0
    sleep 1
  done
  [ "$CACHE_LOCK_OWNED" -eq 1 ] || {
    echo "timed out waiting for MCP parity cache lock: $MCP_CACHE_LOCK" >&2
    exit 1
  }
  if python3 "$MCP_CACHE_HELPER" hit "${MCP_CACHE_ARGS[@]}"; then
    rm -f "$MCP_CACHE_LOCK/owner"
    rmdir "$MCP_CACHE_LOCK"
    CACHE_LOCK_OWNED=0
    echo "MCP profile unchanged: $PROFILE (verified cached parity)"
    exit 0
  fi
fi

managed_retired_registration() {
  client="$1"
  name="$2"
  expected_command="$3"
  if [ "$client" = claude ]; then
    python3 - "$HOME/.claude.json" "$name" "$expected_command" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
try:
    definition = json.loads(path.read_text(encoding="utf8")).get("mcpServers", {}).get(sys.argv[2])
except (OSError, ValueError, TypeError):
    raise SystemExit(2)
raise SystemExit(0 if isinstance(definition, dict)
                 and definition.get("command") == sys.argv[3]
                 and definition.get("args", []) == [] else 1)
PY
    return
  fi

  definition="$("$client" mcp get "$name" 2>/dev/null)" || return 1
  printf '%s\n' "$definition" | grep -Fqx "  command: $expected_command" &&
    printf '%s\n' "$definition" | grep -Fqx '  args: -'
}

prune_retired_registration() {
  client="$1"
  name="$2"
  expected_command="$3"
  status=0
  managed_retired_registration "$client" "$name" "$expected_command" || status=$?
  [ "$status" -ne 2 ] || {
    echo "unable to inspect $client retired MCP registration: $name" >&2
    return 1
  }
  [ "$status" -eq 0 ] || return 0
  if [ "$CHECK" -eq 1 ]; then
    echo "$client has managed retired MCP server: $name" >&2
    DRIFT=1
  elif [ "$client" = claude ]; then
    "$client" mcp remove --scope user "$name"
  else
    "$client" mcp remove "$name"
  fi
}

SELECTED_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/bs-mcp-profile.XXXXXX")"

jq --arg profile "$PROFILE" '
  ((.profiles[.defaultProfile] + .profiles[$profile]) | unique) as $selected
  | {servers: [.servers[] | select(.name as $name | $selected | index($name) != null)]}
' "$MANIFEST" > "$SELECTED_MANIFEST"

args=(--manifest "$SELECTED_MANIFEST")
[ "$FORCE" -eq 0 ] || args+=(--force)
[ "$LOGIN" -eq 0 ] || args+=(--login)
[ "$CHECK" -eq 0 ] || args+=(--check)

# Add/refresh the desired profile before pruning anything. A failed connection
# or auth step leaves a safe superset of capabilities.
#
# mcp-sync.py lives alongside THIS script (same layer — core/scripts/ if this
# ships from the kit, an overlay's scripts/ if overridden there), not
# necessarily under $SETUP_REPO/core/ — a standalone kit install has no
# core/ subdirectory at all.
DRIFT=0
python3 "$MCP_SYNC_PY" "${args[@]}" || DRIFT=1
[ "$CHECK" -eq 1 ] || [ "$DRIFT" -eq 0 ] || exit 1

# Prune only names owned by this manifest. Unknown/user-managed servers are
# never touched.
while IFS= read -r server; do
  for client in claude codex; do
    jq -e --arg server "$server" --arg client "$client" '
      any(.servers[];
        .name == $server and
        ((.clients // ["claude", "codex"]) | index($client) != null)
      )
    ' "$SELECTED_MANIFEST" >/dev/null && continue
    if "$client" mcp get "$server" >/dev/null 2>&1; then
      if [ "$CHECK" -eq 1 ]; then
        echo "$client has out-of-profile MCP server: $server" >&2
        DRIFT=1
        continue
      fi
      if [ "$client" = claude ]; then
        "$client" mcp remove --scope user "$server"
      else
        "$client" mcp remove "$server"
      fi
    fi
  done
done < <(jq -r '.servers[].name, "sequential-thinking", "claude-kit-license"' "$MANIFEST")

# These names were removed from the manifest, so prune only the exact
# registrations previously installed by this repository.
for client in claude codex; do
  prune_retired_registration \
    "$client" ideabrowser "$SETUP_REPO/scripts/run-ideabrowser-mcp.sh"
  prune_retired_registration \
    "$client" readwise "$SETUP_REPO/scripts/run-readwise-mcp.sh"
done

[ "$DRIFT" -eq 0 ] || exit 1
if [ "$CACHE_ELIGIBLE" -eq 1 ]; then
  python3 "$MCP_CACHE_HELPER" record "${MCP_CACHE_ARGS[@]}"
fi
echo "MCP profile active: $PROFILE ($(jq '.servers | length' "$SELECTED_MANIFEST") server(s))"
