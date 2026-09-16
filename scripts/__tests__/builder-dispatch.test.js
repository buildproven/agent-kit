import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DISPATCH = path.join(ROOT, "scripts", "builder-dispatch.js");

function subject() {
  const target = makeTempDir("builder-dispatch-target-");
  const prompt = path.join(makeTempDir("builder-dispatch-prompt-"), "task.md");
  const request = path.join(
    makeTempDir("builder-dispatch-request-"),
    "request.json",
  );
  const state = makeTempDir("builder-dispatch-state-");
  const receipt = path.join(
    makeTempDir("builder-dispatch-receipt-"),
    "plan.json",
  );
  mkdirSync(path.join(target, "src"));
  writeFileSync(path.join(target, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-q"], { cwd: target });
  execFileSync("git", ["config", "user.email", "tests@buildproven.local"], {
    cwd: target,
  });
  execFileSync("git", ["config", "user.name", "BuildProven Tests"], {
    cwd: target,
  });
  execFileSync("git", ["add", "."], { cwd: target });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: target });
  writeFileSync(prompt, "implement the bounded ordinary local feature\n");
  writeFileSync(
    request,
    JSON.stringify({
      schemaVersion: 2,
      caller: "interactive-ralph",
      provider: "codex",
      phase: "implement",
      evidence: {
        localized: true,
        reversible: true,
        targetedProof: true,
        ambiguous: false,
        changedFiles: 1,
        protectedSurfaces: [],
        publicContract: false,
        crossRepository: false,
        plannedPaths: ["src/"],
      },
    }),
  );
  return { target, prompt, request, state, receipt };
}

function run(subject, command, extra = []) {
  return spawnSync(
    "node",
    [
      DISPATCH,
      command,
      "--receipt",
      subject.receipt,
      "--request",
      subject.request,
      "--prompt-file",
      subject.prompt,
      "--target-dir",
      subject.target,
      "--state-dir",
      subject.state,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

describe("builder dispatch", () => {
  it("issues and verifies an exact Terra receipt without inheriting a caller model", () => {
    const value = subject();
    const created = run(value, "create");
    expect(created.status, created.stderr).toBe(0);
    expect(existsSync(value.receipt)).toBe(true);

    const receipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    expect(receipt.payload).toMatchObject({
      schemaVersion: 1,
      kind: "builder-dispatch-plan/v1",
      plan: {
        schemaVersion: 2,
        route: "standard",
        model: "gpt-5.6-terra",
        effort: "medium",
      },
      campaign: { budget: { limitSeconds: 900, reservedSeconds: 900 } },
    });
    expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]+$/);

    const verified = run(value, "verify");
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "medium",
    });
  });

  it("rejects a changed prompt before a worker can use the receipt", () => {
    const value = subject();
    expect(run(value, "create").status).toBe(0);
    writeFileSync(value.prompt, "implement an unrelated task\n");
    const verified = run(value, "verify");
    expect(verified.status).toBe(2);
    expect(verified.stderr).toContain("not bound to this prompt and target");
  });

  it("settles an exact terminal attempt and releases only unused shared budget", () => {
    const value = subject();
    expect(run(value, "create").status).toBe(0);
    const receipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    const runRecord = path.join(
      makeTempDir("builder-dispatch-record-"),
      "record.json",
    );
    const identity = {
      provider: receipt.payload.plan.provider,
      model: receipt.payload.plan.model,
      effort: receipt.payload.plan.effort,
      executionProfileSha256: receipt.payload.plan.executionProfile.sha256,
    };
    writeFileSync(
      runRecord,
      JSON.stringify({
        schemaVersion: 2,
        plan: receipt.payload.plan,
        requested: identity,
        effective: identity,
        timing: { startedAtEpochMs: 1000, finishedAtEpochMs: 3100 },
        outcome: { status: "completed", exitCode: 0, category: null },
        usage: null,
      }),
    );
    const settled = run(value, "settle", ["--run-record", runRecord]);
    expect(settled.status, settled.stderr).toBe(0);
    expect(JSON.parse(settled.stdout)).toMatchObject({
      budget: { limitSeconds: 900, usedSeconds: 3, reservedSeconds: 0 },
    });
  });

  it("keeps every known schema-v2 write caller behind builder dispatch", () => {
    for (const [relative, dispatch, launch] of [
      [
        "scripts/overnight-loop.sh",
        'builder-dispatch.js" create',
        '--builder-receipt "$builder_receipt"',
      ],
      [
        "scripts/steward/orchestrate.sh",
        'builder-dispatch.js" create',
        '--builder-receipt "$builder_receipt"',
      ],
      [
        "skills/ralph/reference.md",
        'builder-dispatch.js" create',
        '--builder-receipt "$EVIDENCE_DIR/builder-receipt.json"',
      ],
    ]) {
      const source = readFileSync(path.join(ROOT, relative), "utf8");
      expect(source, relative).toContain(dispatch);
      expect(source, relative).toContain(launch);
    }
  });
});
