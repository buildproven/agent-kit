#!/usr/bin/env bash
# ralph-next-run.sh - Phase 2 executable runner for /bs:ralph
# Implements graph-state orchestration with local quality checks and evidence logging.

set -euo pipefail

log_info() { echo "[ralph-next] $*"; }
log_warn() { echo "[ralph-next][warn] $*" >&2; }
die() { echo "[ralph-next][error] $*" >&2; exit 1; }

usage() {
    cat <<'USAGE_EOF'
ralph-next-run.sh - Phase 2 graph runner

Usage:
  scripts/ralph-next-run.sh [options]

Options:
  --until "<N items>|<N hours>|empty|item:ID-123|checkpoint:name"
  --scope all|feature|bug|effort:S|effort:M
  --section all|high|medium|low
  --quality auto|95|98
  --next
  --classic
  --reflect-depth standard|deep
  --speculate auto|always|never
  --score-threshold <float>
  --evidence-dir <path>
  --max-retries <n>
  --max-ci-retries <n>
  --no-compact
  --dry-run
  --help

Environment variables:
  RALPH_NEXT_SIMULATE_FAILURE=all|ID-123
  RALPH_NEXT_SIMULATE_FAILURE_TYPE=lint|typecheck|import|test|build:code|build:config|security:critical-high|security:moderate-low|flaky-test|env/tooling|oom/resource|timeout|merge-conflict|QUALITY_INFRA_FAIL
  RALPH_NEXT_ENABLE_SECURITY_AUDIT=1   (runs npm security:audit when available)
  RALPH_NEXT_ENABLE_BUILD_CHECK=1      (runs npm build when available)

Notes:
  - Item IDs may use any prefix (CS-, SN-, BP-, etc.).
  - This script performs local quality gates (lint/pattern checks and optional build/security).
  - Repos with no quality scripts (docs, markdown-only) treat quality as passing.
  - Slash-command execution (/bs:quality or /bs:ralph) is not invoked from shell.
USAGE_EOF
}

ensure_dependency() {
    local bin="$1"
    command -v "$bin" >/dev/null 2>&1 || die "Missing dependency: $bin"
}

to_abs_path() {
    local path="$1"
    if [[ "$path" = /* ]]; then
        echo "$path"
    else
        echo "$GIT_ROOT/$path"
    fi
}

float_ge() {
    local a="$1"
    local b="$2"
    awk -v a="$a" -v b="$b" 'BEGIN { exit !(a >= b) }'
}

float_div_safe() {
    local num="$1"
    local den="$2"
    awk -v n="$num" -v d="$den" 'BEGIN { if (d == 0) print 0; else printf "%.4f", n / d }'
}

compute_score() {
    local quality_coverage="$1"
    local first_attempt="$2"
    local duration_ratio="$3"
    local learning_value="$4"
    awk -v q="$quality_coverage" -v f="$first_attempt" -v d="$duration_ratio" -v l="$learning_value" \
        'BEGIN { printf "%.4f", (q*0.4) + (f*0.2) + (d*0.2) + (l*0.2) }'
}

append_trajectory() {
    local item_id="$1"
    local state="$2"
    local detail_json="$3"
    jq -nc \
        --arg timestamp "$(date -Iseconds)" \
        --arg item_id "$item_id" \
        --arg state "$state" \
        --argjson detail "$detail_json" \
        '{
          timestamp: $timestamp,
          item_id: $item_id,
          state: $state,
          detail: $detail
        }' >> "$TRAJECTORY_LOG"
}

init_state_file() {
    if [[ -f "$STATE_FILE" ]]; then
        # Migrate old schema (missing version field) — reset rather than corrupt
        local version
        version="$(jq -r '.version // empty' "$STATE_FILE" 2>/dev/null || true)"
        if [[ -z "$version" ]]; then
            log_warn "Old state schema detected at $STATE_FILE; resetting for new session"
            rm -f "$STATE_FILE"
        else
            return
        fi
    fi

    jq -n \
        --arg startedAt "$(date -Iseconds)" \
        --arg mode "next" \
        --arg until "$UNTIL_CONDITION" \
        --arg scope "$SCOPE_FILTER" \
        --arg section "$SECTION_FILTER" \
        --arg quality "$QUALITY_LEVEL" \
        --arg reflect "$REFLECT_DEPTH" \
        --arg speculate "$SPECULATE_MODE" \
        --argjson score_threshold "$SCORE_THRESHOLD" \
        --argjson max_retries "$MAX_RETRIES" \
        --argjson max_ci_retries "$MAX_CI_RETRIES" \
        '{
          version: "1.0",
          mode: $mode,
          startedAt: $startedAt,
          lastUpdated: $startedAt,
          config: {
            until: $until,
            scope: $scope,
            section: $section,
            quality: $quality,
            reflectDepth: $reflect,
            speculate: $speculate,
            scoreThreshold: $score_threshold,
            maxRetries: $max_retries,
            maxCiRetries: $max_ci_retries
          },
          items: {},
          sessionStats: {
            attempted: 0,
            completed: 0,
            blocked: 0,
            avgScore: 0
          }
        }' > "$STATE_FILE"
}

update_state_item() {
    local item_id="$1"
    local item_status="$2"
    local decision="$3"
    local failure_type="$4"
    local trajectory_score="$5"
    local quality_passed="$6"
    local attempt_count="$7"
    local tmp_file
    tmp_file="$(mktemp)"

    jq \
        --arg id "$item_id" \
        --arg status "$item_status" \
        --arg decision "$decision" \
        --arg failure_type "$failure_type" \
        --argjson trajectory_score "$trajectory_score" \
        --argjson quality_passed "$quality_passed" \
        --argjson attempts "$attempt_count" \
        --arg updatedAt "$(date -Iseconds)" \
        '
        .lastUpdated = $updatedAt
        | .items[$id] = {
            status: $status,
            decision: $decision,
            failureType: (if $failure_type == "" then null else $failure_type end),
            trajectory_score: $trajectory_score,
            quality_passed: $quality_passed,
            attempts: $attempts,
            updatedAt: $updatedAt
          }
        | .sessionStats.attempted += 1
        | .sessionStats.completed += (if $status == "completed" then 1 else 0 end)
        | .sessionStats.blocked += (if $status == "blocked" then 1 else 0 end)
        ' "$STATE_FILE" > "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
}

finalize_state() {
    local avg_score
    avg_score="$(jq '[.items[]?.trajectory_score] | if length == 0 then 0 else (add / length) end' "$STATE_FILE")"
    local tmp_file
    tmp_file="$(mktemp)"
    jq --arg finishedAt "$(date -Iseconds)" --argjson avg "$avg_score" \
        '.lastUpdated = $finishedAt | .finishedAt = $finishedAt | .sessionStats.avgScore = $avg' \
        "$STATE_FILE" > "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
}

build_scope_filter() {
    cat <<'FILTER_EOF'
if $scope == "all" then .
elif $scope == "feature" then map(select((.type | ascii_downcase | contains("feature"))))
elif $scope == "bug" then map(select((.type | ascii_downcase | contains("bug")) or (.type | ascii_downcase | contains("fix"))))
elif $scope == "effort:S" then map(select((.effort | ascii_downcase) == "xs" or (.effort | ascii_downcase) == "s"))
elif $scope == "effort:M" then map(select((.effort | ascii_downcase) == "m"))
else .
end
FILTER_EOF
}

collect_candidate_items() {
    local backlog_lines
    backlog_lines="$(
        awk '
        function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
        BEGIN { section = "unknown" }
        /^## High Value/   { section = "high";   next }
        /^## Medium Value/ { section = "medium"; next }
        /^## Low Value/    { section = "low";    next }
        /^\|[[:space:]]*[A-Z]+-[0-9]+[[:space:]]*\|/ {
          n = split($0, a, "|")
          id     = trim(a[2])
          desc   = trim(a[3])
          type   = trim(a[4])
          effort = trim(a[6])
          score  = trim(a[7])
          status = trim(a[8])

          if (tolower(status) == "pending" || tolower(status) == "ready") {
            gsub(/\t/, " ", desc)
            if (score == "") score = "0"
            print id "\t" desc "\t" type "\t" effort "\t" score "\t" section
          }
        }' "$BACKLOG_FILE"
    )"

    local scope_filter
    scope_filter="$(build_scope_filter)"

    # Serialize CHECKPOINT_ITEMS bash array to JSON for jq filtering
    local checkpoint_json="[]"
    if [[ "${#CHECKPOINT_ITEMS[@]}" -gt 0 ]]; then
        checkpoint_json="$(printf '%s\n' "${CHECKPOINT_ITEMS[@]}" | jq -R . | jq -s .)"
    fi

    jq -R -s \
        --arg section "$SECTION_FILTER" \
        --arg scope "$SCOPE_FILTER" \
        --arg target_item "$TARGET_ITEM" \
        --argjson checkpoint_items "$checkpoint_json" \
        --argjson limit "$ITEM_LIMIT" \
        "
        split(\"\\n\")
        | map(select(length > 0) | split(\"\\t\"))
        | map({
            id: .[0],
            description: .[1],
            type: .[2],
            effort: .[3],
            score: (.[4] | tonumber? // 0),
            section: .[5]
          })
        | if \$section == \"all\" then . else map(select(.section == \$section)) end
        | $scope_filter
        | if \$target_item == \"\" then . else map(select(.id == \$target_item)) end
        | if (\$checkpoint_items | length) > 0 then map(select(.id as \$id | any(\$checkpoint_items[]; . == \$id))) else . end
        | sort_by(.score) | reverse
        | .[:\$limit]
        " <<< "$backlog_lines"
}

has_package_script() {
    local script_name="$1"
    [[ -f "$PACKAGE_JSON" ]] || return 1
    jq -e --arg name "$script_name" '.scripts and (.scripts[$name] != null)' "$PACKAGE_JSON" >/dev/null 2>&1
}

select_js_runner() {
    if [[ -f "$GIT_ROOT/package-lock.json" ]]; then
        echo "npm"
    elif [[ -f "$GIT_ROOT/pnpm-lock.yaml" ]]; then
        echo "pnpm"
    elif [[ -f "$GIT_ROOT/yarn.lock" ]]; then
        echo "yarn"
    elif command -v npm >/dev/null 2>&1; then
        echo "npm"
    else
        echo ""
    fi
}

run_script_check() {
    local script_name="$1"
    local log_file="$2"

    if ! has_package_script "$script_name"; then
        return 0
    fi

    case "$JS_RUNNER" in
        npm)
            npm run --silent "$script_name" >> "$log_file" 2>&1
            ;;
        pnpm)
            pnpm run "$script_name" >> "$log_file" 2>&1
            ;;
        yarn)
            yarn "$script_name" >> "$log_file" 2>&1
            ;;
        *)
            echo "No JS runner available for script: $script_name" >> "$log_file"
            return 1
            ;;
    esac
}

classify_failure_type_from_log() {
    local log_file="$1"

    if grep -Eiq 'critical|severity:[[:space:]]*high|high severity|exploitable' "$log_file" && grep -Eiq 'security|audit|cve|vulnerability' "$log_file"; then
        echo "security:critical-high"
        return
    fi

    if grep -Eiq 'security|audit|cve|vulnerability' "$log_file"; then
        echo "security:moderate-low"
        return
    fi

    if grep -Eiq 'eslint|lint' "$log_file"; then
        echo "lint"
        return
    fi

    if grep -Eiq 'TS[0-9]{3,4}|type error|typescript|mypy' "$log_file"; then
        echo "typecheck"
        return
    fi

    if grep -Eiq 'cannot find module|module not found|no module named' "$log_file"; then
        echo "import"
        return
    fi

    if grep -Eiq 'flaky' "$log_file"; then
        echo "flaky-test"
        return
    fi

    if grep -Eiq 'test failed|failing tests|assertion|expect\(' "$log_file"; then
        echo "test"
        return
    fi

    if grep -Eiq 'heap out of memory|ENOMEM|killed' "$log_file"; then
        echo "oom/resource"
        return
    fi

    if grep -Eiq 'timed out|timeout' "$log_file"; then
        echo "timeout"
        return
    fi

    if grep -Eiq 'merge conflict|CONFLICT \(' "$log_file"; then
        echo "merge-conflict"
        return
    fi

    if grep -Eiq 'ECONNREFUSED|ENOTFOUND|EAI_AGAIN|registry|network|permission denied|command not found' "$log_file"; then
        echo "env/tooling"
        return
    fi

    if grep -Eiq 'build' "$log_file"; then
        if grep -Eiq 'webpack|vite|tsconfig|rollup|babel|config' "$log_file"; then
            echo "build:config"
        else
            echo "build:code"
        fi
        return
    fi

    echo "QUALITY_INFRA_FAIL"
}

run_quality_checks() {
    local item_id="$1"
    local attempt_index="$2"
    local log_file="$3"
    local failure_target="${RALPH_NEXT_SIMULATE_FAILURE:-}"
    local failure_type_default="${RALPH_NEXT_SIMULATE_FAILURE_TYPE:-test}"

    : > "$log_file"

    if [[ -n "$failure_target" && ( "$failure_target" == "all" || "$failure_target" == "$item_id" ) ]]; then
        echo "Simulated failure for $item_id ($failure_type_default)" >> "$log_file"
        echo "false|$failure_type_default"
        return
    fi

    local any_check_ran="false"

    if has_package_script "lint"; then
        any_check_ran="true"
        log_info "Quality check: lint ($item_id attempt $attempt_index)" >&2
        if ! run_script_check "lint" "$log_file"; then
            echo "false|$(classify_failure_type_from_log "$log_file")"
            return
        fi
    fi

    if has_package_script "test:patterns"; then
        any_check_ran="true"
        log_info "Quality check: test:patterns ($item_id attempt $attempt_index)" >&2
        if ! run_script_check "test:patterns" "$log_file"; then
            echo "false|$(classify_failure_type_from_log "$log_file")"
            return
        fi
    fi

    if [[ "${RALPH_NEXT_ENABLE_BUILD_CHECK:-0}" == "1" ]] && has_package_script "build"; then
        any_check_ran="true"
        log_info "Quality check: build ($item_id attempt $attempt_index)" >&2
        if ! run_script_check "build" "$log_file"; then
            echo "false|$(classify_failure_type_from_log "$log_file")"
            return
        fi
    fi

    if [[ "${RALPH_NEXT_ENABLE_SECURITY_AUDIT:-0}" == "1" ]] && has_package_script "security:audit"; then
        any_check_ran="true"
        log_info "Quality check: security:audit ($item_id attempt $attempt_index)" >&2
        if ! run_script_check "security:audit" "$log_file"; then
            echo "false|$(classify_failure_type_from_log "$log_file")"
            return
        fi
    fi

    # Docs/non-code repos have no quality scripts — treat as passing rather than
    # blocking every item with QUALITY_INFRA_FAIL.
    if [[ "$any_check_ran" == "false" ]]; then
        echo "No local quality scripts found (docs/non-code repo); treating quality as pass" >> "$log_file"
        _write_quality_evidence "$item_id" "$attempt_index"
        echo "true|"
        return
    fi

    _write_quality_evidence "$item_id" "$attempt_index"
    echo "true|"
}

_write_quality_evidence() {
    local item_id="$1"
    local attempt_index="$2"
    mkdir -p "$EVIDENCE_ROOT"
    jq -n \
        --arg id "$item_id" \
        --argjson attempt "$attempt_index" \
        --arg ts "$(date -Iseconds)" \
        '{item_id: $id, attempt: $attempt, passed: true, timestamp: $ts}' \
        > "$EVIDENCE_ROOT/quality-${item_id}.json"
}

get_failure_budget() {
    local failure_type="$1"
    case "$failure_type" in
        lint|typecheck|import|build:code|env/tooling|oom/resource|timeout) echo 2 ;;
        test) echo 3 ;;
        build:config|security:moderate-low|flaky-test|merge-conflict) echo 1 ;;
        security:critical-high) echo 0 ;;
        QUALITY_INFRA_FAIL) echo 2 ;;
        *) echo 1 ;;
    esac
}

classify_decision() {
    local quality_passed="$1"
    local failure_type="$2"
    local score="$3"
    local same_failure_streak="$4"

    if [[ "$quality_passed" == "false" ]]; then
        case "$failure_type" in
            QUALITY_INFRA_FAIL) echo "retry-quality-only" ;;
            lint|typecheck|import|env/tooling|merge-conflict|flaky-test) echo "retry" ;;
            test)
                if [[ "$same_failure_streak" -le 1 ]]; then
                    echo "retry"
                else
                    echo "split"
                fi
                ;;
            build:code)
                if [[ "$same_failure_streak" -le 1 ]]; then
                    echo "retry"
                else
                    echo "split"
                fi
                ;;
            build:config) echo "escalate" ;;
            security:critical-high) echo "escalate" ;;
            security:moderate-low)
                if [[ "$same_failure_streak" -le 1 ]]; then
                    echo "retry"
                else
                    echo "escalate"
                fi
                ;;
            timeout|oom/resource) echo "split" ;;
            *) echo "block" ;;
        esac
        return
    fi

    if float_ge "$score" "$SCORE_THRESHOLD"; then
        echo "pass"
    elif float_ge "$score" "0.4"; then
        echo "marginal"
    else
        echo "retry"
    fi
}

# Update the Status column of an active backlog table row in place.
# Only modifies rows with 8+ fields (active tables); Completed section rows have 4.
update_backlog_item_status() {
    local item_id="$1"
    local new_status="$2"
    local tmp
    backup_backlog_once
    tmp="$(mktemp)"

    awk -v id="$item_id" -v st="$new_status" '
    BEGIN { FS=OFS="|" }
    {
        trimmed=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", trimmed)
        if (trimmed == id && NF >= 8) {
            $8 = " " st " "
        }
        print
    }
    ' "$BACKLOG_FILE" > "$tmp" && mv "$tmp" "$BACKLOG_FILE"
}

# Snapshot BACKLOG.md before a mutation. The session loop backs up once at
# startup, but the subcommands — which skills/ralph tells the orchestrator to
# drive directly — mutated the file with no backup at all, so a bad edit had no
# recovery path. Timestamped so a second run cannot overwrite the only copy of
# the pre-mutation state.
backup_backlog_once() {
    [[ -f "$BACKLOG_FILE" ]] || return 0
    [[ -n "${BACKLOG_BACKED_UP:-}" ]] && return 0
    local stamp
    stamp="$(date +%Y%m%d-%H%M%S)"
    cp "$BACKLOG_FILE" "${BACKLOG_FILE}.ralph-next-backup-${stamp}" 2>/dev/null || return 0
    BACKLOG_BACKED_UP=1
    log_info "BACKLOG.md backed up to ${BACKLOG_FILE}.ralph-next-backup-${stamp}"
}

move_item_to_completed() {
    local item_id="$1"
    local completed_date="$2"
    local tmp
    backup_backlog_once
    tmp="$(mktemp)"

    awk -v id="$item_id" -v date="$completed_date" '
    BEGIN {
        FS=OFS="|"
        in_completed=0; found=0; inserted=0
        item_desc=""; item_type=""
    }

    /^## Completed/ { in_completed=1; print; next }
    /^## / && !/^## Completed/ { in_completed=0 }

    {
        trimmed=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", trimmed)

        # Capture and remove the active row
        if (!in_completed && trimmed == id && NF >= 8) {
            item_desc=$3; item_type=$4
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", item_desc)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", item_type)
            found=1
            next
        }

        print

        # Insert completed row after the Completed section header divider
        if (in_completed && found && !inserted && /^\| ---/) {
            printf "| %s | %s | %s | %s |\n", id, item_desc, item_type, date
            inserted=1
        }
    }

    # The active row is removed by `next` above and re-inserted only inside the
    # Completed section. If that section is absent — or present without a
    # `| ---` divider — the re-insert never fires and the row is simply GONE.
    # Exiting non-zero here means the `&& mv` below never runs, so the original
    # file is left untouched rather than silently truncated.
    END {
        if (found && !inserted) {
            printf "ralph-next: cannot move %s to Completed: no \"## Completed\" section with a \"| ---\" divider row in %s\n", id, FILENAME > "/dev/stderr"
            exit 3
        }
        if (!found) {
            printf "ralph-next: %s not found as an active row in %s\n", id, FILENAME > "/dev/stderr"
            exit 4
        }
    }
    ' "$BACKLOG_FILE" > "$tmp" || {
        rm -f "$tmp"
        die "BACKLOG.md not modified — $item_id could not be moved to Completed"
    }
    mv "$tmp" "$BACKLOG_FILE"
}

########################################
# Sub-command dispatch
# Called by the LLM-driven ralph-next.md to invoke individual graph steps.
# Usage: ralph-next-run.sh <subcmd> [ARGS...] [--evidence-dir DIR]
#
# Subcommands:
#   init         Initialize state files (accepts all config flags)
#   pick-items   Print candidate items as JSON array
#   run-quality  Run quality checks: args ITEM_ID ATTEMPT
#   log-traj     Append trajectory entry: args ITEM_ID STATE DETAIL_JSON
#   update-item  Update state record: args ITEM_ID STATUS DECISION FAILURE_TYPE SCORE QUALITY_PASSED ATTEMPTS
#   complete-item Move item to Completed: args ITEM_ID [DATE]
#   block-item   Mark item Blocked: args ITEM_ID
#   finalize     Write session summary
########################################

# --- proof-of-work helpers -------------------------------------------------
# The graph loop's IMPLEMENT state is a placeholder: this script runs quality
# gates but cannot invoke /bs:ralph or /bs:quality to write code (see usage).
# Completion must therefore be gated on the tree having actually changed,
# otherwise a passing lint run on an untouched checkout reads as a finished
# feature.

current_head_sha() {
    git rev-parse HEAD 2>/dev/null || echo ""
}

# Hash of `git status --porcelain`, so uncommitted work counts as work. Two
# different dirty states produce two different fingerprints; an unchanged tree
# reproduces the same one.
#
# BACKLOG.md is EXCLUDED: this runner writes it itself when it completes or
# blocks an item, so counting it would let item 1's bookkeeping satisfy item
# 2's proof-of-work gate — the loop would vouch for itself after the first
# iteration. The evidence dir and the backup file are already gitignored and
# so never appear here.
working_tree_fingerprint() {
    git status --porcelain 2>/dev/null \
        | grep -v ' BACKLOG\.md$' \
        | shasum 2>/dev/null \
        | awk '{print $1}' || echo ""
}

# True when the repository changed since the baseline captured at PICK, either
# as a new commit or as new uncommitted content. Unknown git state is treated
# as NO evidence: an item must prove work happened, never merely fail to
# disprove it.
item_has_work_evidence() {
    local baseline_head="$1"
    local head_now
    head_now="$(current_head_sha)"

    [[ -n "$baseline_head" && -n "$head_now" ]] || return 1
    [[ "$head_now" != "$baseline_head" ]] && return 0

    local dirty_now
    dirty_now="$(working_tree_fingerprint)"
    [[ -n "$dirty_now" && "$dirty_now" != "$item_baseline_dirty" ]]
}

_sc_setup_env() {
    # Sets up globals required by helper functions.
    # Requires EVIDENCE_DIR to already be set.
    ensure_dependency jq
    GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [[ -n "$GIT_ROOT" ]] || die "Not in a git repository"
    cd "$GIT_ROOT"
    EVIDENCE_ROOT="$(to_abs_path "$EVIDENCE_DIR")"
    STATE_FILE="$EVIDENCE_ROOT/state.json"
    TRAJECTORY_LOG="$EVIDENCE_ROOT/trajectory-log.jsonl"
    EVIDENCE_ITEMS_DIR="$EVIDENCE_ROOT/evidence"
    QUALITY_LOG_DIR="$EVIDENCE_ROOT/quality-logs"
    BACKLOG_FILE="$GIT_ROOT/BACKLOG.md"
    PACKAGE_JSON="$GIT_ROOT/package.json"
    JS_RUNNER="$(select_js_runner)"
}

# Check for known sub-command as first argument
case "${1:-}" in
    init|pick-items|run-quality|log-traj|update-item|complete-item|block-item|finalize|list-completed-ids)
        SUBCMD="$1"; shift

        # Extract --evidence-dir; collect remaining as positional args
        EVIDENCE_DIR=".claude/ralph-next"
        SC_ARGS=()
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --evidence-dir)
                  [ "$#" -ge 2 ] || {
                    echo "ralph-next-run: --evidence-dir requires a value" >&2
                    exit 1
                  }
                  EVIDENCE_DIR="$2"
                  shift 2
                  ;;
                *) SC_ARGS+=("$1"); shift ;;
            esac
        done

        case "$SUBCMD" in
            init)
                # Parse full config args to create state.json
                UNTIL_CONDITION="10 items"
                SCOPE_FILTER="all"; SECTION_FILTER="all"; QUALITY_LEVEL="auto"
                REFLECT_DEPTH="standard"; SPECULATE_MODE="auto"; SCORE_THRESHOLD="0.7"
                MAX_RETRIES=3; MAX_CI_RETRIES=2
                set -- "${SC_ARGS[@]}"
                while [[ $# -gt 0 ]]; do
                    case "$1" in
                        --until)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --until requires a value" >&2
                            exit 1
                          }
                          UNTIL_CONDITION="$2"
                          shift 2
                          ;;
                        --scope)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --scope requires a value" >&2
                            exit 1
                          }
                          SCOPE_FILTER="$2"
                          shift 2
                          ;;
                        --section)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --section requires a value" >&2
                            exit 1
                          }
                          SECTION_FILTER="$2"
                          shift 2
                          ;;
                        --quality)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --quality requires a value" >&2
                            exit 1
                          }
                          QUALITY_LEVEL="$2"
                          shift 2
                          ;;
                        --reflect-depth)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --reflect-depth requires a value" >&2
                            exit 1
                          }
                          REFLECT_DEPTH="$2"
                          shift 2
                          ;;
                        --speculate)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --speculate requires a value" >&2
                            exit 1
                          }
                          SPECULATE_MODE="$2"
                          shift 2
                          ;;
                        --score-threshold)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --score-threshold requires a value" >&2
                            exit 1
                          }
                          SCORE_THRESHOLD="$2"
                          shift 2
                          ;;
                        --max-retries)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --max-retries requires a value" >&2
                            exit 1
                          }
                          MAX_RETRIES="$2"
                          shift 2
                          ;;
                        --max-ci-retries)
                          [ "$#" -ge 2 ] || {
                            echo "ralph-next-run: --max-ci-retries requires a value" >&2
                            exit 1
                          }
                          MAX_CI_RETRIES="$2"
                          shift 2
                          ;;
                        *) log_warn "Unknown init arg: $1"; shift ;;
                    esac
                done
                _sc_setup_env
                mkdir -p "$EVIDENCE_ITEMS_DIR" "$QUALITY_LOG_DIR"
                touch "$TRAJECTORY_LOG"
                init_state_file
                log_info "State initialized: $STATE_FILE"
                exit 0
                ;;

            pick-items)
                _sc_setup_env
                [[ -f "$STATE_FILE" ]] || die "State not initialized. Run 'init' first."
                # Linear-only fast path: bail out before any code path reads
                # BACKLOG_FILE (e.g. the checkpoint awk parser below would die
                # under `set -euo pipefail` on a missing file).
                if [[ ! -f "$BACKLOG_FILE" ]]; then
                    log_warn "Linear-only mode: BACKLOG.md not found in $GIT_ROOT — skipping pick-items. Use Linear MCP (mcp__linear__list_issues) to pick items."
                    echo "[]"
                    exit 0
                fi
                SCOPE_FILTER="$(jq -r '.config.scope // "all"' "$STATE_FILE")"
                SECTION_FILTER="$(jq -r '.config.section // "all"' "$STATE_FILE")"
                UNTIL_CONDITION="$(jq -r '.config.until // "10 items"' "$STATE_FILE")"
                TARGET_ITEM=""
                CHECKPOINT_ITEMS=()
                # Resolve item limit from until condition
                if [[ "$UNTIL_CONDITION" =~ ^([0-9]+)[[:space:]]*items?$ ]]; then
                    ITEM_LIMIT="${BASH_REMATCH[1]}"
                elif [[ "$UNTIL_CONDITION" =~ ^item:([A-Z]+-[0-9]+)$ ]]; then
                    ITEM_LIMIT=1; TARGET_ITEM="${BASH_REMATCH[1]}"
                elif [[ "$UNTIL_CONDITION" == "empty" ]]; then
                    ITEM_LIMIT=999999
                elif [[ "$UNTIL_CONDITION" =~ ^checkpoint:(.+)$ ]]; then
                    SC_CHECKPOINT_NAME="${BASH_REMATCH[1]}"
                    ITEM_LIMIT=999999
                    raw_checkpoint="$(awk -v name="$SC_CHECKPOINT_NAME" '
                    /^## Checkpoints/ { in_section=1; next }
                    /^## / && in_section { in_section=0; next }
                    in_section && /^- \[/ {
                        line = $0; sub(/^- \[.\] */, "", line)
                        colon = index(line, ":"); if (colon > 0) {
                            cname = substr(line, 1, colon-1)
                            gsub(/^[[:space:]]+|[[:space:]]+$/, "", cname)
                            if (tolower(cname) == tolower(name)) {
                                items = substr(line, colon+1)
                                gsub(/^[[:space:]]+|[[:space:]]+$/, "", items)
                                print items; exit
                            }
                        }
                    }' "$BACKLOG_FILE")"
                    if [[ -z "$raw_checkpoint" ]]; then
                        log_warn "Checkpoint '$SC_CHECKPOINT_NAME' not found; defaulting to 10 items"
                        ITEM_LIMIT=10
                    else
                        IFS=', ' read -r -a raw_items <<< "$raw_checkpoint"
                        CHECKPOINT_ITEMS=()
                        for item in "${raw_items[@]}"; do
                            [[ "$item" =~ ^[A-Z]+-[0-9]+$ ]] && CHECKPOINT_ITEMS+=("$item")
                        done
                        ITEM_LIMIT="${#CHECKPOINT_ITEMS[@]}"
                        log_info "Checkpoint '$SC_CHECKPOINT_NAME': $ITEM_LIMIT items"
                    fi
                else
                    ITEM_LIMIT=10
                fi
                collect_candidate_items
                exit 0
                ;;

            run-quality)
                SC_ITEM_ID="${SC_ARGS[0]:-}"
                SC_ATTEMPT="${SC_ARGS[1]:-1}"
                [[ -n "$SC_ITEM_ID" ]] || die "run-quality requires ITEM_ID"
                _sc_setup_env
                mkdir -p "$QUALITY_LOG_DIR"
                quality_log_file="$QUALITY_LOG_DIR/${SC_ITEM_ID}-attempt-${SC_ATTEMPT}.log"
                run_quality_checks "$SC_ITEM_ID" "$SC_ATTEMPT" "$quality_log_file"
                exit 0
                ;;

            log-traj)
                SC_ITEM_ID="${SC_ARGS[0]:-}"
                SC_STATE="${SC_ARGS[1]:-}"
                SC_DETAIL="${SC_ARGS[2]:-'{}'}"
                [[ -n "$SC_ITEM_ID" ]] || die "log-traj requires ITEM_ID"
                [[ -n "$SC_STATE" ]] || die "log-traj requires STATE"
                _sc_setup_env
                mkdir -p "$(dirname "$TRAJECTORY_LOG")"
                touch "$TRAJECTORY_LOG"
                append_trajectory "$SC_ITEM_ID" "$SC_STATE" "$SC_DETAIL"
                exit 0
                ;;

            update-item)
                SC_ITEM_ID="${SC_ARGS[0]:-}"
                SC_STATUS="${SC_ARGS[1]:-blocked}"
                SC_DECISION="${SC_ARGS[2]:-block}"
                SC_FAILURE_TYPE="${SC_ARGS[3]:-}"
                SC_SCORE="${SC_ARGS[4]:-0}"
                SC_QUALITY_PASSED="${SC_ARGS[5]:-false}"
                SC_ATTEMPTS="${SC_ARGS[6]:-1}"
                [[ -n "$SC_ITEM_ID" ]] || die "update-item requires ITEM_ID"
                _sc_setup_env
                if [[ "$SC_QUALITY_PASSED" == "true" ]]; then
                    SC_QP_JSON=true
                else
                    SC_QP_JSON=false
                fi
                update_state_item "$SC_ITEM_ID" "$SC_STATUS" "$SC_DECISION" "$SC_FAILURE_TYPE" \
                    "$SC_SCORE" "$SC_QP_JSON" "$SC_ATTEMPTS"
                exit 0
                ;;

            complete-item)
                SC_ITEM_ID="${SC_ARGS[0]:-}"
                SC_DATE="${SC_ARGS[1]:-$(date +%Y-%m-%d)}"
                [[ -n "$SC_ITEM_ID" ]] || die "complete-item requires ITEM_ID"
                _sc_setup_env
                if [[ ! -f "$BACKLOG_FILE" ]]; then
                    log_warn "Linear-only mode: BACKLOG.md not found in $GIT_ROOT — skipping complete-item for $SC_ITEM_ID. Use mcp__linear__update_issue with state=Done."
                    exit 0
                fi
                SC_QUALITY_EVIDENCE="$EVIDENCE_ROOT/quality-${SC_ITEM_ID}.json"
                [[ -f "$SC_QUALITY_EVIDENCE" ]] || die "Quality evidence missing for $SC_ITEM_ID — run quality checks first (expected: $SC_QUALITY_EVIDENCE)"
                move_item_to_completed "$SC_ITEM_ID" "$SC_DATE"
                log_info "$SC_ITEM_ID moved to Completed in BACKLOG.md"
                exit 0
                ;;

            block-item)
                SC_ITEM_ID="${SC_ARGS[0]:-}"
                [[ -n "$SC_ITEM_ID" ]] || die "block-item requires ITEM_ID"
                _sc_setup_env
                if [[ ! -f "$BACKLOG_FILE" ]]; then
                    log_warn "Linear-only mode: BACKLOG.md not found in $GIT_ROOT — skipping block-item for $SC_ITEM_ID. Use mcp__linear__update_issue with labels=[\"blocked\"]."
                    exit 0
                fi
                update_backlog_item_status "$SC_ITEM_ID" "Blocked"
                log_info "$SC_ITEM_ID marked Blocked in BACKLOG.md"
                exit 0
                ;;

            finalize)
                _sc_setup_env
                [[ -f "$STATE_FILE" ]] || die "State file not found at $STATE_FILE"
                finalize_state
                avg_score="$(jq -r '.sessionStats.avgScore' "$STATE_FILE")"
                attempted="$(jq -r '.sessionStats.attempted' "$STATE_FILE")"
                completed_sc="$(jq '[.items[] | select(.status == "completed")] | length' "$STATE_FILE")"
                blocked_sc="$(jq '[.items[] | select(.status == "blocked")] | length' "$STATE_FILE")"
                log_info "Session finalized: attempted=$attempted completed=$completed_sc blocked=$blocked_sc avgScore=$avg_score"
                exit 0
                ;;

            list-completed-ids)
                _sc_setup_env
                [[ -f "$STATE_FILE" ]] || die "State file not found at $STATE_FILE"
                jq -r '[.items[] | select(.status == "completed") | .id] | join(", ")' "$STATE_FILE"
                exit 0
                ;;
        esac
        ;;
esac

# Defaults
UNTIL_CONDITION="10 items"
SCOPE_FILTER="all"
SECTION_FILTER="all"
QUALITY_LEVEL="auto"
MODE="next"
REFLECT_DEPTH="standard"
SPECULATE_MODE="auto"
SCORE_THRESHOLD="0.7"
EVIDENCE_DIR=".claude/ralph-next"
MAX_RETRIES=3
MAX_CI_RETRIES=2
MAX_TRANSITIONS=8
NO_COMPACT="false"
DRY_RUN="false"
ITEM_LIMIT=10
TARGET_ITEM=""
SESSION_LIMIT_SECONDS=0
CHECKPOINT_NAME=""
CHECKPOINT_ITEMS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --until)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --until requires a value" >&2
            exit 1
          }
          UNTIL_CONDITION="$2"
          shift 2
          ;;
        --scope)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --scope requires a value" >&2
            exit 1
          }
          SCOPE_FILTER="$2"
          shift 2
          ;;
        --section)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --section requires a value" >&2
            exit 1
          }
          SECTION_FILTER="$2"
          shift 2
          ;;
        --quality)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --quality requires a value" >&2
            exit 1
          }
          QUALITY_LEVEL="$2"
          shift 2
          ;;
        --next) MODE="next"; shift ;;
        --classic) MODE="classic"; shift ;;
        --reflect-depth)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --reflect-depth requires a value" >&2
            exit 1
          }
          REFLECT_DEPTH="$2"
          shift 2
          ;;
        --speculate)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --speculate requires a value" >&2
            exit 1
          }
          SPECULATE_MODE="$2"
          shift 2
          ;;
        --score-threshold)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --score-threshold requires a value" >&2
            exit 1
          }
          SCORE_THRESHOLD="$2"
          shift 2
          ;;
        --evidence-dir)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --evidence-dir requires a value" >&2
            exit 1
          }
          EVIDENCE_DIR="$2"
          shift 2
          ;;
        --max-retries)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --max-retries requires a value" >&2
            exit 1
          }
          MAX_RETRIES="$2"
          shift 2
          ;;
        --max-ci-retries)
          [ "$#" -ge 2 ] || {
            echo "ralph-next-run: --max-ci-retries requires a value" >&2
            exit 1
          }
          MAX_CI_RETRIES="$2"
          shift 2
          ;;
        --no-compact) NO_COMPACT="true"; shift ;;
        --dry-run) DRY_RUN="true"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

ensure_dependency jq
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$GIT_ROOT" ]] || die "Not in a git repository"
cd "$GIT_ROOT"

BACKLOG_FILE="$GIT_ROOT/BACKLOG.md"
if [[ ! -f "$BACKLOG_FILE" ]]; then
    die "Missing BACKLOG.md at $BACKLOG_FILE — repos migrated to Linear should drive the loop via the orchestrator (Linear MCP), not the legacy CLI main flow. Run 'init' to set up evidence dir, then orchestrate via Linear directly."
fi
PACKAGE_JSON="$GIT_ROOT/package.json"
JS_RUNNER="$(select_js_runner)"

if [[ "$MODE" == "classic" ]]; then
    log_warn "Classic mode selected. Execute /bs:ralph --classic directly in Claude Code."
    exit 0
fi

# Resolve --until condition
if [[ "$UNTIL_CONDITION" =~ ^([0-9]+)[[:space:]]*items?$ ]]; then
    ITEM_LIMIT="${BASH_REMATCH[1]}"
    [[ "$ITEM_LIMIT" -gt 0 && "$ITEM_LIMIT" -le 10000 ]] \
        || die "--until items must be between 1 and 10000: $UNTIL_CONDITION"
elif [[ "$UNTIL_CONDITION" =~ ^([0-9]+)[[:space:]]*hours?$ ]]; then
    ITEM_LIMIT=999999
    # The regex accepts arbitrarily many digits, and `$(( n * 3600 ))` wraps
    # NEGATIVE on 64-bit overflow. The session guard is
    # `[[ $SESSION_LIMIT_SECONDS -gt 0 && ... ]]`, so a negative limit fails the
    # first conjunct and the wall-clock check is skipped for the entire run —
    # an autonomous loop with its time bound silently removed. Bound the input
    # before multiplying rather than trying to detect the overflow after.
    UNTIL_HOURS="${BASH_REMATCH[1]}"
    [[ "$UNTIL_HOURS" -gt 0 && "$UNTIL_HOURS" -le 168 ]] \
        || die "--until hours must be between 1 and 168 (one week): $UNTIL_CONDITION"
    SESSION_LIMIT_SECONDS="$((UNTIL_HOURS * 3600))"
    [[ "$SESSION_LIMIT_SECONDS" -gt 0 ]] \
        || die "--until produced a non-positive session limit: $UNTIL_CONDITION"
elif [[ "$UNTIL_CONDITION" == "empty" ]]; then
    ITEM_LIMIT=999999
elif [[ "$UNTIL_CONDITION" =~ ^item:([A-Z]+-[0-9]+)$ ]]; then
    ITEM_LIMIT=1
    TARGET_ITEM="${BASH_REMATCH[1]}"
elif [[ "$UNTIL_CONDITION" =~ ^checkpoint:(.+)$ ]]; then
    CHECKPOINT_NAME="${BASH_REMATCH[1]}"
    ITEM_LIMIT=999999  # capped to checkpoint item count below
else
    log_warn "Unrecognized --until '$UNTIL_CONDITION'; defaulting to 10 items"
    ITEM_LIMIT=10
fi

# Resolve checkpoint items from BACKLOG.md Checkpoints section
if [[ -n "$CHECKPOINT_NAME" ]]; then
    raw_checkpoint="$(awk -v name="$CHECKPOINT_NAME" '
    /^## Checkpoints/ { in_section=1; next }
    /^## / && in_section { in_section=0; next }
    in_section && /^- \[/ {
        line = $0
        sub(/^- \[.\] */, "", line)
        colon = index(line, ":")
        if (colon > 0) {
            cname = substr(line, 1, colon-1)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", cname)
            if (tolower(cname) == tolower(name)) {
                items = substr(line, colon+1)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", items)
                print items
                exit
            }
        }
    }
    ' "$BACKLOG_FILE")"

    if [[ -z "$raw_checkpoint" ]]; then
        log_warn "Checkpoint '$CHECKPOINT_NAME' not found in BACKLOG.md; defaulting to 10 items"
        ITEM_LIMIT=10
    else
        # Parse "SN-001, SN-002, SN-003" into a bash array, stripping spaces
        IFS=', ' read -r -a raw_items <<< "$raw_checkpoint"
        CHECKPOINT_ITEMS=()
        for item in "${raw_items[@]}"; do
            [[ "$item" =~ ^[A-Z]+-[0-9]+$ ]] && CHECKPOINT_ITEMS+=("$item")
        done
        ITEM_LIMIT="${#CHECKPOINT_ITEMS[@]}"
        log_info "Checkpoint '$CHECKPOINT_NAME': $ITEM_LIMIT items: ${CHECKPOINT_ITEMS[*]}"
    fi
fi

EVIDENCE_ROOT="$(to_abs_path "$EVIDENCE_DIR")"
STATE_FILE="$EVIDENCE_ROOT/state.json"
TRAJECTORY_LOG="$EVIDENCE_ROOT/trajectory-log.jsonl"
EVIDENCE_ITEMS_DIR="$EVIDENCE_ROOT/evidence"
QUALITY_LOG_DIR="$EVIDENCE_ROOT/quality-logs"

items_json="$(collect_candidate_items)"
item_count="$(jq 'length' <<< "$items_json")"

if [[ "$item_count" -eq 0 ]]; then
    log_warn "No pending/ready backlog items matched filters (scope=$SCOPE_FILTER section=$SECTION_FILTER${CHECKPOINT_NAME:+ checkpoint=$CHECKPOINT_NAME})"
    exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
    log_info "Dry run - selected $item_count items"
    jq -r '.[] | "- \(.id) [\(.type)] [effort:\(.effort)] [score:\(.score)] \(.description)"' <<< "$items_json"
    exit 0
fi

# This runner cannot implement backlog items. Its IMPLEMENT state is a
# placeholder and the loop contains no code-writing, commit, or provider call —
# slash-command execution is out of scope for a shell script (see usage).
#
# It previously ran its quality gates against the UNMODIFIED checkout, passed
# them because the repository's own lint passes, and marked items Completed
# having done nothing. Verified: "Implement OAuth login" and "Fix data
# corruption bug" both closed with zero commits and `passed: true` evidence
# written to disk.
#
# Stop here instead. The selection above is the genuinely useful output, and
# /bs:ralph is the supported path that can actually implement (skills/ralph:
# "YOU are the orchestrator ... YOU drive the PICK->IMPLEMENT->QUALITY loop").
# Exit non-zero so an automated caller cannot mistake this for a completed run.
# BS_RALPH_ALLOW_PLACEHOLDER_LOOP=1 re-enables the legacy loop for anyone
# depending on its quality-gate side effects; completion is still gated on
# proof of work, so it can block but never falsely complete.
if [[ "${BS_RALPH_ALLOW_PLACEHOLDER_LOOP:-}" != "1" ]]; then
    log_warn "Selected $item_count item(s), but this runner cannot implement them."
    jq -r '.[] | "  - \(.id) [\(.type)] [effort:\(.effort)] \(.description)"' <<< "$items_json"
    log_warn ""
    log_warn "Orchestrate implementation via /bs:ralph, which drives the"
    log_warn "PICK -> IMPLEMENT -> QUALITY -> REFLECT -> DECIDE loop with a model."
    log_warn "Use the subcommands (pick-items / run-quality / complete-item) to"
    log_warn "script individual steps, or --dry-run to list selections only."
    exit 3
fi

mkdir -p "$EVIDENCE_ITEMS_DIR" "$QUALITY_LOG_DIR"
touch "$TRAJECTORY_LOG"
init_state_file

# Backup BACKLOG.md once per session before any mutations. Timestamped: the
# fixed filename was overwritten by the next run, so after two runs the
# pre-mutation state was unrecoverable — the backup destroyed the very thing it
# existed to preserve. backup_backlog_once is shared with the subcommands.
backup_backlog_once

session_started_epoch="$(date +%s)"
completed=0
blocked=0

while IFS= read -r item; do
    item_id="$(jq -r '.id' <<< "$item")"
    item_description="$(jq -r '.description' <<< "$item")"
    item_type="$(jq -r '.type' <<< "$item")"
    item_effort="$(jq -r '.effort' <<< "$item")"
    item_score_hint="$(jq -r '.score' <<< "$item")"

    now_epoch="$(date +%s)"
    if [[ "$SESSION_LIMIT_SECONDS" -gt 0 && $((now_epoch - session_started_epoch)) -ge "$SESSION_LIMIT_SECONDS" ]]; then
        log_warn "Session time limit reached; stopping"
        break
    fi

    log_info "Processing $item_id - $item_description"

    # Recorded BEFORE the (placeholder) IMPLEMENT state so completion can be
    # gated on the tree actually changing. See item_has_work_evidence.
    item_baseline_head="$(current_head_sha)"
    item_baseline_dirty="$(working_tree_fingerprint)"

    append_trajectory "$item_id" "PICK" '{"mode":"phase2"}'
    append_trajectory "$item_id" "IMPLEMENT" '{"status":"placeholder"}'

    attempts=0
    transitions=2
    last_failure_type=""
    same_failure_streak=0
    final_decision="block"
    final_failure_type=""
    final_score="0"
    final_quality_passed="false"

    while true; do
        attempts=$((attempts + 1))
        quality_log_file="$QUALITY_LOG_DIR/${item_id}-attempt-${attempts}.log"

        append_trajectory "$item_id" "QUALITY" "{\"level\":\"$QUALITY_LEVEL\",\"attempt\":$attempts}"
        transitions=$((transitions + 1))

        quality_result="$(run_quality_checks "$item_id" "$attempts" "$quality_log_file")"
        quality_passed="$(cut -d'|' -f1 <<< "$quality_result")"
        failure_type="$(cut -d'|' -f2 <<< "$quality_result")"

        if [[ "$quality_passed" == "true" ]]; then
            quality_coverage="1"
            learning_value="0.6"
            if [[ "$attempts" -gt 1 ]]; then
                duration_ratio="0.7"
            else
                duration_ratio="1"
            fi
        else
            quality_coverage="0"
            learning_value="0.2"
            duration_ratio="0.6"
        fi

        first_attempt="$(float_div_safe "1" "$attempts")"
        trajectory_score="$(compute_score "$quality_coverage" "$first_attempt" "$duration_ratio" "$learning_value")"

        if [[ -n "$failure_type" && "$failure_type" == "$last_failure_type" ]]; then
            same_failure_streak=$((same_failure_streak + 1))
        elif [[ -n "$failure_type" ]]; then
            last_failure_type="$failure_type"
            same_failure_streak=1
        fi

        append_trajectory "$item_id" "REFLECT" \
            "$(jq -nc \
                --arg failure "$failure_type" \
                --argjson quality_passed "$quality_passed" \
                --argjson score "$trajectory_score" \
                --argjson attempt "$attempts" \
                --argjson streak "$same_failure_streak" \
                '{quality_passed:$quality_passed, failure_type:(if $failure == "" then null else $failure end), score:$score, attempt:$attempt, same_failure_streak:$streak}')"
        transitions=$((transitions + 1))

        decision="$(classify_decision "$quality_passed" "$failure_type" "$trajectory_score" "$same_failure_streak")"
        append_trajectory "$item_id" "DECIDE" "{\"action\":\"$decision\",\"attempt\":$attempts}"
        transitions=$((transitions + 1))

        final_decision="$decision"
        final_failure_type="$failure_type"
        final_score="$trajectory_score"
        final_quality_passed="$quality_passed"

        if [[ "$decision" == "pass" || "$decision" == "marginal" ]]; then
            break
        fi

        if [[ "$transitions" -ge "$MAX_TRANSITIONS" ]]; then
            final_decision="block"
            final_failure_type="${failure_type:-QUALITY_INFRA_FAIL}"
            append_trajectory "$item_id" "BLOCK" "{\"reason\":\"transition-guard\",\"transitions\":$transitions}"
            transitions=$((transitions + 1))
            break
        fi

        if [[ "$decision" == "retry" || "$decision" == "retry-quality-only" ]]; then
            failure_budget="$(get_failure_budget "$failure_type")"
            if [[ "$attempts" -lt "$MAX_RETRIES" && "$same_failure_streak" -le "$failure_budget" ]]; then
                append_trajectory "$item_id" "IMPLEMENT" "{\"retry\":$attempts,\"failure_type\":\"$failure_type\"}"
                transitions=$((transitions + 1))
                continue
            fi

            final_decision="block"
            append_trajectory "$item_id" "BLOCK" "{\"reason\":\"retry-exhausted\",\"attempt\":$attempts,\"failure_type\":\"$failure_type\"}"
            transitions=$((transitions + 1))
            break
        fi

        if [[ "$decision" == "split" || "$decision" == "speculate" || "$decision" == "escalate" || "$decision" == "block" ]]; then
            append_trajectory "$item_id" "BLOCK" "{\"reason\":\"$decision\",\"attempt\":$attempts,\"failure_type\":\"$failure_type\"}"
            transitions=$((transitions + 1))
            break
        fi

        append_trajectory "$item_id" "BLOCK" "{\"reason\":\"unknown-decision\",\"decision\":\"$decision\"}"
        transitions=$((transitions + 1))
        final_decision="block"
        break
    done

    item_status="blocked"
    if [[ "$final_decision" == "pass" || "$final_decision" == "marginal" ]]; then
        # Proof of work. The IMPLEMENT state in this loop is a placeholder —
        # this script cannot invoke /bs:ralph or /bs:quality (see usage), so it
        # never writes code. Without this gate the loop ran quality checks
        # against an UNMODIFIED tree, passed them because the repo's own lint
        # passes, scored the pass, and marked the item Completed having done
        # nothing: "Implement OAuth login" closed with zero commits.
        #
        # Requiring a real change is what separates "the work succeeded" from
        # "no work was attempted". A quality gate that never saw a diff is
        # evidence about the previous commit, not about this item.
        if item_has_work_evidence "$item_baseline_head"; then
            item_status="completed"
            completed=$((completed + 1))
        else
            append_trajectory "$item_id" "BLOCK" \
                '{"reason":"no-work-evidence","detail":"tree unchanged since PICK; this runner cannot implement items"}'
            log_warn "$item_id: no code change since PICK — refusing to mark Completed."
            log_warn "  This runner performs quality gates only; orchestrate implementation via /bs:ralph."
            final_decision="block"
            blocked=$((blocked + 1))
        fi
    else
        blocked=$((blocked + 1))
    fi

    if [[ "$final_quality_passed" == "true" ]]; then
        quality_passed_json=true
    else
        quality_passed_json=false
    fi

    update_state_item "$item_id" "$item_status" "$final_decision" "$final_failure_type" "$final_score" "$quality_passed_json" "$attempts"

    # Update BACKLOG.md to reflect outcome
    if [[ "$item_status" == "completed" ]]; then
        move_item_to_completed "$item_id" "$(date +%Y-%m-%d)"
        log_info "$item_id moved to Completed in BACKLOG.md"
    else
        update_backlog_item_status "$item_id" "Blocked"
        log_info "$item_id marked Blocked in BACKLOG.md"
    fi

    item_evidence_file="$EVIDENCE_ITEMS_DIR/$item_id.json"
    jq -n \
        --arg item_id "$item_id" \
        --arg description "$item_description" \
        --arg item_type "$item_type" \
        --arg effort "$item_effort" \
        --argjson score_hint "$item_score_hint" \
        --arg quality_level "$QUALITY_LEVEL" \
        --argjson quality_passed "$final_quality_passed" \
        --arg failure_type "$final_failure_type" \
        --arg decision "$final_decision" \
        --arg status "$item_status" \
        --argjson trajectory_score "$final_score" \
        --argjson threshold "$SCORE_THRESHOLD" \
        --argjson attempts "$attempts" \
        --argjson transitions "$transitions" \
        --arg reflect_depth "$REFLECT_DEPTH" \
        --arg speculate_mode "$SPECULATE_MODE" \
        --arg startedAt "$(date -Iseconds)" \
        '{
          item_id: $item_id,
          description: $description,
          item_type: $item_type,
          effort: $effort,
          backlog_score_hint: $score_hint,
          quality: {
            level: $quality_level,
            passed: $quality_passed,
            failure_type: (if $failure_type == "" then null else $failure_type end)
          },
          score: {
            trajectory: $trajectory_score,
            threshold: $threshold,
            components: {
              quality_coverage: (if $quality_passed then 1 else 0 end),
              first_attempt: (1 / $attempts),
              duration_ratio: (if $attempts > 1 then 0.7 else 1 end),
              learning_value: (if $quality_passed then 0.6 else 0.2 end)
            }
          },
          decision: $decision,
          status: $status,
          attempts: $attempts,
          transitions: $transitions,
          reflect_depth: $reflect_depth,
          speculate_mode: $speculate_mode,
          startedAt: $startedAt,
          updatedAt: (now | todate)
        }' > "$item_evidence_file"

    if [[ "$item_status" == "completed" && "$NO_COMPACT" == "false" ]]; then
        log_info "COMPACT_SIGNAL: $item_id complete — run /compact now to drop context before next item (skip with --no-compact)"
    fi

done < <(jq -c '.[]' <<< "$items_json")

finalize_state

avg_score="$(jq -r '.sessionStats.avgScore' "$STATE_FILE")"
attempted="$(jq -r '.sessionStats.attempted' "$STATE_FILE")"

log_info "Session complete"
log_info "  Attempted: $attempted"
log_info "  Completed: $completed"
log_info "  Blocked: $blocked"
log_info "  Avg trajectory score: $avg_score"
log_info "  State: $STATE_FILE"
log_info "  Trajectory log: $TRAJECTORY_LOG"
log_info "  BACKLOG.md backup: ${BACKLOG_FILE}.ralph-next-backup-*"
