#!/usr/bin/env node
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");
const invocation = require("./quality-invocation.js");
const taxonomy = require("./quality-condition-taxonomy.js");
const { evidenceDigestValid } = require("./quality-ci-billing-waiver.js");

// High-risk condition namespaces require an explicit, category-specific
// acknowledgement flag in addition to --accept (BUI-575). This mirrors, but
// does not replace, quality-condition-taxonomy.js's own per-condition
// highRisk marking (which is derived live from manifest state); this map is
// the static id-prefix -> flag-name binding the CLI surface enforces before
// any manifest even exists.
const HIGH_RISK_ACK_FLAGS = [
  { prefix: "gate:security", flag: "--i-understand-security-risk" },
  { prefix: "gate:test", flag: "--i-understand-test-risk" },
  { prefix: "ci:", flag: "--i-understand-missing-ci" },
  {
    prefix: "base:protected-nonstrict",
    flag: "--i-understand-admin-ref-mutation",
  },
  {
    prefix: "pr:non-atomic-state",
    flag: "--i-understand-pr-state-race",
  },
  { prefix: "review:finding:", flag: "--i-understand-code-finding" },
  // Every other high-risk condition can be acknowledged; this one could not,
  // which made a whole class of change unmergeable rather than merely hard.
  // A test-only diff at high tier raises mutation:missing, and the gate is
  // right to refuse it — a changed test cannot vouch for itself (BUI-483) —
  // but with no acknowledgement the only remaining routes were a bypass
  // outside the system or abandoning the change. Neither is auditable.
  // The operator now states the risk explicitly and it lands in signed
  // evidence (BUI-914).
  { prefix: "mutation:missing", flag: "--i-understand-missing-mutation" },
  {
    prefix: "review:provider-exhaustion",
    flag: "--i-understand-missing-review",
  },
  { prefix: "mutation:", flag: "--i-understand-security-risk" },
];

function requiredAckFlagsFor(acceptedIds) {
  const required = new Set();
  for (const id of acceptedIds) {
    for (const { prefix, flag } of HIGH_RISK_ACK_FLAGS) {
      if (id.startsWith(prefix)) required.add(flag);
    }
  }
  return [...required];
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function parseRequest(raw) {
  const request = parseJson(raw, "request");
  if (
    !request ||
    !Array.isArray(request.argv) ||
    request.argv.some((value) => typeof value !== "string")
  ) {
    throw new Error("request must contain a string argv array");
  }
  return request.argv;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function approvalRequested() {
  return process.env.BREAK_GLASS_APPROVED === "true";
}

function assertOuterApprovalContext() {
  if (
    process.env.BS_QUALITY_HEADLESS === "1" ||
    process.env.BS_QUALITY_ACTIVE === "1"
  ) {
    throw new Error(
      "quality approval is accepted only from the outer quality invocation",
    );
  }
}

// Each flag maps to exactly one signed capability scope. A capability is
// narrow by construction: it can only ever carry the single scope named on
// the command line, never a caller-supplied string, so an operator cannot
// mint a scope the wrapper does not know about. A quality override may also
// accept ci:failed when the same exact candidate has independently verified
// billing-outage evidence; this composes two named conditions in one signed
// capability rather than allowing either condition to authorize the other.
//
// `override` is the ticket-required standalone verb
// (`/bs:quality override --pr <n> --head <sha> --reason <text> --accept
// <id>[,<id>...]`). It is accepted as a strict alias for
// `approve --override-quality --reason ... --accept ...` rather than a
// second signing path: both resolve to the same scope="operator-quality-override"
// capability, so there is exactly one place (issueApprovalCapability) that
// ever mints that scope.
const APPROVAL_SCOPE_FLAGS = {
  "--override-quality": "operator-quality-override",
  "--override-ci-billing": "operator-ci-billing-override",
  "--override-nonstrict-refcas": "operator-nonstrict-refcas-override",
};
const OPERATOR_OVERRIDE_SCOPES = new Set([
  "operator-quality-override",
  "operator-ci-billing-override",
  "operator-nonstrict-refcas-override",
]);

function isOperatorOverrideScope(scope) {
  return OPERATOR_OVERRIDE_SCOPES.has(scope);
}

function readManifestArgument(value, nextValue, currentManifest) {
  const matched = value === "--manifest" || value.startsWith("--manifest=");
  if (!matched) return { matched: false };
  if (currentManifest !== null) {
    throw new Error("quality approve accepts only one --manifest");
  }
  return {
    matched: true,
    manifest:
      value === "--manifest" ? nextValue : value.slice("--manifest=".length),
    consumed: value === "--manifest" ? 1 : 0,
  };
}

function bootstrapArgsForManifest(forwarded, exactManifest) {
  if (exactManifest === null) return forwarded;
  if (!exactManifest) {
    throw new Error("quality approve --manifest requires a path");
  }
  const nonIdentityArgs = forwarded.filter((value, index) => {
    if (value.startsWith("--pr=")) return false;
    if (value === "--pr") return false;
    if (index > 0 && forwarded[index - 1] === "--pr") return false;
    if (value === "--ci-failure") return false;
    if (index > 0 && forwarded[index - 1] === "--ci-failure") return false;
    return true;
  });
  if (nonIdentityArgs.length > 0) {
    throw new Error(
      "quality approve with --manifest accepts only exact PR and HEAD identity arguments",
    );
  }
  return ["--manifest", exactManifest];
}

function scanApprovalArgv(argv, initialScope) {
  const forwarded = [];
  let expectedHead = null;
  let expectedPr = null;
  let exactManifest = null;
  let scope = initialScope;
  let reason = null;
  let acceptRaw = null;
  let ciFailureReason = null;
  const acknowledgedFlags = [];
  const ackFlagNames = new Set(HIGH_RISK_ACK_FLAGS.map((entry) => entry.flag));
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    const manifestArgument = readManifestArgument(
      value,
      argv[index + 1],
      exactManifest,
    );
    if (manifestArgument.matched) {
      exactManifest = manifestArgument.manifest;
      index += manifestArgument.consumed;
    } else if (value === "--head") {
      expectedHead = argv[++index];
    } else if (value.startsWith("--head=")) {
      expectedHead = value.slice("--head=".length);
    } else if (value in APPROVAL_SCOPE_FLAGS) {
      if (scope !== "standard") {
        throw new Error(
          `quality approve accepts only one override flag, got both a prior override and '${value}'`,
        );
      }
      scope = APPROVAL_SCOPE_FLAGS[value];
    } else if (value === "--reason") {
      reason = argv[++index];
    } else if (value.startsWith("--reason=")) {
      reason = value.slice("--reason=".length);
    } else if (value === "--ci-failure") {
      ciFailureReason = argv[++index];
    } else if (value.startsWith("--ci-failure=")) {
      ciFailureReason = value.slice("--ci-failure=".length);
    } else if (value === "--accept") {
      acceptRaw = argv[++index];
    } else if (value.startsWith("--accept=")) {
      acceptRaw = value.slice("--accept=".length);
    } else if (ackFlagNames.has(value)) {
      acknowledgedFlags.push(value);
    } else if (value === "--pr") {
      expectedPr = argv[++index];
      forwarded.push(value, expectedPr);
    } else if (value.startsWith("--pr=")) {
      expectedPr = value.slice("--pr=".length);
      forwarded.push(value);
    } else {
      forwarded.push(value);
    }
  }
  return {
    forwarded: bootstrapArgsForManifest(forwarded, exactManifest),
    exactManifest,
    expectedHead,
    expectedPr,
    scope,
    reason,
    acceptRaw,
    ciFailureReason,
    acknowledgedFlags,
  };
}

// --reason and --accept are mandatory for EVERY operator override, whether
// invoked as the standalone `override` verb or as the legacy
// `approve --override-quality` flag — there is exactly one way to mint an
// operator-quality-override capability, and it always names the exact
// conditions being accepted. This is what makes the override an accountable
// decision rather than a blanket bypass switch (BUI-575). High-risk
// conditions additionally require their matching acknowledgement flag.
function assertOverrideRequestComplete(
  overrideQuality,
  reason,
  acceptedConditions,
  acknowledgedFlags,
) {
  if (!overrideQuality) return;
  if (!reason || !reason.trim()) {
    throw new Error("quality override requires --reason <text>");
  }
  if (acceptedConditions.length === 0) {
    throw new Error(
      "quality override requires --accept <condition-id>[,<condition-id>...]",
    );
  }
  const missingAck = requiredAckFlagsFor(acceptedConditions).filter(
    (flag) => !acknowledgedFlags.includes(flag),
  );
  if (missingAck.length > 0) {
    throw new Error(
      `override accepts a high-risk condition and requires: ${missingAck.join(", ")}`,
    );
  }
}

function assertCiBillingConditions(
  scope,
  ciFailureReason,
  diagnosed,
  accepted,
) {
  const compositeQualityOverride =
    scope === "operator-quality-override" && accepted.includes("ci:failed");
  const nonstrictRefCas = scope === "operator-nonstrict-refcas-override";
  const nonstrictOutage = nonstrictRefCas && accepted.includes("ci:failed");
  if (
    scope !== "operator-ci-billing-override" &&
    !compositeQualityOverride &&
    !nonstrictOutage
  )
    return;
  const expected = `ci:${ciFailureReason}`;
  const nonCiDiagnosed = diagnosed.filter(
    (condition) => !condition.id.startsWith("ci:"),
  );
  if (scope === "operator-ci-billing-override" && nonCiDiagnosed.length > 0) {
    throw new Error(
      "CI billing override cannot accept non-CI conditions; resolve local gates, mutation, and review first",
    );
  }
  if (ciFailureReason !== "failed" || !accepted.includes(expected)) {
    throw new Error(`CI billing override must accept exactly ${expected}`);
  }
  if (scope === "operator-ci-billing-override" && accepted.length !== 1) {
    throw new Error("CI billing override must accept exactly ci:failed");
  }
  const expectedNonstrictConditions = [
    ...(nonstrictOutage ? ["ci:failed"] : []),
    ...(accepted.includes("review:provider-exhaustion")
      ? ["review:provider-exhaustion"]
      : []),
    "base:protected-nonstrict",
    "pr:non-atomic-state",
  ];
  if (
    nonstrictRefCas &&
    (accepted.length !== expectedNonstrictConditions.length ||
      expectedNonstrictConditions.some(
        (condition) => !accepted.includes(condition),
      ))
  ) {
    throw new Error(
      `protected non-strict ref-CAS override must accept exactly ${expectedNonstrictConditions.join(", ")}`,
    );
  }
}

function parseApprovalCommand(argv) {
  const isOverrideVerb = argv[0] === "override";
  if (argv[0] !== "approve" && !isOverrideVerb) {
    return {
      argv,
      explicit: false,
      expectedHead: null,
      expectedPr: null,
      scope: "standard",
      reason: null,
      acceptedConditions: [],
      acknowledgedFlags: [],
      exactManifest: null,
    };
  }
  const scanned = scanApprovalArgv(
    argv,
    isOverrideVerb ? "operator-quality-override" : "standard",
  );
  if (!/^[0-9]+$/.test(scanned.expectedPr || "")) {
    throw new Error("quality approve requires --pr <number>");
  }
  if (!/^[0-9a-f]{40}$/.test(scanned.expectedHead || "")) {
    throw new Error("quality approve requires --head <exact-40-character-sha>");
  }
  const isOverride = isOperatorOverrideScope(scanned.scope);
  const acceptedConditions = taxonomy.parseAcceptList(scanned.acceptRaw);
  if (
    (scanned.scope === "operator-ci-billing-override" ||
      (scanned.scope === "operator-nonstrict-refcas-override" &&
        acceptedConditions.includes("ci:failed"))) &&
    scanned.ciFailureReason !== "failed"
  ) {
    throw new Error("CI billing override requires --ci-failure failed");
  }
  assertOverrideRequestComplete(
    isOverride,
    scanned.reason,
    acceptedConditions,
    scanned.acknowledgedFlags,
  );
  assertOuterApprovalContext();
  return {
    argv: scanned.forwarded,
    explicit: true,
    expectedHead: scanned.expectedHead,
    expectedPr: Number(scanned.expectedPr),
    scope: scanned.scope,
    reason: scanned.reason,
    acceptedConditions,
    ciFailureReason: scanned.ciFailureReason,
    acknowledgedFlags: scanned.acknowledgedFlags,
    exactManifest: scanned.exactManifest,
  };
}

function childEnvironment() {
  const environment = { ...process.env };
  delete environment.BREAK_GLASS_APPROVED;
  delete environment.BREAK_GLASS_APPROVER;
  delete environment.BS_QUALITY_APPROVAL_TTL_SECONDS;
  delete environment.BS_QUALITY_OVERRIDE_APPROVAL_TTL_SECONDS;
  delete environment.BS_QUALITY_APPROVAL_PUBLIC_KEY;
  delete environment.BS_QUALITY_APPROVAL_CHALLENGE_SHA256;
  delete environment.BS_QUALITY_APPROVAL_EXPECTED_HEAD;
  delete environment.BS_QUALITY_APPROVAL_EXPECTED_PR;
  delete environment.BS_QUALITY_APPROVAL_ONLY;
  return environment;
}

function withRepositoryLease(manifestPath, operation) {
  const manifest = parseJson(
    fs.readFileSync(manifestPath, "utf8"),
    "quality manifest",
  );
  if (manifest.options?.merge !== true) return operation();
  const lease = require("./quality-repo-lease.js").acquire(manifestPath, {
    waitMs: 0,
  });
  const previousToken = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
  process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = lease.token;
  try {
    return operation();
  } finally {
    if (previousToken === undefined) {
      delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    } else {
      process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = previousToken;
    }
  }
}

// Print the exact diagnosed conditions and evidence snapshot the operator is
// about to accept, before the signed capability is minted (BUI-575 safety
// requirement 2). This always runs ahead of issuing an override capability;
// there is no override path that skips straight to signing.
function printOverrideDiagnosis(manifestPath, manifest, conditions) {
  const terminalStatus = require("./quality-terminal-status.js");
  const diagnosis = terminalStatus.buildDiagnosis(manifestPath, manifest, {});
  process.stdout.write(`${diagnosis}\n\n`);
  process.stdout.write("OPERATOR OVERRIDE — CONDITIONS TO ACCEPT\n");
  for (const condition of conditions) {
    process.stdout.write(
      `  [${condition.highRisk ? "HIGH RISK" : "standard "}] ${condition.id} — ${condition.description}\n`,
    );
  }
  process.stdout.write("\n");
}

// Operator override defaults to a shorter TTL than a standard approval: this
// is a deliberate final human decision about a specific diagnosed state, not
// routine sign-off, so its blast radius (how long the signed capability
// remains redeemable) is deliberately tighter by default.
// BS_QUALITY_APPROVAL_TTL_SECONDS still governs standard approvals;
// BS_QUALITY_OVERRIDE_APPROVAL_TTL_SECONDS is the override-specific knob,
// read only when this capability's scope is operator-quality-override.
function resolveApprovalTtlSeconds(scope) {
  const isOverride = isOperatorOverrideScope(scope);
  const ttlEnvVar = isOverride
    ? "BS_QUALITY_OVERRIDE_APPROVAL_TTL_SECONDS"
    : "BS_QUALITY_APPROVAL_TTL_SECONDS";
  const ttlDefault = isOverride ? "900" : "3600";
  const ttl = Number(process.env[ttlEnvVar] || ttlDefault);
  const minimum = scope === "operator-nonstrict-refcas-override" ? 120 : 1;
  if (!Number.isInteger(ttl) || ttl < minimum || ttl > 86400) {
    throw new Error(
      `approval TTL must be an integer between ${minimum} and 86400 seconds`,
    );
  }
  return ttl;
}

function assertExpectedIdentityMatches(manifest, expectedIdentity) {
  if (!expectedIdentity) return;
  if (
    manifest.repo.pr !== expectedIdentity.pr ||
    manifest.revisions.currentHead !== expectedIdentity.head
  ) {
    throw new Error(
      `approval identity mismatch: expected PR ${expectedIdentity.pr} at ${expectedIdentity.head}, got PR ${manifest.repo.pr} at ${manifest.revisions.currentHead}`,
    );
  }
}

// Prints the diagnosis (BUI-575 safety requirement 2) and validates the
// requested accept-list covers every diagnosed condition before returning
// it. Only ever called on the override path.
function resolveOverrideAcceptedConditions(
  manifestPath,
  manifest,
  expectedIdentity,
) {
  const requestedAccept = expectedIdentity.acceptedConditions || [];
  const diagnosed = taxonomy.diagnoseConditions(manifest, {
    ciFailureReason: expectedIdentity.ciFailureReason,
  });
  let protectedNonstrictProtectionDigest = null;
  let protectedNonstrictRequiredChecks = null;
  if (expectedIdentity.scope === "operator-nonstrict-refcas-override") {
    const branch =
      require("./quality-protected-nonstrict.js").normalizeProtectedBranch(
        manifest.revisions.baseRef,
      );
    const inspection =
      require("./quality-protected-nonstrict.js").inspectProtectedNonstrict({
        repository: manifest.repo.githubRepository,
        branch,
        pr: manifest.repo.pr,
        cwd: manifest.repo.realpath,
      });
    diagnosed.push({
      id: "base:protected-nonstrict",
      description:
        "protected base uses non-strict required checks and requires an administrator non-force ref update",
      highRisk: true,
      protectionDigest: inspection.digest,
    });
    diagnosed.push({
      id: "pr:non-atomic-state",
      description:
        "the direct immutable-head integration cannot atomically bind the ref update to concurrent PR close or retarget state",
      highRisk: true,
    });
    protectedNonstrictProtectionDigest = inspection.digest;
    protectedNonstrictRequiredChecks = inspection.requiredChecks;
  }
  printOverrideDiagnosis(manifestPath, manifest, diagnosed);
  assertCiBillingConditions(
    expectedIdentity.scope,
    expectedIdentity.ciFailureReason,
    diagnosed,
    requestedAccept,
  );
  taxonomy.assertAcceptListComplete(diagnosed, requestedAccept);
  return {
    acceptedConditions: requestedAccept,
    protectedNonstrictProtectionDigest,
    protectedNonstrictRequiredChecks,
  };
}

function ensureCiBillingEvidence(manifest) {
  const artifactPath = path.join(manifest.stateRoot, "ci-billing-waiver.json");
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "quality-ci-billing-waiver.js"),
      "--repo",
      manifest.repo.githubRepository,
      "--pr",
      String(manifest.repo.pr),
      "--head",
      manifest.revisions.currentHead,
      "--artifact",
      artifactPath,
    ],
    { encoding: "utf8", timeout: 30_000, env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(
      `CI billing override requires independently classified exact-head Actions evidence: ${
        result.stderr.trim() || "classification failed"
      }`,
    );
  }
  const evidence = parseJson(
    fs.readFileSync(artifactPath, "utf8"),
    "CI billing waiver evidence",
  );
  if (
    evidence.repository !== manifest.repo.githubRepository ||
    evidence.head !== manifest.revisions.currentHead ||
    evidence.category !== "github-actions-billing-preallocation" ||
    !Array.isArray(evidence.failedJobs) ||
    evidence.failedJobs.length === 0 ||
    !evidenceDigestValid(evidence)
  ) {
    throw new Error(
      "CI billing waiver evidence is not bound to the exact PR head",
    );
  }
  return evidence.evidenceSha256;
}

function issueApprovalCapability(
  manifestPath,
  {
    invocationScript,
    challenge,
    publicKey,
    privateKey,
    expectedIdentity = null,
  },
) {
  const manifest = parseJson(
    fs.readFileSync(manifestPath, "utf8"),
    "quality manifest",
  );
  const scope = expectedIdentity?.scope || "standard";
  const isOverride = isOperatorOverrideScope(scope);
  const ttl = resolveApprovalTtlSeconds(scope);
  const issuedAt = new Date();
  assertExpectedIdentityMatches(manifest, expectedIdentity);
  const overrideResolution = isOverride
    ? resolveOverrideAcceptedConditions(
        manifestPath,
        manifest,
        expectedIdentity,
      )
    : {
        acceptedConditions: [],
        protectedNonstrictProtectionDigest: null,
        protectedNonstrictRequiredChecks: null,
      };
  const {
    acceptedConditions,
    protectedNonstrictProtectionDigest,
    protectedNonstrictRequiredChecks,
  } = overrideResolution;
  const ciBillingEvidenceSha256 = acceptedConditions.includes("ci:failed")
    ? ensureCiBillingEvidence(manifest)
    : null;
  const payload = {
    schemaVersion: 1,
    repoKey: manifest.repo.key,
    pr: manifest.repo.pr,
    head: manifest.revisions.currentHead,
    baseSha: manifest.revisions.baseSha,
    invocationId: manifest.invocationId,
    approver: process.env.BREAK_GLASS_APPROVER || process.env.USER || "unknown",
    scope,
    reason: isOverride ? expectedIdentity.reason : null,
    acceptedConditions,
    ciBillingEvidenceSha256,
    protectedNonstrictProtectionDigest,
    protectedNonstrictRequiredChecks,
    protectedNonstrictBaseSha:
      scope === "operator-nonstrict-refcas-override"
        ? manifest.revisions.baseHeadSha
        : null,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
    nonce: crypto.randomUUID(),
    challenge,
  };
  const artifact = {
    schemaVersion: 1,
    payload,
    signature: crypto
      .sign(
        null,
        Buffer.from(JSON.stringify(canonicalJson(payload))),
        privateKey,
      )
      .toString("base64"),
  };
  const directory = path.join(manifest.stateRoot, "approval");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(
    directory,
    `${manifest.revisions.currentHead}-${payload.nonce}.json`,
  );
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  if (
    fs.realpathSync(invocationScript) !==
    fs.realpathSync(path.join(__dirname, "quality-invocation.js"))
  ) {
    throw new Error("approval invocation script is outside the wrapper root");
  }
  invocation.withManifestLock(manifestPath, (locked) => {
    invocation.armApprovalChallenge(locked, {
      challenge: crypto.createHash("sha256").update(challenge).digest("hex"),
      publicKey,
    });
    invocation.attachApproval(locked, { artifact: artifactPath });
  });
  return payload;
}

// Descendant resume is a two-phase decision: the manifest must move from the
// exhausted old HEAD so its new deterministic gates can be recorded, then the
// final operator override is signed against that new HEAD.  Sign a short-lived
// one-use pre-authorization for the first phase so bootstrap never treats a
// plain environment variable as operator authority.
function prepareDescendantAdvanceAuthorization(
  manifestPath,
  { expectedHead, expectedPr, scope, reason, acceptedConditions },
  { challenge, keyPair, publicKey },
) {
  const manifest = parseJson(
    fs.readFileSync(manifestPath, "utf8"),
    "quality manifest",
  );
  if (
    ![
      "operator-quality-override",
      "operator-nonstrict-refcas-override",
    ].includes(scope) ||
    manifest.repo.pr !== expectedPr ||
    manifest.revisions.currentHead === expectedHead
  ) {
    return null;
  }
  const issuedAt = new Date();
  const payload = {
    schemaVersion: 1,
    kind: "quality-descendant-advance/v1",
    repoKey: manifest.repo.key,
    pr: manifest.repo.pr,
    invocationId: manifest.invocationId,
    baseSha: manifest.revisions.baseSha,
    fromHead: manifest.revisions.currentHead,
    head: expectedHead,
    scope,
    reason,
    acceptedConditions,
    approver: process.env.BREAK_GLASS_APPROVER || process.env.USER || "unknown",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(),
    nonce: crypto.randomUUID(),
    challenge,
  };
  const artifact = {
    schemaVersion: 1,
    payload,
    signature: crypto
      .sign(
        null,
        Buffer.from(JSON.stringify(canonicalJson(payload))),
        keyPair.privateKey,
      )
      .toString("base64"),
  };
  const directory = path.join(manifest.stateRoot, "advance-authorizations");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(
    directory,
    `${expectedHead}-${payload.nonce}.json`,
  );
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  withRepositoryLease(manifestPath, () =>
    invocation.withManifestLock(manifestPath, (locked) => {
      invocation.armApprovalChallenge(locked, {
        challenge: crypto.createHash("sha256").update(challenge).digest("hex"),
        publicKey,
        supersedingHead: expectedHead,
      });
    }),
  );
  return artifactPath;
}

function approvalMaterial(wantsApproval) {
  if (!wantsApproval) {
    return { challenge: null, keyPair: null, publicKey: null };
  }
  const keyPair = crypto.generateKeyPairSync("ed25519");
  return {
    challenge: crypto.randomBytes(32).toString("hex"),
    keyPair,
    publicKey: keyPair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}

function manifestPathFromBootstrap(stdout) {
  const manifestPath = String(stdout || "")
    .split("\n")
    .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
    ?.slice("BS_QUALITY_MANIFEST=".length);
  if (!manifestPath)
    throw new Error("bootstrap did not return a manifest path");
  return manifestPath;
}

function printExplicitApproval(approval) {
  const isOverride = isOperatorOverrideScope(approval.scope);
  process.stdout.write(
    [
      isOverride
        ? "[quality] operator override approval created"
        : "[quality] break-glass approval created",
      `Repository key: ${approval.repoKey}`,
      `PR: ${approval.pr}`,
      `HEAD: ${approval.head}`,
      `Base: ${approval.baseSha}`,
      `Invocation: ${approval.invocationId}`,
      `Approver: ${approval.approver}`,
      ...(isOverride
        ? [
            `Reason: ${approval.reason}`,
            `Accepted conditions: ${approval.acceptedConditions.join(", ")}`,
          ]
        : []),
      `Expires: ${approval.expiresAt}`,
      "",
    ].join("\n"),
  );
}

function readRequestFromStdin() {
  if (process.stdin.isTTY) {
    throw new Error(
      "internal wrapper requires a JSON request on standard input; use quality-bootstrap.sh for an interactive run",
    );
  }
  return parseApprovalCommand(parseRequest(fs.readFileSync(0, "utf8")));
}

function needsDescendantAdvanceAuthorization(request) {
  return (
    request.explicit &&
    request.exactManifest &&
    isOperatorOverrideScope(request.scope) &&
    request.acceptedConditions.includes("review:provider-exhaustion")
  );
}

function main() {
  const bootstrap = process.argv[2];
  if (!bootstrap) throw new Error("bootstrap path is required");
  const request = readRequestFromStdin();
  const argv = request.argv;
  const environmentApproval = approvalRequested();
  if (environmentApproval) assertOuterApprovalContext();
  const wantsApproval = request.explicit || environmentApproval;
  const { challenge, keyPair, publicKey } = approvalMaterial(wantsApproval);
  const environment = childEnvironment();
  let advanceAuthorizationArtifact = null;
  if (needsDescendantAdvanceAuthorization(request)) {
    advanceAuthorizationArtifact = prepareDescendantAdvanceAuthorization(
      request.exactManifest,
      {
        expectedHead: request.expectedHead,
        expectedPr: request.expectedPr,
        scope: request.scope,
        reason: request.reason,
        acceptedConditions: request.acceptedConditions,
      },
      { challenge, keyPair, publicKey },
    );
  }
  if (advanceAuthorizationArtifact) {
    environment.BS_QUALITY_ADVANCE_AUTHORIZATION_ARTIFACT =
      advanceAuthorizationArtifact;
  }
  if (request.exactManifest) {
    environment.BS_QUALITY_APPROVAL_EXPECTED_HEAD = request.expectedHead;
    environment.BS_QUALITY_APPROVAL_EXPECTED_PR = String(request.expectedPr);
    environment.BS_QUALITY_APPROVAL_ONLY = "1";
    environment.BS_QUALITY_APPROVAL_SCOPE = request.scope;
    if (isOperatorOverrideScope(request.scope)) {
      environment.BS_QUALITY_APPROVAL_ACCEPTED_CONDITIONS =
        request.acceptedConditions.join(",");
    }
  }
  const result = spawnSync("bash", [bootstrap, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  if (result.status === 0 && wantsApproval) {
    const manifestPath = manifestPathFromBootstrap(result.stdout);
    const approval = withRepositoryLease(manifestPath, () =>
      issueApprovalCapability(manifestPath, {
        invocationScript: path.join(
          path.dirname(bootstrap),
          "quality-invocation.js",
        ),
        challenge,
        publicKey,
        privateKey: keyPair.privateKey,
        expectedIdentity: request.explicit
          ? {
              pr: request.expectedPr,
              head: request.expectedHead,
              scope: request.scope,
              reason: request.reason,
              acceptedConditions: request.acceptedConditions,
              ciFailureReason: request.ciFailureReason,
            }
          : null,
      }),
    );
    if (request.explicit) printExplicitApproval(approval);
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}

module.exports = {
  assertCiBillingConditions,
  parseApprovalCommand,
  parseRequest,
  prepareDescendantAdvanceAuthorization,
  resolveApprovalTtlSeconds,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality-wrapper: ${error.message}\n`);
    process.exit(1);
  }
}
