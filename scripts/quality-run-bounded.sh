#!/usr/bin/env bash
# Run one provider command in its own process group with a hard wall-clock cap.
set -u
TIMEOUT=""
GOVERNOR_FILE=""
CAP=""
RESERVE=0
CANCEL_FILE=""
while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --governor) GOVERNOR_FILE="$2"; shift 2 ;;
    --cap) CAP="$2"; shift 2 ;;
    --reserve) RESERVE="$2"; shift 2 ;;
    --cancel-file) CANCEL_FILE="$2"; shift 2 ;;
    --) break ;;
    *) break ;;
  esac
done
if [ -n "$GOVERNOR_FILE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  GOVERNOR="$SCRIPT_DIR/quality-run-governor.js"
  [ -f "$GOVERNOR" ] || {
    echo "quality-run-bounded: governor script missing" >&2
    exit 1
  }
  EFFECTIVE_CAP="${CAP:-${TIMEOUT:-2147483647}}"
  TIMEOUT="$(node "$GOVERNOR" remaining "$GOVERNOR_FILE" \
    --reserve "$RESERVE" --cap "$EFFECTIVE_CAP")"
  GOVERNOR_RC=$?
  case "$GOVERNOR_RC" in
    0) ;;
    1) exit 124 ;; # Valid governor, but no budget remains.
    *)
      echo "quality-run-bounded: governor state is unreadable or invalid" >&2
      exit "$GOVERNOR_RC"
      ;;
  esac
fi
[ -n "$TIMEOUT" ] && [ "${1:-}" = -- ] || { echo "usage: quality-run-bounded.sh --timeout <seconds> -- <command>" >&2; exit 1; }
shift
MARKER="$(mktemp "${TMPDIR:-/tmp}/quality-timeout.XXXXXX")"
rm -f "$MARKER"
TRACKED_PIDS_FILE="$(mktemp "${TMPDIR:-/tmp}/quality-provider-pids.XXXXXX")"
rm -f "$TRACKED_PIDS_FILE"
PROCESS_OWNER_ID="$(basename "$TRACKED_PIDS_FILE").$$"
set -m
CHILD_PID=""
TRACKER_PID=""
WATCHDOG_PID=""
process_start() {
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/[[:space:]]*$//' || true
}
process_group() {
  ps -o pgid= -p "$1" 2>/dev/null | tr -d '[:space:]' || true
}
process_tree_postorder() {
  local pid="$1" child
  # Snapshot descendants before signalling the process group. A native helper
  # can call setsid(2), and would otherwise survive a group kill then become
  # reparented before we can find it with pgrep -P.
  while IFS= read -r child; do
    [ -n "$child" ] || continue
    process_tree_postorder "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  printf '%s\n' "$pid"
}
record_snapshot() {
  local snapshot_pid snapshot_start
  while IFS= read -r snapshot_pid; do
    [ -n "$snapshot_pid" ] || continue
    snapshot_start="$(process_start "$snapshot_pid")"
    [ -n "$snapshot_start" ] || continue
    printf '%s\t%s\n' "$snapshot_pid" "$snapshot_start"
  done
}
snapshot_provider_tree() {
  local snapshot
  snapshot="$(process_tree_postorder "$CHILD_PID")"
  record_snapshot <<EOF >> "$TRACKED_PIDS_FILE"
$snapshot
EOF
}
track_provider_tree() {
  # A provider can exit while a native helper it spawned is still alive. Once
  # the leader exits that helper is reparented, so a one-shot pgrep at cleanup
  # cannot find it. Snapshot the tree while the leader is alive and retain the
  # exact PIDs for the bounded cleanup path.
  local last_snapshot="" snapshot
  while kill -0 "$CHILD_PID" 2>/dev/null; do
    snapshot="$(process_tree_postorder "$CHILD_PID")"
    # Provider trees are stable between forks; avoid writing the same snapshot
    # repeatedly while still retaining each observed PID before the leader can
    # exit and reparent a native helper. A quarter-second cadence bounds the
    # race without spawning thousands of pgrep/sleep processes per review.
    if [ "$snapshot" != "$last_snapshot" ]; then
      record_snapshot <<EOF >> "$TRACKED_PIDS_FILE"
$snapshot
EOF
      last_snapshot="$snapshot"
    fi
    sleep 0.25
  done
  snapshot="$(process_tree_postorder "$CHILD_PID")"
  [ "$snapshot" = "$last_snapshot" ] || {
    record_snapshot <<EOF >> "$TRACKED_PIDS_FILE"
$snapshot
EOF
  }
}
owned_provider_processes() {
  local owned environment_file pid
  # Process-tree polling cannot close the fork -> setsid -> reparent race. The
  # provider receives a unique, non-secret ownership marker that descendants
  # retain across fork, exec, setsid, and reparenting. Search without printing
  # process environments, then combine these PIDs with the sampled tree.
  if [ "$(uname -s)" = Linux ] && [ -d /proc ]; then
    owned=""
    for environment_file in /proc/[0-9]*/environ; do
      [ -r "$environment_file" ] || continue
      tr '\0' '\n' < "$environment_file" 2>/dev/null |
        grep -Fqx "BS_QUALITY_PROCESS_OWNER=$PROCESS_OWNER_ID" || continue
      pid="${environment_file#/proc/}"
      pid="${pid%/environ}"
      owned="${owned}${owned:+$'\n'}${pid}"
    done
  else
    owned="$(ps eww -axo pid=,command= 2>/dev/null |
      awk -v marker="BS_QUALITY_PROCESS_OWNER=$PROCESS_OWNER_ID" \
        'index($0, marker) { print $1 }')"
  fi
  record_snapshot <<EOF
$owned
EOF
}
signal_processes() {
  local signal="$1" processes="$2" pid recorded_start current_start
  while IFS=$'\t' read -r pid recorded_start; do
    [ -n "$pid" ] || continue
    current_start="$(process_start "$pid")"
    [ -n "$current_start" ] && [ "$current_start" = "$recorded_start" ] || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done <<EOF
$processes
EOF
}
unique_process_records() {
  awk -F '\t' 'NF >= 2 && !seen[$1]++'
}
stop_tracker() {
  [ -n "$TRACKER_PID" ] || return 0
  kill -TERM "$TRACKER_PID" 2>/dev/null || true
  wait "$TRACKER_PID" 2>/dev/null || true
}
terminate_provider() {
  local targets tracked current_snapshot current_targets owned_targets remaining_targets
  local child_start self_group child_group
  [ -n "$CHILD_PID" ] || return 0
  tracked="$(cat "$TRACKED_PIDS_FILE" 2>/dev/null || true)"
  current_snapshot="$(process_tree_postorder "$CHILD_PID")"
  current_targets="$(record_snapshot <<EOF
$current_snapshot
EOF
)"
  owned_targets="$(owned_provider_processes)"
  targets="$(unique_process_records <<EOF
$current_targets
$owned_targets
$tracked
EOF
)"
  child_start="$(process_start "$CHILD_PID")"
  self_group="$(process_group "$$")"
  child_group="$(process_group "$CHILD_PID")"
  # Signal the intact group as one unit. A waiting shell can resume between
  # separate child/parent signals and run one more command before its TERM.
  if [ -n "$child_start" ] &&
     [ "$(process_start "$CHILD_PID")" = "$child_start" ] &&
     [ -n "$child_group" ] && [ "$child_group" != "$self_group" ]; then
    kill -TERM "-$child_group" 2>/dev/null || true
  fi
  # Descendants first, then the provider leader. This ordering preserves the
  # PID list long enough to kill escaped session leaders as well.
  signal_processes TERM "$targets"
  sleep 1
  remaining_targets="$(owned_provider_processes)"
  targets="$(unique_process_records <<EOF
$remaining_targets
$targets
EOF
)"
  signal_processes KILL "$targets"
}
set -m
watchdog() {
  local sleeper=""
  stop_watchdog() {
    [ -z "$sleeper" ] || kill -TERM "$sleeper" 2>/dev/null || true
    [ -z "$sleeper" ] || wait "$sleeper" 2>/dev/null || true
    exit 0
  }
  # A cancelled wrapper can die before its signal trap completes. Its
  # watchdog receives HUP as the orphaned job and must own provider cleanup.
  trap 'terminate_provider; exit 0' HUP
  trap stop_watchdog INT TERM
  local waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if [ -n "$CANCEL_FILE" ] && [ -f "$CANCEL_FILE" ]; then
      terminate_provider
      exit 0
    fi
    sleep 1 &
    sleeper=$!
    wait "$sleeper" || exit 0
    sleeper=""
    waited=$((waited + 1))
  done
  : > "$MARKER"
  terminate_provider
}
stop_watchdog() {
  local targets
  [ -n "$WATCHDOG_PID" ] || return 0
  # The timeout marker is written before terminate_provider's one-second TERM
  # grace period. Once it exists, the watchdog owns escalation; stopping it
  # here would cancel the required SIGKILL after the leader exits and leave a
  # session-escaped, TERM-ignoring helper running.
  if [ -f "$MARKER" ]; then
    wait "$WATCHDOG_PID" 2>/dev/null || true
    return
  fi
  # The watchdog is a shell with a sleeping child. Killing only the shell
  # queues its trap until that sleep ends on macOS Bash, turning every fast
  # command into a full timeout wait. Terminate its descendants first.
  targets="$(process_tree_postorder "$WATCHDOG_PID")"
  targets="$(record_snapshot <<EOF
$targets
EOF
)"
  signal_processes TERM "$targets"
  wait "$WATCHDOG_PID" 2>/dev/null || true
}
cleanup_provider() {
  local status="${1:-130}"
  trap - INT TERM HUP EXIT
  stop_tracker
  terminate_provider
  stop_watchdog
  [ -z "$CHILD_PID" ] || wait "$CHILD_PID" 2>/dev/null || true
  rm -f "$MARKER"
  rm -f "$TRACKED_PIDS_FILE"
  exit "$status"
}
trap 'cleanup_provider 130' INT
trap 'cleanup_provider 143' TERM
trap 'cleanup_provider 129' HUP
trap 'cleanup_provider $?' EXIT
set -m
BS_QUALITY_PROCESS_OWNER="$PROCESS_OWNER_ID" "$@" &
CHILD_PID=$!
set +m
# The tracker runs asynchronously so it can follow later forks, but its first
# snapshot must happen before the provider can exit and reparent an escaped
# helper. Under CI load a background shell can otherwise lose that race.
snapshot_provider_tree
track_provider_tree &
TRACKER_PID=$!
set -m
watchdog &
WATCHDOG_PID=$!
set +m
wait "$CHILD_PID"; RC=$?
stop_tracker
stop_watchdog
terminate_provider
trap - INT TERM HUP EXIT
rm -f "$TRACKED_PIDS_FILE"
if [ -f "$MARKER" ]; then rm -f "$MARKER"; exit 124; fi
rm -f "$MARKER"
exit "$RC"
