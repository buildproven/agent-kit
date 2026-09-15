#!/usr/bin/env bash
# Install the lean Codex skill default plus explicitly selected capability packs.
set -euo pipefail

# ROOT must be the OVERLAY root — the directory containing both core/ (the
# kit submodule) and, if a private overlay is installed, its own top-level
# skills/config — regardless of whether this specific copy of the script was
# shipped from core/scripts/ or a private overlay's scripts/. Resolve through
# this script's own installed symlink target (install.sh links each file
# individually into ~/.claude/scripts/) rather than $BASH_SOURCE, which would
# resolve to core/ when this file lives inside the kit submodule.
#
# The resolved path ends in .../scripts/setup-codex-skill-profile.sh either
# way, but the overlay root is one level further up when this copy lives
# inside an embedded core/ submodule than when the kit repo is used
# standalone (its own scripts/ dir sits directly under its repo root).
# Detect embedding by preferring an overlay-level config/codex-skills.json
# one level higher, since that file only ever exists at the true overlay
# root of a private overlay, never inside the kit submodule's own tree.
SETUP_CODEX_SKILL_PROFILE_REAL_PATH="$(readlink -f "${HOME}/.claude/scripts/setup-codex-skill-profile.sh" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
SETUP_CODEX_SKILL_PROFILE_SCRIPTS_DIR="$(cd "$(dirname "$SETUP_CODEX_SKILL_PROFILE_REAL_PATH")" && pwd)"
SETUP_CODEX_SKILL_PROFILE_ONE_UP="$(cd "$SETUP_CODEX_SKILL_PROFILE_SCRIPTS_DIR/.." && pwd)"
if [ -z "${SETUP_REPO:-}" ] && [ -f "$SETUP_CODEX_SKILL_PROFILE_ONE_UP/../config/codex-skills.json" ]; then
  SETUP_REPO="$(cd "$SETUP_CODEX_SKILL_PROFILE_ONE_UP/.." && pwd)"
fi
ROOT="${SETUP_REPO:-$SETUP_CODEX_SKILL_PROFILE_ONE_UP}"
TARGET="${CODEX_AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
PROFILE="default"
MODE=()
LIST=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || {
        echo "setup-codex-skill-profile: --profile requires a value" >&2
        exit 1
      }
      PROFILE="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || {
        echo "setup-codex-skill-profile: --target requires a value" >&2
        exit 1
      }
      TARGET="$2"
      shift 2
      ;;
    --check|--clean) MODE=("$1"); shift ;;
    --list) LIST=1; shift ;;
    -h|--help)
      echo "usage: setup-codex-skill-profile.sh [--profile default|all|name[,name...]] [--target dir] [--check|--clean] [--list]"
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$LIST" -eq 1 ]; then
  echo "default (always installed):"
  for manifest in \
    "$ROOT/core/config/codex-skills.json" \
    "$ROOT/config/codex-skills.json"; do
    jq -r '.skills[] | "  - \(.)"' "$manifest"
  done
  echo
  echo "optional packs (additive to default):"
  for manifest in \
    "$ROOT/core/config/codex-skill-packs/"*.json \
    "$ROOT/config/codex-skill-packs/"*.json; do
    [ -f "$manifest" ] || continue
    name=$(basename "$manifest" .json)
    skills=$(jq -r '.skills | join(", ")' "$manifest")
    echo "  $name: $skills"
  done
  echo
  echo "activate: $0 --profile founder,publishing"
  echo "reset:    $0 --profile default"
  exit 0
fi

ENGINE="$ROOT/core/scripts/setup-codex-skills.sh"
if [ ! -f "$ENGINE" ]; then
  ENGINE="$ROOT/scripts/setup-codex-skills.sh"
fi
ARGS=(--target "$TARGET")
[ -d "$ROOT/core/skills" ] && ARGS+=(--source "$ROOT/core/skills")
[ -f "$ROOT/core/config/codex-skills.json" ] && ARGS+=(--allowlist "$ROOT/core/config/codex-skills.json")
[ -d "$ROOT/skills" ] && ARGS+=(--source "$ROOT/skills")
[ -f "$ROOT/config/codex-skills.json" ] && ARGS+=(--allowlist "$ROOT/config/codex-skills.json")

add_pack() {
  local name="$1"
  local found=0
  local candidate
  for candidate in \
    "$ROOT/core/config/codex-skill-packs/$name.json" \
    "$ROOT/config/codex-skill-packs/$name.json"; do
    if [ -f "$candidate" ]; then
      ARGS+=(--allowlist "$candidate")
      found=1
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "unknown Codex skill pack: $name" >&2
    exit 2
  fi
}

if [ "$PROFILE" = all ]; then
  for candidate in \
    "$ROOT/core/config/codex-skill-packs/"*.json \
    "$ROOT/config/codex-skill-packs/"*.json; do
    [ -f "$candidate" ] && ARGS+=(--allowlist "$candidate")
  done
elif [ "$PROFILE" != default ]; then
  IFS=',' read -r -a PACKS <<< "$PROFILE"
  for pack in "${PACKS[@]}"; do add_pack "$pack"; done
fi

if [ ${#MODE[@]} -gt 0 ]; then
  bash "$ENGINE" "${ARGS[@]}" "${MODE[@]}"
else
  bash "$ENGINE" "${ARGS[@]}"
fi
