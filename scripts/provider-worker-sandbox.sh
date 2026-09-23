#!/usr/bin/env bash
# Run one provider worker with an explicit environment and OS sandbox.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TARGET_DIR=""
OUTPUT_DIR=""
PROVIDER=""

usage() {
  echo "usage: provider-worker-sandbox.sh --target-dir DIR --output-dir DIR --provider claude|codex -- command [args...]" >&2
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

SRT_BIN="${BS_PROVIDER_SANDBOX_BIN:-$SCRIPT_DIR/../node_modules/.bin/srt}"
[ -x "$SRT_BIN" ] || { echo "provider-worker-sandbox: Sandbox Runtime is unavailable" >&2; exit 74; }

SANDBOX_HOME="${HOME:?provider-worker-sandbox: HOME is required}"
RUNTIME_DIR=$(cd "$SCRIPT_DIR/../node_modules" && pwd)
SETTINGS=$(mktemp "$OUTPUT_DIR/.provider-sandbox.XXXXXX.json") || exit 2
SENTINEL=$(mktemp "$OUTPUT_DIR/.provider-sandbox-sentinel.XXXXXX") || { rm -f "$SETTINGS"; exit 2; }
cleanup() { rm -f "$SETTINGS" "$SENTINEL"; }
trap cleanup EXIT
printf '%s\n' 'sandbox canary' > "$SENTINEL"

case "$PROVIDER" in
  claude) NETWORK_DOMAINS='["*.anthropic.com"]' ;;
  codex) NETWORK_DOMAINS='["api.openai.com","*.openai.com"]' ;;
esac

jq -n \
  --arg home "$SANDBOX_HOME" \
  --arg target "$TARGET_DIR" \
  --arg output "$OUTPUT_DIR" \
  --arg scripts "$SCRIPT_DIR" \
  --arg runtime "$RUNTIME_DIR" \
  --arg sentinel "$SENTINEL" \
  --argjson domains "$NETWORK_DOMAINS" \
  '{filesystem:{denyRead:[$home,$home+"/.ssh",$home+"/.config/gh",$home+"/.git-credentials",$home+"/.netrc",$home+"/Library/Application Support/gh",$sentinel],allowRead:[$target,$output,$scripts,$runtime,"/usr","/System","/Library","/opt/homebrew",$home+"/.claude",$home+"/.codex",$home+"/.local/bin",$home+"/.local/share/claude",$home+"/.local/share/codex"],allowWrite:[$target,$output],denyWrite:[]},network:{allowedDomains:$domains,deniedDomains:[]}}' \
  > "$SETTINGS"

# A passed canary is proof that the configured runtime is enforcing its most
# specific denied path; a missing or permissive runtime never launches work.
if "$SRT_BIN" --settings "$SETTINGS" /bin/cat "$SENTINEL" >/dev/null 2>&1; then
  echo "provider-worker-sandbox: denied-read canary unexpectedly succeeded" >&2
  exit 78
fi

env -i \
  "PATH=$PATH" \
  "HOME=$SANDBOX_HOME" \
  "TERM=${TERM:-dumb}" \
  "$SRT_BIN" --settings "$SETTINGS" "$@"
