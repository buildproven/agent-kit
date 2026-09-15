#!/usr/bin/env bash
# Load and validate one explicit quality invocation manifest.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest|--manifest=*)
      if [ "$1" = "--manifest" ]; then
        MANIFEST="${2:-}"
      else
        MANIFEST="${1#*=}"
      fi
      case "$MANIFEST" in
        ""|-*) echo "quality-load-root: --manifest requires a non-empty path (use ./ for a path starting with '-')" >&2; exit 1 ;;
      esac
      if [ "$1" = "--manifest" ]; then shift 2; else shift; fi
      ;;
    *) echo "quality-load-root: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || {
  echo "quality-load-root: --manifest is required" >&2
  exit 1
}
ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" locate "$MANIFEST")" || exit 1
cd "$ROOT" || exit 1
node "$SCRIPT_DIR/quality-invocation.js" validate "$MANIFEST" >/dev/null || exit 1
printf '{"manifest":"%s","status":"validated"}\n' "$MANIFEST"
