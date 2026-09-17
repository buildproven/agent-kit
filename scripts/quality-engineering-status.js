#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const invocation = require("./quality-invocation");

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function localEvidence(manifest) {
  try {
    const proof = invocation.reviewAuthorization(manifest);
    const incomplete =
      ["incomplete", "override"].includes(proof.reviewStatus) ||
      proof.operatorOverride === true;
    return { status: incomplete ? "incomplete" : "verified", proof };
  } catch (error) {
    return { status: "unverified", reason: error.message };
  }
}

function ciEvidence(manifest, enabled) {
  if (!enabled)
    return { status: "unknown", reason: "live CI was not requested" };
  if (!manifest.repo.githubRepository) {
    return {
      status: "unknown",
      reason: "manifest has no GitHub repository identity",
    };
  }
  const base = manifest.revisions.baseRef.replace(
    /^refs\/remotes\/origin\/|^origin\/|^refs\/heads\//,
    "",
  );
  try {
    const raw = execFileSync(
      process.execPath,
      [
        path.join(__dirname, "quality-required-checks.js"),
        "assert",
        "--repo",
        manifest.repo.githubRepository,
        "--base",
        base,
        "--head",
        manifest.revisions.currentHead,
      ],
      {
        cwd: manifest.repo.realpath,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const checks = invocation.parseJson(raw, "required-check status");
    return { status: "verified", checks };
  } catch (error) {
    return {
      status: "unverified",
      reason: String(error.stderr || error.message).trim(),
    };
  }
}

function recordedAdmission(manifest) {
  return {
    status: "unknown",
    reason: "product admission is not validated by this status interface",
    deliveryEvidenceBinding: manifest.deliveryEvidenceBinding || null,
    recordedBlock: manifest.merge?.admissionBlock || null,
  };
}

function engineeringStatus(manifestFile, { ci = false } = {}) {
  const before = fs.readFileSync(manifestFile, "utf8");
  const { manifest, manifestPath } = invocation.loadManifest(manifestFile);
  if (fs.readFileSync(manifestPath, "utf8") !== before) {
    throw new Error(
      "campaign changed while loading status; retry the exact manifest",
    );
  }
  const root = manifest.repo.realpath;
  execFileSync(
    process.execPath,
    [path.join(__dirname, "quality-invocation.js"), "validate", manifestPath],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const identity = invocation.validateIdentity(manifest, root);
  if (identity.currentHead !== manifest.revisions.currentHead) {
    throw new Error(
      "engineering status requires the exact manifest HEAD; stamp descendants need their own evidence",
    );
  }
  const treeStatus = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const clean = treeStatus === "";
  const local = localEvidence(manifest);
  const checks = ciEvidence(manifest, ci);
  const current = invocation.validateIdentity(manifest, root);
  if (
    current.currentHead !== identity.currentHead ||
    fs.readFileSync(manifestPath, "utf8") !== before ||
    git(root, ["status", "--porcelain", "--untracked-files=all"]) !== treeStatus
  ) {
    throw new Error(
      "campaign or HEAD changed during status inspection; retry the exact manifest",
    );
  }
  const ciVerified = checks.status === "verified";
  const stale = invocation.lifecycleStale(manifest);
  return {
    interface: "engineering-status",
    schemaVersion: 1,
    readOnly: true,
    manifestPath,
    invocationId: manifest.invocationId,
    repository: {
      root,
      key: manifest.repo.key,
      github: manifest.repo.githubRepository || null,
    },
    revisions: {
      baseRef: manifest.revisions.baseRef,
      creationBase: manifest.revisions.baseSha,
      base: git(root, [
        "merge-base",
        identity.currentHead,
        manifest.revisions.baseRef,
      ]),
      head: identity.currentHead,
    },
    workingTreeClean: clean,
    lifecycleStale: stale,
    engineering: {
      status:
        clean && !stale && local.status === "verified" && ciVerified
          ? "ready"
          : "not-ready",
      gateAndReviewEvidence: local,
      ci: checks,
    },
    recordedGates: manifest.requiredGates.map((required) => {
      const evidence = manifest.gates.find(
        (gate) =>
          gate.name === required.name && gate.head === identity.currentHead,
      );
      return {
        name: required.name,
        recordedStatus: evidence?.status || "missing",
      };
    }),
    admission: recordedAdmission(manifest),
    recordedTerminal: manifest.terminalState || null,
    mergeAuthorized: false,
    limits: [
      "status is not campaign execution or a durable readiness receipt",
      "recorded gates and terminal states are not independent proof",
      "admission and existing merge checks remain required",
    ],
  };
}

function main(argv) {
  if (
    argv[0] !== "--manifest" ||
    !argv[1] ||
    (argv.length !== 2 && !(argv.length === 3 && argv[2] === "--ci"))
  ) {
    throw new Error(
      "usage: quality-engineering-status.js --manifest <exact-path> [--ci]",
    );
  }
  process.stdout.write(
    `${JSON.stringify(engineeringStatus(argv[1], { ci: argv[2] === "--ci" }), null, 2)}\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`quality engineering status: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { engineeringStatus };
