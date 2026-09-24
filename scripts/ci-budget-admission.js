#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveStateDirName } = require("./state-dir-name.js");

const API_VERSION = "2026-03-10";

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function locations(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const stateHome =
    env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return {
    policy:
      env.CI_BUDGET_POLICY ||
      path.join(
        configHome,
        resolveStateDirName(configHome),
        "ci-budget-policy.json",
      ),
    snapshot:
      env.CI_BUDGET_SNAPSHOT ||
      path.join(
        stateHome,
        resolveStateDirName(stateHome),
        "ci-budget",
        "snapshot.json",
      ),
  };
}

function ghJson(args, execute = execFileSync) {
  return parseJson(
    execute("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
    `gh ${args.join(" ")} response`,
  );
}

function collect(policy, execute = execFileSync, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const repositories = ghJson(
    [
      "repo",
      "list",
      policy.account,
      "--limit",
      "101",
      "--json",
      "name,isPrivate,isArchived",
    ],
    execute,
  );
  if (repositories.length > 100)
    throw new Error(
      "fleet has more than 100 repositories; refusing a partial billing snapshot",
    );
  const activePrivate = repositories.filter(
    (repo) => repo.isPrivate && !repo.isArchived,
  );
  const privateNames = new Set(activePrivate.map((repo) => repo.name));
  const scope = policy.accountType === "user" ? "users" : "organizations";
  const report = ghJson(
    [
      "api",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      `/${scope}/${policy.account}/settings/billing/usage?year=${year}&month=${month}&product=Actions`,
    ],
    execute,
  );
  const byRepository = {};
  for (const item of report.usageItems || []) {
    if (String(item.product).toLowerCase() !== "actions") continue;
    if (String(item.unitType).toLowerCase() !== "minutes") continue;
    if (!privateNames.has(item.repositoryName)) continue;
    byRepository[item.repositoryName] =
      (byRepository[item.repositoryName] || 0) + Number(item.quantity || 0);
  }
  return {
    schemaVersion: 1,
    collectorVersion: 1,
    source: "github-enhanced-billing-usage",
    account: policy.account,
    fetchedAt: now.toISOString(),
    billingPeriod: { year, month },
    includedMinutes: policy.includedMinutes,
    usedMinutes: Object.values(byRepository).reduce(
      (sum, value) => sum + value,
      0,
    ),
    byRepository,
    apiCallCount: 2,
  };
}

function ageHours(snapshot, now = new Date()) {
  return (now.getTime() - Date.parse(snapshot.fetchedAt)) / 3_600_000;
}

function classify(snapshot, policy, now = new Date()) {
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.fetchedAt)))
    return { state: "unavailable", allowed: false };
  const age = ageHours(snapshot, now);
  if (age > policy.staleHours)
    return { state: "stale", allowed: false, ageHours: age };
  const percent = (snapshot.usedMinutes / policy.includedMinutes) * 100;
  if (percent >= policy.hardLimitPercent)
    return { state: "hard", allowed: false, percent, ageHours: age };
  if (percent >= policy.softLimitPercent)
    return { state: "soft", allowed: true, percent, ageHours: age };
  return { state: "open", allowed: true, percent, ageHours: age };
}

function breakGlassAllowed(policy, mode, now = new Date()) {
  const gate = policy.breakGlass || {};
  return (
    mode === gate.allowedMode && Date.parse(gate.enabledUntil) > now.getTime()
  );
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function evaluate({
  force = false,
  mode = null,
  execute = execFileSync,
  now = new Date(),
  env = process.env,
} = {}) {
  const files = locations(env);
  if (!fs.existsSync(files.policy))
    return { state: "disabled", allowed: true, breakGlass: false };
  const policy = parseJson(fs.readFileSync(files.policy, "utf8"), "CI policy");
  let snapshot;
  if (!force && fs.existsSync(files.snapshot)) {
    snapshot = parseJson(
      fs.readFileSync(files.snapshot, "utf8"),
      "CI budget snapshot",
    );
    if (ageHours(snapshot, now) > policy.cacheHours) snapshot = null;
  }
  if (!snapshot) {
    snapshot = collect(policy, execute, now);
    atomicWrite(files.snapshot, snapshot);
  }
  const admission = classify(snapshot, policy, now);
  const breakGlass = !admission.allowed && breakGlassAllowed(policy, mode, now);
  return {
    ...admission,
    allowed: admission.allowed || breakGlass,
    breakGlass,
    mode,
    snapshot,
  };
}

if (require.main === module) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : null;
  try {
    const result = evaluate({ force: process.argv.includes("--force"), mode });
    console.log(JSON.stringify(result, null, 2));
    if (!result.allowed) process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "unavailable",
        allowed: false,
        error: error.message,
      }),
    );
    // Exit 2 is reserved for a valid policy decision that denies new CI
    // spend. Operational, validation, and provider failures must not be
    // eligible for the signed billing-denial recovery capability.
    process.exitCode = 1;
  }
}

module.exports = {
  ageHours,
  breakGlassAllowed,
  classify,
  collect,
  evaluate,
  locations,
};
