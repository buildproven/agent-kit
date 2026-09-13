#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const quality = require("./quality-invocation");
const runnerOwnership = require("./quality-runner-ownership");
const { productionCodeChange } = require("./product-completion");
const { assertEngineeringPolicy } = require("./engineering-delivery-policy");

const ORCHESTRATION_SCHEMA_VERSION = 1;
const ACTION_REQUIRED_EXIT = 3;
const WORK_REQUIRED_EXIT = 4;
const BUSY_EXIT = 5;
const SCRIPT_DIR = __dirname;

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--manifest" || !argv[1]) {
    throw new Error("usage: quality-run.js --manifest <exact-path>");
  }
  return path.resolve(argv[1]);
}

function manifestAt(manifestPath) {
  return quality.loadManifest(manifestPath).manifest;
}

function pinRepositoryLease(manifest) {
  if (manifest.options?.merge !== true) return;
  const token = manifest.merge?.repositoryLease?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("merge campaign has no repository lease credential");
  }
  const presented = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
  if (presented && presented !== token) {
    throw new Error("repository lease credential does not match the manifest");
  }
  process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = token;
}

function pinTerminalEpoch(manifest) {
  const epoch = quality.terminalEpoch(manifest);
  process.env.BS_QUALITY_TERMINAL_EPOCH = String(epoch);
}

function updateOrchestration(manifestPath, phase, status, detail = null) {
  quality.withManifestLock(manifestPath, (manifest) => {
    quality.validateIdentity(manifest, manifest.repo.realpath);
    const now = new Date().toISOString();
    const prior = manifest.orchestration;
    if (prior && prior.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
      throw new Error(
        `unsupported quality orchestration schema ${prior.schemaVersion}`,
      );
    }
    if (!prior || prior.head !== manifest.revisions.currentHead) {
      manifest.orchestration = {
        schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
        head: manifest.revisions.currentHead,
        phase: "ready",
        status: "running",
        startedAt: now,
        updatedAt: now,
        steps: {},
      };
    }
    const orchestration = manifest.orchestration;
    orchestration.phase = phase;
    orchestration.status = status;
    orchestration.updatedAt = now;
    orchestration.steps[phase] = {
      status,
      detail,
      updatedAt: now,
      attempts:
        (orchestration.steps[phase]?.attempts || 0) +
        (status === "running" ? 1 : 0),
    };
  });
}

function emit(result) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["inherit", "pipe", "pipe"],
    });
    options.onChild?.(child);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdout = `${stdout}${chunk}`.slice(-32768);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr = `${stderr}${chunk}`.slice(-32768);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      options.onChild?.(null);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function script(name) {
  return path.join(SCRIPT_DIR, name);
}

function currentReview(manifest) {
  if (quality.incompleteRetryStatus(manifest).state === "pending") return false;
  try {
    quality.reviewCoverage(manifest);
    return true;
  } catch (error) {
    if (
      [
        "no review coverage",
        "final HEAD has not been covered by review evidence",
      ].includes(error.message)
    ) {
      return false;
    }
    throw error;
  }
}

function reviewSummary(manifest) {
  const byRange = new Map();
  for (const review of manifest.reviews) {
    byRange.set(`${review.from || ""}\0${review.to || ""}`, review);
  }
  const reviews = [...byRange.values()];
  return {
    status: reviews.some((review) => review.status === "incomplete")
      ? "incomplete"
      : reviews.every((review) => review.status === "exempt")
        ? "policy-exempt"
        : "complete",
    leads: manifest.reviews.reduce(
      (sum, review) => sum + (review.leadCount || 0),
      0,
    ),
  };
}

function likelyExternalRequirement(message) {
  return /(?:signed|capability|approval|operator|override|human-required)/i.test(
    message,
  );
}

function deliveryClaim(manifest) {
  return manifest.options?.deliveryClaim || "contract";
}

function deliveryRepository(manifest) {
  if (manifest.repo.githubRepository) return manifest.repo.githubRepository;
  const origin = manifest.repo.origin || "";
  const match = origin.match(/github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match)
    throw new Error("delivery claim requires a GitHub repository identity");
  return match[1];
}

function deliveryRepositoryId(manifest) {
  const value = String(manifest.repo.githubRepositoryId || "");
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      "delivery claim requires an immutable GitHub repository ID",
    );
  }
  return value;
}

function verifyDeliveryEvidenceDigest(manifest, evidencePath) {
  const binding = manifest.deliveryEvidenceBinding;
  const expected = binding?.sha256;
  if (binding?.head !== manifest.revisions.currentHead) {
    throw new Error("delivery evidence is not bound to the current HEAD");
  }
  if (!/^[a-f0-9]{64}$/i.test(expected || "")) {
    throw new Error("delivery evidence digest is missing from campaign state");
  }
  let body;
  try {
    body = fs.readFileSync(path.resolve(manifest.repo.realpath, evidencePath));
  } catch (error) {
    throw new Error(`delivery evidence cannot be read: ${error.message}`, {
      cause: error,
    });
  }
  const actual = crypto.createHash("sha256").update(body).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error("delivery evidence changed without a HEAD advance");
  }
}

function verifyProtectedProductAdmission(manifest) {
  const evidencePath = manifest.options?.deliveryEvidence;
  verifyDeliveryEvidenceDigest(manifest, evidencePath);
  const requirementsDigest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        prdSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(manifest.options.productPrd))
          .digest("hex"),
        tasksSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(manifest.options.productTasks))
          .digest("hex"),
      }),
    )
    .digest("hex");
  const result = spawnSync(
    process.execPath,
    [
      script("product-admission.js"),
      "verify-remote",
      deliveryRepository(manifest),
      deliveryRepositoryId(manifest),
      manifest.revisions.currentHead,
      requirementsDigest,
      manifest.deliveryEvidenceBinding.sha256,
    ],
    { cwd: manifest.repo.realpath, encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(
      `protected product admission could not start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `protected product admission rejected this exact head${detail ? `: ${detail}` : ""}`,
    );
  }
  try {
    const response = JSON.parse(result.stdout);
    if (response.valid !== true || typeof response.checkId !== "string") {
      throw new Error("protected product admission returned an invalid result");
    }
    return response;
  } catch (error) {
    if (
      error.message === "protected product admission returned an invalid result"
    )
      throw error;
    throw new Error(
      "protected product admission returned malformed structured output",
      { cause: error },
    );
  }
}

function trackedRepositoryPath(manifest, file, label) {
  const relative = path.relative(manifest.repo.realpath, path.resolve(file));
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `${label} must be a tracked file inside the candidate repository`,
    );
  }
  const tracked = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "--", relative],
    {
      cwd: manifest.repo.realpath,
      encoding: "utf8",
    },
  );
  if (tracked.status !== 0) {
    throw new Error(
      `${label} must be committed on the candidate head before protected admission`,
    );
  }
  return relative;
}

function requestProtectedProductAdmission(manifest) {
  const prd = trackedRepositoryPath(
    manifest,
    manifest.options.productPrd,
    "product PRD",
  );
  const tasks = trackedRepositoryPath(
    manifest,
    manifest.options.productTasks,
    "product tasks",
  );
  const requirementsDigest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        prdSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(manifest.options.productPrd))
          .digest("hex"),
        tasksSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(manifest.options.productTasks))
          .digest("hex"),
      }),
    )
    .digest("hex");
  if (
    manifest.productAdmissionRequest?.head === manifest.revisions.currentHead &&
    manifest.productAdmissionRequest.requirementsDigest === requirementsDigest
  ) {
    return false;
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  const result = spawnSync(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${deliveryRepository(manifest)}/dispatches`,
      "-f",
      "event_type=product-evidence-request",
      "-F",
      `client_payload[pullRequest]=${manifest.repo.pr}`,
      "-f",
      `client_payload[base]=${manifest.revisions.baseSha}`,
      "-f",
      `client_payload[head]=${manifest.revisions.currentHead}`,
      "-f",
      `client_payload[prd]=${prd}`,
      "-f",
      `client_payload[tasks]=${tasks}`,
      "-f",
      `client_payload[nonce]=${nonce}`,
    ],
    { cwd: manifest.repo.realpath, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not request protected product admission: ${(result.stderr || "").trim()}`,
    );
  }
  return { requirementsDigest, nonce };
}

function verifierFailure(result) {
  if (result.error) {
    return `product verifier could not start (${result.error.code || "process error"})`;
  }
  if (result.signal) {
    return `product verifier terminated by signal ${result.signal}`;
  }
  if (!result.stdout?.trim()) {
    return `product verifier process failed with status ${result.status}`;
  }
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return "product verifier returned malformed structured output";
  }
  if (output?.valid !== false || !Array.isArray(output.errors)) {
    return "product verifier returned an invalid failure result";
  }
  const hasControlCharacter = (value) =>
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    });
  const errors = output.errors.filter(
    (error) =>
      typeof error === "string" &&
      error.length > 0 &&
      error.length <= 500 &&
      !hasControlCharacter(error),
  );
  if (errors.length === 0 || errors.length !== output.errors.length) {
    return "product verifier returned unsafe or empty diagnostics";
  }
  return errors.slice(0, 10).join("; ");
}

function verifyEngineeringDeliveryClaim(manifest, productInputs) {
  if (productInputs.some(Boolean)) {
    throw new Error(
      "engineering delivery claim cannot carry product acceptance inputs",
    );
  }
  const policy = assertEngineeringPolicy(manifest);
  return `declared engineering at protected policy ${policy.policyRevision}; product acceptance not established`;
}

function verifyDeliveryClaim(manifest) {
  const claim = deliveryClaim(manifest);
  const { productPrd, productTasks, deliveryEvidence } = manifest.options || {};
  const changedFiles = quality.changedFiles(
    manifest.repo.realpath,
    manifest.revisions.baseSha,
    manifest.revisions.currentHead,
  );
  if (changedFiles === null) {
    throw new Error("delivery claim cannot classify the exact candidate diff");
  }
  if (claim === "engineering") {
    return verifyEngineeringDeliveryClaim(manifest, [
      productPrd,
      productTasks,
      deliveryEvidence,
    ]);
  }
  if (
    claim === "contract" &&
    !productPrd &&
    !productTasks &&
    !deliveryEvidence
  ) {
    const productFile = changedFiles.find((file) =>
      productionCodeChange(file, {
        repo: manifest.repo.realpath,
        base: manifest.revisions.baseSha,
        head: manifest.revisions.currentHead,
      }),
    );
    if (productFile) {
      throw new Error(
        `contract delivery claim requires product evidence for product-affecting file '${productFile}'`,
      );
    }
    return "declared contract; no product verifier inputs supplied";
  }
  if (!productPrd || !productTasks || !deliveryEvidence) {
    throw new Error(
      `${claim} delivery claim requires --product-prd, --product-tasks, and --delivery-evidence`,
    );
  }
  verifyDeliveryEvidenceDigest(manifest, deliveryEvidence);
  const changedFilesPath = path.join(
    manifest.stateRoot,
    "delivery-changed-files.json",
  );
  fs.writeFileSync(changedFilesPath, JSON.stringify(changedFiles));
  const result = spawnSync(
    process.execPath,
    [
      script("product-completion.js"),
      "verify-claim",
      "--claim",
      claim,
      "--prd",
      productPrd,
      "--tasks",
      productTasks,
      "--changed-files",
      changedFilesPath,
      "--repo",
      manifest.repo.realpath,
      "--base",
      manifest.revisions.baseSha,
      "--evidence",
      deliveryEvidence,
      "--evidence-sha256",
      manifest.deliveryEvidenceBinding.sha256,
      "--head",
      manifest.revisions.currentHead,
      "--repository",
      deliveryRepository(manifest),
      "--repository-id",
      deliveryRepositoryId(manifest),
    ],
    { cwd: manifest.repo.realpath, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `delivery claim verification failed: ${verifierFailure(result)}`,
    );
  }
  return result.stdout.trim();
}

function actionRequired(manifestPath, phase, message, manifest, review) {
  updateOrchestration(manifestPath, phase, "action-required", message);
  return {
    status: "action-required",
    kind: "external-capability",
    phase,
    message,
    head: manifest.revisions.currentHead,
    review,
  };
}

function prepareProductAdmission(manifestPath) {
  const manifest = manifestAt(manifestPath);
  if (deliveryClaim(manifest) === "contract") return null;
  if (deliveryClaim(manifest) === "engineering") {
    verifyDeliveryClaim(manifest);
    return null;
  }

  // Validate the candidate-owned receipt before spending gate or provider
  // budget. Protected admission is still authoritative, but its request can
  // run while deterministic gates execute instead of being discovered after
  // all local work has already finished.
  verifyDeliveryClaim(manifest);
  if (manifest.options?.merge !== true) return null;
  try {
    verifyProtectedProductAdmission(manifest);
    return null;
  } catch (error) {
    let request;
    try {
      request = requestProtectedProductAdmission(manifest);
    } catch (requestError) {
      return actionRequired(
        manifestPath,
        "product-admission",
        `${error.message}; ${requestError.message}; candidate-worker verification is preflight only`,
        manifest,
      );
    }
    if (request) {
      quality.withManifestLock(manifestPath, (current) => {
        current.productAdmissionRequest = {
          head: current.revisions.currentHead,
          requirementsDigest: request.requirementsDigest,
          requestedAt: new Date().toISOString(),
        };
      });
    }
    return null;
  }
}

function workRequired(manifestPath, phase, message, manifest, detail = {}) {
  const { review, ...resultDetail } = detail;
  updateOrchestration(manifestPath, phase, "work-required", message);
  return {
    status: "work-required",
    kind: phase,
    phase,
    message,
    head: manifest.revisions.currentHead,
    review,
    ...resultDetail,
  };
}

function invocationRuntime(manifestPath, execute) {
  let activeChild = null;
  let interruptedSignal = null;
  const onChild = (child) => {
    activeChild = child;
  };
  const onSignal = (signal) => {
    interruptedSignal ||= signal;
    if (!activeChild || activeChild.killed) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-activeChild.pid, signal);
        return;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    activeChild.kill(signal);
  };
  const assertNotInterrupted = (result) => {
    if (!interruptedSignal && !result.signal) return;
    throw Object.assign(new Error("quality run interrupted"), {
      terminalState: "interrupted",
    });
  };
  const invoke = async (phase, command, args) => {
    assertNotInterrupted({ signal: null });
    updateOrchestration(manifestPath, phase, "running");
    assertNotInterrupted({ signal: null });
    const result = await execute(command, args, {
      cwd: manifestAt(manifestPath).repo.realpath,
      onChild,
    });
    assertNotInterrupted(result);
    if (result.code !== 0) {
      throw Object.assign(
        new Error(`${phase} failed with exit ${result.code}`),
        {
          phase,
          exitCode: result.code,
          preReviewSelectionFailure: phase === "panel",
        },
      );
    }
    updateOrchestration(manifestPath, phase, "success");
    return result;
  };
  return { assertNotInterrupted, invoke, onChild, onSignal };
}

async function runDeterministicPhases(manifestPath, invoke) {
  const admission = prepareProductAdmission(manifestPath);
  if (admission) return admission;
  let manifest = manifestAt(manifestPath);
  if (manifest.risk?.resolved !== true) {
    await invoke("risk", "bash", [
      script("quality-risk-resolve.sh"),
      "--manifest",
      manifestPath,
    ]);
  }
  manifest = manifestAt(manifestPath);
  if (!manifest.panel) {
    await invoke("panel", "bash", [
      script("quality-select-agents.sh"),
      "--manifest",
      manifestPath,
    ]);
  }
  for (const gate of manifestAt(manifestPath).requiredGates) {
    await invoke(`gate:${gate.name}`, "bash", [
      script("quality-run-gate.sh"),
      "--manifest",
      manifestPath,
      "--name",
      gate.name,
    ]);
  }
  const manifestAfterGates = manifestAt(manifestPath);
  updateOrchestration(
    manifestPath,
    "delivery-claim",
    "success",
    verifyDeliveryClaim(manifestAfterGates),
  );
  const gated = manifestAt(manifestPath);
  if (
    ["high", "critical"].includes(gated.risk.tier) &&
    !quality.mutationEvidenceValid(gated)
  ) {
    await invoke("mutation", "bash", [
      script("quality-mutation-check.sh"),
      "--manifest",
      manifestPath,
    ]);
  }
}

async function ensureReview(manifestPath, invoke) {
  const manifest = manifestAt(manifestPath);
  if (quality.incompleteRetryStatus(manifest).state === "pending") {
    await invoke("review-retry-reserve", process.execPath, [
      script("quality-invocation.js"),
      "reserve-incomplete-retry",
      manifestPath,
    ]);
  } else if (currentReview(manifest)) {
    return;
  }
  await invoke("review-authorize", "bash", [
    script("quality-authorize-review-round.sh"),
    manifestPath,
  ]);
  await invoke("review", "bash", [
    script("quality-run-review.sh"),
    "--manifest",
    manifestPath,
  ]);
}

async function finishWithoutMerge(manifestPath, invoke, manifest, review) {
  if (review.status === "incomplete") {
    await invoke("terminal", process.execPath, [
      script("quality-invocation.js"),
      "terminal-state",
      manifestPath,
      "--state",
      "provider-incomplete",
      "--detail",
      `review:incomplete;leads:${review.leads}`,
    ]);
    return {
      status: "terminal",
      state: "provider-incomplete",
      head: manifest.revisions.currentHead,
      review,
    };
  }
  await invoke("terminal", process.execPath, [
    script("quality-invocation.js"),
    "terminal-state",
    manifestPath,
    "--state",
    "verified-unmerged",
    "--detail",
    `review:${review.status};leads:${review.leads}`,
  ]);
  return {
    status: "complete",
    state: "verified-unmerged",
    head: manifest.revisions.currentHead,
    review,
  };
}

async function finishWithMerge(context, manifestPath, manifest, review) {
  if (!["contract", "engineering"].includes(deliveryClaim(manifest))) {
    try {
      verifyProtectedProductAdmission(manifest);
    } catch (error) {
      let requested = false;
      try {
        const request = requestProtectedProductAdmission(manifest);
        if (request) {
          quality.withManifestLock(manifestPath, (current) => {
            current.productAdmissionRequest = {
              head: current.revisions.currentHead,
              requirementsDigest: request.requirementsDigest,
              requestedAt: new Date().toISOString(),
            };
          });
          requested = true;
        }
      } catch (requestError) {
        return actionRequired(
          manifestPath,
          "product-admission",
          `${error.message}; ${requestError.message}; candidate-worker verification is preflight only`,
          manifest,
          review,
        );
      }
      return actionRequired(
        manifestPath,
        "product-admission",
        `${error.message}; ${requested ? "protected evidence has been requested" : "protected evidence is pending"}; candidate-worker verification is preflight only`,
        manifest,
        review,
      );
    }
  }
  try {
    quality.reviewAuthorization(manifest);
  } catch (error) {
    if (!likelyExternalRequirement(error.message)) throw error;
    return actionRequired(
      manifestPath,
      "authorization",
      error.message,
      manifest,
      review,
    );
  }
  updateOrchestration(manifestPath, "merge", "running");
  // An admission block describes one merge attempt only. Retaining it would
  // let a later, unrelated failure inherit the prior signed condition.
  quality.clearMergeAdmissionBlock(manifestPath);
  context.runtime.assertNotInterrupted({ signal: null });
  const expectedHead = manifest.revisions.currentHead;
  const merge = await context.execute(
    "bash",
    [script("quality-stamp-and-merge.sh"), "--manifest", manifestPath],
    {
      cwd: manifest.repo.realpath,
      onChild: context.runtime.onChild,
    },
  );
  context.runtime.assertNotInterrupted(merge);
  if (merge.code === 0) {
    const merged = manifestAt(manifestPath);
    if (
      merged.terminalState?.state !== "merged" ||
      merged.terminalState.head !== expectedHead ||
      merged.revisions.currentHead !== expectedHead
    ) {
      throw Object.assign(
        new Error(
          "merge process exited successfully without exact-head merged terminal evidence",
        ),
        { terminalContractFailure: true },
      );
    }
    return {
      status: "complete",
      state: "merged",
      head: merged.revisions.currentHead,
      review,
    };
  }
  const afterMerge = manifestAt(manifestPath);
  if (merge.code === ACTION_REQUIRED_EXIT) {
    const message = `${merge.stderr || ""}\n${merge.stdout || ""}`.trim();
    const terminal = afterMerge.terminalState;
    const admission = afterMerge.merge?.admissionBlock;
    const terminalConditions = [
      ...(terminal?.mergeAdmissionConditions || []),
    ].sort();
    const admissionConditions = [...(admission?.conditions || [])].sort();
    const evidenceMatches =
      terminal?.state === "blocked" &&
      terminal.head === afterMerge.revisions.currentHead &&
      admission?.head === terminal.head &&
      Number.isInteger(terminal.terminalEpoch) &&
      admission.terminalEpoch === terminal.terminalEpoch &&
      typeof terminal.mergeAttemptId === "string" &&
      terminal.mergeAttemptId.length > 0 &&
      admission.mergeAttemptId === terminal.mergeAttemptId &&
      terminalConditions.length > 0 &&
      JSON.stringify(admissionConditions) ===
        JSON.stringify(terminalConditions);
    if (!evidenceMatches) {
      throw Object.assign(
        new Error(
          "merge capability requirement lacks matching atomic admission evidence",
        ),
        { terminalContractFailure: true },
      );
    }
    if (!afterMerge.governor?.activeExecution)
      context.ownership.acceptTypedPause();
    return actionRequired(
      manifestPath,
      "merge",
      message || "merge requires an external governance capability",
      afterMerge,
      review,
    );
  }
  if (
    afterMerge.terminalState &&
    afterMerge.terminalState.state !== "recovering"
  ) {
    return {
      status: "terminal",
      state: afterMerge.terminalState.state,
      head: afterMerge.revisions.currentHead,
    };
  }
  quality.withManifestLock(manifestPath, (locked) => {
    locked.merge.readFailure = {
      kind:
        merge.code === 75 ? "ci-admission-read-failed" : "merge-process-failed",
      head: expectedHead,
      exitCode: merge.code,
      stdout: (merge.stdout || "").slice(-8192),
      stderr: (merge.stderr || "").slice(-8192),
      recordedAt: new Date().toISOString(),
    };
  });
  throw new Error(
    merge.code === 75
      ? "ci-admission-read-failed"
      : `merge admission failed with exit ${merge.code}`,
  );
}

async function recordFailure(context, manifestPath, error) {
  let manifest;
  try {
    manifest = manifestAt(manifestPath);
  } catch {
    throw error;
  }
  if (
    manifest.terminalState?.recovery?.kind === "merge-read-failure" &&
    !context.mergeReadRecoveryGranted
  ) {
    return {
      status: "terminal",
      state: manifest.terminalState.state,
      head: manifest.revisions.currentHead,
    };
  }
  if (error.terminalContractFailure && manifest.terminalState) {
    return {
      status: "contract-failed",
      observedTerminalState: manifest.terminalState.state,
      message: error.message,
      head: manifest.revisions.currentHead,
    };
  }
  if (
    error.preReviewSelectionFailure === true &&
    Number.isInteger(error.exitCode) &&
    error.exitCode !== 0 &&
    !manifest.terminalState
  ) {
    const terminal = quality.recordPreReviewSelectionFailure(
      manifestPath,
      error.message,
      error.exitCode,
    );
    return {
      status: "terminal",
      state: terminal.state,
      message: error.message,
      head: manifest.revisions.currentHead,
    };
  }
  if (
    !manifest.terminalState ||
    manifest.terminalState.state === "recovering"
  ) {
    const stale =
      /identity.*(?:changed|mismatch)|(?:HEAD|head).*(?:changed|moved|mismatch)|stale|supersed/i.test(
        error.message,
      );
    const state = error.terminalState || (stale ? "superseded" : "blocked");
    const result = await context.execute(
      process.execPath,
      [
        script("quality-invocation.js"),
        "terminal-state",
        manifestPath,
        "--state",
        state,
        "--detail",
        error.message,
      ],
      {
        cwd: manifest.repo.realpath,
        onChild: context.runtime.onChild,
      },
    );
    if (result.code !== 0) {
      throw new Error(
        `terminal state recording failed after: ${error.message}`,
        { cause: error },
      );
    }
  }
  const terminal = manifestAt(manifestPath).terminalState;
  return {
    status: "terminal",
    state: terminal.state,
    message: error.message,
    head: manifest.revisions.currentHead,
  };
}

async function pendingLeadWork(context, manifestPath, manifest, review) {
  if ((manifest.reviewContractVersion || 1) < 2) return null;
  const disposition = leadDispositionStatus(manifest);
  if (disposition.state === "pending") {
    return workRequired(
      manifestPath,
      "lead-verification",
      "verify every identity-bound AI lead, record its deterministic disposition, and resume this manifest",
      manifest,
      { review, context: disposition.context },
    );
  }
  if (disposition.state !== "remediation-required") return null;
  const remediation = remediationState(manifest);
  if (remediation.started && !remediation.advanced && remediation.requested) {
    throw new Error(
      "bounded remediation made no progress: the requested repair commit is missing",
    );
  }
  if (remediation.started && remediation.advanced) {
    throw new Error(
      `bounded remediation did not converge: ${disposition.blockingCount} confirmed finding(s) remain after the one permitted repair head`,
    );
  }
  if (!remediation.started) {
    await context.runtime.invoke("remediation-budget", process.execPath, [
      script("quality-run-governor.js"),
      "check",
      manifestPath,
    ]);
    manifest = manifestAt(manifestPath);
  }
  return workRequired(
    manifestPath,
    "remediation",
    "apply one batched repair commit for the confirmed findings, then resume this manifest for exact-head gates and delta review",
    manifest,
    {
      review,
      blockingCount: disposition.blockingCount,
      artifactPath: disposition.artifactPath,
    },
  );
}

function remediationState(manifest) {
  return {
    started: Number.isInteger(manifest.governor?.remediationStartedAtEpoch),
    advanced: manifest.revisions.currentHead !== manifest.revisions.initialHead,
    requested:
      manifest.orchestration?.head === manifest.revisions.currentHead &&
      manifest.orchestration?.steps?.remediation?.status === "work-required",
  };
}

function leadDispositionStatus(manifest) {
  const context = quality.judgeContext(manifest);
  if (context.findings.length === 0) {
    return { state: "not-required", context };
  }
  const judge = manifest.judge;
  if (!dispositionFresh(judge, context)) {
    return { state: "pending", context };
  }
  if (
    typeof judge.artifactPath !== "string" ||
    typeof judge.artifactSha256 !== "string"
  ) {
    throw new Error("persisted lead disposition artifact is malformed");
  }
  const raw = fs.readFileSync(judge.artifactPath);
  const artifactSha256 = crypto.createHash("sha256").update(raw).digest("hex");
  if (artifactSha256 !== judge.artifactSha256) {
    throw new Error("persisted lead disposition artifact integrity mismatch");
  }
  const artifact = quality.parseJson(
    raw.toString("utf8"),
    "persisted lead disposition artifact",
  );
  if (!Array.isArray(artifact.findings)) {
    throw new Error("persisted lead disposition artifact is malformed");
  }
  const artifactMatches = dispositionArtifactMatches(artifact, judge, context);
  const blockingCount = artifact.findings.filter(
    (finding) => finding.disposition === "BLOCKING",
  ).length;
  if (!artifactMatches || blockingCount !== judge.blockingCount) {
    throw new Error("persisted lead disposition artifact integrity mismatch");
  }
  return {
    state: blockingCount > 0 ? "remediation-required" : "settled",
    blockingCount,
    artifactPath: judge.artifactPath,
    context,
  };
}

function dispositionFresh(judge, context) {
  return (
    judge?.head === context.head &&
    judge?.reviewCount === context.reviewCount &&
    judge?.evidenceSha256 === context.evidenceSha256
  );
}

function dispositionArtifactMatches(artifact, judge, context) {
  return (
    artifact.head === context.head &&
    artifact.invocationId === context.invocationId &&
    artifact.repositoryKey === context.repositoryKey &&
    artifact.reviewCount === context.reviewCount &&
    artifact.evidenceSha256 === context.evidenceSha256
  );
}

async function runOpenCampaign(context, manifestPath, manifest) {
  updateOrchestration(manifestPath, "validate", "success");
  const admission = await runDeterministicPhases(
    manifestPath,
    context.runtime.invoke,
  );
  if (admission) return admission;
  await ensureReview(manifestPath, context.runtime.invoke);
  manifest = manifestAt(manifestPath);
  quality.reviewCoverage(manifest);
  const review = reviewSummary(manifest);
  const leadWork = await pendingLeadWork(
    context,
    manifestPath,
    manifest,
    review,
  );
  if (leadWork) return leadWork;
  return manifest.options?.merge === true
    ? finishWithMerge(context, manifestPath, manifest, review)
    : finishWithoutMerge(
        manifestPath,
        context.runtime.invoke,
        manifest,
        review,
      );
}

async function runManifest(manifestPath, dependencies = {}) {
  // Validate before canonicalizing: a symlinked manifest remains forbidden.
  const initial = quality.loadManifest(manifestPath);
  manifestPath = fs.realpathSync(initial.manifestPath);
  const ownership = runnerOwnership.acquireRunner(manifestPath);
  if (!ownership)
    return {
      status: "busy",
      reason: "runner-owned",
      head: initial.manifest.revisions.currentHead,
    };
  if (manifestAt(manifestPath).governor?.activeExecution) {
    // This invocation has not dispatched a child. Release only its new lock;
    // existing governor reconciliation, not admission, owns orphan expiry.
    ownership.release(false);
    return {
      status: "busy",
      reason: "active-execution",
      head: initial.manifest.revisions.currentHead,
    };
  }
  const execute = (...args) =>
    ownership.execute(dependencies.runProcess || runProcess, ...args);
  const runtime = invocationRuntime(manifestPath, execute);
  const context = { execute, runtime, ownership };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map(
    signals.map((signal) => [
      signal,
      () => {
        ownership.markSignalUncertain();
        runtime.onSignal(signal);
      },
    ]),
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    let manifest = manifestAt(manifestPath);
    if (manifest.terminalState?.recovery?.kind === "merge-read-failure") {
      return {
        status: "terminal",
        state: manifest.terminalState.state,
        head: manifest.revisions.currentHead,
      };
    }
    pinRepositoryLease(manifest);
    quality.advanceManifest(manifestPath);
    manifest = manifestAt(manifestPath);
    pinTerminalEpoch(manifest);
    quality.validateIdentity(manifest, manifest.repo.realpath);
    if (manifest.terminalState) {
      const mergeReadRecovery = quality.resumeMergeReadFailure(manifestPath);
      if (mergeReadRecovery) {
        context.mergeReadRecoveryGranted = true;
        const resumed = manifestAt(manifestPath);
        pinTerminalEpoch(resumed);
        return await finishWithMerge(
          context,
          manifestPath,
          resumed,
          reviewSummary(resumed),
        );
      }
      const ciRecovery = quality.resolveGreenCiAdmissionBlock(manifestPath);
      if (ciRecovery) {
        const resumed = manifestAt(manifestPath);
        pinTerminalEpoch(resumed);
        quality.validateIdentity(resumed, resumed.repo.realpath);
        return await finishWithMerge(
          context,
          manifestPath,
          resumed,
          reviewSummary(resumed),
        );
      }
      const recovery = quality.resumeRecoverableTerminal(manifestPath);
      if (recovery) {
        const resumed = manifestAt(manifestPath);
        pinTerminalEpoch(resumed);
        return await finishWithMerge(
          context,
          manifestPath,
          resumed,
          reviewSummary(resumed),
        );
      }
      const interruptedRecovery =
        quality.resumeInterruptedTerminal(manifestPath);
      if (interruptedRecovery) {
        const resumed = manifestAt(manifestPath);
        pinTerminalEpoch(resumed);
        quality.validateIdentity(resumed, resumed.repo.realpath);
        return await runOpenCampaign(context, manifestPath, resumed);
      }
      const selectionRecovery =
        quality.resumePreReviewSelectionFailure(manifestPath);
      if (selectionRecovery) {
        const resumed = manifestAt(manifestPath);
        pinTerminalEpoch(resumed);
        quality.validateIdentity(resumed, resumed.repo.realpath);
        return await runOpenCampaign(context, manifestPath, resumed);
      }
      return {
        status: "terminal",
        state: manifest.terminalState.state,
        head: manifest.revisions.currentHead,
      };
    }
    return await runOpenCampaign(context, manifestPath, manifest);
  } catch (error) {
    return await recordFailure(context, manifestPath, error);
  } finally {
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
    ownership.release();
  }
}

async function main() {
  try {
    const manifestPath = parseArgs(process.argv.slice(2));
    const result = await runManifest(manifestPath);
    emit(result);
    if (result.status === "busy") {
      process.exitCode = BUSY_EXIT;
    } else if (result.status === "action-required") {
      process.exitCode = ACTION_REQUIRED_EXIT;
    } else if (result.status === "work-required") {
      process.exitCode = WORK_REQUIRED_EXIT;
    } else if (result.status === "complete") {
      process.exitCode = 0;
    } else if (
      result.status !== "terminal" ||
      !["merged", "verified-unmerged"].includes(result.state)
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`quality-run: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  ACTION_REQUIRED_EXIT,
  WORK_REQUIRED_EXIT,
  ORCHESTRATION_SCHEMA_VERSION,
  parseArgs,
  pinRepositoryLease,
  reviewSummary,
  runManifest,
  writeAllSync: runnerOwnership.writeAllSync,
};

if (require.main === module) main();
