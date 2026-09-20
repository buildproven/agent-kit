#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const SCHEMA_VERSION = 1;
const PR_SCOPE = "pull-request-v2";
const PROTOCOL_VERSION = 2;
const STALE_MS = 6 * 60 * 60 * 1000;
const RECOVERY_OVERRIDE_ENV = "BS_QUALITY_LEASE_RECOVERY_OVERRIDE";
const DEFAULT_WAIT_MS = 30_000;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const heldMetadataGuards = new Map();

// One builder for every operator recovery invocation. Three hand-written
// copies of this command used to exist, each interpolating whichever manifest
// the surrounding function happened to have loaded. That is what made BUI-910
// expensive: the two manifests play opposite roles, and a copy that reads
// `loaded.manifestPath` is only correct when `loaded` happens to be the
// successor. Naming both parameters forces the caller to say which is which.
//
// successorManifestPath — the campaign that should own the lease NEXT.
// displacedOwner        — the record of the campaign being taken from.
function recoveryInvocation(subcommand, successorManifestPath, displacedOwner) {
  if (!successorManifestPath) {
    throw new Error("recovery invocation requires the successor manifest path");
  }
  if (!displacedOwner?.invocationId || displacedOwner.pr === undefined) {
    throw new Error("recovery invocation requires the displaced owner record");
  }
  return (
    `node quality-repo-lease.js ${subcommand} ` +
    `--manifest ${successorManifestPath} ` +
    `--confirm-owner-invocation-id ${displacedOwner.invocationId} ` +
    `--confirm-owner-pr ${displacedOwner.pr}`
  );
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(SLEEP_BUFFER), 0, 0, milliseconds);
}

function accountHome() {
  const user = os.userInfo();
  if (
    !user ||
    user.uid !== process.geteuid?.() ||
    !path.isAbsolute(user.homedir)
  ) {
    throw new Error(
      "repository lease requires a canonical effective-UID account home",
    );
  }
  return fs.realpathSync(user.homedir);
}

function stateRoot() {
  const root = path.join(
    accountHome(),
    ".local",
    "state",
    "claude-kit",
    "repository-leases",
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("repository lease state root must be a real directory");
  }
  if (stat.uid !== process.geteuid?.()) {
    throw new Error("repository lease state root has the wrong owner");
  }
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

function repositoryIdentity(manifest) {
  const identity = manifest.repo?.githubRepository;
  if (typeof identity !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(identity)) {
    throw new Error(
      "repository lease requires a protected GitHub repository identity",
    );
  }
  return identity.toLowerCase();
}

function recordedGitCommonDir(manifest) {
  const recorded = manifest.repo?.gitCommonDir;
  if (typeof recorded !== "string" || !path.isAbsolute(recorded)) {
    throw new Error(
      "repository lease requires the recorded canonical Git common directory",
    );
  }
  const canonical = fs.realpathSync(recorded);
  const stat = fs.lstatSync(canonical);
  if (canonical !== recorded || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      "repository lease Git common directory must be a real canonical directory",
    );
  }
  return canonical;
}

function isVitestFixture(manifest) {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.VITEST !== "true" ||
    !process.env.VITEST_WORKER_ID ||
    !/^vitest\/[a-f0-9]{16,64}$/.test(repositoryIdentity(manifest))
  ) {
    return false;
  }
  const gitCommonDir = recordedGitCommonDir(manifest);
  const temporaryRoot = `${fs.realpathSync(os.tmpdir())}${path.sep}`;
  if (!gitCommonDir.startsWith(temporaryRoot)) return false;
  const sentinel = path.join(gitCommonDir, ".quality-vitest-fixture");
  try {
    return (
      readRegularFile(sentinel, "quality Vitest fixture sentinel").trim() ===
      manifest.repo.key
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function repositoryKey(identity) {
  return crypto.createHash("sha256").update(identity).digest("hex");
}

// A pre-v2 campaign stored its exact credential in the repository-wide lease.
// During rollout it must keep using that lease for every operation, not merely
// acquire().  A positive PR number alone is not sufficient to select the
// legacy namespace: require the durable credential and every stable owner
// field to match before treating it as the active legacy owner.
function activeLegacyCredentialMatches(manifest, legacyLease, identity) {
  const credential = manifest?.merge?.repositoryLease;
  if (
    !credential ||
    credential.scope !== undefined ||
    typeof credential.token !== "string" ||
    !Number.isSafeInteger(credential.generation) ||
    !fs.existsSync(legacyLease)
  ) {
    return false;
  }
  let record;
  try {
    record = readOwnershipRecord(legacyLease, "legacy repository lease owner");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return (
    record.schemaVersion === SCHEMA_VERSION &&
    record.scope === undefined &&
    record.disposition === "active" &&
    record.repository === identity &&
    record.invocationId === manifest.invocationId &&
    record.gitCommonDir === recordedGitCommonDir(manifest) &&
    record.pr === manifest.repo?.pr &&
    record.headRef === manifest.repo?.headRefName &&
    record.token === credential.token &&
    record.generation === credential.generation
  );
}

function pathsFor(identity, manifest = null) {
  const root =
    manifest && isVitestFixture(manifest)
      ? path.join(
          recordedGitCommonDir(manifest),
          "quality-test-repository-leases",
        )
      : stateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = repositoryKey(identity);
  const credential = manifest?.merge?.repositoryLease;
  if (credential?.scope !== undefined && credential.scope !== PR_SCOPE) {
    throw new Error("unsupported campaign ownership scope");
  }
  const pr = manifest?.repo?.pr;
  const legacyLease = path.join(root, `${key}.lease`);
  const activeLegacy =
    manifest && activeLegacyCredentialMatches(manifest, legacyLease, identity);
  const scoped =
    Number.isSafeInteger(pr) &&
    pr > 0 &&
    (!credential || credential.scope === PR_SCOPE) &&
    !activeLegacy;
  return {
    root,
    key,
    lease: scoped ? path.join(root, `${key}.pr-${pr}.lease`) : legacyLease,
    legacyLease,
    scope: scoped ? PR_SCOPE : null,
    metadataGuard: path.join(
      root,
      scoped ? `${key}.pr-${pr}.metadata-guard` : `${key}.metadata-guard`,
    ),
    repositoryMetadataGuard: path.join(root, `${key}.metadata-guard`),
    mergeGuard: path.join(root, `${key}.merge-guard`),
  };
}

function relatedMergeGuard(paths, record) {
  if (!fs.existsSync(paths.mergeGuard)) return null;
  const owner = guardOwner(paths.mergeGuard);
  if (owner.repository !== record.repository || owner.pr !== record.pr)
    return null;
  if (owner.token !== record.token || owner.head !== record.mergeIntent?.head) {
    throw new Error("merge operation guard does not match this exact campaign");
  }
  return owner;
}

// Called only during acquisition under the existing repository metadata guard.
// The schema-v2 marker deliberately makes supported schema-v1 writers refuse
// before their legacy orphan/released cleanup can touch another PR's guard.
function prepareOwnershipProtocol(paths, loaded, tuple) {
  const credential = loaded.manifest.merge?.repositoryLease;
  if (!Number.isSafeInteger(tuple.pr) || tuple.pr <= 0) {
    throw new Error("PR-scoped ownership requires a positive PR number");
  }
  if (fs.existsSync(paths.legacyLease)) {
    const record = readOwnershipRecord(
      paths.legacyLease,
      "repository ownership protocol",
    );
    if (record.schemaVersion === SCHEMA_VERSION) {
      if (record.disposition !== "released") {
        if (
          !credential?.scope &&
          tupleMatches(record, tuple) &&
          credential?.token === record.token
        ) {
          paths.lease = paths.legacyLease;
          paths.scope = null;
          return;
        }
        const error = new Error(
          `legacy repository ownership must drain before PR admission: PR #${record.pr} (${record.manifestPath})`,
        );
        error.code = "LEASE_OWNED";
        throw error;
      }
      if (fs.existsSync(paths.mergeGuard)) {
        throw new Error(
          "legacy merge outcome must be reconciled before ownership activation",
        );
      }
      if (
        record.releaseReason === "verified-remote-merged" &&
        fs.existsSync(record.manifestPath)
      ) {
        recordMergedTerminalRaw(record.manifestPath);
      }
      exactCleanup(tombstone(paths.legacyLease));
    } else if (
      record.schemaVersion !== PROTOCOL_VERSION ||
      record.scope !== PR_SCOPE ||
      record.repository !== tuple.repository
    ) {
      throw new Error(
        "unsupported or inconsistent repository ownership protocol",
      );
    }
  }
  if (!fs.existsSync(paths.legacyLease)) {
    if (fs.existsSync(paths.mergeGuard))
      throw new Error(
        "merge outcome must be reconciled before ownership activation",
      );
    // Stage the complete marker before atomically publishing the directory.
    // A crash leaves only an inert uniquely named staging directory; readers
    // never mistake an incomplete marker for a missing ownership record.
    const stage = fs.mkdtempSync(
      path.join(paths.root, `${paths.key}.protocol-stage-`),
    );
    atomicWrite(path.join(stage, "owner.json"), {
      schemaVersion: PROTOCOL_VERSION,
      scope: PR_SCOPE,
      repository: tuple.repository,
      activatedAt: new Date().toISOString(),
    });
    fs.renameSync(stage, paths.legacyLease);
  }
  paths.scope = PR_SCOPE;
  paths.lease = path.join(paths.root, `${paths.key}.pr-${tuple.pr}.lease`);
}

function rollbackProtocol(manifestPath) {
  const { manifest } = loadManifest(manifestPath);
  return withOwnershipTransaction(manifest, (paths, identity) => {
    const marker = readOwnershipRecord(
      paths.legacyLease,
      "repository ownership protocol",
    );
    if (
      marker.schemaVersion !== PROTOCOL_VERSION ||
      marker.scope !== PR_SCOPE ||
      marker.repository !== identity
    ) {
      throw new Error("protocol rollback requires the exact PR-scoped marker");
    }
    const entries = fs
      .readdirSync(paths.root)
      .filter(
        (name) =>
          name.startsWith(`${paths.key}.pr-`) &&
          !name.endsWith(".metadata-guard"),
      );
    const released = entries.map((name) => {
      const directory = path.join(paths.root, name);
      const record = leaseRecord(directory);
      if (record.scope !== PR_SCOPE || record.disposition !== "released") {
        throw new Error("protocol rollback requires all PR ownership to drain");
      }
      return directory;
    });
    if (fs.existsSync(paths.mergeGuard)) {
      throw new Error(
        "protocol rollback requires all PR ownership and merge state to drain",
      );
    }
    for (const directory of released) exactCleanup(tombstone(directory));
    exactCleanup(tombstone(paths.legacyLease));
    return { rolledBack: true, repository: identity };
  });
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function readRegularFile(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      // Ignored for a read-only open, but keeps the security contract explicit
      // for static analyzers that treat every openSync call as a possible create.
      0o600,
    );
  } catch (error) {
    // Linux reports ELOOP for O_NOFOLLOW on a symlink; Darwin/BSD may report
    // EMLINK. Both mean the defensive single-descriptor read refused a link.
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      throw new Error(`${label} must be a non-symlink regular file`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(file, label) {
  return parseJson(readRegularFile(file, label), label);
}

function readOwnershipRecord(directory, label) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.geteuid?.()
  ) {
    throw new Error(`${label} must be an owned non-symlink directory`);
  }
  return readJson(path.join(directory, "owner.json"), label);
}

function atomicWrite(file, value) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try {
      removeAtomicTemporary(temporary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error.message}; repository lease temporary cleanup also failed: ${cleanupError.message}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

function removeAtomicTemporary(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("repository lease atomic-write temporary changed");
  }
  fs.unlinkSync(file);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return null;
  }
}

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const identity = result.stdout.trim();
  return identity || null;
}

function sameGuardOwner(current, observed) {
  return (
    current.pid === observed.pid &&
    current.uid === observed.uid &&
    current.nonce === observed.nonce &&
    current.acquiredAt === observed.acquiredAt
  );
}

function removeRecoveryLock(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("repository lease recovery lock changed");
  }
  fs.unlinkSync(file);
}

function recoverDeadGuard(directory, observed) {
  const recoveryLock = `${directory}.recovery-lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(recoveryLock, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        pid: process.pid,
        uid: process.geteuid?.(),
        nonce: crypto.randomBytes(16).toString("hex"),
      })}\n`,
    );
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error.code === "EEXIST") return false;
    throw error;
  }
  fs.closeSync(descriptor);
  try {
    if (!fs.existsSync(directory)) return false;
    let current;
    try {
      current = guardOwner(directory);
    } catch (error) {
      // A competing recovery can remove the directory after existsSync and
      // before the protected read. It won the race; retry acquisition rather
      // than turning that normal transition into a terminal campaign failure.
      if (error.code === "ENOENT" && !fs.existsSync(directory)) return false;
      throw error;
    }
    if (!sameGuardOwner(current, observed)) return false;
    const alive = processAlive(current.pid);
    if (alive !== false) {
      if (
        alive === true &&
        current.processIdentity &&
        processIdentity(current.pid) !== current.processIdentity
      ) {
        // The PID was reused by another process; it is not this guard owner.
      } else {
        return false;
      }
    }
    const released = tombstone(directory);
    exactCleanup(released);
    return true;
  } finally {
    removeRecoveryLock(recoveryLock);
  }
}

function exactCleanup(directory, recordName = "owner.json") {
  const record = path.join(directory, recordName);
  if (fs.existsSync(record)) {
    const stat = fs.lstatSync(record);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing unsafe cleanup in ${directory}`);
    }
    fs.unlinkSync(record);
  }
  fs.rmdirSync(directory);
}

function tombstone(directory) {
  const renamed = `${directory}.released.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.renameSync(directory, renamed);
  return renamed;
}

function guardOwner(directory) {
  return readJson(
    path.join(directory, "owner.json"),
    "repository lease guard owner",
  );
}

function acquireGuard(directory, timeoutMs = DEFAULT_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = guardOwner(directory);
      } catch (ownerError) {
        if (ownerError.code === "ENOENT" && Date.now() < deadline) {
          sleep(50);
          continue;
        }
        throw ownerError;
      }
      const alive = processAlive(owner.pid);
      const reused =
        alive === true &&
        owner.processIdentity &&
        processIdentity(owner.pid) !== owner.processIdentity;
      if ((alive === false || reused) && options.recoverDead !== false) {
        if (recoverDeadGuard(directory, owner)) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `repository lease metadata is busy (pid ${owner.pid})`,
          {
            cause: error,
          },
        );
      }
      sleep(50);
      continue;
    }
    try {
      const writeOwner = options.writeOwner || atomicWrite;
      writeOwner(path.join(directory, "owner.json"), {
        schemaVersion: SCHEMA_VERSION,
        pid: process.pid,
        uid: process.geteuid?.(),
        nonce: crypto.randomBytes(16).toString("hex"),
        processIdentity: processIdentity(process.pid),
        acquiredAt: new Date().toISOString(),
      });
      return;
    } catch (error) {
      exactCleanup(directory);
      throw error;
    }
  }
}

function releaseGuard(directory) {
  const owner = guardOwner(directory);
  if (owner.pid !== process.pid || owner.uid !== process.geteuid?.()) {
    throw new Error("repository lease guard owner changed");
  }
  const released = tombstone(directory);
  exactCleanup(released);
}

function withMetadataGuard(manifest, operation, timeoutMs) {
  const identity = repositoryIdentity(manifest);
  const paths = pathsFor(identity, manifest);
  return withGuardAt(
    paths,
    paths.metadataGuard,
    identity,
    () => {
      if (
        paths.scope === PR_SCOPE &&
        (manifest.merge?.repositoryLease?.scope === PR_SCOPE ||
          fs.existsSync(paths.lease))
      ) {
        if (!fs.existsSync(paths.legacyLease))
          throw new Error(
            "repository ownership protocol marker is missing; restore exact state before resuming",
          );
        const marker = readOwnershipRecord(
          paths.legacyLease,
          "repository ownership protocol",
        );
        if (
          marker.schemaVersion !== PROTOCOL_VERSION ||
          marker.scope !== PR_SCOPE ||
          marker.repository !== identity
        )
          throw new Error(
            "unsupported or inconsistent repository ownership protocol",
          );
      }
      return operation(paths, identity);
    },
    timeoutMs,
  );
}

function withGuardAt(paths, guardPath, identity, operation, timeoutMs) {
  const held = heldMetadataGuards.get(guardPath);
  if (held) {
    if (!sameGuardOwner(guardOwner(guardPath), held))
      throw new Error("metadata guard owner changed during nested transaction");
    return operation(paths, identity);
  }
  acquireGuard(guardPath, timeoutMs);
  try {
    heldMetadataGuards.set(guardPath, guardOwner(guardPath));
    return operation(paths, identity);
  } finally {
    heldMetadataGuards.delete(guardPath);
    releaseGuard(guardPath);
  }
}

function withOwnershipTransaction(manifest, operation, timeoutMs) {
  return withMetadataGuard(
    manifest,
    (paths, identity) =>
      withGuardAt(
        paths,
        paths.repositoryMetadataGuard,
        identity,
        operation,
        timeoutMs,
      ),
    timeoutMs,
  );
}

function hasMetadataGuard(manifest) {
  if (!manifest.repo?.githubRepository) return false;
  const paths = pathsFor(repositoryIdentity(manifest), manifest);
  const held = heldMetadataGuards.get(paths.metadataGuard);
  if (!held) return false;
  return sameGuardOwner(guardOwner(paths.metadataGuard), held);
}

// quality-invocation is loaded by this module and calls these functions while
// repository-lease initialization is still in progress. Publish the narrow
// guard API before the complete export table below replaces module.exports.
module.exports.withMetadataGuard = withMetadataGuard;
module.exports.hasMetadataGuard = hasMetadataGuard;

function loadManifest(manifestPath) {
  return require("./quality-invocation").loadManifest(manifestPath);
}

function ownerTuple(manifest, manifestPath, options = {}) {
  const gitCommonDir = recordedGitCommonDir(manifest);
  if (options.requireWorktree) {
    const repositoryRoot = fs.realpathSync(manifest.repo.realpath);
    const liveGitCommonDir = fs.realpathSync(
      path.resolve(
        repositoryRoot,
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }).trim(),
      ),
    );
    if (liveGitCommonDir !== gitCommonDir) {
      throw new Error("repository lease Git common directory changed");
    }
  }
  return {
    repository: repositoryIdentity(manifest),
    invocationId: manifest.invocationId,
    manifestPath: fs.realpathSync(manifestPath),
    gitCommonDir,
    pr: manifest.repo.pr,
    headRef: manifest.repo.headRefName,
  };
}

function tupleMatches(record, tuple) {
  return [
    "repository",
    "invocationId",
    "manifestPath",
    "gitCommonDir",
    "pr",
    "headRef",
  ].every((key) => record[key] === tuple[key]);
}

function leaseRecord(leaseDirectory) {
  let record;
  try {
    record = readOwnershipRecord(leaseDirectory, "repository lease owner");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "repository merge lease is missing or has already been released",
        { cause: error },
      );
    }
    throw error;
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported repository lease schema ${record.schemaVersion}`,
    );
  }
  if (
    path.basename(leaseDirectory).includes(".pr-") &&
    (record.scope !== PR_SCOPE ||
      !Number.isSafeInteger(record.pr) ||
      record.pr <= 0 ||
      path.basename(leaseDirectory) !==
        `${repositoryKey(record.repository)}.pr-${record.pr}.lease`)
  ) {
    throw new Error("PR ownership record does not match its scoped namespace");
  }
  return record;
}

function orphanedLeaseHasClosedPullRequest(record) {
  if (fs.existsSync(record.manifestPath)) return false;
  const view = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(record.pr),
      "--repo",
      record.repository,
      "--json",
      "state",
    ],
    { cwd: stateRoot(), encoding: "utf8", timeout: 30_000 },
  );
  if (view.status !== 0) {
    throw new Error(
      `orphaned repository lease cannot verify PR closure: ${view.stderr || "gh pr view failed"}`.trim(),
    );
  }
  try {
    return JSON.parse(view.stdout).state === "CLOSED";
  } catch (error) {
    throw new Error("orphaned repository lease returned malformed PR state", {
      cause: error,
    });
  }
}

function setManifestCredentialRaw(manifestPath, credential) {
  const invocation = require("./quality-invocation");
  invocation.withManifestLockRaw(manifestPath, (manifest) => {
    manifest.merge ??= {};
    const previous = manifest.merge.repositoryLease;
    if (previous && previous.scope !== credential.scope) {
      manifest.merge.repositoryLeaseHistory ??= [];
      manifest.merge.repositoryLeaseHistory.push({
        ...previous,
        replacedAt: new Date().toISOString(),
        reason: "ownership-scope-transition",
      });
    }
    manifest.merge.repositoryLease = credential;
  });
}

function completePending(paths, identity, loaded, current) {
  const credential = loaded.manifest.merge?.repositoryLease;
  if (
    credential?.token !== current.token ||
    credential?.generation !== current.generation ||
    credential?.scope !== current.scope
  ) {
    setManifestCredentialRaw(loaded.manifestPath, {
      repository: identity,
      generation: current.generation,
      token: current.token,
      ...(current.scope ? { scope: current.scope } : {}),
    });
  }
  const active = {
    ...current,
    disposition: "active",
    priorToken: undefined,
  };
  atomicWrite(path.join(paths.lease, "owner.json"), active);
  return {
    token: active.token,
    generation: active.generation,
    identity,
  };
}

function acquireOnce(manifestPath, options = {}) {
  const loaded = loadManifest(manifestPath);
  if (loaded.manifest.options?.merge !== true) return null;
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withOwnershipTransaction(
    loaded.manifest,
    (paths, identity) => {
      prepareOwnershipProtocol(paths, loaded, tuple);
      let reuseReleased = false;
      let previousGeneration =
        loaded.manifest.merge?.repositoryLease?.generation || 0;
      if (fs.existsSync(paths.lease)) {
        const current = leaseRecord(paths.lease);
        previousGeneration = Math.max(previousGeneration, current.generation);
        if (current.disposition === "released") {
          const remotelyVerified = String(
            current.releaseReason || "",
          ).startsWith("verified-remote-");
          if (relatedMergeGuard(paths, current)) {
            if (!remotelyVerified) {
              throw new Error(
                "ambiguous merge operation is quarantined; reconcile GitHub before acquiring another repository lease",
              );
            }
          }
          if (
            current.releaseReason === "verified-remote-merged" &&
            fs.existsSync(current.manifestPath)
          ) {
            recordMergedTerminalRaw(current.manifestPath);
          }
          if (relatedMergeGuard(paths, current)) {
            const releasedGuard = tombstone(paths.mergeGuard);
            exactCleanup(releasedGuard);
          }
          if (paths.scope === PR_SCOPE) reuseReleased = true;
          else exactCleanup(tombstone(paths.lease));
        } else {
          if (
            current.disposition === "active" &&
            orphanedLeaseHasClosedPullRequest(current)
          ) {
            if (relatedMergeGuard(paths, current)) {
              throw new Error(
                "orphaned merge outcome remains quarantined; reconcile exact remote outcome first",
              );
            }
            if (paths.scope === PR_SCOPE) reuseReleased = true;
            else exactCleanup(tombstone(paths.lease));
          } else {
            const credential = loaded.manifest.merge?.repositoryLease;
            if (
              current.disposition === "rotation-pending" &&
              current.priorToken == null &&
              tupleMatches(current, tuple)
            ) {
              return completePending(paths, identity, loaded, current);
            }
            if (
              current.disposition === "active" &&
              tupleMatches(current, tuple) &&
              credential?.token === current.token &&
              credential?.generation === current.generation
            ) {
              current.renewedAt = new Date().toISOString();
              atomicWrite(path.join(paths.lease, "owner.json"), current);
              return {
                token: current.token,
                generation: current.generation,
                identity,
              };
            }
            // Print the command, not just the blocker. "recover or resume
            // that exact campaign" reads as an instruction to point recovery
            // AT the named campaign, which is the wrong --manifest and
            // silently transfers the lease to itself. worktree-manager.js
            // emits its literal unlock invocation and that worked first try
            // every time; this now does the same (BUI-910).
            const error = new Error(
              `repository merge lease is owned by ${current.repository} ` +
                `PR #${current.pr} (${current.manifestPath}).\n` +
                `  Resume that campaign, or take the lease for THIS one:\n` +
                `    ${recoveryInvocation("recover", tuple.manifestPath, current)}\n` +
                `  --manifest names the campaign that should own the lease ` +
                `NEXT; --confirm-owner-* names the one being displaced.\n` +
                `  Add --override true --reason "..." with ` +
                `${RECOVERY_OVERRIDE_ENV}=1 if the owner is still recent.`,
            );
            error.code = "LEASE_OWNED";
            throw error;
          }
        }
      }
      if (
        !reuseReleased &&
        loaded.manifest.merge?.repositoryLease?.scope === PR_SCOPE
      ) {
        throw new Error(
          "scoped ownership record is missing; refusing token-only recreation",
        );
      }
      if (!reuseReleased) fs.mkdirSync(paths.lease, { mode: 0o700 });
      const token = crypto.randomBytes(32).toString("hex");
      const now = new Date().toISOString();
      const pending = {
        schemaVersion: SCHEMA_VERSION,
        ...(paths.scope ? { scope: paths.scope } : {}),
        ...tuple,
        disposition: "rotation-pending",
        generation: previousGeneration + 1,
        token,
        priorToken: null,
        acquiredAt: now,
        renewedAt: now,
      };
      atomicWrite(path.join(paths.lease, "owner.json"), pending);
      try {
        return completePending(paths, identity, loaded, pending);
      } catch (error) {
        throw new Error(
          `repository lease acquisition is pending repair: ${error.message}`,
          { cause: error },
        );
      }
    },
    options.timeoutMs,
  );
}

function acquire(manifestPath, options = {}) {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > DEFAULT_WAIT_MS) {
    throw new Error(`waitMs must be an integer from 0 to ${DEFAULT_WAIT_MS}`);
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquireOnce(manifestPath, options);
    } catch (error) {
      if (error.code !== "LEASE_OWNED" || Date.now() >= deadline) throw error;
      sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    }
  }
}

function verifyUnderMetadata(manifestPath, presentedToken, options = {}) {
  if (!presentedToken)
    throw new Error("repository lease credential is required");
  const loaded = loadManifest(manifestPath);
  if (loaded.manifest.options?.merge !== true) return null;
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withMetadataGuard(
    loaded.manifest,
    (paths) => {
      const record = leaseRecord(paths.lease);
      const credential = loaded.manifest.merge?.repositoryLease;
      if (
        record.disposition !== "active" ||
        !tupleMatches(record, tuple) ||
        record.token !== presentedToken ||
        credential?.token !== presentedToken ||
        credential?.generation !== record.generation
      ) {
        throw new Error(
          "repository merge lease credential is stale or does not own this campaign",
        );
      }
      if (options.renew !== false) {
        record.renewedAt = new Date().toISOString();
        atomicWrite(path.join(paths.lease, "owner.json"), record);
      }
      return record;
    },
    options.timeoutMs,
  );
}

function verify(manifestPath, presentedToken, options = {}) {
  return verifyUnderMetadata(manifestPath, presentedToken, options);
}

function recover(manifestPath, ownerToken, options = {}) {
  const loaded = loadManifest(manifestPath);
  if (loaded.manifest.options?.merge !== true) {
    throw new Error("repository lease recovery requires a merge campaign");
  }
  const nextTuple = ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withOwnershipTransaction(loaded.manifest, (paths, identity) => {
    const current = leaseRecord(paths.lease);
    if (current.disposition === "released")
      throw new Error(
        "repository lease is released; use acquire for a new ownership generation",
      );
    if (relatedMergeGuard(paths, current)) {
      throw new Error(
        "ambiguous merge operation is quarantined; reconcile GitHub before recovery",
      );
    }
    if (current.disposition === "rotation-pending") {
      if (
        !tupleMatches(current, nextTuple) ||
        ![current.token, current.priorToken].includes(ownerToken)
      ) {
        throw new Error(
          "explicit recovery token does not match the pending rotation",
        );
      }
      return completePending(paths, identity, loaded, current);
    }
    if (current.token !== ownerToken) {
      throw new Error(
        "explicit recovery token does not match the current owner",
      );
    }
    const renewedAt = Date.parse(current.renewedAt || "");
    const ageMs = Number.isFinite(renewedAt) ? Date.now() - renewedAt : null;
    const override = options.override === true;
    if (override && process.env[RECOVERY_OVERRIDE_ENV] !== "1") {
      throw new Error(
        `lease recovery override requires ${RECOVERY_OVERRIDE_ENV}=1`,
      );
    }
    if (override && !String(options.reason || "").trim()) {
      throw new Error("lease recovery override requires an explicit reason");
    }
    if (
      !Number.isFinite(renewedAt) ||
      (ageMs !== null && ageMs < STALE_MS && !override)
    ) {
      throw new Error("repository lease owner is recent; recovery is refused");
    }
    const token = crypto.randomBytes(32).toString("hex");
    const generation = current.generation + 1;
    const recoveryReason = override
      ? String(options.reason).trim().slice(0, 500)
      : undefined;
    const pending = {
      ...current,
      ...nextTuple,
      disposition: "rotation-pending",
      priorToken: current.token,
      token,
      generation,
      renewedAt: new Date().toISOString(),
      recoveryReason,
    };
    atomicWrite(path.join(paths.lease, "owner.json"), pending);
    return completePending(paths, identity, loaded, pending);
  });
}

function withManifestMutation(
  manifestPath,
  presentedToken,
  mutation,
  options = {},
) {
  const loaded = loadManifest(manifestPath);
  if (loaded.manifest.options?.merge !== true) {
    return require("./quality-invocation").withManifestLockRaw(
      manifestPath,
      mutation,
    );
  }
  if (!presentedToken)
    throw new Error(
      "repository lease credential is required for manifest mutation",
    );
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withMetadataGuard(loaded.manifest, (paths) => {
    const record = leaseRecord(paths.lease);
    if (
      record.disposition !== "active" ||
      !tupleMatches(record, tuple) ||
      record.token !== presentedToken
    ) {
      throw new Error(
        "repository merge lease credential is stale at manifest mutation",
      );
    }
    if (
      options.requireIdle &&
      (relatedMergeGuard(paths, record) || record.mergeIntent)
    ) {
      throw new Error(
        "merge recovery requires an idle repository with no merge operation",
      );
    }
    return require("./quality-invocation").withManifestLockRaw(
      manifestPath,
      (manifest) => {
        const credential = manifest.merge?.repositoryLease;
        if (
          credential?.token !== presentedToken ||
          credential?.generation !== record.generation
        ) {
          throw new Error("repository merge lease manifest credential changed");
        }
        const result = mutation(manifest, manifestPath);
        record.renewedAt = new Date().toISOString();
        atomicWrite(path.join(paths.lease, "owner.json"), record);
        return result;
      },
    );
  });
}

function release(manifestPath, presentedToken, reason = "completed") {
  const loaded = loadManifest(manifestPath);
  if (loaded.manifest.options?.merge !== true) return false;
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withOwnershipTransaction(loaded.manifest, (paths) => {
    const record = leaseRecord(paths.lease);
    if (relatedMergeGuard(paths, record)) {
      throw new Error(
        "ambiguous merge operation is quarantined; reconcile GitHub before releasing the repository lease",
      );
    }
    if (
      record.disposition !== "active" ||
      !tupleMatches(record, tuple) ||
      record.token !== presentedToken
    ) {
      throw new Error("only the exact repository lease owner may release it");
    }
    record.disposition = "released";
    record.releaseReason = reason;
    record.releasedAt = new Date().toISOString();
    atomicWrite(path.join(paths.lease, "owner.json"), record);
    if (record.scope !== PR_SCOPE) exactCleanup(tombstone(paths.lease));
    return true;
  });
}

function status(manifestPath) {
  const loaded = loadManifest(manifestPath);
  if (loaded.manifest.options?.merge !== true) return { required: false };
  return withMetadataGuard(loaded.manifest, (paths) => {
    if (!fs.existsSync(paths.lease))
      return { required: true, state: "missing" };
    const record = leaseRecord(paths.lease);
    const renewedAt = Date.parse(record.renewedAt || "");
    const ageMs = Number.isFinite(renewedAt)
      ? Math.max(0, Date.now() - renewedAt)
      : null;
    const stale = ageMs !== null && ageMs >= STALE_MS;
    let mergeGuard = null;
    if (fs.existsSync(paths.mergeGuard)) {
      const guard = guardOwner(paths.mergeGuard);
      mergeGuard = {
        repository: guard.repository,
        pr: guard.pr,
        head: guard.head,
        base: guard.base,
        requestStartedAt: guard.requestStartedAt,
        admin: guard.admin === true,
        adminReason: guard.adminReason ?? null,
        mode: guard.mode ?? "strict",
        protectionDigest: guard.protectionDigest ?? null,
      };
    }
    return {
      required: true,
      state: record.disposition,
      repository: record.repository,
      pr: record.pr,
      headRef: record.headRef,
      manifestPath: record.manifestPath,
      renewedAt: record.renewedAt,
      ageMs,
      staleAfterMs: STALE_MS,
      recoveryOverrideRequired: record.disposition !== "released" && !stale,
      generation: record.generation,
      owned:
        record.disposition === "active" &&
        tupleMatches(record, ownerTuple(loaded.manifest, loaded.manifestPath)),
      stale,
      mergeGuard,
      mergeIntent: record.mergeIntent ?? null,
      lastRefCasRejection: record.lastRefCasRejection ?? null,
      // Released receipts require normal acquisition, not stale-owner recovery.
      recoveryCommand:
        record.disposition === "released"
          ? null
          : recoveryInvocation("recover", loaded.manifestPath, record),
    };
  });
}

function liveBase(manifest) {
  const branch = baseBranch(manifest);
  const output = execFileSync(
    "git",
    ["ls-remote", "origin", `refs/heads/${branch}`],
    {
      cwd: manifest.repo.realpath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const sha = output.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha || "")) {
    throw new Error(`repository lease could not refresh origin/${branch}`);
  }
  return sha;
}

function baseBranch(manifest) {
  const baseRef = manifest.revisions.baseRef;
  try {
    return require("./quality-protected-nonstrict.js").normalizeProtectedBranch(
      baseRef,
    );
  } catch (error) {
    throw new Error(
      `repository lease cannot resolve protected base '${baseRef}'`,
      { cause: error },
    );
  }
}

function assertBase(manifestPath, presentedToken) {
  verify(manifestPath, presentedToken);
  const { manifest } = loadManifest(manifestPath);
  const live = liveBase(manifest);
  const bound =
    manifest.revisions.baseRebaseCarry?.baseSha ??
    manifest.revisions.baseHeadSha ??
    manifest.revisions.baseSha;
  if (live !== bound) {
    throw new Error(
      `protected base moved from ${bound} to ${live}; retain the lease, rebase onto ${live}, ` +
        `push, then resume this exact manifest`,
    );
  }
  return live;
}

function mergeHead(manifest) {
  return manifest.merge?.stampHead ?? manifest.revisions.currentHead;
}

function assertMergeIntentTransition(record, nextMode) {
  if (
    record.mergeIntent?.mode === "protected-nonstrict-ref-cas" &&
    nextMode !== "protected-nonstrict-ref-cas"
  ) {
    throw new Error(
      "a ref-CAS campaign cannot downgrade its persisted merge intent",
    );
  }
}

function requiredCheckBindings(checks) {
  return (checks || [])
    .map((check) => ({
      context: check.context,
      appId: check.appId,
    }))
    .sort(
      (left, right) =>
        left.context.localeCompare(right.context) || left.appId - right.appId,
    );
}

function autonomousBasePolicyReady(manifest, basePolicy) {
  const exactBase = manifest.revisions.baseHeadSha;
  return Boolean(
    /^[0-9a-f]{40}$/.test(exactBase || "") &&
    manifest.risk?.mergeAuthorityBaseSha === exactBase &&
    manifest.risk?.protectedNonstrictRefCasBaseSha === exactBase &&
    basePolicy?.baseSha === exactBase &&
    basePolicy?.mergeAuthority === "autonomous" &&
    basePolicy?.protectedNonstrictRefCas === "accept-non-atomic-pr-state",
  );
}

function autonomousReviewReady(manifest, authorization, basePolicy) {
  if (manifest.risk?.mergeAuthority !== "autonomous") return false;
  if (manifest.risk?.protectedNonstrictRefCas !== "accept-non-atomic-pr-state")
    return false;
  if (!autonomousBasePolicyReady(manifest, basePolicy)) return false;
  if (authorization?.operatorOverride === true) return false;
  return ["complete", "policy-exempt"].includes(authorization?.reviewStatus);
}

function autonomousRequestReady(manifest, options) {
  if (options.admin !== true || manifest.merge?.stampHead) return false;
  return !options.ciEvidenceSha256;
}

function protectionBindingReady(inspection, options) {
  if (!/^[a-f0-9]{64}$/.test(inspection?.digest || "")) return false;
  if (!/^[a-f0-9]{64}$/.test(options.protectionDigest || "")) return false;
  return options.protectionDigest === inspection.digest;
}

function greenCheckBindings(checkStates, inspection) {
  if (!Array.isArray(checkStates)) return null;
  if (checkStates.some((check) => check.state !== "success")) return null;
  const bindings = requiredCheckBindings(checkStates);
  return JSON.stringify(bindings) ===
    JSON.stringify(requiredCheckBindings(inspection?.requiredChecks))
    ? bindings
    : null;
}

function autonomousRefCasAuthority(
  manifest,
  options,
  head,
  { inspection, authorization, checkStates, basePolicy },
) {
  const requiredChecks = greenCheckBindings(checkStates, inspection);
  if (
    !autonomousRequestReady(manifest, options) ||
    !autonomousReviewReady(manifest, authorization, basePolicy) ||
    !protectionBindingReady(inspection, options) ||
    !requiredChecks
  ) {
    throw new Error(
      "protected non-strict autonomous ref-CAS requires complete exact-head review, green CI, and unchanged supported protection",
    );
  }
  return {
    ...options,
    mode: "protected-nonstrict-ref-cas",
    authority: "autonomous-green",
    protectionDigest: inspection.digest,
    requiredChecks,
    ciEvidenceSha256: null,
    head,
  };
}

function resolveProtectedNonstrictMode(manifest, options, head) {
  const invocation = require("./quality-invocation.js");
  const capability = invocation.protectedNonstrictRefCasCapability(manifest);
  if (
    manifest.approval?.scope === "operator-nonstrict-refcas-override" &&
    !capability
  ) {
    throw new Error(
      "protected non-strict ref-CAS requires its valid signed exact-head capability",
    );
  }
  if (capability) {
    if (
      options.admin !== true ||
      manifest.merge?.stampHead ||
      (capability.ciEvidenceSha256 &&
        !invocation.ciBillingEvidenceBindingValid(
          manifest,
          capability.ciEvidenceSha256,
        )) ||
      capability.baseSha !== manifest.revisions.baseHeadSha ||
      !/^[a-f0-9]{64}$/.test(capability.protectionDigest || "") ||
      (options.protectionDigest &&
        options.protectionDigest !== capability.protectionDigest)
    ) {
      throw new Error(
        "protected non-strict ref-CAS requires its valid signed exact-head capability",
      );
    }
    return {
      ...options,
      mode: "protected-nonstrict-ref-cas",
      authority: "signed-capability",
      protectionDigest: capability.protectionDigest,
      requiredChecks: capability.requiredChecks,
      ciEvidenceSha256: capability.ciEvidenceSha256,
    };
  }
  const branch = baseBranch(manifest);
  const inspection =
    require("./quality-protected-nonstrict.js").inspectProtectedNonstrict({
      repository: manifest.repo.githubRepository,
      branch,
      pr: manifest.repo.pr,
      cwd: manifest.repo.realpath,
    });
  const authorization = invocation.reviewAuthorization(manifest);
  const basePolicy = protectedNonstrictBasePolicy(manifest);
  const requiredChecks = require("./quality-required-checks.js");
  const checkContext = {
    repository: manifest.repo.githubRepository,
    base: branch,
    head,
  };
  const checkStates = requiredChecks.assertChecks(
    checkContext.repository,
    checkContext.base,
    checkContext.head,
    requiredChecks.monitorForAssertion(manifest, checkContext),
  );
  return autonomousRefCasAuthority(manifest, options, head, {
    inspection,
    authorization,
    checkStates,
    basePolicy,
  });
}

function protectedNonstrictBasePolicy(manifest) {
  const baseSha = manifest.risk?.protectedNonstrictRefCasBaseSha;
  if (!/^[0-9a-f]{40}$/.test(baseSha || "")) {
    return {
      baseSha: null,
      mergeAuthority: "human-required",
      protectedNonstrictRefCas: "signed-only",
    };
  }
  const config = require("./risk-score.js").loadConfigAtRevision(
    manifest.repo.realpath,
    baseSha,
  );
  return {
    baseSha,
    mergeAuthority: config.mergeAuthority,
    protectedNonstrictRefCas: config.protectedNonstrictRefCas,
  };
}

function acquireMergeGuard(manifestPath, presentedToken, options = {}) {
  const loaded = loadManifest(manifestPath);
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withOwnershipTransaction(loaded.manifest, (paths) => {
    const record = leaseRecord(paths.lease);
    const credential = loaded.manifest.merge?.repositoryLease;
    if (
      record.disposition !== "active" ||
      !tupleMatches(record, tuple) ||
      record.token !== presentedToken ||
      credential?.token !== presentedToken ||
      credential?.generation !== record.generation
    ) {
      throw new Error(
        "repository merge lease credential is stale before merge guard acquisition",
      );
    }
    const nextMode = options.mode || "strict";
    assertMergeIntentTransition(record, nextMode);
    acquireGuard(paths.mergeGuard, 1, { recoverDead: false });
    const ownerFile = path.join(paths.mergeGuard, "owner.json");
    atomicWrite(ownerFile, {
      ...guardOwner(paths.mergeGuard),
      repository: record.repository,
      pr: record.pr,
      head: mergeHead(loaded.manifest),
      base:
        loaded.manifest.revisions.baseRebaseCarry?.baseSha ??
        loaded.manifest.revisions.baseHeadSha,
      token: presentedToken,
      admin: options.admin === true,
      adminReason:
        options.admin === true
          ? options.authority || "ci-billing-waiver"
          : null,
      mode: nextMode,
      protectionDigest: options.protectionDigest || null,
      requiredChecks: options.requiredChecks || null,
      ciEvidenceSha256: options.ciEvidenceSha256 || null,
      baseRef: baseBranch(loaded.manifest),
      requestStartedAt: null,
    });
    record.mergeIntent = {
      mode: nextMode,
      head: mergeHead(loaded.manifest),
      baseRef: baseBranch(loaded.manifest),
      baseSha:
        loaded.manifest.revisions.baseRebaseCarry?.baseSha ??
        loaded.manifest.revisions.baseHeadSha,
      protectionDigest: options.protectionDigest || null,
      requiredChecks: options.requiredChecks || null,
      ciEvidenceSha256: options.ciEvidenceSha256 || null,
    };
    record.renewedAt = new Date().toISOString();
    atomicWrite(path.join(paths.lease, "owner.json"), record);
    return paths.mergeGuard;
  });
}

function releaseMergeGuard(
  manifestPath,
  presentedToken,
  outcome,
  details = {},
) {
  const loaded = loadManifest(manifestPath);
  ownerTuple(loaded.manifest, loaded.manifestPath, {
    requireWorktree: true,
  });
  return withOwnershipTransaction(loaded.manifest, (paths) => {
    const owner = guardOwner(paths.mergeGuard);
    if (
      owner.token !== presentedToken ||
      owner.repository !== repositoryIdentity(loaded.manifest) ||
      owner.pr !== loaded.manifest.repo.pr ||
      owner.head !== mergeHead(loaded.manifest)
    ) {
      throw new Error("merge operation guard owner changed");
    }
    if (!["not-started", "request-rejected-stale-base"].includes(outcome)) {
      throw new Error("ambiguous merge operation remains quarantined");
    }
    if (outcome === "not-started" && owner.requestStartedAt !== null) {
      throw new Error(
        "a started merge request cannot use the not-started release path",
      );
    }
    if (outcome === "request-rejected-stale-base") {
      if (
        owner.mode !== "protected-nonstrict-ref-cas" ||
        details.status !== 422 ||
        details.message !== "Update is not a fast forward"
      ) {
        throw new Error(
          "stale-base release requires an exact ref-CAS 422 rejection",
        );
      }
      const record = leaseRecord(paths.lease);
      record.lastRefCasRejection = {
        mode: owner.mode,
        head: owner.head,
        base: owner.base,
        status: details.status,
        message: details.message,
        recordedAt: new Date().toISOString(),
      };
      record.renewedAt = new Date().toISOString();
      atomicWrite(path.join(paths.lease, "owner.json"), record);
    }
    const released = tombstone(paths.mergeGuard);
    exactCleanup(released);
  });
}

function remotePullRequest(manifest, options = {}) {
  const view = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(manifest.repo.pr),
      "--repo",
      manifest.repo.githubRepository,
      "--json",
      "state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,autoMergeRequest",
    ],
    {
      cwd: options.repositoryScoped
        ? manifest.stateRoot
        : manifest.repo.realpath,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (view.status !== 0) {
    throw new Error(
      `GitHub merge state could not be verified: ${view.stderr || "gh pr view failed"}`.trim(),
    );
  }
  try {
    return JSON.parse(view.stdout);
  } catch (error) {
    throw new Error("GitHub merge state was not valid JSON", { cause: error });
  }
}

// A started GitHub merge is normally quarantined until the remote proves the
// exact merge outcome. There is one safe cancellation case: the PR is still
// open, its head has changed beyond the guarded candidate, and GitHub confirms
// that no auto-merge request remains. In that state GitHub cannot merge the
// guarded SHA, and the next exact-head campaign needs a new lease.
function abandonSupersededOpenMerge(
  manifestPath,
  presentedToken,
  options = {},
) {
  const credential = reconciliationCredential(
    manifestPath,
    presentedToken,
    options,
  );
  const { manifest } = loadManifest(manifestPath);
  const paths = pathsFor(repositoryIdentity(manifest), manifest);
  const guard = relatedMergeGuard(paths, credential);
  if (!guard) {
    throw new Error("superseded merge recovery requires the exact merge guard");
  }
  const remote = remotePullRequest(manifest, { repositoryScoped: true });
  if (
    remote.state !== "OPEN" ||
    remote.headRefName !== manifest.repo.headRefName ||
    remote.baseRefName !== baseBranch(manifest) ||
    remote.headRefOid === guard.head ||
    remote.autoMergeRequest !== null
  ) {
    throw new Error(
      "superseded merge recovery requires an open PR with a changed head and disabled auto-merge",
    );
  }
  withOwnershipTransaction(manifest, (lockedPaths) => {
    const record = leaseRecord(lockedPaths.lease);
    const lockedGuard = relatedMergeGuard(lockedPaths, record);
    if (!lockedGuard || record.token !== credential.token) {
      throw new Error("superseded merge recovery ownership changed");
    }
    const released = tombstone(lockedPaths.mergeGuard);
    exactCleanup(released);
  });
  release(manifestPath, credential.token, "superseded-open-merge-cancelled");
  return { abandoned: true, remote };
}

function ghJson(manifest, args, label, options = {}) {
  const result = spawnSync("gh", args, {
    cwd: options.repositoryScoped ? manifest.stateRoot : manifest.repo.realpath,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || "gh failed"}`.trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned malformed JSON`, { cause: error });
  }
}

function parseIncludedGhResponses(stdout) {
  const raw = String(stdout || "");
  const starts = [...raw.matchAll(/^HTTP\/[^\r\n]*$/gm)].map(
    (match) => match.index,
  );
  return starts.map((start, index) => {
    const block = raw.slice(start, starts[index + 1] ?? raw.length);
    const status = Number(block.split(/\r?\n/, 1)[0].trim().split(/\s+/)[1]);
    const separator = block.match(/\r?\n\r?\n/);
    if (
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      !separator
    ) {
      return { status: null, body: null };
    }
    try {
      return {
        status,
        body: JSON.parse(
          block.slice(separator.index + separator[0].length).trim(),
        ),
      };
    } catch {
      return { status, body: null };
    }
  });
}

function parseIncludedGhResponse(stdout) {
  const responses = parseIncludedGhResponses(stdout);
  return responses.length === 1 ? responses[0] : { status: null, body: null };
}

function refUpdateAccepted(update, status, body, branch, head) {
  return (
    update?.status === 0 &&
    status === 200 &&
    body?.ref === `refs/heads/${branch}` &&
    body?.object?.sha === head
  );
}

function staleRefUpdateRejected(update, status, body) {
  return (
    Number.isInteger(update?.status) &&
    update.status !== 0 &&
    status === 422 &&
    body?.message === "Update is not a fast forward"
  );
}

function classifyRefUpdateResponse(update, branch, head) {
  const responses = parseIncludedGhResponses(update?.stdout);
  if (responses.length !== 1) {
    return { kind: "ambiguous", status: null, body: null };
  }
  const { status, body } = responses[0];
  if (refUpdateAccepted(update, status, body, branch, head)) {
    return { kind: "accepted", status, body };
  }
  if (staleRefUpdateRejected(update, status, body)) {
    return { kind: "rejected-stale-base", status, body };
  }
  return { kind: "ambiguous", status, body };
}

function refCasIntegrated(manifest, remote, options = {}) {
  if (exactRemoteOutcome(manifest, remote) !== "merged") return false;
  const branch = baseBranch(manifest);
  const ref = ghJson(
    manifest,
    [
      "api",
      `repos/${manifest.repo.githubRepository}/git/ref/heads/${encodeURIComponent(branch)}`,
    ],
    "protected base ref read",
    options,
  );
  const live = ref?.object?.sha;
  if (!/^[0-9a-f]{40}$/.test(live || "")) {
    throw new Error("protected base ref read omitted its exact SHA");
  }
  const head = mergeHead(manifest);
  const comparison = ghJson(
    manifest,
    [
      "api",
      `repos/${manifest.repo.githubRepository}/compare/${head}...${live}`,
    ],
    "exact-head integration comparison",
    options,
  );
  return comparison?.status === "ahead" || comparison?.status === "identical";
}

function exactRemoteOutcome(manifest, remote) {
  if (!remote || typeof remote !== "object") return null;
  const exactHead =
    remote.headRefName === manifest.repo.headRefName &&
    remote.headRefOid === mergeHead(manifest) &&
    remote.baseRefName === baseBranch(manifest);
  if (
    exactHead &&
    remote.state === "MERGED" &&
    Boolean(remote.mergedAt) &&
    Boolean(remote.mergeCommit?.oid)
  ) {
    return "merged";
  }
  if (
    exactHead &&
    remote.state === "CLOSED" &&
    !remote.mergedAt &&
    !remote.mergeCommit?.oid
  ) {
    return "closed-unmerged";
  }
  return null;
}

function localAncestor(root, ancestor, descendant) {
  if (
    !/^[a-f0-9]{40}$/.test(ancestor || "") ||
    !/^[a-f0-9]{40}$/.test(descendant || "")
  ) {
    return false;
  }
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  return result.status === 0;
}

function localTree(root, revision) {
  const result = spawnSync("git", ["rev-parse", `${revision}^{tree}`], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  const tree = result.stdout?.trim();
  return result.status === 0 && /^[a-f0-9]{40}$/.test(tree) ? tree : null;
}

function localMergeContains(root, head, mergeCommit) {
  if (localAncestor(root, head, mergeCommit)) return true;
  const headTree = localTree(root, head);
  return Boolean(headTree && headTree === localTree(root, mergeCommit));
}

function descendantMergedRemoteOutcome(manifest, remote) {
  const priorHead = mergeHead(manifest);
  if (
    remote?.state !== "MERGED" ||
    !remote.mergedAt ||
    !remote.mergeCommit?.oid ||
    remote.headRefName !== manifest.repo.headRefName ||
    remote.baseRefName !== baseBranch(manifest) ||
    remote.headRefOid === priorHead
  ) {
    return null;
  }
  return localAncestor(manifest.repo.realpath, priorHead, remote.headRefOid) &&
    localMergeContains(
      manifest.repo.realpath,
      remote.headRefOid,
      remote.mergeCommit.oid,
    )
    ? "merged-descendant"
    : null;
}

function exactOpenRemoteOutcome(manifest, remote) {
  return Boolean(
    remote?.state === "OPEN" &&
    !remote.mergedAt &&
    !remote.mergeCommit?.oid &&
    remote.headRefName === manifest.repo.headRefName &&
    remote.headRefOid === mergeHead(manifest) &&
    remote.baseRefName === baseBranch(manifest),
  );
}

function reconciliationCredential(manifestPath, presentedToken, options = {}) {
  if (presentedToken) {
    return verify(manifestPath, presentedToken, { renew: false });
  }
  const loaded = loadManifest(manifestPath);
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath);
  return withMetadataGuard(loaded.manifest, (paths) => {
    const record = leaseRecord(paths.lease);
    if (
      record.disposition !== "active" ||
      !tupleMatches(record, tuple) ||
      options.confirmOwnerInvocationId !== record.invocationId ||
      String(options.confirmOwnerPr || "") !== String(record.pr)
    ) {
      throw new Error(
        "merge reconciliation requires the exact current owner invocation ID and pull request",
      );
    }
    return record;
  });
}

function reconcileMergeOutcome(manifestPath, presentedToken, options = {}) {
  const credential = reconciliationCredential(
    manifestPath,
    presentedToken,
    options,
  );
  const { manifest } = loadManifest(manifestPath);
  const remote = remotePullRequest(manifest, { repositoryScoped: true });
  const paths = pathsFor(repositoryIdentity(manifest), manifest);
  const guard = relatedMergeGuard(paths, credential);
  let outcome =
    exactRemoteOutcome(manifest, remote) ??
    descendantMergedRemoteOutcome(manifest, remote);
  const refCasIntent = refCasIntentMatches(credential, manifest);
  if (
    outcome === "merged" &&
    (guard?.mode === "protected-nonstrict-ref-cas" || refCasIntent) &&
    !refCasIntegrated(manifest, remote, { repositoryScoped: true })
  ) {
    outcome = null;
  }
  if (
    !outcome ||
    (options.mergedOnly && !["merged", "merged-descendant"].includes(outcome))
  ) {
    return { reconciled: false, outcome: null, remote };
  }
  if (outcome === "merged-descendant") {
    // Persist the observed remote successor before releasing its quarantine.
    // A crash after this write remains safe: the lease is still held and a
    // later exact reconciliation will make the same idempotent observation.
    recordDescendantMergedOutcome(manifestPath, remote);
  }
  releaseVerifiedOutcome(manifestPath, credential.token, outcome);
  return { reconciled: true, outcome, remote };
}

function refCasIntentMatches(credential, manifest) {
  return (
    credential.mergeIntent?.mode === "protected-nonstrict-ref-cas" &&
    credential.mergeIntent?.head === mergeHead(manifest) &&
    credential.mergeIntent?.baseRef === baseBranch(manifest)
  );
}

function recordMergedTerminalRaw(manifestPath) {
  require("./quality-invocation").withManifestLockRaw(
    manifestPath,
    (manifest) => {
      if (manifest.terminalState?.state === "merged") return;
      const requestedEpoch = process.env.BS_QUALITY_TERMINAL_EPOCH;
      const recoveringEpoch =
        requestedEpoch === undefined || requestedEpoch === ""
          ? manifest.terminalState?.terminalEpoch
          : Number(requestedEpoch);
      const replacingRecovery =
        manifest.terminalState?.state === "recovering" &&
        Number.isSafeInteger(recoveringEpoch) &&
        recoveringEpoch === manifest.terminalState.terminalEpoch;
      if (
        manifest.terminalState &&
        manifest.terminalState.state !== "verified-unmerged" &&
        !replacingRecovery
      ) {
        return;
      }
      manifest.terminalState = {
        state: "merged",
        detail: `pr:${manifest.repo.pr}`,
        head: manifest.revisions?.currentHead ?? null,
        terminalEpoch: Number.isSafeInteger(recoveringEpoch)
          ? recoveringEpoch
          : (manifest.terminalEpoch ?? 0),
        recordedAt: new Date().toISOString(),
      };
    },
  );
}

function recordMergedTelemetry(manifestPath) {
  try {
    require("./quality-telemetry").recordCampaign(manifestPath, {
      quiet: true,
    });
  } catch (error) {
    process.stderr.write(
      `[quality] telemetry: merged campaign could not be recorded — ${error.message}\n`,
    );
  }
}

function recordDescendantMergedOutcome(manifestPath, remote) {
  require("./quality-invocation").withManifestLockRaw(
    manifestPath,
    (manifest) => {
      manifest.merge ??= {};
      manifest.merge.descendantMerge = {
        head: remote.headRefOid,
        mergeCommit: remote.mergeCommit.oid,
        mergedAt: remote.mergedAt,
        recordedAt: new Date().toISOString(),
      };
    },
  );
}

function releaseVerifiedOutcome(manifestPath, presentedToken, outcome) {
  const loaded = loadManifest(manifestPath);
  const tuple = ownerTuple(loaded.manifest, loaded.manifestPath);
  const released = withOwnershipTransaction(loaded.manifest, (paths) => {
    const record = leaseRecord(paths.lease);
    if (
      record.disposition !== "active" ||
      !tupleMatches(record, tuple) ||
      record.token !== presentedToken
    ) {
      throw new Error(
        "verified remote outcome does not belong to the active repository lease",
      );
    }
    const ownGuard = relatedMergeGuard(paths, record);
    if (ownGuard) {
      const owner = ownGuard;
      if (
        owner.token !== presentedToken ||
        owner.repository !== repositoryIdentity(loaded.manifest) ||
        owner.pr !== loaded.manifest.repo.pr ||
        owner.head !== mergeHead(loaded.manifest)
      ) {
        throw new Error(
          "merge operation guard does not match this exact campaign",
        );
      }
    }
    // This durable disposition is the recovery commit point. If the process
    // dies after GitHub proved the outcome, a later acquire can remove any
    // leftover guard/lease directories without waiting for staleness.
    record.disposition = "released";
    record.releaseReason = `verified-remote-${outcome}`;
    record.releasedAt = new Date().toISOString();
    atomicWrite(path.join(paths.lease, "owner.json"), record);
    if (outcome === "merged") recordMergedTerminalRaw(manifestPath);
    if (ownGuard) {
      const released = tombstone(paths.mergeGuard);
      exactCleanup(released);
    }
    if (record.scope !== PR_SCOPE) exactCleanup(tombstone(paths.lease));
    return true;
  });
  if (outcome === "merged") recordMergedTelemetry(manifestPath);
  return released;
}

function resolveMergeMode(manifest, options, head) {
  if (options.expectedHead !== head) {
    throw new Error(
      `validated PR head ${options.expectedHead || "missing"} does not match manifest merge head ${head}`,
    );
  }
  const mode = options.mode || "strict";
  if (
    !["strict", "unprotectable", "protected-nonstrict-ref-cas"].includes(mode)
  ) {
    throw new Error(`unsupported merge mode '${mode}'`);
  }
  if (mode === "protected-nonstrict-ref-cas") {
    return resolveProtectedNonstrictMode(manifest, options, head);
  }
  return { ...options, mode };
}

function resolveRefCasAtMutation(manifest, options, head) {
  const resolved = resolveMergeMode(manifest, options, head);
  const expiresAt = Date.parse(manifest.approval?.expiresAt || "");
  if (
    resolved.authority === "signed-capability" &&
    (!Number.isFinite(expiresAt) || expiresAt - Date.now() < 120_000)
  ) {
    throw new Error(
      "protected non-strict ref-CAS capability must remain valid through the bounded ref update",
    );
  }
  return resolved;
}

function waitMilliseconds(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function waitForRefCasIntegration(manifest, options = {}) {
  const attempts = options.attempts ?? 30;
  const intervalMs = options.intervalMs ?? 1_000;
  const readRemote = options.readRemote ?? remotePullRequest;
  const integrated = options.integrated ?? refCasIntegrated;
  const wait = options.wait ?? waitMilliseconds;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const remote = readRemote(manifest);
      if (integrated(manifest, remote)) return remote;
    } catch {
      // GitHub read-back can lag or fail briefly after an accepted update.
    }
    if (attempt + 1 < attempts) wait(intervalMs);
  }
  return null;
}

function withNotStartedCleanup(manifestPath, presentedToken, operation) {
  try {
    return operation();
  } catch (error) {
    try {
      releaseMergeGuard(manifestPath, presentedToken, "not-started");
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `${error.message}; merge guard cleanup also failed: ${releaseError.message}`,
        { cause: releaseError },
      );
    }
    throw error;
  }
}

function refCasProtectionMatches(inspection, guarded, options) {
  return (
    inspection.digest === options.protectionDigest &&
    JSON.stringify(requiredCheckBindings(inspection.requiredChecks)) ===
      JSON.stringify(requiredCheckBindings(options.requiredChecks)) &&
    guarded.protectionDigest === options.protectionDigest &&
    JSON.stringify(requiredCheckBindings(guarded.requiredChecks)) ===
      JSON.stringify(requiredCheckBindings(options.requiredChecks)) &&
    guarded.mode === "protected-nonstrict-ref-cas"
  );
}

function assertRefCasPreconditions(manifest, guarded, options, head) {
  const branch = baseBranch(manifest);
  const inspection =
    require("./quality-protected-nonstrict.js").inspectProtectedNonstrict({
      repository: manifest.repo.githubRepository,
      branch,
      pr: manifest.repo.pr,
      cwd: manifest.repo.realpath,
    });
  if (!refCasProtectionMatches(inspection, guarded, options)) {
    throw new Error(
      "protected non-strict branch protection changed before the guarded ref update",
    );
  }
  const preMutationPr = remotePullRequest(manifest);
  if (
    preMutationPr.state !== "OPEN" ||
    preMutationPr.headRefName !== manifest.repo.headRefName ||
    preMutationPr.headRefOid !== head ||
    preMutationPr.baseRefName !== branch
  ) {
    throw new Error(
      "exact pull request identity changed before the ref update",
    );
  }
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", guarded.base, head],
    { cwd: manifest.repo.realpath, encoding: "utf8", timeout: 30_000 },
  );
  if (ancestor.status !== 0) {
    throw new Error("reviewed head is not a descendant of the exact base");
  }
}

function performRefCasUpdate(loaded, presentedToken, options) {
  const { manifestPath } = loaded;
  const prepared = withNotStartedCleanup(manifestPath, presentedToken, () => {
    const refreshed = loadManifest(manifestPath);
    const manifest = refreshed.manifest;
    const head = mergeHead(manifest);
    const finalOptions = resolveRefCasAtMutation(manifest, options, head);
    const paths = pathsFor(repositoryIdentity(manifest), manifest);
    assertRefCasPreconditions(
      manifest,
      guardOwner(paths.mergeGuard),
      finalOptions,
      head,
    );
    const ownerFile = path.join(paths.mergeGuard, "owner.json");
    const guarded = guardOwner(paths.mergeGuard);
    guarded.requestStartedAt = new Date().toISOString();
    atomicWrite(ownerFile, guarded);
    return {
      manifest,
      head,
      mode: finalOptions.mode,
      branch: baseBranch(manifest),
    };
  });
  const { manifest, head, mode, branch } = prepared;
  const update = spawnSync(
    "gh",
    [
      "api",
      "--include",
      "--method",
      "PATCH",
      `repos/${manifest.repo.githubRepository}/git/refs/heads/${encodeURIComponent(branch)}`,
      "--input",
      "-",
    ],
    {
      cwd: manifest.repo.realpath,
      encoding: "utf8",
      timeout: 120_000,
      input: `${JSON.stringify({ sha: head, force: false })}\n`,
    },
  );
  const responseOutcome = classifyRefUpdateResponse(update, branch, head);
  if (responseOutcome.kind === "accepted") {
    const remote = waitForRefCasIntegration(manifest);
    if (remote) {
      releaseVerifiedOutcome(manifestPath, presentedToken, "merged");
      return { merged: true, remote, mode };
    }
    throw new Error(
      `ref-CAS outcome is ambiguous and quarantined (http ${responseOutcome.status ?? "unknown"}, gh status ${update.status ?? "timeout"})`,
    );
  }
  if (responseOutcome.kind === "rejected-stale-base") {
    let remote = null;
    try {
      remote = remotePullRequest(manifest);
    } catch {
      // A rejected update still needs exact synchronous read-back.
    }
    if (remote && refCasIntegrated(manifest, remote)) {
      releaseVerifiedOutcome(manifestPath, presentedToken, "merged");
      return { merged: true, remote, mode, recovered: true };
    }
    if (!exactOpenRemoteOutcome(manifest, remote)) {
      throw new Error(
        "ref-CAS rejection read-back is unavailable or changed; outcome remains ambiguous and quarantined",
      );
    }
    releaseMergeGuard(
      manifestPath,
      presentedToken,
      "request-rejected-stale-base",
      {
        status: responseOutcome.status,
        message: responseOutcome.body?.message,
      },
    );
    throw new Error(
      "protected base changed before the non-force ref update; request was rejected without mutation, repository lease retained for rebase and resume",
    );
  }
  throw new Error(
    `ref-CAS outcome is ambiguous and quarantined (http ${responseOutcome.status ?? "unknown"}, gh status ${update.status ?? "timeout"})`,
  );
}

function performMerge(manifestPath, presentedToken, options = {}) {
  verify(manifestPath, presentedToken);
  const loaded = loadManifest(manifestPath);
  const { manifest } = loaded;
  const repository = repositoryIdentity(manifest);
  const expectedRepository = manifest.repo.githubRepository;
  const pr = String(manifest.repo.pr);
  const head = mergeHead(manifest);
  const resolvedOptions = resolveMergeMode(manifest, options, head);
  const mode = resolvedOptions.mode;
  acquireMergeGuard(manifestPath, presentedToken, resolvedOptions);
  withNotStartedCleanup(manifestPath, presentedToken, () => {
    assertBase(manifestPath, presentedToken);
  });
  if (mode === "protected-nonstrict-ref-cas") {
    return performRefCasUpdate(loaded, presentedToken, resolvedOptions);
  }
  const paths = pathsFor(repository, manifest);
  const ownerFile = path.join(paths.mergeGuard, "owner.json");
  const guarded = guardOwner(paths.mergeGuard);
  guarded.requestStartedAt = new Date().toISOString();
  atomicWrite(ownerFile, guarded);
  const args = [
    "pr",
    "merge",
    pr,
    "--repo",
    expectedRepository,
    "--squash",
    "--match-head-commit",
    head,
  ];
  if (options.admin) args.push("--admin");
  let merge = spawnSync("gh", args, {
    cwd: manifest.repo.realpath,
    encoding: "utf8",
    timeout: 120_000,
  });
  // GitHub can require auto-merge even after its exact protected check is
  // green. This is a normal protected-branch policy path, not an
  // administrator override. Keep the same immutable PR/head binding and
  // require the authoritative merged read-back below before releasing either
  // guard or lease.
  if (
    merge.status !== 0 &&
    !options.admin &&
    /add the `--auto` flag/i.test(
      `${merge.stdout || ""}\n${merge.stderr || ""}`,
    )
  ) {
    merge = spawnSync("gh", [...args, "--auto"], {
      cwd: manifest.repo.realpath,
      encoding: "utf8",
      timeout: 120_000,
    });
  }
  let remote = null;
  let remoteReadError = null;
  try {
    remote = remotePullRequest(manifest);
  } catch (error) {
    remoteReadError = error;
    // A failed/timeout client can have submitted an accepted request. The
    // operation remains quarantined when authoritative read-back also fails.
  }
  if (exactRemoteOutcome(manifest, remote) === "merged") {
    releaseVerifiedOutcome(manifestPath, presentedToken, "merged");
    return { merged: true, remote };
  }
  // A failed/timeout client can have submitted an accepted request. Preserve
  // the operation guard until GitHub proves merge or the operator closes the PR.
  // Build the hint BEFORE the throw, and never let its preconditions replace
  // this diagnostic. This is the most safety-critical message in the file: it
  // fires when GitHub could not confirm the merge, and it carries the gh
  // status, stderr and remote state an operator needs to avoid a duplicate
  // merge. Evaluating the builder inline as an Error argument meant that a
  // manifest missing repo.pr threw "requires the displaced owner record"
  // INSTEAD, discarding all of that context — precisely the failure mode where
  // pr is most likely to be unset.
  let recoveryHint;
  try {
    recoveryHint = `run ${recoveryInvocation(
      "reconcile-merge",
      loaded.manifestPath,
      {
        invocationId: loaded.manifest.invocationId,
        pr: loaded.manifest.repo.pr,
      },
    )}`;
  } catch {
    recoveryHint =
      `run reconcile-merge against ${loaded.manifestPath} manually ` +
      `(owner identity incomplete: invocationId=` +
      `${loaded.manifest.invocationId ?? "unset"}, ` +
      `pr=${loaded.manifest.repo?.pr ?? "unset"})`;
  }
  throw new Error(
    `merge outcome is ambiguous and quarantined (gh status ${merge.status ?? "timeout"}): ` +
      `${merge.stderr || remoteReadError?.message || `GitHub returned ${JSON.stringify(remote)}`}`.trim() +
      `; after verifying GitHub, ${recoveryHint}`,
  );
}

function releaseIfMerged(manifestPath, presentedToken) {
  const { manifest } = loadManifest(manifestPath);
  if (manifest.options?.merge !== true) {
    return { reconciled: false, outcome: null, remote: null };
  }
  return reconcileMergeOutcome(manifestPath, presentedToken, {
    mergedOnly: true,
  });
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) options._.push(argv[index]);
    else options[argv[index].slice(2)] = argv[++index];
  }
  return options;
}

function publicCredential(credential) {
  if (!credential) return credential;
  return {
    identity: credential.identity,
    generation: credential.generation,
  };
}

function presentedToken() {
  return process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
}

function recoverFromOptions(manifest, options) {
  const loaded = loadManifest(manifest);
  const paths = pathsFor(repositoryIdentity(loaded.manifest), loaded.manifest);
  const record = leaseRecord(paths.lease);
  if (
    options["confirm-owner-invocation-id"] !== record.invocationId ||
    String(options["confirm-owner-pr"] || "") !== String(record.pr)
  ) {
    throw new Error(
      "recovery requires the exact current owner invocation ID and pull request",
    );
  }
  const override = options.override === "true";
  if (override && !String(options.reason || "").trim()) {
    throw new Error(
      "recover --override true requires --reason describing the operator decision",
    );
  }
  return recover(manifest, record.token, {
    override,
    reason: options.reason,
  });
}

function requestedWaitMs(options) {
  const waitMs =
    options["wait-ms"] === undefined ? undefined : Number(options["wait-ms"]);
  if (
    waitMs !== undefined &&
    (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > DEFAULT_WAIT_MS)
  ) {
    throw new Error(
      `--wait-ms must be an integer from 0 to ${DEFAULT_WAIT_MS}`,
    );
  }
  return waitMs;
}

function commandHandlers(manifest, options) {
  const waitMs = requestedWaitMs(options);
  return {
    acquire: () => publicCredential(acquire(manifest, { waitMs })),
    verify() {
      verify(manifest, presentedToken());
    },
    release: () => release(manifest, presentedToken(), options.reason),
    status: () => status(manifest),
    "assert-base": () => assertBase(manifest, presentedToken()),
    merge: () =>
      performMerge(manifest, presentedToken(), {
        admin: options.admin === "true",
        expectedHead: options["expected-head"],
        mode: options.mode,
        protectionDigest: options["protection-digest"],
      }),
    "release-if-merged": () => releaseIfMerged(manifest, presentedToken()),
    "reconcile-merge": () =>
      reconcileMergeOutcome(manifest, presentedToken(), {
        confirmOwnerInvocationId: options["confirm-owner-invocation-id"],
        confirmOwnerPr: options["confirm-owner-pr"],
      }),
    "abandon-superseded-open-merge": () =>
      abandonSupersededOpenMerge(manifest, presentedToken(), {
        confirmOwnerInvocationId: options["confirm-owner-invocation-id"],
        confirmOwnerPr: options["confirm-owner-pr"],
      }),
    recover: () => publicCredential(recoverFromOptions(manifest, options)),
    "rollback-protocol": () => rollbackProtocol(manifest),
  };
}

function main() {
  const [command, ...raw] = process.argv.slice(2);
  const options = parseArgs(raw);
  const manifest = options.manifest || options._[0];
  if (!manifest) throw new Error(`${command || "command"} requires --manifest`);
  const handler = commandHandlers(manifest, options)[command];
  if (!handler)
    throw new Error(`unknown repository lease command '${command}'`);
  const result = handler();
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality repository lease: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  STALE_MS,
  RECOVERY_OVERRIDE_ENV,
  accountHome,
  acquire,
  rollbackProtocol,
  acquireMergeGuard,
  abandonSupersededOpenMerge,
  assertBase,
  performMerge,
  reconcileMergeOutcome,
  releaseIfMerged,
  release,
  releaseMergeGuard,
  isVitestFixture,
  repositoryIdentity,
  recover,
  stateRoot,
  status,
  verify,
  withManifestMutation,
  withMetadataGuard,
  hasMetadataGuard,
  _acquireGuard: acquireGuard,
  _atomicWrite: atomicWrite,
  _recoverDeadGuard: recoverDeadGuard,
  _pathsFor: pathsFor,
  _classifyRefUpdateResponse: classifyRefUpdateResponse,
  _exactOpenRemoteOutcome: exactOpenRemoteOutcome,
  _performRefCasUpdate: performRefCasUpdate,
  _parseIncludedGhResponse: parseIncludedGhResponse,
  _autonomousRefCasAuthority: autonomousRefCasAuthority,
  _refCasProtectionMatches: refCasProtectionMatches,
  _resolveRefCasAtMutation: resolveRefCasAtMutation,
  _recordMergedTerminalRaw: recordMergedTerminalRaw,
  _waitForRefCasIntegration: waitForRefCasIntegration,
};
