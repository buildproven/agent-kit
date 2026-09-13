#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  fixedTrustPath,
  parseProductTrust,
  sha256,
} = require("./product-evidence");

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSafeRootOwned(stat, label) {
  if (stat.uid !== 0) throw new Error(`${label} must be root-owned`);
  if (stat.mode & 0o022) {
    throw new Error(`${label} must not be group or other writable`);
  }
}

function assertSafeDirectory(directory, fsImpl) {
  const stat = fsImpl.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("product trust target directory must be a real directory");
  }
  assertSafeRootOwned(stat, "product trust target directory");
}

function readInstalledRegistry(targetFile, fsImpl) {
  const noFollow = fsImpl.constants?.O_NOFOLLOW;
  if (!noFollow) {
    throw new Error(
      "repository product trust needs O_NOFOLLOW support on this platform",
    );
  }
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      targetFile,
      fsImpl.constants.O_RDONLY | noFollow | fsImpl.constants.O_NONBLOCK,
    );
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error("product trust target must be a regular file");
    }
    const after = fsImpl.lstatSync(targetFile);
    if (!sameFile(opened, after) || after.isSymbolicLink()) {
      throw new Error("product trust target changed while it was opened");
    }
    assertSafeRootOwned(opened, "opened product trust target");
    assertSafeRootOwned(after, "product trust target");
    return fsImpl.readFileSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined && error.code === "ENOENT") {
      throw new Error("product trust target changed while it was read", {
        cause: error,
      });
    }
    if (error.code === "ELOOP") {
      throw new Error("product trust target must not be a symbolic link", {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function assertNoUnapprovedRotation(existing, replacement) {
  const byId = new Map(
    existing.entries.map((entry) => [entry.repositoryId, entry]),
  );
  for (const entry of replacement.entries) {
    const previous = byId.get(entry.repositoryId);
    if (!previous) continue;
    if (
      previous.repository !== entry.repository ||
      previous.producerPublicKey !== entry.producerPublicKey ||
      previous.admissionPublicKey !== entry.admissionPublicKey
    ) {
      throw new Error(
        `product trust key replacement for ${entry.repository} needs an explicit rotation decision`,
      );
    }
  }
  for (const entry of existing.entries) {
    if (
      !replacement.entries.some(
        (candidate) => candidate.repositoryId === entry.repositoryId,
      )
    ) {
      throw new Error(
        `product trust removal for ${entry.repository} needs an explicit rotation decision`,
      );
    }
  }
}

function writeAtomically(targetFile, bytes, fsImpl) {
  const directory = path.dirname(targetFile);
  const temporary = path.join(
    directory,
    `.product-trust-${process.pid}-${crypto.randomBytes(16).toString("hex")}`,
  );
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      temporary,
      fsImpl.constants.O_WRONLY |
        fsImpl.constants.O_CREAT |
        fsImpl.constants.O_EXCL,
      0o644,
    );
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.chownSync(temporary, 0, 0);
    fsImpl.chmodSync(temporary, 0o644);
    fsImpl.renameSync(temporary, targetFile);
    const directoryDescriptor = fsImpl.openSync(
      directory,
      fsImpl.constants.O_RDONLY,
    );
    try {
      fsImpl.fsyncSync(directoryDescriptor);
    } finally {
      fsImpl.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function installProductTrust({
  stagingFile,
  expectedSHA256,
  targetFile = fixedTrustPath(),
  fsImpl = fs,
} = {}) {
  if (!targetFile) {
    throw new Error(`product evidence is unsupported on ${process.platform}`);
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSHA256 || "")) {
    throw new Error("expected product trust SHA-256 is invalid");
  }
  assertSafeDirectory(path.dirname(targetFile), fsImpl);
  const bytes = fsImpl.readFileSync(stagingFile);
  if (sha256(bytes) !== expectedSHA256) {
    throw new Error(
      "product trust staging digest does not match the reviewed SHA-256",
    );
  }
  const replacement = parseProductTrust(bytes);
  let existing = null;
  try {
    existing = parseProductTrust(readInstalledRegistry(targetFile, fsImpl));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    assertNoUnapprovedRotation(existing, replacement);
    if (
      Buffer.compare(
        Buffer.from(bytes),
        Buffer.from(readInstalledRegistry(targetFile, fsImpl)),
      ) === 0
    ) {
      return { installed: false, idempotent: true, targetFile };
    }
  }
  writeAtomically(targetFile, bytes, fsImpl);
  return { installed: true, idempotent: false, targetFile };
}

function main(argv) {
  if (argv.length !== 3 || argv[0] !== "install") {
    throw new Error(
      "usage: install-product-trust.js install <reviewed-staging-file> <expected-sha256>",
    );
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("product trust installation must run with root privileges");
  }
  const result = installProductTrust({
    stagingFile: argv[1],
    expectedSHA256: argv[2],
  });
  process.stdout.write(
    `${result.idempotent ? "already installed" : "installed"} ${result.targetFile}\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `product trust installation failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { installProductTrust };
