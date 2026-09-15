#!/bin/bash
# multi-session-guard.sh — Detect multiple Claude Code sessions on the same git repo.
#
# Problem: Two CC tabs on the same repo share .git state. Concurrent git operations
# (checkout, add, commit) collide — commits land on wrong branches, staging gets mixed.
#
# Solution: At session start, check for other active Claude Code processes working
# in the same git repo. Warn if detected. Uses a lock file in .git/ to track sessions.
#
# Hook types: SessionStart (detect + warn), UserPromptSubmit (optional git-op guard)
#
# Environment: CC passes $PWD, $SESSION_ID, $TOOL_INPUT etc.

set -euo pipefail

# Only act in git repos. Resolve the git dir rather than assuming
# "<toplevel>/.git" is a directory: in a linked worktree `.git` is a FILE
# holding a gitdir: pointer, so the old path made `mkdir -p` fail with
# "Not a directory" and `set -e` killed this hook — disabling multi-session
# detection in every worktree, the exact multi-checkout case it guards.
GIT_DIR_PATH=$(git -C "$PWD" rev-parse --absolute-git-dir 2>/dev/null) || exit 0
# Still needed for the human-readable repo/branch in the warning below.
GIT_ROOT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) || exit 0

LOCK_DIR="$GIT_DIR_PATH/claude-sessions"
mkdir -p "$LOCK_DIR" 2>/dev/null || exit 0

# Current session identifier (use CC session ID if available, fallback to PID-based)
SESSION_ID="${SESSION_ID:-$$}"
LOCK_FILE="$LOCK_DIR/$SESSION_ID.lock"

# Register this session.
#
# The third field is the OWNER, and it must outlive this hook. $$ here is the
# hook shell, which exits the moment this script returns, so recording it made
# every lock instantly reapable by the liveness check below while the real
# session kept running — the guard silently stopped guarding (BUI-917).
#
# Prefer a real session identity. Only fall back to $$ when Claude supplies no
# session id, and mark that case so the reaper knows the pid is untrustworthy.
if [ -n "${CLAUDE_SESSION_ID:-}" ]; then
    LOCK_OWNER="session:$CLAUDE_SESSION_ID"
elif [ -n "${SESSION_ID:-}" ] && [ "$SESSION_ID" != "$$" ]; then
    LOCK_OWNER="session:$SESSION_ID"
else
    LOCK_OWNER="hookpid:$$"
fi
echo "$(date +%s) $PWD $LOCK_OWNER" > "$LOCK_FILE"

# Clean stale locks (sessions that ended without cleanup — older than 12 hours)
NOW=$(date +%s)
for lock in "$LOCK_DIR"/*.lock; do
    [ -f "$lock" ] || continue
    [ "$lock" = "$LOCK_FILE" ] && continue

    LOCK_TS=$(head -1 "$lock" 2>/dev/null | awk '{print $1}')
    if [ -n "$LOCK_TS" ]; then
        AGE=$(( NOW - LOCK_TS ))
        if [ "$AGE" -gt 43200 ]; then
            # Stale lock (>12h) — remove
            rm -f "$lock"
            continue
        fi

        # Liveness check, but ONLY for owners whose pid is meaningful.
        #
        # A "session:" owner belongs to a Claude session this hook cannot see
        # in the process table, so its absence proves nothing; those locks age
        # out via the 12h TTL above instead. A "hookpid:" owner is the legacy
        # shape and is already dead by definition, so reaping on pid liveness
        # would discard live sessions — exactly the BUI-917 defect. Treat a
        # bare number the same way: it is a pre-fix record of unknown validity.
        LOCK_OWNER=$(head -1 "$lock" 2>/dev/null | awk '{print $3}')
        case "$LOCK_OWNER" in
            proc:*)
                LOCK_PID="${LOCK_OWNER#proc:}"
                if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
                    rm -f "$lock"
                    continue
                fi
                ;;
        esac
    fi
done

# Count other active sessions (excluding ours)
OTHER_SESSIONS=0
OTHER_INFO=""
for lock in "$LOCK_DIR"/*.lock; do
    [ -f "$lock" ] || continue
    [ "$lock" = "$LOCK_FILE" ] && continue
    OTHER_SESSIONS=$((OTHER_SESSIONS + 1))
    LOCK_PID=$(head -1 "$lock" 2>/dev/null | awk '{print $3}')
    OTHER_INFO="PID $LOCK_PID"
done

if [ "$OTHER_SESSIONS" -gt 0 ]; then
    REPO_NAME=$(basename "$GIT_ROOT")
    BRANCH=$(git -C "$GIT_ROOT" branch --show-current 2>/dev/null || echo "unknown")

    cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "⚠️ MULTI-SESSION COLLISION RISK: ${OTHER_SESSIONS} other CC session(s) active on ${REPO_NAME} (branch: ${BRANCH}, ${OTHER_INFO}). Git operations (checkout, add, commit) will collide. Options: (1) let the other tab finish first, (2) use separate git worktrees, (3) work on different branches and coordinate carefully."
  }
}
JSON
else
    exit 0
fi
