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
const MAX_RETRIES_PER_PLAN = 1;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;
const OWNERLESS_LOCK_STALE_MS = 2_000;
const LEGACY_LOCK_STALE_MS = LOCK_TIMEOUT_MS;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const REQUIRED_OPTIONS = {
  create: [
    "receipt",
    "prompt-file",
    "target-dir",
    "state-dir",
    "request",
    "task-id",
  ],
  verify: ["receipt", "prompt-file", "target-dir", "state-dir"],
  reservation: ["receipt", "prompt-file", "target-dir", "state-dir"],
  launch: ["receipt", "prompt-file", "target-dir", "state-dir"],
  settle: ["receipt", "prompt-file", "target-dir", "state-dir", "run-record"],
};

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

// Inlined rather than imported from ./state-dir-name.js: some test fixtures
// copy this file standalone into an isolated scripts/ dir without siblings,
// so it must not depend on another repo file at runtime.
function resolveStateDirName(parentDir, fsImpl = fs) {
  if (fsImpl.existsSync(path.join(parentDir, "agent-kit"))) return "agent-kit";
  if (fsImpl.existsSync(path.join(parentDir, "claude-kit")))
    return "claude-kit";
  return "agent-kit";
}

function stateDirectory(environment = process.env) {
  const root =
    environment.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(root, resolveStateDirName(root), "builder-dispatch");
}

function assertRequiredOptions(command, options) {
  for (const key of REQUIRED_OPTIONS[command]) {
    if (!options[key]) {
      throw new DispatchError(`--${key} is required for ${command}`);
    }
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (
    !["create", "verify", "reservation", "launch", "settle"].includes(command)
  ) {
    throw new DispatchError(
      "usage: builder-dispatch.js create|verify|reservation|launch|settle --receipt file --prompt-file file --target-dir dir --state-dir dir [--request file --task-id id] [--run-record file]",
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
        "task-id",
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
  assertRequiredOptions(command, options);
  return { command, options };
}

function taskReference(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$/.test(value)
  ) {
    throw new DispatchError(
      "--task-id must be a stable, non-prompt task or approved-plan reference",
    );
  }
  return value;
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

function lockOwnerFile(lock) {
  return path.join(lock, "owner.json");
}

function processStartIdentity(pid) {
  try {
    const identity = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return identity || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw new DispatchError(
      `could not determine builder dispatch lock owner identity: ${error.message}`,
    );
  }
}

function validLockOwnerBase(owner) {
  return (
    Number.isSafeInteger(owner?.pid) &&
    owner.pid > 0 &&
    Number.isSafeInteger(owner.createdAtEpochMs) &&
    owner.createdAtEpochMs > 0
  );
}

function decodedLockOwner(owner, file) {
  if (
    owner?.schemaVersion === 2 &&
    validLockOwnerBase(owner) &&
    typeof owner.processStartIdentity === "string" &&
    owner.processStartIdentity.length > 0 &&
    owner.processStartIdentity.length <= 256
  ) {
    return {
      status: "identified",
      file,
      pid: owner.pid,
      createdAtEpochMs: owner.createdAtEpochMs,
      processStartIdentity: owner.processStartIdentity,
    };
  }
  if (owner?.schemaVersion === 1 && validLockOwnerBase(owner)) {
    return {
      status: "legacy",
      file,
      pid: owner.pid,
      createdAtEpochMs: owner.createdAtEpochMs,
    };
  }
  return { status: "malformed", file };
}

function readLockOwner(lock) {
  const file = lockOwnerFile(lock);
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", file };
    if (error.code === "ELOOP") {
      throw new DispatchError("builder dispatch lock owner is unsafe");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) {
      throw new DispatchError("builder dispatch lock owner is unsafe");
    }
    try {
      return decodedLockOwner(
        JSON.parse(fs.readFileSync(descriptor, "utf8")),
        file,
      );
    } catch {
      // A process can crash while writing the record. Treat it as ownerless only
      // after the directory itself is stale.
      return decodedLockOwner(null, file);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function lockOwnerIsCurrent(owner) {
  const currentIdentity = processStartIdentity(owner.pid);
  if (!currentIdentity) return false;
  if (owner.status === "identified") {
    return currentIdentity === owner.processStartIdentity;
  }
  return Date.now() - owner.createdAtEpochMs < LEGACY_LOCK_STALE_MS;
}

function reclaimStaleLock(lock) {
  const stat = fs.lstatSync(lock);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DispatchError("builder dispatch lock is unsafe");
  }
  const owner = readLockOwner(lock);
  const ownerHasProcessIdentity = ["identified", "legacy"].includes(
    owner.status,
  );
  const staleOwnerlessLock =
    Date.now() - stat.mtimeMs >= OWNERLESS_LOCK_STALE_MS;
  if (
    (ownerHasProcessIdentity && lockOwnerIsCurrent(owner)) ||
    (!ownerHasProcessIdentity && !staleOwnerlessLock)
  ) {
    return false;
  }
  try {
    if (owner.status !== "missing") fs.unlinkSync(owner.file);
    fs.rmdirSync(lock);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) {
      return false;
    }
    throw error;
  }
}

function releaseLock(lock) {
  const owner = lockOwnerFile(lock);
  try {
    fs.unlinkSync(owner);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.rmdirSync(lock);
}

function removeEmptyLockAfterOwnerWriteFailure(lock) {
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    if (error.code !== "ENOTEMPTY") throw error;
  }
}

function writeLockOwner(lock) {
  try {
    const startIdentity = processStartIdentity(process.pid);
    if (!startIdentity) {
      throw new DispatchError(
        "could not capture builder dispatch lock owner identity",
      );
    }
    writeJsonExclusive(
      lockOwnerFile(lock),
      {
        schemaVersion: 2,
        pid: process.pid,
        createdAtEpochMs: Date.now(),
        processStartIdentity: startIdentity,
      },
      "builder dispatch lock owner",
    );
  } catch (error) {
    removeEmptyLockAfterOwnerWriteFailure(lock);
    throw error;
  }
}

function withLock(root, callback) {
  const lock = path.join(root, ".dispatch.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      writeLockOwner(lock);
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (reclaimStaleLock(lock)) continue;
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
    }
  }
  if (!acquired)
    throw new DispatchError("timed out acquiring builder dispatch lock");
  try {
    return callback();
  } finally {
    releaseLock(lock);
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
  const stateDirectory = layout.keys;
  const signingFile = path.join(stateDirectory, "ed25519-signing.der");
  const publicFile = path.join(stateDirectory, "ed25519-public.der");
  withLock(layout.root, () => {
    let privateKey;
    try {
      privateKey = crypto.createPrivateKey({
        key: fs.readFileSync(signingFile),
        format: "der",
        type: "pkcs8",
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const pair = crypto.generateKeyPairSync("ed25519");
      const descriptor = fs.openSync(signingFile, "wx", 0o600);
      try {
        fs.writeFileSync(
          descriptor,
          pair.privateKey.export({ format: "der", type: "pkcs8" }),
        );
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      privateKey = pair.privateKey;
    }
    const expectedPublic = crypto
      .createPublicKey(privateKey)
      .export({ format: "der", type: "spki" });
    try {
      const actualPublic = fs.readFileSync(publicFile);
      if (!crypto.timingSafeEqual(actualPublic, expectedPublic))
        throw new DispatchError(
          "builder dispatch public key does not match signing key",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const descriptor = fs.openSync(publicFile, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, expectedPublic);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  });
  assertRegularFile(signingFile, "builder dispatch signing key");
  assertRegularFile(publicFile, "builder dispatch public key");
  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(signingFile),
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
  const canonicalOrigin = normalizeOrigin(origin);
  // A remote identifies one repository across independent clones. The common
  // Git directory only identifies related local worktrees, so use it only for
  // disconnected repositories.
  return sha256(
    canonicalString(
      canonicalOrigin
        ? { origin: canonicalOrigin, common: null }
        : { origin: null, common },
    ),
  );
}

function normalizeOrigin(origin) {
  let value = origin.trim();
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.endsWith(".git")) value = value.slice(0, -4);
  if (!value) return null;
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      const repository = parsed.pathname.replace(/^\/+/, "");
      if (parsed.hostname && repository) {
        return `${parsed.hostname.toLowerCase()}/${repository}`;
      }
    } catch {
      return value;
    }
  }
  const separator = value.indexOf(":");
  if (separator < 1) return value;
  const host = value.slice(0, separator).split("@").at(-1);
  const repository = value.slice(separator + 1);
  if (!host || !repository) return value;
  return `${host.toLowerCase()}/${repository}`;
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
      "taskReference",
      "taskReferenceSha256",
      "caller",
      "phase",
      "policyVersion",
      "policySha256",
      "createdAt",
      "budget",
      "attempts",
    ]) &&
    campaign.schemaVersion === 2 &&
    campaign.kind === "builder-dispatch-campaign/v2" &&
    /^[a-f0-9]{64}$/.test(campaign.id) &&
    /^[a-f0-9]{64}$/.test(campaign.repositoryIdentity) &&
    typeof campaign.taskReference === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$/.test(campaign.taskReference) &&
    /^[a-f0-9]{64}$/.test(campaign.taskReferenceSha256) &&
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
    (attempt.retryOf === null ||
      /^[a-f0-9]{64}$/.test(attempt.retryOf || "")) &&
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

function assertReceiptOutputDirectory(file) {
  const directory = path.dirname(file);
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new DispatchError("receipt output directory does not exist");
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DispatchError(
      "receipt output directory must be a real directory",
    );
  }
}

function writeOutputReceipt(file, envelope) {
  assertReceiptOutputDirectory(file);
  const payload = `${JSON.stringify(envelope, null, 2)}\n`;
  try {
    fs.writeFileSync(file, payload, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readJson(file, "receipt output");
    if (canonicalString(existing) === canonicalString(envelope)) return;
    throw new DispatchError("receipt output already exists");
  }
}

function rollbackReservation(layout, campaignId, attemptId, envelope) {
  withLock(layout.root, () => {
    const campaign = readCampaign(layout, campaignId);
    const attempt = campaign?.attempts[attemptId];
    if (
      !attempt ||
      attempt.status !== "reserved" ||
      canonicalString(attempt.receipt) !== canonicalString(envelope)
    ) {
      return;
    }
    campaign.budget.reservedSeconds -= attempt.reservedSeconds;
    delete campaign.attempts[attemptId];
    writeJsonAtomically(campaignFile(layout, campaignId), campaign);
  });
}

function create(input) {
  const layout = stateLayout(input.stateDir);
  assertReceiptOutputDirectory(input.receipt);
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
  const promptSha256 = plan.executionBinding.promptSha256;
  const reference = taskReference(input.taskId);
  const policySha256 = policyDigest();
  const repository = repositoryIdentity(target);
  const taskReferenceSha256 = sha256(
    canonicalString({
      schemaVersion: 1,
      kind: "builder-dispatch-task/v1",
      repository,
      caller: plan.caller,
      phase: plan.phase,
      reference,
    }),
  );
  const campaignId = sha256(
    canonicalString({
      schemaVersion: 2,
      kind: "builder-dispatch-campaign/v2",
      repository,
      taskReferenceSha256,
      caller: plan.caller,
      phase: plan.phase,
      policyVersion: plan.policyVersion,
      policySha256,
    }),
  );
  const planSha256 = sha256(canonicalString(plan));
  let envelope;
  let attemptId;
  let createdReservation = false;
  withLock(layout.root, () => {
    let campaign = readCampaign(layout, campaignId);
    if (!campaign) {
      campaign = {
        schemaVersion: 2,
        kind: "builder-dispatch-campaign/v2",
        id: campaignId,
        repositoryIdentity: repository,
        taskReference: reference,
        taskReferenceSha256,
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
    const matchingAttempts = Object.entries(campaign.attempts).filter(
      ([, attempt]) =>
        attempt.targetHead === plan.executionBinding.targetHead &&
        attempt.planSha256 === planSha256,
    );
    const reservedAttempt = matchingAttempts.find(
      ([, attempt]) => attempt.status === "reserved",
    );
    if (reservedAttempt) {
      const [reservedAttemptId, existing] = reservedAttempt;
      const existingEnvelope = existing.receipt;
      const payload = verifyEnvelope(existingEnvelope, keys.publicKey);
      if (
        !receiptPayloadValid(payload) ||
        payload.issuer.publicKeyFingerprint !== keys.fingerprint ||
        payload.attempt.id !== reservedAttemptId ||
        payload.attempt.planSha256 !== planSha256
      ) {
        throw new DispatchError(
          "builder dispatch authoritative receipt is malformed",
        );
      }
      envelope = existingEnvelope;
      return;
    }
    const completedAttempt = matchingAttempts.find(
      ([, attempt]) => attempt.outcome === "completed",
    );
    if (completedAttempt) {
      throw new DispatchError("builder dispatch attempt is already terminal");
    }
    if (matchingAttempts.length > MAX_RETRIES_PER_PLAN) {
      throw new DispatchError("builder dispatch retry capacity is exhausted");
    }
    const retryOf =
      matchingAttempts.length === 0 ? null : matchingAttempts[0][0];
    attemptId = sha256(
      canonicalString({
        schemaVersion: 2,
        campaignId,
        targetHead: plan.executionBinding.targetHead,
        planSha256,
        retryOf,
      }),
    );
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
        taskReference: campaign.taskReference,
        taskReferenceSha256: campaign.taskReferenceSha256,
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
        promptSha256,
        planSha256,
        retryOf,
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
      promptSha256,
      retryOf,
      reservedSeconds,
      receipt: envelope,
    };
    campaign.budget.reservedSeconds += reservedSeconds;
    writeJsonAtomically(campaignFile(layout, campaignId), campaign);
    createdReservation = true;
  });
  try {
    writeOutputReceipt(input.receipt, envelope);
  } catch (error) {
    if (createdReservation) {
      rollbackReservation(layout, campaignId, attemptId, envelope);
    }
    throw error;
  }
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
    payload.campaign.taskReference !== campaign.taskReference ||
    payload.campaign.taskReferenceSha256 !== campaign.taskReferenceSha256 ||
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

function launch(input) {
  const verified = verifiedReceipt(input);
  const launchId = crypto.randomBytes(32).toString("hex");
  withLock(verified.layout.root, () => {
    const campaign = readCampaign(
      verified.layout,
      verified.payload.campaign.id,
    );
    const attempt = campaign?.attempts[verified.payload.attempt.id];
    assertReceiptMatchesLedger(verified.payload, campaign, attempt, true);
    attempt.status = "launched";
    attempt.launchId = launchId;
    attempt.launchedAt = new Date().toISOString();
    writeJsonAtomically(campaignFile(verified.layout, campaign.id), campaign);
  });
  return {
    plan: verified.payload.plan,
    reservedSeconds: verified.payload.attempt.reservedSeconds,
    builderDispatch: {
      campaignId: verified.payload.campaign.id,
      attemptId: verified.payload.attempt.id,
      launchId,
    },
  };
}

function settle(input) {
  // Settlement happens after a workspace-write handoff, so the target is
  // intentionally no longer clean. The immutable receipt and run record bind
  // the settled attempt; launch-time prompt and target validation already ran.
  const verified = verifiedReceipt(input, {
    requireReserved: false,
    validatePlan: false,
  });
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
  if (
    record.builderDispatch?.campaignId !== verified.payload.campaign.id ||
    record.builderDispatch?.attemptId !== verified.payload.attempt.id ||
    (verified.attempt.status === "launched" &&
      record.builderDispatch?.launchId !== verified.attempt.launchId)
  ) {
    throw new DispatchError(
      "builder dispatch run record is not bound to the receipt attempt",
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
    if (!attempt || !["reserved", "launched"].includes(attempt.status)) {
      throw new DispatchError("builder dispatch attempt is already terminal");
    }
    if (
      attempt.status === "launched" &&
      record.builderDispatch?.launchId !== attempt.launchId
    ) {
      throw new DispatchError(
        "builder dispatch run record is not bound to the launched attempt",
      );
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
    taskId: options["task-id"],
  };
  const result =
    command === "create"
      ? create(input)
      : command === "verify"
        ? verify(input)
        : command === "reservation"
          ? reservation(input)
          : command === "launch"
            ? launch(input)
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
  launch,
  settle,
  stateDirectory,
};
