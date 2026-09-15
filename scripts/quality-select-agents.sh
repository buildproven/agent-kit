#!/usr/bin/env bash
# Select the review panel from the manifest's resolved risk contract.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    *) echo "quality-select-agents: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || { echo "quality-select-agents: --manifest is required" >&2; exit 1; }
source "$SCRIPT_DIR/quality-repo-lease-pin.sh" || exit 1
quality_pin_repository_lease "$MANIFEST" || exit 1

bash "$SCRIPT_DIR/quality-load-root.sh" --manifest "$MANIFEST" >/dev/null || exit 1
field() { node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" "$1"; }
TIER="$(field risk.tier)"
AGENT_TARGET="$(field risk.agentTarget)"
[ -n "$TIER" ] && [ -n "$AGENT_TARGET" ] || {
  echo "quality-select-agents: risk state is unresolved; run quality-risk-resolve first" >&2
  exit 1
}

GIT_ROOT="$(field repo.realpath)"
BASE_SHA="$(field revisions.baseSha)"
HEAD_SHA="$(field revisions.currentHead)"
SELECTION_JSON="$(node "$SCRIPT_DIR/quality-agent-selection.js" \
  --tier "$TIER" --repo "$GIT_ROOT" --base "$BASE_SHA" --head "$HEAD_SHA")" || exit 1
DOMAIN="$(printf '%s' "$SELECTION_JSON" | jq -er '.domain')" || exit 1
RULE="$(printf '%s' "$SELECTION_JSON" | jq -er '.rule')" || exit 1
SELECTED_COUNT="$(printf '%s' "$SELECTION_JSON" | jq -er '.agents | length')" || exit 1
[ "$SELECTED_COUNT" -eq "$AGENT_TARGET" ] || {
  echo "quality-select-agents: selector produced $SELECTED_COUNT agents for persisted target $AGENT_TARGET" >&2
  exit 1
}
AGENTS=()
while IFS= read -r agent; do
  [ -n "$agent" ] && AGENTS+=("$agent")
done < <(printf '%s' "$SELECTION_JSON" | jq -r '.agents[]')

MERGE_AUTHORITY="$(field risk.mergeAuthority)"
# Older manifests lack the field and preserve their established manual
# governance behavior. New campaigns always persist one explicit authority.
[ -n "$MERGE_AUTHORITY" ] || MERGE_AUTHORITY=human-required
if [ "$TIER" = critical ] && [ "$MERGE_AUTHORITY" = autonomous ]; then
  echo "[quality] Critical tier: autonomous merge authority; running full critical review." >&2
fi

AGENT_ARGS=(--domain "$DOMAIN" --rule "$RULE" --)
if [ "${#AGENTS[@]}" -gt 0 ]; then
  AGENT_ARGS+=("${AGENTS[@]}")
fi
node "$SCRIPT_DIR/quality-invocation.js" agents "$MANIFEST" "${AGENT_ARGS[@]}" || exit 1
echo "[quality] Selected ${#AGENTS[@]} agents for tier=$TIER domain=$DOMAIN rule=$RULE"
