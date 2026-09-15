#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  canonicalJson,
  sha256,
  trustedPublicKeyFingerprint,
} = require("./product-evidence");

const SOURCE_WORKFLOW = "Product Evidence Source";
const SOURCE_PATH = ".github/workflows/product-evidence-source.yml";
const PRODUCER_PATH = ".github/workflows/product-evidence-producer.yml";
const ISSUER = "github-actions-product-evidence";
const BUNDLE_FILES = [
  "request.json",
  "prd.md",
  "tasks.md",
  "changed-files.json",
  "behavioral-tests.log",
  "acceptance-evidence.log",
];

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function jsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function realFile(root, name) {
  const realRoot = fs.realpathSync(root);
  const candidate = path.join(realRoot, name);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${name} must be a real file`);
  return candidate;
}

function signingKey(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("product evidence signing key is missing");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded.trim()) {
    throw new Error("product evidence signing key is not canonical base64");
  }
  const key = crypto.createPrivateKey({
    key: bytes,
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("product evidence signing key is not Ed25519");
  }
  return key;
}

function validateRequest(request) {
  if (
    !exactKeys(request, [
      "schemaVersion",
      "repository",
      "repositoryId",
      "pullRequest",
      "base",
      "head",
      "nonce",
      "behavioralCommand",
      "acceptanceCommand",
    ]) ||
    request.schemaVersion !== 1 ||
    !/^[^/]+\/[^/]+$/.test(request.repository || "") ||
    !/^[1-9][0-9]*$/.test(request.repositoryId || "") ||
    !Number.isSafeInteger(request.pullRequest) ||
    request.pullRequest < 1 ||
    !/^[0-9a-f]{40}$/.test(request.base || "") ||
    !/^[0-9a-f]{40}$/.test(request.head || "") ||
    !/^[0-9a-f]{32}$/.test(request.nonce || "") ||
    request.behavioralCommand !== "npm test" ||
    request.acceptanceCommand !== "npm run test:patterns"
  )
    throw new Error(
      "source request is malformed or uses a non-allowlisted command",
    );
  return request;
}

function validatePlatform(event, run, jobs, pullRequest, runtime) {
  const repositoryId = String(event.repository?.id || "");
  if (
    runtime.githubActions !== "true" ||
    runtime.eventName !== "workflow_run" ||
    runtime.runAttempt !== "1" ||
    runtime.workflowRef !== PRODUCER_PATH ||
    event.action !== "completed" ||
    event.workflow_run?.id !== run.id ||
    event.workflow_run?.name !== SOURCE_WORKFLOW ||
    event.workflow_run?.path !== SOURCE_PATH ||
    event.repository?.full_name !== runtime.repository ||
    repositoryId !== runtime.repositoryId
  )
    throw new Error("producer has the wrong protected workflow identity");
  if (
    run.name !== SOURCE_WORKFLOW ||
    run.path !== SOURCE_PATH ||
    run.event !== "repository_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1 ||
    run.head_branch !== event.repository.default_branch
  )
    throw new Error("source run is stale, unsuccessful, or unprotected");
  if (
    !Array.isArray(jobs.jobs) ||
    jobs.jobs.length !== 1 ||
    jobs.jobs[0].name !== "collect-product-evidence" ||
    jobs.jobs[0].conclusion !== "success" ||
    jobs.jobs[0].run_id !== run.id
  )
    throw new Error("source run lacks the allowlisted successful evidence job");
  if (
    pullRequest.state !== "open" ||
    pullRequest.head?.repo?.id !== event.repository.id ||
    pullRequest.base?.repo?.id !== event.repository.id ||
    pullRequest.base?.ref !== event.repository.default_branch
  )
    throw new Error(
      "product evidence is denied for a fork or stale pull request",
    );
}

function envelope(payload, key) {
  return {
    payload,
    signature: crypto
      .sign(null, Buffer.from(canonicalJson(payload)), key)
      .toString("base64url"),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function produce(input) {
  validatePlatform(
    input.event,
    input.sourceRun,
    input.sourceJobs,
    input.pullRequest,
    input.runtime,
  );
  for (const name of BUNDLE_FILES) realFile(input.sourceDirectory, name);
  const request = validateRequest(
    jsonFile(realFile(input.sourceDirectory, "request.json"), "source request"),
  );
  if (
    request.repository !== input.event.repository.full_name ||
    request.repositoryId !== String(input.event.repository.id) ||
    request.pullRequest !== input.pullRequest.number ||
    request.head !== input.pullRequest.head.sha
  )
    throw new Error(
      "source request does not match protected platform identity",
    );
  const key = signingKey(input.encodedPrivateKey);
  fs.mkdirSync(input.outputDirectory, { recursive: false, mode: 0o700 });
  for (const name of BUNDLE_FILES.slice(1)) {
    fs.copyFileSync(
      realFile(input.sourceDirectory, name),
      path.join(input.outputDirectory, name),
    );
  }
  const requirementsDigest = sha256(
    Buffer.from(
      JSON.stringify({
        prdSha256: sha256(
          fs.readFileSync(realFile(input.sourceDirectory, "prd.md")),
        ),
        tasksSha256: sha256(
          fs.readFileSync(realFile(input.sourceDirectory, "tasks.md")),
        ),
      }),
    ),
  );
  const references = {};
  for (const [kind, artifactName, command] of [
    ["behavioralTests", "behavioral-tests.log", request.behavioralCommand],
    [
      "acceptanceEvidence",
      "acceptance-evidence.log",
      request.acceptanceCommand,
    ],
  ]) {
    const artifact = fs.readFileSync(
      path.join(input.outputDirectory, artifactName),
    );
    const payload = {
      schemaVersion: 2,
      issuer: ISSUER,
      repository: request.repository,
      repositoryId: request.repositoryId,
      head: request.head,
      requirementsDigest,
      kind,
      observedAt: input.sourceRun.updated_at,
      evidenceSource: "github-actions:product-evidence-source-v1",
      result: "passed",
      environment: "local",
      provenance: {
        executionOwner: "issuer",
        runId: String(input.sourceRun.id),
        runnerIsolation: "fresh-protected",
      },
      artifact: { path: artifactName, sha256: sha256(artifact) },
      ...(kind === "behavioralTests" && command ? { command } : {}),
    };
    const receiptName = `${kind}.receipt.json`;
    writeJson(
      path.join(input.outputDirectory, receiptName),
      envelope(payload, key),
    );
    const receipt = fs.readFileSync(
      path.join(input.outputDirectory, receiptName),
    );
    references[kind] = { receipt: receiptName, sha256: sha256(receipt) };
  }
  const index = {
    schemaVersion: 2,
    repository: request.repository,
    repositoryId: request.repositoryId,
    ...references,
  };
  writeJson(path.join(input.outputDirectory, "evidence.json"), index);
  const evidenceIndexSha256 = sha256(
    fs.readFileSync(path.join(input.outputDirectory, "evidence.json")),
  );
  writeJson(path.join(input.outputDirectory, "producer.json"), {
    schemaVersion: 1,
    head: request.head,
    evidenceIndexSha256,
    requirementsDigest,
    producerRunId: input.runtime.runId,
    sourceRunId: String(input.sourceRun.id),
    keyFingerprint: trustedPublicKeyFingerprint(crypto.createPublicKey(key)),
  });
  return { head: request.head, evidenceIndexSha256 };
}

function main() {
  const [
    eventFile,
    runFile,
    jobsFile,
    prFile,
    sourceDirectory,
    outputDirectory,
  ] = process.argv.slice(2);
  if (!outputDirectory)
    throw new Error(
      "usage: product-evidence-producer.js <event> <run> <jobs> <pr> <source-dir> <output-dir>",
    );
  const result = produce({
    event: jsonFile(eventFile, "event"),
    sourceRun: jsonFile(runFile, "source run"),
    sourceJobs: jsonFile(jobsFile, "source jobs"),
    pullRequest: jsonFile(prFile, "pull request"),
    sourceDirectory,
    outputDirectory,
    encodedPrivateKey: process.env.PRODUCT_EVIDENCE_PRIVATE_KEY,
    runtime: {
      githubActions: process.env.GITHUB_ACTIONS,
      eventName: process.env.GITHUB_EVENT_NAME,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      workflowRef: process.env.PRODUCT_EVIDENCE_WORKFLOW_PATH,
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      runId: process.env.GITHUB_RUN_ID,
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `product evidence producer failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { produce, validateRequest };
