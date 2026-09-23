#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const CONTAINER_NAME = /^harness-certification-[a-f0-9-]+$/;

function processIdentity(pid) {
  const { execFileSync } = require("child_process");
  let line;
  try {
    line = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
  const match = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
  return match ? { pid, started: match[1], command: match[2] } : null;
}

function processGroupIsLive(processGroup, expectedLeader) {
  let lines;
  try {
    const { execFileSync } = require("child_process");
    lines = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
  } catch {
    // Recovery must not reclaim a certificate when the host cannot inspect the
    // recorded process group.
    return true;
  }
  const members = lines
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && pgid === processGroup);
  if (members.length === 0) return false;
  const observedLeader = processIdentity(processGroup);
  if (!observedLeader) return true;
  return observedLeader.started === expectedLeader.started;
}

function containerIsLive(containerName) {
  if (typeof containerName !== "string" || !CONTAINER_NAME.test(containerName))
    return false;
  const { spawnSync } = require("child_process");
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", containerName],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
  );
  return result.status === 0 && result.stdout.trim() === "true";
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
    const liveGates = (receipt.gates || []).filter((gate) => {
      if (!Number.isInteger(gate.processGroup) || !gate.process) return false;
      return processGroupIsLive(gate.processGroup, gate.process);
    });
    const liveContainers = (receipt.gates || []).filter((gate) =>
      containerIsLive(gate.containerName),
    );
    const observed = Number.isInteger(receipt.owner?.pid)
      ? processIdentity(receipt.owner.pid)
      : null;
    const live = Boolean(
      observed &&
      observed.started === receipt.owner?.started &&
      observed.command === receipt.owner?.command,
    );
    return live || liveGates.length > 0
      ? { state: "RUNNING", nextAction: "wait for the recorded owner" }
      : {
          state: "RECOVERABLE",
          nextAction:
            liveContainers.length > 0
              ? "remove the recorded orphaned containers, then restart certification with the same baseline, PR, base, and head"
              : "restart certification with the same baseline, PR, base, and head",
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

module.exports = {
  containerIsLive,
  main,
  processGroupIsLive,
  readReceipt,
  stateFor,
};
