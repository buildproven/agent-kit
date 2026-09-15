#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const impact = require("./test-impact");

function readJson(source, label) {
  try {
    return JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`cannot read valid ${label} JSON`, { cause: error });
  }
}

function repositoryRoot(cwd) {
  if (typeof cwd !== "string" || !cwd || !fs.statSync(cwd).isDirectory()) {
    throw new Error("hook requires an existing cwd directory");
  }
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (/not a git repository|must be run in a work tree/.test(result.stderr)) {
      return null;
    }
    throw new Error("cannot resolve task repository");
  }
  return result.stdout.trim();
}

function main() {
  const payload = readJson(0, "hook input");
  const root = repositoryRoot(payload?.cwd);
  if (!root) return 0;
  const files = impact.workingTreePaths(root);
  if (files.length === 0) return 0;
  const selected = impact.plan(files, impact.loadPolicy(root), { root });
  return impact.execute(selected, root);
}

try {
  process.exitCode = main() === 0 ? 0 : 2;
} catch (error) {
  process.stderr.write(`task-completed-check: ${error.message}\n`);
  process.exitCode = 2;
}
