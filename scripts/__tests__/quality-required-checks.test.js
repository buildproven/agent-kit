import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const dispatchKey = generateKeyPairSync("ed25519")
  .privateKey.export({
    type: "pkcs8",
    format: "der",
  })
  .toString("base64");
const SCRIPT = path.resolve(
  import.meta.dirname,
  "../quality-required-checks.js",
);
const quality = require("../quality-invocation.js");
const {
  adoptPersistedDispatch,
  assertChecks,
  checkRuns,
  checkState,
  claimDispatchNonce,
  claimRemoteDispatchNonce,
  cleanupRemoteDispatchClaims,
  ensureChecks,
  inspectChecks,
  isWriteTransportFailure,
  matchingRuns,
  newRequiredChecksMonitor,
  prepareChecks,
  protectedMonitorLifetimeValid,
  removeRejectedDispatch,
  rememberPersistedDispatch,
  requiredChecks,
  trustedSecretCheckState,
} = require("../quality-required-checks.js");

let originalClaimDirectory;
let originalRemoteClaim;
let activeClaimDirectory;

beforeEach(() => {
  originalClaimDirectory = process.env.QUALITY_REVIEW_DISPATCH_CLAIM_DIR;
  originalRemoteClaim = process.env.QUALITY_REVIEW_DISPATCH_REMOTE_CLAIM;
  activeClaimDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "quality-dispatch-claims-"),
  );
  process.env.QUALITY_REVIEW_DISPATCH_CLAIM_DIR = activeClaimDirectory;
  process.env.QUALITY_REVIEW_DISPATCH_REMOTE_CLAIM = "false";
});

afterEach(() => {
  if (originalClaimDirectory === undefined)
    delete process.env.QUALITY_REVIEW_DISPATCH_CLAIM_DIR;
  else process.env.QUALITY_REVIEW_DISPATCH_CLAIM_DIR = originalClaimDirectory;
  if (originalRemoteClaim === undefined)
    delete process.env.QUALITY_REVIEW_DISPATCH_REMOTE_CLAIM;
  else process.env.QUALITY_REVIEW_DISPATCH_REMOTE_CLAIM = originalRemoteClaim;
  fs.rmSync(activeClaimDirectory, { recursive: true, force: true });
});

function fakeGh(
  root,
  sourceRuns,
  targetRuns,
  registeredRuns = targetRuns,
  context = "quality",
) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "dispatch.log");
  const contextJson = JSON.stringify(context);
  const script = `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"strict":true,"contexts":[${contextJson}],"checks":[{"context":${contextJson},"app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *git/ref/heads/main*) printf '%s\\n' '{"object":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '${JSON.stringify({ check_runs: sourceRuns })}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*)
    if [ -f '${log}' ]; then
      printf '%s\\n' '${JSON.stringify({ check_runs: registeredRuns })}'
    else
      printf '%s\\n' '${JSON.stringify({ check_runs: targetRuns })}'
    fi
    ;;
  *actions/workflows/.github%2Fworkflows%2Fsecret-history-scan.yml*) printf '%s\\n' '{"id":77,"path":".github/workflows/secret-history-scan.yml","state":"active"}' ;;
  *actions/workflows/.github%2Fworkflows%2Fharness-gate.yml*) printf '%s\\n' '{"id":77,"path":".github/workflows/harness-gate.yml","state":"active"}' ;;
  *actions/runs/123*) printf '%s\\n' '{"workflow_id":77}' ;;
  *repos/owner/repo/dispatches*)
    body="$(cat)"
    if printf '%s' "$body" | grep -q '"client_payload":"'; then
      echo 'client_payload must be an object' >&2
      exit 2
    fi
    printf '%s %s\\n' "$*" "$body" >> '${log}'
    ;;
  *actions/workflows/77/dispatches*) printf '%s\\n' "$*" >> '${log}' ;;
  *actions/runs*) printf '%s\\n' '{"total_count":0,"workflow_runs":[]}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;
  const executable = path.join(bin, "gh");
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return { bin, log };
}

function run(root, args, fixture) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY: dispatchKey,
    },
  });
}

describe("quality-required-checks", () => {
  it("adopts the winning persisted nonce after a concurrent intent race", () => {
    const common = {
      workflowId: 77,
      transport: "repository_dispatch",
      requirement: { context: "harness-summary", appId: 15368 },
    };
    const winner = { ...common, nonce: "a".repeat(32) };
    const loser = { ...common, nonce: "b".repeat(32) };

    expect(adoptPersistedDispatch(winner, loser)).toBe(winner);
  });

  it("does not let final wait accept a protected run with another nonce", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-bound-wait-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const expectedExternalId = `secret-history-scan:${"b".repeat(40)}:${"c".repeat(40)}:${"a".repeat(32)}`;
    const otherExternalId = `secret-history-scan:${"b".repeat(40)}:${"c".repeat(40)}:${"b".repeat(32)}`;
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"secret-history-scan","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *commits/${"b".repeat(40)}/check-runs*) printf '%s\\n' '${JSON.stringify({ check_runs: [{ id: 2, name: "secret-history-scan", status: "completed", conclusion: "success", app: { id: 15368 }, external_id: otherExternalId, details_url: "https://github.com/o/r/actions/runs/124" }] })}' ;;
  *git/ref/heads/main*) printf '%s\\n' '{"object":{"sha":"${"c".repeat(40)}"}}' ;;
  *actions/runs/124*) printf '%s\\n' '${JSON.stringify({ workflow_id: 77, event: "repository_dispatch", head_branch: "main", head_sha: "c".repeat(40), path: ".github/workflows/secret-history-scan.yml", display_title: otherExternalId, status: "completed", conclusion: "success" })}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    const requirements = [{ context: "secret-history-scan", appId: 15368 }];
    const monitor = {
      repository: "owner/repo",
      base: "main",
      targetHead: "b".repeat(40),
      baseHead: "c".repeat(40),
      requirements,
      startedAt: 1000,
      deadline: 1000 + 900 * 1000,
      dispatches: [
        {
          requirement: {
            ...requirements[0],
            externalId: expectedExternalId,
          },
          workflowId: 77,
          transport: "repository_dispatch",
          nonce: "a".repeat(32),
        },
      ],
    };
    try {
      expect(inspectChecks("owner/repo", "main", "b".repeat(40))[0].state).toBe(
        "success",
      );
      expect(
        inspectChecks("owner/repo", "main", "b".repeat(40), monitor)[0].state,
      ).toBe("missing");
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores shared-workflow deduplication from a persisted dispatch", () => {
    const dispatchedWorkflowIds = new Set();

    rememberPersistedDispatch(dispatchedWorkflowIds, {
      workflowId: 77,
      transport: "repository_dispatch",
    });

    expect(dispatchedWorkflowIds).toEqual(new Set(["77:repository_dispatch"]));
  });

  it("rejects a persisted protected monitor longer than 15 minutes", () => {
    const requirements = [{ context: "harness-summary", appId: 15368 }];

    expect(
      protectedMonitorLifetimeValid(
        { startedAt: 1000, deadline: 1000 + 900 * 1000 },
        requirements,
      ),
    ).toBe(true);
    expect(
      protectedMonitorLifetimeValid(
        { startedAt: 1000, deadline: 1001 + 900 * 1000 },
        requirements,
      ),
    ).toBe(false);
  });

  it("builds a maximum monitor deadline from one clock reading", () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1001);

    const monitor = newRequiredChecksMonitor(
      { targetHead: "b".repeat(40) },
      [{ context: "harness-summary", appId: 15368 }],
      "c".repeat(40),
      900,
    );

    expect(monitor.deadline - monitor.startedAt).toBe(900 * 1000);
    expect(clock).toHaveBeenCalledTimes(1);
    clock.mockRestore();
  });

  it("keeps accepted registration pending beyond 30 seconds within the head deadline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-delayed-"));
    const source = [
      {
        id: 1,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        details_url: "https://github.com/owner/repo/actions/runs/123",
      },
    ];
    const fixture = fakeGh(root, source, [], []);
    const executable = path.join(fixture.bin, "gh");
    const original = fs.readFileSync(executable, "utf8");
    let now = 0;
    const previousPath = process.env.PATH;
    process.env.PATH = `${fixture.bin}:${previousPath}`;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Atomics, "wait").mockImplementation(
      (_array, _index, _value, duration) => {
        now += duration;
        if (now >= 70000) {
          fs.writeFileSync(
            executable,
            original.replace(
              JSON.stringify({ check_runs: [] }),
              JSON.stringify({ check_runs: source }),
            ),
          );
        }
        return "timed-out";
      },
    );
    try {
      const result = ensureChecks({
        repository: "owner/repo",
        base: "main",
        sourceHead: "a".repeat(40),
        targetHead: "b".repeat(40),
        headRef: "feature/fix",
        timeoutSeconds: 900,
      });
      expect(result.dispatched).toHaveLength(1);
      expect(now).toBeGreaterThan(60000);
      expect(
        fs.readFileSync(fixture.log, "utf8").trim().split("\n"),
      ).toHaveLength(1);
    } finally {
      process.env.PATH = previousPath;
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("prepares protected dispatches without mutating GitHub", () => {
    const originalPath = process.env.PATH;
    const originalKey = process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-prepare-"));
    const fixture = fakeGh(
      root,
      [
        {
          id: 1,
          name: "secret-history-scan",
          status: "completed",
          conclusion: "success",
          app: { id: 15368 },
          details_url: "https://github.com/o/r/actions/runs/123",
        },
      ],
      [],
      [],
      "secret-history-scan",
    );
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    try {
      delete process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY;
      expect(() =>
        prepareChecks({
          repository: "owner/repo",
          base: "main",
          sourceHead: "a".repeat(40),
          targetHead: "b".repeat(40),
        }),
      ).toThrow(/private key/);

      process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY = dispatchKey;
      expect(
        prepareChecks({
          repository: "owner/repo",
          base: "main",
          sourceHead: "a".repeat(40),
          targetHead: "b".repeat(40),
        }).dispatches,
      ).toEqual([
        {
          context: "secret-history-scan",
          workflowId: 77,
          transport: "repository_dispatch",
        },
      ]);
      expect(fs.existsSync(fixture.log)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      if (originalKey === undefined)
        delete process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY;
      else process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY = originalKey;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a registered failed check as requiring new budgeted dispatch", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-prepare-"));
    const sourceRun = {
      id: 1,
      name: "quality",
      status: "completed",
      conclusion: "success",
      app: { id: 15368 },
      details_url: "https://github.com/o/r/actions/runs/123",
    };
    const failedRun = {
      ...sourceRun,
      id: 2,
      conclusion: "failure",
    };
    const fixture = fakeGh(root, [sourceRun], [failedRun], [failedRun]);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    try {
      expect(
        prepareChecks({
          repository: "owner/repo",
          base: "main",
          sourceHead: "a".repeat(40),
          targetHead: "b".repeat(40),
        }).dispatches,
      ).toEqual([
        {
          context: "quality",
          workflowId: 77,
          transport: "workflow_dispatch",
        },
      ]);
      expect(fs.existsSync(fixture.log)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("claims each repository dispatch nonce durably before sending it", () => {
    const fields = {
      repository: "owner/repo",
      eventType: "secret-history-scan",
      head: "b".repeat(40),
      base: "c".repeat(40),
      nonce: "0".repeat(32),
    };
    const claim = claimDispatchNonce(fields);
    expect(fs.readFileSync(claim.claimPath, "utf8")).toContain(
      claim.externalId,
    );
    expect(() => claimDispatchNonce(fields)).toThrow(/already been claimed/);
  });

  it("uses an atomic Git ref as the cross-host dispatch claim", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-ref-claim-"));
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        'case "$*" in',
        "  *buildproven-dispatch-claim-v3-meta*) printf '%s\\n' '{}' ;;",
        "  *buildproven-dispatch-claim-v3*)",
        `    if [ -f '${calls}' ]; then`,
        "      echo 'gh: Reference already exists (HTTP 422)' >&2",
        "      exit 1",
        "    fi",
        `    : > '${calls}'`,
        "    printf '%s\\n' '{}' ;;",
        '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const externalId = `secret-history-scan:${"b".repeat(40)}`;
      const claim = claimRemoteDispatchNonce(
        "owner/repo",
        "secret-history-scan",
        "b".repeat(40),
        externalId,
      );
      expect(claim).toMatch(
        /^refs\/tags\/buildproven-dispatch-claim-v3\/[0-9a-f]{64}$/,
      );
      expect(() =>
        claimRemoteDispatchNonce(
          "owner/repo",
          "secret-history-scan",
          "b".repeat(40),
          externalId,
        ),
      ).toThrow(/already been claimed remotely/);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("cleans expired metadata and quarantines legacy claim refs", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "quality-claim-cleanup-"),
    );
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const oldSuffix = "a".repeat(64);
    const legacySuffix = "b".repeat(64);
    const issuedAtSeconds = "1577836800";
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *matching-refs*) printf '%s\\n' '${JSON.stringify([
    [
      {
        ref: `refs/tags/buildproven-dispatch-claim-v3-meta/${oldSuffix}/${issuedAtSeconds}`,
        object: { type: "commit", sha: "e".repeat(40) },
      },
      {
        ref: `refs/tags/buildproven-dispatch-claim/${legacySuffix}`,
        object: { type: "commit", sha: "f".repeat(40) },
      },
    ],
  ])}' ;;
  *DELETE*refs/tags/refs/tags/*) echo "unexpected duplicated ref prefix" >&2; exit 1 ;;
  *DELETE*buildproven-dispatch-claim-v3/${oldSuffix}*) printf '%s\\n' '{}' ;;
  *DELETE*repos/owner/repo/git/refs/tags/buildproven-dispatch-claim-v3-meta/${oldSuffix}/${issuedAtSeconds}*) printf '%s\\n' '{}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        cleanupRemoteDispatchClaims("owner/repo", {
          retentionMs: 1_000,
          now: Date.parse("2020-01-02T00:00:00Z"),
        }),
      ).toEqual({ deleted: 1, metadataDeleted: 1, retained: 0, skipped: 1 });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("paginates effective rules before deriving required checks", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-rules-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      type: "non_required_rule",
      id: index + 1,
    }));
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"contexts":[],"checks":[]}' ;;
  *rules/branches/main*"page=2"*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"security","integration_id":15368}]}}]' ;;
  *rules/branches/main*"page=1"*) printf '%s\\n' '${JSON.stringify(firstPage)}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(requiredChecks("owner/repo", "main")).toEqual([
        { context: "security", appId: 15368 },
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("uses complete GraphQL branch protection when REST discovery is unavailable", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "quality-graphql-rules-"),
    );
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*)
    echo '{"message":"service unavailable"}' >&2
    exit 1
    ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *graphql*)
    printf '%s\\n' '{"data":{"repository":{"branchProtectionRules":{"pageInfo":{"hasNextPage":false},"nodes":[{"requiredStatusChecks":[{"context":"quality","app":{"databaseId":15368}}],"matchingRefs":{"pageInfo":{"hasNextPage":false},"nodes":[{"name":"main"}]}}]}}}}'
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(requiredChecks("owner/repo", "main")).toEqual([
        { context: "quality", appId: 15368 },
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps effective ruleset checks when GraphQL proves no classic rule", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "quality-graphql-empty-"),
    );
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) exit 1 ;;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"security","integration_id":15368}]}}]' ;;
  *graphql*) printf '%s\\n' '{"data":{"repository":{"branchProtectionRules":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(requiredChecks("owner/repo", "main")).toEqual([
        { context: "security", appId: 15368 },
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("paginates exact-head check runs through GitHub total_count", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *"&page=2"*) printf '%s\\n' '{"total_count":2,"check_runs":[{"id":2,"name":"quality"}]}' ;;
  *"&page=1"*) printf '%s\\n' '{"total_count":2,"check_runs":[{"id":1,"name":"first"}]}' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        checkRuns("owner/repo", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").map(
          (run) => run.id,
        ),
      ).toEqual([1, 2]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("allows ordinary check registration before attempting dispatch", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const count = path.join(root, "target-count");
    const dispatch = path.join(root, "dispatch");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"quality","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '{"check_runs":[{"id":1,"name":"quality","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123"}]}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*)
    if [ -f '${count}' ]; then
      printf '%s\\n' '{"check_runs":[{"id":2,"name":"quality","status":"queued","conclusion":null,"app":{"id":15368}}]}'
    else
      : > '${count}'
      printf '%s\\n' '{"check_runs":[]}'
    fi
    ;;
  *dispatches*) cat > '${dispatch}' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const result = ensureChecks({
        repository: "owner/repo",
        base: "main",
        sourceHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        targetHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        headRef: "feature/fix",
        registrationSeconds: 1,
        registrationIntervalSeconds: 0,
      });
      expect(result.dispatched).toEqual([]);
      expect(fs.existsSync(dispatch)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("fails closed when one protection source cannot be read", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const gh = path.join(bin, "gh");
    fs.writeFileSync(
      gh,
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"contexts":["quality"],"checks":[]}' ;;
  *rules/branches/main*) echo 'gh: API rate limit exceeded (HTTP 403)' >&2; exit 1 ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(() => requiredChecks("owner/repo", "main")).toThrow(
        /API rate limit exceeded/,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("combines classic protection and effective ruleset requirements", () => {
    const calls = [];
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const gh = path.join(bin, "gh");
    fs.writeFileSync(
      gh,
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"contexts":[],"checks":[{"context":"quality","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"security","integration_id":15368}]}}]' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      calls.push(...requiredChecks("owner/repo", "main"));
    } finally {
      process.env.PATH = originalPath;
    }
    expect(calls).toEqual([
      { context: "quality", appId: 15368 },
      { context: "security", appId: 15368 },
    ]);
  });

  it("uses only the newest check from the required GitHub App", () => {
    const requirement = { context: "quality", appId: 15368 };
    const runs = [
      {
        id: 4,
        name: "quality",
        status: "completed",
        conclusion: "failure",
        app: { id: 15368 },
      },
      {
        id: 3,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
      },
      {
        id: 9,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 1 },
      },
    ];
    expect(matchingRuns(runs, requirement).map((run) => run.id)).toEqual([
      4, 3,
    ]);
    expect(checkState(runs, requirement)).toMatchObject({ state: "failed" });
  });

  it("accepts only a successful protected run bound to the exact nonce", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *actions/runs/124*) printf '%s\\n' '{"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","path":".github/workflows/secret-history-scan.yml","display_title":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","status":"completed","conclusion":"success"}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        trustedSecretCheckState({
          repository: "owner/repo",
          runs: [
            {
              id: 2,
              name: "secret-history-scan",
              status: "completed",
              conclusion: "success",
              app: { id: 15368 },
              external_id:
                "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef",
              details_url: "https://github.com/o/r/actions/runs/124",
            },
          ],
          requirement: {
            context: "secret-history-scan",
            appId: 15368,
          },
          workflowId: 77,
          base: "main",
          targetHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          baseHead: "cccccccccccccccccccccccccccccccccccccccc",
        }),
      ).toMatchObject({ state: "success" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves a GitHub-rewritten check URL through one exact workflow run", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const externalId =
      "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef";
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *actions/workflows/77/runs*) printf '%s\\n' '${JSON.stringify({ total_count: 1, workflow_runs: [{ id: 124, workflow_id: 77, event: "repository_dispatch", head_branch: "main", head_sha: "c".repeat(40), path: ".github/workflows/secret-history-scan.yml", display_title: externalId, status: "completed", conclusion: "success" }] })}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        trustedSecretCheckState({
          repository: "owner/repo",
          runs: [
            {
              id: 2,
              name: "secret-history-scan",
              status: "completed",
              conclusion: "success",
              app: { id: 15368 },
              external_id: externalId,
              details_url: "https://github.com/owner/repo/runs/2",
            },
          ],
          requirement: {
            context: "secret-history-scan",
            appId: 15368,
            externalId,
          },
          workflowId: 77,
          base: "main",
          targetHead: "b".repeat(40),
          baseHead: "c".repeat(40),
        }),
      ).toMatchObject({ state: "success" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("carries the persisted workflow binding into final check assertion", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const targetHead = "b".repeat(40);
    const baseHead = "c".repeat(40);
    const externalId = `secret-history-scan:${targetHead}:${baseHead}:${"a".repeat(32)}`;
    const workflowRun = {
      id: 124,
      workflow_id: 77,
      event: "repository_dispatch",
      head_branch: "main",
      head_sha: baseHead,
      path: ".github/workflows/secret-history-scan.yml",
      display_title: externalId,
      status: "completed",
      conclusion: "success",
    };
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"secret-history-scan","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *git/ref/heads/main*) printf '%s\\n' '{"object":{"sha":"${baseHead}"}}' ;;
  *commits/${targetHead}/check-runs*) printf '%s\\n' '${JSON.stringify({ check_runs: [{ id: 2, name: "secret-history-scan", status: "completed", conclusion: "success", app: { id: 15368 }, external_id: externalId, details_url: "https://github.com/owner/repo/runs/2" }] })}' ;;
  *actions/workflows/77/runs*) printf '%s\\n' '${JSON.stringify({ total_count: 1, workflow_runs: [workflowRun] })}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    const requirements = [{ context: "secret-history-scan", appId: 15368 }];
    const monitor = {
      schemaVersion: 1,
      repository: "owner/repo",
      base: "main",
      sourceHead: targetHead,
      targetHead,
      headRef: "feature/fix",
      baseHead,
      requirements,
      startedAt: Date.now(),
      deadline: Date.now() + 60_000,
      dispatches: [
        {
          requirement: { ...requirements[0], externalId },
          workflowId: 77,
          transport: "repository_dispatch",
          nonce: "a".repeat(32),
        },
      ],
    };
    try {
      expect(
        assertChecks("owner/repo", "main", targetHead, monitor)[0],
      ).toMatchObject({
        state: "success",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects rewritten check URLs with ambiguous workflow-run matches", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const externalId =
      "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef";
    const workflowRun = {
      workflow_id: 77,
      event: "repository_dispatch",
      head_branch: "main",
      head_sha: "c".repeat(40),
      path: ".github/workflows/secret-history-scan.yml",
      display_title: externalId,
      status: "completed",
      conclusion: "success",
    };
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *actions/workflows/77/runs*) printf '%s\\n' '${JSON.stringify({
    total_count: 2,
    workflow_runs: [
      { ...workflowRun, id: 124 },
      { ...workflowRun, id: 125 },
    ],
  })}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        trustedSecretCheckState({
          repository: "owner/repo",
          runs: [
            {
              id: 2,
              name: "secret-history-scan",
              status: "completed",
              conclusion: "success",
              app: { id: 15368 },
              external_id: externalId,
              details_url: "https://github.com/owner/repo/runs/2",
            },
          ],
          requirement: {
            context: "secret-history-scan",
            appId: 15368,
            externalId,
          },
          workflowId: 77,
          base: "main",
          targetHead: "b".repeat(40),
          baseHead: "c".repeat(40),
        }),
      ).toMatchObject({ state: "missing" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects a forged success when the protected workflow failed", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *actions/runs/124*) printf '%s\\n' '{"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","path":".github/workflows/secret-history-scan.yml","display_title":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","status":"completed","conclusion":"failure"}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        trustedSecretCheckState({
          repository: "owner/repo",
          runs: [
            {
              id: 2,
              name: "secret-history-scan",
              status: "completed",
              conclusion: "success",
              app: { id: 15368 },
              external_id:
                "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef",
              details_url: "https://github.com/o/r/actions/runs/124",
            },
          ],
          requirement: {
            context: "secret-history-scan",
            appId: 15368,
            externalId:
              "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef",
          },
          workflowId: 77,
          base: "main",
          targetHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          baseHead: "cccccccccccccccccccccccccccccccccccccccc",
        }),
      ).toMatchObject({ state: "failed" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps a correlated in-progress protected run pending", () => {
    const originalPath = process.env.PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *actions/runs/124*) printf '%s\\n' '{"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","path":".github/workflows/secret-history-scan.yml","display_title":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","status":"in_progress","conclusion":null}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      expect(
        trustedSecretCheckState({
          repository: "owner/repo",
          runs: [
            {
              id: 2,
              name: "secret-history-scan",
              status: "queued",
              conclusion: null,
              app: { id: 15368 },
              external_id:
                "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef",
              details_url: "https://github.com/o/r/actions/runs/124",
            },
          ],
          requirement: {
            context: "secret-history-scan",
            appId: 15368,
            externalId:
              "secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef",
          },
          workflowId: 77,
          base: "main",
          targetHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          baseHead: "cccccccccccccccccccccccccccccccccccccccc",
        }),
      ).toMatchObject({ state: "pending" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reuses an existing protected success instead of dispatching again", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const dispatch = path.join(root, "dispatch");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"secret-history-scan","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '{"check_runs":[{"id":1,"name":"secret-history-scan","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123"}]}' ;;
  *git/ref/heads/main*) printf '%s\\n' '{"object":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*) printf '%s\\n' '{"check_runs":[{"id":2,"name":"secret-history-scan","status":"completed","conclusion":"success","app":{"id":15368},"external_id":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","details_url":"https://github.com/o/r/actions/runs/124"}]}' ;;
  *actions/workflows/.github%2Fworkflows%2Fsecret-history-scan.yml*) printf '%s\\n' '{"id":77,"path":".github/workflows/secret-history-scan.yml","state":"active"}' ;;
  *actions/runs/123*) printf '%s\\n' '{"workflow_id":77}' ;;
  *actions/runs/124*) printf '%s\\n' '{"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","path":".github/workflows/secret-history-scan.yml","display_title":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","status":"completed","conclusion":"success"}' ;;
  *dispatches*) cat > '${dispatch}'; exit 1 ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      { bin },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).dispatched).toEqual([]);
    expect(fs.existsSync(dispatch)).toBe(false);
  });

  it("refreshes a protected scan when the base advances during preparation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const dispatch = path.join(root, "dispatch");
    const baseReads = path.join(root, "base-reads");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"secret-history-scan","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *git/ref/heads/main*)
    reads=0
    [ -f '${baseReads}' ] && reads="$(cat '${baseReads}')"
    reads=$((reads + 1))
    printf '%s' "$reads" > '${baseReads}'
    if [ "$reads" -eq 1 ]; then
      printf '%s\\n' '{"object":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}'
    else
      printf '%s\\n' '{"object":{"sha":"dddddddddddddddddddddddddddddddddddddddd"}}'
    fi
    ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '{"check_runs":[{"id":1,"name":"secret-history-scan","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123"}]}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*)
    if [ -f '${dispatch}' ]; then
      nonce="$(sed -n 's/.*"nonce":"\\([0-9a-f]*\\)".*/\\1/p' '${dispatch}')"
      printf '%s\\n' '{"check_runs":[{"id":3,"name":"secret-history-scan","status":"completed","conclusion":"success","app":{"id":15368},"external_id":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:dddddddddddddddddddddddddddddddddddddddd:'"$nonce"'","details_url":"https://github.com/o/r/actions/runs/125"}]}'
    else
      printf '%s\\n' '{"check_runs":[{"id":2,"name":"secret-history-scan","status":"completed","conclusion":"success","app":{"id":15368},"external_id":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","details_url":"https://github.com/o/r/actions/runs/124"}]}'
    fi
    ;;
  *actions/workflows/.github%2Fworkflows%2Fsecret-history-scan.yml*) printf '%s\\n' '{"id":77,"path":".github/workflows/secret-history-scan.yml","state":"active"}' ;;
  *actions/runs/123*) printf '%s\\n' '{"workflow_id":77}' ;;
  *actions/runs/124*) printf '%s\\n' '{"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","path":".github/workflows/secret-history-scan.yml","display_title":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccccccccccc:0123456789abcdef0123456789abcdef","status":"completed","conclusion":"success"}' ;;
  *actions/runs/125*)
    nonce="$(sed -n 's/.*"nonce":"\\([0-9a-f]*\\)".*/\\1/p' '${dispatch}')"
    printf '%s\\n' '{"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"dddddddddddddddddddddddddddddddddddddddd","path":".github/workflows/secret-history-scan.yml","display_title":"secret-history-scan:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:dddddddddddddddddddddddddddddddddddddddd:'"$nonce"'","status":"completed","conclusion":"success"}'
    ;;
  *dispatches*) cat > '${dispatch}';;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      { bin },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).dispatched).toEqual([
      { context: "secret-history-scan", workflowId: 77 },
    ]);
    expect(fs.readFileSync(dispatch, "utf8")).toContain(
      '"base_sha":"dddddddddddddddddddddddddddddddddddddddd"',
    );
  });

  it("dispatches the reviewed-head workflow when an empty stamp has no check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const sourceRuns = [
      {
        id: 1,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        details_url: "https://github.com/o/r/actions/runs/123/job/456",
      },
    ];
    const fixture = fakeGh(
      root,
      sourceRuns,
      [],
      [
        {
          id: 2,
          name: "quality",
          status: "queued",
          conclusion: null,
          app: { id: 15368 },
        },
      ],
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      fixture,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).dispatched).toEqual([
      { context: "quality", workflowId: 77 },
    ]);
    expect(fs.readFileSync(fixture.log, "utf8")).toContain(
      "actions/workflows/77/dispatches -f ref=feature/fix",
    );
  });

  it("dispatches the secret scan through the default-branch repository event", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const sourceRuns = [
      {
        id: 1,
        name: "secret-history-scan",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        details_url: "https://github.com/o/r/actions/runs/123/job/456",
      },
    ];
    const fixture = fakeGh(
      root,
      sourceRuns,
      [],
      [
        {
          id: 2,
          name: "secret-history-scan",
          status: "queued",
          conclusion: null,
          app: { id: 15368 },
        },
      ],
      "secret-history-scan",
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/did not register on stamp/);
    const dispatch = fs.readFileSync(fixture.log, "utf8");
    expect(dispatch).toContain(
      'api --method POST repos/owner/repo/dispatches --input - {"event_type":"secret-history-scan","client_payload":{"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","base_sha":"cccccccccccccccccccccccccccccccccccccccc","nonce":"',
    );
    expect(dispatch).toMatch(/"nonce":"[0-9a-f]{32}"/);
  });

  it("does not treat an unrelated repository-dispatch run as registration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const fixture = fakeGh(
      root,
      [
        {
          id: 1,
          name: "secret-history-scan",
          status: "completed",
          conclusion: "success",
          app: { id: 15368 },
          details_url: "https://github.com/o/r/actions/runs/123/job/456",
        },
      ],
      [],
      [],
      "secret-history-scan",
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/did not register on stamp/);
  });

  it("maps a required workflow from reviewed first-parent history", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const fixture = fakeGh(
      root,
      [],
      [],
      [
        {
          id: 3,
          name: "quality",
          status: "queued",
          conclusion: null,
          app: { id: 15368 },
        },
      ],
    );
    fs.writeFileSync(
      path.join(fixture.bin, "git"),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa cccccccccccccccccccccccccccccccccccccccc
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fixture.bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"quality","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '{"check_runs":[]}' ;;
  *commits/cccccccccccccccccccccccccccccccccccccccc/check-runs*) printf '%s\\n' '{"check_runs":[{"id":1,"name":"quality","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123/job/456"}]}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*)
    if [ -f '${fixture.log}' ]; then
      printf '%s\\n' '{"check_runs":[{"id":3,"name":"quality","status":"queued","conclusion":null,"app":{"id":15368}}]}'
    else
      printf '%s\\n' '{"check_runs":[]}'
    fi
    ;;
  *actions/runs/123*) printf '%s\\n' '{"workflow_id":77}' ;;
  *actions/workflows/77/dispatches*) printf '%s\\n' "$*" >> '${fixture.log}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      fixture,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).dispatched).toEqual([
      { context: "quality", workflowId: 77 },
    ]);
  });

  it("resolves a protected controller before an exact source workflow", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash
set -eu
printf '%s\n' ${Array.from({ length: 100 }, (_, index) =>
        (index + 1).toString(16).padStart(40, "0"),
      ).join(" ")}
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> '${calls}'
case "$*" in
  *protection/required_status_checks*) printf '%s\n' '{"checks":[{"context":"secret-history-scan","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\n' '[]' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\n' '{"total_count":1,"check_runs":[{"id":1,"name":"secret-history-scan","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123/job/456"}]}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*) printf '%s\n' '{"total_count":0,"check_runs":[]}' ;;
  *actions/runs/123*) printf '%s\n' '{"workflow_id":999}' ;;
  *git/ref/heads/main*) printf '%s\n' '{"object":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *actions/workflows/.github%2Fworkflows%2Fsecret-history-scan.yml*) printf '%s\n' '{"id":77,"path":".github/workflows/secret-history-scan.yml","state":"active"}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "prepare",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      { bin },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).dispatches).toEqual([
      {
        context: "secret-history-scan",
        workflowId: 77,
        transport: "repository_dispatch",
      },
    ]);
    const callLog = fs.readFileSync(calls, "utf8");
    expect(callLog).toContain(
      "actions/workflows/.github%2Fworkflows%2Fsecret-history-scan.yml",
    );
    expect(callLog).not.toContain("actions/runs/123");
    expect(callLog).not.toMatch(/commits\/0{39}[1-9a-f]\/check-runs/);
  });

  it("bounds the historical fallback independently of repository depth", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash
set -eu
printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ${Array.from(
        { length: 99 },
        (_, index) => (index + 1).toString(16).padStart(40, "0"),
      ).join(" ")}
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> '${calls}'
case "$*" in
  *protection/required_status_checks*) printf '%s\n' '{"checks":[{"context":"quality","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\n' '[]' ;;
  *check-runs*) printf '%s\n' '{"total_count":0,"check_runs":[]}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "prepare",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      { bin },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot map required check 'quality'");
    const ancestorCalls = fs
      .readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => /commits\/0{39}[1-9a-f]\/check-runs/.test(line));
    expect(ancestorCalls).toHaveLength(3);
  });

  it("fails quickly when a dispatched required context never registers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const sourceRuns = [
      {
        id: 1,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        details_url: "https://github.com/o/r/actions/runs/123/job/456",
      },
    ];
    const fixture = fakeGh(root, sourceRuns, [], []);
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      fixture,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("quality (workflow 77)");
    expect(result.stderr).toContain(
      "did not register on stamp bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("fails closed when a protected workflow does not register its check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const dispatch = path.join(root, "dispatch.json");
    fs.mkdirSync(bin);
    const gh = path.join(bin, "gh");
    fs.writeFileSync(
      gh,
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"harness-summary","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '{"check_runs":[{"id":1,"name":"harness-summary","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123/job/456"}]}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*) printf '%s\\n' '{"check_runs":[]}' ;;
  *actions/workflows/.github%2Fworkflows%2Fharness-gate.yml*) printf '%s\\n' '{"id":77,"path":".github/workflows/harness-gate.yml","state":"active"}' ;;
  *actions/runs/123*) printf '%s\\n' '{"workflow_id":77}' ;;
  *git/ref/heads/main*) printf '%s\\n' '{"object":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *dispatches*) cat > '${dispatch}' ;;
  *actions/runs*) printf '%s\\n' '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","status":"in_progress"}]}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      { bin },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not register on stamp");
    expect(JSON.parse(fs.readFileSync(dispatch, "utf8"))).toMatchObject({
      event_type: "harness-summary",
      client_payload: { head_sha: "b".repeat(40) },
    });
  });

  it("fails when an exact-head workflow completes without publishing its required check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const bin = path.join(root, "bin");
    const dispatch = path.join(root, "dispatch.json");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *protection/required_status_checks*) printf '%s\\n' '{"checks":[{"context":"harness-summary","app_id":15368}]}' ;;
  *rules/branches/main*) printf '%s\\n' '[]' ;;
  *commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs*) printf '%s\\n' '{"check_runs":[{"id":1,"name":"harness-summary","status":"completed","conclusion":"success","app":{"id":15368},"details_url":"https://github.com/o/r/actions/runs/123/job/456"}]}' ;;
  *commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs*) printf '%s\\n' '{"check_runs":[]}' ;;
  *actions/workflows/.github%2Fworkflows%2Fharness-gate.yml*) printf '%s\\n' '{"id":77,"path":".github/workflows/harness-gate.yml","state":"active"}' ;;
  *actions/runs/123*) printf '%s\\n' '{"workflow_id":77}' ;;
  *git/ref/heads/main*) printf '%s\\n' '{"object":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *dispatches*) cat > '${dispatch}' ;;
  *actions/runs*) printf '%s\\n' '{"total_count":1,"workflow_runs":[{"id":124,"workflow_id":77,"event":"repository_dispatch","head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","status":"completed","conclusion":"success"}]}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      { bin },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not register on stamp");
    expect(JSON.parse(fs.readFileSync(dispatch, "utf8"))).toMatchObject({
      event_type: "harness-summary",
      client_payload: { head_sha: "b".repeat(40) },
    });
  });

  it("asserts exact-head success without relying on PR check rollups", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-checks-"));
    const targetRuns = [
      {
        id: 2,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
      },
    ];
    const fixture = fakeGh(root, [], targetRuns);
    const result = run(
      root,
      [
        "assert",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--head",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      fixture,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)[0]).toMatchObject({
      context: "quality",
      appId: 15368,
      state: "success",
    });
  });
});

describe("required-check transport failures", () => {
  it("classifies only ambiguous POST transport failures as uncertain", () => {
    const args = ["api", "--method", "POST", "repos/owner/repo/dispatches"];
    expect(
      isWriteTransportFailure(args, {
        status: 1,
        stderr: "error connecting to api.github.com",
      }),
    ).toBe(true);
    expect(
      isWriteTransportFailure(args, {
        status: 1,
        stderr: "gh: upstream timed out (HTTP 504)",
      }),
    ).toBe(true);
    expect(
      isWriteTransportFailure(args, {
        status: 1,
        stderr: "proxy closed the response stream after request upload",
      }),
    ).toBe(true);
    for (const stderr of [
      "gh: Bad credentials (HTTP 401)",
      "gh: Resource not accessible (HTTP 403)",
      "gh: Validation Failed (HTTP 422)",
    ]) {
      expect(isWriteTransportFailure(args, { status: 1, stderr })).toBe(false);
    }
  });

  it("removes only the creator-owned intended dispatch after rejection", () => {
    const entry = {
      requirement: { context: "quality", appId: 15368 },
      workflowId: 77,
      transport: "workflow_dispatch",
      nonce: null,
      status: "intended",
      issuedAt: 1000,
      expiresAt: 2000,
    };
    const monitor = { dispatches: [structuredClone(entry)] };
    removeRejectedDispatch(monitor, entry);
    expect(monitor.dispatches).toEqual([]);

    for (const changed of [
      { ...entry, nonce: "different" },
      { ...entry, status: "accepted" },
      { ...entry, expiresAt: entry.expiresAt + 1 },
    ]) {
      const protectedMonitor = { dispatches: [changed] };
      expect(() => removeRejectedDispatch(protectedMonitor, entry)).toThrow(
        /intent changed/,
      );
      expect(protectedMonitor.dispatches).toEqual([changed]);
    }
  });

  it("removes a definite rejection so the same monitor can dispatch after credentials recover", () => {
    const root = activeClaimDirectory;
    const sourceRuns = [
      {
        id: 1,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        details_url: "https://github.com/o/r/actions/runs/123",
      },
    ];
    const registeredRuns = [
      {
        id: 2,
        name: "quality",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
      },
    ];
    const fixture = fakeGh(root, sourceRuns, [], registeredRuns);
    const executable = path.join(fixture.bin, "gh");
    const successfulScript = fs.readFileSync(executable, "utf8");
    fs.writeFileSync(
      executable,
      successfulScript.replace(
        `*actions/workflows/77/dispatches*) printf '%s\\n' "$*" >> '${fixture.log}' ;;`,
        `*actions/workflows/77/dispatches*) echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1 ;;`,
      ),
    );
    const manifest = {
      repo: {
        realpath: root,
        githubRepository: "owner/repo",
        headRefName: "feature/fix",
      },
      revisions: {
        currentHead: "a".repeat(40),
        baseRef: "origin/main",
      },
      merge: { stampHead: "b".repeat(40) },
    };
    const withManifestLock = vi
      .spyOn(quality, "withManifestLock")
      .mockImplementation((_manifestPath, callback) => {
        callback(manifest);
        return structuredClone(manifest);
      });
    const validateIdentity = vi
      .spyOn(quality, "validateIdentity")
      .mockImplementation(() => {});
    const originalPath = process.env.PATH;
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const request = {
      repository: "owner/repo",
      base: "main",
      sourceHead: "a".repeat(40),
      targetHead: "b".repeat(40),
      headRef: "feature/fix",
      registrationSeconds: 0,
      manifestPath: "fixture-manifest",
      timeoutSeconds: 900,
    };
    try {
      expect(() => ensureChecks(request)).toThrow(/Bad credentials/);
      expect(manifest.merge.requiredChecksMonitor.dispatches).toEqual([]);

      fs.writeFileSync(executable, successfulScript);
      expect(ensureChecks(request).dispatched).toEqual([
        { context: "quality", workflowId: 77 },
      ]);
      expect(manifest.merge.requiredChecksMonitor.dispatches).toMatchObject([
        { status: "accepted", workflowId: 77 },
      ]);
    } finally {
      process.env.PATH = originalPath;
      withManifestLock.mockRestore();
      validateIdentity.mockRestore();
    }
  });

  it("reconciles an unknown protected POST failure without replacing its nonce", () => {
    const root = activeClaimDirectory;
    const sourceRuns = [
      {
        id: 1,
        name: "harness-summary",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        details_url: "https://github.com/o/r/actions/runs/123",
      },
    ];
    const fixture = fakeGh(root, sourceRuns, [], [], "harness-summary");
    const executable = path.join(fixture.bin, "gh");
    const attempts = path.join(root, "post-attempts");
    fs.writeFileSync(
      executable,
      fs.readFileSync(executable, "utf8").replace(
        `*repos/owner/repo/dispatches*)`,
        `*repos/owner/repo/dispatches*)
    printf 'attempt\\n' >> '${attempts}'
    echo 'proxy closed the response stream after request upload' >&2
    exit 1
    ;;
  *unused-repository-dispatch*)`,
      ),
    );
    const manifest = {
      repo: {
        realpath: root,
        githubRepository: "owner/repo",
        headRefName: "feature/fix",
      },
      revisions: {
        currentHead: "a".repeat(40),
        baseRef: "origin/main",
      },
      merge: { stampHead: "b".repeat(40) },
    };
    const withManifestLock = vi
      .spyOn(quality, "withManifestLock")
      .mockImplementation((_manifestPath, callback) => {
        callback(manifest);
        return structuredClone(manifest);
      });
    const validateIdentity = vi
      .spyOn(quality, "validateIdentity")
      .mockImplementation(() => {});
    const originalPath = process.env.PATH;
    const originalSigningKey = process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY;
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY = dispatchKey;
    const request = {
      repository: "owner/repo",
      base: "main",
      sourceHead: "a".repeat(40),
      targetHead: "b".repeat(40),
      headRef: "feature/fix",
      registrationSeconds: 0,
      registrationIntervalSeconds: 0,
      manifestPath: "fixture-manifest",
      timeoutSeconds: 1,
    };
    try {
      expect(() => ensureChecks(request)).toThrow(/deadline expired/);
      const [intent] = manifest.merge.requiredChecksMonitor.dispatches;
      expect(intent).toMatchObject({
        status: "intended",
        transport: "repository_dispatch",
        requirement: {
          context: "harness-summary",
          appId: 15368,
          externalId: expect.stringMatching(
            new RegExp(`^harness-summary:${"b".repeat(40)}:${"c".repeat(40)}:`),
          ),
        },
      });
      expect(intent.nonce).toMatch(/^[0-9a-f]{32}$/);

      expect(() => ensureChecks(request)).toThrow(/deadline expired/);
      expect(manifest.merge.requiredChecksMonitor.dispatches).toEqual([intent]);
      expect(fs.readFileSync(attempts, "utf8").trim()).toBe("attempt");
    } finally {
      process.env.PATH = originalPath;
      if (originalSigningKey === undefined)
        delete process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY;
      else process.env.QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY = originalSigningKey;
      withManifestLock.mockRestore();
      validateIdentity.mockRestore();
    }
  });

  it.each([
    ["error connecting to api.github.com", 75, 2],
    ["read tcp: connection reset by peer", 75, 2],
    ['Get "https://api.github.com/repos/owner/repo": unexpected EOF', 75, 2],
    ["internal parser failure: unexpected EOF", 1, 1],
    ["gh: Bad credentials (HTTP 401)", 1, 1],
    ["gh: API rate limit exceeded (HTTP 403)", 1, 1],
    ["internal parser failure", 1, 1],
  ])(
    "classifies %s without retrying authority errors",
    (message, status, attempts) => {
      const root = activeClaimDirectory;
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      const log = path.join(root, "calls");
      fs.writeFileSync(
        path.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
process.stderr.write(${JSON.stringify(message)});
process.exit(1);
`,
        { mode: 0o755 },
      );
      const result = run(
        root,
        [
          "prepare",
          "--repo",
          "owner/repo",
          "--base",
          "main",
          "--source-head",
          "a".repeat(40),
          "--head",
          "b".repeat(40),
        ],
        { bin },
      );
      expect(result.status, result.stderr).toBe(status);
      expect(
        fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter((call) => call.includes("protection/required_status_checks")),
      ).toHaveLength(attempts);
    },
  );

  it("completes the same GET after one transport failure", () => {
    const root = activeClaimDirectory;
    const fixture = fakeGh(
      root,
      [],
      [
        {
          id: 2,
          name: "quality",
          status: "completed",
          conclusion: "success",
          app: { id: 15368 },
        },
      ],
    );
    const executable = path.join(fixture.bin, "gh");
    const attempts = path.join(root, "read-attempts");
    fs.writeFileSync(
      executable,
      fs.readFileSync(executable, "utf8").replace(
        "set -eu",
        `set -eu
case "$*" in
  *protection/required_status_checks*)
    if [ ! -f '${attempts}' ]; then
      printf 'first\n' > '${attempts}'
      echo 'error connecting to api.github.com' >&2
      exit 1
    fi
    printf 'retry\n' >> '${attempts}'
    ;;
esac`,
      ),
    );
    const result = run(
      root,
      [
        "assert",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--head",
        "b".repeat(40),
      ],
      fixture,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)[0].state).toBe("success");
    expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toEqual([
      "first",
      "retry",
    ]);
  });

  it("does not retry an ambiguous workflow POST transport failure", () => {
    const root = activeClaimDirectory;
    const fixture = fakeGh(
      root,
      [
        {
          id: 1,
          name: "quality",
          status: "completed",
          conclusion: "success",
          app: { id: 15368 },
          details_url: "https://github.com/o/r/actions/runs/123",
        },
      ],
      [],
    );
    const executable = path.join(fixture.bin, "gh");
    const attempts = path.join(root, "post-attempts");
    fs.writeFileSync(
      executable,
      fs.readFileSync(executable, "utf8").replace(
        "set -eu",
        `set -eu
case "$*" in
  *actions/workflows/77/dispatches*)
    printf 'attempt\n' >> '${attempts}'
    echo 'error connecting to api.github.com' >&2
    exit 1
    ;;
esac`,
      ),
    );
    const result = run(
      root,
      [
        "ensure",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--source-head",
        "a".repeat(40),
        "--head",
        "b".repeat(40),
        "--head-ref",
        "feature/fix",
        "--registration-timeout",
        "0",
      ],
      fixture,
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("error connecting to api.github.com");
    expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toEqual([
      "attempt",
    ]);
  });
});
