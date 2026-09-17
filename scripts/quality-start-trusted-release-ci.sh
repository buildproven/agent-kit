#!/usr/bin/env bash
# Start only GitHub's held quality run for the exact release-please candidate.
# This is deliberately a no-op for normal branches. Merge still performs the
# independent required-check wait after local gates and review complete.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ "$#" -eq 2 ] && [ "$1" = "--manifest" ] && [ -n "$2" ] || {
  echo "quality-start-trusted-release-ci: usage --manifest <exact-path>" >&2
  exit 1
}
MANIFEST="$2"
ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" locate "$MANIFEST")"
HEAD="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.currentHead)"
HEAD_REF="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.headRefName)"
if [[ ! "$HEAD_REF" =~ ^release-please--branches--[A-Za-z0-9._/-]+--components--[A-Za-z0-9._/-]+$ ]]; then
  printf '%s\n' '{"attempted":false,"approved":false}'
  exit 0
fi
REPOSITORY="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.githubRepository)"
PR="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.pr)"
BASE="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.baseRef)"
BASE="${BASE#refs/heads/}"
BASE="${BASE#origin/}"
[ -n "$REPOSITORY" ] && [ -n "$PR" ] && [ -n "$BASE" ] && [ -n "$HEAD" ] || {
  echo "quality-start-trusted-release-ci: release identity is incomplete" >&2
  exit 1
}
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$HEAD" ] || {
  echo "quality-start-trusted-release-ci: local HEAD differs from manifest" >&2
  exit 1
}
PREPARE_JSON="$(node "$SCRIPT_DIR/quality-required-checks.js" prepare \
  --repo "$REPOSITORY" --base "$BASE" --source-head "$HEAD" --head "$HEAD")"
WORKFLOW_ID="$(printf '%s' "$PREPARE_JSON" | jq -r \
  '[.dispatches[] | select(.context == "quality" and .transport == "workflow_dispatch") | .workflowId] | if length == 1 then .[0] else empty end')"
if [ -z "$WORKFLOW_ID" ]; then
  printf '%s\n' '{"attempted":true,"approved":false}'
  exit 0
fi
node "$SCRIPT_DIR/quality-approve-trusted-release-workflow.js" \
  --repo "$REPOSITORY" --pr "$PR" --base "$BASE" --head "$HEAD" \
  --head-ref "$HEAD_REF" --workflow-id "$WORKFLOW_ID"
