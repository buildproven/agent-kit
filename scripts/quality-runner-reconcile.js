#!/usr/bin/env node
"use strict";

const ownership = require("./quality-runner-ownership");

function parseArgs(argv) {
  const values = {};
  let confirmLegacyChildQuiescent = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-legacy-child-quiescent") {
      confirmLegacyChildQuiescent = true;
      continue;
    }
    if (!argument.startsWith("--") || !argv[index + 1])
      throw new Error("runner reconciliation arguments are incomplete");
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  const expectedPid = Number(values["owner-pid"]);
  if (
    !values.manifest ||
    !values.head ||
    !values["owner-host"] ||
    !values["owner-nonce"] ||
    !Number.isInteger(expectedPid) ||
    expectedPid < 1
  )
    throw new Error(
      "usage: quality-runner-reconcile.js --manifest PATH --head SHA --owner-host HOST --owner-pid PID --owner-nonce NONCE [--confirm-legacy-child-quiescent]",
    );
  return {
    manifestPath: values.manifest,
    expectedHead: values.head,
    expectedHost: values["owner-host"],
    expectedPid,
    expectedNonce: values["owner-nonce"],
    confirmLegacyChildQuiescent,
  };
}

function main() {
  try {
    const result = ownership.reconcileRunner(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...result })}\n`,
    );
  } catch (error) {
    process.stderr.write(`quality-runner-reconcile: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };

if (require.main === module) main();
