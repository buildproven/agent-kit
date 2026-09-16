#!/bin/bash
# multi-session-cleanup.sh — Remove session lock on Stop event.
# Paired with multi-session-guard.sh (SessionStart).

# Resolve the git dir, don't assume "<toplevel>/.git" is one: in a linked
# worktree `.git` is a FILE, so the old path never matched where the guard
# actually writes and locks created in a worktree were never cleaned up.
GIT_DIR_PATH=$(git -C "$PWD" rev-parse --absolute-git-dir 2>/dev/null) || exit 0

# Keep the identity precedence identical to multi-session-guard.sh.
SESSION_ID="${CLAUDE_SESSION_ID:-${SESSION_ID:-$$}}"
LOCK_FILE="$GIT_DIR_PATH/claude-sessions/$SESSION_ID.lock"

rm -f "$LOCK_FILE" 2>/dev/null
exit 0
