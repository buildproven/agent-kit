#!/usr/bin/env node
"use strict";

// Restarts a dead frozen-baseline certification without importing candidate code.
// The recorded baseline, candidate, and GitHub identity are the only inputs.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { readReceipt, stateFor } = require("./harness-certification-status.js");

const TRUSTED_BASELINE = fs.realpathSync(path.join(__dirname, ".."));

function fail(message) {
  throw new Error(`harness-certification-recover: ${message}`);
}

function parse(argv) {
  if (argv.length !== 4 || argv[0] !== "--receipt" || argv[2] !== "--out") {
    fail("usage: --receipt <prior-receipt> --out <new-receipt>");
  }
  return { receipt: path.resolve(argv[1]), out: newReceiptPath(argv[3]) };
}

function newReceiptPath(suppliedPath) {
  const supplied = path.resolve(suppliedPath);
  const out = path.join(
    fs.realpathSync(path.dirname(supplied)),
    path.basename(supplied),
  );
  try {
    fs.lstatSync(out);
    fail("--out already exists; preserve prior evidence");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return out;
}

function git(directory, args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function githubRepository(remote) {
  const match = remote.match(
    /(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  return match ? match[1] : null;
}

function verifiedBaseline(baseline, expectedRepository) {
  const directory = fs.realpathSync(baseline.directory);
  if (directory !== TRUSTED_BASELINE) {
    fail("recorded baseline directory does not match the executing checkout");
  }
  if (git(directory, ["rev-parse", "HEAD"]) !== baseline.sha) {
    fail("recorded baseline is no longer at its certified SHA");
  }
  if (
    githubRepository(git(directory, ["remote", "get-url", "origin"])) !==
    expectedRepository
  ) {
    fail("recorded baseline repository does not match candidate repository");
  }
  const runner = path.join(directory, "scripts", "harness-certify.js");
  if (!fs.existsSync(runner)) {
    fail("recorded baseline has no certification runner");
  }
  return { directory, runner };
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
  const { runner } = verifiedBaseline(baseline, candidate.githubRepository);
  const candidateDirectory = fs.realpathSync(candidate.directory);
  return {
    runner,
    args: [
      runner,
      "--baseline-sha",
      baseline.sha,
      "--candidate-dir",
      candidateDirectory,
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
