#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { constants } = require("node:os");
const { repositoryGateEnvironment } = require("./quality-invocation.js");

// Keep the supervisor's identity outside the repository-controlled child.
// The existing bounded runner owns deadlines and process-group cleanup.
const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  process.stderr.write(
    "quality-repository-command: expected executable and arguments\n",
  );
  process.exit(2);
}
const result = spawnSync(executable, args, {
  env: repositoryGateEnvironment(),
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(
    `quality-repository-command: child launch failed (${result.error.code})\n`,
  );
  process.exit(1);
}
process.exit(result.status ?? 128 + (constants.signals[result.signal] || 1));
