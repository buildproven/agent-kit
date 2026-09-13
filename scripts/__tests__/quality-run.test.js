const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const SOURCE_RUNNER = path.resolve(__dirname, "..", "quality-run.js");
const { writeAllSync } = require(SOURCE_RUNNER);
const { ownershipSchemaVersion } = require("../quality-runner-ownership");

const FAKE_INVOCATION = `
"use strict";
const fs = require("node:fs");
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function parseJson(raw) { return JSON.parse(raw); }
function loadManifest(file) { return { manifest: read(file), manifestPath: file }; }
function withManifestLock(file, mutation) {
  const manifest = read(file);
  if (manifest.options?.merge === true &&
      process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN !== manifest.merge?.repositoryLease?.token) {
    throw new Error("repository lease credential is required for manifest mutation");
  }
  mutation(manifest, file);
  manifest.manifestRevision = (manifest.manifestRevision || 0) + 1;
  write(file, manifest);
  return manifest;
}
function validateIdentity(manifest) {
  if (manifest.behavior?.stale) throw new Error("manifest HEAD identity is stale");
}
function terminalEpoch(manifest) { return manifest.terminalEpoch || 0; }
function advanceHead(manifest) {
  if (!manifest.behavior?.nextHead) return false;
  manifest.revisions.currentHead = manifest.behavior.nextHead;
  delete manifest.behavior.nextHead;
  return true;
}
function advanceManifest(file) {
  return withManifestLock(file, (manifest) => {
    const active = manifest.governor?.activeExecution;
    if (active && Date.now() < Date.parse(active.startedAt) + active.timeoutSeconds * 1000) {
      throw new Error("provider execution 'review' is already active");
    }
    manifest.advanceMode = "transactional";
    return advanceHead(manifest);
  });
}
function resumeMergeReadFailure() { return null; }
function resumeRecoverableTerminal(file) {
  const manifest = read(file);
  if (!manifest.behavior?.recoverTerminal || !["blocked", "recovering"].includes(manifest.terminalState?.state)) return null;
  const epoch = terminalEpoch(manifest) + 1;
  manifest.terminalHistory ||= [];
  if (manifest.terminalState.state === "blocked") {
    manifest.terminalHistory.push({ ...manifest.terminalState, disposition: "superseded-by-capability" });
  }
  manifest.terminalHistory.push({ event: "reopened-by-capability", terminalEpoch: epoch });
  manifest.terminalEpoch = epoch;
  manifest.terminalState = { state: "recovering", head: manifest.revisions.currentHead, terminalEpoch: epoch };
  write(file, manifest);
  return manifest.terminalState;
}
function resumeInterruptedTerminal(file) {
  const manifest = read(file);
  const terminal = manifest.terminalState;
  if (terminal?.state !== "interrupted" ||
      terminal.head !== manifest.revisions.currentHead ||
      manifest.governor?.activeExecution) return null;
  const epoch = terminalEpoch(manifest) + 1;
  manifest.terminalHistory ||= [];
  manifest.terminalHistory.push({ ...terminal, disposition: "resumed-after-interruption" });
  manifest.terminalHistory.push({ event: "reopened-after-interruption", terminalEpoch: epoch });
  manifest.terminalEpoch = epoch;
  delete manifest.terminalState;
  write(file, manifest);
  return { head: manifest.revisions.currentHead, terminalEpoch: epoch };
}
function clearMergeAdmissionBlock(file) {
  const manifest = read(file);
  if (!manifest.merge?.admissionBlock) return false;
  delete manifest.merge.admissionBlock;
  write(file, manifest);
  return true;
}
function resolveGreenCiAdmissionBlock(file) {
  const manifest = read(file);
  if (!manifest.behavior?.greenCiRecovery ||
      manifest.terminalState?.state !== "blocked" ||
      JSON.stringify(manifest.terminalState?.mergeAdmissionConditions) !== JSON.stringify(["ci:failed"]) ||
      JSON.stringify(manifest.merge?.admissionBlock?.conditions) !== JSON.stringify(["ci:failed"])) return false;
  const epoch = terminalEpoch(manifest) + 1;
  manifest.terminalHistory ||= [];
  manifest.terminalHistory.push({ ...manifest.terminalState, disposition: "resolved-by-green-ci" });
  manifest.terminalHistory.push({ event: "reopened-by-green-ci", terminalEpoch: epoch });
  manifest.terminalEpoch = epoch;
  delete manifest.terminalState;
  delete manifest.merge.admissionBlock;
  write(file, manifest);
  return true;
}
function mutationEvidenceValid(manifest) { return Boolean(manifest.mutation); }
function incompleteRetryStatus(manifest) {
  const incomplete = manifest.reviews.filter((review) => review.status === "incomplete");
  return { state: manifest.behavior?.retryPending && incomplete.length === 1 ? "pending" : "none" };
}
function reviewCoverage(manifest) {
  const exact = manifest.reviews.some((review) => review.to === manifest.revisions.currentHead);
  const carried = manifest.revisions.reviewRebaseCarries?.some((carry) =>
    carry.head === manifest.revisions.currentHead &&
    manifest.reviews.some((review) => review.to === carry.reviewedHead));
  if (!exact && !carried) {
    throw new Error("final HEAD has not been covered by review evidence");
  }
  if (manifest.gates.some((gate) => gate.status !== "success")) {
    throw new Error("required gate evidence is incomplete");
  }
}
function changedFiles(root, baseSha, head) {
  const manifest = read(process.env.QUALITY_TEST_MANIFEST);
  return manifest.behavior?.changedFiles || [];
}
function reviewAuthorization(manifest) {
  reviewCoverage(manifest);
  if (manifest.behavior?.approvalRequired) {
    throw new Error("a signed exact-head operator capability is required");
  }
  return {
    reviewStatus: manifest.reviews.some(
      (review) => review.status === "incomplete",
    )
      ? "incomplete"
      : "complete",
  };
}
function judgeContext(manifest) {
  reviewCoverage(manifest);
  return {
    invocationId: "fixture-invocation",
    repositoryKey: "fixture-repository",
    head: manifest.revisions.currentHead,
    reviewCount: manifest.reviews.length,
    evidenceSha256: "fixture-evidence",
    findings: Array.from({ length: manifest.behavior?.leads || 0 }, (_, index) => ({
      id: "lead-" + (index + 1),
      provider: "fixture-provider",
      source: "fixture-review",
    })),
  };
}
function leadDispositionStatus(manifest) {
  const context = judgeContext(manifest);
  if (context.findings.length === 0) return { state: "not-required", context };
  if (manifest.judge?.head !== context.head) return { state: "pending", context };
  return {
    state: manifest.judge.blockingCount > 0 ? "remediation-required" : "settled",
    blockingCount: manifest.judge.blockingCount,
    artifactPath: manifest.judge.artifactPath,
    context,
  };
}
function recordTerminalState(file, state, detail) {
  const manifest = read(file);
  if (!manifest.terminalState || manifest.terminalState.state === "recovering") {
    manifest.terminalState = {
      state,
      detail,
      head: manifest.revisions.currentHead,
      terminalEpoch: terminalEpoch(manifest),
    };
  }
  write(file, manifest);
  return manifest.terminalState.state;
}
if (require.main === module) {
  const [, , command, file, ...args] = process.argv;
  if (command === "reserve-incomplete-retry") {
    const manifest = read(file);
    manifest.retryReserved = true;
    write(file, manifest);
    process.exit(0);
  }
  if (command !== "terminal-state") process.exit(2);
  if (read(file).behavior?.terminalRecorderFail) process.exit(7);
  const state = args[args.indexOf("--state") + 1];
  const detail = args[args.indexOf("--detail") + 1];
  const inForce = recordTerminalState(file, state, detail);
  const manifest = read(file);
  manifest.telemetryWrites = (manifest.telemetryWrites || 0) + 1;
  write(file, manifest);
  process.stdout.write(inForce + "\\n");
}
module.exports = { advanceHead, incompleteRetryStatus, judgeContext, leadDispositionStatus, loadManifest, mutationEvidenceValid, parseJson, recordTerminalState,
  advanceManifest, changedFiles, clearMergeAdmissionBlock, resolveGreenCiAdmissionBlock, reviewAuthorization, reviewCoverage, resumeInterruptedTerminal, resumeMergeReadFailure, resumeRecoverableTerminal, terminalEpoch, validateIdentity, withManifestLock };
`;

const FAKE_STEP = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [step, ...args] = process.argv.slice(2);
const index = args.indexOf("--manifest");
const file = index >= 0 ? args[index + 1] :
  (step === "quality-run-governor.js" ? args[1] : args[0]);
let manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.calls ||= [];
manifest.calls.push(step);
if (step === "quality-risk-resolve.sh") manifest.risk.resolved = true;
if (step === "quality-risk-resolve.sh" && manifest.behavior?.orphanSuccessfulChild) {
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  orphan.unref();
  fs.writeFileSync(file + ".successful-orphan-pid", String(orphan.pid));
}
if (step === "quality-risk-resolve.sh" && manifest.behavior?.failRisk) {
  fs.writeFileSync(file, JSON.stringify(manifest));
  process.exit(5);
}
if (step === "quality-select-agents.sh") {
  if (manifest.panel) {
    fs.writeFileSync(file, JSON.stringify(manifest));
    process.stderr.write("quality agent selection is immutable once persisted\\n");
    process.exit(1);
  }
  manifest.panel = { rule: "fixture" };
}
if (step === "quality-run-gate.sh") {
  const name = args[args.indexOf("--name") + 1];
  if (manifest.behavior?.signalGate === name) {
    fs.writeFileSync(file, JSON.stringify(manifest));
    process.kill(process.ppid, "SIGTERM");
    setTimeout(() => {}, 5000);
    return;
  }
  if (manifest.behavior?.failGate === name) {
    manifest.gates.push({ name, status: "failed" });
    manifest.terminalState = { state: "blocked", detail: "gate:" + name };
    manifest.telemetryWrites = (manifest.telemetryWrites || 0) + 1;
    fs.writeFileSync(file, JSON.stringify(manifest));
    process.exit(1);
  }
  manifest.gates.push({ name, status: "success" });
}
if (step === "quality-mutation-check.sh") manifest.mutation = true;
if (step === "quality-run-governor.js") {
  if (manifest.behavior?.remediationBudgetFail) process.exit(1);
  manifest.governor.remediationStartedAtEpoch ||= 1;
}
if (step === "quality-run-review.sh" && manifest.behavior?.holdReview) {
  manifest.governor.activeExecution = {
    kind: "provider", name: "review", startedAt: new Date().toISOString(), timeoutSeconds: 30,
  };
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.writeFileSync(file + ".review-ready", "ready");
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file + ".review-release") && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(file + ".review-release")) process.exit(9);
  manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.governor.activeExecution = null;
}
if (step === "quality-run-review.sh") manifest.reviews.push({
  from: manifest.reviews.filter((review) =>
    ["complete", "exempt"].includes(review.status)).at(-1)?.to || manifest.revisions.baseSha,
  to: manifest.revisions.currentHead,
  status: manifest.behavior?.incompleteReview ? "incomplete" :
    (manifest.risk.tier === "low" ? "exempt" : "complete"),
  leadCount: manifest.behavior?.leads || 0,
});
if (step === "quality-stamp-and-merge.sh") {
  if (manifest.behavior?.externalMergeRequirement) {
    if (manifest.behavior?.orphanMergeDescendant) {
      const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      orphan.unref();
      fs.writeFileSync(file + ".merge-orphan-pid", String(orphan.pid));
    }
    const terminalEpoch = manifest.terminalEpoch || 0;
    const mergeAttemptId = "fixture-merge-attempt";
    manifest.merge ||= {};
    manifest.merge.admissionBlock = {
      conditions: ["base:protected-nonstrict", "pr:non-atomic-state"],
      head: manifest.revisions.currentHead,
      terminalEpoch,
      mergeAttemptId,
    };
    manifest.terminalState = {
      state: "blocked",
      detail: "protected base requires a signed capability",
      head: manifest.revisions.currentHead,
      terminalEpoch,
      mergeAttemptId,
      mergeAdmissionConditions: [
        "base:protected-nonstrict",
        "pr:non-atomic-state",
      ],
    };
    manifest.telemetryWrites = (manifest.telemetryWrites || 0) + 1;
    fs.writeFileSync(file, JSON.stringify(manifest));
    process.stderr.write("protected base requires a signed capability\\n");
    process.exit(3);
  }
  if (manifest.behavior?.failMerge) {
    fs.writeFileSync(file, JSON.stringify(manifest));
    if (manifest.behavior.mergeWarning) {
      process.stderr.write(manifest.behavior.mergeWarning + "\\n");
    }
    process.stderr.write("required CI failed on exact candidate\\n");
    process.exit(manifest.behavior.mergeExit || 1);
  }
  if (!manifest.behavior?.mergeWithoutTerminal) {
    if (manifest.behavior?.rewriteMergedHead) {
      manifest.revisions.currentHead = "rewritten999";
    }
    manifest.terminalState = { state: "merged", head: manifest.revisions.currentHead };
    manifest.telemetryWrites = (manifest.telemetryWrites || 0) + 1;
  }
}
fs.writeFileSync(file, JSON.stringify(manifest));
if (step === "quality-run-review.sh" && manifest.behavior?.holdReview) fs.writeFileSync(file + ".review-finished", "done");
`;

function installEngineeringPolicyFixture(runtime, behavior) {
  if (behavior.deliveryClaim === "engineering") {
    writeFileSync(
      path.join(runtime, "engineering-delivery-policy.js"),
      `"use strict"; module.exports = { assertEngineeringPolicy() { ${
        behavior.policyReject
          ? `throw new Error(${JSON.stringify(behavior.policyReject)});`
          : 'return { policyRevision: "base123", productAcceptance: "not-established" };'
      } } };\n`,
    );
  } else {
    copyFileSync(
      path.resolve(__dirname, "..", "engineering-delivery-policy.js"),
      path.join(runtime, "engineering-delivery-policy.js"),
    );
  }
}

function fixture(behavior = {}, { merge = false, tier = "low" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "quality-run-"));
  const runtime = path.join(root, "scripts");
  mkdirSync(runtime);
  copyFileSync(SOURCE_RUNNER, path.join(runtime, "quality-run.js"));
  copyFileSync(
    path.resolve(__dirname, "..", "quality-runner-ownership.js"),
    path.join(runtime, "quality-runner-ownership.js"),
  );
  copyFileSync(
    path.resolve(__dirname, "..", "quality-runner-reconcile.js"),
    path.join(runtime, "quality-runner-reconcile.js"),
  );
  copyFileSync(
    path.resolve(__dirname, "..", "product-completion.js"),
    path.join(runtime, "product-completion.js"),
  );
  copyFileSync(
    path.resolve(__dirname, "..", "product-evidence.js"),
    path.join(runtime, "product-evidence.js"),
  );
  installEngineeringPolicyFixture(runtime, behavior);
  writeFileSync(
    path.join(runtime, "product-admission.js"),
    behavior.productAdmission
      ? `#!/usr/bin/env node\n${behavior.productAdmission}\n`
      : "#!/usr/bin/env node\nprocess.stderr.write('no protected admission fixture\\n'); process.exitCode = 1;\n",
  );
  if (behavior.productVerifier) {
    const verifier = path.join(runtime, "product-completion.js");
    writeFileSync(
      verifier,
      `#!/usr/bin/env node\nmodule.exports = { productionCodeChange: () => true };\nif (require.main === module) { ${behavior.productVerifier} }\n`,
    );
  }
  chmodSync(path.join(runtime, "quality-run.js"), 0o755);
  writeFileSync(path.join(runtime, "quality-invocation.js"), FAKE_INVOCATION);
  writeFileSync(path.join(runtime, "fake-step.js"), FAKE_STEP);
  for (const name of [
    "quality-risk-resolve.sh",
    "quality-select-agents.sh",
    "quality-run-gate.sh",
    "quality-mutation-check.sh",
    "quality-authorize-review-round.sh",
    "quality-run-review.sh",
    "quality-stamp-and-merge.sh",
  ]) {
    const file = path.join(runtime, name);
    writeFileSync(
      file,
      `#!/usr/bin/env bash\nexec node "${path.join(runtime, "fake-step.js")}" "${name}" "$@"\n`,
    );
    chmodSync(file, 0o755);
  }
  writeFileSync(
    path.join(runtime, "quality-run-governor.js"),
    `#!/usr/bin/env node\nprocess.argv.splice(2, 0, "quality-run-governor.js"); require("${path.join(runtime, "fake-step.js")}");\n`,
  );
  const manifestPath = path.join(root, "invocation.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      manifestRevision: 0,
      stateRoot: root,
      repo: {
        realpath: root,
        origin: "https://github.com/buildproven/fixture.git",
        githubRepositoryId: "123456",
      },
      revisions: {
        initialHead: "abc123",
        currentHead: "abc123",
        baseSha: "base123",
      },
      options: behavior.productVerifier
        ? {
            merge,
            deliveryClaim: "local-product",
            productPrd: path.join(root, "prd.md"),
            productTasks: path.join(root, "tasks.md"),
            deliveryEvidence: path.join(root, "evidence.json"),
          }
        : {
            merge,
            ...(behavior.deliveryClaim
              ? { deliveryClaim: behavior.deliveryClaim }
              : {}),
          },
      ...(merge
        ? { merge: { repositoryLease: { token: "fixture-token" } } }
        : {}),
      risk: { resolved: false, tier },
      requiredGates: ["lint", "test", "security"].map((name) => ({ name })),
      gates: [],
      reviews: [],
      reviewContractVersion: 2,
      invocationId: "fixture-invocation",
      governor: { remediationStartedAtEpoch: null },
      behavior,
      ...(behavior.productVerifier
        ? {
            deliveryEvidenceBinding: {
              head: "abc123",
              sha256: createHash("sha256").update("fixture\n").digest("hex"),
              history: [],
            },
          }
        : {}),
    }),
  );
  if (behavior.productVerifier) {
    for (const name of ["prd.md", "tasks.md", "evidence.json"]) {
      writeFileSync(path.join(root, name), "fixture\n");
    }
  }
  return {
    manifestPath,
    runner: path.join(runtime, "quality-run.js"),
    reconciler: path.join(runtime, "quality-runner-reconcile.js"),
  };
}

function run(entry) {
  const env = { ...process.env, QUALITY_TEST_MANIFEST: entry.manifestPath };
  delete env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
  const result = spawnSync(
    process.execPath,
    [entry.runner, "--manifest", entry.manifestPath],
    {
      encoding: "utf8",
      env,
      // The repository allows subprocess-heavy integration cases 60 seconds
      // under its eight-worker pool. Keep this fixture below that bound while
      // avoiding a machine-load-dependent false timeout.
      timeout: 30_000,
    },
  );
  return {
    ...result,
    manifest: JSON.parse(readFileSync(entry.manifestPath, "utf8")),
    output: result.stdout.trim().split("\n").at(-1),
  };
}

function reconcile(entry, record, extra = []) {
  return spawnSync(
    process.execPath,
    [
      entry.reconciler,
      "--manifest",
      entry.manifestPath,
      "--head",
      "abc123",
      "--owner-host",
      record.hostname,
      "--owner-pid",
      String(record.pid),
      "--owner-nonce",
      record.nonce,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

function recordDisposition(entry, blockingCount, label = "judge") {
  const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
  const findings = Array.from(
    { length: manifest.behavior?.leads || 0 },
    (_, index) => ({
      id: `lead-${index + 1}`,
      provider: "fixture-provider",
      source: "fixture-review",
      disposition: index < blockingCount ? "BLOCKING" : "SUPPRESSED",
    }),
  );
  const artifact = {
    invocationId: manifest.invocationId,
    repositoryKey: "fixture-repository",
    head: manifest.revisions.currentHead,
    reviewCount: manifest.reviews.length,
    evidenceSha256: "fixture-evidence",
    findings,
  };
  const artifactPath = path.join(
    path.dirname(entry.manifestPath),
    `${label}.json`,
  );
  const raw = JSON.stringify(artifact);
  writeFileSync(artifactPath, raw);
  manifest.judge = {
    head: artifact.head,
    reviewCount: artifact.reviewCount,
    evidenceSha256: artifact.evidenceSha256,
    blockingCount,
    artifactPath,
    artifactSha256: createHash("sha256").update(raw).digest("hex"),
  };
  writeFileSync(entry.manifestPath, JSON.stringify(manifest));
}

describe("quality-run public orchestration", () => {
  it("uses the explicit-confirmation compatibility schema without POSIX process groups", () => {
    expect(ownershipSchemaVersion("win32")).toBe(1);
    expect(ownershipSchemaVersion("darwin")).toBe(2);
    expect(ownershipSchemaVersion("linux")).toBe(2);
  });

  it("completes short ownership writes before returning", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "quality-run-write-"));
    const file = path.join(root, "owner");
    const descriptor = require("node:fs").openSync(file, "w+");
    const fs = require("node:fs");
    const originalWrite = fs.writeSync;
    const write = vi
      .spyOn(fs, "writeSync")
      .mockImplementation((fd, data, offset, length, position) =>
        originalWrite(fd, data, offset, Math.min(length, 3), position),
      );
    let contents;
    try {
      writeAllSync(descriptor, Buffer.from("complete ownership record"));
      contents = fs.readFileSync(descriptor, "utf8");
    } finally {
      write.mockRestore();
      fs.closeSync(descriptor);
    }
    expect(contents).toBe("complete ownership record");
  });

  function seedRunnerLock(entry, overrides = {}) {
    const record = {
      schemaVersion: 1,
      hostname: os.hostname(),
      pid: process.pid,
      nonce: "fixture-owner",
      acquiredAt: new Date().toISOString(),
      childInFlight: false,
      ...overrides,
    };
    writeFileSync(entry.manifestPath + ".runner-lock", JSON.stringify(record));
    return readFileSync(entry.manifestPath + ".runner-lock", "utf8");
  }

  function expectBusyUnchanged(entry, reason) {
    const before = readFileSync(entry.manifestPath, "utf8");
    const result = run(entry);
    expect(result.status).toBe(5);
    expect(JSON.parse(result.output)).toMatchObject({ status: "busy", reason });
    expect(readFileSync(entry.manifestPath, "utf8")).toBe(before);
  }

  it.each([false, true])(
    "refuses orphan execution without rewriting its ledger (expired: %s)",
    (expired) => {
      const entry = fixture();
      const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
      manifest.governor = {
        activeSecondsUsed: 32,
        providerSecondsUsed: 17,
        gateSecondsUsed: 15,
        activeExecution: {
          kind: "provider",
          name: "review",
          startedAt: expired
            ? "2020-01-01T00:00:00.000Z"
            : new Date().toISOString(),
          timeoutSeconds: 900,
        },
      };
      manifest.terminalHistory = [
        { state: "blocked", detail: "legacy collision" },
      ];
      writeFileSync(entry.manifestPath, JSON.stringify(manifest));
      expectBusyUnchanged(entry, "active-execution");
      expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(false);
    },
  );

  it("preserves a live runner's lock", () => {
    const entry = fixture();
    const lock = seedRunnerLock(entry);
    expectBusyUnchanged(entry, "runner-owned");
    expect(readFileSync(entry.manifestPath + ".runner-lock", "utf8")).toBe(
      lock,
    );
  });

  it("refuses foreign-host and malformed ownership", () => {
    const entry = fixture();
    const lock = seedRunnerLock(entry, { hostname: "another-machine" });
    expectBusyUnchanged(entry, "runner-owned");
    expect(readFileSync(entry.manifestPath + ".runner-lock", "utf8")).toBe(
      lock,
    );
    writeFileSync(entry.manifestPath + ".runner-lock", "partial");
    expectBusyUnchanged(entry, "runner-owned");
    expect(readFileSync(entry.manifestPath + ".runner-lock", "utf8")).toBe(
      "partial",
    );
  });

  it("recovers only positively dead idle ownership", () => {
    const entry = fixture();
    const exited = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    );
    const pid = Number(exited.stdout);
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    seedRunnerLock(entry, { pid });
    const result = run(entry);
    expect(result.status).toBe(0);
    expect(result.manifest.terminalState.state).toBe("verified-unmerged");
    expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(false);
  });

  it("preserves a held recovery fence", () => {
    const entry = fixture();
    const exited = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    );
    const lock = seedRunnerLock(entry, { pid: Number(exited.stdout) });
    writeFileSync(entry.manifestPath + ".runner-lock.recovery", "held fence");
    expectBusyUnchanged(entry, "runner-owned");
    expect(readFileSync(entry.manifestPath + ".runner-lock", "utf8")).toBe(
      lock,
    );
    expect(
      readFileSync(entry.manifestPath + ".runner-lock.recovery", "utf8"),
    ).toBe("held fence");
  });

  it("refuses ordinary acquisition while a recovery fence is held", () => {
    const entry = fixture();
    writeFileSync(entry.manifestPath + ".runner-lock.recovery", "held fence");
    expectBusyUnchanged(entry, "runner-owned");
    expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(false);
    expect(
      readFileSync(entry.manifestPath + ".runner-lock.recovery", "utf8"),
    ).toBe("held fence");
  });

  it("releases a failed child after its dedicated process group is quiescent", () => {
    const entry = fixture({ failRisk: true });
    expect(run(entry).status).toBe(1);
    expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(false);
    expect(run(entry).status).toBe(1);
  });

  it("retains ownership when a successful child leaves its process group live", async () => {
    const entry = fixture({ orphanSuccessfulChild: true });
    const result = run(entry);
    const orphanPid = Number(
      readFileSync(entry.manifestPath + ".successful-orphan-pid", "utf8"),
    );
    let cleanupError;
    try {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "quality foreground child process group is not quiescent",
      );
      const lock = JSON.parse(
        readFileSync(entry.manifestPath + ".runner-lock", "utf8"),
      );
      expect(lock).toMatchObject({
        schemaVersion: 2,
        childInFlight: true,
        child: { processGroupId: expect.any(Number) },
      });
      expect(
        JSON.parse(readFileSync(entry.manifestPath, "utf8")),
      ).not.toHaveProperty("terminalState");
      expectBusyUnchanged(entry, "runner-owned");
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
    await vi.waitFor(
      () =>
        expect(() => process.kill(orphanPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        ),
      { timeout: 10000 },
    );
  });

  it("reconciles a dead legacy quarantine only with exact bindings and confirmation", () => {
    const entry = fixture();
    const exited = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    );
    const record = {
      schemaVersion: 1,
      hostname: os.hostname(),
      pid: Number(exited.stdout),
      nonce: "legacy-quarantine",
      acquiredAt: new Date().toISOString(),
      childInFlight: true,
    };
    writeFileSync(entry.manifestPath + ".runner-lock", JSON.stringify(record));
    const manifestBefore = readFileSync(entry.manifestPath, "utf8");

    expect(reconcile(entry, record).status).toBe(1);
    expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(true);
    const recovered = reconcile(entry, record, [
      "--confirm-legacy-child-quiescent",
    ]);
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      status: "reconciled",
      head: "abc123",
      legacyConfirmationUsed: true,
    });
    expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(false);
    expect(readFileSync(entry.manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("refuses dead-owner recovery while its orphan child may write", async () => {
    const entry = fixture({ holdReview: true });
    const owner = spawn(
      process.execPath,
      [entry.runner, "--manifest", entry.manifestPath],
      {
        env: { ...process.env, QUALITY_TEST_MANIFEST: entry.manifestPath },
        stdio: "ignore",
      },
    );
    const completed = new Promise((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", resolve);
    });
    try {
      await vi.waitFor(
        () =>
          expect(existsSync(entry.manifestPath + ".review-ready")).toBe(true),
        { timeout: 10000 },
      );
      owner.kill("SIGKILL");
      await completed;
      const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
      manifest.governor.activeExecution.startedAt = "2020-01-01T00:00:00.000Z";
      writeFileSync(entry.manifestPath, JSON.stringify(manifest));
      const lock = readFileSync(entry.manifestPath + ".runner-lock", "utf8");
      expect(JSON.parse(lock).childInFlight).toBe(true);
      expectBusyUnchanged(entry, "runner-owned");
      expect(readFileSync(entry.manifestPath + ".runner-lock", "utf8")).toBe(
        lock,
      );
    } finally {
      writeFileSync(entry.manifestPath + ".review-release", "release");
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill("SIGKILL");
      await completed;
      await vi.waitFor(
        () =>
          expect(existsSync(entry.manifestPath + ".review-finished")).toBe(
            true,
          ),
        { timeout: 10000 },
      );
    }
  });

  it("refuses a concurrent runner without changing its owner's campaign", async () => {
    const entry = fixture({ holdReview: true });
    const owner = spawn(
      process.execPath,
      [entry.runner, "--manifest", entry.manifestPath],
      {
        env: { ...process.env, QUALITY_TEST_MANIFEST: entry.manifestPath },
        stdio: "ignore",
      },
    );
    const completed = new Promise((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", resolve);
    });
    try {
      await vi.waitFor(
        () =>
          expect(existsSync(entry.manifestPath + ".review-ready")).toBe(true),
        {
          timeout: 10000,
        },
      );
      const before = readFileSync(entry.manifestPath, "utf8");
      const duplicate = run(entry);
      expect(duplicate.status).toBe(5);
      expect(JSON.parse(duplicate.output)).toMatchObject({ status: "busy" });
      expect(readFileSync(entry.manifestPath, "utf8")).toBe(before);
      expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(true);
      const alias = entry.manifestPath + ".alias";
      symlinkSync(path.dirname(entry.manifestPath), alias, "dir");
      const aliased = run({
        ...entry,
        manifestPath: path.join(alias, "invocation.json"),
      });
      expect(aliased.status).toBe(5);
      expect(readFileSync(entry.manifestPath, "utf8")).toBe(before);
    } finally {
      writeFileSync(entry.manifestPath + ".review-release", "release");
      await completed;
    }
    const after = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    expect(after.terminalState.state).toBe("verified-unmerged");
    expect(after.reviews).toHaveLength(1);
    expect(existsSync(entry.manifestPath + ".runner-lock")).toBe(false);
  });

  it("retains creator ownership when the release fence is unavailable", async () => {
    const entry = fixture({ holdReview: true });
    const owner = spawn(
      process.execPath,
      [entry.runner, "--manifest", entry.manifestPath],
      {
        env: { ...process.env, QUALITY_TEST_MANIFEST: entry.manifestPath },
        stdio: "ignore",
      },
    );
    const completed = new Promise((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", resolve);
    });
    await vi.waitFor(
      () => expect(existsSync(entry.manifestPath + ".review-ready")).toBe(true),
      { timeout: 10000 },
    );
    writeFileSync(entry.manifestPath + ".runner-lock.recovery", "held fence");
    writeFileSync(entry.manifestPath + ".review-release", "release");
    await completed;

    expect(owner.exitCode).toBe(0);
    expect(
      JSON.parse(readFileSync(entry.manifestPath + ".runner-lock", "utf8")),
    ).toMatchObject({ childInFlight: false });
    expect(
      readFileSync(entry.manifestPath + ".runner-lock.recovery", "utf8"),
    ).toBe("held fence");
  });

  it("merges engineering work without claiming product acceptance", () => {
    const result = run(
      fixture({ deliveryClaim: "engineering" }, { merge: true, tier: "low" }),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "merged",
    });
    expect(
      result.manifest.orchestration.steps["delivery-claim"].detail,
    ).toContain("product acceptance not established");
  });

  it("blocks engineering work when protected policy validation fails", () => {
    const result = run(
      fixture({
        deliveryClaim: "engineering",
        policyReject: "protected engineering policy is revoked",
      }),
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message: "protected engineering policy is revoked",
    });
    expect(result.manifest.calls).toBeUndefined();
  });

  it("pauses for identity-bound lead verification before merge", () => {
    const result = run(fixture({ leads: 2 }, { merge: true, tier: "medium" }));

    expect(result.status).toBe(4);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "work-required",
      kind: "lead-verification",
      phase: "lead-verification",
      context: { findings: [{ id: "lead-1" }, { id: "lead-2" }] },
    });
    expect(result.manifest.calls).not.toContain("quality-stamp-and-merge.sh");
    expect(result.manifest.telemetryWrites).toBeUndefined();
  });

  it("requests one bounded remediation after confirmed findings", () => {
    const entry = fixture({ leads: 1 }, { merge: true, tier: "medium" });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.reviews.push({
      from: manifest.revisions.baseSha,
      to: manifest.revisions.currentHead,
      status: "complete",
      leadCount: 1,
    });
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));
    recordDisposition(entry, 1);

    const result = run(entry);

    expect(result.status).toBe(4);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "work-required",
      kind: "remediation",
      phase: "remediation",
      blockingCount: 1,
    });
    expect(result.manifest.governor.remediationStartedAtEpoch).toBe(1);
    expect(result.manifest.calls).toContain("quality-run-governor.js");
    expect(result.manifest.calls).not.toContain("quality-stamp-and-merge.sh");
  });

  it("stops a repeated remediation resume when no repair commit was made", () => {
    const entry = fixture({ leads: 1 }, { merge: true, tier: "medium" });
    expect(run(entry).status).toBe(4);
    recordDisposition(entry, 1);
    expect(run(entry).status).toBe(4);

    const repeated = run(entry);

    expect(repeated.status).toBe(1);
    expect(JSON.parse(repeated.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message: expect.stringContaining("repair commit is missing"),
    });
    expect(repeated.manifest.telemetryWrites).toBe(1);
  });

  it("resumes without replaying immutable policy after all leads are dispositioned", () => {
    const entry = fixture({ leads: 1 }, { merge: true, tier: "medium" });
    expect(run(entry).status).toBe(4);
    recordDisposition(entry, 0);

    const result = run(entry);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "merged",
    });
    expect(
      result.manifest.calls.filter(
        (call) => call === "quality-select-agents.sh",
      ),
    ).toHaveLength(1);
  });

  it("fails closed when the lead disposition artifact changes after recording", () => {
    const entry = fixture({ leads: 1 }, { merge: true, tier: "medium" });
    expect(run(entry).status).toBe(4);
    recordDisposition(entry, 0);
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    writeFileSync(manifest.judge.artifactPath, "{}");

    const result = run(entry);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message: expect.stringContaining("integrity mismatch"),
    });
  });

  it("advances one repair head, runs delta review, and then merges", () => {
    const entry = fixture({ leads: 1 }, { merge: true, tier: "medium" });
    expect(run(entry).status).toBe(4);

    recordDisposition(entry, 1, "initial-judge");
    expect(run(entry).status).toBe(4);

    let manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.behavior.nextHead = "repair456";
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));
    const delta = run(entry);
    expect(delta.status).toBe(4);
    expect(JSON.parse(delta.output)).toMatchObject({
      status: "work-required",
      kind: "lead-verification",
      head: "repair456",
    });
    expect(delta.manifest.reviews.at(-1)).toMatchObject({
      from: "abc123",
      to: "repair456",
    });
    expect(delta.manifest.advanceMode).toBe("transactional");

    recordDisposition(entry, 0, "delta-judge");
    const merged = run(entry);
    expect(merged.status).toBe(0);
    expect(JSON.parse(merged.output)).toMatchObject({
      status: "complete",
      state: "merged",
      head: "repair456",
    });
  });

  it("stops clearly when the one remediation head still has confirmed findings", () => {
    const entry = fixture({ leads: 1 }, { merge: true, tier: "medium" });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.revisions.currentHead = "repair456";
    manifest.governor.remediationStartedAtEpoch = 1;
    manifest.reviews.push({
      from: manifest.revisions.initialHead,
      to: manifest.revisions.currentHead,
      status: "complete",
      leadCount: 1,
    });
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));
    recordDisposition(entry, 1);

    const result = run(entry);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message: expect.stringContaining("bounded remediation did not converge"),
    });
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("runs low-risk gates and review in order, records one terminal result, and reuses it", () => {
    const entry = fixture();
    const first = run(entry);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.output)).toMatchObject({
      status: "complete",
      state: "verified-unmerged",
      review: { status: "policy-exempt", leads: 0 },
    });
    expect(first.manifest.calls).toEqual([
      "quality-risk-resolve.sh",
      "quality-select-agents.sh",
      "quality-run-gate.sh",
      "quality-run-gate.sh",
      "quality-run-gate.sh",
      "quality-authorize-review-round.sh",
      "quality-run-review.sh",
    ]);
    expect(first.manifest.telemetryWrites).toBe(1);

    const resumed = run(entry);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.output)).toMatchObject({
      status: "terminal",
      state: "verified-unmerged",
    });
    expect(resumed.manifest.calls).toEqual(first.manifest.calls);
    expect(resumed.manifest.telemetryWrites).toBe(1);
  });

  it("stops after a failed gate and never starts review", () => {
    const result = run(fixture({ failGate: "test" }));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
    });
    expect(result.manifest.calls || []).not.toContain("quality-run-review.sh");
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("blocks an evidence-free contract claim for a product diff", () => {
    const result = run(fixture({ changedFiles: ["src/App.tsx"] }));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message:
        "contract delivery claim requires product evidence for product-affecting file 'src/App.tsx'",
    });
    expect(result.manifest.calls).not.toContain("quality-run-review.sh");
  });

  it("runs an evidence-free contract claim for quality-control configuration", () => {
    const result = run(
      fixture({
        changedFiles: [".buildproven/test-impact.json", "harness-config.json"],
      }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "verified-unmerged",
    });
    expect(result.manifest.calls).toContain("quality-run-review.sh");
  });

  it("runs all quality gates and review for committed dependency maintenance", () => {
    const entry = fixture({
      changedFiles: ["package.json", "package-lock.json"],
    });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    const cwd = manifest.repo.realpath;
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "3" } }),
    );
    git("add", "package.json");
    git("commit", "-qm", "base");
    manifest.revisions.baseSha = git("rev-parse", "HEAD");
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "4" } }),
    );
    git("add", "package.json");
    git("commit", "-qm", "candidate");
    manifest.revisions.currentHead = git("rev-parse", "HEAD");
    manifest.revisions.initialHead = manifest.revisions.currentHead;
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));
    const result = run(entry);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output).state).toBe("verified-unmerged");
    expect(result.manifest.calls).toContain("quality-run-review.sh");
    expect(result.manifest.gates.map((gate) => gate.name)).toEqual(
      expect.arrayContaining(["lint", "test", "security"]),
    );
  });

  it("requires protected admission before merging a product claim", () => {
    const result = run(
      fixture(
        {
          changedFiles: ["src/App.tsx"],
          productVerifier:
            "process.stdout.write(JSON.stringify({valid:true,errors:[]}));",
        },
        { merge: true },
      ),
    );
    expect(result.status).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "action-required",
      phase: "product-admission",
      message: expect.stringContaining(
        "candidate-worker verification is preflight only",
      ),
    });
    expect(result.manifest.calls || []).not.toContain(
      "quality-stamp-and-merge.sh",
    );
    expect(result.manifest.calls || []).not.toContain("quality-run-review.sh");
  });

  it("does not request protected admission for a non-merge product review", () => {
    const result = run(
      fixture({
        changedFiles: ["src/App.tsx"],
        productVerifier:
          "process.stdout.write(JSON.stringify({valid:true,errors:[]}));",
      }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "verified-unmerged",
    });
    expect(result.manifest.calls).toContain("quality-run-review.sh");
  });

  it("merges a product claim only after exact-head protected admission", () => {
    const result = run(
      fixture(
        {
          changedFiles: ["src/App.tsx"],
          productVerifier:
            "process.stdout.write(JSON.stringify({valid:true,errors:[]}));",
          productAdmission:
            "process.stdout.write(JSON.stringify({valid:true,checkId:'123'}));",
        },
        { merge: true },
      ),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "merged",
    });
    expect(result.manifest.calls).toContain("quality-stamp-and-merge.sh");
  });

  it("blocks similarly named harness configuration that is not the exact quality-control file", () => {
    const result = run(fixture({ changedFiles: ["harness-config.js"] }));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message:
        "contract delivery claim requires product evidence for product-affecting file 'harness-config.js'",
    });
    expect(result.manifest.calls).not.toContain("quality-run-review.sh");
  });

  it.each([
    ["incomplete tasks", "implementation task is incomplete"],
    ["digest mismatch", "behavioralTests receipt digest does not match"],
    [
      "missing receipt fields",
      "acceptanceEvidence receipt is missing artifact",
    ],
  ])("preserves actionable product diagnostics for %s", (_case, diagnostic) => {
    const result = run(
      fixture({
        changedFiles: ["src/App.tsx"],
        productVerifier: `process.stdout.write(JSON.stringify({valid:false,errors:[${JSON.stringify(diagnostic)}]})); process.exitCode=1;`,
      }),
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output).message).toContain(diagnostic);
  });

  it("rejects a delivery-evidence index changed without a HEAD advance", () => {
    const entry = fixture({
      changedFiles: ["src/App.tsx"],
      productVerifier:
        "process.stdout.write(JSON.stringify({valid:true,errors:[]}));",
    });
    writeFileSync(
      path.join(path.dirname(entry.manifestPath), "evidence.json"),
      "changed\n",
    );

    const result = run(entry);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.output).message).toContain(
      "delivery evidence changed without a HEAD advance",
    );
    expect(result.manifest.calls || []).not.toContain("quality-run-review.sh");
  });

  it("classifies malformed verifier output without exposing it", () => {
    const secret = "raw-secret-value";
    const result = run(
      fixture({
        changedFiles: ["src/App.tsx"],
        productVerifier: `process.stdout.write("not-json ${secret}"); process.stderr.write("${secret}"); process.exitCode=1;`,
      }),
    );
    const message = JSON.parse(result.output).message;
    expect(message).toContain("malformed structured output");
    expect(message).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  it("rejects terminal control sequences in structured diagnostics", () => {
    const result = run(
      fixture({
        changedFiles: ["src/App.tsx"],
        productVerifier:
          'process.stdout.write(JSON.stringify({valid:false,errors:["\\u001b[2Jmisleading"]})); process.exitCode=1;',
      }),
    );
    expect(JSON.parse(result.output).message).toContain(
      "unsafe or empty diagnostics",
    );
    expect(result.stdout).not.toContain("\u001b");
  });

  it("keeps a verifier process failure distinct from validation errors", () => {
    const result = run(
      fixture({
        changedFiles: ["src/App.tsx"],
        productVerifier: "process.exit(9);",
      }),
    );
    expect(JSON.parse(result.output).message).toContain(
      "product verifier process failed with status 9",
    );
  });

  it("records signal interruption as one terminal campaign", () => {
    const entry = fixture({ signalGate: "lint" });
    const result = run(entry);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "interrupted",
    });
    expect(result.manifest.telemetryWrites).toBe(1);
    expect(
      JSON.parse(readFileSync(entry.manifestPath + ".runner-lock", "utf8")),
    ).toMatchObject({ childInFlight: true });
  });

  it("resumes an exact-head reviewed campaign after host interruption", () => {
    const entry = fixture({}, { merge: true, tier: "high" });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.risk.resolved = true;
    manifest.gates = manifest.requiredGates.map(({ name }) => ({
      name,
      status: "success",
      head: manifest.revisions.currentHead,
    }));
    manifest.reviews = [
      {
        from: manifest.revisions.baseSha,
        to: "reviewed-before-interruption",
        status: "complete",
        leadCount: 0,
      },
    ];
    manifest.governor.providerSecondsUsed = 64;
    manifest.governor.activeExecution = null;
    manifest.terminalEpoch = 1;
    manifest.terminalState = {
      state: "interrupted",
      detail: "quality run interrupted",
      head: manifest.revisions.currentHead,
      terminalEpoch: 1,
    };
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "merged",
    });
    expect(result.manifest.governor.providerSecondsUsed).toBe(64);
    expect(result.manifest.calls).toContain("quality-mutation-check.sh");
    expect(result.manifest.calls).toContain("quality-run-review.sh");
    expect(result.manifest.calls).toContain("quality-stamp-and-merge.sh");
    expect(result.manifest.terminalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "interrupted",
          disposition: "resumed-after-interruption",
        }),
        expect.objectContaining({
          event: "reopened-after-interruption",
          terminalEpoch: 2,
        }),
      ]),
    );
  });

  it("classifies stale identity as superseded before any phase runs", () => {
    const result = run(fixture({ stale: true }));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "superseded",
    });
    expect(result.manifest.calls).toBeUndefined();
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("keeps incomplete provider evidence honest for a no-merge audit", () => {
    const result = run(fixture({ incompleteReview: true }, { tier: "medium" }));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "provider-incomplete",
      review: { status: "incomplete" },
    });
    expect(result.manifest.reviews[0].status).toBe("incomplete");
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("merges after bounded provider failure when deterministic evidence is green", () => {
    const result = run(
      fixture({ incompleteReview: true }, { merge: true, tier: "medium" }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "merged",
      review: { status: "incomplete" },
    });
    expect(result.manifest.calls).toContain("quality-stamp-and-merge.sh");
  });

  it("resumes the authorized same-range retry after an interrupted incomplete review", () => {
    const entry = fixture(
      { incompleteReview: true, retryPending: true },
      { tier: "medium" },
    );
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.risk.resolved = true;
    manifest.gates = manifest.requiredGates.map(({ name }) => ({
      name,
      status: "success",
    }));
    manifest.reviews.push({
      from: manifest.revisions.baseSha,
      to: manifest.revisions.currentHead,
      status: "incomplete",
      leadCount: 0,
    });
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);
    expect(result.manifest.retryReserved).toBe(true);
    expect(result.manifest.calls).toContain(
      "quality-authorize-review-round.sh",
    );
    expect(result.manifest.reviews).toHaveLength(2);
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("reports a successful provider retry as complete", () => {
    const entry = fixture({ retryPending: true }, { tier: "medium" });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.reviews.push({
      from: "base123",
      to: manifest.revisions.currentHead,
      status: "incomplete",
      leadCount: 0,
    });
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      review: { status: "complete" },
    });
  });

  it("reuses rebase-carried review coverage without relabeling it as policy-exempt", () => {
    const entry = fixture({}, { tier: "medium" });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.revisions.currentHead = "rebased456";
    manifest.revisions.reviewRebaseCarries = [
      { reviewedHead: "abc123", head: "rebased456" },
    ];
    manifest.reviews = [{ to: "abc123", status: "complete", leadCount: 3 }];
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      review: { status: "complete", leads: 3 },
    });
    expect(result.manifest.calls).not.toContain(
      "quality-authorize-review-round.sh",
    );
    expect(result.manifest.calls).not.toContain("quality-run-review.sh");
  });

  it("pauses a merge only for a typed external capability requirement", () => {
    const result = run(
      fixture({ approvalRequired: true }, { merge: true, tier: "medium" }),
    );
    expect(result.status).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "action-required",
      kind: "external-capability",
      phase: "authorization",
      review: { leads: 0 },
    });
    expect(result.manifest.terminalState).toBeUndefined();
    expect(result.manifest.calls).not.toContain("quality-stamp-and-merge.sh");
  });

  it("delegates an authorized merge to the protected merge script", () => {
    const result = run(fixture({}, { merge: true, tier: "medium" }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "complete",
      state: "merged",
    });
    expect(result.manifest.calls.at(-1)).toBe("quality-stamp-and-merge.sh");
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("continues only the explicitly recoverable terminal merge campaign", () => {
    const entry = fixture(
      { recoverTerminal: true, externalMergeRequirement: true },
      { merge: true, tier: "medium" },
    );
    expect(run(entry).status).toBe(3);
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.behavior.externalMergeRequirement = false;
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);

    expect(result.status).toBe(0);
    expect(result.manifest.terminalState).toMatchObject({ state: "merged" });
    expect(result.manifest.terminalHistory).toHaveLength(2);
    expect(result.manifest.terminalEpoch).toBe(1);
  });

  it("re-enters a same-head CI admission block after current CI becomes green", () => {
    const entry = fixture(
      { greenCiRecovery: true },
      { merge: true, tier: "medium" },
    );
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.risk.resolved = true;
    manifest.gates = manifest.requiredGates.map(({ name }) => ({
      name,
      status: "success",
    }));
    manifest.reviews = [
      {
        from: manifest.revisions.baseSha,
        to: manifest.revisions.currentHead,
        status: "complete",
        leadCount: 0,
      },
    ];
    manifest.merge.admissionBlock = {
      conditions: ["ci:failed"],
      head: manifest.revisions.currentHead,
    };
    manifest.terminalState = {
      state: "blocked",
      head: manifest.revisions.currentHead,
      mergeAdmissionConditions: ["ci:failed"],
    };
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);

    expect(result.status).toBe(0);
    expect(result.manifest.terminalState).toMatchObject({ state: "merged" });
    expect(result.manifest.terminalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: "resolved-by-green-ci" }),
        expect.objectContaining({ event: "reopened-by-green-ci" }),
      ]),
    );
    expect(result.manifest.calls).toEqual(["quality-stamp-and-merge.sh"]);
  });

  it("records a new terminal cause when a recovered merge fails", () => {
    const entry = fixture(
      { recoverTerminal: true, externalMergeRequirement: true },
      { merge: true, tier: "medium" },
    );
    expect(run(entry).status).toBe(3);
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.behavior.externalMergeRequirement = false;
    manifest.behavior.failMerge = true;
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    const result = run(entry);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
    });
    expect(result.manifest.terminalState).toMatchObject({
      state: "blocked",
      detail: "merge admission failed with exit 1",
    });
  });

  it("keeps a recovered external merge requirement actionable", () => {
    const entry = fixture(
      { recoverTerminal: true, externalMergeRequirement: true },
      { merge: true, tier: "medium" },
    );
    expect(run(entry).status).toBe(3);

    const result = run(entry);

    expect(result.status).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "action-required",
      kind: "external-capability",
      phase: "merge",
    });
    expect(result.manifest.terminalState).toMatchObject({
      state: "blocked",
      terminalEpoch: 1,
    });
  });

  it("advances the epoch when a second runner re-enters recovery", () => {
    const entry = fixture(
      { recoverTerminal: true, externalMergeRequirement: true },
      { merge: true, tier: "medium" },
    );
    expect(run(entry).status).toBe(3);
    expect(run(entry).manifest.terminalEpoch).toBe(1);

    const result = run(entry);

    expect(result.status).toBe(3);
    expect(result.manifest.terminalState).toMatchObject({
      state: "blocked",
      terminalEpoch: 2,
    });
    expect(result.manifest.terminalHistory.at(-1)).toMatchObject({
      event: "reopened-by-capability",
      terminalEpoch: 2,
    });
  });

  it("rejects merge exit zero without exact merged terminal evidence", () => {
    const result = run(
      fixture({ mergeWithoutTerminal: true }, { merge: true, tier: "medium" }),
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
      message:
        "merge process exited successfully without exact-head merged terminal evidence",
    });
  });

  it("binds merged terminal evidence to the immutable pre-merge head", () => {
    const result = run(
      fixture({ rewriteMergedHead: true }, { merge: true, tier: "medium" }),
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "contract-failed",
      observedTerminalState: "merged",
      message:
        "merge process exited successfully without exact-head merged terminal evidence",
    });
  });

  it("uses the structured merge exit for an external governance capability", () => {
    const result = run(
      fixture(
        { externalMergeRequirement: true },
        { merge: true, tier: "medium" },
      ),
    );
    expect(result.status).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "action-required",
      kind: "external-capability",
      phase: "merge",
    });
    expect(result.manifest.terminalState).toMatchObject({
      state: "blocked",
      detail: expect.stringContaining("signed capability"),
    });
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("retains typed-pause ownership while its process group is not quiescent", async () => {
    const entry = fixture(
      { externalMergeRequirement: true, orphanMergeDescendant: true },
      { merge: true, tier: "medium" },
    );
    const result = run(entry);
    const orphanPid = Number(
      readFileSync(entry.manifestPath + ".merge-orphan-pid", "utf8"),
    );
    let cleanupError;
    try {
      expect(result.status).toBe(3);
      const lock = JSON.parse(
        readFileSync(entry.manifestPath + ".runner-lock", "utf8"),
      );
      expect(lock).toMatchObject({
        schemaVersion: 2,
        childInFlight: true,
        child: { processGroupId: expect.any(Number) },
      });
      expectBusyUnchanged(entry, "runner-owned");
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
    await vi.waitFor(
      () =>
        expect(() => process.kill(orphanPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        ),
      { timeout: 10000 },
    );
  });

  it("resumes a structured merge requirement without replaying immutable phases", () => {
    const entry = fixture(
      { recoverTerminal: true, externalMergeRequirement: true },
      { merge: true, tier: "medium" },
    );
    const initial = run(entry);
    expect(initial.status).toBe(3);
    expect(initial.manifest.terminalState).toMatchObject({ state: "blocked" });

    const resumed = run(entry);

    expect(resumed.status).toBe(3);
    expect(resumed.stderr).not.toContain("agent selection is immutable");
    expect(resumed.manifest.terminalEpoch).toBe(1);
    expect(resumed.manifest.terminalHistory).toHaveLength(2);
  });

  it("records a CI merge-admission failure as blocked, not action-required", () => {
    const result = run(
      fixture(
        { failMerge: true, mergeWarning: "using signed exact-head evidence" },
        { merge: true, tier: "medium" },
      ),
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "terminal",
      state: "blocked",
    });
    expect(result.manifest.telemetryWrites).toBe(1);
  });

  it("preserves the phase failure when terminal recording also fails", () => {
    const result = run(fixture({ failRisk: true, terminalRecorderFail: true }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "terminal state recording failed after: risk failed with exit 5",
    );
    expect(result.stderr).not.toContain("Cannot read properties of undefined");
  });
});

describe("merge read failure runner boundary", () => {
  it("keeps a persisted creator-only recovery sentinel terminal", () => {
    const entry = fixture({}, { merge: true, tier: "medium" });
    const manifest = JSON.parse(readFileSync(entry.manifestPath, "utf8"));
    manifest.terminalState = {
      state: "recovering",
      head: manifest.revisions.currentHead,
      terminalEpoch: 1,
      recovery: { kind: "merge-read-failure" },
    };
    writeFileSync(entry.manifestPath, JSON.stringify(manifest));
    const result = run(entry);
    expect(result.status).toBe(1);
    expect(result.manifest).toEqual(manifest);
  });

  it("retains typed read failure diagnostics separately from CI rejection", () => {
    const entry = fixture(
      {
        failMerge: true,
        mergeExit: 75,
        mergeWarning: "GitHub GET transport exhausted",
      },
      { merge: true, tier: "medium" },
    );
    const result = run(entry);
    expect(result.status).toBe(1);
    expect(result.manifest.terminalState).toMatchObject({
      state: "blocked",
      detail: "ci-admission-read-failed",
    });
    expect(result.manifest.merge.readFailure).toMatchObject({
      kind: "ci-admission-read-failed",
      exitCode: 75,
      head: result.manifest.revisions.currentHead,
      stderr: expect.stringContaining("GitHub GET transport exhausted"),
    });
    expect(result.manifest.merge.admissionBlock).toBeUndefined();
  });
});
