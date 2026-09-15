#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=provider-policy.sh
source "$SCRIPT_DIR/provider-policy.sh"

PRIMARY=""
FALLBACK=""
CONFIG="${BS_PROVIDER_CONFIG:-$(bs_provider_default_config)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --primary)
      [ "$#" -ge 2 ] || {
        echo "provider-config: --primary requires a value" >&2
        exit 1
      }
      PRIMARY="$2"
      shift 2
      ;;
    --fallback)
      [ "$#" -ge 2 ] || {
        echo "provider-config: --fallback requires a value" >&2
        exit 1
      }
      FALLBACK="$2"
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || {
        echo "provider-config: --config requires a value" >&2
        exit 1
      }
      CONFIG="$2"
      shift 2
      ;;
    *) echo "usage: provider-config.sh --primary auto|codex|claude --fallback none|codex|claude [--config path]" >&2; exit 1 ;;
  esac
done

bs_provider_validate "$PRIMARY" "$FALLBACK" || {
  echo "invalid provider policy: primary=$PRIMARY fallback=$FALLBACK" >&2
  exit 1
}

mkdir -p "$(dirname "$CONFIG")"
TMP_CONFIG=$(mktemp "$(dirname "$CONFIG")/.agent-providers.XXXXXX")
printf '{\n  "primary": "%s",\n  "fallback": "%s"\n}\n' "$PRIMARY" "$FALLBACK" > "$TMP_CONFIG"
mv "$TMP_CONFIG" "$CONFIG"
echo "agent providers: primary=$PRIMARY fallback=$FALLBACK ($CONFIG)"
