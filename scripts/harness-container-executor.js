#!/usr/bin/env node
"use strict";

// Baseline-owned Docker argv for untrusted harness gates. Candidate data is
// mounted only under /candidate; policy and limits are not caller-configurable.
const LIMITS = Object.freeze({ cpus: "2", memory: "3g", pids: "128" });

function fail(message) {
  throw new Error(`harness-container-executor: ${message}`);
}

function absolute(directory, name) {
  if (typeof directory !== "string" || !directory.startsWith("/"))
    fail(`${name} must be an absolute path`);
  return directory;
}

function invocation({ image, candidate, toolchain, command }) {
  if (typeof image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image))
    fail("image must be a pinned sha256 digest");
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
    "--mount",
    `type=bind,src=${absolute(candidate, "candidate")},dst=/candidate,rw`,
    "--mount",
    `type=bind,src=${absolute(toolchain, "toolchain")},dst=/toolchain,readonly`,
    "--workdir",
    "/candidate",
    image,
    ...command,
  ];
}

module.exports = { LIMITS, invocation };
