#!/usr/bin/env bash
# Active-repo fleet steward: discover, audit, optionally repair via provider.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
CONFIG="${BS_FLEET_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/buildproven/fleet.json}"
MODE="audit"
MAX_REPOS=10
PROVIDER=""
FALLBACK=""

while [ $# -gt 0 ]; do
  case "$1" in
    audit|status) MODE="$1"; shift ;;
    fix) MODE=fix; shift ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    --max-repos) MAX_REPOS="${2:-}"; shift 2 ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --fallback) FALLBACK="${2:-}"; shift 2 ;;
    *) echo "usage: orchestrate.sh [status|audit|fix] [--config path] [--max-repos N] [--provider provider] [--fallback provider]" >&2; exit 2 ;;
  esac
done
[[ "$MAX_REPOS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid --max-repos" >&2; exit 2; }
[ -f "$CONFIG" ] || { echo "fleet config missing: $CONFIG" >&2; exit 2; }

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/buildproven/steward"
BUILDER_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-kit/builder-dispatch"
mkdir -p "$STATE_DIR"
DISCOVERY="$STATE_DIR/active-repos.json"
SUMMARY="$STATE_DIR/latest.json"
python3 "$SCRIPT_DIR/discover-active-repos.py" --config "$CONFIG" --output "$DISCOVERY"

if [ "$MODE" = status ]; then cat "$SUMMARY" 2>/dev/null || cat "$DISCOVERY"; exit 0; fi

repos=()
while IFS= read -r repo; do
  [ -n "$repo" ] && repos+=("$repo")
done < <(
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [print(r.get("localPath") or "") for r in d["repositories"]]' "$DISCOVERY" |
    sed '/^$/d' |
    head -n "$MAX_REPOS"
)
results=()
fixed=0
for repo in "${repos[@]}"; do
  audit_file="$STATE_DIR/$(basename "$repo")-audit.json"
  bash "$SCRIPT_DIR/audit-repo.sh" "$repo" > "$audit_file"
  results+=("$audit_file")
  converged=$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["converged"]).lower())' "$audit_file")
  [ "$MODE" = fix ] && [ "$converged" != true ] || continue

  reconcilable=$(python3 -c '
import json, sys
d=json.load(open(sys.argv[1]))
blocked=(d["branch"] != d["defaultBranch"] or d["dirtyFiles"] or d["ahead"] or d["behind"] or
         d["openPullRequests"] or d["lockedWorktrees"] or d["stashes"] or
         d["unmergedLocalBranches"])
print("true" if not blocked else "false")
' "$audit_file")
  [ "$reconcilable" = true ] || {
    echo "steward: preserving active or ambiguous lifecycle state in $repo; see $audit_file" >&2
    continue
  }

  # Steward may remove only residue that the lifecycle manager proves is
  # terminal. Active locks, open PRs, dirty trees, unpushed commits, recent
  # activity, and ambiguous branches remain protected by reconcile.
  node "$KIT_ROOT/scripts/worktree-manager.js" reconcile \
    --repo "$repo" \
    --apply \
    --grace-hours 24 \
    --recent-minutes 60 \
    --delete-branch \
    --repair-stale > "$STATE_DIR/$(basename "$repo")-reconcile.json"
  bash "$SCRIPT_DIR/audit-repo.sh" "$repo" > "$audit_file"
  converged=$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["converged"]).lower())' "$audit_file")
  [ "$converged" != true ] || continue

  repairable=$(python3 -c '
import json, sys
d=json.load(open(sys.argv[1]))
blocked=(d["branch"] != d["defaultBranch"] or d["dirtyFiles"] or d["ahead"] or d["behind"] or
         d["openPullRequests"] or d["extraWorktrees"] or d["lockedWorktrees"] or
         d["stashes"] or d["unmergedLocalBranches"])
print("true" if not blocked and not d["instructionSync"] else "false")
' "$audit_file")
  [ "$repairable" = true ] || {
    echo "steward: preserving active or ambiguous lifecycle state in $repo; see $audit_file" >&2
    continue
  }

  slug="steward-$(date +%Y%m%d-%H%M%S)"
  branch="codex/$slug"
  default_branch=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["defaultBranch"])' "$audit_file")
  invocation="bs:steward/$(basename "$repo")/$slug"
  create_json=$(node "$KIT_ROOT/scripts/worktree-manager.js" create \
    --repo "$repo" \
    --branch "$branch" \
    --base "origin/$default_branch" \
    --creator "bs:steward" \
    --purpose "fleet-repair" \
    --invocation "$invocation" \
    --lock-reason "$invocation")
  worktree=$(printf '%s' "$create_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["worktreePath"])')
  prompt="$STATE_DIR/$(basename "$repo")-$slug.prompt"
  phase_request="$STATE_DIR/$(basename "$repo")-$slug.phase.json"
  provider_output="$STATE_DIR/$(basename "$repo")-$slug.provider"
  builder_receipt="$provider_output/builder-receipt.json"
  cat > "$prompt" <<EOF
Repair the exact fleet-steward audit failures recorded in $audit_file for repository $worktree.
Preserve unrelated behavior. Run the repository's required checks, commit on the existing feature branch,
push, open a PR, release the terminal worktree lock with:
node "$KIT_ROOT/scripts/worktree-manager.js" unlock --repo "$worktree" --branch "$branch" --owner "$invocation" --terminal
and complete the repository's provider-neutral quality merge workflow. Never push directly
to the default branch. Return the PR URL and final verification evidence.
EOF
  if [ "$PROVIDER" = codex ]; then
    printf '%s\n' '{"schemaVersion":2,"caller":"fleet-steward","provider":"codex","phase":"implement","evidence":{"localized":false,"reversible":false,"targetedProof":false,"ambiguous":true,"changedFiles":0,"protectedSurfaces":[],"publicContract":false,"crossRepository":false,"plannedPaths":["**"]}}' > "$phase_request"
    mkdir -p "$provider_output"
    if ! node "$KIT_ROOT/scripts/builder-dispatch.js" create \
      --receipt "$builder_receipt" \
      --request "$phase_request" \
      --prompt-file "$prompt" \
      --target-dir "$worktree" \
      --state-dir "$BUILDER_STATE_DIR"; then
      echo "steward: builder dispatch denied $repo before provider launch" >&2
      continue
    fi
    args=(--prompt-file "$prompt" --builder-receipt "$builder_receipt" --builder-state-dir "$BUILDER_STATE_DIR" --caller fleet-steward --provider codex --fallback none --target-dir "$worktree" --timeout 3600 --output-dir "$provider_output")
  else
    printf '%s\n' '{"phase":"implement","localized":false,"reversible":false,"targetedProof":false,"ambiguous":true,"changedFiles":0,"protectedSurfaces":[],"sameFailureStreak":0}' > "$phase_request"
    args=(--prompt-file "$prompt" --execution-facts "$phase_request" --target-dir "$worktree" --timeout 3600 --output-dir "$provider_output")
    [ -z "$PROVIDER" ] || args+=(--provider "$PROVIDER")
    [ -z "$FALLBACK" ] || args+=(--fallback "$FALLBACK")
  fi
  if "$KIT_ROOT/scripts/provider-run.sh" "${args[@]}" | tee "$STATE_DIR/$(basename "$repo")-$slug.result"; then
    fixed=$((fixed + 1))
  fi
done

RESULT_FILES=$(IFS=:; echo "${results[*]}") DISCOVERY="$DISCOVERY" FIXED="$fixed" SUMMARY="$SUMMARY" python3 - <<'PY'
import json, os, time
files=[p for p in os.environ["RESULT_FILES"].split(":") if p]
payload={
  "generatedAtEpoch": int(time.time()),
  "discovery": os.environ["DISCOVERY"],
  "audits": [json.load(open(p)) for p in files],
  "repairRunsSucceeded": int(os.environ["FIXED"]),
}
with open(os.environ["SUMMARY"], "w") as f:
  json.dump(payload, f, indent=2, sort_keys=True)
  f.write("\n")
print(json.dumps(payload, indent=2, sort_keys=True))
PY
