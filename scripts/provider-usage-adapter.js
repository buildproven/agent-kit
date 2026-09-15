#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

/** Read fresh usage for the provider that will execute the loop. */
function readProviderUsage(
  provider,
  { run = spawnSync, now = Date.now() } = {},
) {
  if (!["codex", "claude"].includes(provider)) {
    throw new Error("Select the loop provider with --provider codex|claude");
  }
  const result = run(
    "codexbar",
    [
      "usage",
      "--provider",
      provider,
      "--format",
      "json",
      "--no-credits",
      "--source",
      provider === "codex" ? "oauth" : "auto",
    ],
    {
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "Usage unavailable: install CodexBar CLI and sign in to the selected provider on this computer",
    );
  }
  const usage = parseProviderRecord(result.stdout, provider);
  const observedAt = Date.parse(usage?.updatedAt);
  if (
    !Number.isFinite(observedAt) ||
    now - observedAt > 300_000 ||
    observedAt > now + 30_000
  ) {
    throw new Error("Usage evidence is missing, stale, or future-dated");
  }
  return { provider, windows: capacityWindows(usage) };
}

function parseProviderRecord(output, provider) {
  let records;
  try {
    records = JSON.parse(output);
  } catch {
    throw new Error("Usage reader returned invalid JSON");
  }
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    records[0].provider !== provider ||
    records[0].error
  ) {
    throw new Error(
      "Usage reader returned an ambiguous or mismatched provider",
    );
  }
  return records[0].usage;
}

function capacityWindows(usage) {
  const windows = {};
  for (const key of ["primary", "secondary", "tertiary"]) {
    const window = usage[key];
    if (window == null) continue;
    if (
      typeof window.usedPercent !== "number" ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100
    ) {
      throw new Error("Usage window is invalid");
    }
    windows[key] = window.usedPercent;
  }
  if (!Object.keys(windows).length)
    throw new Error("Usage reader returned no capacity windows");
  return windows;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--provider")
      throw new Error(
        "Usage: provider-usage-adapter.js --provider codex|claude",
      );
    process.stdout.write(`${JSON.stringify(readProviderUsage(args[1]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { readProviderUsage };
