#!/usr/bin/env bash
# Run one provider worker with an explicit environment and OS sandbox.
set -euo pipefail

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

TARGET_DIR=$(cd -P "$TARGET_DIR" && pwd)
OUTPUT_DIR=$(cd -P "$OUTPUT_DIR" && pwd)
ACCOUNT_HOME=$(account_home)
[ -n "$ACCOUNT_HOME" ] && [ -d "$ACCOUNT_HOME" ] || { echo "provider-worker-sandbox: cannot resolve account home" >&2; exit 74; }
ACCOUNT_HOME=$(cd -P "$ACCOUNT_HOME" && pwd)
reject_account_root "$TARGET_DIR" "target directory"
reject_account_root "$OUTPUT_DIR" "output directory"

SRT_BIN="${BS_PROVIDER_SANDBOX_BIN:-$SCRIPT_DIR/../node_modules/.bin/srt}"
[ -x "$SRT_BIN" ] || { echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2; exit 74; }

RUNTIME_DIR=$(cd "$SCRIPT_DIR/../node_modules" && pwd)
CONTROL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/provider-sandbox.XXXXXX") || exit 2
SETTINGS="$CONTROL_DIR/settings.json"
SENTINEL="$CONTROL_DIR/sentinel"
cleanup() { rm -f "$SETTINGS" "$SENTINEL"; rmdir "$CONTROL_DIR" 2>/dev/null || true; }
trap cleanup EXIT
printf '%s\n' 'sandbox canary' > "$SENTINEL"

case "$PROVIDER" in
  claude) NETWORK_DOMAINS='["*.anthropic.com"]'; PROVIDER_HOME="$ACCOUNT_HOME/.claude" ;;
  codex) NETWORK_DOMAINS='["api.openai.com","*.openai.com"]'; PROVIDER_HOME="$ACCOUNT_HOME/.codex" ;;
esac

GIT_DENY=$(find "$TARGET_DIR" -name .git -prune -print0 | python3 -c 'import json, sys; print(json.dumps([item.decode() for item in sys.stdin.buffer.read().split(b"\0") if item]))')

jq -n \
  --arg home "$ACCOUNT_HOME" \
  --arg target "$TARGET_DIR" \
  --arg output "$OUTPUT_DIR" \
  --arg scripts "$SCRIPT_DIR" \
  --arg runtime "$RUNTIME_DIR" \
  --arg control "$CONTROL_DIR" \
  --arg sentinel "$SENTINEL" \
  --arg providerHome "$PROVIDER_HOME" \
  --argjson gitDeny "$GIT_DENY" \
  --argjson domains "$NETWORK_DOMAINS" \
  '{filesystem:{denyRead:["/",$home,$home+"/.ssh",$home+"/.config/gh",$home+"/.git-credentials",$home+"/.netrc",$home+"/Library/Application Support/gh",$sentinel],allowRead:[$target,$output,$scripts,$runtime,$control,"/usr","/System","/Library","/opt/homebrew","/private/var/select",$providerHome,$home+"/.local/bin",$home+"/.local/share/claude",$home+"/.local/share/codex"],allowWrite:[$target,$output],denyWrite:(["/tmp/claude","/private/tmp/claude",$home+"/.claude/debug"] + $gitDeny)},network:{allowedDomains:$domains,deniedDomains:[]}}' \
  > "$SETTINGS"

# A passed canary is proof that the configured runtime is enforcing its most
# specific denied path; a missing or permissive runtime never launches work.
if "$SRT_BIN" --settings "$SETTINGS" /bin/cat "$SENTINEL" >/dev/null 2>&1; then
  echo "provider-worker-sandbox: denied-read canary unexpectedly succeeded" >&2
  exit 78
fi

(
  cd "$TARGET_DIR"
  env -i \
    "PATH=$PATH" \
    "HOME=$ACCOUNT_HOME" \
    "TERM=${TERM:-dumb}" \
    "$SRT_BIN" --settings "$SETTINGS" "$@"
)
