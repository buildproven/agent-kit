import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers/tmp.js";
import {
  loadPolicy,
  resolve,
  resolveExecution,
  validatePlan,
  validateRunRecord,
  calibrationDecision,
  resolvePhaseExecution,
  validatePhasePlan,
  validatePhaseExecutionPlan,
  validatePhaseRunRecord,
  validatePhaseCandidate,
  loadPolicyV2,
} from "../compute-governor";

const base = {
  provider: "codex",
  phase: "implement",
  localized: true,
  reversible: true,
  targetedProof: true,
  changedFiles: 1,
  protectedSurfaces: [],
  sameFailureStreak: 0,
};

const phaseEvidence = {
  localized: false,
  reversible: false,
  targetedProof: false,
  ambiguous: true,
  changedFiles: 0,
  protectedSurfaces: [],
  publicContract: false,
  crossRepository: false,
  plannedPaths: ["src/"],
};

function phaseTarget(prefix = "governor-phase-") {
  const target = makeTempDir(prefix);
  const prompt = path.join(makeTempDir("governor-prompt-"), "prompt.md");
  writeFileSync(prompt, "perform ordinary local work\n");
  execFileSync("git", ["init", "-q"], { cwd: target });
  execFileSync("git", ["config", "user.email", "tests@buildproven.local"], {
    cwd: target,
  });
  execFileSync("git", ["config", "user.name", "BuildProven Tests"], {
    cwd: target,
  });
  writeFileSync(path.join(target, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: target });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: target });
  return { target, prompt };
}

describe("compute governor", () => {
  it("routes Claude native advice only through the exact neutral profile", () => {
    const result = resolve({
      interface: "native-advisory",
      schemaVersion: 1,
      work: "delegation",
      facts: {
        provider: "claude",
        phase: "implement",
        readOnly: false,
        localized: false,
        reversible: false,
        targetedProof: false,
        ambiguous: true,
        changedFiles: 2,
        protectedSurfaces: [],
        sameFailureStreak: 0,
        publicContract: false,
        crossRepository: false,
        operatorRoute: null,
      },
      task: { text: "Implement the approved change", plannedPaths: ["src"] },
      parent: { model: "claude-sonnet-5", effort: "medium" },
      override: null,
      fork: "bounded",
      capabilities: {
        delegation: true,
        overrides: true,
        models: [{ model: "claude-sonnet-5", efforts: ["medium"] }],
        profiles: [
          { subagent_type: "security-review", effort: "medium" },
          { subagent_type: "native-task-medium", effort: "medium" },
        ],
      },
    });
    expect(result).toMatchObject({
      status: "ready",
      modelArguments: {
        subagent_type: "native-task-medium",
        model: "sonnet",
      },
    });
  });

  it("rejects native advice without at least one planned path", () => {
    expect(() =>
      resolve({
        interface: "native-advisory",
        schemaVersion: 1,
        work: "delegation",
        facts: {
          provider: "codex",
          phase: "scan",
          readOnly: true,
          localized: true,
          reversible: true,
          targetedProof: true,
          ambiguous: false,
          changedFiles: 0,
          protectedSurfaces: [],
          sameFailureStreak: 0,
          publicContract: false,
          crossRepository: false,
          operatorRoute: null,
        },
        task: { text: "Inspect the source", plannedPaths: [] },
        parent: { model: "gpt-5.6-terra", effort: "medium" },
        override: null,
        fork: "bounded",
        capabilities: {
          delegation: true,
          overrides: true,
          models: [{ model: "gpt-5.6-luna", efforts: ["high"] }],
          profiles: null,
        },
      }),
    ).toThrow("invalid native identity, context, or task");
  });

  it("makes an eligible localized code change an economy-builder candidate", () => {
    const plan = resolve(base);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      policyVersion: "2026-08-26-no-opus",
      route: "economy-builder",
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "high",
      safetyFloor: "economy-micro",
      promotion: "candidate-requires-calibration",
    });
    expect(plan.reasons).toEqual([
      "no protected surface",
      "localized reversible behavior",
      "targeted deterministic proof",
    ]);
  });

  it("uses Haiku without fabricating an effort setting for economy-micro", () => {
    const plan = resolve({
      ...base,
      provider: "claude",
      phase: "scan",
      readOnly: true,
    });
    expect(plan).toMatchObject({
      route: "economy-micro",
      model: "claude-haiku-4-5",
      effort: null,
    });
  });

  it("requires standard work when targeted proof is missing", () => {
    const plan = resolve({ ...base, targetedProof: false });
    expect(plan.route).toBe("standard");
    expect(plan.reasons).toContain("targeted deterministic proof missing");
  });

  it("escalates two matching failures to expert", () => {
    const plan = resolve({ ...base, sameFailureStreak: 2 });
    expect(plan.route).toBe("expert");
    expect(plan.reasons).toContain("two matching failed attempts");
  });

  it("never lowers the protected floor for a tiny test-backed change", () => {
    const plan = resolve({ ...base, protectedSurfaces: ["auth"] });
    expect(plan.route).toBe("critical");
    expect(plan.safetyFloor).toBe("critical");
  });

  it.each([
    ["reset the user's password", "auth"],
    ["repair the sign-in flow", "auth"],
    ["change access control for editors", "authorization"],
  ])(
    "classifies omitted protected surfaces in %s",
    (promptText, expectedSurface) => {
      const target = makeTempDir("governor-protected-prompt-");
      const prompt = path.join(target, "prompt.txt");
      writeFileSync(prompt, `${promptText}\n`);
      execFileSync("git", ["init", "-q"], { cwd: target });
      execFileSync("git", ["config", "user.email", "tests@buildproven.local"], {
        cwd: target,
      });
      execFileSync("git", ["config", "user.name", "BuildProven Tests"], {
        cwd: target,
      });
      execFileSync("git", ["add", "."], { cwd: target });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: target });

      const plan = resolveExecution(base, prompt, target);

      expect(plan.route).toBe("critical");
      expect(plan.safetyFloor).toBe("critical");
      expect(plan.executionBinding.classifiedProtectedSurfaces).toContain(
        expectedSurface,
      );
    },
  );

  it("rejects an unknown protected-surface spelling instead of lowering it", () => {
    expect(() =>
      resolve({ ...base, protectedSurfaces: ["authentcation"] }),
    ).toThrow("facts.protectedSurfaces is invalid");
  });

  it("rejects malformed execution protected surfaces before classification", () => {
    for (const protectedSurfaces of ["auth", { surface: "auth" }]) {
      expect(() =>
        resolveExecution(
          { ...base, protectedSurfaces },
          "/nonexistent/prompt",
          "/nonexistent/target",
        ),
      ).toThrow("facts.protectedSurfaces is invalid");
    }
  });

  it("rejects unsupported execution facts instead of silently omitting them", () => {
    expect(() => resolve({ ...base, emergencyOverride: true })).toThrow(
      "unsupported execution fact 'emergencyOverride'",
    );
  });

  it("rejects unsupported or sensitive execution facts", () => {
    expect(() => resolve({ ...base, prompt: "secret task" })).toThrow(
      "unsupported execution fact 'prompt'",
    );
  });

  it("rejects string booleans that could lower a protected floor", () => {
    expect(() => resolve({ ...base, publicContract: "true" })).toThrow(
      "numeric or route facts are invalid",
    );
    expect(() => resolve({ ...base, crossRepository: "false" })).toThrow(
      "numeric or route facts are invalid",
    );
  });

  it("rejects a low-cost plan whose bound facts require a protected floor", () => {
    const economy = resolve(base);
    expect(() =>
      validatePlan({
        ...economy,
        facts: { ...economy.facts, protectedSurfaces: ["auth"] },
      }),
    ).toThrow("not bound to its facts");
  });

  it("rejects a plan whose model/effort is not the configured mapping", () => {
    const plan = resolve(base);
    expect(() => validatePlan({ ...plan, effort: "xhigh" })).toThrow(
      "violates policy",
    );
  });

  it("rejects tampered safety floors and execution caps", () => {
    const plan = resolve(base);
    expect(() => validatePlan({ ...plan, safetyFloor: "critical" })).toThrow(
      "below its safety floor",
    );
    expect(() =>
      validatePlan({
        ...plan,
        caps: { ...plan.caps, maxWallSeconds: plan.caps.maxWallSeconds + 1 },
      }),
    ).toThrow("invalid execution plan contract");
  });

  it("rejects a plan whose declared facts no longer produce it", () => {
    const plan = resolve(base);
    expect(() =>
      validatePlan({
        ...plan,
        facts: { ...plan.facts, protectedSurfaces: ["auth"] },
      }),
    ).toThrow("execution plan is not bound to its facts");
  });

  it("accepts an equivalent plan regardless of JSON object key order", () => {
    const plan = resolve(base);
    const reordered = Object.fromEntries(Object.entries(plan).reverse());
    reordered.facts = Object.fromEntries(Object.entries(plan.facts).reverse());
    reordered.caps = Object.fromEntries(Object.entries(plan.caps).reverse());
    expect(validatePlan(reordered)).toEqual(reordered);
  });

  it("rejects unexpected or sensitive fields in an execution binding", () => {
    const plan = {
      ...resolve(base),
      route: "standard",
      model: "gpt-5.6-terra",
      effort: "medium",
      caps: { maxWallSeconds: 1800, maxWorkers: 1 },
      reasons: [
        ...resolve(base).reasons,
        "economy candidate lacks approved calibration",
      ],
      promotion: "calibration-required-standard-fallback",
      executionBinding: {
        schemaVersion: 1,
        policyVersion: "2026-08-26-no-opus",
        promptSha256: "a".repeat(64),
        targetIdentitySha256: "b".repeat(64),
        targetHead: "c".repeat(40),
        classifiedProtectedSurfaces: [],
      },
    };
    const invalidPlan = {
      ...plan,
      executionBinding: {
        ...plan.executionBinding,
        password: "must-not-persist",
      },
    };

    expect(() => validatePlan(invalidPlan)).toThrow(
      "execution binding schema mismatch",
    );
    expect(() =>
      validateRunRecord({
        schemaVersion: 1,
        plan: invalidPlan,
        requested: {
          provider: plan.provider,
          model: plan.model,
          effort: plan.effort,
        },
        effective: {
          provider: plan.provider,
          model: plan.model,
          effort: plan.effort,
        },
        outcome: {
          status: "passed",
          exitCode: 0,
          providerFailureCategory: null,
        },
        timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
        attempts: 1,
        usage: null,
      }),
    ).toThrow("execution binding schema mismatch");
  });

  it("accepts full SHA-256 Git object IDs in execution bindings", () => {
    const candidate = resolve(base);
    const plan = {
      ...candidate,
      route: "standard",
      model: "gpt-5.6-terra",
      effort: "medium",
      caps: { maxWallSeconds: 1800, maxWorkers: 1 },
      reasons: [
        ...candidate.reasons,
        "economy candidate lacks approved calibration",
      ],
      promotion: "calibration-required-standard-fallback",
      executionBinding: {
        schemaVersion: 1,
        policyVersion: "2026-08-26-no-opus",
        promptSha256: "a".repeat(64),
        targetIdentitySha256: "b".repeat(64),
        targetHead: "c".repeat(64),
        classifiedProtectedSurfaces: [],
      },
    };
    expect(validatePlan(plan)).toEqual(plan);
  });

  it("rejects a run record that contains prompt or credential material", () => {
    const plan = resolve(base);
    expect(() =>
      validateRunRecord({
        schemaVersion: 1,
        plan,
        requested: {
          provider: plan.provider,
          model: plan.model,
          effort: plan.effort,
        },
        effective: {
          provider: plan.provider,
          model: plan.model,
          effort: plan.effort,
        },
        outcome: {
          status: "passed",
          exitCode: 0,
          providerFailureCategory: null,
        },
        timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
        attempts: 1,
        usage: null,
        prompt: "do not persist me",
      }),
    ).toThrow("forbidden run-record field 'prompt'");
    expect(() =>
      validateRunRecord({
        schemaVersion: 1,
        plan,
        requested: {
          provider: plan.provider,
          model: plan.model,
          effort: plan.effort,
        },
        effective: {
          provider: plan.provider,
          model: plan.model,
          effort: plan.effort,
        },
        outcome: {
          status: "passed",
          providerFailureCategory: null,
          credentials: "forbidden",
        },
        timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
        attempts: 1,
        usage: null,
      }),
    ).toThrow("forbidden run-record field 'credentials'");
  });

  it("rejects contradictory outcome evidence", () => {
    const plan = resolve(base);
    const record = {
      schemaVersion: 1,
      plan,
      requested: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      effective: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      attempts: 1,
      timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
      outcome: {
        status: "passed",
        exitCode: 1,
        providerFailureCategory: "provider-error",
      },
      usage: null,
    };
    expect(() => validateRunRecord(record)).toThrow(
      "invalid run record contract",
    );
  });

  it("rejects arbitrary provider usage metadata until its schema is allowlisted", () => {
    const plan = resolve(base);
    const record = {
      schemaVersion: 1,
      plan,
      requested: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      effective: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      attempts: 1,
      timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
      outcome: {
        status: "passed",
        exitCode: 0,
        providerFailureCategory: null,
      },
      usage: { accessToken: "secret" },
    };
    expect(() => validateRunRecord(record)).toThrow(
      "usage must be null or match the redacted exact-token schema",
    );
  });

  it("accepts only redacted exact provider token usage", () => {
    const plan = resolve(base);
    const record = {
      schemaVersion: 1,
      plan,
      requested: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      effective: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      attempts: 1,
      timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
      outcome: {
        status: "passed",
        exitCode: 0,
        providerFailureCategory: null,
      },
      usage: {
        schemaVersion: 1,
        source: "codex-cli",
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 120,
      },
    };
    expect(validateRunRecord(record)).toEqual(record);
  });

  it("rejects unknown run-record metadata at every persisted object boundary", () => {
    const plan = resolve(base);
    const record = {
      schemaVersion: 1,
      plan,
      requested: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      effective: {
        provider: plan.provider,
        model: plan.model,
        effort: plan.effort,
      },
      attempts: 1,
      timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
      outcome: {
        status: "passed",
        exitCode: 0,
        providerFailureCategory: null,
      },
      usage: null,
    };
    expect(() => validateRunRecord({ ...record, transcript: "raw" })).toThrow(
      "run record schema mismatch",
    );
    expect(() =>
      validateRunRecord({
        ...record,
        outcome: { ...record.outcome, detail: "raw provider response" },
      }),
    ).toThrow("outcome schema mismatch");
  });

  it("loads a complete versioned policy", () => {
    const policy = loadPolicy();
    expect(policy.schemaVersion).toBe(1);
    expect(policy.routes.critical.providers.claude.model).toBe(
      "claude-sonnet-5",
    );
    expect(
      Object.values(policy.routes).map((route) => route.providers.claude.model),
    ).not.toContain("claude-opus-5");
    expect(policy.routes["economy-builder"].providers.claude.effort).toBe(
      "low",
    );
  });

  it("rejects provider mappings that cannot pin model and effort", () => {
    const policy = loadPolicy();
    for (const mutate of [
      (copy) => {
        copy.routes.standard.providers.codex.model = "";
      },
      (copy) => {
        copy.routes.standard.providers.codex.model = " gpt-5.6-terra ";
      },
      (copy) => {
        copy.routes.standard.providers.codex.effort = null;
      },
      (copy) => {
        copy.routes.standard.providers.claude.effort = "xhigh";
      },
    ]) {
      const copy = structuredClone(policy);
      mutate(copy);
      const file = path.join(makeTempDir("governor-policy-"), "policy.json");
      writeFileSync(file, JSON.stringify(copy));
      expect(() => loadPolicy(file)).toThrow(
        "compute-governor: policy missing route 'standard'",
      );
    }
  });

  it("rejects missing or extra protected classifier policy entries", () => {
    const policy = loadPolicy();
    for (const mutate of [
      (copy) => delete copy.protectedPromptPatterns.auth,
      (copy) => {
        copy.protectedPromptPatterns.unknown = ["unknown"];
      },
    ]) {
      const copy = structuredClone(policy);
      mutate(copy);
      const file = path.join(makeTempDir("governor-policy-"), "policy.json");
      writeFileSync(file, JSON.stringify(copy));
      expect(() => loadPolicy(file)).toThrow(
        "protected prompt policy must exactly cover protected surfaces",
      );
    }
  });

  it("requires a unique policy-owned specialized exemption allowlist", () => {
    const policy = loadPolicyV2();
    expect(policy.specializedExemptions).toEqual([
      "quality-panel",
      "strategy-ensemble",
    ]);
    for (const specializedExemptions of [
      [],
      ["quality-panel", "quality-panel"],
      ["quality-panel", "Invalid Name"],
    ]) {
      const file = path.join(
        makeTempDir("governor-phase-policy-"),
        "policy.json",
      );
      writeFileSync(file, JSON.stringify({ ...policy, specializedExemptions }));
      expect(() => loadPolicyV2(file)).toThrow(
        "unsupported phase policy schema",
      );
    }
  });

  it("does not promote a cheaper candidate that loses acceptance quality", () => {
    const result = calibrationDecision({
      maxAcceptanceRateDrop: 0.05,
      baseline: [
        { accepted: true, gatesPassed: true, attempts: 1, elapsedMs: 10 },
        { accepted: true, gatesPassed: true, attempts: 1, elapsedMs: 10 },
      ],
      candidate: [
        { accepted: true, gatesPassed: true, attempts: 1, elapsedMs: 5 },
        { accepted: false, gatesPassed: false, attempts: 2, elapsedMs: 5 },
      ],
    });
    expect(result.status).toBe("candidate-only");
  });

  it("promotes only a candidate that meets both acceptance and retry thresholds", () => {
    const result = calibrationDecision({
      baseline: [
        { accepted: true, gatesPassed: true, attempts: 1, elapsedMs: 10 },
        { accepted: true, gatesPassed: true, attempts: 2, elapsedMs: 20 },
      ],
      candidate: [
        { accepted: true, gatesPassed: true, attempts: 1, elapsedMs: 8 },
        { accepted: true, gatesPassed: true, attempts: 1, elapsedMs: 9 },
      ],
    });
    expect(result.status).toBe("eligible-for-default");
  });

  it("rejects incomplete calibration evidence instead of promoting it", () => {
    expect(() =>
      calibrationDecision({
        baseline: [{ accepted: true, gatesPassed: true }],
        candidate: [{ accepted: true, gatesPassed: true }],
      }),
    ).toThrow("calibration run evidence is incomplete");
  });

  it.each([
    ["scan", "read-only"],
    ["plan", "read-only"],
    ["review", "read-only"],
    ["verify", "verification-only"],
    ["implement", "workspace-write"],
    ["remediate", "workspace-write"],
    ["diagnose", "workspace-write"],
  ])("resolves schema-v2 %s with derived %s access", (phase, accessProfile) => {
    const { target, prompt } = phaseTarget();
    const caller = ["scan", "review"].includes(phase)
      ? "cross-review"
      : "interactive-ralph";
    const plan = resolvePhaseExecution(
      {
        schemaVersion: 2,
        caller,
        provider: "codex",
        phase,
        evidence: phaseEvidence,
      },
      prompt,
      target,
    );
    expect(plan).toMatchObject({
      schemaVersion: 2,
      route: "standard",
      provider: "codex",
      model: "gpt-5.6-terra",
      phase,
      accessProfile,
      promotion: "economy-execution-disabled",
    });
    expect(validatePhasePlan(plan)).toEqual(plan);
    expect(validatePhaseExecutionPlan(plan, prompt, target)).toEqual(plan);
  });

  it("normalizes schema-v2 test to verify but preserves legacy test", () => {
    const { target, prompt } = phaseTarget();
    const phasePlan = resolvePhaseExecution(
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "test",
        evidence: phaseEvidence,
      },
      prompt,
      target,
    );
    expect(phasePlan.phase).toBe("verify");
    expect(resolve({ ...base, phase: "test" }).facts.phase).toBe("test");
  });

  it("routes protected schema-v2 work to critical and rejects caller escalation", () => {
    const { target, prompt } = phaseTarget();
    writeFileSync(prompt, "repair Stripe payment authorization\n");
    const critical = resolvePhaseExecution(
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "implement",
        evidence: phaseEvidence,
      },
      prompt,
      target,
    );
    expect(critical).toMatchObject({
      route: "critical",
      model: "gpt-5.6-sol",
      safetyFloor: "critical",
    });
    expect(() =>
      resolvePhaseExecution(
        {
          schemaVersion: 2,
          caller: "cross-review",
          provider: "codex",
          phase: "implement",
          evidence: phaseEvidence,
        },
        prompt,
        target,
      ),
    ).toThrow("invalid schema-v2 phase request");
  });

  it("rejects Claude, caller failure claims, and unsafe planned paths in v2", () => {
    const { target, prompt } = phaseTarget();
    for (const request of [
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "claude",
        phase: "implement",
        evidence: phaseEvidence,
      },
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "implement",
        evidence: { ...phaseEvidence, sameFailureStreak: 2 },
      },
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "implement",
        evidence: { ...phaseEvidence, plannedPaths: ["../src/"] },
      },
    ]) {
      expect(() => resolvePhaseExecution(request, prompt, target)).toThrow(
        "invalid schema-v2 phase request",
      );
    }
  });

  it("validates exact schema-v2 terminal and prelaunch receipts", () => {
    const { target, prompt } = phaseTarget();
    const plan = resolvePhaseExecution(
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "implement",
        evidence: phaseEvidence,
      },
      prompt,
      target,
    );
    const identity = {
      provider: plan.provider,
      model: plan.model,
      effort: plan.effort,
      executionProfileSha256: plan.executionProfile.sha256,
    };
    const record = {
      schemaVersion: 2,
      plan,
      requested: identity,
      effective: identity,
      timing: { startedAtEpochMs: 1, finishedAtEpochMs: 2 },
      outcome: { status: "completed", exitCode: 0, category: null },
      usage: null,
    };
    expect(validatePhaseRunRecord(record)).toEqual(record);
    expect(
      validatePhaseRunRecord({
        ...record,
        outcome: {
          status: "capability-disabled",
          exitCode: 78,
          category: "verification-disabled",
        },
      }).outcome.status,
    ).toBe("capability-disabled");
  });

  it("approves only exact regular-file additions and rejects undeclared protected paths", () => {
    const { target, prompt } = phaseTarget();
    const request = {
      schemaVersion: 2,
      caller: "interactive-ralph",
      provider: "codex",
      phase: "implement",
      evidence: phaseEvidence,
    };
    const plan = resolvePhaseExecution(request, prompt, target);
    mkdirSync(path.join(target, "src"));
    writeFileSync(
      path.join(target, "src", "feature.js"),
      "export default 1;\n",
    );
    execFileSync("git", ["add", "-N", "--all"], { cwd: target });
    const patchFile = path.join(makeTempDir("governor-patch-"), "change.patch");
    writeFileSync(
      patchFile,
      execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
        cwd: target,
      }),
    );
    expect(validatePhaseCandidate(plan, target, patchFile)).toMatchObject({
      status: "approved",
      changedFiles: 1,
    });

    const protectedSubject = phaseTarget("governor-protected-path-");
    const protectedPlan = resolvePhaseExecution(
      {
        ...request,
        evidence: { ...phaseEvidence, plannedPaths: ["auth/"] },
      },
      protectedSubject.prompt,
      protectedSubject.target,
    );
    mkdirSync(path.join(protectedSubject.target, "auth"));
    writeFileSync(
      path.join(protectedSubject.target, "auth", "guard.js"),
      "export default 1;\n",
    );
    execFileSync("git", ["add", "-N", "--all"], {
      cwd: protectedSubject.target,
    });
    writeFileSync(
      patchFile,
      execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
        cwd: protectedSubject.target,
      }),
    );
    expect(() =>
      validatePhaseCandidate(protectedPlan, protectedSubject.target, patchFile),
    ).toThrow("undeclared protected path");

    const nestedSubject = phaseTarget("governor-nested-protected-path-");
    const nestedPlan = resolvePhaseExecution(
      request,
      nestedSubject.prompt,
      nestedSubject.target,
    );
    mkdirSync(path.join(nestedSubject.target, "src", "auth"), {
      recursive: true,
    });
    writeFileSync(
      path.join(nestedSubject.target, "src", "auth", "guard.js"),
      "export default 1;\n",
    );
    execFileSync("git", ["add", "-N", "--all"], {
      cwd: nestedSubject.target,
    });
    writeFileSync(
      patchFile,
      execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
        cwd: nestedSubject.target,
      }),
    );
    expect(() =>
      validatePhaseCandidate(nestedPlan, nestedSubject.target, patchFile),
    ).toThrow("undeclared protected path");

    for (const controlPath of [
      "scripts/compute-governor.js",
      "scripts/provider-run.sh",
      "scripts/provider-policy.sh",
      "scripts/run-with-deadline.py",
      "scripts/quality-provider-error.js",
      "scripts/quality-provider-usage.js",
      "scripts/autonomous-loop-runtime.js",
      "scripts/overnight-loop.sh",
      "scripts/steward/orchestrate.sh",
      "skills/ralph/reference.md",
      "skills/cross-review/SKILL.md",
      "config/compute-governor-policy-v1.json",
      "config/compute-governor-policy-v2.json",
    ]) {
      const controlSubject = phaseTarget("governor-control-plane-path-");
      const controlPlan = resolvePhaseExecution(
        {
          ...request,
          evidence: { ...phaseEvidence, plannedPaths: ["**"] },
        },
        controlSubject.prompt,
        controlSubject.target,
      );
      mkdirSync(path.dirname(path.join(controlSubject.target, controlPath)), {
        recursive: true,
      });
      writeFileSync(path.join(controlSubject.target, controlPath), "fixture\n");
      execFileSync("git", ["add", "-N", "--all"], {
        cwd: controlSubject.target,
      });
      writeFileSync(
        patchFile,
        execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
          cwd: controlSubject.target,
        }),
      );
      expect(() =>
        validatePhaseCandidate(controlPlan, controlSubject.target, patchFile),
      ).toThrow("undeclared protected path");
    }
  });

  it("rejects a permission-only change to a planned regular file", () => {
    const { target, prompt } = phaseTarget("governor-mode-change-");
    const plan = resolvePhaseExecution(
      {
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "implement",
        evidence: { ...phaseEvidence, plannedPaths: ["README.md"] },
      },
      prompt,
      target,
    );
    chmodSync(path.join(target, "README.md"), 0o755);
    const patchFile = path.join(
      makeTempDir("governor-mode-patch-"),
      "change.patch",
    );
    writeFileSync(
      patchFile,
      execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
        cwd: target,
      }),
    );
    expect(() => validatePhaseCandidate(plan, target, patchFile)).toThrow(
      "disallowed Git change kind or file mode",
    );
  });
});
