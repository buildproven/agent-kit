import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "../compute-governor";

const cli = path.resolve("scripts/compute-governor.js");
const capabilities = {
  delegation: true,
  overrides: true,
  models: [
    { model: "gpt-5.6-luna", efforts: ["medium", "high"] },
    { model: "gpt-5.6-terra", efforts: ["medium", "high"] },
    { model: "gpt-5.6-sol", efforts: ["high"] },
    { model: "claude-haiku-4-5", efforts: [null] },
    { model: "claude-sonnet-5", efforts: ["low", "medium", "high"] },
  ],
  profiles: [
    { subagent_type: "general-purpose", effort: null },
    { subagent_type: "native-task-low", effort: "low" },
    { subagent_type: "native-task-medium", effort: "medium" },
    { subagent_type: "native-task-high", effort: "high" },
  ],
};

const request = {
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
    changedFiles: 1,
    protectedSurfaces: [],
    sameFailureStreak: 0,
    publicContract: false,
    crossRepository: false,
    operatorRoute: null,
  },
  task: {
    text: "Inspect the targeted worker behavior.",
    plannedPaths: ["src/worker.js"],
  },
  parent: { model: "gpt-6-astra", effort: "high" },
  override: null,
  fork: "bounded",
  capabilities,
};

describe("compute governor native advisory", () => {
  it("returns the unpromoted Luna mapping for a complete bounded low-risk scan", () => {
    const results = ["resolve", "explain"].map((command) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, command, "-"], {
          input: JSON.stringify(request),
          encoding: "utf8",
        }),
      ),
    );

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      status: "ready",
      safetyFloor: "economy-micro",
      recommendation: {
        route: "economy-micro",
        model: "gpt-5.6-luna",
        effort: "medium",
      },
      modelArguments: {
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
      },
      observed: null,
      usage: null,
      constraints: {
        launches: 0,
        executionReceipt: false,
        grantsAuthority: false,
      },
    });
    expect(results[0].task.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(results[0])).not.toContain(request.task.text);
    expect(JSON.stringify(results[0])).not.toContain(
      request.task.plannedPaths[0],
    );
  });

  it("uses the policy matrix for eligible builder, ambiguous, and Claude work", () => {
    expect(
      resolve({
        ...request,
        facts: { ...request.facts, phase: "implement", readOnly: false },
      }),
    ).toMatchObject({
      recommendation: {
        route: "economy-builder",
        model: "gpt-5.6-luna",
        effort: "high",
      },
    });
    expect(
      resolve({
        ...request,
        facts: { ...request.facts, ambiguous: true },
      }),
    ).toMatchObject({
      recommendation: {
        route: "standard",
        model: "gpt-5.6-terra",
        effort: "medium",
      },
    });
    expect(
      resolve({
        ...request,
        facts: { ...request.facts, provider: "claude" },
      }),
    ).toMatchObject({
      recommendation: {
        route: "economy-micro",
        model: "claude-haiku-4-5",
        effort: null,
      },
      modelArguments: { subagent_type: "general-purpose", model: "haiku" },
    });
    expect(
      resolve({
        ...request,
        facts: { ...request.facts, provider: "claude", ambiguous: true },
      }),
    ).toMatchObject({
      recommendation: {
        route: "standard",
        model: "claude-sonnet-5",
        effort: "medium",
      },
      modelArguments: {
        subagent_type: "native-task-medium",
        model: "sonnet",
      },
    });
  });

  it("unions task text and paths into the protected floor without returning task data", () => {
    for (const task of [
      {
        text: "Repair Stripe billing behavior.",
        plannedPaths: ["src/worker.js"],
      },
      { text: "Repair session behavior.", plannedPaths: ["auth/session.js"] },
    ]) {
      const result = resolve({ ...request, task });
      expect(result).toMatchObject({
        safetyFloor: "critical",
        recommendation: {
          route: "critical",
          model: "gpt-5.6-sol",
          effort: "high",
        },
      });
      expect(result.task.classifiedProtectedSurfaces.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(task.text);
      expect(JSON.stringify(result)).not.toContain(task.plannedPaths[0]);
    }
  });

  it("honors an explicit supported downgrade above the floor and records it", () => {
    const result = resolve({
      ...request,
      facts: { ...request.facts, ambiguous: true },
      override: { model: "gpt-5.6-luna", effort: "medium" },
    });

    expect(result).toMatchObject({
      status: "ready",
      recommendation: { route: "standard" },
      requestedRoute: "economy-micro",
      overrideBelowRecommendation: true,
      modelArguments: {
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
      },
    });
    expect(result.reasons).toContain(
      "explicit override is below the advisory recommendation",
    );
  });

  it("blocks below-floor overrides and keeps an explicit operator floor", () => {
    for (const facts of [
      { ...request.facts, protectedSurfaces: ["security"] },
      { ...request.facts, operatorRoute: "standard" },
    ]) {
      expect(
        resolve({
          ...request,
          facts,
          override: { model: "gpt-5.6-luna", effort: "medium" },
        }),
      ).toMatchObject({ status: "blocked", modelArguments: null });
    }
  });

  it("raises the default recommendation to an explicit operator floor", () => {
    expect(
      resolve({
        ...request,
        facts: { ...request.facts, operatorRoute: "critical" },
      }),
    ).toMatchObject({
      status: "ready",
      safetyFloor: "critical",
      recommendation: {
        route: "critical",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      requested: { model: "gpt-5.6-sol", effort: "high" },
      requestedRoute: "critical",
      modelArguments: {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
      },
    });
  });

  it("keeps retries advisory and full-history parent selection unchanged", () => {
    expect(
      resolve({
        ...request,
        facts: { ...request.facts, sameFailureStreak: 2 },
      }),
    ).toMatchObject({
      recommendation: {
        route: "expert",
        model: "gpt-5.6-terra",
        effort: "high",
      },
      constraints: { executionReceipt: false, grantsAuthority: false },
    });
    expect(
      resolve({
        ...request,
        fork: "all",
        parent: { model: "gpt-5.6-terra", effort: "medium" },
        capabilities: { ...capabilities, overrides: false },
      }),
    ).toMatchObject({
      status: "ready",
      requested: { model: "gpt-5.6-terra", effort: "medium" },
      modelArguments: null,
    });
  });

  it.each([
    (value) => {
      delete value.facts.readOnly;
    },
    (value) => {
      value.facts.changedFiles = null;
    },
    (value) => {
      value.facts.protectedSurfaces = null;
    },
    (value) => {
      value.task.text = "";
    },
    (value) => {
      value.task.plannedPaths = [];
    },
    (value) => {
      value.work = "local";
    },
    (value) => {
      value.capabilities.profiles = [];
      value.capabilities.profiles.push({ subagent_type: "", effort: "low" });
    },
  ])(
    "rejects incomplete facts, task data, and capabilities visibly",
    (mutate) => {
      const invalid = structuredClone(request);
      mutate(invalid);
      const result = spawnSync(process.execPath, [cli, "resolve", "-"], {
        input: JSON.stringify(invalid),
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("compute-governor:");
    },
  );

  it("blocks unknown capabilities visibly without model arguments", () => {
    expect(
      resolve({
        ...request,
        capabilities: { ...capabilities, models: null },
      }),
    ).toMatchObject({ status: "blocked", modelArguments: null });
    expect(
      resolve({
        ...request,
        capabilities: { ...capabilities, models: null },
      }).reasons,
    ).toContain("requested model and effort unavailable or unknown");
  });

  it("requires an installed declared Claude profile for non-null effort", () => {
    const result = resolve({
      ...request,
      facts: { ...request.facts, provider: "claude", ambiguous: true },
      capabilities: {
        ...capabilities,
        profiles: [{ subagent_type: "general-purpose", effort: null }],
      },
    });
    expect(result).toMatchObject({ status: "blocked", modelArguments: null });
    expect(result.reasons).toContain(
      "requested model and effort unavailable or unknown",
    );
  });

  it("selects only the exact neutral Claude profile for an effort", () => {
    const result = resolve({
      ...request,
      facts: { ...request.facts, provider: "claude", ambiguous: true },
      capabilities: {
        ...capabilities,
        profiles: [
          { subagent_type: "security-review", effort: "medium" },
          ...capabilities.profiles,
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

  it("blocks when only an unrelated Claude profile has the selected effort", () => {
    const result = resolve({
      ...request,
      facts: { ...request.facts, provider: "claude", ambiguous: true },
      capabilities: {
        ...capabilities,
        profiles: [{ subagent_type: "security-review", effort: "medium" }],
      },
    });
    expect(result).toMatchObject({ status: "blocked", modelArguments: null });
    expect(result.reasons).toContain(
      "requested model and effort unavailable or unknown",
    );
  });

  it("requires native delegation instructions to consume ready advice", () => {
    for (const file of [
      "config/CLAUDE.md",
      "skills/dev/SKILL.md",
      "skills/triage/SKILL.md",
      "commands/bs/help.md",
      "commands/bs/workflow.md",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("native-advisory");
      expect(source).toMatch(
        /ready.{0,100}(model|argument)|model.{0,100}ready/is,
      );
      expect(source).toMatch(
        /blocked.{0,140}(local|default)|local.{0,140}blocked/is,
      );
    }
  });
});
