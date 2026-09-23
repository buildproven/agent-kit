#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function fail(message) {
  throw new Error(`harness-certification-status: ${message}`);
}

function readReceipt(receiptPath) {
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.kind !== "frozen-harness-certification"
    ) {
      fail("receipt does not have the frozen-harness-certification schema");
    }
    return receipt;
  } catch (error) {
    if (error.message.startsWith("harness-certification-status:")) throw error;
    fail(`cannot read receipt: ${receiptPath}`);
  }
}

function stateFor(receipt) {
  if (!["RUNNING", "passed", "failed"].includes(receipt.state)) {
    fail(`unknown receipt state '${receipt.state}'`);
  }
  return {
    state: "RETIRED",
    recordedState: receipt.state,
    authority: "historical-only",
    nextAction:
      "Preserve this historical receipt. Do not restart certification or infer process liveness from it. " +
      "Use direct repository checks, independent review, and protected CI for current delivery.",
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--receipt") {
    fail("usage: --receipt <exact-path>");
  }
  const receiptPath = path.resolve(argv[1]);
  const receipt = readReceipt(receiptPath);
  process.stdout.write(
    `${JSON.stringify({ ...stateFor(receipt), receipt: receiptPath, candidate: receipt.candidate, gates: receipt.gates }, null, 2)}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { main, readReceipt, stateFor };
