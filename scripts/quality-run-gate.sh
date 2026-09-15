#!/usr/bin/env bash
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
NAME=""
SKIP=false
REASON=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-run-gate: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    --name)
      [ "$#" -ge 2 ] || {
        echo "quality-run-gate: --name requires a value" >&2
        exit 1
      }
      NAME="$2"
      shift 2
      ;;
    --skip) SKIP=true; shift ;;
    --reason)
      [ "$#" -ge 2 ] || {
        echo "quality-run-gate: --reason requires a value" >&2
        exit 1
      }
      REASON="$2"
      shift 2
      ;;
    --) shift; break ;;
    *) echo "quality-run-gate: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] && [ -n "$NAME" ] || {
  echo "quality-run-gate: --manifest and --name are required" >&2
  exit 1
}
source "$SCRIPT_DIR/quality-repo-lease-pin.sh" || exit 1
quality_pin_repository_lease "$MANIFEST" || exit 1
if [ "$SKIP" = true ]; then
  [ "$NAME" = test ] && [ -n "$REASON" ] && [ "$#" -eq 0 ] || {
    echo "quality-run-gate: --skip requires --name test, --reason, and no command" >&2
    exit 1
  }
elif [ "$#" -eq 0 ]; then
  :
else
  echo "quality-run-gate: commands are resolved from the persisted gate policy" >&2
  exit 1
fi
ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" locate "$MANIFEST")" || exit 1
bash "$SCRIPT_DIR/quality-assert-clean.sh" \
  --manifest "$MANIFEST" --phase "gate '$NAME'" || exit 1
STATE_ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" stateRoot)"
HEAD="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.currentHead)"
if node "$SCRIPT_DIR/quality-invocation.js" gate-satisfied "$MANIFEST" \
  --name "$NAME"; then
  echo "[quality] reusing exact-HEAD gate evidence: $NAME @ $HEAD"
  exit 0
fi
LOG_DIR="$STATE_ROOT/gates/$HEAD"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$NAME.log"
cd "$ROOT" || exit 1
release_terminal_quality_lock() {
  local lock_owner branch plan primary root_real primary_real unlock_error
  # Bootstrap acquires quality worktree locks only for merge campaigns.
  [ "$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" options.merge)" = true ] || return 0
  branch="$(git branch --show-current 2>/dev/null || true)"
  [ -n "$branch" ] || {
    echo "[quality] terminal gate failure could not determine the current branch (detached HEAD?); the worktree lock was not changed." >&2
    return 0
  }
  lock_owner="$(node "$SCRIPT_DIR/quality-invocation.js" lock-owner "$MANIFEST")" || {
    echo "[quality] terminal gate failure could not resolve its invocation identity; the worktree lock was not changed." >&2
    return 0
  }
  plan="$(node "$SCRIPT_DIR/worktree-manager.js" resolve --repo "$ROOT" --branch "$branch")" || {
    echo "[quality] terminal gate failure could not resolve worktree ownership for '$branch'; the lock was not changed." >&2
    return 0
  }
  primary="$(printf '%s' "$plan" | jq -r '.repoRoot // empty' 2>/dev/null)"
  [ -n "$primary" ] || {
    echo "[quality] terminal gate failure resolved no primary repository for '$branch'; the lock was not changed." >&2
    return 0
  }
  root_real="$(cd "$ROOT" 2>/dev/null && pwd -P)" || {
    echo "[quality] terminal gate failure could not normalize target repository '$ROOT'; the lock was not changed." >&2
    return 0
  }
  primary_real="$(cd "$primary" 2>/dev/null && pwd -P)" || {
    echo "[quality] terminal gate failure could not normalize primary repository '$primary'; the lock was not changed." >&2
    return 0
  }
  [ "$primary_real" != "$root_real" ] || return 0
  unlock_error="$(node "$SCRIPT_DIR/worktree-manager.js" unlock \
    --repo "$ROOT" --branch "$branch" --owner "$lock_owner" --terminal \
    2>&1 >/dev/null)" || {
    echo "[quality] terminal gate failure left its worktree lock in place: $unlock_error" >&2
    node "$SCRIPT_DIR/worktree-manager.js" status \
      --repo "$ROOT" --branch "$branch" --skip-pr-check >&2 || true
  }
}
if [ "$SKIP" = true ]; then
  node "$SCRIPT_DIR/quality-invocation.js" gate-run "$MANIFEST" \
    --name "$NAME" --skip --reason "$REASON" || exit 1
  cat "$LOG"
  exit 0
fi
node "$SCRIPT_DIR/quality-invocation.js" gate-run "$MANIFEST" \
  --name "$NAME"
GATE_RC=$?
if [ "$GATE_RC" -ne 0 ]; then
  release_terminal_quality_lock
  node "$SCRIPT_DIR/quality-terminal-status.js" \
    --manifest "$MANIFEST" --category repository-gate --gate "$NAME" || true
  GATE_FAILURE_CODE="$(jq -r --arg name "$NAME" --arg head "$HEAD" \
    '[.gates[] | select(.name == $name and .head == $head)] | last | .failureCode // ""' \
    "$MANIFEST")"
  TERMINAL_STATE=blocked
  TERMINAL_DETAIL="gate:$NAME"
  if [ "$GATE_FAILURE_CODE" = signal-interrupted ]; then
    TERMINAL_STATE=interrupted
    TERMINAL_DETAIL="gate:$NAME:signal-interrupted"
  fi
  # See quality-run-review.sh: record the machine-readable terminal state next
  # to the human diagnosis so an ended campaign is identifiable from disk.
  node "$SCRIPT_DIR/quality-invocation.js" terminal-state "$MANIFEST" \
    --state "$TERMINAL_STATE" --detail "$TERMINAL_DETAIL" >/dev/null || true
  exit "$GATE_RC"
fi
bash "$SCRIPT_DIR/quality-assert-clean.sh" \
  --manifest "$MANIFEST" --phase "gate '$NAME' completion" || exit 1
