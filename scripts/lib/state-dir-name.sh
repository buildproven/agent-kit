# Resolves the on-disk directory segment used for this project's persistent
# state/config. The repo was renamed from claude-kit to agent-kit; existing
# installs may still have state under the old name. Prefers "agent-kit";
# falls back to "claude-kit" only if that's the sole one present on disk, so
# upgrading does not orphan existing state.
state_dir_name() {
  local parent_dir="$1"
  if [ -d "$parent_dir/agent-kit" ] || [ ! -d "$parent_dir/claude-kit" ]; then
    echo "agent-kit"
  else
    echo "claude-kit"
  fi
}
