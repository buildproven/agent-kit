"use strict";

// Host-side registration for an existing campaign. This module creates no
// campaign, grants no retry and does not reset any execution budget.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const quality = require("./quality-invocation");
const { atomicCreate } = require("./quality-manifest-io");
const { parseStopAt } = require("./quality-run");
const ownership = require("./quality-runner-ownership");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function privateOwnerPath(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error(
      directory
        ? "wake state requires a private owner directory"
        : "wake registration requires a private owner file",
    );
  }
}

function controllerIdentity(requestedRoot) {
  const root = fs.realpathSync(requestedRoot);
  if (fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error("controller must be a repository root");
  }
  if (git(root, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error(
      "controller must be clean before wake registration or execution",
    );
  }
  for (const file of ["scripts/quality-run.js", "package-lock.json"]) {
    git(root, ["ls-files", "--error-unmatch", "--", file]);
    if (!fs.lstatSync(path.join(root, file)).isFile()) {
      throw new Error(
        `controller input must be a regular tracked file: ${file}`,
      );
    }
  }
  return {
    root,
    head: git(root, ["rev-parse", "HEAD"]),
    node: fs.realpathSync(process.execPath),
    nodeVersion: process.version,
    lockSha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, "package-lock.json")))
      .digest("hex"),
  };
}

function readRegistration(file) {
  privateOwnerPath(path.dirname(file), true);
  privateOwnerPath(file);
  return quality.parseJson(
    fs.readFileSync(file, "utf8"),
    "quality wake registration",
  );
}

function registerQuality(options, defaultStateDirectory) {
  if (!options.manifest || !options["stop-at"]) {
    throw new Error("register-quality requires --manifest and --stop-at");
  }
  const stopAt = parseStopAt(options["stop-at"]);
  const { manifest, manifestPath } = quality.loadManifest(options.manifest);
  quality.validateIdentity(manifest, manifest.repo.realpath);
  const createdAt = Date.parse(manifest.createdAt);
  const ttl = manifest.governor.lifecycleTTLSeconds * 1000;
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(ttl) ||
    ttl <= 0 ||
    stopAt <= createdAt ||
    stopAt > createdAt + ttl
  ) {
    throw new Error("wake deadline must fit the original lifecycle allowance");
  }
  const controller = controllerIdentity(
    options.controller || path.resolve(__dirname, ".."),
  );
  const requestedDirectory = path.resolve(
    options["state-dir"] || defaultStateDirectory,
  );
  fs.mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
  privateOwnerPath(requestedDirectory, true);
  const directory = fs.realpathSync(requestedDirectory);
  for (const root of [manifest.repo.realpath, controller.root]) {
    const relative = path.relative(root, directory);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    ) {
      throw new Error(
        "wake registration must be outside target and controller repositories",
      );
    }
  }
  const record = {
    schemaVersion: 1,
    manifestPath,
    invocationId: manifest.invocationId,
    repoKey: manifest.repo.key,
    target: manifest.repo.realpath,
    createdAt: manifest.createdAt,
    stopAt: new Date(stopAt).toISOString(),
    controller,
  };
  const id = crypto
    .createHash("sha256")
    .update(`${record.repoKey}\0${record.invocationId}`)
    .digest("hex");
  const registrationPath = path.join(directory, `${id}.json`);
  const created = atomicCreate(registrationPath, record);
  if (
    !created &&
    !isDeepStrictEqual(readRegistration(registrationPath), record)
  ) {
    throw new Error(
      "wake registration already binds different inputs; no deadline or identity change allowed",
    );
  }
  return {
    status: created ? "registered" : "already-registered",
    registrationPath,
  };
}

function validatedWake(file) {
  const registration = readRegistration(file);
  if (
    registration.schemaVersion !== 1 ||
    !registration.controller ||
    typeof registration.manifestPath !== "string"
  ) {
    throw new Error("unsupported or incomplete wake registration");
  }
  const stopAt = parseStopAt(registration.stopAt);
  if (stopAt === null)
    throw new Error("wake registration is missing its deadline");
  if (
    !isDeepStrictEqual(
      controllerIdentity(registration.controller.root),
      registration.controller,
    )
  ) {
    throw new Error("controller no longer matches wake registration");
  }
  const { manifest, manifestPath } = quality.loadManifest(
    registration.manifestPath,
  );
  if (
    manifestPath !== registration.manifestPath ||
    manifest.invocationId !== registration.invocationId ||
    manifest.repo.key !== registration.repoKey ||
    manifest.repo.realpath !== registration.target ||
    manifest.createdAt !== registration.createdAt
  ) {
    throw new Error("campaign no longer matches wake registration");
  }
  quality.validateIdentity(manifest, manifest.repo.realpath, {
    requireHead: false,
  });
  return { registration, manifest, stopAt };
}

function ownerReadiness(observed, activeExecution) {
  if (!observed) return { status: "blocked", reason: "owner-unverifiable" };
  const owner = observed.record;
  if (owner.hostname !== os.hostname())
    return { status: "blocked", reason: "owner-host-mismatch" };
  if (!ownership.processAbsent(owner.pid))
    return { status: "busy", reason: "runner-live" };
  if (owner.schemaVersion !== 2)
    return { status: "blocked", reason: "legacy-owner" };
  if (owner.child) {
    if (
      !ownership.processAbsent(owner.child.pid) ||
      !ownership.processGroupAbsent(owner.child.processGroupId)
    ) {
      return { status: "busy", reason: "child-live-or-unverifiable" };
    }
  } else if (owner.childInFlight || activeExecution) {
    return { status: "blocked", reason: "child-identity-missing" };
  }
  if (activeExecution) {
    if (
      !Number.isFinite(Date.parse(activeExecution.startedAt)) ||
      !Number.isFinite(activeExecution.timeoutSeconds) ||
      activeExecution.timeoutSeconds <= 0
    ) {
      return { status: "blocked", reason: "execution-deadline-invalid" };
    }
    if (!quality.hasAbandonedExecution({ governor: { activeExecution } }))
      return { status: "busy", reason: "execution-deadline-pending" };
  }
  return null;
}

async function reconcileQuality(options) {
  if (!options.registration)
    throw new Error("reconcile-quality requires --registration");
  const file = path.resolve(options.registration);
  const snapshot = validatedWake(file);
  const { registration, manifest, stopAt } = snapshot;
  const manifestPath = registration.manifestPath;
  const identity = {
    schemaVersion: 1,
    invocationId: registration.invocationId,
    repoKey: registration.repoKey,
    manifestPath,
    head: manifest.revisions.currentHead,
  };
  if (Date.now() >= stopAt)
    return { ...identity, status: "blocked", reason: "stop-at-expired" };
  if (
    manifest.terminalState &&
    manifest.terminalState.state !== "interrupted"
  ) {
    return {
      ...identity,
      status: "paused",
      reason: "campaign-terminal",
      state: manifest.terminalState.state,
    };
  }
  if (
    manifest.orchestration?.head === identity.head &&
    manifest.orchestration.status === "work-required"
  ) {
    return { ...identity, status: "paused", reason: "work-required" };
  }
  const ownerFile = `${manifestPath}.runner-lock`;
  const observed = ownership.readOwner(ownerFile);
  if (observed || fs.existsSync(ownerFile)) {
    const notReady = ownerReadiness(
      observed,
      manifest.governor.activeExecution,
    );
    if (notReady) return { ...identity, ...notReady };
  } else if (manifest.governor.activeExecution) {
    return {
      ...identity,
      status: "blocked",
      reason: "active-execution-owner-missing",
    };
  }
  // Dispatch must run inside the pinned host controller. Do not dynamically
  // load executable code selected by registration data or candidate files.
  if (
    fs.realpathSync(path.resolve(__dirname, "..")) !==
    registration.controller.root
  ) {
    throw new Error(
      "invoke reconcile-quality using the registered controller runtime",
    );
  }
  const controllerQuality = quality;
  const controllerRunner = require("./quality-run");
  const controllerOwnership = ownership;
  if (observed) {
    controllerRunner.pinRepositoryLease(manifest);
    if (manifest.governor.activeExecution)
      controllerQuality.advanceManifest(manifestPath);
    const current = validatedWake(file);
    const currentOwner = ownership.readOwner(ownerFile);
    if (Date.now() >= stopAt)
      return { ...identity, status: "blocked", reason: "stop-at-expired" };
    if (
      !isDeepStrictEqual(current.registration, registration) ||
      current.manifest.revisions.currentHead !== identity.head ||
      current.manifest.governor.activeExecution ||
      !currentOwner ||
      currentOwner.stat.ino !== observed.stat.ino ||
      currentOwner.stat.dev !== observed.stat.dev ||
      !isDeepStrictEqual(currentOwner.record, observed.record) ||
      ownerReadiness(currentOwner, null)
    ) {
      return {
        ...identity,
        status: "busy",
        reason: "recovery-observation-changed",
      };
    }
    controllerOwnership.reconcileRunner({
      manifestPath,
      expectedHead: identity.head,
      expectedHost: observed.record.hostname,
      expectedPid: observed.record.pid,
      expectedNonce: observed.record.nonce,
    });
  }
  const result = await controllerRunner.runManifest(manifestPath, { stopAt });
  const completed = validatedWake(file);
  const final = completed.manifest;
  if (
    !isDeepStrictEqual(completed.registration, registration) ||
    result.head !== final.revisions.currentHead ||
    final.invocationId !== identity.invocationId
  ) {
    throw new Error("wake result does not match the final campaign identity");
  }
  if (
    result.status === "complete" &&
    (!["merged", "verified-unmerged"].includes(result.state) ||
      final.terminalState?.state !== result.state ||
      final.terminalState.head !== result.head)
  ) {
    throw new Error(
      "wake completion lacks a matching terminal campaign record",
    );
  }
  return { ...identity, ...result };
}

module.exports = {
  registerQuality,
  reconcileQuality,
  readRegistration,
  controllerIdentity,
};
