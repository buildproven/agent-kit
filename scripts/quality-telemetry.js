#!/usr/bin/env node

/**
 * Quality Telemetry Recorder
 *
 * Wave 2.5 of the SOTA quality upgrade (BUI-341). The quality system was
 * open-loop: it ran, but nothing measured whether it was worth its tokens.
 * This module closes the loop by appending ONE JSON line per finished campaign
 * to a telemetry log, from which a weekly report derives escaped-defect rate,
 * AI lead/status attribution, a heuristic capture-rate proxy, and deterministic
 * failure outcomes. The proxy is not statistical precision because the ledger
 * does not contain a false-positive denominator.
 *
 * Every field recorded already exists in the invocation manifest — the single
 * source of campaign truth (see quality-invocation.js createManifest). We do
 * not re-derive anything the manifest already knows; we summarize it.
 *
 * DESTINATION (kit stays standalone — see core/CLAUDE.md "this repo never
 * embeds references to anything that overlays it"): the log path resolves to
 *   1. $BS_QUALITY_TELEMETRY_FILE if set (an overlay can pin a committed path)
 *   2. else $XDG_STATE_HOME/agent-kit/quality-telemetry/<repo-key>.jsonl
 *      (falling back to ~/.local/state)
 * The default is deliberately outside the target repo: auditing a clean
 * worktree must leave it clean. Committed, fleet-visible history remains
 * opt-in via $BS_QUALITY_TELEMETRY_FILE.
 *
 * IDEMPOTENT: keyed on invocationId, terminal state, and recovery epoch. A
 * campaign records each terminal transition once, so a verified-unmerged
 * receipt can later be followed by one exact merged receipt, while repeated
 * blocked/recovering events in later recovery epochs remain observable.
 * Absence of a manifest, or an unreadable one, is a hard failure — telemetry
 * that silently no-ops would report "quality is cheap" by recording nothing.
 * But a telemetry WRITE failure must NOT fail the campaign: measuring the run
 * is strictly less important than the run's own verdict. `record` therefore
 * exits 0 on a successful append or a benign duplicate, and exits 0 with a
 * stderr warning if the log is unwritable — never blocks a merge.
 *
 * Pure summary functions are exported for unit testing — see
 *   scripts/__tests__/quality-telemetry.test.js
 */

"use strict";

const fs = require("fs");
const crypto = require("node:crypto");
const os = require("os");
const path = require("path");
const {
  authorizationReviews,
  coveredReviews,
} = require("./quality-review-history");
const { reviewUsage, validUsage } = require("./quality-provider-usage");

const TELEMETRY_SCHEMA_VERSION = 9;
const REVIEW_TOKEN_CHARS_PER_TOKEN = 4;
const TELEMETRY_TERMINAL_STATES = new Set([
  "recovering",
  "merged",
  "verified-unmerged",
  "blocked",
  "timeout",
  "interrupted",
  "superseded",
  "policy-superseded",
  "provider-incomplete",
  "provider-contract-failed",
]);

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Read a finished invocation manifest for summarization.
 *
 * Deliberately NOT quality-invocation.loadManifest: that enforces the live
 * tmp-root/stateRoot identity contract used while a campaign mutates state.
 * Telemetry runs at the terminal step and only needs the manifest's recorded
 * facts, not proof it still owns the tmp sentinel — reusing the strict loader
 * would couple observational recording to that contract and reject a manifest
 * copied or relocated for reporting. We validate only what we summarize.
 */
function readManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error("quality manifest must not be a symlink");
  }
  const raw = fs.readFileSync(resolved, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`quality manifest is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `unsupported quality manifest schema ${manifest.schemaVersion}`,
    );
  }
  if (!manifest.invocationId || !manifest.repo?.realpath) {
    throw new Error("quality manifest is missing required identity fields");
  }
  return manifest;
}

/**
 * Resolve where telemetry lines are appended. Env override wins so an overlay
 * (or CI) can pin a single committed path; otherwise an operator-state
 * directory keeps the audited repository byte-for-byte clean.
 */
function resolveTelemetryFile(manifest) {
  const override = process.env.BS_QUALITY_TELEMETRY_FILE;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(
    stateHome,
    "agent-kit",
    "quality-telemetry",
    `${manifest.repo.key}.jsonl`,
  );
}

/**
 * Number of successful review rounds actually run this campaign. `reviews` is
 * the authoritative record; governor.roundsUsed can lag a crash mid-round, so
 * count successes directly (matches how judge derives reviewCount).
 */
function successfulReviewCount(manifest) {
  if (!Array.isArray(manifest.reviews)) return 0;
  return manifest.reviews.filter((review) => review.status === "success")
    .length;
}

/**
 * Files this campaign's review covered — the change set under
 * baseSha..currentHead. Recorded so the escaped-defect tagger can later ask
 * "did a later fix: commit touch a file a passed campaign already reviewed?"
 * without re-running git against a possibly-rebased history. Returns [] when
 * the range can't be computed (fail-soft: telemetry is never load-bearing).
 */
function coveredFiles(manifest, execFileSync) {
  const base = manifest.revisions?.baseSha;
  const head = manifest.revisions?.currentHead;
  if (!base || !head) return [];
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `${base}..${head}`],
      {
        cwd: manifest.repo.realpath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Estimate review token volume from the immutable provider artifacts. Provider
 * CLIs do not expose one stable usage schema, so these are explicitly a proxy,
 * never reported provider usage. Counting the prompt files that were actually
 * sent avoids charging a review for repository context that the runtime
 * deliberately prepared outside the provider clock.
 */
function artifactNames(review) {
  if (!review.artifactDir || typeof review.artifactDir !== "string") return [];
  try {
    return fs.readdirSync(review.artifactDir);
  } catch {
    return [];
  }
}

function sumArtifactChars(directory, names, multiplier = 1) {
  return names.reduce(
    (sum, name) =>
      sum + readableArtifactChars(path.join(directory, name)) * multiplier,
    0,
  );
}

function measureReviewArtifacts(review, agentCount) {
  const names = artifactNames(review);
  if (names.length === 0) return { inputChars: 0, outputChars: 0 };
  const providerPromptNames = names.filter((name) =>
    /^(?:codex-\d+|gemini-\d+)\.prompt$/.test(name),
  );
  const claudePromptNames = names.filter(
    (name) => name === "review-prompt.txt",
  );
  const promptNames =
    providerPromptNames.length > 0 ? providerPromptNames : claudePromptNames;
  const claudeMultiplier =
    review.provider === "claude" ? Math.max(1, agentCount) : 1;
  return {
    inputChars: sumArtifactChars(
      review.artifactDir,
      promptNames,
      claudeMultiplier,
    ),
    outputChars: sumArtifactChars(
      review.artifactDir,
      names.filter((name) => /\.normalized\.json$/.test(name)),
    ),
  };
}

function reviewTokenProxy(manifest) {
  let inputChars = 0;
  let outputChars = 0;
  const reviews = Array.isArray(manifest.reviews) ? manifest.reviews : [];
  const agentCount = Array.isArray(manifest.agents)
    ? manifest.agents.length
    : 0;
  for (const review of reviews) {
    const measures = measureReviewArtifacts(review, agentCount);
    inputChars += measures.inputChars;
    outputChars += measures.outputChars;
  }
  const hasMeasurements = inputChars > 0 || outputChars > 0;
  return {
    reviewInputChars: hasMeasurements ? inputChars : null,
    reviewInputTokensEstimated: hasMeasurements
      ? Math.ceil(inputChars / REVIEW_TOKEN_CHARS_PER_TOKEN)
      : null,
    reviewOutputChars: hasMeasurements ? outputChars : null,
    reviewOutputTokensEstimated: hasMeasurements
      ? Math.ceil(outputChars / REVIEW_TOKEN_CHARS_PER_TOKEN)
      : null,
    reviewTokenEstimateSource: hasMeasurements
      ? `artifact-chars/${REVIEW_TOKEN_CHARS_PER_TOKEN}`
      : null,
  };
}

function readableArtifactChars(file) {
  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return 0;
    return fs.readFileSync(descriptor, "utf8").length;
  } catch {
    return 0;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Derive the campaign verdict from persisted state alone — no model judgment.
 *
 * Version 2 derives completion from exact-head discovery attestation; legacy
 * version 1 retains judge-based interpretation for historical records.
 *
 *  - "authorized"   : merge requested and deterministic authorization passed.
 *                     This is "authorized to merge", NOT "merged" — the actual
 *                     GitHub merge is async/CI-owned and can still abort after
 *                     the judge clears (red CI, stale trailers, push failure).
 *                     Deliberately named for what the manifest actually knows,
 *                     so the escaped-defect / cost-per-bug reports never count
 *                     an authorized-but-unmerged campaign as a shipped merge.
 *  - "passed"       : review completed, judge recorded, 0 blocking, no merge asked.
 *  - "blocked"      : judge recorded a blocking count > 0.
 *  - "incomplete"   : no judge artifact, or a judge bound to a head other than
 *                     the one being recorded (campaign stopped before synthesis
 *                     — budget exhaustion, error, a still-running record call,
 *                     or commits landed after the judge without a re-judge).
 *                     A stale judge describes a DIFFERENT head than the recorded
 *                     `head` column, so its blocking count cannot be trusted for
 *                     the current revision — mirrors the staleness contract in
 *                     quality-invocation.js review-authorization.
 */
function deriveVerdict(manifest) {
  if ((manifest.reviewContractVersion || 1) >= 2) {
    const terminal = manifest.terminalState?.state;
    if (terminal === "blocked") return "blocked";
    if (
      [
        "timeout",
        "recovering",
        "interrupted",
        "superseded",
        "policy-superseded",
        "provider-incomplete",
        "provider-contract-failed",
      ].includes(terminal)
    ) {
      return "incomplete";
    }
    if (terminal === "merged") return "authorized";
    if (terminal === "verified-unmerged") return "passed";
    const hasCurrentAttestation = (manifest.reviews || []).some(
      (review) =>
        ["success", "exempt", "incomplete"].includes(review.status) &&
        review.to === manifest.revisions?.currentHead,
    );
    if (!hasCurrentAttestation) return "incomplete";
    return manifest.options?.merge === true ? "authorized" : "passed";
  }
  const judge = manifest.judge;
  if (!judge || !Number.isFinite(judge.blockingCount)) return "incomplete";
  if (judge.head !== manifest.revisions?.currentHead) return "incomplete";
  if (judge.blockingCount > 0) return "blocked";
  return manifest.options?.merge === true ? "authorized" : "passed";
}

/**
 * Campaign wall-clock, from the governor's start epoch to the record moment.
 * Null when either bound is unavailable; clamped at 0 so clock skew or a
 * relocated manifest never records a negative duration.
 */
function campaignDuration(manifest, nowIso) {
  const startedAtEpoch = manifest.governor?.startedAtEpoch;
  const endedAtEpoch = Math.floor(Date.parse(nowIso) / 1000);
  if (!Number.isFinite(startedAtEpoch) || !Number.isFinite(endedAtEpoch)) {
    return null;
  }
  return Math.max(0, endedAtEpoch - startedAtEpoch);
}

/** Coalesce `undefined` to `null` for a stable JSONL column set. */
function orNull(value) {
  return value === undefined ? null : value;
}

/**
 * The manifest's flat identity fields (repo/PR/branch/revisions/risk). Split
 * out of buildRecord to keep each function readable; `orNull` keeps the branch
 * count low (a bare `?? null` per column otherwise reads as N conditionals to
 * the complexity linter). Risk fields are recorded only once resolved, so an
 * unresolved campaign never logs a stale requested tier as if it were final.
 *
 * The absolute repo realpath is DELIBERATELY NOT recorded: it is a host path
 * (`/Users/<name>/...`) that would leak into any committed telemetry log —
 * unacceptable in a public repo. `repoKey` + `githubRepository` identify the
 * repo without exposing the operator's filesystem.
 */
function identityFields(manifest) {
  const repo = manifest.repo || {};
  const revisions = manifest.revisions || {};
  const risk = manifest.risk || {};
  const resolved = risk.resolved === true;
  return {
    recordClass:
      typeof repo.githubRepository !== "string" || !repo.githubRepository
        ? "unattributed"
        : repo.githubRepository.startsWith("vitest/") ||
            repo.githubRepository === "owner/repo"
          ? "fixture"
          : "production",
    repoKey: orNull(repo.key),
    githubRepository: orNull(repo.githubRepository),
    pr: orNull(repo.pr),
    branch: orNull(repo.headRefName),
    baseSha: orNull(revisions.baseSha),
    head: orNull(revisions.currentHead),
    taskType: resolved ? orNull(risk.taskType) : null,
    riskTier: resolved ? orNull(risk.tier) : null,
    riskScore: resolved ? orNull(risk.score) : null,
    requestedLevel: orNull(risk.requestedLevel),
  };
}

function reviewFields(manifest) {
  const provider = manifest.provider || {};
  const inferredArm =
    provider.reviewer === "claude"
      ? "bespoke"
      : ["codex", "gemini"].includes(provider.reviewer)
        ? "native"
        : null;
  const covered = coveredReviews(manifest);
  const authorized = authorizationReviews(manifest);
  const incomplete = authorized.some(
    (review) => review.status === "incomplete",
  );
  const exempt =
    authorized.length > 0 &&
    authorized.every((review) => review.status === "exempt");
  const providersAttempted = [
    ...new Set(
      (manifest.reviews || [])
        .map((review) => review.provider)
        .filter((provider) => typeof provider === "string" && provider),
    ),
  ];
  const codexModel =
    manifest.risk?.tier === "critical"
      ? "gpt-5.6-sol"
      : manifest.risk?.tier === "low"
        ? "gpt-5.6-luna"
        : "gpt-5.6-terra";
  const exact = reviewUsage(manifest);
  const usage = exact.usage;
  return {
    // Older manifests predate the experiment and remain reportable as null.
    // All newly-created manifests persist one of these arms at creation time.
    reviewArm: manifest.options?.reviewArm ?? inferredArm,
    reviewProvider: provider.reviewer ?? null,
    reviewModel: provider.reviewer === "codex" ? codexModel : null,
    requestedProvider: provider.primary ?? null,
    providersAttempted,
    fallbackUsed: Boolean(
      provider.primary &&
      provider.reviewer &&
      provider.reviewer !== provider.primary,
    ),
    reviewEffort: provider.effort ?? null,
    reviewTokens: usage?.totalTokens ?? null,
    reviewInputTokens: usage?.inputTokens ?? null,
    reviewCachedInputTokens: usage?.cachedInputTokens ?? null,
    reviewCacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
    reviewOutputTokens: usage?.outputTokens ?? null,
    reviewReasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
    reviewTokenUsageSource: usage?.source ?? null,
    reviewTokenUsageSamples: usage?.samples ?? 0,
    reviewUsageMissingReviews: exact.reviewCount - exact.reviewsWithUsage,
    ...reviewTokenProxy(manifest),
    reviewStatus: incomplete
      ? "incomplete"
      : exempt
        ? "policy-exempt"
        : authorized.length > 0
          ? "complete"
          : null,
    leadCount: covered.reduce(
      (sum, review) =>
        sum + (Number.isInteger(review.leadCount) ? review.leadCount : 0),
      0,
    ),
  };
}

function findingDispositionFields(manifest, leadCount) {
  const empty = {
    findingDispositions: [],
    findingDispositionMissingCount: leadCount,
    findingResolutionMissingCount: 0,
    judgeArtifactSha256: null,
  };
  const judge = manifest.judge;
  if (
    !judge?.artifactPath ||
    typeof judge.artifactSha256 !== "string" ||
    !judge.artifactSha256
  ) {
    return empty;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      judge.artifactPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    if (!fs.fstatSync(descriptor).isFile()) return empty;
    const raw = fs.readFileSync(descriptor);
    if (
      crypto.createHash("sha256").update(raw).digest("hex") !==
      judge.artifactSha256
    ) {
      return empty;
    }
    const artifact = parseJson(raw.toString("utf8"), "judge artifact");
    if (
      artifact.invocationId !== manifest.invocationId ||
      artifact.head !== manifest.revisions?.currentHead ||
      !Array.isArray(artifact.findings)
    ) {
      return empty;
    }
    const rows = artifact.findings.flatMap((finding) => {
      if (
        typeof finding.id !== "string" ||
        !finding.id ||
        !["BLOCKING", "WARNING", "SUPPRESSED"].includes(finding.disposition)
      ) {
        return [];
      }
      return [
        {
          id: finding.id,
          disposition: finding.disposition,
          provider:
            typeof finding.provider === "string" ? finding.provider : null,
          source: typeof finding.source === "string" ? finding.source : null,
          resolution:
            typeof finding.resolution === "string" && finding.resolution
              ? finding.resolution
              : null,
        },
      ];
    });
    if (new Set(rows.map((row) => row.id)).size !== rows.length) return empty;
    return {
      findingDispositions: rows,
      findingDispositionMissingCount: Math.max(0, leadCount - rows.length),
      findingResolutionMissingCount: rows.filter(
        (row) => row.resolution === null,
      ).length,
      judgeArtifactSha256: judge.artifactSha256,
    };
  } catch {
    return empty;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function deterministicBlockingCount(manifest) {
  if ((manifest.reviewContractVersion || 1) < 2) return null;
  const head = manifest.revisions?.currentHead;
  const failedGates = (manifest.gates || []).filter(
    (gate) => gate.head === head && ["failed", "timeout"].includes(gate.status),
  ).length;
  if (failedGates > 0) return failedGates;
  return manifest.terminalState?.state === "blocked" ? 1 : 0;
}

function testSelectionMode(manifest) {
  const gate = (manifest.requiredGates || []).find(
    (candidate) => candidate.name === "test",
  );
  if (!gate) return null;
  if (gate.source === "test-impact:.buildproven/test-impact.json") {
    return gate.testImpactMode ?? null;
  }
  if (
    gate.source?.startsWith("package-script:") ||
    gate.source?.startsWith("quality-gates:") ||
    gate.source?.startsWith("python:")
  ) {
    return "complete";
  }
  return null;
}

function validateRecord(record) {
  const validArm =
    record.reviewArm === null ||
    ["bespoke", "native"].includes(record.reviewArm);
  const validTokens =
    record.reviewTokens === null ||
    (Number.isInteger(record.reviewTokens) && record.reviewTokens >= 0);
  const validProviderDuration =
    record.providerDurationSeconds === null ||
    (Number.isInteger(record.providerDurationSeconds) &&
      record.providerDurationSeconds >= 0);
  const validProxyMetric = (value) =>
    value === null || (Number.isInteger(value) && value >= 0);
  const validProxySource =
    record.reviewTokenEstimateSource === null ||
    record.reviewTokenEstimateSource === "artifact-chars/4";
  const validTerminalState =
    record.terminalState === null ||
    TELEMETRY_TERMINAL_STATES.has(record.terminalState);
  const validTerminalEpoch =
    Number.isSafeInteger(record.terminalEpoch) && record.terminalEpoch >= 0;
  const validExactUsage =
    record.reviewTokens === null
      ? [
          record.reviewInputTokens,
          record.reviewCachedInputTokens,
          record.reviewCacheWriteInputTokens,
          record.reviewOutputTokens,
          record.reviewReasoningOutputTokens,
          record.reviewTokenUsageSource,
        ].every((value) => value === null) &&
        record.reviewTokenUsageSamples === 0
      : validUsage(
          {
            schemaVersion: 1,
            source: record.reviewTokenUsageSource,
            inputTokens: record.reviewInputTokens,
            cachedInputTokens: record.reviewCachedInputTokens,
            cacheWriteInputTokens: record.reviewCacheWriteInputTokens,
            outputTokens: record.reviewOutputTokens,
            reasoningOutputTokens: record.reviewReasoningOutputTokens,
            totalTokens: record.reviewTokens,
            samples: record.reviewTokenUsageSamples,
          },
          { aggregate: true },
        );
  const validDispositions =
    Array.isArray(record.findingDispositions) &&
    record.findingDispositions.every(
      (finding) =>
        typeof finding.id === "string" &&
        ["BLOCKING", "WARNING", "SUPPRESSED"].includes(finding.disposition) &&
        (finding.provider === null || typeof finding.provider === "string") &&
        (finding.source === null || typeof finding.source === "string") &&
        (finding.resolution === null || typeof finding.resolution === "string"),
    ) &&
    new Set(record.findingDispositions.map((finding) => finding.id)).size ===
      record.findingDispositions.length;
  return Boolean(
    record.telemetrySchemaVersion === TELEMETRY_SCHEMA_VERSION &&
    typeof record.invocationId === "string" &&
    typeof record.recordedAt === "string" &&
    validArm &&
    (record.reviewProvider === null ||
      typeof record.reviewProvider === "string") &&
    (record.reviewEffort === null || typeof record.reviewEffort === "string") &&
    (record.reviewModel === null || typeof record.reviewModel === "string") &&
    validTokens &&
    validExactUsage &&
    validProviderDuration &&
    validProxyMetric(record.activeDurationSeconds) &&
    validProxyMetric(record.gateDurationSeconds) &&
    validProxyMetric(record.fixCommitCount) &&
    validProxyMetric(record.evidenceReusedCount) &&
    (record.mutationAvoidedSeconds === undefined ||
      validProxyMetric(record.mutationAvoidedSeconds)) &&
    validProxyMetric(record.deterministicFailureCount) &&
    Array.isArray(record.providersAttempted) &&
    record.providersAttempted.every(
      (provider) => typeof provider === "string",
    ) &&
    typeof record.fallbackUsed === "boolean" &&
    validProxyMetric(record.reviewInputChars) &&
    validProxyMetric(record.reviewInputTokensEstimated) &&
    validProxyMetric(record.reviewOutputChars) &&
    validProxyMetric(record.reviewOutputTokensEstimated) &&
    validProxySource &&
    ["production", "fixture", "unattributed", "preflight"].includes(
      record.recordClass,
    ) &&
    Number.isInteger(record.reviewUsageMissingReviews) &&
    record.reviewUsageMissingReviews >= 0 &&
    validDispositions &&
    Number.isInteger(record.findingDispositionMissingCount) &&
    record.findingDispositionMissingCount >= 0 &&
    Number.isInteger(record.findingResolutionMissingCount) &&
    record.findingResolutionMissingCount >= 0 &&
    (record.judgeArtifactSha256 === null ||
      typeof record.judgeArtifactSha256 === "string") &&
    validTerminalState &&
    validTerminalEpoch &&
    [null, "none", "focused", "audit", "complete", "unmapped"].includes(
      record.testSelectionMode,
    ) &&
    [null, "complete", "incomplete", "policy-exempt"].includes(
      record.reviewStatus,
    ) &&
    Number.isInteger(record.leadCount) &&
    record.leadCount >= 0,
  );
}

function fixCommitCount(manifest, execFileSync) {
  const from = manifest.revisions?.initialHead;
  const to = manifest.revisions?.currentHead;
  if (!from || !to || from === to) return 0;
  try {
    const count = Number(
      execFileSync("git", ["rev-list", "--count", `${from}..${to}`], {
        cwd: manifest.repo.realpath,
        encoding: "utf8",
      }).trim(),
    );
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * Build the one telemetry record for a finished campaign. Pure given a manifest
 * and a git runner (injected for testability). All fields trace to the manifest.
 */
function buildRecord(manifest, { execFileSync, nowIso }) {
  const judge = manifest.judge || {};
  const review = reviewFields(manifest);
  const record = {
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    invocationId: manifest.invocationId,
    recordedAt: nowIso,
    ...identityFields(manifest),
    ...review,
    ...findingDispositionFields(manifest, review.leadCount),
    durationSeconds: campaignDuration(manifest, nowIso),
    providerDurationSeconds: Number.isInteger(
      manifest.governor?.providerSecondsUsed,
    )
      ? manifest.governor.providerSecondsUsed
      : null,
    gateDurationSeconds: Number.isInteger(manifest.governor?.gateSecondsUsed)
      ? manifest.governor.gateSecondsUsed
      : null,
    activeDurationSeconds: Number.isInteger(
      manifest.governor?.activeSecondsUsed,
    )
      ? manifest.governor.activeSecondsUsed
      : Number.isInteger(manifest.governor?.gateSecondsUsed) &&
          Number.isInteger(manifest.governor?.providerSecondsUsed)
        ? manifest.governor.gateSecondsUsed +
          manifest.governor.providerSecondsUsed
        : null,
    fixCommitCount: fixCommitCount(manifest, execFileSync),
    evidenceReusedCount: (manifest.gates || []).filter(
      (gate) =>
        gate.head === manifest.revisions?.currentHead && gate.remoteEvidence,
    ).length,
    mutationAvoidedSeconds: Number.isInteger(
      manifest.mutationCarry?.avoidedSeconds,
    )
      ? manifest.mutationCarry.avoidedSeconds
      : 0,
    testSelectionMode: testSelectionMode(manifest),
    terminalState: manifest.terminalState?.state ?? null,
    terminalEpoch:
      Number.isSafeInteger(manifest.terminalState?.terminalEpoch) &&
      manifest.terminalState.terminalEpoch >= 0
        ? manifest.terminalState.terminalEpoch
        : Number.isSafeInteger(manifest.terminalEpoch) &&
            manifest.terminalEpoch >= 0
          ? manifest.terminalEpoch
          : 0,
    reviewRounds: successfulReviewCount(manifest),
    agentsRun: Array.isArray(manifest.agents) ? manifest.agents.length : 0,
    blockingCount: Number.isFinite(judge.blockingCount)
      ? judge.blockingCount
      : null,
    deterministicFailureCount: deterministicBlockingCount(manifest),
    mergeRequested: manifest.options?.merge === true,
    verdict: deriveVerdict(manifest),
    coveredFiles: coveredFiles(manifest, execFileSync),
  };
  if (!validateRecord(record)) {
    throw new Error("quality telemetry record is missing required attribution");
  }
  return record;
}

/**
 * Return true if the log already contains a line for this invocationId.
 * Read-tolerant: a missing file is "not present"; a malformed line is skipped
 * (a single corrupt line must not resurrect a duplicate append nor throw).
 */
function alreadyRecorded(
  logPath,
  invocationId,
  terminalState,
  terminalEpoch = 0,
) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (
        record.invocationId === invocationId &&
        (terminalState === undefined ||
          (record.terminalState === terminalState &&
            (record.terminalEpoch ?? 0) === terminalEpoch))
      ) {
        return true;
      }
    } catch {
      // skip corrupt line
    }
  }
  return false;
}

function appendRecord(logPath, record) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
}

/**
 * `record` subcommand. Reads the manifest, builds the summary, appends once.
 * Returns a process exit code. A write failure warns but returns 0 — telemetry
 * is observational and must never block a campaign's real outcome.
 */
function recordCampaign(manifestPath, deps = {}) {
  const execFileSync =
    deps.execFileSync || require("child_process").execFileSync;
  const nowIso = deps.nowIso || new Date().toISOString();
  const quiet = deps.quiet === true;
  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    process.stderr.write(
      `[quality] telemetry: manifest unreadable at ${manifestPath} — ${error.message}\n`,
    );
    return 1;
  }
  const logPath = resolveTelemetryFile(manifest);
  let record;
  try {
    record = buildRecord(manifest, { execFileSync, nowIso });
  } catch (error) {
    process.stderr.write(
      `[quality] telemetry: campaign ${manifest.invocationId} could not be summarized — ${error.message} (campaign outcome unaffected).\n`,
    );
    return 0;
  }
  if (
    alreadyRecorded(
      logPath,
      manifest.invocationId,
      record.terminalState,
      record.terminalEpoch,
    )
  ) {
    if (!quiet) {
      process.stdout.write(
        `[quality] telemetry: campaign ${manifest.invocationId} already recorded — skipping.\n`,
      );
    }
    return 0;
  }
  try {
    appendRecord(logPath, record);
  } catch (error) {
    process.stderr.write(
      `[quality] telemetry: could not write ${logPath} — ${error.message} (campaign outcome unaffected).\n`,
    );
    return 0;
  }
  if (!quiet) {
    process.stdout.write(
      `[quality] telemetry: recorded campaign ${manifest.invocationId} (${record.verdict}, ${record.durationSeconds}s) -> ${logPath}\n`,
    );
  }
  return 0;
}

function main() {
  const [, , cmd, manifestPath] = process.argv;
  if (cmd !== "record" || !manifestPath) {
    process.stderr.write(
      "usage: quality-telemetry.js record <manifest-path>\n",
    );
    process.exit(2);
  }
  process.exit(recordCampaign(manifestPath));
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  resolveTelemetryFile,
  successfulReviewCount,
  coveredFiles,
  reviewTokenProxy,
  deriveVerdict,
  buildRecord,
  deterministicBlockingCount,
  testSelectionMode,
  validateRecord,
  alreadyRecorded,
  recordCampaign,
};

if (require.main === module) {
  main();
}
