#!/usr/bin/env node
"use strict";

/**
 * The only schema-v2 write ingress.
 *
 * A receipt is deliberately stored outside the target repository.  A worker
 * can validate the exact prompt and revision, but cannot invent a cheaper
 * model, a larger wall cap, or a new campaign after it starts.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  loadPolicyV2,
  resolvePhaseExecution,
  validatePhaseExecutionPlan,
  validatePhaseRunRecord,
} = require("./compute-governor");

const CAMPAIGN_BUDGET_SECONDS = 900;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

class DispatchError extends Error {}

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

function canonicalString(value) {
  return JSON.stringify(canonicalJson(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stateDirectory(environment = process.env) {
  const root =
    environment.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(root, "claude-kit", "builder-dispatch");
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["create", "verify", "reservation", "settle"].includes(command)) {
    throw new DispatchError(
      "usage: builder-dispatch.js create|verify|reservation|settle --receipt file --prompt-file file --target-dir dir --state-dir dir [--request file] [--run-record file]",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--") || token.includes("=")) {
      throw new DispatchError(`invalid argument: ${token}`);
    }
    const key = token.slice(2);
    if (
      ![
        "receipt",
        "request",
        "prompt-file",
        "target-dir",
        "state-dir",
        "run-record",
      ].includes(key)
    ) {
      throw new DispatchError(`unknown argument: ${token}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DispatchError(`${token} requires a value`);
    }
    if (options[key]) throw new DispatchError(`duplicate argument: ${token}`);
    options[key] = value;
    index += 1;
  }
  for (const key of ["receipt", "prompt-file", "target-dir", "state-dir"]) {
    if (!options[key]) throw new DispatchError(`--${key} is required`);
  }
  if (command === "create" && !options.request) {
    throw new DispatchError("--request is required for create");
  }
  if (command === "settle" && !options["run-record"]) {
    throw new DispatchError("--run-record is required for settle");
  }
  return { command, options };
}

function assertRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new DispatchError(`${label} is unreadable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DispatchError(`${label} must be a regular file`);
  }
  return file;
}

function readJson(file, label) {
  assertRegularFile(file, label);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new DispatchError(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertPrivateDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DispatchError(`${label} must be a real directory`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new DispatchError(`${label} must not be group or world accessible`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new DispatchError(`${label} is owned by another user`);
  }
  return fs.realpathSync(directory);
}

function ensurePrivateSubdirectory(root, name) {
  const directory = path.join(root, name);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  return assertPrivateDirectory(
    directory,
    `builder dispatch ${name} directory`,
  );
}

function writeJsonExclusive(file, value, label) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(file, payload, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new DispatchError(`${label} already exists`);
    throw error;
  }
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}

function withLock(root, callback) {
  const lock = path.join(root, ".dispatch.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
    }
  }
  if (!acquired)
    throw new DispatchError("timed out acquiring builder dispatch lock");
  try {
    return callback();
  } finally {
    fs.rmdirSync(lock);
  }
}

function safeStateFile(directory, name, label) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) {
    throw new DispatchError(`invalid ${label} identifier`);
  }
  return path.join(directory, name);
}

function stateLayout(input) {
  const root = assertPrivateDirectory(
    input,
    "builder dispatch state directory",
  );
  return {
    root,
    keys: ensurePrivateSubdirectory(root, "keys"),
    campaigns: ensurePrivateSubdirectory(root, "campaigns"),
  };
}

function signingKeys(layout) {
  const privateFile = path.join(layout.keys, "ed25519-private.der");
  const publicFile = path.join(layout.keys, "ed25519-public.der");
  if (!fs.existsSync(privateFile)) {
    const pair = crypto.generateKeyPairSync("ed25519");
    try {
      fs.writeFileSync(
        privateFile,
        pair.privateKey.export({ format: "der", type: "pkcs8" }),
        { mode: 0o600, flag: "wx" },
      );
      fs.writeFileSync(
        publicFile,
        pair.publicKey.export({ format: "der", type: "spki" }),
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  assertRegularFile(privateFile, "builder dispatch private key");
  assertRegularFile(publicFile, "builder dispatch public key");
  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(privateFile),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = fs.readFileSync(publicFile);
  const publicKey = crypto.createPublicKey({
    key: publicDer,
    format: "der",
    type: "spki",
  });
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new DispatchError("builder dispatch signing key must be Ed25519");
  }
  return { privateKey, publicKey, fingerprint: sha256(publicDer) };
}

function gitValue(targetDir, args, label) {
  try {
    return execFileSync("git", args, {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new DispatchError(`target directory has no readable ${label}`);
  }
}

function repositoryIdentity(targetDir) {
  const common = gitValue(
    targetDir,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "Git identity",
  );
  let origin = "";
  try {
    origin = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Local fixtures and disconnected repositories have no origin.  The shared
    // Git directory still keeps different worktrees on one stable identity.
  }
  return sha256(canonicalString({ origin: origin || null, common }));
}

function policyDigest() {
  const policyFile = path.join(
    __dirname,
    "..",
    "config",
    "compute-governor-policy-v2.json",
  );
  return sha256(
    canonicalString(readJson(policyFile, "compute governor policy")),
  );
}

function receiptEnvelope(payload, privateKey) {
  return {
    payload,
    signature: crypto
      .sign(null, Buffer.from(canonicalString(payload)), privateKey)
      .toString("base64url"),
  };
}

function verifyEnvelope(envelope, publicKey) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    !envelope.payload ||
    typeof envelope.payload !== "object" ||
    Array.isArray(envelope.payload) ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.signature)
  ) {
    throw new DispatchError("builder dispatch receipt is malformed");
  }
  if (
    !crypto.verify(
      null,
      Buffer.from(canonicalString(envelope.payload)),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    )
  ) {
    throw new DispatchError("builder dispatch receipt signature is invalid");
  }
  return envelope.payload;
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalString(Object.keys(value).sort()) ===
      canonicalString([...keys].sort())
  );
}

function validCampaignIdentity(campaign) {
  return (
    exactKeys(campaign, [
      "schemaVersion",
      "kind",
      "id",
      "repositoryIdentity",
      "taskIntentSha256",
      "caller",
      "phase",
      "policyVersion",
      "policySha256",
      "createdAt",
      "budget",
      "attempts",
    ]) &&
    campaign.schemaVersion === 1 &&
    campaign.kind === "builder-dispatch-campaign/v1" &&
    /^[a-f0-9]{64}$/.test(campaign.id) &&
    /^[a-f0-9]{64}$/.test(campaign.repositoryIdentity) &&
    /^[a-f0-9]{64}$/.test(campaign.taskIntentSha256) &&
    /^[a-f0-9]{64}$/.test(campaign.policySha256) &&
    typeof campaign.caller === "string" &&
    typeof campaign.phase === "string" &&
    typeof campaign.createdAt === "string"
  );
}

function validCampaignBudget(budget) {
  return (
    budget &&
    Number.isInteger(budget.limitSeconds) &&
    budget.limitSeconds === CAMPAIGN_BUDGET_SECONDS &&
    Number.isInteger(budget.usedSeconds) &&
    budget.usedSeconds >= 0 &&
    Number.isInteger(budget.reservedSeconds) &&
    budget.reservedSeconds >= 0 &&
    budget.usedSeconds + budget.reservedSeconds <= budget.limitSeconds
  );
}

function validCampaign(campaign) {
  return (
    validCampaignIdentity(campaign) &&
    validCampaignBudget(campaign.budget) &&
    campaign.attempts &&
    typeof campaign.attempts === "object" &&
    !Array.isArray(campaign.attempts)
  );
}

function validReceiptIssuer(issuer) {
  return (
    issuer &&
    issuer.algorithm === "ed25519" &&
    /^[a-f0-9]{64}$/.test(issuer.publicKeyFingerprint || "")
  );
}

function validReceiptAttempt(attempt) {
  return (
    attempt &&
    /^[a-f0-9]{64}$/.test(attempt.id || "") &&
    /^[a-f0-9]{64}$/.test(attempt.campaignId || "") &&
    /^[a-f0-9]{40}$/.test(attempt.targetHead || "") &&
    /^[a-f0-9]{64}$/.test(attempt.planSha256 || "") &&
    /^[a-f0-9]{64}$/.test(attempt.promptSha256 || "") &&
    Number.isInteger(attempt.reservedSeconds) &&
    attempt.reservedSeconds > 0
  );
}

function receiptPayloadValid(payload) {
  return (
    exactKeys(payload, [
      "schemaVersion",
      "kind",
      "issuer",
      "campaign",
      "attempt",
      "plan",
    ]) &&
    payload.schemaVersion === 1 &&
    payload.kind === "builder-dispatch-plan/v1" &&
    validReceiptIssuer(payload.issuer) &&
    payload.campaign &&
    /^[a-f0-9]{64}$/.test(payload.campaign.id || "") &&
    validReceiptAttempt(payload.attempt) &&
    payload.plan &&
    typeof payload.plan === "object"
  );
}

function campaignFile(layout, id) {
  return safeStateFile(layout.campaigns, `${id}.json`, "campaign");
}

function readCampaign(layout, id) {
  const file = campaignFile(layout, id);
  if (!fs.existsSync(file)) return null;
  const campaign = readJson(file, "builder dispatch campaign");
  if (!validCampaign(campaign) || campaign.id !== id) {
    throw new DispatchError("builder dispatch campaign is malformed");
  }
  return campaign;
}

function writeOutputReceipt(file, envelope) {
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) {
    throw new DispatchError("receipt output directory does not exist");
  }
  writeJsonExclusive(file, envelope, "receipt output");
}

function create(input) {
  const layout = stateLayout(input.stateDir);
  const keys = signingKeys(layout);
  const request = readJson(input.request, "phase request");
  assertRegularFile(input.promptFile, "prompt file");
  const target = fs.realpathSync(input.targetDir);
  const policy = loadPolicyV2();
  const plan = resolvePhaseExecution(request, input.promptFile, target, policy);
  if (plan.accessProfile !== "workspace-write") {
    throw new DispatchError(
      "builder dispatch is only required for schema-v2 write phases",
    );
  }
  const intent = plan.executionBinding.promptSha256;
  const policySha256 = policyDigest();
  const repository = repositoryIdentity(target);
  const campaignId = sha256(
    canonicalString({
      schemaVersion: 1,
      kind: "builder-dispatch-campaign/v1",
      repository,
      taskIntentSha256: intent,
      caller: plan.caller,
      phase: plan.phase,
      policyVersion: plan.policyVersion,
      policySha256,
    }),
  );
  const planSha256 = sha256(canonicalString(plan));
  const attemptId = sha256(
    canonicalString({
      schemaVersion: 1,
      campaignId,
      targetHead: plan.executionBinding.targetHead,
      planSha256,
    }),
  );
  let envelope;
  withLock(layout.root, () => {
    let campaign = readCampaign(layout, campaignId);
    if (!campaign) {
      campaign = {
        schemaVersion: 1,
        kind: "builder-dispatch-campaign/v1",
        id: campaignId,
        repositoryIdentity: repository,
        taskIntentSha256: intent,
        caller: plan.caller,
        phase: plan.phase,
        policyVersion: plan.policyVersion,
        policySha256,
        createdAt: new Date().toISOString(),
        budget: {
          limitSeconds: CAMPAIGN_BUDGET_SECONDS,
          usedSeconds: 0,
          reservedSeconds: 0,
        },
        attempts: {},
      };
      writeJsonExclusive(
        campaignFile(layout, campaignId),
        campaign,
        "campaign",
      );
    }
    const existing = campaign.attempts[attemptId];
    if (existing) {
      if (existing.status !== "reserved") {
        throw new DispatchError("builder dispatch attempt is already terminal");
      }
      const existingEnvelope = existing.receipt;
      const payload = verifyEnvelope(existingEnvelope, keys.publicKey);
      if (
        !receiptPayloadValid(payload) ||
        payload.issuer.publicKeyFingerprint !== keys.fingerprint ||
        payload.attempt.id !== attemptId ||
        payload.attempt.planSha256 !== planSha256
      ) {
        throw new DispatchError(
          "builder dispatch authoritative receipt is malformed",
        );
      }
      envelope = existingEnvelope;
      return;
    }
    const remaining =
      campaign.budget.limitSeconds -
      campaign.budget.usedSeconds -
      campaign.budget.reservedSeconds;
    const reservedSeconds = Math.min(plan.caps.maxWallSeconds, remaining);
    if (reservedSeconds < 1) {
      throw new DispatchError("builder dispatch campaign budget is exhausted");
    }
    const payload = {
      schemaVersion: 1,
      kind: "builder-dispatch-plan/v1",
      issuer: { algorithm: "ed25519", publicKeyFingerprint: keys.fingerprint },
      campaign: {
        id: campaign.id,
        repositoryIdentity: campaign.repositoryIdentity,
        taskIntentSha256: campaign.taskIntentSha256,
        policyVersion: campaign.policyVersion,
        policySha256: campaign.policySha256,
        budget: {
          limitSeconds: campaign.budget.limitSeconds,
          reservedSeconds,
        },
      },
      attempt: {
        id: attemptId,
        campaignId,
        targetHead: plan.executionBinding.targetHead,
        promptSha256: intent,
        planSha256,
        reservedSeconds,
      },
      plan,
    };
    envelope = receiptEnvelope(payload, keys.privateKey);
    // Keep the receipt and reservation in one atomic campaign record. A crash
    // can leave an empty campaign, but cannot strand a live reservation without
    // the exact signed receipt needed to settle or resume it.
    campaign.attempts[attemptId] = {
      status: "reserved",
      targetHead: plan.executionBinding.targetHead,
      planSha256,
      promptSha256: intent,
      reservedSeconds,
      receipt: envelope,
    };
    campaign.budget.reservedSeconds += reservedSeconds;
    writeJsonAtomically(campaignFile(layout, campaignId), campaign);
  });
  writeOutputReceipt(input.receipt, envelope);
  return envelope;
}

function assertReceiptMatchesLedger(
  payload,
  campaign,
  attempt,
  requireReserved,
) {
  if (
    !attempt ||
    payload.attempt.campaignId !== campaign.id ||
    payload.campaign.repositoryIdentity !== campaign.repositoryIdentity ||
    payload.campaign.taskIntentSha256 !== campaign.taskIntentSha256 ||
    payload.campaign.policyVersion !== campaign.policyVersion ||
    payload.campaign.policySha256 !== campaign.policySha256 ||
    attempt.targetHead !== payload.attempt.targetHead ||
    attempt.planSha256 !== payload.attempt.planSha256 ||
    attempt.promptSha256 !== payload.attempt.promptSha256 ||
    attempt.reservedSeconds !== payload.attempt.reservedSeconds ||
    (requireReserved && attempt.status !== "reserved")
  ) {
    throw new DispatchError(
      "builder dispatch receipt is not an active exact attempt",
    );
  }
}

function assertReceiptPlanBinding(payload) {
  if (
    payload.plan.executionBinding.targetHead !== payload.attempt.targetHead ||
    sha256(canonicalString(payload.plan)) !== payload.attempt.planSha256 ||
    payload.plan.executionBinding.promptSha256 !== payload.attempt.promptSha256
  ) {
    throw new DispatchError(
      "builder dispatch receipt plan binding is malformed",
    );
  }
}

function verifiedReceipt(
  input,
  { requireReserved = true, validatePlan = true } = {},
) {
  const layout = stateLayout(input.stateDir);
  const keys = signingKeys(layout);
  const envelope = readJson(input.receipt, "builder dispatch receipt");
  const payload = verifyEnvelope(envelope, keys.publicKey);
  if (!receiptPayloadValid(payload)) {
    throw new DispatchError("builder dispatch receipt payload is malformed");
  }
  if (payload.issuer.publicKeyFingerprint !== keys.fingerprint) {
    throw new DispatchError("builder dispatch receipt has an unknown issuer");
  }
  const campaign = readCampaign(layout, payload.campaign.id);
  const attempt = campaign?.attempts[payload.attempt.id];
  const authoritative = attempt?.receipt;
  if (canonicalString(authoritative) !== canonicalString(envelope)) {
    throw new DispatchError(
      "builder dispatch receipt does not match its ledger entry",
    );
  }
  assertReceiptMatchesLedger(payload, campaign, attempt, requireReserved);
  if (validatePlan) {
    try {
      validatePhaseExecutionPlan(
        payload.plan,
        input.promptFile,
        input.targetDir,
      );
    } catch (error) {
      throw new DispatchError(error.message);
    }
  }
  assertReceiptPlanBinding(payload);
  return { layout, keys, envelope, payload, campaign, attempt };
}

function verify(input) {
  return verifiedReceipt(input).payload.plan;
}

function reservation(input) {
  const verified = verifiedReceipt(input);
  return { reservedSeconds: verified.payload.attempt.reservedSeconds };
}

function settle(input) {
  // Settlement happens after a workspace-write handoff, so the target is
  // intentionally no longer clean. The immutable receipt and run record bind
  // the settled attempt; launch-time prompt and target validation already ran.
  const verified = verifiedReceipt(input, { validatePlan: false });
  const record = readJson(input.runRecord, "builder dispatch run record");
  try {
    validatePhaseRunRecord(record);
  } catch (error) {
    throw new DispatchError(error.message);
  }
  if (canonicalString(record.plan) !== canonicalString(verified.payload.plan)) {
    throw new DispatchError(
      "builder dispatch run record is not bound to the receipt plan",
    );
  }
  const elapsedMilliseconds =
    record.timing.finishedAtEpochMs - record.timing.startedAtEpochMs;
  const usedSeconds = Math.max(1, Math.ceil(elapsedMilliseconds / 1000));
  if (usedSeconds > verified.attempt.reservedSeconds) {
    throw new DispatchError(
      "builder dispatch run record exceeded its reservation",
    );
  }
  let settled;
  withLock(verified.layout.root, () => {
    const campaign = readCampaign(verified.layout, verified.campaign.id);
    const attempt = campaign.attempts[verified.payload.attempt.id];
    if (!attempt || attempt.status !== "reserved") {
      throw new DispatchError("builder dispatch attempt is already terminal");
    }
    campaign.budget.reservedSeconds -= attempt.reservedSeconds;
    campaign.budget.usedSeconds += usedSeconds;
    attempt.status = "settled";
    attempt.usedSeconds = usedSeconds;
    attempt.outcome = record.outcome.status;
    attempt.runRecordSha256 = sha256(canonicalString(record));
    attempt.settledAt = new Date().toISOString();
    writeJsonAtomically(campaignFile(verified.layout, campaign.id), campaign);
    settled = campaign;
  });
  return settled;
}

function main(argv) {
  const { command, options } = parseArguments(argv);
  const input = {
    receipt: options.receipt,
    request: options.request,
    promptFile: options["prompt-file"],
    targetDir: options["target-dir"],
    stateDir: options["state-dir"] || stateDirectory(),
    runRecord: options["run-record"],
  };
  const result =
    command === "create"
      ? create(input)
      : command === "verify"
        ? verify(input)
        : command === "reservation"
          ? reservation(input)
          : settle(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error instanceof DispatchError ? 2 : 1);
  }
}

module.exports = {
  CAMPAIGN_BUDGET_SECONDS,
  create,
  verify,
  reservation,
  settle,
  stateDirectory,
};
