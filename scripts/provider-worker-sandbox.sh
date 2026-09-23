#!/usr/bin/env bash
# Run one provider worker with an explicit environment and OS sandbox.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_CONFIG GIT_CONFIG_COUNT
for git_env in $(env | sed -n 's/^\(GIT_CONFIG_KEY_[0-9][0-9]*\|GIT_CONFIG_VALUE_[0-9][0-9]*\)=.*/\1/p'); do
  unset "$git_env"
done

SOURCE=${BASH_SOURCE[0]}
while [ -L "$SOURCE" ]; do
  SOURCE_DIR=$(cd -P "$(dirname "$SOURCE")" && pwd)
  SOURCE=$(readlink "$SOURCE")
  case "$SOURCE" in /*) ;; *) SOURCE="$SOURCE_DIR/$SOURCE" ;; esac
done
SCRIPT_DIR=$(cd -P "$(dirname "$SOURCE")" && pwd)
TARGET_DIR=""
OUTPUT_DIR=""
PROVIDER=""

usage() {
  echo "usage: provider-worker-sandbox.sh --target-dir DIR --output-dir DIR --provider claude|codex -- command [args...]" >&2
}

account_home() {
  if command -v dscl >/dev/null 2>&1; then
    dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk 'NR == 1 { print $2; exit }'
    return
  fi
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$(id -u)" | awk -F: 'NR == 1 { print $6; exit }'
    return
  fi
  eval "printf '%s\\n' ~$(id -un)"
}

is_same_or_ancestor() {
  [ "$1" = "$2" ] || case "$2" in "$1"/*) return 0 ;; *) return 1 ;; esac
}

reject_account_root() {
  local path="$1" label="$2" protected
  [ "$path" != "/" ] || { echo "provider-worker-sandbox: $label must not be /" >&2; exit 2; }
  for protected in "$ACCOUNT_HOME" "$ACCOUNT_HOME/.ssh" "$ACCOUNT_HOME/.config/gh" "$ACCOUNT_HOME/.git-credentials" "$ACCOUNT_HOME/.netrc" "$ACCOUNT_HOME/.claude" "$ACCOUNT_HOME/.codex" "$ACCOUNT_HOME/.aws" "$ACCOUNT_HOME/.gnupg" "$ACCOUNT_HOME/.docker" "$ACCOUNT_HOME/.npmrc" "$ACCOUNT_HOME/Library/Keychains" "$ACCOUNT_HOME/Library/Application Support/gh"; do
    if is_same_or_ancestor "$path" "$protected"; then
      echo "provider-worker-sandbox: $label must not contain the account home or a credential path" >&2
      exit 2
    fi
  done
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target-dir) [ $# -ge 2 ] || { usage; exit 2; }; TARGET_DIR="$2"; shift 2 ;;
    --output-dir) [ $# -ge 2 ] || { usage; exit 2; }; OUTPUT_DIR="$2"; shift 2 ;;
    --provider) [ $# -ge 2 ] || { usage; exit 2; }; PROVIDER="$2"; shift 2 ;;
    --) shift; break ;;
    *) usage; exit 2 ;;
  esac
done

[ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ] || { echo "provider-worker-sandbox: target directory is required" >&2; exit 2; }
[ -n "$OUTPUT_DIR" ] && [ -d "$OUTPUT_DIR" ] || { echo "provider-worker-sandbox: output directory is required" >&2; exit 2; }
case "$PROVIDER" in claude|codex) ;; *) echo "provider-worker-sandbox: provider must be claude or codex" >&2; exit 2 ;; esac
[ $# -gt 0 ] || { echo "provider-worker-sandbox: wrapped command is required" >&2; exit 2; }
[ "${BS_GOVERNED_PROVIDER_SNAPSHOT:-}" = "1" ] || { echo "provider-worker-sandbox: governed detached-worktree invocation is required" >&2; exit 78; }

TARGET_DIR=$(cd -P "$TARGET_DIR" && pwd)
OUTPUT_DIR=$(cd -P "$OUTPUT_DIR" && pwd)
RUNTIME_DIR=$(cd -P "$SCRIPT_DIR/../node_modules" 2>/dev/null && pwd) \
  || { echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2; exit 74; }
SAFE_PATH='/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin'
NODE_BIN=$(command -v node 2>/dev/null) \
  || { echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2; exit 74; }
ACCOUNT_HOME=$(account_home)
[ -n "$ACCOUNT_HOME" ] && [ -d "$ACCOUNT_HOME" ] || { echo "provider-worker-sandbox: cannot resolve account home" >&2; exit 74; }
ACCOUNT_HOME=$(cd -P "$ACCOUNT_HOME" && pwd)
reject_account_root "$TARGET_DIR" "target directory"
reject_account_root "$OUTPUT_DIR" "output directory"
case "$NODE_BIN" in
  /*) ;;
  *) echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2; exit 74 ;;
esac
if is_same_or_ancestor "$TARGET_DIR" "$NODE_BIN" || is_same_or_ancestor "$OUTPUT_DIR" "$NODE_BIN"; then
  echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2
  exit 74
fi

GIT_DIR=$(git -C "$TARGET_DIR" rev-parse --path-format=absolute --git-dir 2>/dev/null) || { echo "provider-worker-sandbox: governed target must be a Git worktree" >&2; exit 78; }
GIT_COMMON_DIR=$(git -C "$TARGET_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 78
[ "$(git -C "$TARGET_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)" = "" ] || { echo "provider-worker-sandbox: governed target must have detached HEAD" >&2; exit 78; }
[ "$GIT_DIR" != "$GIT_COMMON_DIR" ] || { echo "provider-worker-sandbox: governed target must be a linked worktree" >&2; exit 78; }
TARGET_HEAD=$(git -C "$TARGET_DIR" rev-parse HEAD) || exit 78
GOVERNED_RECEIPT="$GIT_DIR/buildproven-provider-sandbox.json"
jq -e --arg head "$TARGET_HEAD" \
  --arg output "$OUTPUT_DIR" \
  '.schemaVersion == 1 and .targetHead == $head and .outputDir == $output' "$GOVERNED_RECEIPT" >/dev/null 2>&1 \
  || { echo "provider-worker-sandbox: governed snapshot receipt is missing or mismatched" >&2; exit 78; }
[ -z "$(git -C "$TARGET_DIR" status --porcelain=v1 --untracked-files=all)" ] \
  || { echo "provider-worker-sandbox: governed target must be clean" >&2; exit 78; }
[ -z "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || { echo "provider-worker-sandbox: governed output directory must be empty" >&2; exit 78; }
for protected in "$GIT_DIR" "$GIT_COMMON_DIR" "$SCRIPT_DIR" "$RUNTIME_DIR"; do
  if is_same_or_ancestor "$TARGET_DIR" "$protected" || is_same_or_ancestor "$protected" "$TARGET_DIR" || is_same_or_ancestor "$OUTPUT_DIR" "$protected" || is_same_or_ancestor "$protected" "$OUTPUT_DIR"; then
    echo "provider-worker-sandbox: target or output overlaps controller metadata" >&2
    exit 78
  fi
done
[ "$TARGET_DIR" != "$OUTPUT_DIR" ] || { echo "provider-worker-sandbox: output directory must differ from target" >&2; exit 78; }

SRT_SOURCE="$SCRIPT_DIR/../node_modules/.bin/srt"
while [ -L "$SRT_SOURCE" ]; do
  SRT_SOURCE_DIR=$(cd -P "$(dirname "$SRT_SOURCE")" && pwd)
  SRT_SOURCE=$(readlink "$SRT_SOURCE")
  case "$SRT_SOURCE" in /*) ;; *) SRT_SOURCE="$SRT_SOURCE_DIR/$SRT_SOURCE" ;; esac
done
SRT_BIN=$(cd -P "$(dirname "$SRT_SOURCE")" 2>/dev/null && pwd)/$(basename "$SRT_SOURCE")
[ -x "$SRT_BIN" ] && is_same_or_ancestor "$RUNTIME_DIR" "$SRT_BIN" \
  || { echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2; exit 74; }

CONTROL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/provider-sandbox.XXXXXX") || exit 2
CONTROL_DIR=$(cd -P "$CONTROL_DIR" && pwd)
SETTINGS="$CONTROL_DIR/settings.json"
SENTINEL="$CONTROL_DIR/sentinel"
POSITIVE_CONTROL="$CONTROL_DIR/allowed"
OUTSIDE_CONTROL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/provider-sandbox-outside.XXXXXX") || exit 2
OUTSIDE_CONTROL_DIR=$(cd -P "$OUTSIDE_CONTROL_DIR" && pwd)
OUTSIDE_SENTINEL="$OUTSIDE_CONTROL_DIR/sentinel"
cleanup() { rm -f "$SETTINGS" "$SENTINEL" "$POSITIVE_CONTROL" "$OUTSIDE_SENTINEL"; rmdir "$CONTROL_DIR" "$OUTSIDE_CONTROL_DIR" 2>/dev/null || true; }
trap cleanup EXIT
printf '%s\n' 'sandbox canary' > "$SENTINEL"
printf '%s\n' 'sandbox outside' > "$OUTSIDE_SENTINEL"
printf '%s\n' 'sandbox allowed' > "$POSITIVE_CONTROL"

case "$PROVIDER" in
  claude) NETWORK_DOMAINS='["*.anthropic.com"]' ;;
  codex) NETWORK_DOMAINS='["api.openai.com","*.openai.com"]' ;;
esac

GIT_DENY=$(find "$TARGET_DIR" -name .git -prune -print0 | python3 -c 'import json, sys; print(json.dumps([item.decode() for item in sys.stdin.buffer.read().split(b"\0") if item]))')
HOOKS_PATH=$(git -C "$TARGET_DIR" config --get core.hooksPath 2>/dev/null || true)
if [ -n "$HOOKS_PATH" ]; then
  HOOKS_DENY=$(python3 - "$TARGET_DIR" "$HOOKS_PATH" <<'PY'
import json
import os
import sys

target, hooks = sys.argv[1:]
resolved = hooks if os.path.isabs(hooks) else os.path.normpath(os.path.join(target, hooks))
denied = [resolved]
# Husky configures core.hooksPath to .husky/_ but its dispatcher executes
# siblings in .husky. Deny the complete hook root, not only that shim path.
if os.path.basename(resolved) == "_":
    denied.append(os.path.dirname(resolved))
print(json.dumps(denied))
PY
)
else
  HOOKS_DENY='[]'
fi

jq -n \
  --arg home "$ACCOUNT_HOME" \
  --arg target "$TARGET_DIR" \
  --arg output "$OUTPUT_DIR" \
  --arg scripts "$SCRIPT_DIR" \
  --arg runtime "$RUNTIME_DIR" \
  --arg control "$CONTROL_DIR" \
  --arg sentinel "$SENTINEL" \
  --argjson gitDeny "$GIT_DENY" \
  --argjson hooksDeny "$HOOKS_DENY" \
  --argjson domains "$NETWORK_DOMAINS" \
  '{filesystem:{denyRead:["/",$home,$home+"/.ssh",$home+"/.config/gh",$home+"/.git-credentials",$home+"/.netrc",$home+"/.claude",$home+"/.codex",$home+"/Library/Application Support/gh",$sentinel],allowRead:[$target,$output,$scripts,$runtime,$control,"/usr","/System","/Library","/opt/homebrew","/private/var/select",$home+"/.local/bin",$home+"/.local/share/claude",$home+"/.local/share/codex"],allowWrite:[$target,$output],denyWrite:(["/tmp/claude","/private/tmp/claude",$home+"/.claude/debug",$target+"/node_modules/.bin"] + $gitDeny + $hooksDeny)},network:{allowedDomains:$domains,deniedDomains:[]}}' \
  > "$SETTINGS"

# A positive and a negative probe prove that the runtime can execute under the
# same minimal environment and specifically enforces this denied path.
if [ "$(env -i "PATH=$SAFE_PATH" "HOME=$ACCOUNT_HOME" 'TERM=dumb' "$NODE_BIN" "$SRT_BIN" --settings "$SETTINGS" -- /bin/cat "$POSITIVE_CONTROL" 2>/dev/null)" != 'sandbox allowed' ]; then
  echo "provider-worker-sandbox: positive sandbox probe failed" >&2
  exit 78
fi
set +e
DENY_ERROR=$(env -i "PATH=$SAFE_PATH" "HOME=$ACCOUNT_HOME" 'TERM=dumb' "$NODE_BIN" "$SRT_BIN" --settings "$SETTINGS" -- /bin/cat "$SENTINEL" 2>&1)
DENY_STATUS=$?
set -e
if [ "$DENY_STATUS" -eq 0 ] || ! printf '%s' "$DENY_ERROR" | grep -q 'Operation not permitted'; then
  echo "provider-worker-sandbox: denied-read canary was not enforced" >&2
  exit 78
fi
set +e
OUTSIDE_ERROR=$(env -i "PATH=$SAFE_PATH" "HOME=$ACCOUNT_HOME" 'TERM=dumb' "$NODE_BIN" "$SRT_BIN" --settings "$SETTINGS" -- /bin/cat "$OUTSIDE_SENTINEL" 2>&1)
OUTSIDE_STATUS=$?
set -e
if [ "$OUTSIDE_STATUS" -eq 0 ] || ! printf '%s' "$OUTSIDE_ERROR" | grep -q 'Operation not permitted'; then
  echo "provider-worker-sandbox: root deny probe was not enforced" >&2
  exit 78
fi

(
  cd "$TARGET_DIR"
  env -i \
    "PATH=$SAFE_PATH" \
    "HOME=$ACCOUNT_HOME" \
    'TERM=dumb' \
    "$NODE_BIN" "$SRT_BIN" --settings "$SETTINGS" -- "$@"
)
