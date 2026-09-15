#!/usr/bin/env bash
# overnight-loop.sh — bounded, project-scoped Linear → Ralph engineering loop.
set -uo pipefail

if [ -n "${OVERNIGHT_LOOP_ENV_FILE:-}" ]; then
  [ -f "$OVERNIGHT_LOOP_ENV_FILE" ] || { echo "OVERNIGHT_LOOP_ENV_FILE does not exist" >&2; exit 2; }
  set -a
  # shellcheck source=/dev/null
  source "$OVERNIGHT_LOOP_ENV_FILE" || { echo "OVERNIGHT_LOOP_ENV_FILE failed to source cleanly" >&2; exit 2; }
  set +a
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CCUSAGE_BIN="${CCUSAGE_BIN:-ccusage}"
AUTONOMOUS_RUNTIME="$SCRIPT_DIR/autonomous-loop-runtime.js"
CLAUDE_USAGE_COMMAND="${CLAUDE_USAGE_COMMAND:-}"
CURL_BIN="${CURL_BIN:-curl}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
LINEAR_API_URL="${LINEAR_API_URL:-https://api.linear.app/graphql}"
RESET_BUFFER_SECONDS="${RESET_BUFFER_SECONDS:-120}"
FALLBACK_SLEEP_SECONDS="${FALLBACK_SLEEP_SECONDS:-16200}"

MAX_ITEMS=8
MAX_HOURS=8
TARGET_DIR="$(pwd)"
LINEAR_PROJECT=""
DRY_RUN=0
PROVIDER=""
PROVIDER_FALLBACK=""

die() { echo "$*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --max-items) [ $# -ge 2 ] || die "--max-items requires a value"; MAX_ITEMS="$2"; shift 2 ;;
    --max-hours) [ $# -ge 2 ] || die "--max-hours requires a value"; MAX_HOURS="$2"; shift 2 ;;
    --target-dir) [ $# -ge 2 ] || die "--target-dir requires a value"; TARGET_DIR="$2"; shift 2 ;;
    --linear-project) [ $# -ge 2 ] || die "--linear-project requires a value"; LINEAR_PROJECT="$2"; shift 2 ;;
    --provider) [ $# -ge 2 ] || die "--provider requires a value"; PROVIDER="$2"; shift 2 ;;
    --fallback) [ $# -ge 2 ] || die "--fallback requires a value"; PROVIDER_FALLBACK="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "$MAX_ITEMS" =~ ^[1-9][0-9]*$ ]] || die "--max-items must be a positive integer (got '$MAX_ITEMS')"
[[ "$MAX_HOURS" =~ ^[1-9][0-9]*$ ]] || die "--max-hours must be a positive integer (got '$MAX_HOURS')"
[ -n "$LINEAR_PROJECT" ] || die "--linear-project is required (prevents cross-repo backlog execution)"

TARGET_STATE_ID=$("$PYTHON_BIN" -c 'import hashlib,os,sys; print(hashlib.sha256(os.path.realpath(sys.argv[1]).encode()).hexdigest()[:16])' "$TARGET_DIR") \
  || die "cannot derive target state identity"
STATE_HOME="${XDG_STATE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.local/state}"
LOG_DIR="${OVERNIGHT_LOOP_STATE_DIR:-$STATE_HOME/buildproven/overnight-loop/$TARGET_STATE_ID}"
LOG_FILE="$LOG_DIR/overnight-loop-$(date +%Y-%m-%d).log"
STATUS_FILE="$LOG_DIR/overnight-loop-status.json"
RUN_WITH_DEADLINE="$SCRIPT_DIR/run-with-deadline.py"
mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

START_EPOCH=$(date +%s)
DEADLINE_EPOCH=$(( START_EPOCH + MAX_HOURS * 3600 ))
items_done=0
attempts=0
current_issue=""
terminal_reason="starting"
exit_status=1

write_status() {
  STATUS_FILE="$STATUS_FILE" RUN_STARTED="$START_EPOCH" RUN_DEADLINE="$DEADLINE_EPOCH" \
    RUN_TARGET="$TARGET_DIR" RUN_PROJECT="$LINEAR_PROJECT" RUN_ISSUE="$current_issue" \
    RUN_ITEMS="$items_done" RUN_ATTEMPTS="$attempts" RUN_REASON="$terminal_reason" \
    RUN_EXIT="$exit_status" "$PYTHON_BIN" - <<'PY'
import json, os, tempfile, time
path = os.environ["STATUS_FILE"]
payload = {
    "startedAtEpoch": int(os.environ["RUN_STARTED"]),
    "updatedAtEpoch": int(time.time()),
    "deadlineEpoch": int(os.environ["RUN_DEADLINE"]),
    "targetDir": os.environ["RUN_TARGET"],
    "linearProject": os.environ["RUN_PROJECT"],
    "currentIssue": os.environ["RUN_ISSUE"] or None,
    "itemsMerged": int(os.environ["RUN_ITEMS"]),
    "attempts": int(os.environ["RUN_ATTEMPTS"]),
    "terminalReason": os.environ["RUN_REASON"],
    "exitStatus": int(os.environ["RUN_EXIT"]),
}
fd, tmp = tempfile.mkstemp(prefix=".overnight-status-", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)
except BaseException:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    raise
PY
}

finish() {
  terminal_reason="$1"
  exit_status="$2"
  if ! write_status; then
    log "ERROR: could not persist final status"
    terminal_reason="status-write-failed-after-$terminal_reason"
    exit_status=1
  fi
  log "=== Overnight loop done: reason=$terminal_reason merged=$items_done attempts=$attempts exit=$exit_status ==="
  return "$exit_status"
}

main_tip() { git -C "$TARGET_DIR" rev-parse --verify -q main 2>/dev/null || true; }

linear_graphql() {
  local query="$1" variables="$2" payload api_timeout
  api_timeout=$(( DEADLINE_EPOCH - $(date +%s) ))
  [ "$api_timeout" -gt 0 ] || return 1
  [ "$api_timeout" -gt 30 ] && api_timeout=30
  payload=$("$PYTHON_BIN" -c 'import json,sys; print(json.dumps({"query":sys.argv[1],"variables":json.loads(sys.argv[2])}))' "$query" "$variables") || return 1
  "$CURL_BIN" --silent --show-error --fail --max-time "$api_timeout" \
    -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' \
    --data "$payload" "$LINEAR_API_URL"
}

linear_next_issue() {
  local query variables response
  query='query($project:String!){issues(first:250,filter:{state:{name:{eq:"Backlog"}},project:{name:{eq:$project}}}){nodes{identifier priority createdAt project{name}} pageInfo{hasNextPage}}}'
  variables=$("$PYTHON_BIN" -c 'import json,sys; print(json.dumps({"project":sys.argv[1]}))' "$LINEAR_PROJECT") || return 1
  response=$(linear_graphql "$query" "$variables") || return 1
  printf '%s' "$response" | "$PYTHON_BIN" -c '
import json,sys
d=json.load(sys.stdin)
if d.get("errors"): raise SystemExit(1)
try:
    connection=d["data"]["issues"]
    nodes=connection["nodes"]
except (KeyError,TypeError): raise SystemExit(1)
if not isinstance(nodes,list): raise SystemExit(1)
if connection.get("pageInfo",{}).get("hasNextPage"): raise SystemExit(1)
nodes=[n for n in nodes if n.get("project",{}).get("name")==sys.argv[1]]
nodes.sort(key=lambda n: (n.get("priority") in (None,0), n.get("priority") or 99, n.get("createdAt", "")))
if nodes:
    identifier=nodes[0].get("identifier","")
    if not identifier or not all(c.isalnum() or c=="-" for c in identifier): raise SystemExit(1)
    print(identifier)
' "$LINEAR_PROJECT"
}

linear_issue_state() {
  local issue="$1" query variables response
  query='query($identifier:String!){issue(id:$identifier){identifier state{name} project{name}}}'
  variables=$("$PYTHON_BIN" -c 'import json,sys; print(json.dumps({"identifier":sys.argv[1]}))' "$issue") || return 1
  response=$(linear_graphql "$query" "$variables") || return 1
  printf '%s' "$response" | "$PYTHON_BIN" -c '
import json,sys
d=json.load(sys.stdin)
if d.get("errors"): raise SystemExit(1)
issue=d.get("data",{}).get("issue")
if not issue or issue.get("identifier") != sys.argv[1] or issue.get("project",{}).get("name") != sys.argv[2]: raise SystemExit(1)
print(issue.get("state",{}).get("name", ""))
' "$issue" "$LINEAR_PROJECT"
}

issue_receipt() {
  local before="$1" after="$2" issue="$3" sha body matches=0 receipt=""
  [ -n "$before" ] && [ -n "$after" ] && git -C "$TARGET_DIR" merge-base --is-ancestor "$before" "$after" 2>/dev/null || return 1
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    body=$(git -C "$TARGET_DIR" show -s --format=%B "$sha") || return 1
    if printf '%s\n' "$body" | grep -Eq "(^|[^A-Za-z0-9-])${issue}([^A-Za-z0-9-]|$)" && \
       printf '%s\n' "$body" | grep -Eiq '^Reviewed-By: (quality|claude-quality|codex|claude)( |$)'; then
      matches=$((matches + 1)); receipt="$sha"
    fi
  done < <(git -C "$TARGET_DIR" rev-list "$before..$after")
  [ "$matches" -eq 1 ] || return 1
  printf '%s\n' "$receipt"
}

block_reset_epoch() {
  local json remaining
  remaining=$(( DEADLINE_EPOCH - $(date +%s) ))
  [ "$remaining" -gt 0 ] || return 1
  [ "$remaining" -gt 30 ] && remaining=30
  json=$("$PYTHON_BIN" "$RUN_WITH_DEADLINE" --timeout-seconds "$remaining" -- "$CCUSAGE_BIN" blocks --active --json 2>/dev/null) || return 1
  printf '%s' "$json" | "$PYTHON_BIN" -c '
import datetime,json,sys
blocks=json.load(sys.stdin).get("blocks",[])
if not blocks: raise SystemExit(0)
end=blocks[0].get("endTime")
if not end: raise SystemExit(1)
print(int(datetime.datetime.fromisoformat(end.replace("Z","+00:00")).timestamp()))
'
}

sleep_until_reset() {
  local now reset_epoch wait_s
  now=$(date +%s)
  reset_epoch=$(block_reset_epoch) || reset_epoch=""
  if [ -n "$reset_epoch" ] && [ "$reset_epoch" -gt "$now" ]; then
    wait_s=$(( reset_epoch - now + RESET_BUFFER_SECONDS ))
  else
    wait_s="$FALLBACK_SLEEP_SECONDS"
  fi
  [ $(( now + wait_s )) -lt "$DEADLINE_EPOCH" ] || return 1
  log "Usage-limit signal confirmed; sleeping ${wait_s}s before retry."
  sleep "$wait_s"
}

cleanup_lock() {
  if [ "${LOOP_ADMITTED:-0}" -eq 1 ]; then
    node "$AUTONOMOUS_RUNTIME" release --id "$LOOP_ID" --owner-pid "$$" >/dev/null 2>&1 || true
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

main() {
  [ -n "${LINEAR_API_KEY:-}" ] || { log "FATAL: LINEAR_API_KEY is required"; return 1; }
  [ -x "$SCRIPT_DIR/provider-run.sh" ] || { log "FATAL: provider runner missing"; return 1; }
  [ -f "$AUTONOMOUS_RUNTIME" ] || { log "FATAL: autonomous-loop runtime missing"; return 1; }
  [ -f "$RUN_WITH_DEADLINE" ] || { log "FATAL: deadline helper missing at $RUN_WITH_DEADLINE"; return 1; }
  command -v git >/dev/null 2>&1 || { log "FATAL: git not on PATH"; return 1; }
  command -v shasum >/dev/null 2>&1 || { log "FATAL: shasum not on PATH"; return 1; }
  command -v "$PYTHON_BIN" >/dev/null 2>&1 || { log "FATAL: python3 not on PATH"; return 1; }
  command -v "$CURL_BIN" >/dev/null 2>&1 || { log "FATAL: curl not on PATH"; return 1; }
  [ -d "$TARGET_DIR" ] && [ -n "$(main_tip)" ] || { log "FATAL: target has no readable main branch: $TARGET_DIR"; return 1; }
  local usage_args=()
  if [ -n "$CLAUDE_USAGE_COMMAND" ]; then
    usage_args=(--usage-command "$CLAUDE_USAGE_COMMAND")
  else
    # Resolve the same policy as the worker before checking either provider.
    source "$SCRIPT_DIR/provider-policy.sh"
    local policy_primary policy_fallback
    read -r policy_primary policy_fallback < <(bs_provider_load)
    PROVIDER="${PROVIDER:-$policy_primary}"
    [ "$PROVIDER" != auto ] || PROVIDER=$(bs_provider_invoker)
    PROVIDER_FALLBACK="${PROVIDER_FALLBACK:-$policy_fallback}"
    [ "$PROVIDER" != codex ] || PROVIDER_FALLBACK=none
    usage_args=(--provider "$PROVIDER" --fallback "$PROVIDER_FALLBACK")
  fi

  local lock_key
  lock_key=$(printf '%s\0%s' "$TARGET_DIR" "$LINEAR_PROJECT" | shasum -a 256 | cut -c1-20)
  LOCK_DIR="${TMPDIR:-/tmp}/buildproven-overnight-loop-$lock_key.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "FATAL: another loop owns $LOCK_DIR (remove only after proving it is stale)"
    return 1
  fi
  LOOP_ID="overnight:${TARGET_DIR}:${LINEAR_PROJECT}"
  if ! node "$AUTONOMOUS_RUNTIME" admit \
    --kind ralph \
    --id "$LOOP_ID" \
    --owner-pid "$$" \
    "${usage_args[@]}" >/dev/null; then
    log "FATAL: autonomous-loop admission denied; inspect operator telemetry for the sanitized reason"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    return 1
  fi
  LOOP_ADMITTED=1
  trap cleanup_lock EXIT
  trap 'exit 130' INT TERM

  log "=== Overnight loop start: target=$TARGET_DIR project=$LINEAR_PROJECT max_items=$MAX_ITEMS max_hours=$MAX_HOURS ==="
  write_status || { log "FATAL: cannot persist run status"; return 1; }

  current_issue=$(linear_next_issue) || { finish "linear-unreachable" 1; return $?; }
  if [ -z "$current_issue" ]; then finish "backlog-drained" 0; return $?; fi
  log "Scoped Linear backlog reachable; next issue=$current_issue"
  if [ "$DRY_RUN" -eq 1 ]; then finish "dry-run" 0; return $?; fi

  local error_streak=0 now remaining main_before main_after run_rc receipt issue_state iteration_log provider_output_dir
  while [ "$items_done" -lt "$MAX_ITEMS" ]; do
    now=$(date +%s)
    [ "$now" -lt "$DEADLINE_EPOCH" ] || { finish "max-hours" 1; return $?; }
    attempts=$((attempts + 1))
    [ "$attempts" -le $((MAX_ITEMS * 3)) ] || { finish "attempt-cap" 1; return $?; }
    remaining=$((DEADLINE_EPOCH - now))
    write_status || { finish "status-write-failed" 1; return $?; }
    main_before=$(main_tip)
    [ -n "$main_before" ] || { finish "git-unreadable" 1; return $?; }
    iteration_log="$LOG_DIR/overnight-loop-${current_issue}-${START_EPOCH}-${attempts}.log"
    log "Attempt $attempts: exact Linear item $current_issue (${remaining}s wall budget left)"

    prompt_file="$LOG_DIR/overnight-loop-${current_issue}-${START_EPOCH}-${attempts}.prompt"
    execution_facts_file="$LOG_DIR/overnight-loop-${current_issue}-${START_EPOCH}-${attempts}.facts.json"
    provider_output_dir="$LOG_DIR/overnight-loop-${current_issue}-${START_EPOCH}-${attempts}.provider"
    printf '%s\n' "Run the ralph workflow until exactly item:$current_issue in target directory $TARGET_DIR. Use the repository's quality merge gate and stop after this exact item is merged." > "$prompt_file"
    # An explicitly selected Codex child uses the phase-v2 contract. The unset
    # provider keeps legacy policy resolution so a Claude-only host remains
    # usable. V2 declares repository-wide planned scope because the shell
    # launcher cannot infer item paths; protected paths still force a replan.
    if [ "$PROVIDER" = codex ]; then
      printf '%s\n' '{"schemaVersion":2,"caller":"overnight-ralph","provider":"codex","phase":"implement","evidence":{"localized":false,"reversible":false,"targetedProof":false,"ambiguous":true,"changedFiles":0,"protectedSurfaces":[],"publicContract":false,"crossRepository":false,"plannedPaths":["**"]}}' > "$execution_facts_file"
      provider_args=(--prompt-file "$prompt_file" --phase-request "$execution_facts_file" --caller overnight-ralph --provider codex --fallback none --target-dir "$TARGET_DIR" --timeout "$remaining" --output-dir "$provider_output_dir")
    else
      printf '%s\n' '{"phase":"implement","localized":false,"reversible":false,"targetedProof":false,"ambiguous":true,"changedFiles":0,"protectedSurfaces":[],"sameFailureStreak":0}' > "$execution_facts_file"
      provider_args=(--prompt-file "$prompt_file" --execution-facts "$execution_facts_file" --target-dir "$TARGET_DIR" --timeout "$remaining" --output-dir "$provider_output_dir")
      [ -z "$PROVIDER" ] || provider_args+=(--provider "$PROVIDER")
      [ -z "$PROVIDER_FALLBACK" ] || provider_args+=(--fallback "$PROVIDER_FALLBACK")
    fi
    "$SCRIPT_DIR/provider-run.sh" "${provider_args[@]}" 2>&1 | tee -a "$LOG_FILE" "$iteration_log" >/dev/null
    run_rc=${PIPESTATUS[0]}
    rm -f "$prompt_file"
    rm -f "$execution_facts_file"
    main_after=$(main_tip)
    [ -n "$main_after" ] || { finish "git-unreadable" 1; return $?; }
    issue_state=$(linear_issue_state "$current_issue") || { finish "linear-unreachable" 1; return $?; }
    receipt=$(issue_receipt "$main_before" "$main_after" "$current_issue") || receipt=""

    if [ -n "$receipt" ] && [ "$issue_state" = "Done" ]; then
      items_done=$((items_done + 1)); error_streak=0
      log "MERGED $current_issue at $receipt; Linear state=Done ($items_done/$MAX_ITEMS)."
      current_issue=$(linear_next_issue) || { finish "linear-unreachable" 1; return $?; }
      if [ -z "$current_issue" ]; then finish "backlog-drained" 0; return $?; fi
      continue
    fi
    if [ -n "$receipt" ] || [ "$issue_state" != "Backlog" ]; then
      log "ERROR: inconsistent outcome for $current_issue: receipt=${receipt:-none} Linear=$issue_state rc=$run_rc"
      finish "inconsistent-receipt" 1; return $?
    fi
    if [ "$run_rc" -eq 76 ] || [ "$run_rc" -eq 124 ]; then finish "agent-deadline" 1; return $?; fi
    if [ "$run_rc" -eq 75 ]; then
      if sleep_until_reset; then continue; fi
      finish "limit-reset-past-deadline" 1; return $?
    fi

    error_streak=$((error_streak + 1))
    log "ERROR: $current_issue produced no exact receipt (rc=$run_rc, Linear=$issue_state, streak=$error_streak)."
    if [ "$error_streak" -ge 3 ]; then finish "ralph-error-streak" 1; return $?; fi
  done
  finish "max-items" 0
}

if [ "${OVERNIGHT_LOOP_LIB_ONLY:-0}" -eq 1 ]; then
  return 0 2>/dev/null || exit 0
fi

if main; then
  status=0
else
  status=$?
fi
find "$LOG_DIR" -name 'overnight-loop-*.log' -mtime +56 -delete || log "WARN: log prune failed"
exit "$status"
