#!/usr/bin/env bash
# Validate that HEAD carries internally consistent, revision-bound evidence.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASE_REF=origin/main
MANIFEST=""
REQUIRED_TIER=""
REQUIRE_SIGNATURE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || {
        echo "quality-validate-review-trailers: --manifest requires a value" >&2
        exit 1
      }
      MANIFEST="$2"
      shift 2
      ;;
    --base)
      [ "$#" -ge 2 ] || {
        echo "quality-validate-review-trailers: --base requires a value" >&2
        exit 1
      }
      BASE_REF="$2"
      shift 2
      ;;
    --required-tier)
      [ "$#" -ge 2 ] || {
        echo "quality-validate-review-trailers: --required-tier requires a value" >&2
        exit 1
      }
      REQUIRED_TIER="$2"
      shift 2
      ;;
    --require-signature) REQUIRE_SIGNATURE=true; shift ;;
    *) BASE_REF="$1"; shift ;;
  esac
done
AUTHORIZATION=""
if [ -n "$MANIFEST" ]; then
  AUTHORIZATION="$(node "$SCRIPT_DIR/quality-invocation.js" review-authorization "$MANIFEST")" || exit 1
  AUTH_HEAD="$(printf '%s' "$AUTHORIZATION" | jq -r '.head')"
  AUTH_BASE="$(printf '%s' "$AUTHORIZATION" | jq -r '.base')"
  AUTH_PROVIDER="$(printf '%s' "$AUTHORIZATION" | jq -r '.provider')"
  AUTH_PRIMARY="$(printf '%s' "$AUTHORIZATION" | jq -r '.primary')"
  AUTH_FALLBACK="$(printf '%s' "$AUTHORIZATION" | jq -r '.fallback')"
  AUTH_FINDINGS="$(printf '%s' "$AUTHORIZATION" | jq -r '.blockingCount')"
  AUTH_TIER="$(printf '%s' "$AUTHORIZATION" | jq -r '.tier')"
  AUTH_CONTRACT="$(printf '%s' "$AUTHORIZATION" | jq -r '.contractVersion // 1')"
  if [ "$AUTH_CONTRACT" -ge 2 ]; then
    AUTH_LEADS="$(printf '%s' "$AUTHORIZATION" | jq -r '.leads')"
    AUTH_REVIEW_STATUS="$(printf '%s' "$AUTHORIZATION" | jq -r '.reviewStatus')"
    AUTH_POLICY="$(printf '%s' "$AUTHORIZATION" | jq -r '.policyDigest')"
    AUTH_AGENTS="$(printf '%s' "$AUTHORIZATION" | jq -r '.agentsSha256')"
    AUTH_DOMAIN="$(printf '%s' "$AUTHORIZATION" | jq -r '.domain')"
    AUTH_SELECTION="$(printf '%s' "$AUTHORIZATION" | jq -r '.selectionRule')"
    AUTH_REPOSITORY="$(printf '%s' "$AUTHORIZATION" | jq -r '.repositoryKey')"
    AUTH_DIFF="$(printf '%s' "$AUTHORIZATION" | jq -r '.diffSha256')"
    AUTH_EVIDENCE="$(printf '%s' "$AUTHORIZATION" | jq -r '.evidenceSha256')"
  fi
fi

PARSED="$(git log -1 --format=%B | git interpret-trailers --parse 2>/dev/null)"
QUALITY_TRAILER="$(printf '%s\n' "$PARSED" | grep -E '^Reviewed-By: quality( |$)' | head -1)"
if [ -z "$QUALITY_TRAILER" ]; then
  # New campaigns keep the reviewed branch immutable. Their signed evidence
  # lives in an exact-head GitHub check run, so validation must not require a
  # synthetic child commit or its trailers. Legacy stamped campaigns continue
  # through the trailer validator below for resumability.
  if [ -n "$MANIFEST" ]; then
    if { [ "${QUALITY_LOCAL_REVIEW:-false}" = true ] ||
      { [ "${QUALITY_CI_BILLING_LOCAL_REVIEW:-false}" = true ] &&
        node "$SCRIPT_DIR/quality-invocation.js" ci-billing-capability "$MANIFEST" \
          >/dev/null 2>&1; }; }; then
      LOCAL_ARTIFACT="${QUALITY_LOCAL_REVIEW_ARTIFACT:-}"
      [ -n "$LOCAL_ARTIFACT" ] || {
        echo "signed local review evidence artifact is required" >&2
        exit 1
      }
      node "$SCRIPT_DIR/quality-review-check.js" verify-local \
        --manifest "$MANIFEST" --artifact "$LOCAL_ARTIFACT" \
        --required-tier "$REQUIRED_TIER" >/dev/null || exit 1
      # A user token cannot create GitHub check-runs (the API requires an App
      # token). Under the exact-head, independently verified billing waiver,
      # use the persisted local review checkpoint instead of pretending a
      # remote check exists. The operator capability and CI waiver remain the
      # separate, signed authorities for this exceptional path.
      AUTHORIZATION="$(node "$SCRIPT_DIR/quality-invocation.js" \
        review-authorization "$MANIFEST")" || exit 1
      AUTH_HEAD="$(printf '%s' "$AUTHORIZATION" | jq -r '.head')"
      AUTH_BASE="$(printf '%s' "$AUTHORIZATION" | jq -r '.base')"
      AUTH_TIER="$(printf '%s' "$AUTHORIZATION" | jq -r '.tier')"
      AUTH_FINDINGS="$(printf '%s' "$AUTHORIZATION" | jq -r '.blockingCount')"
      AUTH_STATUS="$(printf '%s' "$AUTHORIZATION" | jq -r '.reviewStatus // empty')"
      AUTH_REVIEW_OVERRIDE="$(printf '%s' "$AUTHORIZATION" | jq -r '
        .operatorOverride == true and
        ([.override.acceptedConditions[]? |
          select(startswith("review:") and
            (startswith("review:finding:") | not))] | length > 0)
      ')"
      CURRENT_HEAD="$(git rev-parse HEAD)"
      CURRENT_BASE="$(git merge-base HEAD "$BASE_REF")" || exit 1
      [ "$AUTH_HEAD" = "$CURRENT_HEAD" ] || {
        echo "local review evidence head is stale" >&2
        exit 1
      }
      [ "$AUTH_BASE" = "$CURRENT_BASE" ] || {
        echo "local review evidence base is stale" >&2
        exit 1
      }
      [ "$AUTH_FINDINGS" = 0 ] || {
        echo "local review evidence contains blocking findings" >&2
        exit 1
      }
      { [ "$AUTH_STATUS" = complete ] ||
        [ "$AUTH_STATUS" = policy-exempt ] ||
        { [ "$AUTH_STATUS" = incomplete ] &&
          [ "$AUTH_REVIEW_OVERRIDE" = true ]; }; } || {
        echo "local review evidence is not complete" >&2
        exit 1
      }
      rank() {
        case "$1" in
          low) echo 0 ;; medium) echo 1 ;; high) echo 2 ;; critical) echo 3 ;;
          *) return 1 ;;
        esac
      }
      AUTH_RANK="$(rank "$AUTH_TIER")" || {
        echo "local review evidence tier is invalid" >&2
        exit 1
      }
      REQUIRED_RANK="$(rank "$REQUIRED_TIER")" || {
        echo "required quality tier is invalid" >&2
        exit 1
      }
      [ "$AUTH_RANK" -ge "$REQUIRED_RANK" ] || {
        echo "local review evidence tier is below the required tier" >&2
        exit 1
      }
      echo "[quality] verified local signed review checkpoint for exact-head merge" >&2
    else
      node "$SCRIPT_DIR/quality-review-check.js" verify \
        --manifest "$MANIFEST" --required-tier "$REQUIRED_TIER"
    fi
  else
    REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || exit 1
    node "$SCRIPT_DIR/quality-review-check.js" verify \
      --repository "$REPOSITORY" --head "$(git rev-parse HEAD)" --base "$BASE_REF" \
      --required-tier "$REQUIRED_TIER"
  fi
  exit $?
fi
for key in Quality-Tier Quality-Reviewer Quality-Primary Quality-Fallback Quality-Findings Quality-Head Quality-Base; do
  [ "$(printf '%s\n' "$PARSED" | grep -c "^${key}: ")" -eq 1 ] || {
    echo "quality trailer ${key} is missing or duplicated" >&2
    exit 1
  }
done

STAMP_HEAD="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Head: //p' | head -1)"
STAMP_BASE="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Base: //p' | head -1)"
STAMP_PROVIDER="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Reviewer: //p' | head -1)"
STAMP_TIER="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Tier: //p' | head -1)"
STAMP_FINDINGS="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Findings: //p' | head -1)"
STAMP_PRIMARY="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Primary: //p' | head -1)"
STAMP_FALLBACK="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Fallback: //p' | head -1)"
STAMP_SIGNATURE="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Evidence-Signature: //p' | head -1)"
STAMP_CONTRACT="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Contract: //p' | head -1)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_PARENT="$(git rev-parse HEAD~1 2>/dev/null || true)"
CURRENT_BASE="$(git merge-base HEAD "$BASE_REF")"

if { [ "$STAMP_HEAD" != "$CURRENT_HEAD" ] && [ "$STAMP_HEAD" != "$CURRENT_PARENT" ]; } \
   || [ "$STAMP_BASE" != "$CURRENT_BASE" ] || [ -z "$STAMP_PROVIDER" ] \
   || [ -z "$STAMP_TIER" ] || [ -z "$STAMP_FINDINGS" ]; then
  echo "quality trailer is stale or malformed" >&2
  exit 1
fi
SIGNATURE_V2_ARGS=()
if [ -n "$STAMP_CONTRACT" ]; then
  [ "$STAMP_CONTRACT" = 2 ] || {
    echo "quality trailer contract version is unsupported" >&2
    exit 1
  }
  for key in Quality-Policy Quality-Agents Quality-Domain Quality-Selection \
    Quality-Repository Quality-Diff Quality-Review-Evidence Quality-Leads \
    Quality-Review-Status; do
    [ "$(printf '%s\n' "$PARSED" | grep -c "^${key}: ")" -eq 1 ] || {
      echo "quality trailer ${key} is missing or duplicated" >&2
      exit 1
    }
  done
  STAMP_POLICY="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Policy: //p' | head -1)"
  STAMP_LEADS="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Leads: //p' | head -1)"
  STAMP_REVIEW_STATUS="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Review-Status: //p' | head -1)"
  STAMP_AGENTS="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Agents: //p' | head -1)"
  STAMP_DOMAIN="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Domain: //p' | head -1)"
  STAMP_SELECTION="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Selection: //p' | head -1)"
  STAMP_REPOSITORY="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Repository: //p' | head -1)"
  STAMP_DIFF="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Diff: //p' | head -1)"
  STAMP_EVIDENCE="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Review-Evidence: //p' | head -1)"
  SIGNATURE_V2_ARGS=(
    --contractVersion "$STAMP_CONTRACT" --leads "$STAMP_LEADS"
    --reviewStatus "$STAMP_REVIEW_STATUS" --policyDigest "$STAMP_POLICY"
    --agentsSha256 "$STAMP_AGENTS" --domain "$STAMP_DOMAIN"
    --selectionRule "$STAMP_SELECTION"
    --repositoryKey "$STAMP_REPOSITORY" --diffSha256 "$STAMP_DIFF"
    --evidenceSha256 "$STAMP_EVIDENCE"
  )
fi
if [ -n "$AUTHORIZATION" ] && {
  [ "$STAMP_HEAD" != "$AUTH_HEAD" ] || [ "$STAMP_BASE" != "$AUTH_BASE" ] ||
  [ "$STAMP_PROVIDER" != "$AUTH_PROVIDER" ] ||
  [ "$STAMP_PRIMARY" != "$AUTH_PRIMARY" ] ||
  [ "$STAMP_FALLBACK" != "$AUTH_FALLBACK" ] ||
  [ "$STAMP_FINDINGS" != "$AUTH_FINDINGS" ] ||
  [ "$STAMP_TIER" != "$AUTH_TIER" ]
}; then
  echo "quality trailer does not match manifest authorization" >&2
  exit 1
fi
if [ -n "$AUTHORIZATION" ] && [ "${STAMP_CONTRACT:-1}" != "$AUTH_CONTRACT" ]; then
  echo "quality trailer contract does not match manifest authorization" >&2
  exit 1
fi
if [ -n "$AUTHORIZATION" ] && [ "$AUTH_CONTRACT" -ge 2 ] && {
  [ "$STAMP_LEADS" != "$AUTH_LEADS" ] ||
  [ "$STAMP_REVIEW_STATUS" != "$AUTH_REVIEW_STATUS" ] ||
  [ "$STAMP_POLICY" != "$AUTH_POLICY" ] ||
  [ "$STAMP_AGENTS" != "$AUTH_AGENTS" ] ||
  [ "$STAMP_DOMAIN" != "$AUTH_DOMAIN" ] ||
  [ "$STAMP_SELECTION" != "$AUTH_SELECTION" ] ||
  [ "$STAMP_REPOSITORY" != "$AUTH_REPOSITORY" ] ||
  [ "$STAMP_DIFF" != "$AUTH_DIFF" ] ||
  [ "$STAMP_EVIDENCE" != "$AUTH_EVIDENCE" ]
}; then
  echo "quality policy trailers do not match manifest authorization" >&2
  exit 1
fi
if [ "$STAMP_HEAD" = "$CURRENT_PARENT" ] && ! git diff --quiet HEAD~1 HEAD; then
  echo "stamp commit changes the reviewed tree" >&2
  exit 1
fi

EXPECTED="Reviewed-By: ${STAMP_PROVIDER}"
printf '%s\n' "$PARSED" | grep -Fxq "$EXPECTED" || {
  echo "provider trailer does not exactly match quality authorization" >&2
  exit 1
}

if [ "$REQUIRE_SIGNATURE" = true ]; then
  [ -n "$STAMP_SIGNATURE" ] || {
    echo "quality evidence signature is missing" >&2
    exit 1
  }
  [ -n "${QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY:-}" ] || {
    echo "quality evidence public key is missing" >&2
    exit 1
  }
  node "$SCRIPT_DIR/quality-review-evidence.js" verify \
    --head "$STAMP_HEAD" --base "$STAMP_BASE" --tier "$STAMP_TIER" \
    --findings "$STAMP_FINDINGS" --reviewer "$STAMP_PROVIDER" \
    --primary "$STAMP_PRIMARY" --fallback "$STAMP_FALLBACK" \
    "${SIGNATURE_V2_ARGS[@]}" \
    --signature "$STAMP_SIGNATURE" || exit 1
fi

if [ "$STAMP_PROVIDER" = "operator-quality-override" ]; then
  [ "$(printf '%s\n' "$PARSED" |
    grep -Ec '^Quality-Override: operator-(quality-override|nonstrict-refcas-override)$')" -eq 1 ] || {
    echo "operator override evidence is missing its override trailer" >&2
    exit 1
  }
  for key in Quality-Override-Reason Quality-Override-Accepted Quality-Override-Approver; do
    [ "$(printf '%s\n' "$PARSED" | grep -c "^${key}: ")" -eq 1 ] || {
      echo "operator override evidence is missing or duplicating ${key}" >&2
      exit 1
    }
  done
  STAMP_OVERRIDE_ACCEPTED="$(printf '%s\n' "$PARSED" | sed -n 's/^Quality-Override-Accepted: //p' | head -1)"
  [ -n "$STAMP_OVERRIDE_ACCEPTED" ] || {
    echo "operator override evidence has an empty accepted-conditions list" >&2
    exit 1
  }
elif printf '%s\n' "$PARSED" | grep -q '^Quality-Override'; then
  echo "non-override evidence must not carry Quality-Override trailers" >&2
  exit 1
fi

tier_rank() {
  case "$1" in
    low) echo 0 ;;
    medium) echo 1 ;;
    high) echo 2 ;;
    critical) echo 3 ;;
    *) return 1 ;;
  esac
}
STAMP_RANK="$(tier_rank "$STAMP_TIER")" || {
  echo "quality evidence tier is invalid" >&2
  exit 1
}
if [ -n "$REQUIRED_TIER" ]; then
  REQUIRED_RANK="$(tier_rank "$REQUIRED_TIER")" || {
    echo "required quality tier is invalid" >&2
    exit 1
  }
  [ "$STAMP_RANK" -ge "$REQUIRED_RANK" ] || {
    echo "quality evidence tier is below the required tier" >&2
    exit 1
  }
fi
if [ -n "$REQUIRED_TIER" ] && [ "$REQUIRED_RANK" -ge 2 ]; then
  [ "$REQUIRE_SIGNATURE" = true ] || {
    echo "high/critical evidence requires --require-signature" >&2
    exit 1
  }
  # Contract v2 makes provider discovery advisory. A signed fallback or typed
  # incomplete attempt is valid evidence that bounded discovery ran; requiring
  # the configured primary here would make provider availability merge
  # authority again. Legacy v1 retains its stricter primary-provider rule.
  if [ -z "$STAMP_CONTRACT" ] && [ "$STAMP_PROVIDER" != "operator-quality-override" ]; then
    [ -n "$STAMP_PRIMARY" ] || {
      echo "high/critical evidence requires a configured primary reviewer" >&2
      exit 1
    }
    [ "$STAMP_PROVIDER" = "$STAMP_PRIMARY" ] || {
      echo "high/critical evidence requires the configured primary reviewer" >&2
      exit 1
    }
  fi
fi
echo "quality review evidence verified: reviewer=$STAMP_PROVIDER head=$STAMP_HEAD base=$STAMP_BASE"
