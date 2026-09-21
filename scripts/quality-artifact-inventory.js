"use strict";

// Review artifact inventory is a complete evidence boundary: it chooses the
// provider-owned artifacts, rejects incomplete reports, and writes the
// hash-bound record that later review verification consumes (BUI-905).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function providerEvidenceName(name, provider) {
  if (provider === "policy-exempt") {
    return ["policy-exempt.findings.txt", "policy-exempt.result.json"].includes(
      name,
    );
  }
  if (provider === "review-incomplete") {
    return (
      [
        "review-incomplete.findings.txt",
        "review-incomplete.result.json",
      ].includes(name) ||
      /^primary-(?:codex|gemini|claude)-.+\.result\.json$/.test(name) ||
      /^(?:codex|gemini)-\d+\.normalized\.json$/.test(name) ||
      (!/^(?:codex|gemini|primary)-/.test(name) &&
        name.endsWith(".normalized.json"))
    );
  }
  if (/^primary-(?:codex|gemini|claude)-/.test(name)) return true;
  if (provider === "codex") {
    return (
      name === "codex.findings.txt" ||
      /^codex-\d+(?:\.normalized)?\.json$/.test(name)
    );
  }
  if (provider === "gemini") {
    return (
      name === "gemini.findings.txt" ||
      /^gemini-\d+(?:\.normalized)?\.json$/.test(name)
    );
  }
  if (provider === "claude") {
    return (
      (name.endsWith(".findings.txt") ||
        name.endsWith(".result.json") ||
        name.endsWith(".normalized.json")) &&
      !/^(?:codex|gemini)(?:-|\.)/.test(name)
    );
  }
  throw new Error(`unsupported review provider '${provider}'`);
}

function writeArtifactInventory(
  manifest,
  artifactDir,
  provider,
  { advisory = false, exempt = false, incomplete = false } = {},
  { reviewInfo, atomicWrite },
) {
  const resolved = path.resolve(artifactDir);
  const info = reviewInfo(manifest);
  if (resolved !== path.resolve(info.artifactDir)) {
    throw new Error("artifact inventory directory identity mismatch");
  }
  const names = fs
    .readdirSync(resolved)
    .filter(
      (name) =>
        name.endsWith(".findings.txt") ||
        name.endsWith(".result.json") ||
        name.endsWith(".normalized.json") ||
        /^(?:codex|gemini)-\d+(?:\.normalized)?\.json$/.test(name),
    )
    .filter((name) => providerEvidenceName(name, provider))
    .sort();
  const findings = names.filter((name) => name.endsWith(".findings.txt"));
  if (findings.length === 0) throw new Error("provider findings are missing");
  if (
    provider === "claude" &&
    !advisory &&
    findings.length !== manifest.agents.length
  ) {
    throw new Error(
      "Claude findings inventory does not cover the mandatory panel",
    );
  }
  const inconclusiveFindings = findings.filter((name) => {
    const text = fs.readFileSync(path.join(resolved, name), "utf8");
    return (
      !text.trim() ||
      text.split(/\r?\n/).some((line) => line.startsWith("INCONCLUSIVE:"))
    );
  });
  const panelSize =
    exempt || incomplete
      ? 0
      : provider === "claude" && !advisory
        ? manifest.agents.length
        : findings.length;
  const usableFindings = findings.length - inconclusiveFindings.length;
  if (usableFindings < panelSize) {
    throw new Error(
      `inconclusive provider findings cannot be inventoried: only ${usableFindings}/${panelSize} usable reports (need ${panelSize})`,
    );
  }
  const inventory = {
    schemaVersion: 1,
    invocationId: manifest.invocationId,
    headSha: manifest.revisions.currentHead,
    provider,
    status: exempt ? "exempt" : incomplete ? "incomplete" : "success",
    tier: manifest.risk.tier,
    focusSha256:
      (manifest.reviewContractVersion || 1) >= 2 &&
      manifest.panel?.rule &&
      !manifest.panel.rule.startsWith("legacy")
        ? sha256File(path.join(resolved, "review-focus.txt"))
        : null,
    panel: manifest.panel || {
      requiredAgents: manifest.agents.length,
      selectedAgents: manifest.agents.length,
      incomplete: false,
    },
    files: names.map((name) => {
      const preservedMatch = name.match(/^primary-(codex|gemini|claude)-/);
      const nativeMatch = name.match(/^(codex|gemini)-\d+\.normalized\.json$/);
      const partialClaude =
        provider === "review-incomplete" &&
        !preservedMatch &&
        !nativeMatch &&
        name.endsWith(".normalized.json");
      return {
        name,
        provider: preservedMatch
          ? preservedMatch[1]
          : nativeMatch
            ? nativeMatch[1]
            : partialClaude
              ? "claude"
              : provider,
        sha256: sha256File(path.join(resolved, name)),
      };
    }),
  };
  atomicWrite(path.join(resolved, "artifact-inventory.json"), inventory);
}

module.exports = { writeArtifactInventory };
