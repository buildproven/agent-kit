#!/usr/bin/env bash
# backlog-post-merge.sh - Close every Linear issue cited by a merged change.
#
# Run manually or from a local post-merge hook when native Linear integration is
# unavailable. The hosted agent-kit repository uses Linear's native GitHub
# integration and explicit `Closes TEAM-123` statements in pull request bodies.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

fail() {
  echo "[backlog-post-merge] ERROR: $*" >&2
  exit 1
}

extract_linear_ids() {
  # Identifiers are intentionally prefix-agnostic: public users should not need
  # to fork this script just because their Linear team key is not BUI or CS.
  { grep -Eo '[A-Z]{2,}-[0-9]+' || true; } | sort -u
}

github_pr_bodies() {
  if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${GITHUB_SHA:-}" ]]; then
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    fail "gh is required to read associated PR bodies"
  fi

  gh api --paginate "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/pulls" \
    --jq '.[].body // empty' || {
      echo "[backlog-post-merge] ERROR: could not read associated PR bodies" >&2
      return 1
    }
}

collect_linear_ids() {
  local pr_bodies source_text
  if [[ -n "${ITEM_ID_OVERRIDE:-}" ]]; then
    printf '%s\n' "$ITEM_ID_OVERRIDE" | extract_linear_ids
    return 0
  fi

  if ! source_text="$(git -C "$GIT_ROOT" log -1 --format='%s%n%b')"; then
    echo "[backlog-post-merge] ERROR: could not read the merged commit" >&2
    return 1
  fi
  if ! pr_bodies="$(github_pr_bodies)"; then
    return 1
  fi
  source_text+=$'\n'
  source_text+="$pr_bodies"
  printf '%s\n' "$source_text" | extract_linear_ids
}

linear_graphql() {
  local query="$1"
  local variables="${2:-}"
  local payload response
  [[ -n "$variables" ]] || variables="{}"
  payload="$(jq -cn \
    --arg query "$query" \
    --argjson variables "$variables" \
    '{query: $query, variables: $variables}')"
  if ! response="$(curl -fsS \
    -H "Content-Type: application/json" \
    -H "Authorization: $LINEAR_API_KEY" \
    --data "$payload" \
    "https://api.linear.app/graphql")"; then
    return 1
  fi
  if ! jq -e '(.errors // [] | length == 0) and (.data != null)' \
    >/dev/null <<<"$response"; then
    echo "[backlog-post-merge] ERROR: Linear GraphQL request failed" >&2
    jq -r '.errors[]?.message // empty' <<<"$response" >&2 || true
    return 1
  fi
  printf '%s' "$response"
}

LINEAR_API_KEY="${LINEAR_API_KEY:-}"
if [[ -z "$LINEAR_API_KEY" && -f "$GIT_ROOT/.env" ]]; then
  LINEAR_API_KEY="$(awk -F= '/^LINEAR_API_KEY=/{sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' "$GIT_ROOT/.env")"
fi

if ! item_ids_text="$(collect_linear_ids)"; then
  fail "could not collect Linear issue identifiers"
fi
ITEM_IDS=()
while IFS= read -r item_id; do
  [[ -n "$item_id" ]] && ITEM_IDS+=("$item_id")
done <<<"$item_ids_text"
if [[ ${#ITEM_IDS[@]} -eq 0 ]]; then
  echo "[backlog-post-merge] No Linear issue identifiers found; nothing to update"
  exit 0
fi

if [[ -z "$LINEAR_API_KEY" ]]; then
  fail "LINEAR_API_KEY is required to close: ${ITEM_IDS[*]}. Add it as a repository Actions secret."
fi

ISSUE_QUERY="query Issue(\$issueId: String!) {
  issue(id: \$issueId) { team { id } }
}"
STATE_QUERY="query TeamCompletedStatuses(\$teamId: String!) {
  team(id: \$teamId) {
    states(filter: { type: { eq: \"completed\" } }) {
      nodes { id position }
    }
  }
}"
CLOSE_MUTATION="mutation CloseIssue(\$issueId: String!, \$stateId: String!) {
  issueUpdate(id: \$issueId, input: { stateId: \$stateId }) { success }
}"
FAILED_IDS=()
for item_id in "${ITEM_IDS[@]}"; do
  issue_variables="$(jq -cn --arg issueId "$item_id" '{issueId: $issueId}')"
  if ! issue_response="$(linear_graphql "$ISSUE_QUERY" "$issue_variables")"; then
    echo "[backlog-post-merge] ERROR: could not resolve $item_id" >&2
    FAILED_IDS+=("$item_id")
    continue
  fi
  team_id="$(jq -r '.data.issue.team.id // empty' <<<"$issue_response")"
  if [[ -z "$team_id" ]]; then
    echo "[backlog-post-merge] ERROR: $item_id was not found with a team" >&2
    FAILED_IDS+=("$item_id")
    continue
  fi

  state_variables="$(jq -cn --arg teamId "$team_id" '{teamId: $teamId}')"
  if ! state_response="$(linear_graphql "$STATE_QUERY" "$state_variables")"; then
    echo "[backlog-post-merge] ERROR: could not resolve a completed state for $item_id" >&2
    FAILED_IDS+=("$item_id")
    continue
  fi
  done_state_id="$(jq -r \
    '.data.team.states.nodes | sort_by(.position) | .[0].id // empty' \
    <<<"$state_response")"
  if [[ -z "$done_state_id" ]]; then
    echo "[backlog-post-merge] ERROR: $item_id has no completed workflow state" >&2
    FAILED_IDS+=("$item_id")
    continue
  fi

  close_variables="$(jq -cn \
    --arg issueId "$item_id" \
    --arg stateId "$done_state_id" \
    '{issueId: $issueId, stateId: $stateId}')"
  if ! close_response="$(linear_graphql "$CLOSE_MUTATION" "$close_variables")"; then
    echo "[backlog-post-merge] ERROR: request failed while closing $item_id" >&2
    FAILED_IDS+=("$item_id")
    continue
  fi
  result="$(jq -r '.data.issueUpdate.success // false' <<<"$close_response")"
  if [[ "$result" == "true" ]]; then
    echo "[backlog-post-merge] Marked $item_id as Done"
  else
    echo "[backlog-post-merge] ERROR: Linear rejected the update for $item_id" >&2
    FAILED_IDS+=("$item_id")
  fi
done

if [[ ${#FAILED_IDS[@]} -gt 0 ]]; then
  fail "failed to close: ${FAILED_IDS[*]}"
fi
