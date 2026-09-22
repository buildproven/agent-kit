#!/usr/bin/env node
"use strict";

// Restarts a dead frozen-baseline certification without importing candidate code.
// The recorded baseline, candidate, and GitHub identity are the only inputs.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { readReceipt, stateFor } = require("./harness-certification-status.js");

function fail(message) {
  throw new Error(`harness-certification-recover: ${message}`);
}

function parse(argv) {
  if (argv.length !== 4 || argv[0] !== "--receipt" || argv[2] !== "--out") {
    fail("usage: --receipt <prior-receipt> --out <new-receipt>");
  }
  return { receipt: path.resolve(argv[1]), out: path.resolve(argv[3]) };
}

function git(directory, args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: directory,
    encoding: "utf8",
  }).trim();
}

function validIdentity(baseline, candidate) {
  return Boolean(
    typeof baseline?.directory === "string" &&
    typeof baseline.sha === "string" &&
    typeof candidate?.directory === "string" &&
    typeof candidate.sha === "string" &&
    typeof candidate.baseSha === "string" &&
    typeof candidate.profile === "string" &&
    typeof candidate.claim === "string" &&
    typeof candidate.githubRepository === "string" &&
    Number.isInteger(candidate.pullRequest),
  );
}

function recoveryInvocation(receiptPath, out) {
  const receipt = readReceipt(receiptPath);
  if (stateFor(receipt).state !== "RECOVERABLE") {
    fail("prior certification is not safely recoverable");
  }
  const baseline = receipt.baseline;
  const candidate = receipt.candidate;
  if (!validIdentity(baseline, candidate)) {
    fail("prior receipt lacks a complete certification identity");
  }
  const baselineDirectory = fs.realpathSync(baseline.directory);
  if (git(baselineDirectory, ["rev-parse", "HEAD"]) !== baseline.sha) {
    fail("recorded baseline is no longer at its certified SHA");
  }
  const runner = path.join(baselineDirectory, "scripts", "harness-certify.js");
  if (!fs.existsSync(runner))
    fail("recorded baseline has no certification runner");
  if (fs.existsSync(out)) fail("--out already exists; preserve prior evidence");
  return {
    runner,
    args: [
      runner,
      "--baseline-sha",
      baseline.sha,
      "--candidate-dir",
      candidate.directory,
      "--candidate-head",
      candidate.sha,
      "--base-sha",
      candidate.baseSha,
      "--profile",
      candidate.profile,
      "--claim",
      candidate.claim,
      "--github-repo",
      candidate.githubRepository,
      "--pr",
      String(candidate.pullRequest),
      "--out",
      out,
    ],
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const invocation = recoveryInvocation(options.receipt, options.out);
  const result = execFileSync(process.execPath, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { parse, recoveryInvocation };
