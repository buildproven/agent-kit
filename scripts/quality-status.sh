#!/usr/bin/env bash
# quality-status.sh — on-demand terminal diagnosis for an in-flight or
# stalled quality campaign (BUI-383).
#
# quality-terminal-status.js's buildDiagnosis() already produces a clear,
# structured report (repository gate status, provider review/checkpoint
# state, break-glass approval state, GitHub CI status) but was previously
# invoked only reactively from failure paths inside quality-run-gate.sh,
# quality-run-review.sh, and quality-stamp-and-merge.sh — all with
# best-effort `|| true` semantics tucked into error handling. There was no
# way to proactively ask "what's the state of my campaign?" without either
# waiting for a failure or manually reading the manifest JSON and `ps aux`.
#
# This script is that missing first-class entry point: read-only, no
# mutation, no new campaign, no discovery-by-glob. Matches the same explicit
# "the caller must pass the exact manifest path" convention already used by
# quality-bootstrap.sh's resume path and quality-load-root.sh — status must
# never guess which invocation is "the active one" from a PR number, session
# ID, or mtime.
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
        ""|-*) echo "quality-status: --manifest requires a non-empty path (use ./ for a path starting with '-')" >&2; exit 1 ;;
      esac
      if [ "$1" = "--manifest" ]; then shift 2; else shift; fi
      ;;
    *) echo "quality-status: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || {
  echo "❌ quality-status: --manifest <path> is required." >&2
  echo "   There is deliberately no PR-number or session lookup — pass the" >&2
  echo "   exact manifest path printed by an earlier bootstrap/resume." >&2
  exit 1
}
[ -f "$MANIFEST" ] || {
  echo "❌ quality-status: manifest not found: $MANIFEST" >&2
  exit 1
}

# quality-load-root.sh already does exactly the read-only locate+validate
# this needs (cd to repo root, verify identity) — reuse it rather than
# duplicating that logic here.
bash "$SCRIPT_DIR/quality-load-root.sh" --manifest "$MANIFEST" >/dev/null || exit 1

# No --category/--provider/--reset-at: this is a proactive on-demand check,
# not a reaction to a specific failure classification. buildDiagnosis()'s
# failure parameter defaults to {}, which still reports the true current
# state of gates, provider reviews, and break-glass approval from the
# manifest itself — it just won't have a specific "why did THIS fail" label,
# because nothing has necessarily failed yet.
node "$SCRIPT_DIR/quality-terminal-status.js" --manifest "$MANIFEST"
