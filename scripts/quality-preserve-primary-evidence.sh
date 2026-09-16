#!/usr/bin/env bash
set -euo pipefail

REVIEW_OUT=""
MODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --review-out)
      [ "$#" -ge 2 ] || {
        echo "quality-preserve-primary-evidence: --review-out requires a value" >&2
        exit 1
      }
      REVIEW_OUT="$2"
      shift 2
      ;;
    --mode)
      [ "$#" -ge 2 ] || {
        echo "quality-preserve-primary-evidence: --mode requires a value" >&2
        exit 1
      }
      MODE="$2"
      shift 2
      ;;
    *) echo "quality-preserve-primary-evidence: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

[ -n "$REVIEW_OUT" ] && [ -d "$REVIEW_OUT" ] || {
  echo "quality-preserve-primary-evidence: --review-out must name a directory" >&2
  exit 1
}
case "$MODE" in
  parser-inconclusive|evidence-absent) ;;
  *) echo "quality-preserve-primary-evidence: invalid --mode" >&2; exit 1 ;;
esac

FAILED_PRIMARY="$REVIEW_OUT/failed-primary"
mkdir -p "$FAILED_PRIMARY"

quarantine() {
  local evidence="$1" destination counter
  destination="$FAILED_PRIMARY/$(basename "$evidence")"
  counter=2
  while [ -e "$destination" ]; do
    destination="$FAILED_PRIMARY/$(basename "$evidence").$counter"
    counter=$((counter + 1))
  done
  mv "$evidence" "$destination"
}

# A multi-pass primary (e.g. Codex's or Gemini's 2-pass review) can complete
# one pass with real findings before a LATER pass fails for any reason —
# parser failure, exhaustion, timeout, unavailability. The completed pass's
# normalized result is authoritative regardless of why the later pass
# failed, so this preservation runs for both modes, not just
# parser-inconclusive, and for both providers. Names that cannot collide
# with a fallback run.
for evidence in \
  "$REVIEW_OUT"/codex-*.normalized.json \
  "$REVIEW_OUT"/gemini-*.normalized.json; do
  [ -e "$evidence" ] || continue
  preserve_pass="$(basename "$evidence" .normalized.json)"
  preserve_destination="$REVIEW_OUT/primary-$preserve_pass.result.json"
  if [ -e "$preserve_destination" ]; then
    # Re-entry into an attempt directory must not abort or create a second
    # authoritative result for the same pass. Retain the first immutable
    # result and quarantine the duplicate as diagnostic evidence.
    quarantine "$evidence"
    continue
  fi
  mv "$evidence" "$preserve_destination"
done

# Every rendered or partial findings file is diagnostic only. The normalized
# result preserved above (if any) carries completed-pass findings with exact
# severity; rendered text can contain partial, clean-sentinel, or
# marker-adjacent content and is never authoritative.
for evidence in "$REVIEW_OUT"/*.findings.txt; do
  [ -e "$evidence" ] || continue
  quarantine "$evidence"
done

for evidence in \
  "$REVIEW_OUT"/*.stderr \
  "$REVIEW_OUT"/codex-*.json \
  "$REVIEW_OUT"/codex-*.progress \
  "$REVIEW_OUT"/codex-*.prompt \
  "$REVIEW_OUT"/gemini-*.json \
  "$REVIEW_OUT"/gemini-*.prompt; do
  [ -e "$evidence" ] || continue
  quarantine "$evidence"
done
