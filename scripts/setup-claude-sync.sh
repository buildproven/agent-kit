#!/bin/bash
# =============================================================================
# setup-claude-sync.sh — symlink this repo into ~/.claude, and verify/repair it
# =============================================================================
# The kit is consumed via symlinks: ~/.claude/<dir> -> <repo>/<dir>. Hooks in
# config/settings.json resolve through $HOME/.claude/scripts/..., so `scripts`
# is load-bearing — if it is not linked, every hook silently no-ops.
#
# Modes:
#   --check    verify every expected link; exit 1 if any are missing/broken
#   --repair   create or replace broken links, then re-verify
#   (no args)  same as --repair
#
# Never clobbers a real directory or a user's own file: if ~/.claude/<x> exists
# and is NOT a symlink, we warn and skip rather than delete their work.
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
err()     { echo -e "${RED}✗${NC} $1"; }

# Display-only label for the config dir. Built, not written as a literal `~/...`,
# so it is unambiguously a message string and never mistaken for a path to expand.
D="$(printf '~')/.claude"

# Repo root = parent of this script's directory.
#
# This MUST physically resolve symlinks, and the previous version did not.
# install.sh links <config>/scripts -> <repo>/scripts, so /bs:sync finds this
# script *through that link*. A naive `cd "$(dirname "$BASH_SOURCE")" && pwd`
# returns the LOGICAL path, collapsing REPO_ROOT to the config dir itself —
# whereupon --repair unlinked the working symlink and recreated it pointing at
# itself (<config>/scripts -> <config>/scripts). ELOOP: every hook dead, and
# the next --check reported "OK" because readlink == src. Walk the chain instead.
src_path="${BASH_SOURCE[0]}"
while [[ -L "$src_path" ]]; do
  link_target="$(readlink "$src_path")"
  if [[ "$link_target" == /* ]]; then
    src_path="$link_target"
  else
    src_path="$(cd "$(dirname "$src_path")" && pwd -P)/$link_target"
  fi
done
SCRIPT_DIR="$(cd "$(dirname "$src_path")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# If we did not land in a real checkout, refuse — better than symlinking things
# relative to a misresolved root.
if [[ ! -f "$REPO_ROOT/config/settings.json" ]]; then
  err "cannot locate the agent-kit checkout (resolved REPO_ROOT=$REPO_ROOT)"
  exit 1
fi

# Shared with install.sh so first-run installation and later repair cannot
# silently diverge. This is loaded only after REPO_ROOT has been resolved.
# shellcheck source=claude-link-manifest.sh
source "$REPO_ROOT/scripts/claude-link-manifest.sh"

MODE="repair"
case "${1:-}" in
  --check)  MODE="check" ;;
  --repair) MODE="repair" ;;
  # NOT silently aliased to --repair: the old --all advertised backup + commit +
  # push. Quietly doing something narrower is the silent-downgrade class of bug
  # this script exists to prevent.
  --all)    echo "--all was removed: it never did the backup/commit/push it advertised. Use --repair." >&2; exit 2 ;;
  "")       MODE="repair" ;;
  *) echo "usage: $(basename "$0") [--check|--repair]" >&2; exit 2 ;;
esac

FAILURES=0

# want_link <src> <dest>
# In check mode: report only. In repair mode: create/replace the symlink.
want_link() {
  local src="$1" dest="$2" label="$3"

  # Belt and braces against the ELOOP failure described above: never link a path
  # to itself, even if REPO_ROOT resolution regresses again.
  if [[ "$src" == "$dest" ]]; then
    err "$label: refusing to link $dest to itself (REPO_ROOT misresolved to $REPO_ROOT)"
    FAILURES=$((FAILURES + 1))
    return 0
  fi

  # All four LINK_DIRS are mandatory. A missing source means a broken or partial
  # checkout — count it, so --check cannot exit 0 on an install that cannot work.
  if [[ ! -e "$src" ]]; then
    err "$label: source missing from the checkout ($src)"
    FAILURES=$((FAILURES + 1))
    return 0
  fi

  # Already correct?
  if [[ -L "$dest" ]] && [[ "$(readlink "$dest")" == "$src" ]]; then
    success "$label → $src"
    return 0
  fi

  # Occupied by something that is not our symlink.
  if [[ -e "$dest" && ! -L "$dest" ]]; then
    warn "$label: $dest exists and is not a symlink — leaving it alone (merge manually)"
    FAILURES=$((FAILURES + 1))
    return 0
  fi

  if [[ "$MODE" == "check" ]]; then
    err "$label: not linked (expected $dest → $src)"
    FAILURES=$((FAILURES + 1))
    return 0
  fi

  # Repair: replace a stale/broken symlink, or create a new one.
  [[ -L "$dest" ]] && rm "$dest"
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
  success "linked $label → $src"
}

echo ""
echo "agent-kit sync (${MODE})"
echo "  repo:   $REPO_ROOT"
echo "  target: $CLAUDE_DIR"
echo "------------------------------------------------------------"

[[ "$MODE" == "repair" ]] && mkdir -p "$CLAUDE_DIR"

for dir in "${CLAUDE_LINK_DIRS[@]}"; do
  want_link "$REPO_ROOT/$dir" "$CLAUDE_DIR/$dir" "$D/$dir"
done

# settings.json and CLAUDE.md are single files, and users are far more likely to
# have their own. Only link them if the slot is genuinely free.
for f in "${CLAUDE_LINK_FILES[@]}"; do
  dest_name="${f%%:*}"; src_rel="${f##*:}"
  src="$REPO_ROOT/$src_rel"; dest="$CLAUDE_DIR/$dest_name"

  [[ -f "$src" ]] || continue

  if [[ -L "$dest" ]] && [[ "$(readlink "$dest")" == "$src" ]]; then
    success "$D/$dest_name → $src"
  elif [[ -e "$dest" ]]; then
    warn "$D/$dest_name exists (not ours) — skipping (merge manually if needed)"
  elif [[ "$MODE" == "check" ]]; then
    err "$D/$dest_name: not linked"
    FAILURES=$((FAILURES + 1))
  else
    ln -s "$src" "$dest"
    success "linked $D/$dest_name → $src"
  fi
done

# Hooks are the reason `scripts` must be linked. Verify they actually resolve.
#
# The `|| true` is deliberate, and on its own would be a bug. grep exits 1 on
# no-match, which under `set -euo pipefail` killed the script mid-line — before
# the summary, with no diagnosis. But silently swallowing that is worse: an empty
# hook list would sail through the loop and report "all hooks resolve" having
# verified nothing. So: tolerate the status, then treat "no hooks found" as its
# own hard failure.
if [[ -d "$CLAUDE_DIR/scripts" ]]; then
  if [[ ! -f "$REPO_ROOT/config/settings.json" ]]; then
    err "config/settings.json missing from the checkout — cannot verify hooks"
    FAILURES=$((FAILURES + 1))
  else
    # SC2016: single quotes deliberate — match the *literal* text as written in
    # settings.json, not its expansion.
    # shellcheck disable=SC2016
    hook_names="$(grep -o '\$HOME/\.claude/scripts/[a-zA-Z0-9._-]*\.sh' \
                    "$REPO_ROOT/config/settings.json" | sed 's|.*/||' | sort -u || true)"

    if [[ -z "$hook_names" ]]; then
      err "no hook scripts found in config/settings.json — the hook path format changed, so this check is now verifying nothing"
      FAILURES=$((FAILURES + 1))
    else
      missing_hooks=0
      hook_count=0
      while IFS= read -r hook; do
        [[ -n "$hook" ]] || continue
        hook_count=$((hook_count + 1))
        [[ -f "$CLAUDE_DIR/scripts/$hook" ]] || {
          err "hook script unresolvable: $D/scripts/$hook"
          missing_hooks=$((missing_hooks + 1))
        }
      done <<< "$hook_names"

      if [[ $missing_hooks -eq 0 ]]; then
        # Report the count, so a silent drop to zero hooks is visible, not green.
        success "all $hook_count hook scripts resolve under $D/scripts/"
      else
        FAILURES=$((FAILURES + missing_hooks))
      fi
    fi
  fi
else
  err "$D/scripts is not linked — every hook in settings.json will silently no-op"
  FAILURES=$((FAILURES + 1))
fi

# Keep Codex's managed native skill profile converged on upgrades as well as
# fresh installs. The reconciler preserves unmanaged entries by design.
CODEX_SKILL_SYNC="$REPO_ROOT/scripts/setup-codex-skills.sh"
DEFAULT_CLAUDE_DIR="$HOME/.claude"
if [[ "$CLAUDE_DIR" != "$DEFAULT_CLAUDE_DIR" && -z "${CODEX_AGENT_SKILLS_DIR:-}" ]]; then
  warn "alternate Claude target: skipping Codex reconciliation without CODEX_AGENT_SKILLS_DIR"
elif [[ "$MODE" == "check" ]]; then
  if bash "$CODEX_SKILL_SYNC" --check; then
    success "Codex native skill profile is current"
  else
    err "Codex native skill profile has drift"
    FAILURES=$((FAILURES + 1))
  fi
elif bash "$CODEX_SKILL_SYNC"; then
  success "Codex native skill profile reconciled"
else
  err "Codex native skill profile reconciliation failed"
  FAILURES=$((FAILURES + 1))
fi

echo "------------------------------------------------------------"
if [[ $FAILURES -eq 0 ]]; then
  success "agent-kit sync OK"
  exit 0
fi

if [[ "$MODE" == "check" ]]; then
  err "$FAILURES issue(s) found — run: $0 --repair"
else
  err "$FAILURES issue(s) need manual attention (see warnings above)"
fi
exit 1
