#!/usr/bin/env bash
# Provider-neutral, revision-bound blocking review.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QUALITY_CODEX_SOURCE_HOME="${QUALITY_CODEX_SOURCE_HOME:-${CODEX_HOME:-$HOME/.codex}}"
export QUALITY_CODEX_SOURCE_HOME
MANIFEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-run-review: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    *) echo "quality-run-review: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || { echo "quality-run-review: --manifest is required" >&2; exit 1; }
source "$SCRIPT_DIR/quality-repo-lease-pin.sh" || exit 1
quality_pin_repository_lease "$MANIFEST" || exit 1

bash "$SCRIPT_DIR/quality-load-root.sh" --manifest "$MANIFEST" >/dev/null || exit 1
field() { node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" "$1"; }
GIT_ROOT="$(field repo.realpath)"
BS_QUALITY_INVOCATION_ID="$(field invocationId)"
BASE_SHA="$(field revisions.baseSha)"
RESOLVED_BASE="$(field revisions.baseRef)"
TIER="$(field risk.tier)"
REVIEW_CONTRACT_VERSION="$(field reviewContractVersion)"
CODEX_DEPTH="$(field risk.codexDepth)"
CODEX_ROUNDS="$(field risk.codexRounds)"
BS_QUALITY_PRIMARY="$(field provider.primaryOverride)"
BS_QUALITY_FALLBACK="$(field provider.fallbackOverride)"
BS_QUALITY_PROVIDER_CONFIG="$(field provider.config)"
export BS_QUALITY_PRIMARY BS_QUALITY_FALLBACK BS_QUALITY_PROVIDER_CONFIG
cd "$GIT_ROOT" || exit 1
bash "$SCRIPT_DIR/quality-assert-clean.sh" \
  --manifest "$MANIFEST" --phase "blocking review" || exit 1
# shellcheck source=quality-provider-policy.sh
source "$SCRIPT_DIR/quality-provider-policy.sh" || exit 1
# shellcheck source=quality-review-plan.sh
source "$SCRIPT_DIR/quality-review-plan.sh"

REVIEW_INFO="$(node "$SCRIPT_DIR/quality-invocation.js" review-info "$MANIFEST")" || exit 1
REVIEW_ROUND="$(printf '%s' "$REVIEW_INFO" | jq -r '.round')"
if [ "$REVIEW_ROUND" -gt 1 ]; then
  # A mandatory fix-validation pass owns its own provider allowance. The
  # verification reserve is campaign-planning metadata, not a provider
  # timeout; using it here made large reviews time out before they could
  # validate otherwise-complete remediation. Legacy manifests predate the
  # persisted validation allowance and use the bounded default.
  QUALITY_REVIEW_TIMEOUT="$(field risk.runtime.reviewReserveSeconds)"
  [ -n "$QUALITY_REVIEW_TIMEOUT" ] || QUALITY_REVIEW_TIMEOUT=300
  QUALITY_REVIEW_PASSES=1
  QUALITY_REVIEW_DEPTH=high
  QUALITY_REVIEW_FOCUS="Targeted verification only: prove each prior blocker is fixed and inspect the fix delta for regressions. Automated gates already passed. Use only the supplied evidence; do not run commands or tests. Return the final structured verdict immediately after static analysis."
else
  QUALITY_REVIEW_TIMEOUT="$(field risk.runtime.reviewSeconds)"
fi

REVIEW_DIFF_BASE="$(printf '%s' "$REVIEW_INFO" | jq -r '.from')"
REVIEWED_HEAD="$(printf '%s' "$REVIEW_INFO" | jq -r '.to')"
REVIEW_OUT="$(printf '%s' "$REVIEW_INFO" | jq -r '.artifactDir')"
[ "$REVIEWED_HEAD" = "$(git rev-parse HEAD)" ] || {
  echo "quality-run-review: manifest HEAD changed before review" >&2
  exit 1
}

# A provider review can run for several minutes.  The branch may advance while
# that provider is working (a second campaign, a human commit, or an automated
# formatter).  Never attach the resulting evidence to a different revision:
# the manifest is exact-head bound, so a moved head supersedes this campaign
# and the caller must start/resume a fresh campaign for the new revision.
assert_reviewed_head_current() {
  local current_head
  current_head="$(git rev-parse HEAD 2>/dev/null)" || {
    echo "quality-run-review: cannot resolve current HEAD before recording review evidence" >&2
    return 1
  }
  if [ "$current_head" != "$REVIEWED_HEAD" ]; then
    echo "quality-run-review: reviewed HEAD moved during provider review (expected $REVIEWED_HEAD, found $current_head); refusing to record evidence" >&2
    node "$SCRIPT_DIR/quality-invocation.js" terminal-state "$MANIFEST" \
      --state superseded --detail "head-moved-during-review" >/dev/null || true
    return 1
  fi
}

mkdir -p "$REVIEW_OUT"
git diff "${REVIEW_DIFF_BASE}..${REVIEWED_HEAD}" > "$REVIEW_OUT/diff.txt"
git diff --name-only "${REVIEW_DIFF_BASE}..${REVIEWED_HEAD}" > "$REVIEW_OUT/files.txt"

# A gitlink is executable policy, not a text-only pointer. When the reviewed
# repository advances a `core` submodule, include the exact recursive diff in
# the immutable review envelope so providers cannot approve an opaque trusted
# control-plane update. Repositories without a gitlink are unchanged.
# `git rev-parse <commit>:core` is not a safe existence test: for a missing
# path Git can echo the path expression before returning non-zero. Read the
# tree entry and require mode 160000 so ordinary repositories without a core
# submodule never enter the recursive-review branch.
BASE_CORE_SHA="$(git ls-tree "$REVIEW_DIFF_BASE" -- core |
  awk '$1 == "160000" && $2 == "commit" {print $3}')"
HEAD_CORE_SHA="$(git ls-tree "$REVIEWED_HEAD" -- core |
  awk '$1 == "160000" && $2 == "commit" {print $3}')"
# A changed gitlink is executable policy, so an uninitialized checkout cannot
# silently degrade the review to an opaque pointer-only diff.
if { [ -n "$BASE_CORE_SHA" ] || [ -n "$HEAD_CORE_SHA" ]; }; then
  [ -n "$BASE_CORE_SHA" ] && [ -n "$HEAD_CORE_SHA" ] || {
    echo "quality-run-review: core gitlink exists on only one side of the diff" >&2
    exit 1
  }
  if [ "$BASE_CORE_SHA" != "$HEAD_CORE_SHA" ]; then
    if ! { [ -d core/.git ] || [ -f core/.git ]; }; then
      echo "quality-run-review: changed core gitlink requires an initialized checkout for recursive review" >&2
      exit 1
    fi
    git -C core cat-file -e "$BASE_CORE_SHA^{commit}" 2>/dev/null || {
      echo "quality-run-review: base core commit is unavailable for recursive review" >&2
      exit 1
    }
    git -C core cat-file -e "$HEAD_CORE_SHA^{commit}" 2>/dev/null || {
      echo "quality-run-review: head core commit is unavailable for recursive review" >&2
      exit 1
    }
    {
      printf '\n===== recursive submodule diff: core %s..%s =====\n' \
        "$BASE_CORE_SHA" "$HEAD_CORE_SHA"
      git -C core diff --submodule=diff "$BASE_CORE_SHA" "$HEAD_CORE_SHA"
      printf '===== end recursive submodule diff: core =====\n'
    } >> "$REVIEW_OUT/diff.txt"
    git -C core diff --name-only "$BASE_CORE_SHA" "$HEAD_CORE_SHA" |
      sed 's#^#core/#' >> "$REVIEW_OUT/files.txt"
  fi
fi
git log "${REVIEW_DIFF_BASE}..${REVIEWED_HEAD}" --oneline > "$REVIEW_OUT/log.txt"
node "$SCRIPT_DIR/quality-invocation.js" review-identity "$MANIFEST" \
  > "$REVIEW_OUT/identity.json" || exit 1
printf '%s\n' "$QUALITY_REVIEW_FOCUS" > "$REVIEW_OUT/review-focus.txt"
PRIOR_FINDINGS_FILE=""
PROVIDER_HEALTH="$SCRIPT_DIR/quality-provider-health.js"
if [ "$REVIEW_ROUND" -gt 1 ]; then
  PRIOR_FINDINGS_FILE="$REVIEW_OUT/prior-findings.json"
  node "$SCRIPT_DIR/quality-invocation.js" prior-findings "$MANIFEST" \
    > "$PRIOR_FINDINGS_FILE" || exit 1
fi
if [ "$TIER" = low ]; then
  printf '%s\n' \
    "AI REVIEW NOT REQUIRED. This exact diff is covered by the low-risk zero-reviewer policy." \
    > "$REVIEW_OUT/policy-exempt.findings.txt"
  DIFF_SHA="$(shasum -a 256 "$REVIEW_OUT/diff.txt" | awk '{print $1}')"
  jq --arg diffSha256 "$DIFF_SHA" '{
    schemaVersion: 1,
    aiReviewRequired: false,
    head: .headSha,
    tier,
    reviewContractVersion,
    reviewPolicyDigest,
    agentsSha256,
    domain: .panelDomain,
    selectionRule: .panelRule,
    diffSha256: $diffSha256
  }' "$REVIEW_OUT/identity.json" > "$REVIEW_OUT/policy-exempt.result.json" || exit 1
  node "$SCRIPT_DIR/quality-invocation.js" inventory "$MANIFEST" \
    --artifact-dir "$REVIEW_OUT" --provider policy-exempt --exempt || exit 1
  node "$SCRIPT_DIR/quality-invocation.js" record-policy-exempt-review "$MANIFEST" \
    --from "$REVIEW_DIFF_BASE" \
    --to "$REVIEWED_HEAD" \
     --primary "$QUALITY_PRIMARY" \
     --fallback "$QUALITY_FALLBACK" \
     --validate-remote-head true \
     --artifact-dir "$REVIEW_OUT" \
    --diff-sha "$DIFF_SHA" || exit 1
  echo "ℹ️  [quality] low-risk policy requires deterministic gates and no AI reviewer." >&2
  echo "REVIEW_OUT=$REVIEW_OUT"
  echo "REVIEW_BASE=$RESOLVED_BASE"
  echo "REVIEW_DIFF_BASE=$REVIEW_DIFF_BASE"
  echo "REVIEW_PROVIDER=policy-exempt"
  exit 0
fi

REVIEW_INPUT_MODE=discovery
if [ "$REVIEW_ROUND" -gt 1 ]; then
  REVIEW_INPUT_MODE=verification
fi
REVIEW_INPUT_ARGS=(
  build
  --output "$REVIEW_OUT/review-prompt.txt"
  --input-output "$REVIEW_OUT/review-input.json"
  --mode "$REVIEW_INPUT_MODE"
  --focus "$REVIEW_OUT/review-focus.txt"
  --identity "$REVIEW_OUT/identity.json"
  --files "$REVIEW_OUT/files.txt"
  --log "$REVIEW_OUT/log.txt"
  --diff "$REVIEW_OUT/diff.txt"
)
if [ "$REVIEW_ROUND" -gt 1 ]; then
  REVIEW_INPUT_ARGS+=(--prior-findings "$PRIOR_FINDINGS_FILE")
fi
node "$SCRIPT_DIR/quality-review-input.js" "${REVIEW_INPUT_ARGS[@]}" || exit 1

record_provider_exhaustion() {
  local provider="$1" evidence="$2" reset_at
  node "$SCRIPT_DIR/quality-provider-error.js" describe "$evidence" |
    jq --arg provider "$provider" '. + {provider: ($provider | ascii_downcase)}' \
      > "$REVIEW_OUT/provider-failure.json" || return 1
  reset_at="$(jq -r '.resetAt // "time unavailable"' "$REVIEW_OUT/provider-failure.json")"
  printf '%s provider exhausted (structured error metadata; reset %s)\n' \
    "$provider" "$reset_at" > "$REVIEW_OUT/provider-exhausted"
}

terminal_diagnosis() {
  local category="$1" provider="${2:-}" reset_at="${3:-}"
  local args=(--manifest "$MANIFEST" --category "$category")
  [ -n "$provider" ] && args+=(--provider "$provider")
  [ -n "$reset_at" ] && args+=(--reset-at "$reset_at")
  node "$SCRIPT_DIR/quality-terminal-status.js" "${args[@]}" || true
  # Persist the terminal state alongside the human-readable diagnosis, so a
  # campaign that ended is distinguishable from one still running by reading
  # the manifest alone. Without this the two are byte-identical on disk
  # (activeExecution is null either way) and only a stale lastActivityAt hints
  # at the difference. Write-once: the first cause recorded wins.
  local state
  case "$category" in
    parser-inconclusive) state=provider-incomplete ;;
    provider-contract-failed) state=provider-contract-failed ;;
    provider-timeout | provider-governor) state=timeout ;;
    *) state=blocked ;;
  esac
  node "$SCRIPT_DIR/quality-invocation.js" terminal-state "$MANIFEST" \
    --state "$state" --detail "$category" >/dev/null || true
}

authorize_provider_attempt() {
  local provider="$1" requested_timeout="$2" authorization remaining
  authorization="$(node "$SCRIPT_DIR/quality-invocation.js" provider-attempt \
    "$MANIFEST" --provider "$provider" \
    --requested-timeout "$requested_timeout")" || return 77
  remaining="$(printf '%s' "$authorization" | jq -r '.remainingSeconds')"
  [ "$remaining" -gt 0 ] || return 77
  if [ "$requested_timeout" -lt "$remaining" ]; then
    printf '%s\n' "$requested_timeout"
  else
    printf '%s\n' "$remaining"
  fi
}

complete_provider_attempt() {
  local provider="$1" started_at="$2" elapsed
  elapsed=$((SECONDS - started_at))
  node "$SCRIPT_DIR/quality-invocation.js" provider-complete \
    "$MANIFEST" --provider "$provider" --elapsed-seconds "$elapsed"
}

run_claude_review() {
  local agents_csv rc attempt_timeout attempt_started
  local companion_args=()
  command -v claude >/dev/null 2>&1 || return 2
  claude auth status --json 2>/dev/null | jq -e '.loggedIn == true' >/dev/null 2>&1 || return 2
  agents_csv="$(node "$SCRIPT_DIR/quality-invocation.js" get "$MANIFEST" agents \
    | jq -r 'join(",")')"
  [ -n "$agents_csv" ] || { echo "quality: Claude panel unresolved" >&2; return 1; }
  attempt_timeout="$(authorize_provider_attempt claude "$QUALITY_REVIEW_TIMEOUT")" \
    || return 77
  companion_args=(
    --diff-file "$REVIEW_OUT/diff.txt" \
    --files-file "$REVIEW_OUT/files.txt" \
    --log-file "$REVIEW_OUT/log.txt" \
    --identity-file "$REVIEW_OUT/identity.json" \
    --out-dir "$REVIEW_OUT" \
    --agents "$agents_csv" \
    --tier "$TIER" \
    --focus "$QUALITY_REVIEW_FOCUS" \
    --prompt-file "$REVIEW_OUT/review-prompt.txt" \
    --timeout "$attempt_timeout"
  )
  if [ "$REVIEW_ROUND" -gt 1 ]; then
    companion_args+=(--review-mode verification \
      --prior-findings-file "$PRIOR_FINDINGS_FILE")
  fi
  attempt_started=$SECONDS
  bash "$SCRIPT_DIR/claude-review-companion.sh" "${companion_args[@]}"
  rc=$?
  complete_provider_attempt claude "$attempt_started" || return 1
  return "$rc"
}

render_structured_review() {
  local normalized_file="$1" findings_file="$2"
  if ! jq -r '
    if (.findings | length) == 0 then "NO FINDINGS. Verdict: \(.verdict). \(.summary)"
    else .findings[] | "\(.severity // "WARNING"): \(.file // "unknown"):\(.line_start // 0) — \(.title // "finding")\n\(.body // "")\nFix: \(.recommendation // "")"
    end' "$normalized_file" >> "$findings_file"; then
    # A normalized payload whose rendering failed is part of the inconclusive
    # pass, not authoritative completed-pass evidence.
    rm -f "$normalized_file"
    return 1
  fi
}

classify_structured_provider_failure() {
  local provider="$1" evidence="$2" failure_json category
  failure_json="$(node "$SCRIPT_DIR/quality-provider-error.js" describe \
    "$evidence" 2>/dev/null)" || return 1
  category="$(printf '%s' "$failure_json" | jq -r '.category')"
  printf '%s' "$failure_json" |
    jq --arg provider "$provider" '. + {provider: $provider}' \
      > "$REVIEW_OUT/provider-failure.json" || return 1
  case "$category" in
    provider-exhaustion) return 75 ;;
    provider-billing) return 79 ;;
    provider-input-too-large) return 78 ;;
    *) return 1 ;;
  esac
}

run_codex_review() {
  local bounded normalizer schema raw_file normalized_file error_file rc pass pass_timeout
  local auth_output prompt_file attempt_started failure_rc
  bounded="$SCRIPT_DIR/quality-run-bounded.sh"
  normalizer="$SCRIPT_DIR/quality-normalize-codex-review.sh"
  schema="$SCRIPT_DIR/schemas/quality-review-output.schema.json"
  [ -f "$schema" ] || return 2
  command -v codex >/dev/null 2>&1 || return 2
  # Isolate cache state by installed CLI version. The desktop app can continue
  # to update the operator home without invalidating an active quality review.
  CODEX_HOME="$(bash "$SCRIPT_DIR/quality-codex-home.sh")" || return 2
  export CODEX_HOME
  # Probe the version-scoped cache. A failed one-shot regeneration still makes
  # Codex unavailable so the runner can use its fallback without a long stall.
  if ! bash "$SCRIPT_DIR/quality-codex-cache-guard.sh"; then
    return 2
  fi
  auth_output="$(bash "$bounded" --timeout 10 -- \
    codex login status 2>&1)"
  rc=$?
  [ "$rc" -eq 124 ] && return 76
  [ "$rc" -eq 0 ] || return 2
  printf '%s' "$auth_output" | grep -q 'Logged in' || return 2
  case "$QUALITY_REVIEW_PASSES" in
    1|2) ;;
    *) echo "quality: Codex review passes must be 1 or 2" >&2; return 64 ;;
  esac

  : > "$REVIEW_OUT/codex.findings.txt"
  pass_timeout=$((QUALITY_REVIEW_TIMEOUT / QUALITY_REVIEW_PASSES))
  [ "$pass_timeout" -ge 30 ] || pass_timeout=30
  pass=1
  while [ "$pass" -le "$QUALITY_REVIEW_PASSES" ]; do
    raw_file="$REVIEW_OUT/codex-${pass}.json"
    normalized_file="$REVIEW_OUT/codex-${pass}.normalized.json"
    error_file="$REVIEW_OUT/codex-${pass}.stderr"
    prompt_file="$REVIEW_OUT/codex-${pass}.prompt"
    {
      echo "Perform the bounded static review now."
      echo "Use only the supplied review envelope; do not run commands, inspect the repository, or expand context."
      cat "$REVIEW_OUT/review-prompt.txt"
    } > "$prompt_file"
    pass_timeout="$(authorize_provider_attempt codex "$pass_timeout")" \
      || return 77
    attempt_started=$SECONDS
    # The complete review envelope is prepared before this clock starts. Run
    # from the artifact directory with no Git repository so Codex cannot spend
    # the review budget rediscovering repository context.
    # The fixed envelope below is the sole repository-controlled review data.
    # Do not load optional MCP configuration; unrelated, stale OAuth grants
    # must not block a review that only needs the supplied envelope.
    bash "$bounded" --timeout "$pass_timeout" -- \
      codex exec --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check -s read-only --json \
      --model "$QUALITY_CODEX_MODEL" \
      -C "$REVIEW_OUT" \
      -c "model_reasoning_effort=\"$QUALITY_REVIEW_DEPTH\"" \
      --output-schema "$schema" -o "$raw_file" - \
      < "$prompt_file" \
      > "$REVIEW_OUT/codex-${pass}.progress" 2>"$error_file"
    rc=$?
    complete_provider_attempt codex "$attempt_started" || return 1
    if [ "$rc" -ne 0 ]; then
      [ "$rc" -eq 124 ] && return 76
      if node "$SCRIPT_DIR/quality-provider-error.js" \
        "$REVIEW_OUT/codex-${pass}.progress"; then
        record_provider_exhaustion Codex "$REVIEW_OUT/codex-${pass}.progress"
        return 75
      fi
      if FAILURE_JSON="$(node "$SCRIPT_DIR/quality-provider-error.js" describe \
        "$REVIEW_OUT/codex-${pass}.progress" 2>/dev/null)" &&
        [ "$(printf '%s' "$FAILURE_JSON" | jq -r '.category')" = provider-billing ]; then
        printf '%s' "$FAILURE_JSON" |
          jq '. + {provider: "codex"}' > "$REVIEW_OUT/provider-failure.json"
        return 79
      fi
      classify_structured_provider_failure codex "$error_file"
      failure_rc=$?
      case "$failure_rc" in 75|78|79) return "$failure_rc" ;; esac
      # Codex refreshes MCP OAuth before starting the review. A rejected refresh
      # token prevents the reviewer from running at all, so it is provider
      # unavailability rather than a review or parser failure. Keep this match
      # deliberately narrow: other rc=1 errors remain fail-closed.
      grep -Eiq 'not authenticated|not logged in|login required|setup required|OAuth token refresh failed:.*invalid_grant' "$error_file" 2>/dev/null && return 2
      return 1
    fi
    if ! bash "$normalizer" "$raw_file" "$normalized_file"; then
      echo "INCONCLUSIVE: Codex output could not be parsed — human review required" >> "$REVIEW_OUT/codex.findings.txt"
      return 4
    fi
    if ! render_structured_review "$normalized_file" \
      "$REVIEW_OUT/codex.findings.txt"; then
      echo "INCONCLUSIVE: normalized Codex findings could not be rendered — human review required" >> "$REVIEW_OUT/codex.findings.txt"
      return 4
    fi
    pass=$((pass + 1))
  done
}

run_gemini_review() {
  local bounded normalizer schema raw_file normalized_file error_file
  local prompt_file rc pass pass_timeout focus failure_rc attempt_started
  bounded="$SCRIPT_DIR/quality-run-bounded.sh"
  normalizer="$SCRIPT_DIR/quality-normalize-gemini-review.js"
  schema="$SCRIPT_DIR/schemas/quality-review-output.schema.json"
  [ -f "$schema" ] || return 2
  command -v gemini >/dev/null 2>&1 || return 2
  case "$QUALITY_REVIEW_PASSES" in
    1|2) ;;
    *) echo "quality: Gemini review passes must be 1 or 2" >&2; return 64 ;;
  esac

  : > "$REVIEW_OUT/gemini.findings.txt"
  pass_timeout=$((QUALITY_REVIEW_TIMEOUT / QUALITY_REVIEW_PASSES))
  [ "$pass_timeout" -ge 30 ] || pass_timeout=30
  pass=1
  while [ "$pass" -le "$QUALITY_REVIEW_PASSES" ]; do
    raw_file="$REVIEW_OUT/gemini-${pass}.json"
    normalized_file="$REVIEW_OUT/gemini-${pass}.normalized.json"
    error_file="$REVIEW_OUT/gemini-${pass}.stderr"
    prompt_file="$REVIEW_OUT/gemini-${pass}.prompt"
    if [ "$pass" -eq 1 ]; then
      focus="correctness, security, reliability, and silent failure paths"
    else
      focus="test adequacy, performance, architecture, and accidental complexity"
    fi
    {
      echo "Review focus for pass $pass/$QUALITY_REVIEW_PASSES: $focus."
      echo "Return one response INSTANCE with exactly the top-level keys verdict, summary, and findings."
      echo "Never return JSON Schema definition keys such as \$schema, type, properties, required, or additionalProperties."
      echo "Use verdict=approve only with zero findings. Use needs-attention with one or more actionable findings."
      echo "The next block is the trusted JSON Schema definition for validation, not the response instance."
      cat "$schema"
      cat "$REVIEW_OUT/review-prompt.txt"
    } > "$prompt_file"
    pass_timeout="$(authorize_provider_attempt gemini "$pass_timeout")" \
      || return 77
    attempt_started=$SECONDS
    bash "$bounded" --timeout "$pass_timeout" -- \
      gemini --skip-trust --approval-mode plan --output-format json \
        -p "Perform the bounded static review supplied on stdin. Return only a JSON response instance with exactly verdict, summary, and findings; never echo or merge the JSON Schema definition." \
        < "$prompt_file" > "$raw_file" 2> "$error_file"
    rc=$?
    complete_provider_attempt gemini "$attempt_started" || return 1
    classify_structured_provider_failure gemini "$raw_file"
    failure_rc=$?
    case "$failure_rc" in 75|79) return "$failure_rc" ;; esac
    classify_structured_provider_failure gemini "$error_file"
    failure_rc=$?
    case "$failure_rc" in 75|79) return "$failure_rc" ;; esac
    if [ "$rc" -ne 0 ]; then
      [ "$rc" -eq 124 ] && return 76
      grep -Eiq 'not authenticated|not logged in|login required|setup required|api key.*(?:missing|not found)' "$error_file" 2>/dev/null && return 2
      return 1
    fi
    if ! node "$normalizer" "$raw_file" "$normalized_file"; then
      echo "INCONCLUSIVE: Gemini output could not be parsed — human review required" >> "$REVIEW_OUT/gemini.findings.txt"
      return 4
    fi
    if ! render_structured_review "$normalized_file" \
      "$REVIEW_OUT/gemini.findings.txt"; then
      echo "INCONCLUSIVE: normalized Gemini findings could not be rendered — human review required" >> "$REVIEW_OUT/gemini.findings.txt"
      return 4
    fi
    pass=$((pass + 1))
  done
}

provider_live_probe() {
  local provider="$1" output rc
  case "$provider" in
    claude)
      command -v claude >/dev/null 2>&1 || return 1
      output="$(bash "$SCRIPT_DIR/quality-run-bounded.sh" --timeout 10 -- \
        claude auth status --json 2>/dev/null)"
      rc=$?
      [ "$rc" -eq 0 ] || return 1
      printf '%s' "$output" | jq -e '.loggedIn == true' >/dev/null 2>&1
      ;;
    codex)
      command -v codex >/dev/null 2>&1 || return 1
      output="$(bash "$SCRIPT_DIR/quality-run-bounded.sh" --timeout 10 -- \
        codex login status 2>&1)"
      rc=$?
      [ "$rc" -eq 0 ] || return 1
      printf '%s' "$output" | grep -q 'Logged in'
      ;;
    gemini)
      command -v gemini >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

run_provider() {
  local provider="$1" availability rc
  availability="$(node "$PROVIDER_HEALTH" check "$provider")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # Provider health is a backoff hint, not proof that the account is still
    # unavailable. A cheap live CLI/auth probe prevents a stale exhaustion
    # record from suppressing a currently healthy fallback provider.
    echo "⚠️  [quality] $provider has a cached provider-health failure; probing live availability." >&2
    if provider_live_probe "$provider"; then
      node "$PROVIDER_HEALTH" clear "$provider" || return 1
      availability='{"available":true,"probe":true}'
      rc=0
    else
      printf '%s' "$availability" |
        jq --arg provider "$provider" '. + {provider: $provider}' \
          > "$REVIEW_OUT/provider-failure.json"
      echo "⚠️  [quality] skipping $provider: live provider probe failed." >&2
      return "$rc"
    fi
  fi
  case "$provider" in
    claude) run_claude_review ;;
    codex) run_codex_review ;;
    gemini) run_gemini_review ;;
    *) return 2 ;;
  esac
  rc=$?
  if [ "$rc" -eq 0 ]; then
    node "$PROVIDER_HEALTH" clear "$provider" || return 1
  elif { [ "$rc" -eq 75 ] || [ "$rc" -eq 79 ]; } &&
    [ -s "$REVIEW_OUT/provider-failure.json" ]; then
    node "$PROVIDER_HEALTH" record "$provider" \
      "$REVIEW_OUT/provider-failure.json" || return 1
  fi
  return "$rc"
}

# Should a primary that exhausts its bounded review clock without converging
# (rc=76, from a 124 timeout) fail over to the fallback? Two competing goals:
#   - #104 bounded total review time: DON'T fall back on timeout — a second full
#     review doubles the clock, and on a genuinely huge diff the fallback times
#     out too, so you burn both clocks and still block.
#   - Resilience: a DEGRADED primary (e.g. a broken codex models-cache stalling
#     model resolution) times out on diffs the fallback reviews in seconds — here
#     blocking every merge while a healthy fallback sits idle is the wrong call.
# It's therefore configurable. Default TRUE: in practice a stalled primary
# blocking merges outright is worse than an occasional bounded double-review,
# and the fallback runs exactly ONCE (a fallback rc=76 hard-blocks below — no
# loop, so the total is at most two review clocks, never unbounded). Set
# BS_QUALITY_FALLBACK_ON_TIMEOUT=0 to restore the strict single-clock bound.
FALLBACK_ON_TIMEOUT="${BS_QUALITY_FALLBACK_ON_TIMEOUT:-1}"

REVIEW_PROVIDER="$QUALITY_PRIMARY"
echo "[quality] reviewer policy: primary=$QUALITY_PRIMARY fallback=$QUALITY_FALLBACK (fallback-on-timeout=$FALLBACK_ON_TIMEOUT)" >&2
run_provider "$QUALITY_PRIMARY"
PROVIDER_RC=$?

# rc=76 (bounded-budget timeout without converging) fails over to the fallback
# when configured. Exhaustion, billing, and unavailability always fail over
# because they cannot produce review evidence. Native Codex and Gemini both
# report parser-inconclusive output structurally the same way (rc=4) and both
# fail over for the same reason: their normalized-output parser rejected the
# response, not the model. Claude's rc=4 currently combines parser, timeout,
# and unresolved-agent failures, so it remains fail-closed rather than masking
# those distinct causes or bypassing the timeout policy. A parser failure is
# not promoted to a clean result: the fallback must independently complete,
# and an inconclusive fallback remains terminal below. The fallback attempt
# cannot overrun the invocation: authorize_provider_attempt caps it against
# the cumulative active-provider ledger and returns 77 when no budget remains.
#
# rc=77 from the PRIMARY (BUI-348): authorize_provider_attempt already
# refuses to LAUNCH a provider once provider budget is too tight — this is
# the scope-degradation signal, not a guillotine, because nothing was ever
# started. Before this fallback triggered on 77, a primary that correctly
# declined to start (e.g. Claude skipping its panel because too little
# budget remained) hard-blocked the campaign even when a fallback provider
# had enough remaining budget to run. Falling back here reuses the exact
# same machinery as every other primary failure mode below; a fallback that
# ALSO returns 77 (no budget left for anyone) falls through unchanged to the
# rc=77 terminal case further down — no new failure mode, no loop risk,
# since run_provider is called at most twice in this script.
PRIMARY_HAS_STRUCTURED_RC4=false
case "$QUALITY_PRIMARY" in
  codex | gemini) PRIMARY_HAS_STRUCTURED_RC4=true ;;
esac
# QUALITY_FALLBACK != QUALITY_PRIMARY guards every failure code below (75,
# 78, 79, 2, 4, 76, 77), not only the rc=4 branch added alongside
# PRIMARY_HAS_STRUCTURED_RC4 — pre-existing behavior, not new with that flag.
# "Falling back" to the same provider that just failed can never make sense
# regardless of which rc triggered it, so the guard is correctly universal.
if { [ "$PROVIDER_RC" -eq 75 ] || [ "$PROVIDER_RC" -eq 78 ] ||
  [ "$PROVIDER_RC" -eq 79 ] ||
  [ "$PROVIDER_RC" -eq 2 ] || [ "$PROVIDER_RC" -eq 77 ] ||
  { [ "$PROVIDER_RC" -eq 4 ] && [ "$PRIMARY_HAS_STRUCTURED_RC4" = true ]; } ||
  { [ "$PROVIDER_RC" -eq 76 ] && [ "$FALLBACK_ON_TIMEOUT" = 1 ]; }; } &&
  [ "$QUALITY_FALLBACK" != none ] &&
  [ "$QUALITY_FALLBACK" != "$QUALITY_PRIMARY" ]; then
  if [ "$PROVIDER_RC" -eq 75 ]; then
    DETAIL="$(cat "$REVIEW_OUT/provider-exhausted" 2>/dev/null || true)"
    echo "⚠️  [quality] $QUALITY_PRIMARY exhausted${DETAIL:+ — $DETAIL}; switching immediately to $QUALITY_FALLBACK." >&2
  elif [ "$PROVIDER_RC" -eq 79 ]; then
    echo "⚠️  [quality] $QUALITY_PRIMARY reported a billing or credits failure; switching immediately to $QUALITY_FALLBACK." >&2
  elif [ "$PROVIDER_RC" -eq 78 ]; then
    echo "⚠️  [quality] $QUALITY_PRIMARY rejected the exact review envelope as too large; switching immediately to $QUALITY_FALLBACK." >&2
  elif [ "$PROVIDER_RC" -eq 2 ]; then
    echo "⚠️  [quality] $QUALITY_PRIMARY unavailable; switching immediately to $QUALITY_FALLBACK." >&2
  elif [ "$PROVIDER_RC" -eq 4 ] && [ "$PRIMARY_HAS_STRUCTURED_RC4" = true ]; then
    echo "⚠️  [quality] $QUALITY_PRIMARY review was inconclusive; switching once to $QUALITY_FALLBACK." >&2
  elif [ "$PROVIDER_RC" -eq 76 ]; then
    echo "⚠️  [quality] $QUALITY_PRIMARY exceeded its review budget without converging; failing over to $QUALITY_FALLBACK (BS_QUALITY_FALLBACK_ON_TIMEOUT=0 to disable)." >&2
  elif [ "$PROVIDER_RC" -eq 77 ]; then
    echo "⚠️  [quality] $QUALITY_PRIMARY declined to start — too little provider execution budget remained; trying $QUALITY_FALLBACK instead of blocking outright." >&2
  fi
  # Preserve failed-primary diagnostics without discarding conclusive findings
  # from an earlier successful pass when a later pass becomes inconclusive.
  PRESERVATION_MODE=evidence-absent
  if [ "$PROVIDER_RC" -eq 4 ] && [ "$PRIMARY_HAS_STRUCTURED_RC4" = true ]; then
    PRESERVATION_MODE=parser-inconclusive
  fi
  bash "$SCRIPT_DIR/quality-preserve-primary-evidence.sh" \
    --review-out "$REVIEW_OUT" --mode "$PRESERVATION_MODE"
  REVIEW_PROVIDER="$QUALITY_FALLBACK"
  run_provider "$QUALITY_FALLBACK"
  PROVIDER_RC=$?
fi

if [ "$PROVIDER_RC" -ne 0 ]; then
  if [ "${REVIEW_CONTRACT_VERSION:-1}" -ge 2 ]; then
    case "$PROVIDER_RC" in
      2) INCOMPLETE_CATEGORY=provider-unavailable ;;
      4)
        if [ -f "$REVIEW_OUT/provider-contract-failed" ]; then
          INCOMPLETE_CATEGORY=provider-contract-failed
        else
          INCOMPLETE_CATEGORY=parser-inconclusive
        fi
        ;;
      75) INCOMPLETE_CATEGORY=provider-exhaustion ;;
      76) INCOMPLETE_CATEGORY=provider-timeout ;;
      77) INCOMPLETE_CATEGORY=provider-governor ;;
      78) INCOMPLETE_CATEGORY=provider-input-too-large ;;
      79) INCOMPLETE_CATEGORY=provider-billing ;;
      *) INCOMPLETE_CATEGORY=provider-error ;;
    esac
    printf 'AI REVIEW INCOMPLETE: %s failed with %s (rc=%s).\n' \
      "$REVIEW_PROVIDER" "$INCOMPLETE_CATEGORY" "$PROVIDER_RC" \
      > "$REVIEW_OUT/review-incomplete.findings.txt"
    jq --arg provider "$REVIEW_PROVIDER" \
      --arg category "$INCOMPLETE_CATEGORY" \
      --argjson rc "$PROVIDER_RC" \
      '{schemaVersion: 1, status: "incomplete", provider: $provider,
        failureCategory: $category, providerRc: $rc, head: .headSha,
        tier, reviewContractVersion, reviewPolicyDigest, agentsSha256,
        domain: .panelDomain, selectionRule: .panelRule}' \
      "$REVIEW_OUT/identity.json" \
      > "$REVIEW_OUT/review-incomplete.result.json" || exit 1
    DIFF_SHA="$(shasum -a 256 "$REVIEW_OUT/diff.txt" | awk '{print $1}')"
    node "$SCRIPT_DIR/quality-invocation.js" inventory "$MANIFEST" \
      --artifact-dir "$REVIEW_OUT" --provider review-incomplete \
      --incomplete || exit 1
    node "$SCRIPT_DIR/quality-invocation.js" record-incomplete-review "$MANIFEST" \
      --from "$REVIEW_DIFF_BASE" --to "$REVIEWED_HEAD" \
      --primary "$QUALITY_PRIMARY" --fallback "$QUALITY_FALLBACK" \
      --failed-provider "$REVIEW_PROVIDER" \
      --failure-category "$INCOMPLETE_CATEGORY" \
      --validate-remote-head true \
      --artifact-dir "$REVIEW_OUT" --diff-sha "$DIFF_SHA" || exit 1
    RETRY_STATUS="$(node "$SCRIPT_DIR/quality-invocation.js" \
      review-retry-status "$MANIFEST")" || exit 1
    RETRY_STATE="$(printf '%s' "$RETRY_STATUS" | jq -r '.state')"
    if [ "$RETRY_STATE" = pending ] &&
      [ "$INCOMPLETE_CATEGORY" != provider-input-too-large ]; then
      echo "⚠️  [quality] AI discovery incomplete ($INCOMPLETE_CATEGORY); authorizing the one bounded same-range retry." >&2
      node "$SCRIPT_DIR/quality-invocation.js" reserve-incomplete-retry \
        "$MANIFEST" || {
        echo "❌ MERGE BLOCKED: the persisted campaign cannot safely reserve incomplete-review retry capacity." >&2
        node "$SCRIPT_DIR/quality-invocation.js" terminal-state "$MANIFEST" \
          --state provider-incomplete \
          --detail "retry-capacity:$INCOMPLETE_CATEGORY" >/dev/null || true
        exit 1
      }
      bash "$SCRIPT_DIR/quality-authorize-review-round.sh" "$MANIFEST" || {
        echo "❌ MERGE BLOCKED: the incomplete review retry could not be authorized." >&2
        node "$SCRIPT_DIR/quality-invocation.js" terminal-state "$MANIFEST" \
          --state provider-incomplete \
          --detail "retry-authorization:$INCOMPLETE_CATEGORY" >/dev/null || true
        exit 1
      }
      exec bash "$SCRIPT_DIR/quality-run-review.sh" --manifest "$MANIFEST"
    fi
    echo "⚠️  [quality] AI discovery remained incomplete after its one bounded same-range retry ($INCOMPLETE_CATEGORY); deterministic delivery checks continue with signed incomplete evidence." >&2
    echo "REVIEW_OUT=$REVIEW_OUT"
    echo "REVIEW_BASE=$RESOLVED_BASE"
    echo "REVIEW_DIFF_BASE=$REVIEW_DIFF_BASE"
    echo "REVIEW_PROVIDER=review-incomplete"
    exit 0
  fi
  # Only claim the fallback is missing when it actually is. When a fallback ran
  # and also failed, saying "no usable fallback is configured" sends the reader
  # to check their config instead of the second provider's evidence.
  if [ "$QUALITY_FALLBACK" = none ]; then
    FALLBACK_NOTE="and no fallback is configured"
  elif [ "$REVIEW_PROVIDER" = "$QUALITY_FALLBACK" ]; then
    FALLBACK_NOTE="after falling back from $QUALITY_PRIMARY"
  else
    FALLBACK_NOTE="and the $QUALITY_FALLBACK fallback did not run"
  fi
  case "$PROVIDER_RC" in
    75)
      RESET_AT="$(jq -r '.resetAt // empty' "$REVIEW_OUT/provider-failure.json" 2>/dev/null || true)"
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER account quota exhausted $FALLBACK_NOTE." >&2
      terminal_diagnosis provider-exhaustion "$REVIEW_PROVIDER" "$RESET_AT"
      ;;
    2)
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER CLI unavailable $FALLBACK_NOTE." >&2
      terminal_diagnosis provider-unavailable "$REVIEW_PROVIDER"
      ;;
    79)
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER billing or credits failure $FALLBACK_NOTE." >&2
      terminal_diagnosis provider-billing "$REVIEW_PROVIDER"
      ;;
    76)
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER exceeded its bounded review budget $FALLBACK_NOTE." >&2
      terminal_diagnosis provider-timeout "$REVIEW_PROVIDER"
      ;;
    77)
      echo "❌ MERGE BLOCKED: the invocation-wide provider attempt cap or absolute deadline is exhausted." >&2
      terminal_diagnosis provider-governor
      ;;
    78)
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER rejected the exact review envelope as too large $FALLBACK_NOTE." >&2
      terminal_diagnosis provider-input-too-large "$REVIEW_PROVIDER"
      ;;
    4)
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER review was inconclusive $FALLBACK_NOTE." >&2
      if [ -f "$REVIEW_OUT/provider-contract-failed" ]; then
        terminal_diagnosis provider-contract-failed "$REVIEW_PROVIDER"
      else
        terminal_diagnosis parser-inconclusive "$REVIEW_PROVIDER"
      fi
      ;;
    *)
      echo "❌ MERGE BLOCKED: $REVIEW_PROVIDER review runner failed (rc=$PROVIDER_RC)." >&2
      terminal_diagnosis provider-error "$REVIEW_PROVIDER"
      ;;
  esac
  exit 1
fi

DIFF_SHA="$(shasum -a 256 "$REVIEW_OUT/diff.txt" | awk '{print $1}')"
# A fallback is an availability path, not a second-review requirement. Once the
# configured primary returns a valid, zero-finding review, that exact evidence
# is complete at every tier. Calling a healthy-but-quota-exhausted fallback
# would consume capacity without adding a failure signal.
node "$SCRIPT_DIR/quality-invocation.js" inventory "$MANIFEST" \
  --artifact-dir "$REVIEW_OUT" \
  --provider "$REVIEW_PROVIDER" || exit 1
node "$SCRIPT_DIR/quality-invocation.js" record-review "$MANIFEST" \
  --from "$REVIEW_DIFF_BASE" \
  --to "$REVIEWED_HEAD" \
  --provider "$REVIEW_PROVIDER" \
  --primary "$QUALITY_PRIMARY" \
   --fallback "$QUALITY_FALLBACK" \
   --effort "$QUALITY_REVIEW_DEPTH" \
   --validate-remote-head true \
   --artifact-dir "$REVIEW_OUT" \
  --diff-sha "$DIFF_SHA" || exit 1

echo "REVIEW_OUT=$REVIEW_OUT"
echo "REVIEW_BASE=$RESOLVED_BASE"
echo "REVIEW_DIFF_BASE=$REVIEW_DIFF_BASE"
echo "REVIEW_PROVIDER=$REVIEW_PROVIDER"
