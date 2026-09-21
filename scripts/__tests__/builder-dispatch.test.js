import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
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

function builderBinding(receipt) {
  return {
    campaignId: receipt.payload.campaign.id,
    attemptId: receipt.payload.attempt.id,
  };
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

    const reusedPid = subject();
    const reusedPidLock = path.join(reusedPid.state, ".dispatch.lock");
    mkdirSync(reusedPidLock, { mode: 0o700 });
    writeFileSync(
      path.join(reusedPidLock, "owner.json"),
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        createdAtEpochMs: Date.now(),
        processStartIdentity: "not-the-current-process-start",
      }),
      { mode: 0o600 },
    );
    const recoveredReusedPid = run(reusedPid, "create");
    expect(recoveredReusedPid.status, recoveredReusedPid.stderr).toBe(0);
    expect(existsSync(reusedPidLock)).toBe(false);
  });

  it("refuses a lock owner that changes into a symbolic link", () => {
    const value = subject();
    const lock = path.join(value.state, ".dispatch.lock");
    const target = path.join(
      makeTempDir("builder-dispatch-owner-target-"),
      "owner.json",
    );
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, path.join(lock, "owner.json"));

    const result = run(value, "create");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("builder dispatch lock owner is unsafe");
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
        builderDispatch: builderBinding(receipt),
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

  it("atomically claims a receipt once before provider launch and binds settlement", () => {
    const value = subject();
    expect(run(value, "create").status).toBe(0);
    const receipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    const launched = run(value, "launch");
    expect(launched.status, launched.stderr).toBe(0);
    const claim = JSON.parse(launched.stdout);
    expect(claim.builderDispatch.launchId).toMatch(/^[a-f0-9]{64}$/);
    const duplicate = run(value, "launch");
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain("not an active exact attempt");

    const identity = {
      provider: receipt.payload.plan.provider,
      model: receipt.payload.plan.model,
      effort: receipt.payload.plan.effort,
      executionProfileSha256: receipt.payload.plan.executionProfile.sha256,
    };
    const runRecord = path.join(
      makeTempDir("builder-dispatch-claim-record-"),
      "record.json",
    );
    writeFileSync(
      runRecord,
      JSON.stringify({
        schemaVersion: 2,
        plan: receipt.payload.plan,
        requested: identity,
        effective: identity,
        builderDispatch: claim.builderDispatch,
        timing: { startedAtEpochMs: 1000, finishedAtEpochMs: 2000 },
        outcome: { status: "completed", exitCode: 0, category: null },
        usage: null,
      }),
    );
    expect(run(value, "settle", ["--run-record", runRecord]).status).toBe(0);
  });

  it("repairs a missing public key from an existing signing key", () => {
    const value = subject();
    expect(run(value, "create").status).toBe(0);
    unlinkSync(path.join(value.state, "keys", "ed25519-public.der"));
    const verified = run(value, "verify");
    expect(verified.status, verified.stderr).toBe(0);
    expect(
      existsSync(path.join(value.state, "keys", "ed25519-public.der")),
    ).toBe(true);
  });

  it("shares one campaign budget across independent clones of the same origin", () => {
    const first = subject();
    const second = subject();
    second.state = first.state;
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:buildproven/agent-kit.git"],
      {
        cwd: first.target,
      },
    );
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/buildproven/agent-kit.git",
      ],
      {
        cwd: second.target,
      },
    );

    const firstCreated = run(first, "create");
    expect(firstCreated.status, firstCreated.stderr).toBe(0);
    const secondCreated = run(second, "create");
    expect(secondCreated.status).toBe(2);
    expect(secondCreated.stderr).toContain("campaign budget is exhausted");
    const firstReceipt = JSON.parse(readFileSync(first.receipt, "utf8"));
    const [campaign] = readdirSync(path.join(first.state, "campaigns"));
    expect(campaign).toBe(`${firstReceipt.payload.campaign.id}.json`);
  });

  it("allows one signed retry after a failed exact attempt without resetting the budget", () => {
    const value = subject();
    expect(run(value, "create").status).toBe(0);
    const firstReceipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    const runRecord = path.join(
      makeTempDir("builder-dispatch-failed-record-"),
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
        builderDispatch: builderBinding(firstReceipt),
        timing: { startedAtEpochMs: 1000, finishedAtEpochMs: 2000 },
        outcome: {
          status: "provider-unavailable",
          exitCode: 1,
          category: "unavailable",
        },
        usage: null,
      }),
    );
    const firstSettlement = run(value, "settle", ["--run-record", runRecord]);
    expect(firstSettlement.status, firstSettlement.stderr).toBe(0);

    value.receipt = path.join(
      makeTempDir("builder-dispatch-retry-receipt-"),
      "receipt.json",
    );
    const retried = run(value, "create");
    expect(retried.status, retried.stderr).toBe(0);
    const retryReceipt = JSON.parse(readFileSync(value.receipt, "utf8"));
    expect(retryReceipt.payload.attempt).toMatchObject({
      retryOf: firstReceipt.payload.attempt.id,
      reservedSeconds: 899,
    });

    const replayed = run(value, "settle", ["--run-record", runRecord]);
    expect(replayed.status).toBe(2);
    expect(replayed.stderr).toContain("not bound to the receipt attempt");
    writeFileSync(
      runRecord,
      JSON.stringify({
        schemaVersion: 2,
        plan: retryReceipt.payload.plan,
        requested: identity,
        effective: identity,
        builderDispatch: builderBinding(retryReceipt),
        timing: { startedAtEpochMs: 2000, finishedAtEpochMs: 3000 },
        outcome: {
          status: "provider-unavailable",
          exitCode: 1,
          category: "unavailable",
        },
        usage: null,
      }),
    );
    expect(run(value, "settle", ["--run-record", runRecord]).status).toBe(0);
    value.receipt = path.join(
      makeTempDir("builder-dispatch-exhausted-retry-"),
      "receipt.json",
    );
    const exhausted = run(value, "create");
    expect(exhausted.status).toBe(2);
    expect(exhausted.stderr).toContain("retry capacity is exhausted");
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
        builderDispatch: builderBinding(firstReceipt),
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
