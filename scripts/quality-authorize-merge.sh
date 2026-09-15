#!/usr/bin/env bash
# Executable final merge authorization gate. This script authorizes; it does
# not push or merge.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST=""
PREFLIGHT=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-authorize-merge: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    --preflight) PREFLIGHT=true; shift ;;
    *) echo "quality-authorize-merge: unknown argument '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || {
  echo "quality-authorize-merge: --manifest is required" >&2
  exit 1
}
if [ "$PREFLIGHT" != true ] &&
  [ "${BS_QUALITY_PROTECTION_RECHECK:-0}" = 1 ]; then
  echo "❌ MERGE BLOCKED: the protection recheck sentinel is reserved for the internal preflight." >&2
  exit 1
fi
source "$SCRIPT_DIR/quality-repo-lease-pin.sh" || exit 1
quality_pin_repository_lease "$MANIFEST" || exit 1

verify_ci_billing_digest() {
  local artifact="$1"
  local expected="$2"
  node - "$SCRIPT_DIR" "$artifact" "$expected" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [scriptDir, artifactPath, expected] = process.argv.slice(2);
const { evidenceDigestValid } = require(path.join(
  scriptDir,
  "quality-ci-billing-waiver.js",
));
const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
if (!evidenceDigestValid(evidence) || evidence.evidenceSha256 !== expected) {
  process.exit(1);
}
NODE
}

# A billing waiver is usable only with a signed CI capability, or with a
# signed quality override that explicitly accepted ci:failed alongside its
# other diagnosed conditions. The latter is the only safe composition point:
# the signed artifact still binds both the review decision and the exact CI
# outage evidence to this manifest and HEAD.
has_ci_billing_capability() {
  node "$SCRIPT_DIR/quality-invocation.js" ci-billing-capability "$MANIFEST" \
    >/dev/null 2>&1
}

record_merge_admission_blocked_terminal() {
  node "$SCRIPT_DIR/quality-invocation.js" record-merge-admission-blocked-terminal \
    "$MANIFEST" --conditions "$1" --detail "$2" >/dev/null
}

node "$SCRIPT_DIR/quality-invocation.js" review-authorization "$MANIFEST" >/dev/null || exit 1
MERGE_REQUESTED="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" options.merge)"
[ "$MERGE_REQUESTED" = true ] || {
  echo "❌ MERGE BLOCKED: invocation was created without --merge." >&2
  exit 1
}
PR="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.pr)"
EXPECTED_HEAD="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.currentHead)"
EXPECTED_REPOSITORY="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.githubRepository)"
EXPECTED_HEAD_REF="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" repo.headRefName)"
STAMP_HEAD="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" merge.stampHead)"
STAMP_PUBLICATION="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" merge.stampPublication.status)"
ROOT="$(node "$SCRIPT_DIR/quality-invocation.js" locate "$MANIFEST")" || exit 1
cd "$ROOT" || exit 1
bash "$SCRIPT_DIR/quality-assert-clean.sh" \
  --manifest "$MANIFEST" --phase "merge authorization" || exit 1
[ -n "$PR" ] || { echo "❌ MERGE BLOCKED: manifest has no PR identity." >&2; exit 1; }
[ -n "$EXPECTED_REPOSITORY" ] && [ -n "$EXPECTED_HEAD_REF" ] || {
  echo "❌ MERGE BLOCKED: manifest lacks persisted GitHub repository/head identity." >&2
  exit 1
}
ACTUAL_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || exit 1
[ "$ACTUAL_REPOSITORY" = "$EXPECTED_REPOSITORY" ] || {
  echo "❌ MERGE BLOCKED: GitHub repository identity changed." >&2
  exit 1
}
PR_JSON="$(gh pr view "$PR" --repo "$EXPECTED_REPOSITORY" \
  --json state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName)" || exit 1
ACTUAL_STATE="$(printf '%s' "$PR_JSON" | jq -r '.state')"
ACTUAL_HEAD="$(printf '%s' "$PR_JSON" | jq -r '.headRefOid')"
ACTUAL_HEAD_REF="$(printf '%s' "$PR_JSON" | jq -r '.headRefName')"
ACTUAL_BASE_NAME="$(printf '%s' "$PR_JSON" | jq -r '.baseRefName')"
[ "$ACTUAL_HEAD_REF" = "$EXPECTED_HEAD_REF" ] || {
  echo "❌ MERGE BLOCKED: PR head branch identity changed." >&2
  exit 1
}
if [ "$ACTUAL_STATE" = MERGED ]; then
  MERGED_EXPECTED_HEAD="${STAMP_HEAD:-$EXPECTED_HEAD}"
  [ "$ACTUAL_HEAD" = "$MERGED_EXPECTED_HEAD" ] &&
    [ "$(printf '%s' "$PR_JSON" | jq -r '.mergedAt // empty')" != "" ] &&
    [ "$(printf '%s' "$PR_JSON" | jq -r '.mergeCommit.oid // empty')" != "" ] || {
      echo "❌ MERGE BLOCKED: merged PR does not match the persisted expected head." >&2
      exit 1
  }
  echo "❌ MERGE BLOCKED: PR was already merged at $MERGED_EXPECTED_HEAD without this invocation's persisted pre-merge authorization." >&2
  echo "   Treating the result as an out-of-band merge; exact-head evidence and post-merge CI cannot prove pre-merge authorization." >&2
  exit 1
fi
[ "$ACTUAL_STATE" = OPEN ] || {
  echo "❌ MERGE BLOCKED: PR is not open or safely merged (state=$ACTUAL_STATE)." >&2
  exit 1
}
# Capture before piping: `cmd | awk` reports awk's status, so a failed lookup
# whose partial output still parsed would read as a successful base resolution.
# This is the authoritative base read and --preflight exits before the later one.
ACTUAL_BASE_LS="$(git ls-remote origin "refs/heads/$ACTUAL_BASE_NAME")" || {
  echo "❌ MERGE BLOCKED: could not resolve the PR base ref." >&2
  exit 1
}
ACTUAL_BASE_OID="$(printf '%s' "$ACTUAL_BASE_LS" | awk 'NR==1 {print $1}')"
[ -n "$ACTUAL_BASE_OID" ] || {
  echo "❌ MERGE BLOCKED: base ref resolved to no OID." >&2
  exit 1
}
EXPECTED_BASE_REF="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.baseRef)"
EXPECTED_BASE_OID="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.baseHeadSha)"
[ "$EXPECTED_BASE_REF" = "origin/$ACTUAL_BASE_NAME" ] &&
  [ "$EXPECTED_BASE_OID" = "$ACTUAL_BASE_OID" ] || {
    echo "❌ MERGE BLOCKED: PR base changed after review." >&2
    exit 1
  }
LOCAL_HEAD="$(git rev-parse HEAD)"
if [ "$PREFLIGHT" = true ]; then
  if [ -n "$STAMP_HEAD" ]; then
    [ "$LOCAL_HEAD" = "$STAMP_HEAD" ] || {
      echo "❌ MERGE BLOCKED: persisted local stamp is not checked out." >&2
      exit 1
    }
    if [ "$STAMP_PUBLICATION" = published ]; then
      [ "$ACTUAL_HEAD" = "$STAMP_HEAD" ] || {
        echo "❌ MERGE BLOCKED: published stamp no longer matches PR HEAD." >&2
        exit 1
      }
    else
      { [ "$ACTUAL_HEAD" = "$EXPECTED_HEAD" ] || [ "$ACTUAL_HEAD" = "$STAMP_HEAD" ]; } || {
        echo "❌ MERGE BLOCKED: local stamp is orphaned from the expected PR revision." >&2
        exit 1
      }
    fi
  else
    REVIEW_HISTORY="$(node "$SCRIPT_DIR/quality-invocation.js" \
      get "$MANIFEST" reviews)" || exit 1
    REMOTE_PREDECESSOR="$(printf '%s' "$REVIEW_HISTORY" | jq -r \
      '[.[] | select(.status == "success")][-2].to // empty')"
    [ "$LOCAL_HEAD" = "$EXPECTED_HEAD" ] &&
      { [ "$ACTUAL_HEAD" = "$EXPECTED_HEAD" ] ||
        { [ -n "$REMOTE_PREDECESSOR" ] &&
          [ "$ACTUAL_HEAD" = "$REMOTE_PREDECESSOR" ]; }; } || {
      echo "❌ MERGE BLOCKED: preflight HEAD does not match the reviewed PR head." >&2
      exit 1
    }
  fi
  echo "BS_QUALITY_PR_HEAD=$ACTUAL_HEAD"
else
  [ "$ACTUAL_HEAD" = "$LOCAL_HEAD" ] || {
    echo "❌ MERGE BLOCKED: PR HEAD does not match reviewed HEAD." >&2
    exit 1
  }
  if [ -n "$STAMP_HEAD" ]; then
    [ "$LOCAL_HEAD" = "$STAMP_HEAD" ] &&
      [ "$(git rev-parse HEAD~1)" = "$EXPECTED_HEAD" ] &&
      git diff --quiet HEAD~1 HEAD || {
        echo "❌ MERGE BLOCKED: PR HEAD is not the persisted empty stamp of reviewed HEAD." >&2
        exit 1
      }
  else
    [ "$LOCAL_HEAD" = "$EXPECTED_HEAD" ] || {
      echo "❌ MERGE BLOCKED: PR HEAD is not the exact reviewed candidate." >&2
      exit 1
    }
  fi
  CI_BILLING_WAIVER_ARTIFACT="${BS_QUALITY_CI_BILLING_WAIVER_ARTIFACT:-}"
  CI_BILLING_WAIVED=false
  if [ -n "$CI_BILLING_WAIVER_ARTIFACT" ]; then
    # This is deliberately the first of two validations: it authorizes
    # bypassing only the green-check query below. Revalidate the same
    # invocation-bound, exact-head artifact immediately before adding --admin.
    EXPECTED_WAIVER_ARTIFACT="$(dirname "$MANIFEST")/ci-billing-waiver.json"
    [ "$CI_BILLING_WAIVER_ARTIFACT" = "$EXPECTED_WAIVER_ARTIFACT" ] || {
      echo "❌ MERGE BLOCKED: CI billing waiver artifact path is not invocation-bound." >&2
      exit 1
    }
    node "$SCRIPT_DIR/quality-ci-billing-waiver.js" \
      --repo "$EXPECTED_REPOSITORY" --pr "$PR" --head "$ACTUAL_HEAD" \
      --artifact "$CI_BILLING_WAIVER_ARTIFACT" >/dev/null || {
      echo "❌ MERGE BLOCKED: CI billing waiver no longer matches live exact-HEAD evidence." >&2
      exit 1
    }
    if has_ci_billing_capability; then
      SIGNED_WAIVER_DIGEST="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" approval.ciBillingEvidenceSha256)"
      verify_ci_billing_digest "$CI_BILLING_WAIVER_ARTIFACT" "$SIGNED_WAIVER_DIGEST" || {
        echo "❌ MERGE BLOCKED: live CI billing evidence differs from the signed operator diagnosis." >&2
        exit 1
      }
    fi
    CI_BILLING_WAIVED=true
  fi
fi
git merge-base --is-ancestor "$EXPECTED_BASE_OID" "$EXPECTED_HEAD" || {
  echo "❌ MERGE BLOCKED: reviewed branch is not up to date with the PR base." >&2
  exit 1
}
REPOSITORY="$EXPECTED_REPOSITORY"
ATOMIC_BASE_FRESHNESS=false
ADMIN_BASE_FRESHNESS=false
ATOMIC_BASE_SOURCE=""
ADMIN_BASE_SOURCE=""
MERGE_MODE=""
PROTECTED_NONSTRICT_DIGEST=""
REPOSITORY_ADMIN_PERMISSION=false
CURRENT_USER_ID=""
CURRENT_USER_LOGIN=""
ORGANIZATION_ADMIN_PERMISSION=false
ENCODED_BASE_NAME="$(jq -rn --arg value "$ACTUAL_BASE_NAME" '$value | @uri')" || exit 1
if [ "${CI_BILLING_WAIVED:-false}" = true ]; then
  REPOSITORY_ADMIN_PERMISSION="$(gh api "repos/$REPOSITORY" \
    --jq '.permissions.admin' 2>/dev/null || true)"
  CURRENT_USER_ID="$(gh api user --jq '.id' 2>/dev/null || true)"
  CURRENT_USER_LOGIN="$(gh api user --jq '.login' 2>/dev/null || true)"
  ORGANIZATION_ADMIN_PERMISSION="$(gh api \
    "orgs/${REPOSITORY%%/*}/memberships/$CURRENT_USER_LOGIN" \
    --jq '.role == "admin"' 2>/dev/null || true)"
fi
if [ "$(gh api "repos/$REPOSITORY/branches/$ENCODED_BASE_NAME/protection/required_status_checks" \
  --jq '.strict' 2>/dev/null || true)" = true ]; then
  ATOMIC_BASE_FRESHNESS=true
  ATOMIC_BASE_SOURCE=classic
fi
if [ "${CI_BILLING_WAIVED:-false}" = true ] &&
  [ "$(gh api "repos/$REPOSITORY/branches/$ENCODED_BASE_NAME/protection" \
    --jq '.enforce_admins.enabled' 2>/dev/null || true)" = false ] &&
  [ "$REPOSITORY_ADMIN_PERMISSION" = true ]; then
  ADMIN_BASE_FRESHNESS=true
  ADMIN_BASE_SOURCE=classic
fi
# Repos whose plan cannot enforce strict checks (private, no GitHub Pro) can
# never satisfy the check above, so --merge is unsatisfiable there and operators
# fall back to --admin, which skips every gate rather than just this one.
#
# This escape hatch is deliberately NOT presented as an equivalent guarantee.
# GitHub exposes no base-SHA precondition on merge (only --match-head-commit),
# so a client cannot reconstruct atomic base freshness: the base may advance
# between the last check and the merge, producing exactly the untested
# head-on-new-base combination that strict checks exist to prevent. What follows
# is a documented, opt-in acceptance of that weaker property — equivalent to a
# non-strict protected branch — not a reproduction of the strong one.
#
# Plan capability is read from the repository object, never inferred from API
# error text: rate limiting and insufficient token scope also return HTTP 403,
# and treating a failed observation as "protection is unavailable" would turn a
# transient failure into an authorization.
# GitHub evaluates ruleset include/exclude patterns for this concrete branch.
# Do not duplicate fnmatch semantics locally: exclusions, nested wildcards,
# organization rulesets, and future pattern syntax must remain server-owned.
# If this endpoint is unavailable, rulesets provide no authorization and the
# classic strict-protection check above is the only accepted guarantee.
if EFFECTIVE_RULES="$(gh api \
  "repos/$REPOSITORY/rules/branches/$ENCODED_BASE_NAME" 2>/dev/null)"; then
  if printf '%s' "$EFFECTIVE_RULES" |
    jq -e 'any(.[]?; .type == "merge_queue")' >/dev/null; then
    echo "❌ MERGE BLOCKED: merge-queue branches require a queue-aware monitored merge path." >&2
    exit 1
  fi
  if printf '%s' "$EFFECTIVE_RULES" |
    jq -e '
      any(.[]?;
        .type == "required_status_checks" and
        .parameters.strict_required_status_checks_policy == true
      )
    ' >/dev/null; then
    ATOMIC_BASE_FRESHNESS=true
    ATOMIC_BASE_SOURCE=ruleset
  fi
fi
if [ "${CI_BILLING_WAIVED:-false}" = true ] &&
  [ "$ATOMIC_BASE_SOURCE" = ruleset ]; then
  # The effective-rules response identifies the strict status-check rulesets
  # that supply freshness for this concrete branch. Fetch each complete
  # ruleset before allowing an admin merge and require a bypass actor that
  # matches the authenticated operator. Unrelated rulesets do not authorize
  # or deny this specific status-check bypass. An absent or hidden
  # bypass_actors field is not authorization.
  RULESET_ADMIN_FRESHNESS=true
  RULESET_IDS="$(printf '%s' "$EFFECTIVE_RULES" |
    jq -r '
      .[]?
      | select(.type == "required_status_checks")
      | select(.parameters.strict_required_status_checks_policy == true)
      | .ruleset_id // empty
    ' | sort -u)"
  [ -n "$RULESET_IDS" ] || RULESET_ADMIN_FRESHNESS=false
  while IFS= read -r RULESET_ID; do
    [ -n "$RULESET_ID" ] || continue
    RULESET_DETAIL="$(gh api \
      "repos/$REPOSITORY/rulesets/$RULESET_ID?includes_parents=true" \
      2>/dev/null || true)"
    AUTHORIZED_TEAM_ACTOR_IDS_JSON='[]'
    TEAM_ACTOR_IDS="$(printf '%s' "$RULESET_DETAIL" |
      jq -r '.bypass_actors[]? | select(.actor_type == "Team") | .actor_id | tostring' |
      sort -u)"
    if [ -n "$TEAM_ACTOR_IDS" ] && [ -n "$CURRENT_USER_LOGIN" ]; then
      ORGANIZATION="${REPOSITORY%%/*}"
      TEAM_INDEX="$(gh api --paginate \
        "orgs/$ORGANIZATION/teams?per_page=100" \
        --jq '.[] | [(.id | tostring), .slug] | @tsv' 2>/dev/null || true)"
      while IFS= read -r TEAM_ACTOR_ID; do
        [ -n "$TEAM_ACTOR_ID" ] || continue
        TEAM_SLUG="$(printf '%s\n' "$TEAM_INDEX" |
          awk -F '\t' -v actor_id "$TEAM_ACTOR_ID" '$1 == actor_id { print $2; exit }')"
        [ -n "$TEAM_SLUG" ] || continue
        if [ "$(gh api \
          "orgs/$ORGANIZATION/teams/$TEAM_SLUG/memberships/$CURRENT_USER_LOGIN" \
          --jq '.state == "active"' 2>/dev/null || true)" = true ]; then
          AUTHORIZED_TEAM_ACTOR_IDS_JSON="$(printf '%s' "$AUTHORIZED_TEAM_ACTOR_IDS_JSON" |
            jq -c --arg actor_id "$TEAM_ACTOR_ID" '. + [$actor_id]')"
        fi
      done <<EOF
$TEAM_ACTOR_IDS
EOF
    fi
    if ! printf '%s' "$EFFECTIVE_RULES" |
      jq -e --arg ruleset_id "$RULESET_ID" '
        any(.[]?;
          (.ruleset_id | tostring) == $ruleset_id and
          .type == "required_status_checks" and
          .parameters.strict_required_status_checks_policy == true
        )
      ' >/dev/null 2>&1 || ! printf '%s' "$RULESET_DETAIL" |
      jq -e \
        --arg user_id "$CURRENT_USER_ID" \
        --arg admin "$REPOSITORY_ADMIN_PERMISSION" \
        --arg org_admin "$ORGANIZATION_ADMIN_PERMISSION" \
        --argjson authorized_team_actor_ids "$AUTHORIZED_TEAM_ACTOR_IDS_JSON" '
        .enforcement == "active" and
        (.bypass_actors | type == "array") and
        any(.bypass_actors[]?;
          (.bypass_mode == "always" or .bypass_mode == "pull_request" or .bypass_mode == "exempt") and
          ((.actor_type == "OrganizationAdmin" and $org_admin == "true") or
           (.actor_type == "RepositoryRole" and (.actor_id | tostring) == "5" and $admin == "true") or
           (.actor_type == "User" and (.actor_id | tostring) == $user_id) or
           (.actor_type == "Team" and
             ((.actor_id | tostring) as $actor_id |
               any($authorized_team_actor_ids[]?; tostring == $actor_id))))
        )
      ' >/dev/null 2>&1; then
      RULESET_ADMIN_FRESHNESS=false
      break
    fi
  done <<EOF
$RULESET_IDS
EOF
  if [ "$RULESET_ADMIN_FRESHNESS" = true ]; then
    ADMIN_BASE_FRESHNESS=true
    ADMIN_BASE_SOURCE=ruleset
  fi
fi
# GitHub's classic protection and effective-rules REST endpoints can be
# unavailable while the GraphQL branch-protection view remains healthy. Use
# that independent, server-owned view as a read-only confirmation of strict
# freshness. The branch is accepted only when the rule itself reports strict
# checks and GitHub says it matches this concrete base ref.
if [ "$ATOMIC_BASE_FRESHNESS" != true ]; then
  GRAPHQL_OWNER="${REPOSITORY%%/*}"
  GRAPHQL_NAME="${REPOSITORY#*/}"
  GRAPHQL_RULES="$(gh api graphql \
    -f 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){branchProtectionRules(first:100){pageInfo{hasNextPage} nodes{requiresStrictStatusChecks isAdminEnforced matchingRefs(first:100){pageInfo{hasNextPage} nodes{name}}}}}}' \
    -F "owner=$GRAPHQL_OWNER" -F "name=$GRAPHQL_NAME" 2>/dev/null || true)"
  if printf '%s' "$GRAPHQL_RULES" |
    jq -e --arg branch "$ACTUAL_BASE_NAME" '
      (.data.repository.branchProtectionRules.pageInfo.hasNextPage == false)
      and
      ([.data.repository.branchProtectionRules.nodes[]?
        | select(.matchingRefs.pageInfo.hasNextPage == false)
        | select(any(.matchingRefs.nodes[]?.name; . == $branch))]
        | length == 1 and .[0].requiresStrictStatusChecks == true)
    ' >/dev/null 2>&1; then
    ATOMIC_BASE_FRESHNESS=true
    ATOMIC_BASE_SOURCE=graphql
  fi
  if [ "${CI_BILLING_WAIVED:-false}" = true ] &&
    printf '%s' "$GRAPHQL_RULES" |
      jq -e --arg branch "$ACTUAL_BASE_NAME" '
        (.data.repository.branchProtectionRules.pageInfo.hasNextPage == false)
        and
        ([.data.repository.branchProtectionRules.nodes[]?
          | select(.matchingRefs.pageInfo.hasNextPage == false)
          | select(any(.matchingRefs.nodes[]?.name; . == $branch))]
          | length == 1 and .[0].requiresStrictStatusChecks == true
          and .[0].isAdminEnforced == false)
      ' >/dev/null 2>&1; then
    if [ "$REPOSITORY_ADMIN_PERMISSION" = true ]; then
      ADMIN_BASE_FRESHNESS=true
      ADMIN_BASE_SOURCE=graphql
    fi
  fi
fi
# A protected strict:false base uses the complete deny-by-default ref-CAS
# classifier. A clean campaign with autonomous merge authority may use this
# transaction directly. Signed capability authority remains required when the
# campaign also accepts failed CI, incomplete review, or another override.
UNPROTECTABLE_MERGE_POLICY="${BS_QUALITY_ALLOW_UNPROTECTABLE_BASE:-false}"
if [ "$ATOMIC_BASE_FRESHNESS" != true ]; then
  PROTECTED_NONSTRICT_ERROR_FILE="$(mktemp)"
  PROTECTED_NONSTRICT_RC=0
  PROTECTED_NONSTRICT_INSPECTION="$(node \
    "$SCRIPT_DIR/quality-protected-nonstrict.js" inspect \
    --repo "$REPOSITORY" --branch "$ACTUAL_BASE_NAME" --pr "$PR" \
    2>"$PROTECTED_NONSTRICT_ERROR_FILE")" || PROTECTED_NONSTRICT_RC=$?
  if [ "$PROTECTED_NONSTRICT_RC" -ne 0 ]; then
    PROTECTED_NONSTRICT_ERROR="$(head -n 1 "$PROTECTED_NONSTRICT_ERROR_FILE")"
    case "$PROTECTED_NONSTRICT_RC:$PROTECTED_NONSTRICT_ERROR" in
      3:* | *"classic branch protection read failed:"*"Branch not protected (HTTP 404)"*) ;;
      *)
        if [ "$UNPROTECTABLE_MERGE_POLICY" = true ]; then
          # The source-owned protectability classifier below performs a fresh
          # read and accepts only GitHub's exact private-plan-limit response.
          # Do not turn this preliminary API failure into authority.
          :
        else
          echo "❌ MERGE BLOCKED: protected non-strict ref-CAS classification failed: ${PROTECTED_NONSTRICT_ERROR:-unknown error}" >&2
          rm -f "$PROTECTED_NONSTRICT_ERROR_FILE"
          exit 1
        fi
        ;;
    esac
  fi
  rm -f "$PROTECTED_NONSTRICT_ERROR_FILE"
  PROTECTED_NONSTRICT_DIGEST=""
  if [ "$PROTECTED_NONSTRICT_RC" -eq 0 ]; then
    PROTECTED_NONSTRICT_DIGEST="$(printf '%s' "$PROTECTED_NONSTRICT_INSPECTION" |
      jq -r '.digest // empty')"
  fi
  if [ -n "$PROTECTED_NONSTRICT_DIGEST" ]; then
    if node "$SCRIPT_DIR/quality-invocation.js" approval-scope "$MANIFEST" \
      --scope operator-nonstrict-refcas-override >/dev/null 2>&1; then
      SIGNED_PROTECTED_NONSTRICT_DIGEST="$(node \
        "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" \
        approval.protectedNonstrictProtectionDigest)"
      [ "$PROTECTED_NONSTRICT_DIGEST" = "$SIGNED_PROTECTED_NONSTRICT_DIGEST" ] || {
        echo "❌ MERGE BLOCKED: protected non-strict branch protection differs from the signed operator diagnosis." >&2
        exit 1
      }
    fi
    ATOMIC_BASE_FRESHNESS=protected-nonstrict-ref-cas
    ATOMIC_BASE_SOURCE=classic
  fi
fi
# Last resort, and only after BOTH classic protection and effective rulesets have
# had their chance to authorize: a ruleset can supply strict freshness on a repo
# with no classic protection, so running this earlier would reject a properly
# protected base.
if [ "$ATOMIC_BASE_FRESHNESS" = false ] && [ "$UNPROTECTABLE_MERGE_POLICY" = true ]; then
  # Classification lives in quality-base-protectability.sh so it is executable
  # in tests; it fails closed on anything short of a proven plan limit.
  #
  # Write the body to a file rather than a shell variable: command substitution
  # silently strips NUL bytes, which would let a malformed raw response be
  # normalized into a well-formed authorized one before jq ever sees it.
  PROTECTION_RC=0
  PROTECTION_BODY_FILE="$(mktemp)"
  # STDOUT ONLY. gh prints the JSON error body to stdout and a human-readable
  # line to stderr; folding them together would make the body un-parseable as a
  # single JSON document and force fragment-recovery, which is the exact
  # response-injection hole the classifier refuses to accept.
  gh api "repos/$REPOSITORY/branches/$ENCODED_BASE_NAME/protection" \
    >"$PROTECTION_BODY_FILE" 2>/dev/null || PROTECTION_RC=$?
  REPO_PRIVATE="$(gh api "repos/$REPOSITORY" --jq '.private' 2>/dev/null || echo unknown)"
  if bash "$SCRIPT_DIR/quality-base-protectability.sh" \
    --private "$REPO_PRIVATE" --rc "$PROTECTION_RC" \
    --body-file "$PROTECTION_BODY_FILE" >/dev/null; then
    echo "⚠️  [quality] this plan cannot protect branches on a private repo." >&2
    echo "⚠️  [quality] BS_QUALITY_ALLOW_UNPROTECTABLE_BASE=true accepts NON-ATOMIC base freshness." >&2
    echo "⚠️  [quality] The base may advance before the merge lands; that combination is untested." >&2
    ATOMIC_BASE_FRESHNESS=unprotectable
  else
    rm -f "$PROTECTION_BODY_FILE"
    echo "❌ MERGE BLOCKED: BS_QUALITY_ALLOW_UNPROTECTABLE_BASE is set, but this base is protectable" >&2
    echo "   or its capability could not be proven (private=$REPO_PRIVATE)." >&2
    echo "   Configure strict required-status checks instead." >&2
    exit 1
  fi
  rm -f "$PROTECTION_BODY_FILE"
fi
case "$ATOMIC_BASE_FRESHNESS" in
  true)
    MERGE_MODE=strict
    ;;
  protected-nonstrict-ref-cas)
    MERGE_MODE=protected-nonstrict-ref-cas
    ;;
  unprotectable)
    MERGE_MODE=unprotectable
    ;;
  *)
    record_merge_admission_blocked_terminal \
      "base:protected-nonstrict,pr:non-atomic-state" \
      "the PR base lacks server-enforced strict freshness" || exit 1
    echo "❌ MERGE BLOCKED: the PR base lacks server-enforced strict freshness." >&2
    echo "   Enable strict required-status checks or use a supported merge queue." >&2
    echo "   If this repo's plan cannot protect branches at all, set" >&2
    echo "   BS_QUALITY_ALLOW_UNPROTECTABLE_BASE=true to accept the weaker," >&2
    echo "   non-atomic guarantee explicitly." >&2
    # Exit 3 is the quality runner's typed action-required contract. This
    # outcome needs an external branch-governance change or the separately
    # signed protected-nonstrict capability; it is not a deterministic code
    # failure and must not be collapsed into terminal blocked evidence.
    exit 3
    ;;
esac
NONSTRICT_REFCAS_CAPABILITY=false
if node "$SCRIPT_DIR/quality-invocation.js" approval-scope "$MANIFEST" \
  --scope operator-nonstrict-refcas-override >/dev/null 2>&1; then
  NONSTRICT_REFCAS_CAPABILITY=true
fi
if [ "$NONSTRICT_REFCAS_CAPABILITY" = true ] &&
  [ "$MERGE_MODE" != protected-nonstrict-ref-cas ]; then
  echo "❌ MERGE BLOCKED: the protected non-strict ref-CAS capability cannot authorize another merge mode." >&2
  exit 1
fi
CI_GREEN_VERIFIED=false
if [ "$PREFLIGHT" = false ] && [ "${CI_BILLING_WAIVED:-false}" = false ]; then
  if [ "$ATOMIC_BASE_FRESHNESS" = unprotectable ]; then
    # This plan cannot define required checks, so the stamp waiter and final
    # authorization must both validate every registered exact-HEAD check.
    gh pr checks "$PR" --repo "$EXPECTED_REPOSITORY" >/dev/null || {
      echo "❌ MERGE BLOCKED: registered CI is not successful." >&2
      exit 1
    }
  else
    node "$SCRIPT_DIR/quality-required-checks.js" assert \
      --repo "$EXPECTED_REPOSITORY" --base "$ACTUAL_BASE_NAME" \
      --head "$ACTUAL_HEAD" --manifest "$MANIFEST" >/dev/null || {
      echo "❌ MERGE BLOCKED: required CI is not successful." >&2
      exit 1
    }
  fi
  CI_GREEN_VERIFIED=true
fi
if [ "$PREFLIGHT" = false ] &&
  [ "$MERGE_MODE" = protected-nonstrict-ref-cas ] &&
  [ "$NONSTRICT_REFCAS_CAPABILITY" != true ] &&
  [ "$CI_GREEN_VERIFIED" != true ]; then
  record_merge_admission_blocked_terminal \
    "ci:failed" \
    "protected non-strict autonomous ref-CAS requires green exact-head CI" || exit 1
  echo "❌ MERGE BLOCKED: protected non-strict autonomous ref-CAS requires green exact-head CI." >&2
  exit 1
fi
# A CI billing waiver on a genuinely server-enforceable base is normally
# refused outright: an admin merge there would silently step around real,
# working branch protection. The one accepted exception is an operator
# capability signed for EXACTLY this scope — narrower than
# operator-quality-override, which covers unavailable/malformed review
# evidence and has nothing to do with CI. Scope is checked, not just
# validity, so a capability signed for a different purpose can never satisfy
# this. It still requires quality-ci-billing-waiver.js to have independently
# proven the billing-preallocation signature above; this only widens WHICH
# repos may use that proof, never what counts as proof.
OPERATOR_CI_BILLING_APPROVED=false
if [ -n "${CI_BILLING_WAIVER_ARTIFACT:-}" ] &&
  [ "$ATOMIC_BASE_FRESHNESS" != unprotectable ] &&
  has_ci_billing_capability; then
  OPERATOR_CI_BILLING_APPROVED=true
  echo "⚠️  [quality] operator-signed CI outage capability accepted on a server-enforceable base." >&2
fi
if [ -n "${CI_BILLING_WAIVER_ARTIFACT:-}" ] &&
  [ "$ATOMIC_BASE_FRESHNESS" != unprotectable ] &&
  [ "$OPERATOR_CI_BILLING_APPROVED" = false ]; then
  echo "❌ MERGE BLOCKED: CI billing waivers are limited to plan-proven unprotectable private repositories," >&2
  echo "   unless the operator supplies a signed operator-ci-billing-override capability." >&2
  echo "   Refusing an admin merge that could bypass required reviews, status checks, or strict base freshness." >&2
  echo "   To authorize: BREAK_GLASS_APPROVED=true BREAK_GLASS_APPROVER=<you> \\" >&2
  echo "     node quality-wrapper.js approve --pr $PR --head <exact-head-sha> --override-ci-billing" >&2
  exit 1
fi
if [ -n "${CI_BILLING_WAIVER_ARTIFACT:-}" ] &&
  [ "$ATOMIC_BASE_FRESHNESS" != unprotectable ] &&
  { [ "$ADMIN_BASE_FRESHNESS" != true ] ||
    [ -z "$ATOMIC_BASE_SOURCE" ] ||
    [ "$ADMIN_BASE_SOURCE" != "$ATOMIC_BASE_SOURCE" ]; }; then
  echo "❌ MERGE BLOCKED: CI billing waiver admin merge requires a current authorized bypass actor." >&2
  echo "   GitHub did not prove that this authenticated operator can bypass the selected strict rule." >&2
  exit 1
fi
TIER="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" risk.tier)"
MERGE_AUTHORITY="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" risk.mergeAuthority)"
MERGE_AUTHORITY_BASE_SHA="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" risk.mergeAuthorityBaseSha)"
PROTECTED_NONSTRICT_REFCAS_POLICY="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" risk.protectedNonstrictRefCas)"
PROTECTED_NONSTRICT_REFCAS_POLICY_BASE_SHA="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" risk.protectedNonstrictRefCasBaseSha)"
# Manifests created before mergeAuthority was introduced retain their original
# manual-governance behavior. Every newly resolved campaign persists an explicit
# value, so an installed runtime upgrade can never grant authority mid-campaign.
[ -n "$MERGE_AUTHORITY" ] || MERGE_AUTHORITY=human-required
[ -n "$PROTECTED_NONSTRICT_REFCAS_POLICY" ] || PROTECTED_NONSTRICT_REFCAS_POLICY=signed-only
case "$MERGE_AUTHORITY" in
  autonomous | human-required) ;;
  *)
    echo "❌ MERGE BLOCKED: manifest has invalid merge authority '$MERGE_AUTHORITY'." >&2
    exit 1
    ;;
esac
if [ "$MERGE_MODE" = protected-nonstrict-ref-cas ] &&
  [ "$NONSTRICT_REFCAS_CAPABILITY" != true ] &&
  { [ "$MERGE_AUTHORITY" != autonomous ] ||
    [ "$MERGE_AUTHORITY_BASE_SHA" != "$EXPECTED_BASE_OID" ] ||
    [ "$PROTECTED_NONSTRICT_REFCAS_POLICY" != accept-non-atomic-pr-state ] ||
    [ "$PROTECTED_NONSTRICT_REFCAS_POLICY_BASE_SHA" != "$EXPECTED_BASE_OID" ]; }; then
  record_merge_admission_blocked_terminal \
    "base:protected-nonstrict,pr:non-atomic-state" \
    "protected non-strict ref-CAS needs exact signed authority or explicit repository cancellation-risk acceptance" || exit 1
  echo "❌ MERGE BLOCKED: protected non-strict ref-CAS needs exact signed authority or explicit repository cancellation-risk acceptance." >&2
  exit 3
fi

# Manual-governance policy (legacy opt-in).
#
# Review tier controls evidence depth. It does NOT control merge authority:
# autonomous campaigns merge once their revision-bound review, CI, base, and
# trailer evidence is clean. Repositories that explicitly select
# `human-required` retain the signed break-glass check below.
#
# In either mode, deterministic findings, failed/stale CI, or changed base/HEAD
# remain hard stops. AI leads and incomplete discovery are signed advisory
# evidence and never replace those deterministic authorities.
#
# In human-required mode, two independent conditions require a signed capability:
#
#   A. The change touches the always-human security floor
#      (secrets/creds/keys/auth/license/deploy/webhooks — humanFloor). Checked
#      for every manually governed merge, independent of tier: a persisted tier
#      is derived from an earlier revision and a floor path can be added during
#      remediation or evade tier classification, so gating the floor on
#      tier=critical would let such a change through (Codex review: tier-nesting
#      exploit).
#
#   B. The change is critical tier AND the base is server-enforceable. On a repo
#      that genuinely cannot be enforced (ATOMIC_BASE_FRESHNESS=unprotectable — a
#      value set only by the hardened quality-base-protectability.sh classifier),
#      a human break-glass buys no real protection (no external attacker, no
#      server enforcement), so clean review + green gates suffice for critical.
#
# Fail-closed exit-code contract of human-floor-check when manual governance is
# explicitly enabled:
#   0  = VERIFIED CLEAR of the floor
#   10 = touches the floor
#   anything else (1 = error, empty diff, tampered manifest) = treat as touches.
# Only an explicit rc=0 counts as clear; every other outcome requires a human, so
# an errored or ambiguous check can never silently authorize an autonomous merge.
REQUIRE_APPROVAL=false
FLOOR_REASON=""
if [ "$MERGE_AUTHORITY" = human-required ]; then
  HUMAN_FLOOR_RC=0
  node "$SCRIPT_DIR/quality-invocation.js" human-floor-check "$MANIFEST" \
    || HUMAN_FLOOR_RC=$?
  TOUCHES_HUMAN_FLOOR=true
  [ "$HUMAN_FLOOR_RC" -eq 0 ] && TOUCHES_HUMAN_FLOOR=false
  if [ "$TOUCHES_HUMAN_FLOOR" = true ]; then
    REQUIRE_APPROVAL=true
    FLOOR_REASON="the change touches the always-human security floor"
  elif [ "$TIER" = critical ] && [ "$ATOMIC_BASE_FRESHNESS" != unprotectable ]; then
    REQUIRE_APPROVAL=true
    FLOOR_REASON="critical tier on a server-enforceable base"
  fi
fi

if [ "$REQUIRE_APPROVAL" = true ]; then
  node "$SCRIPT_DIR/quality-invocation.js" approval-valid "$MANIFEST" || {
    echo "❌ MERGE BLOCKED: human break-glass approval is missing or stale ($FLOOR_REASON)." >&2
    exit 1
  }
elif [ "$MERGE_AUTHORITY" = human-required ] && [ "$TIER" = critical ]; then
  echo "[quality] Critical tier on an unprotectable private repo, clear of the" >&2
  echo "          always-human security floor: accepting clean review + green" >&2
  echo "          gates in lieu of human break-glass (Phase 0 policy)." >&2
fi
[ "$PREFLIGHT" = false ] || {
  echo "BS_QUALITY_BASE_PROTECTION=$ATOMIC_BASE_FRESHNESS"
  echo "[quality] non-mutating merge authorization preflight passed"
  exit 0
}
BASE_REF="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" revisions.baseRef)"
if [ "${CI_BILLING_WAIVED:-false}" = true ]; then
  QUALITY_CI_BILLING_LOCAL_REVIEW=true bash \
    "$SCRIPT_DIR/quality-validate-review-trailers.sh" \
    --manifest "$MANIFEST" --base "$BASE_REF" \
    --required-tier "$TIER" --require-signature || exit 1
else
  bash "$SCRIPT_DIR/quality-validate-review-trailers.sh" \
    --manifest "$MANIFEST" --base "$BASE_REF" \
    --required-tier "$TIER" --require-signature || exit 1
fi
FINAL_PR_JSON="$(gh pr view "$PR" --repo "$EXPECTED_REPOSITORY" \
  --json headRefName,headRefOid,baseRefName)" || exit 1
[ "$(printf '%s' "$FINAL_PR_JSON" | jq -r '.headRefName')" = "$EXPECTED_HEAD_REF" ] || {
  echo "❌ MERGE BLOCKED: PR head branch changed immediately before merge." >&2
  exit 1
}
[ "$(printf '%s' "$FINAL_PR_JSON" | jq -r '.baseRefName')" = "$ACTUAL_BASE_NAME" ] || {
  echo "❌ MERGE BLOCKED: PR target branch changed immediately before merge." >&2
  exit 1
}
# Capture ls-remote BEFORE piping. `cmd | awk` reports awk's status, not git's,
# and this script does not set pipefail — so a failed lookup whose partial output
# still parsed would have been read as a successful base re-read.
FINAL_BASE_LS="$(git ls-remote origin "refs/heads/$ACTUAL_BASE_NAME")" || {
  echo "❌ MERGE BLOCKED: could not re-read the base ref to confirm freshness." >&2
  exit 1
}
FINAL_BASE_OID="$(printf '%s' "$FINAL_BASE_LS" | awk 'NR==1 {print $1}')"
[ -n "$FINAL_BASE_OID" ] || {
  echo "❌ MERGE BLOCKED: base ref lookup returned no OID." >&2
  exit 1
}
[ "$(printf '%s' "$FINAL_PR_JSON" | jq -r '.headRefOid')" = "$ACTUAL_HEAD" ] &&
  [ "$FINAL_BASE_OID" = "$EXPECTED_BASE_OID" ] || {
    echo "❌ MERGE BLOCKED: PR identity changed immediately before merge." >&2
    exit 1
  }
LEASE_ADMIN=false
if [ "$MERGE_MODE" = protected-nonstrict-ref-cas ]; then
  LEASE_ADMIN=true
  if [ "$NONSTRICT_REFCAS_CAPABILITY" = true ]; then
    echo "⚠️  [quality] administrator non-force ref update authorized by the signed protected non-strict ref-CAS capability." >&2
  else
    echo "[quality] autonomous non-force exact-ref update authorized by complete green evidence." >&2
  fi
fi
if [ "${CI_BILLING_WAIVED:-false}" = true ]; then
  if [ "$ATOMIC_BASE_FRESHNESS" != unprotectable ]; then
    { [ "$ADMIN_BASE_FRESHNESS" = true ] &&
      [ -n "$ATOMIC_BASE_SOURCE" ] &&
      [ "$ADMIN_BASE_SOURCE" = "$ATOMIC_BASE_SOURCE" ]; } || {
      echo "❌ MERGE BLOCKED: CI billing waiver admin merge requires a current authorized bypass actor." >&2
      exit 1
    }
    # Revalidate the operator scope immediately before --admin, same
    # discipline as the artifact revalidation below: the earlier check
    # authorizes skipping the green-check query, this one authorizes the
    # actual admin merge, and neither trusts a variable computed earlier.
    has_ci_billing_capability || {
      echo "❌ MERGE BLOCKED: CI billing waiver admin merge on a server-enforceable base requires a" >&2
      echo "   currently-valid operator-ci-billing-override capability; none is present immediately before merge." >&2
      exit 1
    }
    echo "⚠️  [quality] admin merge authorized by operator-signed CI billing override on a server-enforceable base." >&2
  fi
  node "$SCRIPT_DIR/quality-ci-billing-waiver.js" \
    --repo "$EXPECTED_REPOSITORY" --pr "$PR" --head "$ACTUAL_HEAD" \
    --artifact "$CI_BILLING_WAIVER_ARTIFACT" >/dev/null || {
    echo "❌ MERGE BLOCKED: CI billing waiver changed before merge." >&2
    exit 1
  }
  if [ "$OPERATOR_CI_BILLING_APPROVED" = true ]; then
    SIGNED_WAIVER_DIGEST="$(node "$SCRIPT_DIR/quality-invocation.js" field "$MANIFEST" approval.ciBillingEvidenceSha256)"
    verify_ci_billing_digest "$CI_BILLING_WAIVER_ARTIFACT" "$SIGNED_WAIVER_DIGEST" || {
      echo "❌ MERGE BLOCKED: live CI billing evidence differs from the signed operator diagnosis." >&2
      exit 1
    }
  fi
  LEASE_ADMIN=true
  echo "⚠️  [quality] using admin merge only for verified GitHub Actions billing preallocation failures." >&2
fi
if { [ "$MERGE_MODE" = protected-nonstrict-ref-cas ] ||
  { [ "${CI_BILLING_WAIVED:-false}" = true ] &&
    [ "$ATOMIC_BASE_FRESHNESS" != unprotectable ]; }; } &&
  [ "${BS_QUALITY_PROTECTION_RECHECK:-0}" != 1 ]; then
  # Re-read the same server-owned protection source immediately before the
  # lease performs the administrator merge. The guard prevents the preflight
  # child from recursing while preserving the final source/equality checks.
  BS_QUALITY_PROTECTION_RECHECK=1 \
    bash "$SCRIPT_DIR/quality-authorize-merge.sh" --manifest "$MANIFEST" --preflight \
    >/dev/null || {
    echo "❌ MERGE BLOCKED: administrator protection changed or could not be revalidated immediately before merge." >&2
    exit 1
  }
fi
if node "$SCRIPT_DIR/quality-repo-lease.js" merge \
  --manifest "$MANIFEST" \
  --expected-head "$ACTUAL_HEAD" \
  --mode "$MERGE_MODE" \
  --protection-digest "$PROTECTED_NONSTRICT_DIGEST" \
  --admin "$LEASE_ADMIN" >/dev/null; then
  echo "[quality] merged exact reviewed revision $ACTUAL_HEAD"
  exit 0
fi
echo "❌ MERGE BLOCKED: GitHub did not prove the exact-head merge; the repository merge guard remains quarantined." >&2
exit 1
