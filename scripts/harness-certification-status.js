#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function processIdentity(pid) {
  const { execFileSync } = require("child_process");
  let line;
  try {
    line = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
  const match = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
  return match ? { pid, started: match[1], command: match[2] } : null;
}

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
  if (receipt.state === "RUNNING") {
    const observed = Number.isInteger(receipt.owner?.pid)
      ? processIdentity(receipt.owner.pid)
      : null;
    const live = Boolean(
      observed &&
      observed.started === receipt.owner?.started &&
      observed.command === receipt.owner?.command,
    );
    return live
      ? { state: "RUNNING", nextAction: "wait for the recorded owner" }
      : {
          state: "RECOVERABLE",
          nextAction:
            "restart certification with the same baseline, PR, base, and head",
        };
  }
  if (receipt.state === "passed") {
    return {
      state: "WAITING_REVIEW",
      nextAction: "attach independent review and protected-check evidence",
    };
  }
  if (receipt.state === "failed") {
    return {
      state: "NEEDS_FIX",
      nextAction:
        "repair the first failed fixed gate, then restart certification",
    };
  }
  fail(`unknown receipt state '${receipt.state}'`);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--receipt") {
    fail("usage: --receipt <exact-path>");
  }
  const receiptPath = path.resolve(argv[1]);
  const receipt = readReceipt(receiptPath);
  const { state, nextAction } = stateFor(receipt);
  process.stdout.write(
    `${JSON.stringify({ state, nextAction, receipt: receiptPath, candidate: receipt.candidate, gates: receipt.gates }, null, 2)}\n`,
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

module.exports = { main, stateFor };
