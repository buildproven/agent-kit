#!/usr/bin/env node

"use strict";

/**
 * Operator-scoped admission and handoff controls for unattended agent loops.
 *
 * State lives outside the repository so independent checkouts share one cap and
 * an autonomous run never dirties the repository it is meant to audit. Usage
 * adapters are deliberately external: Claude Code has no stable public account
 * usage API, and this runtime must never scrape or persist credentials.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_LOOPS = 2;
const DEFAULT_MAX_UTILIZATION_PERCENT = 70;
const DEFAULT_CONTEXT_CAP_TOKENS = 80_000;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

class RuntimeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

function stateHome(environment = process.env) {
  return (
    environment.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  );
}

function runtimeDirectory(environment = process.env) {
  return path.join(stateHome(environment), "claude-kit", "autonomous-loops");
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new RuntimeError(
      `${name} must be a positive integer`,
      "INVALID_ARGUMENT",
    );
  }
  return candidate;
}

function nonNegativeInteger(value, name) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new RuntimeError(
      `${name} must be a non-negative integer`,
      "INVALID_ARGUMENT",
    );
  }
  return candidate;
}

function percentage(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate < 0 || candidate > 100) {
    throw new RuntimeError(
      `${name} must be a percentage from 0 through 100`,
      "INVALID_ARGUMENT",
    );
  }
  return candidate;
}

function requireValue(options, name) {
  const value = options[name];
  if (!value || typeof value !== "string") {
    throw new RuntimeError(`--${name} is required`, "INVALID_ARGUMENT");
  }
  return value;
}

function recordIdentity(options) {
  if (options.id) return { idHash: hash(requireValue(options, "id")) };
  const idHash = requireValue(options, "record-hash");
  if (!/^[a-f0-9]{64}$/.test(idHash)) {
    throw new RuntimeError(
      "--record-hash must be a SHA-256 hex digest",
      "INVALID_ARGUMENT",
    );
  }
  return { idHash };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new RuntimeError(
        `unexpected argument: ${token}`,
        "INVALID_ARGUMENT",
      );
    }
    const name = token.slice(2);
    if (!name || name.includes("=")) {
      throw new RuntimeError(`invalid argument: ${token}`, "INVALID_ARGUMENT");
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new RuntimeError(`--${name} requires a value`, "INVALID_ARGUMENT");
    }
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function writeJsonExclusively(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.linkSync(temporary, file);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new RuntimeError(
        "this autonomous loop is already admitted",
        "ALREADY_ADMITTED",
      );
    }
    throw error;
  } finally {
    fs.unlinkSync(temporary);
  }
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw new RuntimeError(
      `refusing symlinked state file: ${file}`,
      "UNSAFE_PATH",
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new RuntimeError(
      `invalid JSON in ${file}: ${error.message}`,
      "INVALID_STATE",
    );
  }
}

function withGlobalLock(directory, callback) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".admission.lock");
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
  if (!acquired) {
    throw new RuntimeError(
      "timed out acquiring global autonomous-loop lock",
      "LOCK_TIMEOUT",
    );
  }
  try {
    return callback();
  } finally {
    fs.rmdirSync(lock);
  }
}

function processStartedAt(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const marker = result.stdout.trim();
  return marker || null;
}

function isLive(record) {
  if (
    !record ||
    record.hostname !== os.hostname() ||
    !Number.isInteger(record.pid)
  ) {
    return true;
  }
  try {
    process.kill(record.pid, 0);
    if (!record.processStartedAt) return true;
    return processStartedAt(record.pid) === record.processStartedAt;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function activeRecords(directory) {
  const records = [];
  for (const name of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      !name.isFile() ||
      !name.name.endsWith(".json") ||
      name.name === "telemetry.jsonl"
    ) {
      continue;
    }
    const file = path.join(directory, name.name);
    let record;
    try {
      record = readJson(file);
    } catch {
      // An unreadable record may represent an active run. Retain it fail-closed.
      records.push({ file, invalid: true });
      continue;
    }
    if (isLive(record)) {
      records.push({ file, ...record });
    } else {
      fs.unlinkSync(file);
    }
  }
  return records;
}

function appendTelemetry(directory, event) {
  const record = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(
    path.join(directory, "telemetry.jsonl"),
    `${JSON.stringify(record)}\n`,
    {
      mode: 0o600,
    },
  );
}

function usageFromAdapter(command) {
  const result = spawnSync(command, [], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) {
    throw new RuntimeError("Claude usage adapter failed", "USAGE_UNAVAILABLE");
  }
  let usage;
  try {
    usage = JSON.parse(result.stdout);
  } catch {
    throw new RuntimeError(
      "Claude usage adapter returned invalid JSON",
      "USAGE_UNAVAILABLE",
    );
  }
  const fiveHourPercent = usage.fiveHourPercent;
  const sevenDayPercent = usage.sevenDayPercent;
  if (
    !Number.isFinite(fiveHourPercent) ||
    fiveHourPercent < 0 ||
    fiveHourPercent > 100 ||
    !Number.isFinite(sevenDayPercent) ||
    sevenDayPercent < 0 ||
    sevenDayPercent > 100
  ) {
    throw new RuntimeError(
      "Claude usage adapter must return fiveHourPercent and sevenDayPercent from 0 through 100",
      "USAGE_UNAVAILABLE",
    );
  }
  return { fiveHourPercent, sevenDayPercent };
}

function admit(options, environment = process.env) {
  const kind = requireValue(options, "kind");
  const id = requireValue(options, "id");
  const adapter = options["usage-command"];
  const provider = adapter ? null : requireValue(options, "provider");
  const maxLoops = positiveInteger(
    options["max-loops"],
    "max-loops",
    DEFAULT_MAX_LOOPS,
  );
  const maxUtilization = percentage(
    options["max-utilization-percent"],
    "max-utilization-percent",
    DEFAULT_MAX_UTILIZATION_PERCENT,
  );
  // The admission command is intentionally short-lived, so it cannot infer a
  // reliable owner from its own parent process. Require the long-lived loop
  // launcher to bind the slot explicitly rather than silently creating a
  // record that will immediately look stale.
  const ownerPid = positiveInteger(
    requireValue(options, "owner-pid"),
    "owner-pid",
  );
  if (!isLive({ hostname: os.hostname(), pid: ownerPid })) {
    throw new RuntimeError(
      "--owner-pid must identify a live local process",
      "OWNER_NOT_LIVE",
    );
  }
  const ownerStartedAt = processStartedAt(ownerPid);
  if (!ownerStartedAt) {
    throw new RuntimeError(
      "--owner-pid must identify a readable local process",
      "OWNER_NOT_LIVE",
    );
  }
  const directory = options["state-dir"]
    ? path.resolve(options["state-dir"])
    : runtimeDirectory(environment);
  const idHash = hash(id);

  return withGlobalLock(directory, () => {
    const active = activeRecords(directory);
    const recordFile = path.join(directory, `${idHash}.json`);
    if (active.some((record) => record.file === recordFile)) {
      throw new RuntimeError(
        "this autonomous loop is already admitted",
        "ALREADY_ADMITTED",
      );
    }
    if (active.length >= maxLoops) {
      appendTelemetry(directory, {
        event: "admission",
        result: "concurrency-cap",
        kind,
        idHash,
        activeLoops: active.length,
      });
      throw new RuntimeError(
        `global autonomous-loop cap reached (${active.length}/${maxLoops})`,
        "CONCURRENCY_CAP",
      );
    }
    let usage;
    try {
      if (adapter) {
        usage = usageFromAdapter(adapter);
      } else {
        try {
          usage = require("./provider-usage-adapter.js").readProviderUsage(
            provider,
          );
          if (
            options.fallback &&
            options.fallback !== "none" &&
            options.fallback !== provider
          ) {
            const fallbackUsage =
              require("./provider-usage-adapter.js").readProviderUsage(
                options.fallback,
              );
            Object.assign(
              usage.windows,
              Object.fromEntries(
                Object.entries(fallbackUsage.windows).map(([window, value]) => [
                  `${options.fallback}-${window}`,
                  value,
                ]),
              ),
            );
          }
        } catch (error) {
          throw new RuntimeError(error.message, "USAGE_UNAVAILABLE");
        }
      }
    } catch (error) {
      appendTelemetry(directory, {
        event: "admission",
        result: "usage-unavailable",
        kind,
        idHash,
      });
      throw error;
    }
    if (
      Math.max(
        ...(usage.windows
          ? Object.values(usage.windows)
          : [usage.fiveHourPercent, usage.sevenDayPercent]),
      ) >= maxUtilization
    ) {
      appendTelemetry(directory, {
        event: "admission",
        result: "usage-cap",
        kind,
        idHash,
        usage,
      });
      throw new RuntimeError(
        `Claude usage is at or above the ${maxUtilization}% autonomous-loop limit`,
        "USAGE_CAP",
      );
    }
    const record = {
      schemaVersion: 1,
      kind,
      idHash,
      // `admit` is a short-lived child of the autonomous loop. Recording its
      // own PID would immediately make every slot stale after the command
      // exits, defeating the cross-repository cap. The parent is the loop
      // owner unless a launcher supplies its exact PID explicitly.
      pid: ownerPid,
      processStartedAt: ownerStartedAt,
      hostname: os.hostname(),
      admittedAt: new Date().toISOString(),
    };
    writeJsonExclusively(recordFile, record);
    appendTelemetry(directory, {
      event: "admission",
      result: "admitted",
      kind,
      idHash,
      activeLoops: active.length + 1,
      usage,
    });
    return { admitted: true, stateDir: directory, recordFile, usage };
  });
}

function release(options, environment = process.env) {
  const { idHash } = recordIdentity(options);
  const ownerPid = positiveInteger(
    requireValue(options, "owner-pid"),
    "owner-pid",
  );
  const directory = options["state-dir"]
    ? path.resolve(options["state-dir"])
    : runtimeDirectory(environment);
  const ownerStartedAt = processStartedAt(ownerPid);
  if (!ownerStartedAt) {
    throw new RuntimeError(
      "--owner-pid must identify a readable local process",
      "OWNER_NOT_LIVE",
    );
  }
  return withGlobalLock(directory, () => {
    const recordFile = path.join(directory, `${idHash}.json`);
    if (!fs.existsSync(recordFile))
      return { released: false, stateDir: directory };
    const record = readJson(recordFile);
    if (record.idHash !== idHash) {
      throw new RuntimeError(
        "admission record identity mismatch",
        "INVALID_STATE",
      );
    }
    if (record.pid !== ownerPid || record.processStartedAt !== ownerStartedAt) {
      throw new RuntimeError(
        "only the admitted loop owner can release this slot",
        "OWNER_MISMATCH",
      );
    }
    fs.unlinkSync(recordFile);
    appendTelemetry(directory, {
      event: "release",
      result: "released",
      kind: record.kind,
      idHash,
    });
    return { released: true, stateDir: directory };
  });
}

function repair(options, environment = process.env) {
  const { idHash } = recordIdentity(options);
  if (requireValue(options, "confirm") !== "remove-corrupt-record") {
    throw new RuntimeError(
      "--confirm must be remove-corrupt-record",
      "INVALID_ARGUMENT",
    );
  }
  const directory = options["state-dir"]
    ? path.resolve(options["state-dir"])
    : runtimeDirectory(environment);
  return withGlobalLock(directory, () => {
    const recordFile = path.join(directory, `${idHash}.json`);
    if (!fs.existsSync(recordFile)) {
      return { repaired: false, stateDir: directory };
    }
    try {
      readJson(recordFile);
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "INVALID_STATE") {
        throw error;
      }
      fs.unlinkSync(recordFile);
      appendTelemetry(directory, {
        event: "repair",
        result: "corrupt-record-removed",
        idHash,
      });
      return { repaired: true, stateDir: directory };
    }
    throw new RuntimeError(
      "refusing to remove a readable admission record",
      "REPAIR_NOT_NEEDED",
    );
  });
}

function contextBreak(options) {
  const stateFile = path.resolve(requireValue(options, "state"));
  const observedTokens = nonNegativeInteger(
    requireValue(options, "observed-tokens"),
    "observed-tokens",
  );
  const capTokens = positiveInteger(
    options["cap-tokens"],
    "cap-tokens",
    DEFAULT_CONTEXT_CAP_TOKENS,
  );
  const state = readJson(stateFile);
  if (observedTokens < capTokens) {
    return { breakRequired: false, observedTokens, capTokens };
  }
  const handoff = {
    schemaVersion: 1,
    reason: "context-cap",
    observedTokens,
    capTokens,
    requestedAt: new Date().toISOString(),
  };
  const next = {
    ...state,
    continuation: handoff,
  };
  writeJsonAtomically(stateFile, next);
  return { breakRequired: true, observedTokens, capTokens, handoff };
}

function freshLaunch(options, environment = process.env) {
  const handoff = path.resolve(requireValue(options, "handoff"));
  const targetDir = path.resolve(requireValue(options, "target-dir"));
  const workflow = requireValue(options, "workflow");
  const stat = fs.lstatSync(handoff);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RuntimeError(
      "handoff must be a regular, non-symlinked file",
      "UNSAFE_PATH",
    );
  }
  const handoffState = readJson(handoff);
  const prompt = [
    "Start a fresh autonomous campaign; do not resume, continue, or fork a prior session.",
    `Workflow: /bs:${workflow}`,
    `Target directory: ${targetDir}`,
    `Authoritative handoff: ${handoff}`,
    "Read that handoff and continue only the remaining work it records.",
  ].join("\n");
  const claude =
    options["claude-bin"] || environment.BS_AUTONOMOUS_CLAUDE_BIN || "claude";
  const childEnvironment = { ...environment };
  delete childEnvironment.CLAUDE_CODE_SESSION_ID;
  delete childEnvironment.CLAUDE_SESSION_ID;
  delete childEnvironment.CLAUDE_CODE_ENTRYPOINT;
  const result = spawnSync(
    claude,
    ["--print", "--no-session-persistence", "--output-format", "json", prompt],
    {
      cwd: targetDir,
      env: childEnvironment,
      encoding: "utf8",
      // The CLI itself has a JSON stdout contract. Keep provider output from
      // interleaving with the final runtime result while preserving diagnostics.
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (result.error) {
    throw new RuntimeError(
      `could not launch fresh Claude campaign: ${result.error.message}`,
      "LAUNCH_FAILED",
    );
  }
  if (result.status !== 0) {
    throw new RuntimeError(
      `fresh Claude campaign exited with status ${result.status}`,
      "LAUNCH_FAILED",
    );
  }
  let providerResponse;
  try {
    providerResponse = JSON.parse(result.stdout);
  } catch {
    throw new RuntimeError(
      "fresh Claude campaign returned invalid JSON",
      "LAUNCH_FAILED",
    );
  }
  if (providerResponse.is_error === true || providerResponse.result == null) {
    throw new RuntimeError(
      "fresh Claude campaign did not report a successful result",
      "LAUNCH_FAILED",
    );
  }
  if (Object.hasOwn(handoffState, "continuation")) {
    const resumedState = { ...handoffState };
    delete resumedState.continuation;
    writeJsonAtomically(handoff, resumedState);
  }
  return { launched: true, handoff, targetDir, workflow };
}

function runCli() {
  const { command, options } = parseArguments(process.argv.slice(2));
  let result;
  switch (command) {
    case "admit":
      result = admit(options);
      break;
    case "release":
      result = release(options);
      break;
    case "repair":
      result = repair(options);
      break;
    case "context-break":
      result = contextBreak(options);
      break;
    case "fresh-launch":
      result = freshLaunch(options);
      break;
    default:
      throw new RuntimeError(
        "usage: autonomous-loop-runtime.js admit|release|repair|context-break|fresh-launch [--option value]",
        "INVALID_COMMAND",
      );
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    const code =
      error instanceof RuntimeError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(
      `${JSON.stringify({ ok: false, code, error: error.message })}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CONTEXT_CAP_TOKENS,
  DEFAULT_MAX_LOOPS,
  DEFAULT_MAX_UTILIZATION_PERCENT,
  RuntimeError,
  admit,
  contextBreak,
  freshLaunch,
  repair,
  release,
  runtimeDirectory,
};
