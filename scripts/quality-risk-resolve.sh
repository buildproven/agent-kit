#!/usr/bin/env bash
# Resolve risk into the authoritative invocation manifest.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-risk-resolve: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    *) echo "quality-risk-resolve: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || { echo "quality-risk-resolve: --manifest is required" >&2; exit 1; }
source "$SCRIPT_DIR/quality-repo-lease-pin.sh" || exit 1
quality_pin_repository_lease "$MANIFEST" || exit 1

bash "$SCRIPT_DIR/quality-load-root.sh" --manifest "$MANIFEST" >/dev/null || exit 1
field() { node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" "$1"; }
GIT_ROOT="$(field repo.realpath)"
if [ "$(field risk.resolved)" = true ]; then
  echo "🧭 Risk: preserving persisted invocation contract for resumed HEAD $(field revisions.currentHead)"
  exit 0
fi
LEVEL="$(field risk.level)"
[ -n "$LEVEL" ] || LEVEL="$(field options.level)"
RESOLVED_BASE="$(field revisions.baseRef)"
GATE_COUNT="$(field requiredGates | jq 'length')"
GATE_TIMEOUTS_JSON="$(field requiredGates | jq -c 'map(select(.timeoutSeconds != null) | {key: .name, value: .timeoutSeconds}) | from_entries')"
cd "$GIT_ROOT" || exit 1

case "$LEVEL" in
  auto) MINIMUM_RISK=0 ;;
  low) MINIMUM_RISK=0 ;;
  medium) MINIMUM_RISK=20 ;;
  high) MINIMUM_RISK=50 ;;
  critical) MINIMUM_RISK=75 ;;
  95) MINIMUM_RISK=50 ;;
  98) MINIMUM_RISK=75 ;;
  *)
    echo "quality-risk-resolve: invalid requested level '$LEVEL'" >&2
    exit 1
    ;;
esac

PLAN_JSON="$(node "$SCRIPT_DIR/quality-runtime-plan.js" \
  --base "$RESOLVED_BASE" --minimum-risk "$MINIMUM_RISK" \
  --gate-count "$GATE_COUNT" --gate-timeouts-json "$GATE_TIMEOUTS_JSON")" || exit 1
PLAN_GATE_COUNT="$(printf '%s' "$PLAN_JSON" | jq -er '.gateCount | numbers')" || {
  echo "quality-risk-resolve: runtime plan is missing numeric gateCount" >&2
  exit 1
}
PLAN_GATE_RESERVE_SECONDS="$(printf '%s' "$PLAN_JSON" | jq -er '.gateReserveSeconds | numbers')" || {
  echo "quality-risk-resolve: runtime plan is missing numeric gateReserveSeconds" >&2
  exit 1
}
RISK_SCORE="$(printf '%s' "$PLAN_JSON" | jq -r '.riskScore')"
TIER="$(printf '%s' "$PLAN_JSON" | jq -r '.tier')"
AGENT_TARGET="$(printf '%s' "$PLAN_JSON" | jq -r '.agents')"
CODEX_DEPTH="$(printf '%s' "$PLAN_JSON" | jq -r '.reviewDepth')"
CODEX_ROUNDS="$(printf '%s' "$PLAN_JSON" | jq -r '.reviewPasses')"
NATURE="$(printf '%s' "$PLAN_JSON" | jq -r '.changeNature')"
TASK_TYPE="$(printf '%s' "$PLAN_JSON" | jq -r '.taskType')"

node "$SCRIPT_DIR/quality-invocation.js" risk "$MANIFEST" \
  --tier "$TIER" \
  --merge-authority "$(printf '%s' "$PLAN_JSON" | jq -r '.mergeAuthority')" \
  --merge-authority-base-sha "$(printf '%s' "$PLAN_JSON" | jq -r '.mergeAuthorityBaseSha')" \
  --protected-nonstrict-ref-cas "$(printf '%s' "$PLAN_JSON" | jq -r '.protectedNonstrictRefCas')" \
  --protected-nonstrict-ref-cas-base-sha "$(printf '%s' "$PLAN_JSON" | jq -r '.protectedNonstrictRefCasBaseSha')" \
  --task-type "$TASK_TYPE" \
  --score "$RISK_SCORE" \
  --agents "$AGENT_TARGET" \
  --codex-depth "$CODEX_DEPTH" \
  --codex-rounds "$CODEX_ROUNDS" \
  --workload "$(printf '%s' "$PLAN_JSON" | jq -r '.workload')" \
  --workload-units "$(printf '%s' "$PLAN_JSON" | jq -r '.workloadUnits')" \
  --diff-files "$(printf '%s' "$PLAN_JSON" | jq -r '.diffStats.files')" \
  --diff-lines "$(printf '%s' "$PLAN_JSON" | jq -r '.diffStats.lines')" \
  --campaign-seconds "$(printf '%s' "$PLAN_JSON" | jq -r '.campaignSeconds')" \
  --review-seconds "$(printf '%s' "$PLAN_JSON" | jq -r '.reviewSeconds')" \
  --verification-seconds "$(printf '%s' "$PLAN_JSON" | jq -r '.verificationSeconds')" \
  --check-seconds "$(printf '%s' "$PLAN_JSON" | jq -r '.checkSeconds')" \
  --gate-count "$PLAN_GATE_COUNT" \
  --gate-reserve-seconds "$PLAN_GATE_RESERVE_SECONDS" \
  --gate-timeouts-json "$(printf '%s' "$PLAN_JSON" | jq -c '.gateTimeoutSeconds')" \
  --review-reserve-seconds "$(printf '%s' "$PLAN_JSON" | jq -r '.reviewReserveSeconds')" \
  --check-reserve-seconds "$(printf '%s' "$PLAN_JSON" | jq -r '.checkReserveSeconds')" \
  --level "$LEVEL" || exit 1

echo "🧭 Risk: ${RISK_SCORE}/100 (${TASK_TYPE}/${NATURE}), $(printf '%s' "$PLAN_JSON" | jq -r '"\(.workload): \(.diffStats.files) files/\(.diffStats.lines) lines"') → ${AGENT_TARGET} agents, Codex ${CODEX_DEPTH}×${CODEX_ROUNDS} [${TIER}], $(printf '%s' "$PLAN_JSON" | jq -r '.campaignSeconds')s workload plan"

# scored.reasons[] is otherwise silently dropped — every other reason is
# routine scoring detail, but these two mean the diff itself may be
# unreliable (measured against the wrong base, or not measured at all): a
# soft merge-base fallback that still produced a diff, or a collection
# failure severe enough that scoring fell back to 100/max-risk. The operator
# needs to see either even though the campaign proceeds in both cases (see
# risk-score.js merge-base and diff-collection-failure handling).
printf '%s' "$PLAN_JSON" | jq -r '.reasons[]? | select(startswith("merge-base HEAD") or startswith("diff collection failed"))' | while IFS= read -r reason; do
  echo "⚠️  quality-risk-resolve: $reason" >&2
done
