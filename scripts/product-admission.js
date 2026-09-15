#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  canonicalJson,
  sha256,
  verifyAdmissionEnvelope,
} = require("./product-evidence");

const MARKER = "buildproven-product-admission:v1:";

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function privateKey(encoded) {
  if (!encoded) throw new Error("product admission signing key is missing");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded.trim())
    throw new Error("product admission signing key is not canonical base64");
  const key = crypto.createPrivateKey({
    key: bytes,
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("product admission signing key is not Ed25519");
  return key;
}

function createAdmission(bundle, output, runtime, encodedKey) {
  if (
    runtime.githubActions !== "true" ||
    runtime.eventName !== "workflow_run" ||
    runtime.runAttempt !== "1" ||
    runtime.workflowPath !== ".github/workflows/product-evidence-admission.yml"
  )
    throw new Error(
      "admission requires a first-attempt protected Actions worker",
    );
  const producer = readJson(
    path.join(bundle, "producer.json"),
    "producer record",
  );
  const evidence = path.join(bundle, "evidence.json");
  if (sha256(fs.readFileSync(evidence)) !== producer.evidenceIndexSha256) {
    throw new Error("producer evidence digest changed before admission");
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "product-completion.js"),
      "verify-claim",
      "--claim",
      "local-product",
      "--prd",
      path.join(bundle, "prd.md"),
      "--tasks",
      path.join(bundle, "tasks.md"),
      "--changed-files",
      path.join(bundle, "changed-files.json"),
      "--evidence",
      evidence,
      "--head",
      producer.head,
      "--repository",
      runtime.repository,
      "--repository-id",
      runtime.repositoryId,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0)
    throw new Error(
      `protected verifier rejected evidence: ${(result.stderr || result.stdout).trim()}`,
    );
  const verified = parseJson(result.stdout, "protected verifier output");
  if (verified.valid !== true)
    throw new Error("protected verifier did not return valid=true");
  const key = privateKey(encodedKey);
  const payload = {
    schemaVersion: 1,
    issuer: "github-actions-product-evidence",
    repository: runtime.repository,
    repositoryId: runtime.repositoryId,
    head: producer.head,
    requirementsDigest: verified.requirementsDigest,
    evidenceIndexSha256: producer.evidenceIndexSha256,
    producerRunId: String(producer.producerRunId),
    sourceRunId: String(producer.sourceRunId),
    keyFingerprint: sha256(
      crypto.createPublicKey(key).export({ format: "der", type: "spki" }),
    ),
    admittedAt: new Date().toISOString(),
  };
  const envelope = {
    payload,
    signature: crypto
      .sign(null, Buffer.from(canonicalJson(payload)), key)
      .toString("base64url"),
  };
  fs.writeFileSync(output, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return envelope;
}

function ghJson(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0)
    throw new Error(
      `GitHub admission lookup failed: ${(result.stderr || "").trim()}`,
    );
  return parseJson(result.stdout, "GitHub admission response");
}

function verifyRemote({
  repository,
  repositoryId,
  head,
  requirementsDigest,
  evidenceIndexSha256,
}) {
  const response = ghJson([
    "api",
    `repos/${repository}/commits/${head}/check-runs`,
    "-H",
    "Accept: application/vnd.github+json",
  ]);
  const candidates = (response.check_runs || []).filter(
    (check) =>
      check.name === "product-admission" &&
      check.conclusion === "success" &&
      check.status === "completed",
  );
  for (const check of candidates) {
    const summary = check.output?.summary || "";
    if (!summary.startsWith(MARKER)) continue;
    try {
      const envelope = JSON.parse(
        Buffer.from(summary.slice(MARKER.length), "base64url").toString("utf8"),
      );
      const payload = verifyAdmissionEnvelope(envelope, {
        repository,
        repositoryId,
        head,
        requirementsDigest,
        evidenceIndexSha256,
      });
      return { valid: true, checkId: String(check.id), admission: payload };
    } catch {
      /* inspect all exact-head checks before failing closed */
    }
  }
  throw new Error(
    "no valid protected product-admission check exists for the exact head and evidence digest",
  );
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "create") {
    if (args.length !== 2)
      throw new Error(
        "usage: product-admission.js create <bundle-dir> <output>",
      );
    const envelope = createAdmission(
      args[0],
      args[1],
      {
        githubActions: process.env.GITHUB_ACTIONS,
        eventName: process.env.GITHUB_EVENT_NAME,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        workflowPath: process.env.PRODUCT_ADMISSION_WORKFLOW_PATH,
        repository: process.env.GITHUB_REPOSITORY,
        repositoryId: process.env.GITHUB_REPOSITORY_ID,
      },
      process.env.PRODUCT_ADMISSION_PRIVATE_KEY,
    );
    process.stdout.write(
      `${MARKER}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}\n`,
    );
    return;
  }
  if (command === "verify-remote") {
    if (args.length !== 5)
      throw new Error(
        "usage: product-admission.js verify-remote <repository> <repository-id> <head> <requirements-sha256> <evidence-sha256>",
      );
    process.stdout.write(
      `${JSON.stringify(verifyRemote({ repository: args[0], repositoryId: args[1], head: args[2], requirementsDigest: args[3], evidenceIndexSha256: args[4] }))}\n`,
    );
    return;
  }
  throw new Error("usage: product-admission.js create|verify-remote ...");
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`product admission failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MARKER, createAdmission, verifyRemote };
