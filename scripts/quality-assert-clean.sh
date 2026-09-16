#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
PHASE="quality operation"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-assert-clean: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    --phase)
      [ "$#" -ge 2 ] || {
        echo "quality-assert-clean: --phase requires a value" >&2
        exit 1
      }
      PHASE="$2"
      shift 2
      ;;
    *) echo "quality-assert-clean: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || {
  echo "quality-assert-clean: --manifest is required" >&2
  exit 1
}
ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" locate "$MANIFEST")"
cd "$ROOT"
DIRTY="$(git status --porcelain=v1 --untracked-files=all)"
[ -z "$DIRTY" ] || {
  echo "❌ QUALITY BLOCKED: dirty working tree before $PHASE." >&2
  printf '%s\n' "$DIRTY" >&2
  exit 1
}
