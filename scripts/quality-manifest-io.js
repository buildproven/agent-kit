#!/usr/bin/env node
"use strict";

// Manifest persistence, extracted from quality-invocation.js.
//
// Second slice of BUI-905. These functions own one concern: getting a campaign
// manifest safely onto and off disk — the temp root it lives under, atomic
// write and create, the normalizers that repair an older manifest shape on
// read, and the two save paths (one bumps manifestRevision, one deliberately
// does not).
//
// Verified self-contained before extraction: every name the block calls is
// either defined inside it, a Node builtin, or parseJson. advanceHead,
// withManifestLock and qualityManifestReleaseState appear only in comments
// explaining why these functions behave as they do, not in executed code.
//
// Extracted verbatim. Behaviour is unchanged.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseJson } = require("./quality-canonical-json.js");

// These Symbols tag a manifest that was read in an older shape and still needs
// migrating. They MUST be defined once and shared: two Symbols with the same
// description are never equal, so a second copy would silently stop matching
// and the migration would never run.
// Manifest shape versions. Like the Symbols below, these must have one home:
// a normalizer here and a consumer in quality-invocation.js comparing two
// different copies of "the current version" is a silent divergence.
const SCHEMA_VERSION = 1;
const EXECUTION_BUDGET_VERSION = 1;
const REQUIRED_GATES_POLICY_VERSION = 3;

const NEEDS_EXECUTION_BUDGET_MIGRATION = Symbol(
  "needs-execution-budget-migration",
);
const NEEDS_REQUIRED_GATES_MIGRATION = Symbol("needs-required-gates-migration");

function qualityTmpRoot() {
  return fs.realpathSync(process.env.TMPDIR || os.tmpdir());
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function atomicCreate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.create`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.linkSync(temporary, file);
    fs.chmodSync(file, 0o600);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.unlinkSync(temporary);
  }
}

function normalizeExecutionGovernor(manifest) {
  if (manifest.governor.executionBudgetVersion === undefined) {
    Object.defineProperty(manifest, NEEDS_EXECUTION_BUDGET_MIGRATION, {
      value: true,
      writable: true,
    });
  } else if (
    manifest.governor.executionBudgetVersion !== EXECUTION_BUDGET_VERSION
  ) {
    throw new Error(
      `unsupported execution budget version ${manifest.governor.executionBudgetVersion}`,
    );
  }
  manifest.governor.lifecycleTTLSeconds ??= 24 * 60 * 60;
  manifest.governor.lastActivityAt ??= new Date(
    (manifest.governor.startedAtEpoch || Math.floor(Date.now() / 1000)) * 1000,
  ).toISOString();
  manifest.governor.gateSecondsLimit ??= 10 * 60;
  manifest.governor.gateSecondsUsed ??= 0;
  manifest.governor.providerSecondsLimit ??= 15 * 60;
  manifest.governor.providerSecondsUsed ??= 0;
  manifest.governor.activeExecution ??= null;
}

function normalizeGovernor(manifest) {
  manifest.governor ??= {};
  normalizeExecutionGovernor(manifest);
  manifest.governor.authorizedAttempts ??= [];
  manifest.governor.maxProviderAttempts ??= 6;
  manifest.governor.providerWindowSeconds ??= 3600;
  manifest.governor.providerAttempts ??= [];
  manifest.governor.campaignSeconds ??=
    manifest.governor.providerWindowSeconds +
    manifest.governor.remediationSeconds +
    manifest.governor.reReviewReserveSeconds;
  manifest.governor.activeSecondsLimit ??= manifest.governor.campaignSeconds;
  manifest.governor.activeSecondsUsed ??=
    manifest.governor.gateSecondsUsed + manifest.governor.providerSecondsUsed;
}

function normalizeManifestCollections(manifest) {
  manifest.reviews ??= [];
  manifest.gates ??= [];
  manifest.mutation ??= null;
  manifest.merge ??= {};
  manifest.merge.invalidatedStamps ??= [];
  // Every campaign ends in exactly ONE recorded terminal state. Without this a
  // campaign killed mid-flight (timeout, ^C, crashed provider) leaves a
  // manifest byte-identical to one that is still running: activeExecution is
  // null either way, so the only signal is a stale lastActivityAt. Nine PR-267
  // manifests were in precisely that condition — interrupted before review,
  // with no way to tell "paused" from "in progress" from disk.
  //
  // null = still open. Anything else is final and must never be overwritten
  // (see recordTerminalState), so the first terminal cause wins and a late
  // cleanup path cannot relabel a failure as success.
  manifest.terminalState ??= null;
  normalizeGovernor(manifest);
  if (
    manifest.requiredGatesPolicyVersion === undefined ||
    manifest.requiredGatesPolicyVersion === 1 ||
    manifest.requiredGatesPolicyVersion === 2
  ) {
    // v1->v2 and v2->v3 both migrate via full recompute (replace, not
    // union) — v3 (BUI-467) changed inference semantics for the `type`
    // gate specifically (mypy is no longer promoted merely because
    // pyproject.toml declares [tool.mypy]; the diff must touch .py/.pyi
    // too), so a v2 manifest that already inferred python:mypy must be
    // recomputed under the new policy rather than keeping the stale entry
    // via union.
    Object.defineProperty(manifest, NEEDS_REQUIRED_GATES_MIGRATION, {
      value: true,
      writable: true,
    });
  } else if (
    manifest.requiredGatesPolicyVersion !== REQUIRED_GATES_POLICY_VERSION
  ) {
    throw new Error(
      `unsupported required-gates policy version ${manifest.requiredGatesPolicyVersion}`,
    );
  }
  manifest.requiredGates ??= [];
}

function loadManifest(file) {
  const requested = path.resolve(file);
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink()) {
    throw new Error("quality manifest must not be a symlink");
  }
  const manifestPath = fs.realpathSync(requested);
  const manifest = parseJson(
    fs.readFileSync(manifestPath, "utf8"),
    "quality manifest",
  );
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported quality manifest schema ${manifest.schemaVersion}`,
    );
  }
  normalizeManifestCollections(manifest);
  if (
    !manifest.invocationId ||
    !manifest.repo?.realpath ||
    !manifest.revisions?.baseSha ||
    !manifest.revisions?.currentHead
  ) {
    throw new Error("quality manifest is missing required identity fields");
  }
  const expectedPath = path.join(manifest.stateRoot, "invocation.json");
  if (path.resolve(expectedPath) !== manifestPath) {
    throw new Error("quality manifest path does not match its stateRoot");
  }
  const expectedStateRoot = path.join(
    qualityTmpRoot(),
    "bs-quality",
    manifest.repo.key,
    `pr-${manifest.repo.pr ?? "none"}`,
    manifest.revisions.baseSha,
    manifest.invocationId,
  );
  if (path.resolve(expectedStateRoot) !== path.resolve(manifest.stateRoot)) {
    throw new Error("quality manifest stateRoot identity is invalid");
  }
  return { manifest, manifestPath };
}

function saveManifest(file, manifest) {
  manifest.updatedAt = new Date().toISOString();
  manifest.manifestRevision = (manifest.manifestRevision || 0) + 1;
  atomicWrite(file, manifest);
}

// A mid-mutation persist for progress that must survive even if the rest of
// the current mutation() callback later throws (withManifestLock() only
// calls saveManifest() on a callback that returns normally). Unlike
// saveManifest(), this does NOT bump manifestRevision: withManifestLock()
// compares manifestRevision before/after the SAME mutation() call to detect
// a genuinely concurrent writer, and bumping it here would make that check
// misfire against our own in-progress transaction, not an actual concurrent
// writer. updatedAt IS refreshed, though — worktree-manager.js's
// qualityManifestReleaseState() reads it to judge whether a locked
// campaign is abandoned, and an execution reconciled moments ago is
// definitionally not abandoned (Codex review finding, 2026-08-01, medium).
function saveManifestMidTransaction(file, manifest) {
  manifest.updatedAt = new Date().toISOString();
  atomicWrite(file, manifest);
}

module.exports = {
  SCHEMA_VERSION,
  EXECUTION_BUDGET_VERSION,
  REQUIRED_GATES_POLICY_VERSION,
  NEEDS_EXECUTION_BUDGET_MIGRATION,
  NEEDS_REQUIRED_GATES_MIGRATION,
  qualityTmpRoot,
  atomicWrite,
  atomicCreate,
  normalizeExecutionGovernor,
  normalizeGovernor,
  normalizeManifestCollections,
  loadManifest,
  saveManifest,
  saveManifestMidTransaction,
};
