#!/usr/bin/env node
"use strict";

// Restarts a dead frozen-baseline certification without importing candidate code.
// The recorded baseline, candidate, and GitHub identity are the only inputs.

const { execFileSync, spawnSync } = require("child_process");
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
  return { receipt: path.resolve(argv[1]), out: path.resolve(argv[3]) };
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

function isWithin(directory, target) {
  const relative = path.relative(directory, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
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

function validIdentity(baseline, candidate, executor) {
  return Boolean(
    typeof baseline?.directory === "string" &&
    typeof baseline.sha === "string" &&
    typeof candidate?.directory === "string" &&
    typeof candidate.sha === "string" &&
    typeof candidate.baseSha === "string" &&
    typeof candidate.profile === "string" &&
    typeof candidate.claim === "string" &&
    typeof candidate.githubRepository === "string" &&
    Number.isInteger(candidate.pullRequest) &&
    executor?.kind === "docker-container" &&
    typeof executor.image === "string" &&
    /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(executor.image),
  );
}

function removeOrphanedContainers(receipt) {
  const names = [
    ...new Set((receipt.gates || []).map((gate) => gate.containerName)),
  ];
  for (const name of names) {
    if (name === undefined) continue;
    if (
      typeof name !== "string" ||
      !/^harness-certification-[a-f0-9-]+$/.test(name)
    )
      fail("prior receipt has an unsafe container identity");
    const inspected = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "buildproven.harness-certification" }}',
        name,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
    if (inspected.status !== 0) {
      if (inspected.stderr.includes("No such object")) continue;
      fail(`could not inspect recorded orphaned container '${name}'`);
    }
    if (inspected.stdout.trim() !== name) {
      fail(`recorded orphaned container '${name}' lacks its identity label`);
    }
    const removed = spawnSync("docker", ["rm", "-f", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (removed.status !== 0)
      fail(`could not remove recorded orphaned container '${name}'`);
  }
}

function recoveryInvocation(receiptPath, out) {
  const receiptOut = newReceiptPath(out);
  const receipt = readReceipt(receiptPath);
  if (stateFor(receipt).state !== "RECOVERABLE") {
    fail("prior certification is not safely recoverable");
  }
  const baseline = receipt.baseline;
  const candidate = receipt.candidate;
  if (!validIdentity(baseline, candidate, receipt.executor)) {
    fail("prior receipt lacks a complete certification identity");
  }
  // The owner is dead.  Before a new attempt, inspect and remove only the
  // unpredictable identities persisted by the prior attempt.
  removeOrphanedContainers(receipt);
  const { runner } = verifiedBaseline(baseline, candidate.githubRepository);
  const candidateDirectory = fs.realpathSync(candidate.directory);
  if (
    isWithin(TRUSTED_BASELINE, receiptOut) ||
    isWithin(candidateDirectory, receiptOut)
  ) {
    fail("--out must be outside the baseline and candidate checkouts");
  }
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
      "--container-image",
      receipt.executor.image,
      "--out",
      receiptOut,
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

module.exports = { parse, recoveryInvocation, removeOrphanedContainers };
