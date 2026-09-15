#!/usr/bin/env bash
# Decide whether a PR base is genuinely UNPROTECTABLE — i.e. the repository's
# plan cannot enforce branch protection at all — as opposed to protectable but
# unconfigured, or simply unobserved.
#
# Split out of quality-authorize-merge.sh so the classification is executable in
# tests. The distinction gates an escape hatch that permits merging without
# server-enforced strict base freshness, so a false "unprotectable" silently
# weakens the merge gate. Fail closed on every ambiguity.
#
# Usage: quality-base-protectability.sh --private <true|false|unknown> \
#          --rc <gh-exit-status> --body <gh-stdout-json>
#
# --body must be the API response body from STDOUT ONLY. Never pass output
# captured with 2>&1: interleaved stderr makes the body un-parseable as a single
# JSON document, and recovering a JSON fragment out of mixed text is exactly the
# response-injection hole this script exists to avoid.
#
# Exit 0 = unprotectable (escape hatch may open). Non-zero = protectable,
# unknown, or unobserved (must stay blocked).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# HTTP 403 is overloaded, so a bare status code proves nothing:
#   plan limit -> the exact plan-limit message with status 403
#   rate limit -> 403 whose message may itself quote the upgrade text
#   no access  -> 404 "Not Found", never this message
# The message and status are matched in quality-parse-plan-limit.js.

PRIVATE=""
RC=""
BODY_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --private)
      [ "$#" -ge 2 ] || {
        echo "quality-base-protectability: --private requires a value" >&2
        exit 1
      }
      PRIVATE="$2"
      shift 2
      ;;
    --rc)
      [ "$#" -ge 2 ] || {
        echo "quality-base-protectability: --rc requires a value" >&2
        exit 1
      }
      RC="$2"
      shift 2
      ;;
    --body-file)
      [ "$#" -ge 2 ] || {
        echo "quality-base-protectability: --body-file requires a value" >&2
        exit 1
      }
      BODY_FILE="$2"
      shift 2
      ;;
    *) echo "quality-base-protectability: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[ -n "$PRIVATE" ] && [ -n "$RC" ] && [ -n "$BODY_FILE" ] || {
  echo "quality-base-protectability: --private, --rc and --body-file are required" >&2
  exit 2
}
[ -f "$BODY_FILE" ] || {
  echo "unobserved: response body file is missing" >&2
  exit 1
}

# A public repo can always be protected; only a private repo can be plan-limited.
[ "$PRIVATE" = true ] || {
  echo "protectable: repository is not private (private=$PRIVATE)" >&2
  exit 1
}

# The request must have FAILED. A successful response that merely quotes the
# upgrade text — inside a required-check context, say — must never qualify.
[ "$RC" -ne 0 ] 2>/dev/null || {
  echo "protectable: protection request succeeded (rc=$RC)" >&2
  exit 1
}

# Body validation lives in a real tokenizer, not in jq or grep. Three shell
# approaches were tried and each was bypassable: substring counting cannot see
# JSON-escaped key names; every parser (jq, JSON.parse) keeps only the LAST
# duplicate key; and `jq --stream` emits leaf paths, so a duplicate whose first
# value is a non-empty container never produces a depth-1 path at all.
node "$SCRIPT_DIR/quality-parse-plan-limit.js" "$BODY_FILE" >/dev/null || exit 1

echo "unprotectable"
exit 0
