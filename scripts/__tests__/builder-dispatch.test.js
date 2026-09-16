import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

function run(subject, command, extra = [], taskId = "BUI-793") {
  const taskArgs =
    command === "create" && taskId !== null ? ["--task-id", taskId] : [];
  return spawnSync(
    "node",
    [
      DISPATCH,
      command,
      "--receipt",
      subject.receipt,
      "--request",
      subject.request,
      ...taskArgs,
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
    expect(receipt.payload.campaign).toMatchObject({
      taskReference: "BUI-793",
    });

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

  it("requires a stable task reference before creating a campaign", () => {
    const value = subject();
    const created = run(value, "create", [], null);
    expect(created.status).toBe(2);
    expect(created.stderr).toContain("--task-id is required for create");
    expect(existsSync(value.receipt)).toBe(false);
  });

  it("recovers stale or dead-owner dispatcher locks without manual state edits", () => {
    const ownerless = subject();
    const ownerlessLock = path.join(ownerless.state, ".dispatch.lock");
    mkdirSync(ownerlessLock, { mode: 0o700 });
    utimesSync(ownerlessLock, new Date(0), new Date(0));
    const recoveredOwnerless = run(ownerless, "create");
    expect(recoveredOwnerless.status, recoveredOwnerless.stderr).toBe(0);
    expect(existsSync(ownerlessLock)).toBe(false);

    const deadOwner = subject();
    const deadOwnerLock = path.join(deadOwner.state, ".dispatch.lock");
    mkdirSync(deadOwnerLock, { mode: 0o700 });
    writeFileSync(
      path.join(deadOwnerLock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 99_999_999,
        createdAtEpochMs: Date.now(),
      }),
      { mode: 0o600 },
    );
    const recoveredDeadOwner = run(deadOwner, "create");
    expect(recoveredDeadOwner.status, recoveredDeadOwner.stderr).toBe(0);
    expect(existsSync(deadOwnerLock)).toBe(false);
  });

  it("does not reserve budget when the receipt destination is unavailable", () => {
    const value = subject();
    value.receipt = path.join(
      makeTempDir("builder-dispatch-missing-receipt-"),
      "missing",
      "receipt.json",
    );
    const failed = run(value, "create");
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("receipt output directory does not exist");
    expect(
      readdirSync(path.join(value.state, "campaigns")).filter((entry) =>
        entry.endsWith(".json"),
      ),
    ).toEqual([]);

    mkdirSync(path.dirname(value.receipt));
    const retried = run(value, "create");
    expect(retried.status, retried.stderr).toBe(0);
  });

  it("rolls back a new reservation when receipt delivery fails", () => {
    const value = subject();
    writeFileSync(value.receipt, JSON.stringify({ stale: true }));
    const failed = run(value, "create");
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("receipt output already exists");
    const [campaign] = readdirSync(path.join(value.state, "campaigns"));
    const ledger = JSON.parse(
      readFileSync(path.join(value.state, "campaigns", campaign), "utf8"),
    );
    expect(ledger.budget.reservedSeconds).toBe(0);
    expect(ledger.attempts).toEqual({});

    unlinkSync(value.receipt);
    const retried = run(value, "create");
    expect(retried.status, retried.stderr).toBe(0);
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

  it("keeps a changed remediation prompt in its stable task campaign", () => {
    const value = subject();
    expect(run(value, "create").status).toBe(0);
    const firstReceipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    const runRecord = path.join(
      makeTempDir("builder-dispatch-remediation-record-"),
      "record.json",
    );
    const identity = {
      provider: firstReceipt.payload.plan.provider,
      model: firstReceipt.payload.plan.model,
      effort: firstReceipt.payload.plan.effort,
      executionProfileSha256: firstReceipt.payload.plan.executionProfile.sha256,
    };
    writeFileSync(
      runRecord,
      JSON.stringify({
        schemaVersion: 2,
        plan: firstReceipt.payload.plan,
        requested: identity,
        effective: identity,
        timing: { startedAtEpochMs: 1000, finishedAtEpochMs: 2000 },
        outcome: { status: "completed", exitCode: 0, category: null },
        usage: null,
      }),
    );
    expect(run(value, "settle", ["--run-record", runRecord]).status).toBe(0);

    value.receipt = path.join(
      makeTempDir("builder-dispatch-remediation-receipt-"),
      "receipt.json",
    );
    writeFileSync(
      value.prompt,
      "repair the exact finding from the first attempt\n",
    );
    const remediated = run(value, "create");
    expect(remediated.status, remediated.stderr).toBe(0);
    const remediationReceipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    expect(remediationReceipt.payload.campaign).toMatchObject({
      id: firstReceipt.payload.campaign.id,
      taskReference: "BUI-793",
      budget: { limitSeconds: 900, reservedSeconds: 899 },
    });
    expect(remediationReceipt.payload.attempt.promptSha256).not.toBe(
      firstReceipt.payload.attempt.promptSha256,
    );
  });

  it("rejects a non-write phase before it can reserve a dispatch campaign", () => {
    const value = subject();
    writeFileSync(
      value.request,
      JSON.stringify({
        ...JSON.parse(readFileSync(value.request, "utf8")),
        phase: "verify",
      }),
    );
    const created = run(value, "create");
    expect(created.status).toBe(2);
    expect(created.stderr).toContain(
      "only required for schema-v2 write phases",
    );
    expect(existsSync(value.receipt)).toBe(false);
    expect(
      readdirSync(path.join(value.state, "campaigns")).filter((entry) =>
        entry.endsWith(".json"),
      ),
    ).toEqual([]);
  });

  it("keeps every known schema-v2 write caller behind builder dispatch", () => {
    for (const [relative, dispatch, task, launch] of [
      [
        "scripts/overnight-loop.sh",
        'builder-dispatch.js" create',
        '--task-id "$current_issue"',
        '--builder-receipt "$builder_receipt"',
      ],
      [
        "scripts/steward/orchestrate.sh",
        'builder-dispatch.js" create',
        '--task-id "$invocation"',
        '--builder-receipt "$builder_receipt"',
      ],
      [
        "skills/ralph/reference.md",
        'builder-dispatch.js" create',
        '--task-id "$ITEM_ID"',
        '--builder-receipt "$EVIDENCE_DIR/builder-receipt.json"',
      ],
    ]) {
      const source = readFileSync(path.join(ROOT, relative), "utf8");
      expect(source, relative).toContain(dispatch);
      expect(source, relative).toContain(task);
      expect(source, relative).toContain(launch);
    }
  });
});
