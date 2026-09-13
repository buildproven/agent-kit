#!/usr/bin/env bash
# Working-tree feedback, not exact-head release or product-completion evidence.
# Leave time for owned-process cleanup inside the 60-second hook deadline.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if bash "$SCRIPT_DIR/quality-run-bounded.sh" --timeout 50 -- \
  node "$SCRIPT_DIR/task-completed-check.js"; then
  exit 0
else
  RESULT=$?
  if [ "$RESULT" -eq 124 ]; then
    echo "Task tests exceeded the hook budget. Run the affected plan in the quality campaign; completion is not verified." >&2
  else
    echo "Task verification failed (exit $RESULT). Resolve the reported check before completing." >&2
  fi
  exit 2
fi
