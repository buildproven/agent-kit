#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const POLICY_PATH = ".buildproven/delivery-policy.json";
const REQUIRED_CONTROLS = [
  "deterministic-gates",
  "independent-review",
  "required-ci",
  "base-freshness",
  "merge-authority",
];

function fail(message) {
  throw new Error(`engineering delivery policy: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} does not match the closed schema`);
  }
}

function validatePolicy(policy) {
  exactKeys(policy, ["schemaVersion", "claims"], "document");
  if (policy.schemaVersion !== 1) fail("schemaVersion must be 1");
  exactKeys(policy.claims, ["engineering"], "claims");
  const engineering = policy.claims.engineering;
  exactKeys(
    engineering,
    ["enabled", "claim", "requiredControls", "productAcceptance"],
    "engineering claim",
  );
  if (engineering.enabled !== true) fail("engineering claim is disabled");
  if (engineering.claim !== "engineering") {
    fail("claim identity must be engineering");
  }
  if (
    !Array.isArray(engineering.requiredControls) ||
    JSON.stringify(engineering.requiredControls) !==
      JSON.stringify(REQUIRED_CONTROLS)
  ) {
    fail("requiredControls must contain the complete fixed control set");
  }
  if (engineering.productAcceptance !== "not-established") {
    fail("productAcceptance must be not-established");
  }
  return engineering;
}

function git(root, args, label) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail(`${label} cannot be read from the repository`);
  }
}

function policyAtRevision(root, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision || "")) {
    fail("protected base revision is invalid");
  }
  const raw = git(root, ["show", `${revision}:${POLICY_PATH}`], "policy");
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch {
    fail("policy is not valid JSON");
  }
  return validatePolicy(policy);
}

function assertEngineeringPolicy(manifest) {
  if (manifest.options?.deliveryClaim !== "engineering") return null;
  const root = path.resolve(manifest.repo?.realpath || "");
  const revision = manifest.revisions?.baseHeadSha;
  const baseRef = manifest.revisions?.baseRef;
  if (!baseRef || typeof baseRef !== "string") {
    fail("protected base ref is missing");
  }
  const currentBase = git(root, ["rev-parse", baseRef], "protected base ref");
  if (currentBase !== revision) {
    fail("protected base policy is stale; resume on the current base");
  }
  policyAtRevision(root, revision);
  return {
    claim: "engineering",
    policyRevision: revision,
    productAcceptance: "not-established",
  };
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--manifest") {
    fail("usage: engineering-delivery-policy.js --manifest <exact-path>");
  }
  const quality = require("./quality-invocation");
  const manifest = quality.loadManifest(path.resolve(argv[1])).manifest;
  quality.validateIdentity(manifest, manifest.repo.realpath);
  const result = assertEngineeringPolicy(manifest);
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  POLICY_PATH,
  REQUIRED_CONTROLS,
  assertEngineeringPolicy,
  policyAtRevision,
  validatePolicy,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
