#!/usr/bin/env node
"use strict";

const invocation = require("./quality-invocation");
const fs = require("fs");
const worktrees = require("./worktree-manager");

function currentGateStatus(manifest, name, failure = {}) {
  if (failure.category === "repository-gate" && failure.gate === name) {
    return "failed";
  }
  const evidence = [...(manifest.gates || [])]
    .reverse()
    .find(
      (gate) =>
        gate.name === name && gate.head === manifest.revisions.currentHead,
    );
  return evidence?.status || "pending";
}

function providerStatus(manifest, failure) {
  const provider = failure.provider || "provider";
  const failures = {
    "provider-exhaustion": `blocked — ${provider} exhaustion; reset ${
      failure.resetAt || "time unavailable"
    }`,
    "parser-inconclusive": `blocked — ${provider} review output was inconclusive`,
    "provider-unavailable": `blocked — ${provider} CLI or authentication unavailable`,
    "provider-timeout": `blocked — ${provider} exceeded its bounded review budget`,
    "provider-governor": "blocked — provider attempt cap or deadline exhausted",
    "provider-error": `blocked — ${provider} review runner failed`,
    "provider-billing": `blocked — ${provider} billing or credits failure`,
    "code-findings": "blocked — actionable code findings remain",
  };
  if (failures[failure.category]) return failures[failure.category];
  const successfulReviews = (manifest.reviews || []).filter(
    (review) => review.status === "success",
  );
  const advisoryReviews = (manifest.reviews || []).filter(
    (review) => review.status === "advisory",
  );
  if (advisoryReviews.length > 0) {
    return `${advisoryReviews.length} CI-only advisory checkpoint(s) complete`;
  }
  return successfulReviews.length > 0
    ? `${successfulReviews.length} checkpoint(s) complete`
    : "not completed";
}

function breakGlassStatus(manifest) {
  // A manifest created before mergeAuthority was introduced must report the
  // same manual-governance requirement that final authorization enforces.
  const mergeAuthority = manifest.risk?.mergeAuthority || "human-required";
  if (mergeAuthority !== "human-required") {
    return "not required (autonomous merge authority)";
  }
  if (manifest.risk?.tier !== "critical") {
    // The terminal diagnosis does not re-run the authoritative floor matcher;
    // avoid claiming routine manual-governance campaigns need approval when
    // only an exceptional human-floor path could require it.
    return "not required unless the manual security floor applies";
  }
  if (
    manifest.approval?.approved === true &&
    invocation.approvalValid(manifest, manifest.repo.realpath)
  ) {
    return `approved through ${manifest.approval.expiresAt}`;
  }
  return "required and missing or stale";
}

function worktreeLockStatus(manifest) {
  try {
    const target = fs.realpathSync(manifest.repo.realpath);
    const result = worktrees.status({
      repo: target,
      skipPrCheck: true,
    });
    const record = result.worktrees.find((candidate) => {
      try {
        return fs.realpathSync(candidate.path) === target;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    if (!record) return "not tracked";
    return record.locked
      ? `locked by ${record.lockReason || "unknown owner"}`
      : "released";
  } catch (error) {
    if (error.code === "ENOENT") return "not tracked (worktree removed)";
    return `status unavailable — ${error.message}`;
  }
}

function repositoryLeaseStatus(manifestPath, manifest) {
  if (manifest.options?.merge !== true) return "not required";
  try {
    const status = require("./quality-repo-lease").status(manifestPath);
    if (status.state === "missing") return "missing — merge remains blocked";
    return (
      `${status.state} for ${status.repository} PR #${status.pr}; ` +
      `owner=${status.manifestPath}; generation=${status.generation}; renewed=${status.renewedAt}` +
      (status.mergeGuard
        ? `; merge-quarantine=head ${status.mergeGuard.head}, request-started=${status.mergeGuard.requestStartedAt || "no"}, admin=${status.mergeGuard.admin === true}`
        : "") +
      (status.recoveryCommand ? `; recovery=${status.recoveryCommand}` : "")
    );
  } catch (error) {
    return `status unavailable — ${error.message}`;
  }
}

function activeBudgetStatus(manifest) {
  const governor = manifest.governor || {};
  const used = governor.activeSecondsUsed;
  const limit = governor.activeSecondsLimit;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) {
    return "unavailable";
  }
  return `${used}s used / ${limit}s shared active limit; lifecycle idle time excluded`;
}

function terminalStatus(manifest) {
  const terminal = manifest.terminalState;
  if (!terminal) return "open";
  if (terminal.state !== "interrupted") return terminal.state;
  if (manifest.governor?.activeExecution) {
    return "interrupted — recovery waits for active execution reconciliation";
  }
  return terminal.head === manifest.revisions?.currentHead
    ? "interrupted — exact resume will continue unfinished phases"
    : "interrupted at prior HEAD — descendant resume will archive it";
}

function buildDiagnosis(manifestPath, manifest, failure = {}) {
  const gates = (manifest.requiredGates || [])
    .map(
      (gate) =>
        `${gate.name}=${currentGateStatus(manifest, gate.name, failure)}`,
    )
    .join(", ");
  const ciStatus =
    failure.category === "github-ci"
      ? `failed — ${failure.detail || "required check failure"}`
      : "not checked by this failure path";

  return [
    "",
    "QUALITY TERMINAL DIAGNOSIS",
    `Campaign terminal: ${terminalStatus(manifest)}`,
    `Repository gates: ${gates || "none discovered"}`,
    `Provider review/checkpoint: ${providerStatus(manifest, failure)}`,
    `Active execution: ${activeBudgetStatus(manifest)}`,
    `Break-glass: ${breakGlassStatus(manifest)}`,
    `Worktree lock: ${worktreeLockStatus(manifest)}`,
    `Repository merge lease: ${repositoryLeaseStatus(manifestPath, manifest)}`,
    `GitHub CI: ${ciStatus}`,
    `Retry/resume: /bs:quality --manifest ${manifestPath}`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || !argv[index + 1]) {
      throw new Error(`invalid argument '${key}'`);
    }
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
      argv[++index];
  }
  if (!options.manifest) throw new Error("--manifest is required");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { manifest, manifestPath } = invocation.loadManifest(options.manifest);
  const failure = {
    category: options.category,
    provider: options.provider,
    resetAt: options.resetAt,
    detail: options.detail,
    gate: options.gate,
  };
  process.stderr.write(`${buildDiagnosis(manifestPath, manifest, failure)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality terminal status: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  activeBudgetStatus,
  buildDiagnosis,
  currentGateStatus,
  parseArgs,
  terminalStatus,
  worktreeLockStatus,
  repositoryLeaseStatus,
};
