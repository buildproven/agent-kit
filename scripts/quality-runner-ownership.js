#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const quality = require("./quality-invocation");

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function processAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function processGroupAbsent(processGroupId) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function ownershipSchemaVersion(platform = process.platform) {
  return platform === "win32" ? 1 : 2;
}

function validChild(child) {
  return (
    child === null ||
    (child &&
      Number.isInteger(child.pid) &&
      child.pid > 0 &&
      Number.isInteger(child.processGroupId) &&
      child.processGroupId > 0 &&
      Number.isFinite(Date.parse(child.startedAt)))
  );
}

function readOwner(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) return null;
    const record = quality.parseJson(
      fs.readFileSync(descriptor, "utf8"),
      "runner owner",
    );
    if (
      ![1, 2].includes(record.schemaVersion) ||
      !Number.isInteger(record.pid) ||
      record.pid < 1 ||
      typeof record.hostname !== "string" ||
      typeof record.nonce !== "string" ||
      !record.nonce ||
      !Number.isFinite(Date.parse(record.acquiredAt)) ||
      typeof record.childInFlight !== "boolean" ||
      (record.schemaVersion === 2 && !validChild(record.child))
    )
      return null;
    return { stat, record };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeAllSync(descriptor, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(
      descriptor,
      data,
      offset,
      data.length - offset,
      offset,
    );
    if (written <= 0)
      throw new Error("runner ownership write made no progress");
    offset += written;
  }
}

function createOwner(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (["EEXIST", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
  const stat = fs.fstatSync(descriptor);
  const schemaVersion = ownershipSchemaVersion();
  const record = {
    schemaVersion,
    hostname: os.hostname(),
    pid: process.pid,
    nonce: crypto.randomBytes(16).toString("hex"),
    acquiredAt: new Date().toISOString(),
    childInFlight: false,
    ...(schemaVersion === 2 ? { child: null } : {}),
  };
  const write = () => {
    if (!sameFile(fs.lstatSync(file), stat))
      throw new Error("runner ownership file changed");
    const data = Buffer.from(`${JSON.stringify(record)}\n`);
    writeAllSync(descriptor, data);
    fs.ftruncateSync(descriptor, data.length);
    fs.fsyncSync(descriptor);
  };
  try {
    write();
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  return {
    record,
    write,
    release({ serialize = false } = {}) {
      let fence = null;
      if (!record.childInFlight && serialize) {
        fence = createOwner(`${file}.recovery`);
      }
      fs.closeSync(descriptor);
      if (record.childInFlight || (serialize && !fence)) return;
      try {
        const current = readOwner(file);
        if (
          !current ||
          !sameFile(current.stat, stat) ||
          current.record.nonce !== record.nonce
        )
          return;
        fs.unlinkSync(file);
      } finally {
        fence?.release();
      }
    },
  };
}

function deadIdleOwner(owner) {
  return (
    owner?.record.hostname === os.hostname() &&
    !owner.record.childInFlight &&
    processAbsent(owner.record.pid)
  );
}

function recoverDeadIdleOwner(file, manifestPath, observed) {
  if (!deadIdleOwner(observed)) return null;
  const current = readOwner(file);
  if (
    !current ||
    !sameFile(current.stat, observed.stat) ||
    current.record.nonce !== observed.record.nonce ||
    !deadIdleOwner(current) ||
    quality.loadManifest(manifestPath).manifest.governor?.activeExecution
  )
    return null;
  fs.unlinkSync(file);
  return createOwner(file);
}

function acquireRunner(manifestPath) {
  const file = `${manifestPath}.runner-lock`;
  const fence = createOwner(`${file}.recovery`);
  if (!fence) return null;
  let owner;
  try {
    owner = createOwner(file);
    if (!owner) {
      owner = recoverDeadIdleOwner(file, manifestPath, readOwner(file));
    }
  } finally {
    fence.release();
  }
  if (!owner) return null;
  let uncertain = false;
  let priorUncertain = false;
  let signalUncertain = false;
  let lastChildQuiescent = false;
  let quarantined = false;
  return {
    async execute(execute, command, args, options = {}) {
      if (quarantined)
        throw new Error(
          "quality foreground child process group is not quiescent",
        );
      priorUncertain = uncertain;
      owner.record.childInFlight = true;
      if (owner.record.schemaVersion === 2) owner.record.child = null;
      owner.write();
      const onChild = (child) => {
        options.onChild?.(child);
        if (!child?.pid || owner.record.schemaVersion !== 2) return;
        owner.record.child = {
          pid: child.pid,
          processGroupId: child.pid,
          startedAt: new Date().toISOString(),
        };
        owner.write();
      };
      try {
        const result = await execute(command, args, { ...options, onChild });
        const childQuiescent =
          owner.record.schemaVersion === 2 &&
          owner.record.child &&
          processAbsent(owner.record.child.pid) &&
          processGroupAbsent(owner.record.child.processGroupId);
        lastChildQuiescent = Boolean(childQuiescent);
        uncertain ||=
          signalUncertain ||
          (owner.record.schemaVersion === 2
            ? !childQuiescent
            : result.code !== 0 || Boolean(result.signal));
        owner.record.childInFlight = uncertain;
        if (!uncertain && owner.record.schemaVersion === 2)
          owner.record.child = null;
        owner.write();
        if (
          owner.record.schemaVersion === 2 &&
          result.code === 0 &&
          !result.signal &&
          !childQuiescent
        ) {
          quarantined = true;
          throw new Error(
            "quality foreground child process group is not quiescent",
          );
        }
        return result;
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    acceptTypedPause() {
      uncertain = signalUncertain || priorUncertain || !lastChildQuiescent;
      owner.record.childInFlight = uncertain;
      if (!uncertain && owner.record.schemaVersion === 2)
        owner.record.child = null;
      owner.write();
    },
    markSignalUncertain() {
      signalUncertain = true;
      uncertain = true;
      owner.record.childInFlight = true;
      owner.write();
    },
    release(checkExecution = true) {
      if (
        checkExecution &&
        quality.loadManifest(manifestPath).manifest.governor?.activeExecution
      ) {
        owner.record.childInFlight = true;
        owner.write();
      }
      owner.release({ serialize: true });
    },
  };
}

function reconcileRunner({
  manifestPath,
  expectedHead,
  expectedHost,
  expectedPid,
  expectedNonce,
  confirmLegacyChildQuiescent = false,
}) {
  const loaded = quality.loadManifest(manifestPath);
  manifestPath = fs.realpathSync(loaded.manifestPath);
  const file = `${manifestPath}.runner-lock`;
  const fence = createOwner(`${file}.recovery`);
  if (!fence) throw new Error("runner recovery fence is already owned");
  try {
    const manifest = quality.loadManifest(manifestPath).manifest;
    quality.validateIdentity(manifest, manifest.repo.realpath);
    if (manifest.revisions.currentHead !== expectedHead)
      throw new Error("runner recovery head does not match the manifest");
    if (manifest.governor?.activeExecution)
      throw new Error("runner recovery requires null active execution");
    const observed = readOwner(file);
    if (!observed) throw new Error("runner ownership is missing or malformed");
    const { record, stat } = observed;
    if (
      expectedHost !== os.hostname() ||
      record.hostname !== expectedHost ||
      record.pid !== expectedPid ||
      record.nonce !== expectedNonce
    )
      throw new Error("runner recovery owner binding does not match");
    if (!processAbsent(record.pid))
      throw new Error("runner recovery owner is still live or unverifiable");
    if (record.childInFlight) {
      if (record.schemaVersion === 1) {
        if (!confirmLegacyChildQuiescent)
          throw new Error(
            "legacy runner recovery requires explicit child-quiescence confirmation",
          );
      } else if (
        !record.child ||
        !processAbsent(record.child.pid) ||
        !processGroupAbsent(record.child.processGroupId)
      ) {
        throw new Error("runner recovery child process group is not quiescent");
      }
    }
    const current = readOwner(file);
    if (
      !current ||
      !sameFile(current.stat, stat) ||
      current.record.nonce !== record.nonce
    )
      throw new Error("runner ownership changed during recovery");
    fs.unlinkSync(file);
    return {
      status: "reconciled",
      manifestPath,
      head: manifest.revisions.currentHead,
      owner: {
        hostname: record.hostname,
        pid: record.pid,
        nonce: record.nonce,
      },
      legacyConfirmationUsed:
        record.schemaVersion === 1 && record.childInFlight === true,
    };
  } finally {
    fence.release();
  }
}

module.exports = {
  acquireRunner,
  ownershipSchemaVersion,
  processAbsent,
  processGroupAbsent,
  readOwner,
  reconcileRunner,
  writeAllSync,
};
