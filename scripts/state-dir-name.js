"use strict";

/**
 * Resolves the on-disk directory segment used for this project's persistent
 * state/config (under XDG state/config homes, /etc, etc). The repo was
 * renamed from claude-kit to agent-kit; existing installs may still have
 * state under the old name. New writes use "agent-kit"; reads prefer
 * "agent-kit" but fall back to "claude-kit" if only the legacy directory
 * exists, so upgrading does not orphan existing state.
 */

const fs = require("node:fs");
const path = require("node:path");

const CURRENT_NAME = "agent-kit";
const LEGACY_NAME = "claude-kit";

function resolveStateDirName(parentDir, fsImpl = fs) {
  const currentPath = path.join(parentDir, CURRENT_NAME);
  if (fsImpl.existsSync(currentPath)) return CURRENT_NAME;
  const legacyPath = path.join(parentDir, LEGACY_NAME);
  if (fsImpl.existsSync(legacyPath)) return LEGACY_NAME;
  return CURRENT_NAME;
}

module.exports = { resolveStateDirName, CURRENT_NAME, LEGACY_NAME };
