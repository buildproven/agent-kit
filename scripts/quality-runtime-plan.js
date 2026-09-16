#!/usr/bin/env node
"use strict";

/**
 * Convert change risk and workload into bounded per-phase allowances.
 *
 * Risk controls depth. Workload controls time. Keeping those dimensions
 * separate prevents a one-line security edit from receiving a huge-change
 * allowance, while still giving a broad low-risk diff enough time to be read.
 * `campaignSeconds` is the authoritative shared active-execution limit.
 * Phase allowances reserve work inside that limit; they never expand it.
 */

const {
  score,
  scoreToKnobs,
  DEFAULTS,
  CRITICAL_RISK_SCORE,
  loadConfigAtRevision,
} = require("./risk-score");
const { execFileSync } = require("node:child_process");

const WORKLOAD_BANDS = [
  {
    name: "micro",
    maxUnits: 100,
    campaignSeconds: 300,
    reviewSeconds: 75,
    verificationSeconds: 60,
    checkSeconds: 120,
    reviewReserveSeconds: 90,
    // A tiny diff does not make a repository's fixed-cost full suite tiny.
    // Let one micro gate use the existing ten-minute global gate ledger; the
    // ledger still bounds hangs and the remaining gates consume the balance.
    checkReserveSeconds: 480,
  },
  {
    name: "small",
    maxUnits: 400,
    campaignSeconds: 420,
    // A small change can still select the four-agent medium panel. Give that
    // panel enough wall clock to return every mandatory review artifact after
    // a primary-provider timeout and fallback; 120s was observed to kill a
    // healthy reviewer at the watchdog boundary.
    reviewSeconds: 180,
    verificationSeconds: 90,
    checkSeconds: 180,
    reviewReserveSeconds: 120,
    // The kit's bounded integration suite performs real Git/npm work. Give a
    // Small release metadata changes require the complete suite. Its measured
    // fixed cost can exceed the prior ten-and-a-half-minute total, so retain
    // a bounded ten-minute reserve for a thirteen-minute maximum gate.
    checkReserveSeconds: 600,
  },
  {
    name: "medium",
    maxUnits: 1500,
    campaignSeconds: 600,
    reviewSeconds: 210,
    verificationSeconds: 120,
    checkSeconds: 240,
    reviewReserveSeconds: 150,
    checkReserveSeconds: 390,
  },
  {
    name: "large",
    maxUnits: 5000,
    campaignSeconds: 780,
    reviewSeconds: 330,
    verificationSeconds: 180,
    checkSeconds: 300,
    reviewReserveSeconds: 210,
    checkReserveSeconds: 540,
  },
  {
    name: "huge",
    maxUnits: Number.POSITIVE_INFINITY,
    campaignSeconds: 900,
    reviewSeconds: 480,
    verificationSeconds: 240,
    checkSeconds: 360,
    reviewReserveSeconds: 270,
    checkReserveSeconds: 720,
  },
];

const RISK_FLOORS = {
  low: { campaignSeconds: 300, reviewSeconds: 75 },
  medium: { campaignSeconds: 480, reviewSeconds: 180 },
  high: { campaignSeconds: 540, reviewSeconds: 180 },
  // Empirical floor: an xhigh Codex pass over a 1.2k-line security diff took
  // longer than the old 330s "large" allowance. Keep the planning envelope
  // bounded at one hour, but reserve nine minutes for the only provider pass
  // that can produce the mandatory critical review evidence.
  critical: { campaignSeconds: 900, reviewSeconds: 540 },
};
const ORCHESTRATION_SECONDS = 60;
const MAX_CAMPAIGN_SECONDS = 60 * 60;

function riskTier(riskScore) {
  if (riskScore >= CRITICAL_RISK_SCORE) return "critical";
  if (riskScore >= 50) return "high";
  if (riskScore >= 20) return "medium";
  return "low";
}

function workloadUnits(diffStats = {}) {
  const files = Math.max(0, Number(diffStats.files) || 0);
  const lines = Math.max(0, Number(diffStats.lines) || 0);
  // A reviewer also pays a fixed exploration cost to find callers, policy, and
  // tests. Bound that term so a large repository cannot create an unbounded
  // review, while tiny diffs in large repositories leave the micro band before
  // an agent is killed at its first tool call (BUI-688).
  const repositoryFiles = Math.max(0, Number(diffStats.repositoryFiles) || 0);
  const explorationUnits = Math.min(400, Math.ceil(repositoryFiles / 5));
  return lines + files * 25 + explorationUnits;
}

function repositoryFileCount() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.length === 0
      ? 0
      : output.toString("utf8").split("\0").length - 1;
  } catch {
    return 0;
  }
}

function workloadBand(diffStats) {
  const units = workloadUnits(diffStats);
  const band =
    WORKLOAD_BANDS.find((candidate) => units <= candidate.maxUnits) ||
    WORKLOAD_BANDS[WORKLOAD_BANDS.length - 1];
  return { ...band, units };
}

function normalizedRiskScore(riskScore, minimumRisk) {
  return Math.max(
    0,
    Math.min(100, Math.max(Number(riskScore) || 0, Number(minimumRisk) || 0)),
  );
}

function reviewKnobs(riskScore, normalizedRisk, knobs) {
  if (knobs && normalizedRisk === Number(riskScore)) return knobs;
  return scoreToKnobs(normalizedRisk, DEFAULTS);
}

function plannedDepth(mode, knobs) {
  if (mode === "verification") return "high";
  return knobs.codex === "skip" ? "low" : knobs.codex;
}

function normalizeGateTimeoutSeconds(gateTimeoutSeconds) {
  return Object.fromEntries(
    Object.entries(gateTimeoutSeconds || {}).flatMap(([name, value]) => {
      const seconds = Number(value);
      return Number.isInteger(seconds) && seconds > 0 ? [[name, seconds]] : [];
    }),
  );
}

function gateTimeoutExtraSeconds(gateTimeoutSeconds, checkSeconds) {
  return Object.values(gateTimeoutSeconds).reduce(
    (total, seconds) => total + Math.max(0, seconds - checkSeconds),
    0,
  );
}

function gateCampaignBudget({
  band,
  riskFloor,
  tier,
  reviewSeconds,
  requiredGateCount,
  declaredGateTimeoutSeconds,
}) {
  const declaredGateExtraSeconds = gateTimeoutExtraSeconds(
    declaredGateTimeoutSeconds,
    band.checkSeconds,
  );
  const gateReserveSeconds =
    requiredGateCount * band.checkSeconds + declaredGateExtraSeconds;
  // High and critical campaigns must run a mutation proof after the required
  // gates. That proof has a bounded watchdog of check + reserve. It is a
  // mandatory active phase, so the shared per-head cap must fund it as well as
  // the gate ledger. Otherwise a valid gate can leave too little time for the
  // mutation baseline and controlled revert to finish.
  const mutationReserveSeconds = ["high", "critical"].includes(tier)
    ? band.checkSeconds + band.checkReserveSeconds
    : 0;
  const minimumCampaignSeconds =
    gateReserveSeconds +
    mutationReserveSeconds +
    reviewSeconds +
    ORCHESTRATION_SECONDS;
  if (declaredGateExtraSeconds === 0) {
    if (minimumCampaignSeconds > MAX_CAMPAIGN_SECONDS) {
      throw new Error(
        `required gate, mutation, and review reserves require ${minimumCampaignSeconds}s, above the bounded ${MAX_CAMPAIGN_SECONDS}s campaign maximum`,
      );
    }
    return {
      gateReserveSeconds,
      campaignSeconds: Math.max(
        band.campaignSeconds,
        riskFloor.campaignSeconds,
        minimumCampaignSeconds,
      ),
    };
  }
  const declaredMinimumCampaignSeconds = Math.max(
    minimumCampaignSeconds,
    gateReserveSeconds +
      band.reviewReserveSeconds +
      band.verificationSeconds +
      ORCHESTRATION_SECONDS,
  );
  if (declaredMinimumCampaignSeconds > MAX_CAMPAIGN_SECONDS) {
    throw new Error(
      `declared gate, mutation, and review reserves require ${declaredMinimumCampaignSeconds}s, above the bounded ${MAX_CAMPAIGN_SECONDS}s campaign maximum`,
    );
  }
  return {
    gateReserveSeconds,
    campaignSeconds: Math.max(
      band.campaignSeconds,
      riskFloor.campaignSeconds,
      declaredMinimumCampaignSeconds,
    ),
  };
}

function planRuntime({
  riskScore,
  diffStats,
  mode = "discovery",
  knobs = null,
  minimumRisk = 0,
  gateCount = 0,
  gateTimeoutSeconds = {},
}) {
  if (!["discovery", "verification"].includes(mode)) {
    throw new Error(`invalid review mode: ${mode}`);
  }
  const normalizedRisk = normalizedRiskScore(riskScore, minimumRisk);
  const tier = riskTier(normalizedRisk);
  const resolvedDiffStats = {
    ...diffStats,
    repositoryFiles: Math.max(0, Number(diffStats?.repositoryFiles) || 0),
  };
  const band = workloadBand(resolvedDiffStats);
  const riskFloor = RISK_FLOORS[tier];
  const resolvedKnobs = reviewKnobs(riskScore, normalizedRisk, knobs);
  const discoverySeconds = Math.max(
    band.reviewSeconds,
    riskFloor.reviewSeconds,
  );
  const reviewSeconds =
    mode === "verification" ? band.verificationSeconds : discoverySeconds;
  // Required gates run before the first provider pass. Reserve their bounded
  // allowance up front so a small diff cannot consume its entire campaign
  // before the review evidence required for merge can even begin.
  const requiredGateCount = Math.max(0, Number(gateCount) || 0);
  const declaredGateTimeoutSeconds =
    normalizeGateTimeoutSeconds(gateTimeoutSeconds);
  const { gateReserveSeconds, campaignSeconds } = gateCampaignBudget({
    band,
    riskFloor,
    tier,
    reviewSeconds,
    requiredGateCount,
    declaredGateTimeoutSeconds,
  });

  return {
    riskScore: normalizedRisk,
    tier,
    workload: band.name,
    workloadUnits: band.units,
    diffStats: {
      files: Math.max(0, Number(resolvedDiffStats.files) || 0),
      lines: Math.max(0, Number(resolvedDiffStats.lines) || 0),
      repositoryFiles: resolvedDiffStats.repositoryFiles,
    },
    mode,
    campaignSeconds,
    reviewSeconds,
    verificationSeconds: band.verificationSeconds,
    checkSeconds: band.checkSeconds,
    gateCount: requiredGateCount,
    gateReserveSeconds,
    gateTimeoutSeconds: declaredGateTimeoutSeconds,
    reviewReserveSeconds: band.reviewReserveSeconds,
    checkReserveSeconds: band.checkReserveSeconds,
    agents: resolvedKnobs.agents,
    reviewDepth: plannedDepth(mode, resolvedKnobs),
    reviewPasses: mode === "verification" ? 1 : resolvedKnobs.codexRounds || 1,
  };
}

function parseArgs(argv) {
  const args = {
    base: null,
    mode: "discovery",
    minimumRisk: 0,
    gateCount: 0,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      args.base = argv[++index];
    } else if (argv[index] === "--mode" && argv[index + 1]) {
      args.mode = argv[++index];
    } else if (argv[index] === "--minimum-risk" && argv[index + 1]) {
      args.minimumRisk = Number(argv[++index]);
    } else if (argv[index] === "--gate-count" && argv[index + 1]) {
      args.gateCount = Number(argv[++index]);
    } else if (argv[index] === "--gate-timeouts-json" && argv[index + 1]) {
      args.gateTimeoutSeconds = parseGateTimeoutsJson(argv[++index]);
    } else if (argv[index] === "--json") {
      args.json = true;
    }
  }
  return args;
}

function parseGateTimeoutsJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`gate timeouts are not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scored = score({ base: args.base });
  const policyBaseSha = execFileSync("git", ["rev-parse", scored.base], {
    encoding: "utf8",
  }).trim();
  const basePolicy = loadConfigAtRevision(process.cwd(), policyBaseSha);
  const plan = planRuntime({
    riskScore: scored.riskScore,
    diffStats: {
      ...scored.diffStats,
      repositoryFiles: repositoryFileCount(),
    },
    mode: args.mode,
    knobs: scored.knobs,
    minimumRisk: args.minimumRisk,
    gateCount: args.gateCount,
    gateTimeoutSeconds: args.gateTimeoutSeconds,
  });
  const result = {
    ...plan,
    mergeAuthority: basePolicy.mergeAuthority,
    mergeAuthorityBaseSha: policyBaseSha,
    protectedNonstrictRefCas: basePolicy.protectedNonstrictRefCas,
    protectedNonstrictRefCasBaseSha: policyBaseSha,
    taskType: scored.taskType,
    changeNature: scored.changeNature,
    reasons: scored.reasons,
    base: scored.base,
  };
  // Always emit the plan as JSON on stdout. The sole production consumer,
  // quality-risk-resolve.sh, captures this stdout and feeds every field into
  // `quality-invocation.js risk`. Gating output on GITHUB_OUTPUT (as a prior
  // revision did) silently produced empty stdout under GitHub Actions — where
  // GITHUB_OUTPUT is always set — so the resolver read an empty tier and threw
  // `invalid resolved tier ''`, failing risk resolution in CI only. This script
  // is a CLI invoked by a shell script, not a GitHub Actions step that writes
  // to $GITHUB_OUTPUT, so there is nothing to gate on.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  planRuntime,
  riskTier,
  workloadBand,
  workloadUnits,
  repositoryFileCount,
  WORKLOAD_BANDS,
  RISK_FLOORS,
  MAX_CAMPAIGN_SECONDS,
};
