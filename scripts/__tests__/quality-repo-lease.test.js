const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const invocation = require("../quality-invocation");
const lease = require("../quality-repo-lease");
const LEASE_CLI = path.resolve(__dirname, "..", "quality-repo-lease.js");
const FIXTURE_REPOSITORY = `vitest/${"a".repeat(16)}`;

let sandbox;
let originalTmpdir;
let originalTelemetryFile;
const stateRoots = [];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function attachRefCasCapability(
  manifestPath,
  protectionDigest,
  requiredChecks,
  {
    expiresInMs = 300_000,
    includeOutage = true,
    includeMissingReview = false,
  } = {},
) {
  const { manifest } = invocation.loadManifest(manifestPath);
  const evidence = {
    schemaVersion: 1,
    category: "github-actions-billing-preallocation",
    repository: manifest.repo.githubRepository,
    head: manifest.revisions.currentHead,
    waiverUntil: "2099-01-01T00:00:00.000Z",
    classifiedAt: "2026-08-21T12:00:00.000Z",
    failedJobs: [
      {
        check: "Quality Checks/quality",
        jobId: "1",
        startedAt: "2026-08-21T12:00:00.000Z",
        completedAt: "2026-08-21T12:00:01.000Z",
      },
    ],
    successfulOrSkippedChecks: [],
  };
  evidence.evidenceSha256 =
    require("../quality-ci-billing-waiver").evidenceSha256(evidence);
  if (includeOutage) {
    fs.writeFileSync(
      path.join(manifest.stateRoot, "ci-billing-waiver.json"),
      `${JSON.stringify(evidence)}\n`,
      { mode: 0o600 },
    );
  }
  const keys = crypto.generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1,
    repoKey: manifest.repo.key,
    pr: manifest.repo.pr,
    head: manifest.revisions.currentHead,
    baseSha: manifest.revisions.baseSha,
    invocationId: manifest.invocationId,
    approver: "test-operator",
    scope: "operator-nonstrict-refcas-override",
    reason: includeOutage
      ? "test Actions outage"
      : "test exact-head green CI ref update",
    acceptedConditions: includeOutage
      ? [
          "ci:failed",
          ...(includeMissingReview ? ["review:provider-exhaustion"] : []),
          "base:protected-nonstrict",
          "pr:non-atomic-state",
        ]
      : [
          ...(includeMissingReview ? ["review:provider-exhaustion"] : []),
          "base:protected-nonstrict",
          "pr:non-atomic-state",
        ],
    ciBillingEvidenceSha256: includeOutage ? evidence.evidenceSha256 : null,
    protectedNonstrictProtectionDigest: protectionDigest,
    protectedNonstrictRequiredChecks: requiredChecks,
    protectedNonstrictBaseSha: manifest.revisions.baseHeadSha,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    nonce: crypto.randomUUID(),
    challenge: "test-challenge",
  };
  const artifact = {
    schemaVersion: 1,
    payload,
    signature: crypto
      .sign(
        null,
        Buffer.from(JSON.stringify(canonicalJson(payload))),
        keys.privateKey,
      )
      .toString("base64"),
  };
  const artifactPath = path.join(manifest.stateRoot, "approval.json");
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, {
    mode: 0o600,
  });
  invocation.withManifestLockRaw(manifestPath, (locked) => {
    locked.approvalTrust = {
      publicKey: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    };
    locked.approval = {
      approved: true,
      repoKey: payload.repoKey,
      pr: payload.pr,
      head: payload.head,
      baseSha: payload.baseSha,
      invocationId: payload.invocationId,
      approver: payload.approver,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      source: "outer-wrapper-capability",
      scope: payload.scope,
      reason: payload.reason,
      acceptedConditions: payload.acceptedConditions,
      ciBillingEvidenceSha256: payload.ciBillingEvidenceSha256,
      protectedNonstrictProtectionDigest: protectionDigest,
      protectedNonstrictRequiredChecks: requiredChecks,
      protectedNonstrictBaseSha: payload.protectedNonstrictBaseSha,
      artifactPath,
      artifactSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(artifactPath))
        .digest("hex"),
    };
  });
}

beforeAll(() => {
  originalTmpdir = process.env.TMPDIR;
  originalTelemetryFile = process.env.BS_QUALITY_TELEMETRY_FILE;
  sandbox = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "quality-repo-lease-test-")),
  );
  process.env.TMPDIR = sandbox;
  process.env.BS_QUALITY_TELEMETRY_FILE = path.join(
    sandbox,
    "quality-telemetry.jsonl",
  );
});

afterAll(() => {
  for (const stateRoot of stateRoots) {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (originalTelemetryFile === undefined)
    delete process.env.BS_QUALITY_TELEMETRY_FILE;
  else process.env.BS_QUALITY_TELEMETRY_FILE = originalTelemetryFile;
});

function fixture(name, overrides = {}) {
  const root = path.join(sandbox, name);
  if (overrides.linkedFrom) {
    git(overrides.linkedFrom.root, ["worktree", "add", "-q", "--detach", root]);
    if (overrides.advanceHead) {
      fs.writeFileSync(path.join(root, "file.txt"), `${name}\n`);
      git(root, ["add", "file.txt"]);
      git(root, ["commit", "-q", "-m", `fixture ${name}`]);
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "quality@example.test"]);
    git(root, ["config", "user.name", "Quality Test"]);
    fs.writeFileSync(path.join(root, "file.txt"), `${name}\n`);
    git(root, ["add", "file.txt"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
    git(root, [
      "remote",
      "add",
      "origin",
      "git@github.com:buildproven/fixture.git",
    ]);
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const gitCommonDir = fs.realpathSync(
    path.resolve(root, git(root, ["rev-parse", "--git-common-dir"])),
  );
  const repoKey = overrides.repoKey || crypto.randomBytes(8).toString("hex");
  const invocationId = overrides.invocationId || crypto.randomUUID();
  const githubRepository = overrides.githubRepository || FIXTURE_REPOSITORY;
  const stateRoot = path.join(
    sandbox,
    "bs-quality",
    repoKey,
    "pr-7",
    head,
    invocationId,
  );
  stateRoots.push(stateRoot);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(stateRoot, "invocation.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: invocation.SCHEMA_VERSION,
        manifestRevision: 1,
        invocationId,
        stateRoot,
        options: { merge: true },
        repo: {
          realpath: root,
          gitCommonDir,
          key: repoKey,
          pr: 7,
          origin: "git@github.com:buildproven/fixture.git",
          githubRepository,
          headRepository: githubRepository,
          headRefName: `fix/${name}`,
          isCrossRepository: false,
        },
        revisions: {
          baseRef: "origin/main",
          baseSha: head,
          baseHeadSha: head,
          initialHead: head,
          currentHead: head,
        },
        merge: { invalidatedStamps: [] },
        governor: {},
        reviews: [],
        gates: [],
        requiredGates: [],
        risk: { tier: "medium" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(gitCommonDir, ".quality-vitest-fixture"),
    `${repoKey}\n`,
    { mode: 0o600 },
  );
  return { root, manifestPath, repoKey };
}

describe("repository merge lease", () => {
  it("recovers a ref-CAS block with a signed optional CI condition", () => {
    const { manifestPath } = fixture("refcas-recovery-optional-ci");
    const protectionDigest = "c".repeat(64);
    const requiredChecks = [{ context: "quality", appId: 15368 }];
    invocation.recordMergeAdmissionBlockedTerminal(
      manifestPath,
      ["base:protected-nonstrict", "pr:non-atomic-state"],
      "merge admission blocked",
    );
    attachRefCasCapability(manifestPath, protectionDigest, requiredChecks, {
      includeOutage: true,
    });
    const { manifest } = invocation.loadManifest(manifestPath);
    expect(invocation.approvalValid(manifest)).toBe(true);
    expect(
      invocation.protectedNonstrictRefCasCapability(manifest),
    ).not.toBeNull();

    expect(invocation.recoveryScope(manifest, manifest.terminalState)).toBe(
      "operator-nonstrict-refcas-override",
    );

    for (const field of ["head", "terminalEpoch", "mergeAttemptId"]) {
      const tampered = structuredClone(manifest);
      tampered.merge.admissionBlock[field] =
        field === "terminalEpoch"
          ? tampered.merge.admissionBlock[field] + 1
          : `tampered-${field}`;
      expect(
        invocation.recoveryScope(tampered, tampered.terminalState),
      ).toBeNull();
    }
    const conditionsTampered = structuredClone(manifest);
    conditionsTampered.merge.admissionBlock.conditions = ["ci:failed"];
    expect(
      invocation.recoveryScope(
        conditionsTampered,
        conditionsTampered.terminalState,
      ),
    ).toBeNull();
  });

  it("parses included GitHub responses with CRLF and rejects malformed output", () => {
    expect(
      lease._parseIncludedGhResponse(
        'HTTP/2 422\r\ncontent-type: application/json\r\n\r\n{"message":"Update is not a fast forward"}\r\n',
      ),
    ).toEqual({
      status: 422,
      body: { message: "Update is not a fast forward" },
    });
    expect(lease._parseIncludedGhResponse("not an HTTP response")).toEqual({
      status: null,
      body: null,
    });
  });

  it("recognizes only the exact non-fast-forward response as a safe rejection", () => {
    const included = (message) => ({
      status: 1,
      stdout: `HTTP/2 422 Unprocessable Entity\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ message })}\r\n`,
    });
    expect(
      lease._classifyRefUpdateResponse(
        included("Update is not a fast forward"),
        "main",
        "a".repeat(40),
      ).kind,
    ).toBe("rejected-stale-base");
    expect(
      lease._classifyRefUpdateResponse(
        included("Validation Failed"),
        "main",
        "a".repeat(40),
      ).kind,
    ).toBe("ambiguous");
    expect(
      lease._classifyRefUpdateResponse(
        {
          status: 1,
          stdout:
            'HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n{"ref":"refs/heads/main","object":{"sha":"' +
            "a".repeat(40) +
            '"}}\r\nHTTP/2 422 Unprocessable Entity\r\ncontent-type: application/json\r\n\r\n{"message":"Update is not a fast forward"}\r\n',
        },
        "main",
        "a".repeat(40),
      ).kind,
    ).toBe("ambiguous");
    expect(
      lease._classifyRefUpdateResponse(
        {
          status: 0,
          stdout:
            'HTTP/2 422 Unprocessable Entity\r\ncontent-type: application/json\r\n\r\n{"message":"Update is not a fast forward"}\r\n',
        },
        "main",
        "a".repeat(40),
      ).kind,
    ).toBe("ambiguous");
  });

  it("requires exact open PR read-back before releasing a rejected ref-CAS", () => {
    const { manifestPath } = fixture("refcas-rejection-readback");
    const { manifest } = invocation.loadManifest(manifestPath);
    const exact = {
      state: "OPEN",
      mergedAt: null,
      mergeCommit: null,
      headRefName: manifest.repo.headRefName,
      headRefOid: manifest.revisions.currentHead,
      baseRefName: "main",
    };
    expect(lease._exactOpenRemoteOutcome(manifest, exact)).toBe(true);
    expect(lease._exactOpenRemoteOutcome(manifest, null)).toBe(false);
    expect(
      lease._exactOpenRemoteOutcome(manifest, {
        ...exact,
        baseRefName: "another-base",
      }),
    ).toBe(false);
    expect(
      lease._exactOpenRemoteOutcome(manifest, {
        ...exact,
        state: "CLOSED",
      }),
    ).toBe(false);
  });

  it("retries accepted ref-CAS read-back until indirect merge state converges", () => {
    const { manifestPath } = fixture("refcas-lagging-readback");
    const { manifest } = invocation.loadManifest(manifestPath);
    let reads = 0;
    const remote = lease._waitForRefCasIntegration(manifest, {
      attempts: 4,
      intervalMs: 0,
      readRemote() {
        reads += 1;
        if (reads < 3) throw new Error("transient read failure");
        return { state: "MERGED" };
      },
      integrated: (_candidate, value) => value.state === "MERGED",
      wait() {},
    });
    expect(remote).toEqual({ state: "MERGED" });
    expect(reads).toBe(3);
  });

  it("requires capability validity through the bounded ref update", () => {
    const candidate = fixture("refcas-expiry-reserve");
    const { manifest } = invocation.loadManifest(candidate.manifestPath);
    const digest = "c".repeat(64);
    attachRefCasCapability(
      candidate.manifestPath,
      digest,
      [{ context: "quality", appId: 15368 }],
      { expiresInMs: 60_000 },
    );
    expect(() =>
      lease._resolveRefCasAtMutation(
        invocation.loadManifest(candidate.manifestPath).manifest,
        {
          admin: true,
          expectedHead: manifest.revisions.currentHead,
          mode: "protected-nonstrict-ref-cas",
          protectionDigest: digest,
        },
        manifest.revisions.currentHead,
      ),
    ).toThrow(/remain valid through the bounded ref update/);
  });

  it("releases a not-started guard when final capability validation fails", () => {
    const candidate = fixture("refcas-final-validation-cleanup");
    const { manifest } = invocation.loadManifest(candidate.manifestPath);
    const digest = "c".repeat(64);
    const requiredChecks = [{ context: "quality", appId: 15368 }];
    attachRefCasCapability(candidate.manifestPath, digest, requiredChecks, {
      expiresInMs: 60_000,
    });
    const owner = lease.acquire(candidate.manifestPath);
    const options = {
      admin: true,
      expectedHead: manifest.revisions.currentHead,
      mode: "protected-nonstrict-ref-cas",
      protectionDigest: digest,
      requiredChecks,
    };
    lease.acquireMergeGuard(candidate.manifestPath, owner.token, options);

    expect(() =>
      lease._performRefCasUpdate(
        invocation.loadManifest(candidate.manifestPath),
        owner.token,
        options,
      ),
    ).toThrow(/remain valid through the bounded ref update/);
    expect(lease.status(candidate.manifestPath)).toMatchObject({
      state: "active",
      mergeGuard: null,
    });
    lease.release(candidate.manifestPath, owner.token, "test-complete");
  });

  it("acquires idempotently for the exact owner and ignores TMPDIR changes", () => {
    const { manifestPath } = fixture("idempotent");
    const first = lease.acquire(manifestPath);
    const firstRoot = lease.stateRoot();
    const priorTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = path.join(sandbox, "different-tmp");
    const secondRoot = lease.stateRoot();
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;

    expect(secondRoot).toBe(firstRoot);
    expect(lease.acquire(manifestPath)).toEqual(first);
    expect(lease.status(manifestPath)).toMatchObject({
      state: "active",
      owned: true,
      repository: FIXTURE_REPOSITORY,
    });
    lease.release(manifestPath, first.token, "test-complete");
  });

  it("reclaims an orphaned lease only after GitHub confirms its PR is closed", () => {
    const first = fixture("orphaned-lease-owner");
    lease.acquire(first.manifestPath);
    const { manifest } = invocation.loadManifest(first.manifestPath);
    fs.unlinkSync(first.manifestPath);

    const bin = path.join(sandbox, "orphaned-lease-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ state: "CLOSED", mergedAt: null })}'
`,
      { mode: 0o700 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const successor = fixture("orphaned-lease-successor", {
        linkedFrom: first,
        repoKey: first.repoKey,
        advanceHead: true,
      });
      expect(
        lease.acquire(successor.manifestPath, { waitMs: 0 }),
      ).toMatchObject({
        generation: 1,
        identity: manifest.repo.githubRepository,
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("keeps an orphaned lease when its PR remains open", () => {
    const first = fixture("orphaned-open-lease-owner");
    lease.acquire(first.manifestPath);
    fs.unlinkSync(first.manifestPath);

    const bin = path.join(sandbox, "orphaned-open-lease-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ state: "OPEN" })}'
`,
      { mode: 0o700 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const successor = fixture("orphaned-open-lease-successor", {
        linkedFrom: first,
        repoKey: first.repoKey,
        advanceHead: true,
      });
      expect(() =>
        lease.acquire(successor.manifestPath, { waitMs: 0 }),
      ).toThrow(/recover or resume/);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("keeps the fencing credential out of CLI verification output", () => {
    const { manifestPath } = fixture("silent-verification");
    const childEnv = {
      ...process.env,
      NODE_ENV: "test",
      VITEST: "true",
      VITEST_WORKER_ID: "credential-output",
    };
    execFileSync("node", [LEASE_CLI, "acquire", "--manifest", manifestPath], {
      env: childEnv,
    });
    const ownerToken =
      invocation.loadManifest(manifestPath).manifest.merge.repositoryLease
        .token;
    const output = execFileSync(
      "node",
      [LEASE_CLI, "verify", "--manifest", manifestPath],
      {
        encoding: "utf8",
        env: {
          ...childEnv,
          BS_QUALITY_REPOSITORY_LEASE_TOKEN: ownerToken,
        },
      },
    );
    expect(output).toBe("");
    expect(output).not.toContain(ownerToken);
    execFileSync("node", [LEASE_CLI, "release", "--manifest", manifestPath], {
      env: {
        ...childEnv,
        BS_QUALITY_REPOSITORY_LEASE_TOKEN: ownerToken,
      },
    });
  });

  it("rejects stale credentials at verification, mutation, and release", () => {
    const { manifestPath } = fixture("stale-token");
    const owner = lease.acquire(manifestPath);
    expect(() => lease.verify(manifestPath, "0".repeat(64))).toThrow(
      /stale|does not own/,
    );
    expect(() =>
      lease.withManifestMutation(manifestPath, "0".repeat(64), () => {}),
    ).toThrow(/stale/);
    expect(() => lease.release(manifestPath, "0".repeat(64))).toThrow(
      /exact.*owner/,
    );
    lease.release(manifestPath, owner.token, "test-complete");
  });

  it("does not let ambient Vitest variables redirect a real repository", () => {
    const { root, manifestPath } = fixture("ambient-test-namespace", {
      githubRepository: "BuildProven/Fixture",
    });
    const { manifest } = invocation.loadManifest(manifestPath);
    fs.writeFileSync(
      path.join(root, ".quality-vitest-fixture"),
      `${manifest.repo.key}\n`,
    );
    const previousVitest = process.env.VITEST;
    const previousWorker = process.env.VITEST_WORKER_ID;
    process.env.VITEST = "true";
    process.env.VITEST_WORKER_ID = "ambient-test-namespace";
    try {
      expect(lease.isVitestFixture(manifest)).toBe(false);
      expect(lease._pathsFor("buildproven/fixture", manifest).root).toBe(
        lease.stateRoot(),
      );
    } finally {
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousWorker === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = previousWorker;
    }
  });

  it("reads a test-fixture sentinel from one non-symlink descriptor", () => {
    const githubRepository = `vitest/${crypto.randomBytes(12).toString("hex")}`;
    const { root, manifestPath } = fixture("fixture-sentinel", {
      githubRepository,
    });
    const { manifest } = invocation.loadManifest(manifestPath);
    const sentinel = path.join(root, ".git", ".quality-vitest-fixture");
    fs.writeFileSync(sentinel, `${manifest.repo.key}\n`, { mode: 0o600 });
    const previousVitest = process.env.VITEST;
    const previousWorker = process.env.VITEST_WORKER_ID;
    process.env.VITEST = "true";
    process.env.VITEST_WORKER_ID = "fixture-sentinel";
    try {
      expect(lease.isVitestFixture(manifest)).toBe(true);
      const backing = path.join(root, ".git", ".fixture-sentinel-backing");
      fs.renameSync(sentinel, backing);
      fs.symlinkSync(backing, sentinel);
      expect(() => lease.isVitestFixture(manifest)).toThrow(
        /non-symlink regular file/,
      );
      fs.unlinkSync(sentinel);
      fs.renameSync(backing, sentinel);
    } finally {
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousWorker === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = previousWorker;
    }
  });

  it("refuses to release a pending lease generation", () => {
    const { manifestPath } = fixture("pending-release");
    const owner = lease.acquire(manifestPath);
    const { manifest } = invocation.loadManifest(manifestPath);
    const ownerFile = path.join(
      lease._pathsFor(FIXTURE_REPOSITORY, manifest).lease,
      "owner.json",
    );
    const record = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    record.disposition = "rotation-pending";
    fs.writeFileSync(ownerFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    expect(() => lease.release(manifestPath, owner.token)).toThrow(
      /exact.*owner/,
    );
    record.disposition = "active";
    fs.writeFileSync(ownerFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    lease.release(manifestPath, owner.token, "test-complete");
  });

  it("serializes dead-guard recovery and never removes a replacement owner", () => {
    const directory = path.join(sandbox, "guard-recovery-race");
    fs.mkdirSync(directory, { mode: 0o700 });
    const observed = {
      schemaVersion: 1,
      pid: 99999999,
      uid: process.geteuid(),
      nonce: crypto.randomBytes(16).toString("hex"),
      processIdentity: null,
      acquiredAt: "2026-08-05T00:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(directory, "owner.json"),
      `${JSON.stringify(observed)}\n`,
      { mode: 0o600 },
    );
    const recoveryLock = `${directory}.recovery-lock`;
    fs.writeFileSync(recoveryLock, "busy\n", { mode: 0o600 });
    expect(lease._recoverDeadGuard(directory, observed)).toBe(false);

    const replacement = {
      ...observed,
      pid: process.pid,
      nonce: crypto.randomBytes(16).toString("hex"),
      acquiredAt: "2026-08-05T00:00:01.000Z",
    };
    fs.writeFileSync(
      path.join(directory, "owner.json"),
      `${JSON.stringify(replacement)}\n`,
      { mode: 0o600 },
    );
    fs.unlinkSync(recoveryLock);
    expect(lease._recoverDeadGuard(directory, observed)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")),
    ).toEqual(replacement);
    fs.unlinkSync(path.join(directory, "owner.json"));
    fs.rmdirSync(directory);
  });

  it("distinguishes a recycled PID from the recorded guard process", () => {
    const directory = path.join(sandbox, "guard-reused-pid");
    fs.mkdirSync(directory, { mode: 0o700 });
    const observed = {
      schemaVersion: 1,
      pid: process.pid,
      uid: process.geteuid(),
      nonce: crypto.randomBytes(16).toString("hex"),
      processIdentity: "a different process start time",
      acquiredAt: "2026-08-05T00:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(directory, "owner.json"),
      `${JSON.stringify(observed)}\n`,
      { mode: 0o600 },
    );
    expect(lease._recoverDeadGuard(directory, observed)).toBe(true);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("cleans a newly created guard when its owner write fails", () => {
    const directory = path.join(sandbox, "guard-owner-write-failure");
    expect(() =>
      lease._acquireGuard(directory, 10, {
        writeOwner() {
          const error = new Error("injected owner write failure");
          error.code = "EIO";
          throw error;
        },
      }),
    ).toThrow(/injected owner write failure/);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("retries when a contended guard disappears before its owner read", async () => {
    const directory = path.join(sandbox, "guard-release-race");
    fs.mkdirSync(directory, { mode: 0o700 });
    const child = spawn(
      "node",
      [
        "-e",
        `require(${JSON.stringify(path.resolve(__dirname, "..", "quality-repo-lease.js"))})._acquireGuard(${JSON.stringify(directory)}, 1000)`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmdirSync(directory);
    const result = await new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(result.code, result.stderr).toBe(0);
    fs.unlinkSync(path.join(directory, "owner.json"));
    fs.rmdirSync(directory);
  });

  it("rejects a symlink substituted for an opened lease record", () => {
    const { manifestPath } = fixture("symlink-record");
    const owner = lease.acquire(manifestPath);
    const { manifest } = invocation.loadManifest(manifestPath);
    const ownerFile = path.join(
      lease._pathsFor(FIXTURE_REPOSITORY, manifest).lease,
      "owner.json",
    );
    const backingFile = path.join(
      path.dirname(ownerFile),
      "owner.backing.json",
    );
    fs.renameSync(ownerFile, backingFile);
    fs.symlinkSync(backingFile, ownerFile);
    expect(() => lease.verify(manifestPath, owner.token)).toThrow(
      /non-symlink regular file/,
    );
    fs.unlinkSync(ownerFile);
    fs.renameSync(backingFile, ownerFile);
    lease.release(manifestPath, owner.token, "test-complete");
  });

  it("rejects the same invocation id from an independent clone tuple", () => {
    const invocationId = crypto.randomUUID();
    const first = fixture("clone-one", { invocationId });
    const second = fixture("clone-two", {
      invocationId,
      linkedFrom: first,
      repoKey: first.repoKey,
      advanceHead: true,
    });
    const owner = lease.acquire(first.manifestPath);
    expect(() => lease.acquire(second.manifestPath, { waitMs: 0 })).toThrow(
      /owned by/,
    );
    lease.release(first.manifestPath, owner.token, "test-complete");
  });

  it("rejects an unbounded CLI wait request", () => {
    const { manifestPath } = fixture("bounded-cli-wait");
    expect(() =>
      execFileSync(
        process.execPath,
        [
          LEASE_CLI,
          "acquire",
          "--manifest",
          manifestPath,
          "--wait-ms",
          "30001",
        ],
        { encoding: "utf8" },
      ),
    ).toThrow(/--wait-ms must be an integer from 0 to 30000/);
  });

  it.each([-1, 30001, Infinity, 1.5])(
    "rejects an unbounded public API wait request: %s",
    (waitMs) => {
      const { manifestPath } = fixture(`bounded-api-wait-${String(waitMs)}`);
      expect(() => lease.acquire(manifestPath, { waitMs })).toThrow(
        /waitMs must be an integer from 0 to 30000/,
      );
    },
  );

  it("fences every public manifest mutation through the pinned process token", () => {
    const { manifestPath } = fixture("mutation-fence");
    const owner = lease.acquire(manifestPath);
    const previous = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = owner.token;
    invocation.withManifestLock(manifestPath, (manifest) => {
      manifest.risk.score = 42;
    });
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = "f".repeat(64);
    expect(() =>
      invocation.withManifestLock(manifestPath, (manifest) => {
        manifest.risk.score = 99;
      }),
    ).toThrow(/stale/);
    expect(invocation.loadManifest(manifestPath).manifest.risk.score).toBe(42);
    if (previous === undefined)
      delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    else process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = previous;
    lease.release(manifestPath, owner.token, "test-complete");
  });

  it("uses crash-atomic namespace removal on release", () => {
    const { manifestPath } = fixture("atomic-release");
    const owner = lease.acquire(manifestPath);
    expect(lease.release(manifestPath, owner.token, "test-complete")).toBe(
      true,
    );
    expect(lease.status(manifestPath)).toEqual({
      required: true,
      state: "missing",
    });
  });

  it("requires the exact token and six-hour staleness before fenced recovery", () => {
    const first = fixture("recover-one");
    const second = fixture("recover-two", {
      linkedFrom: first,
      repoKey: first.repoKey,
    });
    const owner = lease.acquire(first.manifestPath);
    expect(() => lease.recover(second.manifestPath, owner.token)).toThrow(
      /recent/,
    );

    const { manifest } = invocation.loadManifest(first.manifestPath);
    const ownerFile = path.join(
      lease._pathsFor(FIXTURE_REPOSITORY, manifest).lease,
      "owner.json",
    );
    const record = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    record.renewedAt = new Date(
      Date.now() - lease.STALE_MS - 1000,
    ).toISOString();
    fs.writeFileSync(ownerFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });

    expect(() => lease.recover(second.manifestPath, "0".repeat(64))).toThrow(
      /does not match/,
    );
    const recovered = lease.recover(second.manifestPath, owner.token);
    expect(() => lease.verify(first.manifestPath, owner.token)).toThrow(
      /stale|does not own/,
    );
    expect(lease.verify(second.manifestPath, recovered.token)).toMatchObject({
      generation: 2,
    });
    lease.release(second.manifestPath, recovered.token, "test-complete");
  });

  it("exposes lease age and requires an explicit break-glass override for recent recovery", () => {
    const first = fixture("recover-override-one");
    const second = fixture("recover-override-two", {
      linkedFrom: first,
      repoKey: first.repoKey,
    });
    const owner = lease.acquire(first.manifestPath);
    expect(lease.status(first.manifestPath)).toMatchObject({
      state: "active",
      stale: false,
      staleAfterMs: lease.STALE_MS,
      recoveryOverrideRequired: true,
    });
    const previous = process.env.BS_QUALITY_LEASE_RECOVERY_OVERRIDE;
    try {
      delete process.env.BS_QUALITY_LEASE_RECOVERY_OVERRIDE;
      expect(() =>
        lease.recover(second.manifestPath, owner.token, {
          override: true,
          reason: "operator confirmed the original campaign is abandoned",
        }),
      ).toThrow(/BS_QUALITY_LEASE_RECOVERY_OVERRIDE/);

      process.env.BS_QUALITY_LEASE_RECOVERY_OVERRIDE = "1";
      const recovered = lease.recover(second.manifestPath, owner.token, {
        override: true,
        reason: "operator confirmed the original campaign is abandoned",
      });
      expect(recovered.generation).toBe(2);
      lease.release(second.manifestPath, recovered.token, "test-complete");
    } finally {
      if (previous === undefined)
        delete process.env.BS_QUALITY_LEASE_RECOVERY_OVERRIDE;
      else process.env.BS_QUALITY_LEASE_RECOVERY_OVERRIDE = previous;
    }
  });

  it("completes either crash point in the pending rotation write pair", () => {
    for (const crashPoint of ["before-manifest", "after-manifest"]) {
      const { manifestPath } = fixture(`rotation-${crashPoint}`);
      const owner = lease.acquire(manifestPath);
      const { manifest } = invocation.loadManifest(manifestPath);
      const ownerFile = path.join(
        lease._pathsFor(FIXTURE_REPOSITORY, manifest).lease,
        "owner.json",
      );
      const record = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      const nextToken = crypto.randomBytes(32).toString("hex");
      const pending = {
        ...record,
        disposition: "rotation-pending",
        priorToken: owner.token,
        token: nextToken,
        generation: owner.generation + 1,
      };
      fs.writeFileSync(ownerFile, `${JSON.stringify(pending, null, 2)}\n`, {
        mode: 0o600,
      });
      if (crashPoint === "after-manifest") {
        invocation.withManifestLockRaw(manifestPath, (manifest) => {
          manifest.merge.repositoryLease = {
            repository: FIXTURE_REPOSITORY,
            generation: pending.generation,
            token: nextToken,
          };
        });
      }
      const recovered = lease.recover(manifestPath, owner.token);
      expect(recovered).toMatchObject({
        token: nextToken,
        generation: owner.generation + 1,
      });
      expect(() => lease.verify(manifestPath, owner.token)).toThrow(/stale/);
      expect(lease.verify(manifestPath, nextToken)).toMatchObject({
        disposition: "active",
      });
      lease.release(manifestPath, nextToken, "test-complete");
    }
  });

  it("preserves both the primary atomic-write and cleanup failures", () => {
    const directory = path.join(sandbox, "atomic-write-double-failure");
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(directory, "owner.json");
    const originalWrite = fs.writeFileSync;
    const originalUnlink = fs.unlinkSync;
    fs.writeFileSync = (file, data, options = {}) => {
      originalWrite(file, data, { ...options, mode: 0o600 });
      throw new Error("primary write failure");
    };
    fs.unlinkSync = () => {
      throw new Error("cleanup unlink failure");
    };
    try {
      expect(() => lease._atomicWrite(target, { value: true })).toThrow(
        /primary write failure.*cleanup.*cleanup unlink failure/,
      );
    } finally {
      fs.writeFileSync = originalWrite;
      fs.unlinkSync = originalUnlink;
      for (const file of fs.readdirSync(directory)) {
        originalUnlink(path.join(directory, file));
      }
      fs.rmdirSync(directory);
    }
  });

  it("reconciles a crashed merge guard without the lost process token", () => {
    const { manifestPath } = fixture("merge-reconcile");
    const owner = lease.acquire(manifestPath);
    lease.acquireMergeGuard(manifestPath, owner.token, { admin: true });
    invocation.withManifestLockRaw(manifestPath, (locked) => {
      locked.terminalState = {
        state: "verified-unmerged",
        detail: "awaiting operator merge authority",
        head: locked.revisions.currentHead,
        recordedAt: "2026-08-05T11:00:00Z",
      };
    });
    expect(() =>
      lease.release(manifestPath, owner.token, "provider-incomplete"),
    ).toThrow(/quarantined/);
    expect(lease.status(manifestPath).mergeGuard).toMatchObject({
      admin: true,
      adminReason: "ci-billing-waiver",
    });
    const { manifest } = invocation.loadManifest(manifestPath);
    const bin = path.join(sandbox, "merge-reconcile-bin");
    fs.mkdirSync(bin);
    const gh = path.join(bin, "gh");
    fs.writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-08-05T12:00:00Z",
        mergeCommit: { oid: "a".repeat(40) },
        headRefName: manifest.repo.headRefName,
        headRefOid: manifest.revisions.currentHead,
        baseRefName: "main",
      })}'
`,
      { mode: 0o700 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      expect(() =>
        lease.reconcileMergeOutcome(manifestPath, undefined, {
          confirmOwnerInvocationId: "wrong",
          confirmOwnerPr: manifest.repo.pr,
        }),
      ).toThrow(/exact current owner/);
      const reconcileEnv = { ...process.env };
      delete reconcileEnv.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
      expect(
        JSON.parse(
          execFileSync(
            "node",
            [
              LEASE_CLI,
              "reconcile-merge",
              "--manifest",
              manifestPath,
              "--confirm-owner-invocation-id",
              manifest.invocationId,
              "--confirm-owner-pr",
              String(manifest.repo.pr),
            ],
            { encoding: "utf8", env: reconcileEnv },
          ),
        ),
      ).toMatchObject({ reconciled: true, outcome: "merged" });
      expect(lease.status(manifestPath)).toEqual({
        required: true,
        state: "missing",
      });
      expect(
        invocation.loadManifest(manifestPath).manifest.terminalState,
      ).toMatchObject({
        state: "merged",
        head: manifest.revisions.currentHead,
      });
      const telemetry = fs
        .readFileSync(process.env.BS_QUALITY_TELEMETRY_FILE, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((record) => record.invocationId === manifest.invocationId);
      expect(telemetry).toHaveLength(1);
      expect(telemetry[0]).toMatchObject({
        terminalState: "merged",
        githubRepository: FIXTURE_REPOSITORY,
        recordClass: "fixture",
      });
      expect(
        fs.existsSync(lease._pathsFor(FIXTURE_REPOSITORY, manifest).mergeGuard),
      ).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("reconciles an exact merged outcome after the campaign worktree was removed", () => {
    const primary = fixture("removed-worktree-primary");
    const campaign = fixture("removed-worktree-campaign", {
      linkedFrom: primary,
      repoKey: primary.repoKey,
      advanceHead: true,
    });
    const owner = lease.acquire(campaign.manifestPath);
    lease.acquireMergeGuard(campaign.manifestPath, owner.token);
    const { manifest } = invocation.loadManifest(campaign.manifestPath);
    git(primary.root, ["worktree", "remove", campaign.root]);
    expect(fs.existsSync(campaign.root)).toBe(false);
    expect(() => lease.verify(campaign.manifestPath, owner.token)).toThrow(
      /ENOENT/,
    );

    const bin = path.join(sandbox, "removed-worktree-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
printf '%s\n' '${JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-08-06T12:00:00Z",
        mergeCommit: { oid: "b".repeat(40) },
        headRefName: manifest.repo.headRefName,
        headRefOid: manifest.revisions.currentHead,
        baseRefName: "main",
      })}'
`,
      { mode: 0o700 },
    );
    const reconcileEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    };
    delete reconcileEnv.BS_QUALITY_REPOSITORY_LEASE_TOKEN;

    expect(
      JSON.parse(
        execFileSync(
          "node",
          [
            LEASE_CLI,
            "reconcile-merge",
            "--manifest",
            campaign.manifestPath,
            "--confirm-owner-invocation-id",
            manifest.invocationId,
            "--confirm-owner-pr",
            String(manifest.repo.pr),
          ],
          { encoding: "utf8", env: reconcileEnv },
        ),
      ),
    ).toMatchObject({ reconciled: true, outcome: "merged" });
    expect(lease.status(campaign.manifestPath)).toEqual({
      required: true,
      state: "missing",
    });
    expect(
      invocation.loadManifest(campaign.manifestPath).manifest.terminalState,
    ).toMatchObject({
      state: "merged",
      head: manifest.revisions.currentHead,
    });
  });

  it("reclaims a durably released lease after a cleanup crash", () => {
    const first = fixture("released-cleanup-crash");
    const owner = lease.acquire(first.manifestPath);
    const { manifest } = invocation.loadManifest(first.manifestPath);
    const paths = lease._pathsFor(FIXTURE_REPOSITORY, manifest);
    lease.acquireMergeGuard(first.manifestPath, owner.token);
    const record = JSON.parse(
      fs.readFileSync(path.join(paths.lease, "owner.json"), "utf8"),
    );
    record.disposition = "released";
    record.releaseReason = "verified-remote-merged";
    fs.writeFileSync(
      path.join(paths.lease, "owner.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );

    const second = fixture("released-cleanup-successor", {
      linkedFrom: first,
      repoKey: first.repoKey,
      advanceHead: true,
    });
    const successor = lease.acquire(second.manifestPath, { waitMs: 0 });
    expect(successor.generation).toBe(1);
    expect(
      invocation.loadManifest(first.manifestPath).manifest.terminalState,
    ).toMatchObject({ state: "merged", head: manifest.revisions.currentHead });
    lease.release(second.manifestPath, successor.token, "test-complete");
    expect(owner.token).not.toBe(successor.token);
  });

  it("reports a late manifest mutation after release as released", () => {
    const { manifestPath } = fixture("late-mutation");
    const owner = lease.acquire(manifestPath);
    lease.release(manifestPath, owner.token, "test-complete");
    const previous = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = owner.token;
    try {
      expect(() => invocation.withManifestLock(manifestPath, () => {})).toThrow(
        /missing or has already been released/,
      );
    } finally {
      if (previous === undefined)
        delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
      else process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = previous;
    }
  });

  it("does not reclaim an unverified released lease with a merge guard", () => {
    const first = fixture("unverified-release-guard");
    const owner = lease.acquire(first.manifestPath);
    lease.acquireMergeGuard(first.manifestPath, owner.token);
    const { manifest } = invocation.loadManifest(first.manifestPath);
    const paths = lease._pathsFor(FIXTURE_REPOSITORY, manifest);
    const record = JSON.parse(
      fs.readFileSync(path.join(paths.lease, "owner.json"), "utf8"),
    );
    record.disposition = "released";
    record.releaseReason = "provider-incomplete";
    fs.writeFileSync(
      path.join(paths.lease, "owner.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    const second = fixture("unverified-release-successor", {
      linkedFrom: first,
      repoKey: first.repoKey,
      advanceHead: true,
    });
    expect(() => lease.acquire(second.manifestPath, { waitMs: 0 })).toThrow(
      /quarantined/,
    );
    record.disposition = "active";
    fs.writeFileSync(
      path.join(paths.lease, "owner.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    lease.releaseMergeGuard(first.manifestPath, owner.token, "not-started");
    lease.release(first.manifestPath, owner.token, "test-complete");
  });

  it("uses a non-force exact ref update for protected non-strict green CI mode", () => {
    const candidate = fixture("protected-nonstrict-refcas");
    const base = git(candidate.root, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(candidate.root, "candidate.txt"), "candidate\n");
    git(candidate.root, ["add", "candidate.txt"]);
    git(candidate.root, ["commit", "-q", "-m", "fix: candidate"]);
    const head = git(candidate.root, ["rev-parse", "HEAD"]);
    invocation.withManifestLockRaw(candidate.manifestPath, (manifest) => {
      manifest.revisions.baseSha = base;
      manifest.revisions.baseHeadSha = base;
      manifest.revisions.initialHead = head;
      manifest.revisions.currentHead = head;
    });
    const { manifest } = invocation.loadManifest(candidate.manifestPath);
    const owner = lease.acquire(candidate.manifestPath);
    const bin = path.join(sandbox, "protected-nonstrict-refcas-bin");
    const calls = path.join(bin, "calls.log");
    const mutated = path.join(bin, "mutated");
    fs.mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  printf '%s refs/heads/main\\n' '${base}'
  exit 0
fi
if [ "$1" = "merge-base" ]; then exit 0; fi
exec '${realGit}' "$@"
`,
      { mode: 0o700 },
    );
    const protection = {
      url: "https://api.github.test/protection",
      required_status_checks: {
        url: "https://api.github.test/checks",
        strict: false,
        contexts: ["quality"],
        contexts_url: "https://api.github.test/contexts",
        checks: [{ context: "quality", app_id: 15368 }],
      },
      required_signatures: {
        url: "https://api.github.test/signatures",
        enabled: false,
      },
      enforce_admins: {
        url: "https://api.github.test/admins",
        enabled: false,
      },
      required_linear_history: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      required_conversation_resolution: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: false },
    };
    const digest =
      require("../quality-protected-nonstrict").classifyProtectedNonstrict({
        protection,
        effectiveRules: [],
        reviewThreads: null,
        repositoryAdmin: true,
      }).digest;
    attachRefCasCapability(
      candidate.manifestPath,
      digest,
      [{ context: "quality", appId: 15368 }],
      { includeOutage: false, includeMissingReview: true },
    );
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  *"branches/main/protection"*) printf '%s\\n' '${JSON.stringify(protection)}' ;;
  *"rules/branches/main"*) printf '%s\\n' '[]' ;;
  *"--method PATCH"*"git/refs/heads/main"*)
    body="$(cat)"
    printf '%s\\n' "$body" >> '${calls}'
    printf 'HTTP/2 200 OK\\ncontent-type: application/json\\n\\n%s\\n' '{"ref":"refs/heads/main","object":{"sha":"${head}"}}'
    : > '${mutated}' ;;
  *"pr view"*)
    if [ -f '${mutated}' ]; then
      printf '%s\\n' '${JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-08-21T12:00:00Z",
        mergeCommit: { oid: head },
        headRefName: manifest.repo.headRefName,
        headRefOid: head,
        baseRefName: "main",
      })}'
    else
      printf '%s\\n' '${JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        headRefName: manifest.repo.headRefName,
        headRefOid: head,
        baseRefName: "main",
      })}'
    fi ;;
  *"git/ref/heads/main"*) printf '%s\\n' '{"object":{"sha":"${head}"}}' ;;
  *"compare/${head}...${head}"*) printf '%s\\n' '{"status":"identical"}' ;;
  *"api repos/${FIXTURE_REPOSITORY}"*) printf '%s\\n' '{"permissions":{"admin":true}}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    const priorPath = process.env.PATH;
    process.env.PATH = `${bin}:${priorPath}`;
    try {
      expect(
        lease.performMerge(candidate.manifestPath, owner.token, {
          admin: true,
          expectedHead: head,
          mode: "protected-nonstrict-ref-cas",
          protectionDigest: digest,
        }),
      ).toMatchObject({ merged: true });
      const log = fs.readFileSync(calls, "utf8");
      expect(log).toContain("--method PATCH");
      expect(log).toContain(`"sha":"${head}"`);
      expect(log).toContain('"force":false');
      expect(log).not.toContain("pr merge");
      expect(lease.status(candidate.manifestPath)).toEqual({
        required: true,
        state: "missing",
      });
    } finally {
      process.env.PATH = priorPath;
    }
  });

  it("authorizes protected non-strict ref-CAS from complete autonomous green evidence", () => {
    const head = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const digest = "d".repeat(64);
    const requiredChecks = [
      { context: "build", appId: 15368 },
      { context: "quality", appId: 15368 },
    ];
    expect(
      lease._autonomousRefCasAuthority(
        {
          merge: { invalidatedStamps: [] },
          risk: {
            mergeAuthority: "autonomous",
            mergeAuthorityBaseSha: baseSha,
            protectedNonstrictRefCas: "accept-non-atomic-pr-state",
            protectedNonstrictRefCasBaseSha: baseSha,
          },
          revisions: { baseHeadSha: baseSha },
        },
        { admin: true, protectionDigest: digest },
        head,
        {
          inspection: { digest, requiredChecks },
          authorization: { reviewStatus: "complete" },
          checkStates: [
            { context: "quality", appId: 15368, state: "success" },
            { context: "build", appId: 15368, state: "success" },
          ],
          basePolicy: {
            baseSha,
            mergeAuthority: "autonomous",
            protectedNonstrictRefCas: "accept-non-atomic-pr-state",
          },
        },
      ),
    ).toMatchObject({
      authority: "autonomous-green",
      mode: "protected-nonstrict-ref-cas",
      protectionDigest: digest,
      requiredChecks,
      ciEvidenceSha256: null,
    });
  });

  it("treats reordered but identical check bindings as unchanged at mutation", () => {
    const digest = "d".repeat(64);
    const quality = { context: "quality", appId: 15368 };
    const build = { context: "build", appId: 15368 };
    expect(
      lease._refCasProtectionMatches(
        { digest, requiredChecks: [quality, build] },
        {
          mode: "protected-nonstrict-ref-cas",
          protectionDigest: digest,
          requiredChecks: [build, quality],
        },
        { protectionDigest: digest, requiredChecks: [quality, build] },
      ),
    ).toBe(true);
    expect(
      lease._refCasProtectionMatches(
        { digest, requiredChecks: [quality, build] },
        {
          mode: "protected-nonstrict-ref-cas",
          protectionDigest: digest,
          requiredChecks: [build, quality],
        },
        {
          protectionDigest: digest,
          requiredChecks: [quality, { ...build, appId: 12345 }],
        },
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "human-required merge authority",
      manifest: { risk: { mergeAuthority: "human-required" } },
      authorization: { reviewStatus: "complete" },
      checkState: "success",
    },
    {
      name: "missing repository cancellation-risk acceptance",
      manifest: { risk: { mergeAuthority: "autonomous" } },
      authorization: { reviewStatus: "complete" },
      checkState: "success",
    },
    {
      name: "operator review override",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      },
      authorization: { reviewStatus: "incomplete", operatorOverride: true },
      checkState: "success",
    },
    {
      name: "legacy review evidence without explicit status",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      },
      authorization: {},
      checkState: "success",
    },
    {
      name: "failed required CI",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      },
      authorization: { reviewStatus: "complete" },
      checkState: "failed",
    },
    {
      name: "changed protection digest",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      },
      authorization: { reviewStatus: "complete" },
      checkState: "success",
      requestedDigest: "e".repeat(64),
    },
    {
      name: "missing authorizer protection digest",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      },
      authorization: { reviewStatus: "complete" },
      checkState: "success",
      requestedDigest: null,
    },
    {
      name: "changed required check App binding",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      },
      authorization: { reviewStatus: "complete" },
      checkState: "success",
      checkAppId: 12345,
    },
    {
      name: "stamp commit mutation",
      manifest: {
        risk: {
          mergeAuthority: "autonomous",
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
        merge: { stampHead: "b".repeat(40) },
      },
      authorization: { reviewStatus: "complete" },
      checkState: "success",
    },
  ])("keeps $name outside autonomous ref-CAS authority", (scenario) => {
    const digest = "d".repeat(64);
    const baseSha = "b".repeat(40);
    const policyAccepted =
      scenario.manifest.risk?.protectedNonstrictRefCas ===
      "accept-non-atomic-pr-state";
    expect(() =>
      lease._autonomousRefCasAuthority(
        {
          ...scenario.manifest,
          risk: {
            ...scenario.manifest.risk,
            mergeAuthorityBaseSha:
              scenario.manifest.risk?.mergeAuthority === "autonomous"
                ? baseSha
                : undefined,
            protectedNonstrictRefCasBaseSha: policyAccepted
              ? baseSha
              : undefined,
          },
          revisions: { baseHeadSha: baseSha },
          merge: {
            invalidatedStamps: [],
            ...(scenario.manifest.merge || {}),
          },
        },
        {
          admin: true,
          protectionDigest:
            scenario.requestedDigest === undefined
              ? digest
              : scenario.requestedDigest,
        },
        "a".repeat(40),
        {
          inspection: {
            digest,
            requiredChecks: [{ context: "quality", appId: 15368 }],
          },
          authorization: scenario.authorization,
          checkStates: [
            {
              context: "quality",
              appId: scenario.checkAppId || 15368,
              state: scenario.checkState,
            },
          ],
          basePolicy: {
            baseSha,
            mergeAuthority: "autonomous",
            protectedNonstrictRefCas: "accept-non-atomic-pr-state",
          },
        },
      ),
    ).toThrow(/complete exact-head review, green CI/);
  });

  it("rejects acceptance introduced only by the candidate head", () => {
    const baseSha = "b".repeat(40);
    const digest = "d".repeat(64);
    expect(() =>
      lease._autonomousRefCasAuthority(
        {
          merge: { invalidatedStamps: [] },
          revisions: { baseHeadSha: baseSha },
          risk: {
            mergeAuthority: "autonomous",
            mergeAuthorityBaseSha: baseSha,
            protectedNonstrictRefCas: "accept-non-atomic-pr-state",
            protectedNonstrictRefCasBaseSha: baseSha,
          },
        },
        { admin: true, protectionDigest: digest },
        "a".repeat(40),
        {
          inspection: {
            digest,
            requiredChecks: [{ context: "quality", appId: 15368 }],
          },
          authorization: { reviewStatus: "complete" },
          checkStates: [{ context: "quality", appId: 15368, state: "success" }],
          basePolicy: {
            baseSha,
            mergeAuthority: "autonomous",
            protectedNonstrictRefCas: "signed-only",
          },
        },
      ),
    ).toThrow(/complete exact-head review, green CI/);
  });

  it("rejects an invalid ref-CAS capability without acquiring a merge guard", () => {
    const candidate = fixture("refcas-invalid-capability");
    const { manifest } = invocation.loadManifest(candidate.manifestPath);
    attachRefCasCapability(
      candidate.manifestPath,
      "c".repeat(64),
      [{ context: "quality", appId: 15368 }],
      { includeOutage: false },
    );
    invocation.withManifestLockRaw(candidate.manifestPath, (locked) => {
      locked.approval.protectedNonstrictProtectionDigest = "d".repeat(64);
    });
    const owner = lease.acquire(candidate.manifestPath);
    expect(() =>
      lease.performMerge(candidate.manifestPath, owner.token, {
        admin: true,
        expectedHead: manifest.revisions.currentHead,
        mode: "protected-nonstrict-ref-cas",
        protectionDigest: "d".repeat(64),
      }),
    ).toThrow(/valid signed exact-head capability/);
    expect(lease.status(candidate.manifestPath).mergeGuard).toBeNull();
    lease.release(candidate.manifestPath, owner.token, "test-complete");
  });

  it("rejects a manifest binding that differs from the signed capability", () => {
    const candidate = fixture("refcas-tampered-capability");
    const { manifest } = invocation.loadManifest(candidate.manifestPath);
    const signedDigest = "c".repeat(64);
    attachRefCasCapability(candidate.manifestPath, signedDigest, [
      { context: "quality", appId: 15368 },
    ]);
    invocation.withManifestLockRaw(candidate.manifestPath, (locked) => {
      locked.approval.protectedNonstrictProtectionDigest = "d".repeat(64);
    });
    const owner = lease.acquire(candidate.manifestPath);
    expect(() =>
      lease.performMerge(candidate.manifestPath, owner.token, {
        admin: true,
        expectedHead: manifest.revisions.currentHead,
        mode: "protected-nonstrict-ref-cas",
        protectionDigest: "d".repeat(64),
      }),
    ).toThrow(/valid signed exact-head capability/);
    lease.release(candidate.manifestPath, owner.token, "test-complete");
  });

  it("rejects ref-CAS when signed CI outage evidence is removed", () => {
    const candidate = fixture("refcas-missing-ci-evidence");
    const { manifest } = invocation.loadManifest(candidate.manifestPath);
    attachRefCasCapability(candidate.manifestPath, "c".repeat(64), [
      { context: "quality", appId: 15368 },
    ]);
    fs.unlinkSync(path.join(manifest.stateRoot, "ci-billing-waiver.json"));
    const owner = lease.acquire(candidate.manifestPath);
    expect(() =>
      lease.performMerge(candidate.manifestPath, owner.token, {
        admin: true,
        expectedHead: manifest.revisions.currentHead,
        mode: "protected-nonstrict-ref-cas",
      }),
    ).toThrow(/valid signed exact-head capability/);
    lease.release(candidate.manifestPath, owner.token, "test-complete");
  });

  it("keeps the campaign lease resumable after an authoritative stale-base rejection", () => {
    const candidate = fixture("refcas-stale-base-rejection");
    const owner = lease.acquire(candidate.manifestPath);
    lease.acquireMergeGuard(candidate.manifestPath, owner.token, {
      admin: true,
      mode: "protected-nonstrict-ref-cas",
      protectionDigest: "d".repeat(64),
    });
    expect(lease.status(candidate.manifestPath).mergeGuard).toMatchObject({
      mode: "protected-nonstrict-ref-cas",
      protectionDigest: "d".repeat(64),
    });
    lease.releaseMergeGuard(
      candidate.manifestPath,
      owner.token,
      "request-rejected-stale-base",
      { status: 422, message: "Update is not a fast forward" },
    );
    expect(lease.status(candidate.manifestPath)).toMatchObject({
      state: "active",
      owned: true,
      mergeGuard: null,
      mergeIntent: {
        mode: "protected-nonstrict-ref-cas",
      },
      lastRefCasRejection: {
        status: 422,
        message: "Update is not a fast forward",
      },
    });
    expect(() =>
      lease.acquireMergeGuard(candidate.manifestPath, owner.token),
    ).toThrow(/cannot downgrade/);
    expect(
      invocation.loadManifest(candidate.manifestPath).manifest.terminalState,
    ).toBeNull();
    lease.release(candidate.manifestPath, owner.token, "test-complete");
  });
});

describe("idle-only recovery mutation", () => {
  it("rejects a live merge guard before invoking the mutation", () => {
    const { manifestPath } = fixture("idle-recovery-merge-guard");
    const owner = lease.acquire(manifestPath);
    lease.acquireMergeGuard(manifestPath, owner.token);
    let called = false;
    expect(() =>
      lease.withManifestMutation(
        manifestPath,
        owner.token,
        () => {
          called = true;
        },
        { requireIdle: true },
      ),
    ).toThrow(/idle repository/);
    expect(called).toBe(false);
  });

  it("allows the exact idle owner without changing its lease generation", () => {
    const { manifestPath } = fixture("idle-recovery-owner");
    const owner = lease.acquire(manifestPath);
    lease.withManifestMutation(
      manifestPath,
      owner.token,
      (manifest) => {
        manifest.recoveryProbe = true;
      },
      { requireIdle: true },
    );
    const { manifest } = invocation.loadManifest(manifestPath);
    expect(manifest.recoveryProbe).toBe(true);
    expect(manifest.merge.repositoryLease.generation).toBe(owner.generation);
  });
});
