#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveStateDirName } = require("./state-dir-name.js");

const SCHEMA_VERSION = 1;
const PROVIDERS = new Set(["claude", "codex", "gemini"]);
const CATEGORIES = new Set(["provider-exhaustion", "provider-billing"]);
const PROBE_DELAYS_MS = {
  "provider-exhaustion": 60 * 60 * 1000,
  "provider-billing": 6 * 60 * 60 * 1000,
};

function defaultStateFile() {
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(
    stateHome,
    resolveStateDirName(stateHome),
    "quality-provider-health.json",
  );
}

function validateProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new Error(`invalid provider '${provider}'`);
  }
}

function providerStateFile(file, provider) {
  validateProvider(provider);
  return path.join(`${file}.d`, `${provider}.json`);
}

function readLegacyFailure(file, provider) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !parsed.providers ||
      (parsed.providers[provider] &&
        !CATEGORIES.has(parsed.providers[provider].category))
    ) {
      throw new Error("provider-health schema is invalid");
    }
    return parsed.providers[provider] || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readProviderState(file, provider) {
  const providerFile = providerStateFile(file, provider);
  try {
    const parsed = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    if (
      parsed.schemaVersion !== SCHEMA_VERSION ||
      parsed.provider !== provider ||
      (parsed.failure !== null && !CATEGORIES.has(parsed.failure?.category))
    ) {
      throw new Error("provider-health schema is invalid");
    }
    return parsed.failure;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return readLegacyFailure(file, provider);
  }
}

function readState(file) {
  const providers = {};
  for (const provider of PROVIDERS) {
    const failure = readProviderState(file, provider);
    if (failure) providers[provider] = failure;
  }
  return { schemaVersion: SCHEMA_VERSION, providers };
}

function writeProviderState(file, provider, failure) {
  const root = `${file}.d`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const providerFile = providerStateFile(file, provider);
  const temporary = path.join(
    root,
    `.${provider}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(
      { schemaVersion: SCHEMA_VERSION, provider, failure },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporary, providerFile);
  fs.chmodSync(providerFile, 0o600);
}

function providerAvailability(root, provider, now = Date.now()) {
  const failure = readProviderState(root, provider);
  if (!failure) return { available: true };
  if (failure.probeAt && Date.parse(failure.probeAt) <= now) {
    return {
      available: true,
      probe: true,
      priorFailure: failure.category,
    };
  }
  return { available: false, ...failure };
}

function recordProviderFailure(root, provider, failure, now = Date.now()) {
  validateProvider(provider);
  if (!CATEGORIES.has(failure?.category)) {
    throw new Error(`invalid provider failure '${failure?.category}'`);
  }
  const recordedAt = new Date(now).toISOString();
  const typedReset = Date.parse(failure.resetAt || "");
  const probeAt = new Date(
    Number.isFinite(typedReset)
      ? Math.max(typedReset, now)
      : now + PROBE_DELAYS_MS[failure.category],
  ).toISOString();
  writeProviderState(root, provider, {
    category: failure.category,
    resetAt: failure.resetAt || null,
    recordedAt,
    probeAt,
  });
}

function clearProviderFailure(root, provider) {
  validateProvider(provider);
  // A null per-provider record is an intentional tombstone. It prevents a
  // migrated legacy aggregate file from resurrecting a circuit after clear.
  writeProviderState(root, provider, null);
}

function readFailureEvidence(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`provider failure evidence is not valid JSON: ${file}`, {
      cause: error,
    });
  }
}

function main() {
  const [command, provider, evidence] = process.argv.slice(2);
  const file =
    process.env.BS_QUALITY_PROVIDER_HEALTH_FILE || defaultStateFile();
  if (command === "check") {
    const availability = providerAvailability(file, provider);
    process.stdout.write(`${JSON.stringify(availability)}\n`);
    if (!availability.available) {
      process.exitCode = availability.category === "provider-billing" ? 79 : 75;
    }
    return;
  }
  if (command === "record") {
    if (!evidence) throw new Error("record requires a failure evidence file");
    recordProviderFailure(file, provider, readFailureEvidence(evidence));
    return;
  }
  if (command === "clear") {
    clearProviderFailure(file, provider);
    return;
  }
  throw new Error(
    "usage: quality-provider-health.js check|record|clear <provider> [evidence]",
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality provider health: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  clearProviderFailure,
  defaultStateFile,
  providerAvailability,
  readState,
  recordProviderFailure,
};
