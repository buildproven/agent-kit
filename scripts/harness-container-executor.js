#!/usr/bin/env node
"use strict";

// Baseline-owned Docker argv for untrusted harness gates. Candidate data is
// source-only: the baseline copies it into a fixed-size container tmpfs before
// execution. Policy and limits are not caller-configurable.
const LIMITS = Object.freeze({ cpus: "2", memory: "3g", pids: "128" });
const WORKSPACE_LIMIT = "1g";
const TMP_LIMIT = "64m";
const ENTRYPOINT = 'cp -a /source/. /candidate/; cd /candidate; exec "$@"';

function fail(message) {
  throw new Error(`harness-container-executor: ${message}`);
}

function absolute(directory, name) {
  if (typeof directory !== "string" || !directory.startsWith("/"))
    fail(`${name} must be an absolute path`);
  return directory;
}

function invocation({ image, candidate, toolchain, command }) {
  if (
    typeof image !== "string" ||
    !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(image)
  )
    fail("image must be a pinned image reference with a sha256 digest");
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((v) => typeof v !== "string")
  )
    fail("command must be a non-empty argv array");
  return [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--cpus",
    LIMITS.cpus,
    "--memory",
    LIMITS.memory,
    "--pids-limit",
    LIMITS.pids,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    `/candidate:rw,exec,nosuid,nodev,size=${WORKSPACE_LIMIT}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${TMP_LIMIT}`,
    "--mount",
    `type=bind,src=${absolute(candidate, "candidate")},dst=/source,readonly`,
    "--mount",
    `type=bind,src=${absolute(toolchain, "toolchain")},dst=/toolchain,readonly`,
    image,
    "/bin/sh",
    "-ceu",
    ENTRYPOINT,
    "harness-certification",
    ...command,
  ];
}

module.exports = { ENTRYPOINT, LIMITS, TMP_LIMIT, WORKSPACE_LIMIT, invocation };
