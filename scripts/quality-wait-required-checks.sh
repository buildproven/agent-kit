#!/usr/bin/env bash
# Wait for required checks to register, then hand off to gh's check watcher.
set -u

PR=""
INTERVAL=2
# Total seconds to wait for CI before giving up. Telemetry showed 55 of 953
# campaigns (6%) consuming 515 of 687 wall hours (75%) by waiting on CI that
# never completed -- one ran 71h with 228s of provider work. The wait is now
# bounded so a stuck or never-scheduled check fails the campaign loudly instead
# of hanging it. Override with --deadline or QUALITY_CI_WAIT_DEADLINE_SECONDS.
DEADLINE="${QUALITY_CI_WAIT_DEADLINE_SECONDS:-2700}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr) PR="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --deadline) DEADLINE="${2:-}"; shift 2 ;;
    *) echo "quality-wait-required-checks: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$PR" ] || {
  echo "quality-wait-required-checks: --pr is required" >&2
  exit 1
}
case "$INTERVAL" in
  ''|*[!0-9]*)
    echo "quality-wait-required-checks: --interval must be seconds" >&2
    exit 1
    ;;
esac
case "$DEADLINE" in
  ''|*[!0-9]*)
    echo "quality-wait-required-checks: --deadline must be seconds" >&2
    exit 1
    ;;
esac

STARTED_AT="$(date +%s)"

# Seconds left before the deadline, or empty when unbounded (--deadline 0).
remaining_seconds() {
  [ "$DEADLINE" -eq 0 ] && { printf '%s' ""; return 0; }
  REMAINING=$(( DEADLINE - ( $(date +%s) - STARTED_AT ) ))
  [ "$REMAINING" -lt 1 ] && REMAINING=0
  printf '%s' "$REMAINING"
}

expired() {
  LEFT="$(remaining_seconds)"
  [ -n "$LEFT" ] && [ "$LEFT" -eq 0 ]
}

give_up() {
  echo "quality-wait-required-checks: CI did not complete within ${DEADLINE}s ($1)." >&2
  echo "quality-wait-required-checks: treating this as a CI failure, not a pass." >&2
  exit 75
}

# Hand off to gh's watcher under the remaining budget. `timeout` is absent on a
# stock macOS PATH, so fall back to a background watch we can bound ourselves.
watch_bounded() {
  LEFT="$(remaining_seconds)"
  if [ -z "$LEFT" ]; then
    exec gh pr checks "$@" --watch --interval 10
  fi
  [ "$LEFT" -eq 0 ] && give_up "no time left to watch checks"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$LEFT" gh pr checks "$@" --watch --interval 10
    WATCH_RC=$?
    [ "$WATCH_RC" -eq 124 ] && give_up "watch exceeded the deadline"
    exit "$WATCH_RC"
  fi
  gh pr checks "$@" --watch --interval 10 &
  WATCH_PID=$!
  while kill -0 "$WATCH_PID" 2>/dev/null; do
    if expired; then
      kill "$WATCH_PID" 2>/dev/null
      wait "$WATCH_PID" 2>/dev/null
      give_up "watch exceeded the deadline"
    fi
    sleep 1
  done
  wait "$WATCH_PID"
  exit $?
}

while true; do
  OUTPUT="$(gh pr checks "$PR" --required 2>&1)"
  RC=$?
  if [ "$RC" -eq 0 ] || [ "$RC" -eq 8 ]; then
    watch_bounded "$PR" --required
  fi
  case "$OUTPUT" in
    "no checks reported"*)
      expired && give_up "required checks never registered"
      echo "[quality] required checks are not registered yet; retrying" >&2
      sleep "$INTERVAL"
      ;;
    "no required checks reported"*)
      # An explicitly unprotectable repository can still have CI even though
      # GitHub reports no branch-rule-required checks. Wait on every registered
      # check in that case; this preserves CI evidence instead of burning the
      # full timeout polling for a required-check set that cannot exist.
      ALL_OUTPUT="$(gh pr checks "$PR" 2>&1)"
      ALL_RC=$?
      case "$ALL_OUTPUT" in
        "no checks reported"*)
          expired && give_up "CI checks never registered"
          echo "[quality] CI checks are not registered yet; retrying" >&2
          sleep "$INTERVAL"
          ;;
        *)
          if [ "$ALL_RC" -eq 0 ] || [ "$ALL_RC" -eq 1 ] || [ "$ALL_RC" -eq 8 ]; then
            watch_bounded "$PR"
          fi
          [ -n "$ALL_OUTPUT" ] && printf '%s\n' "$ALL_OUTPUT" >&2
          exit "$ALL_RC"
          ;;
      esac
      ;;
    *)
      [ -n "$OUTPUT" ] && printf '%s\n' "$OUTPUT" >&2
      exit "$RC"
      ;;
  esac
done
