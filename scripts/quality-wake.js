"use strict";

// Host-side registration for an existing campaign. This module creates no
// campaign, grants no retry and does not reset any execution budget.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const quality = require("./quality-invocation");
const { atomicCreate } = require("./quality-manifest-io");
const { parseStopAt } = require("./quality-run");

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

module.exports = { registerQuality, readRegistration, controllerIdentity };
