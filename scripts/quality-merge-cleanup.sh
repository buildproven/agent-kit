#!/usr/bin/env bash
# Post-merge cleanup. A completed merge stays successful even when cleanup
# cannot finish; every incomplete path prints one exact recovery command.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=quality-repo-lease-pin.sh
source "$SCRIPT_DIR/quality-repo-lease-pin.sh"
PRESERVE_BRANCH=false
MANIFEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preserve-branch) PRESERVE_BRANCH=true; shift ;;
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-merge-cleanup: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    *) echo "[quality] merge succeeded; cleanup incomplete: unknown cleanup argument '$1'." >&2; exit 0 ;;
  esac
done

# Repository serialization is independent of worktree cleanup. Release a lease
# from authoritative remote merge evidence before a dirty primary can make the
# ordinary cleanup path return early.
if [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ]; then
  LEASE_STATUS="$(node "$SCRIPT_DIR/quality-repo-lease.js" status \
    --manifest "$MANIFEST" 2>/dev/null || true)"
  if [ "$(printf '%s' "$LEASE_STATUS" | jq -r '.state // empty' 2>/dev/null)" = active ]; then
    if quality_pin_repository_lease "$MANIFEST"; then
      LEASE_RESULT="$(node "$SCRIPT_DIR/quality-repo-lease.js" release-if-merged \
        --manifest "$MANIFEST")" || LEASE_RESULT=error
      if [ "$LEASE_RESULT" = error ]; then
        PRESERVE_BRANCH=true
        echo "[quality] merge succeeded; repository lease reconciliation failed." >&2
        echo "  Recovery: node \"$SCRIPT_DIR/quality-repo-lease.js\" status --manifest \"$MANIFEST\"" >&2
      elif [ "$(printf '%s' "$LEASE_RESULT" | jq -r '.reconciled // false')" != true ]; then
        LEASE_STATUS="$(node "$SCRIPT_DIR/quality-repo-lease.js" status \
          --manifest "$MANIFEST" 2>/dev/null || true)"
        if [ "$(printf '%s' "$LEASE_STATUS" | jq -r '.mergeGuard != null' 2>/dev/null)" = true ]; then
          PRESERVE_BRANCH=true
          INVOCATION_ID="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" invocationId)"
          PR="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.pr)"
          echo "[quality] merge succeeded; repository merge remains quarantined pending exact remote verification." >&2
          echo "  Recovery: node \"$SCRIPT_DIR/quality-repo-lease.js\" reconcile-merge --manifest \"$MANIFEST\" --confirm-owner-invocation-id \"$INVOCATION_ID\" --confirm-owner-pr \"$PR\"" >&2
        else
          PRESERVE_BRANCH=true
          echo "[quality] merge succeeded; repository lease remains active because GitHub did not prove the exact head merged." >&2
        fi
      fi
    else
      PRESERVE_BRANCH=true
      echo "[quality] merge succeeded; repository lease cleanup was fenced; resume the exact campaign shown by lease status." >&2
    fi
  fi
fi

WORKTREE_PATH="$(git rev-parse --show-toplevel 2>/dev/null || true)"
FEATURE_BRANCH="$(git branch --show-current 2>/dev/null || true)"
MANAGER="$SCRIPT_DIR/worktree-manager.js"
if [ -z "$WORKTREE_PATH" ] || [ -z "$FEATURE_BRANCH" ] || [ ! -f "$MANAGER" ]; then
  echo "[quality] merge succeeded; cleanup incomplete: target or worktree manager unavailable." >&2
  exit 0
fi

PLAN="$(node "$MANAGER" resolve --repo "$WORKTREE_PATH" --branch "$FEATURE_BRANCH" 2>/dev/null || true)"
PRIMARY_CHECKOUT="$(printf '%s' "$PLAN" | jq -r '.repoRoot // empty' 2>/dev/null)"
DEFAULT_BRANCH="$(printf '%s' "$PLAN" | jq -r '.defaultBranch // empty' 2>/dev/null)"
if [ -z "$PRIMARY_CHECKOUT" ]; then
  echo "[quality] merge succeeded; cleanup incomplete: primary checkout could not be resolved." >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$WORKTREE_PATH\" --apply" >&2
  exit 0
fi

if [ "$PRIMARY_CHECKOUT" = "$WORKTREE_PATH" ]; then
  echo "[quality] merge succeeded; cleanup incomplete: merge ran in the primary checkout." >&2
  echo "  Recovery: inspect \"$PRIMARY_CHECKOUT\" and move future work to a linked worktree." >&2
  exit 0
fi

LOCK_OWNER=""
if [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ]; then
  LOCK_OWNER="$(node "$SCRIPT_DIR/quality-invocation.js" lock-owner "$MANIFEST" 2>/dev/null || true)"
fi

# Leave the worktree before asking Git to remove its exact registered path.
cd "$PRIMARY_CHECKOUT" || {
  echo "[quality] merge succeeded; cleanup incomplete: cannot enter $PRIMARY_CHECKOUT." >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$WORKTREE_PATH\" --apply" >&2
  exit 0
}

[ -n "$DEFAULT_BRANCH" ] || {
  echo "[quality] merge succeeded; cleanup incomplete: default branch could not be resolved." >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
  exit 0
}
PRIMARY_STATUS="$(git status --porcelain)"
PRIMARY_STATUS_RC=$?
if [ "$PRIMARY_STATUS_RC" -ne 0 ]; then
  echo "[quality] merge succeeded; cleanup incomplete: primary checkout status could not be inspected: $PRIMARY_STATUS" >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
  exit 0
fi
if [ -n "$PRIMARY_STATUS" ]; then
  echo "[quality] merge succeeded; cleanup incomplete: primary checkout is dirty; it was not changed." >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
  exit 0
fi
git fetch origin "$DEFAULT_BRANCH" -q || {
  echo "[quality] merge succeeded; cleanup incomplete: could not fetch origin/$DEFAULT_BRANCH." >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
  exit 0
}
PRIMARY_BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [ "$PRIMARY_BRANCH" = "$DEFAULT_BRANCH" ]; then
  git merge --ff-only "origin/$DEFAULT_BRANCH" >/dev/null || {
    echo "[quality] merge succeeded; cleanup incomplete: primary $DEFAULT_BRANCH did not fast-forward." >&2
    echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
    exit 0
  }
else
  echo "[quality] merge succeeded; cleanup incomplete: primary checkout is on '${PRIMARY_BRANCH:-detached}', not '$DEFAULT_BRANCH'; it was not updated." >&2
  echo "  Recovery: switch \"$PRIMARY_CHECKOUT\" to \"$DEFAULT_BRANCH\", fast-forward it, then run node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
  exit 0
fi

REMOVE_ARGS=(remove --repo "$PRIMARY_CHECKOUT" --branch "$FEATURE_BRANCH" --allow-unknown)
[ -n "$LOCK_OWNER" ] &&
  REMOVE_ARGS+=(--recover --owner "$LOCK_OWNER")
[ "$PRESERVE_BRANCH" = false ] && REMOVE_ARGS+=(--delete-branch)
REMOVE_JSON="$(node "$MANAGER" "${REMOVE_ARGS[@]}" 2>&1)"
REMOVE_RC=$?
if [ "$REMOVE_RC" -ne 0 ]; then
  echo "[quality] merge succeeded; cleanup incomplete: $REMOVE_JSON" >&2
  echo "  Recovery: node \"$MANAGER\" reconcile --repo \"$PRIMARY_CHECKOUT\" --apply" >&2
  exit 0
fi
BRANCH_DELETED="$(printf '%s' "$REMOVE_JSON" | jq -r '.branchDeleted // false' 2>/dev/null)"
BRANCH_DELETE_ERROR="$(printf '%s' "$REMOVE_JSON" | jq -r '.branchDeletionError // empty' 2>/dev/null)"
if [ "$PRESERVE_BRANCH" = false ] && [ "$BRANCH_DELETED" != true ]; then
  echo "[quality] merge succeeded; worktree removed; local branch cleanup incomplete: ${BRANCH_DELETE_ERROR:-git branch -d refused deletion}." >&2
  echo "  Recovery: git -C \"$PRIMARY_CHECKOUT\" branch -d \"$FEATURE_BRANCH\"" >&2
  echo "  primary: $PRIMARY_CHECKOUT ($DEFAULT_BRANCH)"
  echo "  removed: $WORKTREE_PATH"
  echo "  remaining worktrees:"
  git worktree list
  exit 0
fi

echo "[quality] merge cleanup complete."
echo "  primary: $PRIMARY_CHECKOUT ($DEFAULT_BRANCH)"
echo "  removed: $WORKTREE_PATH"
echo "  remaining worktrees:"
git worktree list
exit 0
