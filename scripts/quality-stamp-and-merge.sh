#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    *) echo "quality-stamp-and-merge: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || { echo "quality-stamp-and-merge: --manifest is required" >&2; exit 1; }
source "$SCRIPT_DIR/quality-repo-lease-pin.sh" || exit 1
quality_pin_repository_lease "$MANIFEST" || exit 1
ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" locate "$MANIFEST")"
cd "$ROOT"
bash "$SCRIPT_DIR/quality-assert-clean.sh" \
  --manifest "$MANIFEST" --phase "quality stamp" || exit 1
node "$SCRIPT_DIR/quality-invocation.js" review-authorization "$MANIFEST" >/dev/null
REVIEWED_HEAD="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.currentHead)"
STAMP_HEAD="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" merge.stampHead)"
PR="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.pr)"
EXPECTED_REPOSITORY="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.githubRepository)"
EXPECTED_HEAD_REF="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.headRefName)"
EXPECTED_HEAD_REPOSITORY="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.headRepository)"
LOCAL_HEAD="$(git rev-parse HEAD)"

# A fleet operator may install a private Actions-minute policy. The public kit
# remains standalone when none exists. At a hard limit, only a signed
# exact-head billing condition may select the time-bounded local path. When
# review is also incomplete, that condition is composed into the same signed
# operator-quality capability; neither condition authorizes the other.
CI_BUDGET_MODE=""
if node "$SCRIPT_DIR/quality-invocation.js" ci-billing-capability "$MANIFEST" \
  >/dev/null 2>&1; then
  CI_BUDGET_MODE="local-exact-head"
fi
CI_BUDGET_ARGS=()
[ -z "$CI_BUDGET_MODE" ] || CI_BUDGET_ARGS=(--mode "$CI_BUDGET_MODE")
record_merge_admission_blocked_terminal() {
  node "$SCRIPT_DIR/quality-invocation.js" record-merge-admission-blocked-terminal \
    "$MANIFEST" --conditions "$1" --detail "$2" >/dev/null
}
REQUIRED_CHECKS_JSON=""
REQUIRED_CHECKS_ABSENT=false
REQUIRED_CHECKS_LOOKUP_SUCCEEDED=false
if REQUIRED_CHECKS_OUTPUT="$(gh pr checks "$PR" \
  --repo "$EXPECTED_REPOSITORY" --required --json state 2>&1)"; then
  REQUIRED_CHECKS_LOOKUP_SUCCEEDED=true
fi
case "$REQUIRED_CHECKS_OUTPUT" in
  "no required checks reported"*) REQUIRED_CHECKS_ABSENT=true ;;
  *)
    if [ "$REQUIRED_CHECKS_LOOKUP_SUCCEEDED" = true ]; then
      REQUIRED_CHECKS_JSON="$REQUIRED_CHECKS_OUTPUT"
    else
      echo "[quality] required-check lookup failed; retaining normal CI budget admission." >&2
    fi
    ;;
esac
CHECKS_FOR_ADMISSION_JSON="$REQUIRED_CHECKS_JSON"
if [ "$REQUIRED_CHECKS_ABSENT" = true ]; then
  # Private repositories on plans without enforceable required contexts can
  # still have exact-head CI. Reuse every registered check in that repository
  # class, matching quality-wait-required-checks.sh, rather than asking the
  # fleet budget gate to admit CI that already ran.
  REGISTERED_CHECKS_JSON="$(gh pr checks "$PR" --repo "$EXPECTED_REPOSITORY" \
    --json state 2>/dev/null || true)"
  CHECKS_FOR_ADMISSION_JSON="$REGISTERED_CHECKS_JSON"
fi
CI_ALREADY_GREEN=false
CI_ALREADY_REGISTERED=false
if printf '%s' "$CHECKS_FOR_ADMISSION_JSON" | jq -e \
  'length > 0' >/dev/null 2>&1; then
  CI_ALREADY_REGISTERED=true
fi
if printf '%s' "$CHECKS_FOR_ADMISSION_JSON" | jq -e \
  'length > 0 and all(.[]; .state == "SUCCESS" or .state == "SKIPPED" or .state == "NEUTRAL")' \
  >/dev/null 2>&1; then
  CI_ALREADY_GREEN=true
fi
CI_BUDGET_STATUS=0
admit_ci_dispatch() {
  if node "$SCRIPT_DIR/ci-budget-admission.js" \
    ${CI_BUDGET_ARGS[@]+"${CI_BUDGET_ARGS[@]}"} >/dev/null; then
    CI_BUDGET_STATUS=0
  else
    CI_BUDGET_STATUS=$?
    if [ "$CI_BUDGET_STATUS" -ne 2 ]; then
      echo "❌ MERGE FAILED: CI budget admission could not produce a policy decision (exit $CI_BUDGET_STATUS)." >&2
      exit "$CI_BUDGET_STATUS"
    fi
    # A valid local policy refusal is authoritative budget evidence, but it is
    # not evidence that GitHub denied runner allocation. Preserve it until the
    # required-check preparation below has exposed any more specific lookup,
    # registration, dispatch, or credential condition.
    echo "[quality] local CI budget policy refused the prepared required-check dispatch; terminal admission follows." >&2
  fi
}
if [ "$CI_ALREADY_GREEN" = true ]; then
  # A prior CI-budget denial is immutable evidence, but it must not strand the
  # same exact HEAD after GitHub reports current green CI. The resolver reads
  # the live PR and registered checks again, archives only a matching
  # `ci:failed` admission block, and leaves every other terminal cause intact.
  node "$SCRIPT_DIR/quality-invocation.js" resolve-green-ci-admission-block \
    "$MANIFEST" >/dev/null || exit 1
fi

# Keep the private signer outside every repository.  An explicit environment
# setting wins; the conventional local path makes autonomous quality runs work
# without requiring each shell to source a secret-bearing dotfile.
if [ -z "${QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY:-}" ] && \
  [ -z "${QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY_FILE:-}" ]; then
  DEFAULT_REVIEW_EVIDENCE_KEY="${XDG_CONFIG_HOME:-$HOME/.config}/claude-kit/quality-review-evidence.key"
  if [ -r "$DEFAULT_REVIEW_EVIDENCE_KEY" ]; then
    export QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY_FILE="$DEFAULT_REVIEW_EVIDENCE_KEY"
  fi
fi
if [ -z "${QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY:-}" ] && \
  { [ -n "${QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY:-}" ] || \
    [ -n "${QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY_FILE:-}" ]; }; then
  # Local quality owns the private signer, so derive its matching public
  # verifier once for the final local authorization. CI receives only its
  # separately configured public key and never reaches this branch.
  export QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY="$(node "$SCRIPT_DIR/quality-review-evidence.js" public-key)"
fi

HEAD_REMOTE=""
while IFS= read -r REMOTE; do
  [ -n "$REMOTE" ] || continue
  REMOTE_URL="$(git remote get-url --push "$REMOTE")" || exit 1
  REMOTE_REPOSITORY="$(gh repo view "$REMOTE_URL" --json nameWithOwner \
    --jq .nameWithOwner 2>/dev/null || true)"
  [ "$REMOTE_REPOSITORY" = "$EXPECTED_HEAD_REPOSITORY" ] || continue
  [ -z "$HEAD_REMOTE" ] || {
    echo "❌ MERGE BLOCKED: multiple remotes map to PR head repository $EXPECTED_HEAD_REPOSITORY." >&2
    exit 1
  }
  HEAD_REMOTE="$REMOTE"
done < <(git remote)
[ -n "$HEAD_REMOTE" ] || {
  echo "❌ MERGE BLOCKED: no local remote maps to PR head repository $EXPECTED_HEAD_REPOSITORY." >&2
  exit 1
}

# Prove remote identity and server-side merge freshness before creating a stamp
# or pushing anything. A failed authorization prerequisite must be non-mutating.
PREFLIGHT_OUTPUT="$(bash "$SCRIPT_DIR/quality-authorize-merge.sh" \
  --manifest "$MANIFEST" --preflight)"
printf '%s\n' "$PREFLIGHT_OUTPUT"
PREFLIGHT_PR_HEAD="$(printf '%s\n' "$PREFLIGHT_OUTPUT" |
  sed -n 's/^BS_QUALITY_PR_HEAD=//p')"
[ -n "$PREFLIGHT_PR_HEAD" ] || {
  echo "❌ MERGE BLOCKED: authorization preflight omitted PR HEAD identity." >&2
  exit 1
}
PREFLIGHT_BASE_PROTECTION="$(printf '%s\n' "$PREFLIGHT_OUTPUT" |
  sed -n 's/^BS_QUALITY_BASE_PROTECTION=//p')"
case "$PREFLIGHT_BASE_PROTECTION" in
  true | protected-nonstrict-ref-cas | unprotectable) ;;
  *)
    echo "❌ MERGE BLOCKED: authorization preflight omitted base-protection classification." >&2
    exit 1
    ;;
esac
PERSISTED_REMOTE="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" merge.stampPublication.remote)"
[ -z "$PERSISTED_REMOTE" ] || [ "$PERSISTED_REMOTE" = "$HEAD_REMOTE" ] || {
  echo "❌ MERGE BLOCKED: persisted stamp remote no longer matches PR head repository." >&2
  exit 1
}

MERGE_HEAD="$REVIEWED_HEAD"
REQUESTED_LOCAL_REVIEW_EVIDENCE="${QUALITY_LOCAL_REVIEW_EVIDENCE:-false}"
case "$REQUESTED_LOCAL_REVIEW_EVIDENCE" in
  true|false) ;;
  *) echo "❌ MERGE BLOCKED: QUALITY_LOCAL_REVIEW_EVIDENCE must be true or false." >&2; exit 1 ;;
esac
LOCAL_REVIEW_EVIDENCE=false
LOCAL_REVIEW_EVIDENCE_DEFERRED=false
LOCAL_REVIEW_EVIDENCE_ARTIFACT="$(dirname "$MANIFEST")/local-review-evidence.json"
prepare_local_review_evidence() {
  node "$SCRIPT_DIR/quality-review-check.js" write-local \
    --manifest "$MANIFEST" --artifact "$LOCAL_REVIEW_EVIDENCE_ARTIFACT" >/dev/null
  node "$SCRIPT_DIR/quality-review-check.js" verify-local \
    --manifest "$MANIFEST" --artifact "$LOCAL_REVIEW_EVIDENCE_ARTIFACT" >/dev/null
}
if [ -n "$STAMP_HEAD" ]; then
  # Backward compatibility for campaigns that were created before the
  # check-run evidence transport landed. Never create another stamp, but let
  # an interrupted legacy campaign finish its already-published child.
  [ "$LOCAL_HEAD" = "$STAMP_HEAD" ] || {
    echo "❌ MERGE BLOCKED: persisted quality stamp $STAMP_HEAD is not checked out." >&2
    exit 1
  }
  [ "$(git rev-parse "${STAMP_HEAD}~1")" = "$REVIEWED_HEAD" ] &&
    git diff --quiet "${STAMP_HEAD}~1" "$STAMP_HEAD" || {
      echo "❌ MERGE BLOCKED: persisted review stamp is not an empty child of reviewed HEAD." >&2
      exit 1
    }
  if [ -z "$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" merge.stampPublication.remote)" ]; then
    node "$SCRIPT_DIR/quality-invocation.js" record-stamp "$MANIFEST" \
      --head "$STAMP_HEAD" --remote "$HEAD_REMOTE" \
      --expected-old-head "$PREFLIGHT_PR_HEAD" >/dev/null
  fi
  [ -n "$PR" ] || { echo "❌ MERGE BLOCKED: manifest has no PR identity." >&2; exit 1; }
  [ -n "$EXPECTED_REPOSITORY" ] && [ -n "$EXPECTED_HEAD_REF" ] || {
    echo "❌ MERGE BLOCKED: manifest lacks persisted GitHub repository/head identity." >&2
    exit 1
  }
  if [ "$PREFLIGHT_PR_HEAD" != "$STAMP_HEAD" ]; then
    git push \
      --force-with-lease="refs/heads/$EXPECTED_HEAD_REF:$PREFLIGHT_PR_HEAD" \
      "$HEAD_REMOTE" "$STAMP_HEAD:refs/heads/$EXPECTED_HEAD_REF"
  fi
  node "$SCRIPT_DIR/quality-invocation.js" record-stamp-published "$MANIFEST" \
    --head "$STAMP_HEAD" --remote "$HEAD_REMOTE" \
    --previous-head "$PREFLIGHT_PR_HEAD" >/dev/null
  MERGE_HEAD="$STAMP_HEAD"
else
  [ "$LOCAL_HEAD" = "$REVIEWED_HEAD" ] || {
    echo "❌ MERGE BLOCKED: local HEAD changed after review." >&2
    exit 1
  }
  # Publish signed evidence on the reviewed commit itself. This is idempotent
  # and never rewrites or force-pushes the PR branch. GitHub's check-run API
  # requires an App token; during a verified Actions billing outage the signed
  # operator capability is the explicit local evidence transport instead.
  if [ "$CI_BUDGET_MODE" = local-exact-head ]; then
    prepare_local_review_evidence
    LOCAL_REVIEW_EVIDENCE=true
    echo "⚠️  [quality] skipping GitHub review check publication under the exact-head CI billing override; final authorization will validate the local signed review checkpoint." >&2
  elif [ "$REQUESTED_LOCAL_REVIEW_EVIDENCE" = true ]; then
    if [ "$CI_ALREADY_GREEN" = true ]; then
      prepare_local_review_evidence
      LOCAL_REVIEW_EVIDENCE=true
      echo "⚠️  [quality] using signed exact-head local review evidence because required CI is already green and custom check publication is unavailable." >&2
    else
      LOCAL_REVIEW_EVIDENCE_DEFERRED=true
      echo "[quality] local review evidence requested; waiting for required CI before signing it." >&2
    fi
  else
    if ! node "$SCRIPT_DIR/quality-review-check.js" publish --manifest "$MANIFEST" >/dev/null; then
      if [ "$CI_ALREADY_GREEN" = true ]; then
        prepare_local_review_evidence
        LOCAL_REVIEW_EVIDENCE=true
        echo "⚠️  [quality] custom review check publication is unavailable; using signed exact-head local review evidence with already-green required CI." >&2
      else
        LOCAL_REVIEW_EVIDENCE_DEFERRED=true
        echo "[quality] custom review check publication is unavailable; waiting for required CI before signing local evidence." >&2
      fi
    fi
  fi
fi

if [ -z "$STAMP_HEAD" ] && [ "$PREFLIGHT_PR_HEAD" != "$MERGE_HEAD" ]; then
  echo "❌ MERGE BLOCKED: PR HEAD does not match the exact reviewed candidate." >&2
  exit 1
fi

# GitHub's PR API can briefly lag a just-completed push (read-after-write
# consistency delay), which produced a false MERGE BLOCKED on this exact
# check twice in one session (BUI-462) even though the push had already
# landed and a manual retry seconds later showed matching SHAs both times.
# Retry a few times with a short backoff before treating a mismatch as real;
# a genuine divergence (someone else pushed to the branch) still fails after
# the retry window exhausts.
PR_HEAD_RETRIES="${QUALITY_STAMP_PR_HEAD_RETRIES:-3}"
MERGE_HEAD="${MERGE_HEAD:-${STAMP_HEAD:-}}"
case "$PR_HEAD_RETRIES" in
  ''|*[!0-9]*) echo "❌ MERGE BLOCKED: QUALITY_STAMP_PR_HEAD_RETRIES must be a non-negative integer." >&2; exit 1 ;;
esac
[ "$PR_HEAD_RETRIES" -gt 0 ] || {
  echo "❌ MERGE BLOCKED: QUALITY_STAMP_PR_HEAD_RETRIES must be positive." >&2
  exit 1
}
PR_HEAD_RETRY_DELAY="${QUALITY_STAMP_PR_HEAD_RETRY_DELAY:-3}"
case "$PR_HEAD_RETRY_DELAY" in
  ''|*[!0-9]*) echo "❌ MERGE BLOCKED: QUALITY_STAMP_PR_HEAD_RETRY_DELAY must be a non-negative integer (seconds)." >&2; exit 1 ;;
esac
PR_HEAD=""
PR_HEAD_ERR_FILE="$(mktemp)"
trap 'rm -f "$PR_HEAD_ERR_FILE"' EXIT
attempt=1
while [ "$attempt" -le "$PR_HEAD_RETRIES" ]; do
  # `gh pr view` failing outright (network blip, auth hiccup, rate limit) is
  # a different flavor of the same transient-flakiness problem this retry
  # loop exists for — under `set -e` an unguarded failure here would abort
  # the whole script on attempt 1 and silently defeat the retry entirely.
  # Tolerate a failed call the same way as a mismatched SHA: log it and retry.
  # Capture stdout and stderr SEPARATELY in ONE call (5 review agents, two
  # rounds): a merged `2>&1` capture corrupts PR_HEAD with benign stderr
  # noise (e.g. a gh update nag) even on success — the exact false-mismatch
  # bug this fix exists to eliminate. A prior version re-ran the command a
  # second time on failure just to get a clean error message, which doubled
  # API calls on exactly the rate-limit path this fix is meant to tolerate;
  # route stderr to a scratch file instead so one call covers both.
  GH_PR_VIEW_FAILED=false
  if ! PR_HEAD="$(gh pr view "$PR" --repo "$EXPECTED_REPOSITORY" \
    --json headRefOid --jq .headRefOid 2>"$PR_HEAD_ERR_FILE")"; then
    echo "[quality] gh pr view failed on attempt $attempt/$PR_HEAD_RETRIES: $(cat "$PR_HEAD_ERR_FILE")" >&2
    PR_HEAD=""
    GH_PR_VIEW_FAILED=true
  fi
  [ "$PR_HEAD" = "$MERGE_HEAD" ] && break
  if [ "$attempt" -lt "$PR_HEAD_RETRIES" ]; then
    if [ "$GH_PR_VIEW_FAILED" = true ]; then
      echo "[quality] retrying in ${PR_HEAD_RETRY_DELAY}s after the gh pr view failure above (attempt $attempt/$PR_HEAD_RETRIES)" >&2
    else
      echo "[quality] PR HEAD mismatch on attempt $attempt/$PR_HEAD_RETRIES (got $PR_HEAD, want $MERGE_HEAD) — retrying in ${PR_HEAD_RETRY_DELAY}s, likely GitHub API lag" >&2
    fi
    sleep "$PR_HEAD_RETRY_DELAY"
  fi
  attempt=$((attempt + 1))
done
rm -f "$PR_HEAD_ERR_FILE"
[ "$PR_HEAD" = "$MERGE_HEAD" ] || {
  echo "❌ MERGE BLOCKED: PR HEAD does not match the exact reviewed candidate $MERGE_HEAD after $PR_HEAD_RETRIES attempts." >&2
  exit 1
}
CI_TIMEOUT="${QUALITY_STAMP_CI_TIMEOUT:-900}"
case "$CI_TIMEOUT" in
  ''|*[!0-9]*) echo "❌ MERGE BLOCKED: QUALITY_STAMP_CI_TIMEOUT must be seconds." >&2; exit 1 ;;
esac
[ "$CI_TIMEOUT" -gt 0 ] || {
  echo "❌ MERGE BLOCKED: QUALITY_STAMP_CI_TIMEOUT must be positive." >&2
  exit 1
}
echo "[quality] waiting up to ${CI_TIMEOUT}s for required CI on exact candidate $MERGE_HEAD"
BASE_BRANCH="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.baseRef)"
BASE_BRANCH="${BASE_BRANCH#refs/heads/}"
BASE_BRANCH="${BASE_BRANCH#origin/}"
[ -n "$BASE_BRANCH" ] || {
  echo "❌ MERGE BLOCKED: manifest base branch is missing." >&2
  exit 1
}
RC=0
CI_BILLING_WAIVED=false
CI_WAIVER_ARTIFACT="$(dirname "$MANIFEST")/ci-billing-waiver.json"
enforce_ci_budget_admission() {
  [ "$CI_BUDGET_STATUS" -ne 2 ] || {
    CI_BUDGET_DETAIL="local CI budget policy denied new workflow spend for this candidate"
    record_merge_admission_blocked_terminal "ci:failed" "$CI_BUDGET_DETAIL" || exit 1
    echo "❌ MERGE BLOCKED: $CI_BUDGET_DETAIL." >&2
    exit 1
  }
}
if [ "$CI_BUDGET_MODE" = local-exact-head ]; then
  # The operator capability is already bound to independently classified
  # billing-preallocation evidence. Revalidate it before any workflow dispatch
  # so the outage path cannot spend minutes or depend on workflow_dispatch.
  node "$SCRIPT_DIR/quality-ci-billing-waiver.js" \
    --repo "$EXPECTED_REPOSITORY" --pr "$PR" --head "$MERGE_HEAD" \
    --artifact "$CI_WAIVER_ARTIFACT"
  CI_BILLING_WAIVED=true
  echo "⚠️  [quality] exact-HEAD CI billing override validated before workflow dispatch; using local gates and review." >&2
elif [ "$PREFLIGHT_BASE_PROTECTION" = unprotectable ]; then
  if [ "$CI_ALREADY_REGISTERED" != true ]; then
    admit_ci_dispatch
  fi
  enforce_ci_budget_admission
  bash "$SCRIPT_DIR/quality-run-bounded.sh" --timeout "$CI_TIMEOUT" -- \
    bash "$SCRIPT_DIR/quality-wait-required-checks.sh" --pr "$PR" || RC=$?
else
  # Resolve required-check mappings and protected-dispatch credentials without
  # mutating GitHub. This preserves the actionable condition while keeping a
  # real local budget refusal ahead of every workflow dispatch.
  PREPARE_JSON="$(node "$SCRIPT_DIR/quality-required-checks.js" prepare \
    --repo "$EXPECTED_REPOSITORY" --base "$BASE_BRANCH" \
    --source-head "$REVIEWED_HEAD" --head "$MERGE_HEAD")" || exit $?
  PREPARED_DISPATCH_COUNT="$(printf '%s' "$PREPARE_JSON" | jq '.dispatches | length')"
  if [ "$PREPARED_DISPATCH_COUNT" -gt 0 ]; then
    admit_ci_dispatch
    enforce_ci_budget_admission
    ENSURE_JSON="$(node "$SCRIPT_DIR/quality-required-checks.js" ensure \
      --repo "$EXPECTED_REPOSITORY" --base "$BASE_BRANCH" \
      --source-head "$REVIEWED_HEAD" --head "$MERGE_HEAD" \
      --head-ref "$EXPECTED_HEAD_REF" --manifest "$MANIFEST" \
      --timeout "$CI_TIMEOUT")" || exit $?
    if [ "$(printf '%s' "$ENSURE_JSON" | jq '.deferred | length')" -gt 0 ]; then
      printf '%s' "$ENSURE_JSON" | jq -r \
        '.deferred[] | "[quality] exact-head workflow registered; required check remains deferred: \(.context) workflow=\(.workflowId) run=\(.runId) status=\(.status)"' >&2
    fi
  fi
  bash "$SCRIPT_DIR/quality-run-bounded.sh" --timeout "$CI_TIMEOUT" -- \
    node "$SCRIPT_DIR/quality-required-checks.js" wait \
      --repo "$EXPECTED_REPOSITORY" --base "$BASE_BRANCH" \
      --head "$MERGE_HEAD" --timeout "$CI_TIMEOUT" --interval 10 \
      --manifest "$MANIFEST" || RC=$?
fi
# A GitHub read transport failure is not CI failure or billing evidence.
# Preserve its type for same-campaign recovery before any waiver evaluation.
[ "$RC" -ne 75 ] || exit 75
if [ "$RC" -ne 0 ]; then
  if node "$SCRIPT_DIR/quality-ci-billing-waiver.js" \
    --repo "$EXPECTED_REPOSITORY" --pr "$PR" --head "$MERGE_HEAD" \
    --artifact "$CI_WAIVER_ARTIFACT"; then
    CI_BILLING_WAIVED=true
    echo "⚠️  [quality] GitHub Actions billing prevented runner allocation; exact-HEAD local gates and review remain authoritative (waiver: $CI_WAIVER_ARTIFACT)." >&2
  else
    if [ "$RC" -eq 124 ]; then
      DETAIL="timed out waiting for CI on exact candidate $MERGE_HEAD"
    else
      DETAIL="required CI failed on exact candidate $MERGE_HEAD"
    fi
    echo "❌ MERGE BLOCKED: $DETAIL." >&2
    node "$SCRIPT_DIR/quality-terminal-status.js" \
      --manifest "$MANIFEST" --category github-ci --detail "$DETAIL" || true
    exit 1
  fi
fi
if [ "$LOCAL_REVIEW_EVIDENCE_DEFERRED" = true ]; then
  prepare_local_review_evidence
  LOCAL_REVIEW_EVIDENCE=true
  if [ "$CI_BILLING_WAIVED" = true ]; then
    echo "⚠️  [quality] the exact-head CI billing waiver is valid; using signed local review evidence after custom check publication was unavailable." >&2
  else
    echo "⚠️  [quality] required CI is green; using signed exact-head local review evidence after custom check publication was unavailable." >&2
  fi
fi
[ "$(gh pr view "$PR" --repo "$EXPECTED_REPOSITORY" \
  --json headRefOid --jq .headRefOid)" = "$MERGE_HEAD" ] || {
  echo "❌ MERGE BLOCKED: PR HEAD changed while waiting for exact-candidate CI." >&2
  exit 1
}
if [ "$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" options.deliveryClaim)" = engineering ]; then
  # Re-read the closed policy from the exact protected base after CI and
  # immediately before final authorization. Candidate files never supply the
  # policy, and a stale or revoked base remains blocked.
  node "$SCRIPT_DIR/engineering-delivery-policy.js" --manifest "$MANIFEST" >/dev/null
fi
if [ "$CI_BILLING_WAIVED" = true ]; then
  BS_QUALITY_CI_BILLING_WAIVER_ARTIFACT="$CI_WAIVER_ARTIFACT" \
    QUALITY_CI_BILLING_LOCAL_REVIEW="$LOCAL_REVIEW_EVIDENCE" \
    QUALITY_LOCAL_REVIEW_ARTIFACT="$LOCAL_REVIEW_EVIDENCE_ARTIFACT" \
    bash "$SCRIPT_DIR/quality-authorize-merge.sh" --manifest "$MANIFEST"
elif [ "$LOCAL_REVIEW_EVIDENCE" = true ]; then
  QUALITY_LOCAL_REVIEW=true \
    QUALITY_LOCAL_REVIEW_ARTIFACT="$LOCAL_REVIEW_EVIDENCE_ARTIFACT" \
    bash "$SCRIPT_DIR/quality-authorize-merge.sh" --manifest "$MANIFEST"
else
  bash "$SCRIPT_DIR/quality-authorize-merge.sh" --manifest "$MANIFEST"
fi
# `quality-repo-lease.js merge` records the write-once `merged` terminal state
# in the same verified-outcome transaction that releases the lease.  Do not
# call the lease-aware terminal-state mutator again here: the lease has already
# been released, so that redundant call used to emit a misleading credential
# error after a successful exact-head merge (BUI-728).
bash "$SCRIPT_DIR/quality-merge-cleanup.sh" --manifest "$MANIFEST"
