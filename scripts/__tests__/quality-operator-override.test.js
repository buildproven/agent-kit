import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// BUI-575: signed operator override — an accountable final human decision
// that accepts specific, named, diagnosed terminal conditions rather than a
// hidden force-merge switch. These tests exercise the standalone `override`
// verb end-to-end through quality-wrapper.js (the only place that ever mints
// the operator-quality-override scope), the condition taxonomy, and the
// distinct Quality-Override-* merge evidence trailers.

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const INVOCATION = path.join(ROOT, "scripts", "quality-invocation.js");
const BOOTSTRAP = path.join(ROOT, "scripts", "quality-bootstrap.sh");
const RISK = path.join(ROOT, "scripts", "quality-risk-resolve.sh");
const WRAPPER = path.join(ROOT, "scripts", "quality-wrapper.js");
const LEASE = path.join(ROOT, "scripts", "quality-repo-lease.js");
const require = createRequire(import.meta.url);
const invocation = require(INVOCATION);
const lease = require(LEASE);
const taxonomy = require(
  path.join(ROOT, "scripts", "quality-condition-taxonomy.js"),
);
const { prepareDescendantAdvanceAuthorization } = require(WRAPPER);

function recordGateFixtureLocal(manifestPath, name) {
  invocation.withManifestLock(manifestPath, (manifest) => {
    const required = manifest.requiredGates.find((gate) => gate.name === name);
    const log = path.join(path.dirname(manifestPath), `${name}.gate.log`);
    writeFileSync(log, `${name} passed\n`);
    invocation.recordGate(manifest, {
      name,
      source: required.source,
      command: required.command,
      log,
    });
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withoutAmbientGitHubIdentity(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GITHUB_")) delete env[key];
  }
  return env;
}

function repo(label) {
  const root = mkdtempSync(path.join(tmpdir(), `quality-override-${label}-`));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Quality Test"]);
  git(root, ["config", "user.email", "quality@example.com"]);
  writeFileSync(path.join(root, "file.js"), "export const value = 1;\n");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { lint: "true", test: "true", "security:audit": "true" },
    }),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", root]);
  git(root, ["fetch", "-q", "origin", "main"]);
  git(root, ["switch", "-q", "-c", "feature"]);
  writeFileSync(path.join(root, "file.js"), "export const value = 2;\n");
  git(root, ["commit", "-qam", "change"]);
  return root;
}

// quality-target-resolver.js's getRepoForDir requires a GitHub-shaped origin
// remote (BUI-391); this shim intercepts only `remote get-url origin` to
// report one matching the mock `gh`, forwarding every other git subcommand
// through to the real binary.
function githubShimBin(headRefOid, baseRefOid, pr, repository = "owner/repo") {
  const bin = mkdtempSync(path.join(tmpdir(), "quality-override-gh-"));
  const gh = path.join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
if [ "$1 $2" = "pr view" ]; then
  printf '%s\\n' '{"number":${pr},"headRefName":"feature","headRefOid":"${headRefOid}","headRepository":{"nameWithOwner":"${repository}"},"isCrossRepository":false,"baseRefName":"main","baseRefOid":"${baseRefOid}","url":"https://github.com/${repository}/pull/${pr}"}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' '${repository}'
  exit 0
fi
exit 1
`,
  );
  chmodSync(gh, 0o755);
  const gitShim = path.join(bin, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    gitShim,
    `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3 $4 $5" = "remote get-url origin" ]; then
  printf '%s\\n' "https://github.com/owner/repo.git"
  exit 0
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(gitShim, 0o755);
  return bin;
}

function bootstrapWithOverride(
  root,
  bin,
  { pr, head, extraArgv = [], env = {} },
) {
  return spawnSync("node", [WRAPPER, BOOTSTRAP], {
    cwd: root,
    input: JSON.stringify({
      argv: [
        "override",
        "--target-dir",
        root,
        "--pr",
        String(pr),
        "--head",
        head,
        // Deliberately no --level override: the fixture's trivial one-line
        // diff resolves well below high/critical, so no mutation evidence is
        // required and tests can focus on gate/review conditions alone.
        ...extraArgv,
      ],
    }),
    encoding: "utf8",
    env: withoutAmbientGitHubIdentity({
      BREAK_GLASS_APPROVER: "brett",
      CLAUDE_SETUP_ROOT: ROOT,
      PATH: `${bin}:${process.env.PATH}`,
      ...env,
    }),
  });
}

function manifestPathFromStdout(stdout) {
  return stdout
    .split("\n")
    .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
    ?.slice("BS_QUALITY_MANIFEST=".length);
}

describe("quality-condition-taxonomy", () => {
  it("assigns a gate:<name> id to every failing required gate", () => {
    const manifest = {
      revisions: { currentHead: "headsha" },
      requiredGates: [{ name: "lint" }, { name: "security" }, { name: "test" }],
      gates: [{ name: "lint", head: "headsha", status: "success" }],
      risk: { tier: "medium" },
    };
    const conditions = taxonomy.diagnoseConditions(manifest, {});
    const ids = conditions.map((c) => c.id).sort();
    expect(ids).toEqual(["gate:security", "gate:test"]);
    expect(conditions.find((c) => c.id === "gate:security").highRisk).toBe(
      true,
    );
    expect(conditions.find((c) => c.id === "gate:test").highRisk).toBe(true);
  });

  it("flags mutation:missing for high/critical tiers only", () => {
    const highManifest = {
      revisions: { currentHead: "h" },
      requiredGates: [],
      gates: [],
      risk: { tier: "high" },
      mutation: null,
    };
    expect(
      taxonomy.diagnoseConditions(highManifest, {}).map((c) => c.id),
    ).toContain("mutation:missing");
    const lowManifest = { ...highManifest, risk: { tier: "low" } };
    expect(
      taxonomy.diagnoseConditions(lowManifest, {}).map((c) => c.id),
    ).not.toContain("mutation:missing");
  });

  it("assigns review:<reason> and ci:<reason> ids from caller-supplied failure hints", () => {
    const manifest = {
      revisions: { currentHead: "h" },
      requiredGates: [],
      gates: [],
      risk: { tier: "low" },
    };
    const conditions = taxonomy.diagnoseConditions(manifest, {
      reviewFailureReason: "provider-exhaustion",
      ciFailureReason: "failed",
    });
    expect(conditions.map((c) => c.id)).toEqual([
      "review:provider-exhaustion",
      "ci:failed",
    ]);
    expect(conditions.every((c) => typeof c.description === "string")).toBe(
      true,
    );
  });

  it("surfaces exhausted provider coverage without requiring a runner hint", () => {
    const manifest = {
      revisions: { currentHead: "h" },
      requiredGates: [],
      gates: [],
      reviews: [],
      governor: { providerSecondsUsed: 900, providerSecondsLimit: 900 },
      risk: { tier: "low" },
    };
    expect(taxonomy.diagnoseConditions(manifest, {}).map((c) => c.id)).toEqual([
      "review:provider-exhaustion",
    ]);
  });

  it("rejects an accept list missing a diagnosed condition", () => {
    const conditions = [
      { id: "gate:lint", description: "x", highRisk: false },
      { id: "gate:test", description: "y", highRisk: true },
    ];
    expect(() =>
      taxonomy.assertAcceptListComplete(conditions, ["gate:lint"]),
    ).toThrow(/missing diagnosed condition/);
  });

  it("rejects an accept list naming an undiagnosed condition", () => {
    const conditions = [{ id: "gate:lint", description: "x", highRisk: false }];
    expect(() =>
      taxonomy.assertAcceptListComplete(conditions, ["gate:lint", "gate:test"]),
    ).toThrow(/not currently diagnosed/);
  });

  it("accepts an exact match between diagnosed and accepted conditions", () => {
    const conditions = [
      { id: "gate:lint", description: "x", highRisk: false },
      { id: "gate:test", description: "y", highRisk: true },
    ];
    expect(() =>
      taxonomy.assertAcceptListComplete(conditions, ["gate:test", "gate:lint"]),
    ).not.toThrow();
  });

  it("rejects a repeated id in --accept", () => {
    expect(() => taxonomy.parseAcceptList("gate:lint,gate:lint")).toThrow(
      /not repeat/,
    );
  });
});

describe("quality-wrapper override command surface", () => {
  it("requires --reason and --accept for the override verb", () => {
    const { parseApprovalCommand } = require(WRAPPER);
    expect(() =>
      parseApprovalCommand(["override", "--pr", "1", "--head", "a".repeat(40)]),
    ).toThrow(/--reason/);
  });

  it("requires the matching acknowledgement flag for a high-risk accepted condition", () => {
    const { parseApprovalCommand } = require(WRAPPER);
    expect(() =>
      parseApprovalCommand([
        "override",
        "--pr",
        "1",
        "--head",
        "a".repeat(40),
        "--reason",
        "flaky infra",
        "--accept",
        "gate:security",
      ]),
    ).toThrow(/i-understand-security-risk/);
  });

  it("accepts a high-risk condition once the acknowledgement flag is present", () => {
    const { parseApprovalCommand } = require(WRAPPER);
    const parsed = parseApprovalCommand([
      "override",
      "--pr",
      "1",
      "--head",
      "a".repeat(40),
      "--reason",
      "known transient outage, ops accepted",
      "--accept",
      "gate:security",
      "--i-understand-security-risk",
    ]);
    expect(parsed.scope).toBe("operator-quality-override");
    expect(parsed.acceptedConditions).toEqual(["gate:security"]);
    expect(parsed.reason).toMatch(/known transient outage/);
  });

  it("requires an explicit acknowledgement for exhausted provider review", () => {
    const { parseApprovalCommand } = require(WRAPPER);
    const args = [
      "override",
      "--pr",
      "1",
      "--head",
      "a".repeat(40),
      "--reason",
      "provider budget exhausted after deterministic gates passed",
      "--accept",
      "review:provider-exhaustion",
    ];
    expect(() => parseApprovalCommand(args)).toThrow(
      /i-understand-missing-review/,
    );
    expect(() =>
      parseApprovalCommand([...args, "--i-understand-missing-review"]),
    ).not.toThrow();
  });

  it("does not require an acknowledgement flag for a standard-risk condition", () => {
    const { parseApprovalCommand } = require(WRAPPER);
    expect(() =>
      parseApprovalCommand([
        "override",
        "--pr",
        "1",
        "--head",
        "a".repeat(40),
        "--reason",
        "flaky lint runner, verified locally",
        "--accept",
        "gate:lint",
      ]),
    ).not.toThrow();
  });
});

describe("operator override end-to-end", () => {
  it("attaches an override to the explicitly selected existing manifest", () => {
    const root = repo("existing-manifest");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const repository = `vitest/${"a".repeat(16)}`;
    const bin = githubShimBin(head, base, 20, repository);
    const manifest = execFileSync(
      "node",
      [
        INVOCATION,
        "create",
        "--repo",
        root,
        "--base-ref",
        "origin/main",
        "--pr",
        "20",
        "--github-repo",
        repository,
        "--head-ref",
        "feature",
        "--head-repository",
        repository,
        "--cross-repository",
        "false",
        "--merge",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const initialManifest = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(
      path.resolve(
        root,
        git(root, ["rev-parse", "--git-common-dir"]),
        ".quality-vitest-fixture",
      ),
      `${initialManifest.repo.key}\n`,
    );
    const lease = require(
      path.join(ROOT, "scripts", "quality-repo-lease.js"),
    ).acquire(manifest, { waitMs: 0 });
    const previousLeaseToken = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = lease.token;
    try {
      execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
      for (const gate of ["lint", "test", "security"]) {
        recordGateFixtureLocal(manifest, gate);
      }
      invocation.withManifestLock(manifest, (state) => {
        state.risk.tier = "high";
      });
      invocation.recordTerminalState(
        manifest,
        "provider-incomplete",
        "bounded provider failure",
      );
    } finally {
      if (previousLeaseToken === undefined) {
        delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
      } else {
        process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = previousLeaseToken;
      }
    }
    const original = JSON.parse(readFileSync(manifest, "utf8"));

    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: [
          "override",
          "--manifest",
          manifest,
          "--pr",
          "20",
          "--head",
          head,
          "--reason",
          "the exact campaign exhausted mutation capacity",
          "--accept",
          "mutation:missing",
          // Was --i-understand-security-risk: mutation:missing had no
          // acknowledgement of its own, so this fixture borrowed an unrelated
          // flag. It now names the risk the operator is actually accepting
          // (BUI-914).
          "--i-understand-missing-mutation",
          "--i-understand-security-risk",
        ],
      }),
      encoding: "utf8",
      env: withoutAmbientGitHubIdentity({
        BREAK_GLASS_APPROVER: "brett",
        CLAUDE_SETUP_ROOT: ROOT,
        PATH: `${bin}:${process.env.PATH}`,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(manifestPathFromStdout(result.stdout)).toBe(manifest);
    const updated = JSON.parse(readFileSync(manifest, "utf8"));
    expect(updated.invocationId).toBe(original.invocationId);
    expect(updated.stateRoot).toBe(original.stateRoot);
    expect(updated.approval.invocationId).toBe(original.invocationId);
    expect(updated.approval.acceptedConditions).toEqual(["mutation:missing"]);
    expect(updated.terminalState.state).toBe("provider-incomplete");
  }, 120_000);

  it("rejects stale exact-head identity without mutating the selected manifest", () => {
    const root = repo("existing-manifest-stale-head");
    const recordedHead = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const manifest = execFileSync(
      "node",
      [
        INVOCATION,
        "create",
        "--repo",
        root,
        "--base-ref",
        "origin/main",
        "--pr",
        "19",
        "--github-repo",
        "owner/repo",
        "--head-ref",
        "feature",
        "--head-repository",
        "owner/repo",
        "--cross-repository",
        "false",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "descendant"]);
    const liveHead = git(root, ["rev-parse", "HEAD"]);
    const bin = githubShimBin(liveHead, base, 19);
    const before = readFileSync(manifest, "utf8");

    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: [
          "override",
          "--manifest",
          manifest,
          "--pr",
          "19",
          "--head",
          recordedHead,
          "--reason",
          "stale approval must not advance the campaign",
          "--accept",
          "gate:lint,gate:test,gate:security",
          "--i-understand-security-risk",
          "--i-understand-test-risk",
        ],
      }),
      encoding: "utf8",
      env: withoutAmbientGitHubIdentity({
        BREAK_GLASS_APPROVER: "brett",
        CLAUDE_SETUP_ROOT: ROOT,
        PATH: `${bin}:${process.env.PATH}`,
      }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/identity mismatch before manifest resume/);
    expect(readFileSync(manifest, "utf8")).toBe(before);
  }, 120_000);

  it("advances an exhausted merge campaign before exact-new-head override approval", () => {
    const root = repo("exhausted-descendant-merge");
    const repository = "owner/repo-bui709-descendant";
    const manifest = execFileSync(
      "node",
      [
        INVOCATION,
        "create",
        "--repo",
        root,
        "--base-ref",
        "origin/main",
        "--pr",
        "23",
        "--github-repo",
        repository,
        "--head-ref",
        "feature",
        "--head-repository",
        repository,
        "--cross-repository",
        "false",
        "--merge",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const credential = lease.acquire(manifest, { waitMs: 0 });
    const priorToken = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = credential.token;
    const initial = JSON.parse(readFileSync(manifest, "utf8"));
    invocation.withManifestLock(manifest, (state) => {
      invocation.setRisk(state, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(state, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        state.reviews.push({
          status: "incomplete",
          provider: "review-incomplete",
          from: state.revisions.baseSha,
          to: state.revisions.currentHead,
          leadCount: 0,
          artifactDir: path.join(
            path.dirname(manifest),
            `incomplete-review-${attempt}`,
          ),
        });
      }
      state.terminalState = {
        state: "provider-incomplete",
        detail: "retry-exhausted:provider-exhaustion",
        head: state.revisions.currentHead,
        recordedAt: new Date().toISOString(),
      };
    });
    writeFileSync(
      path.join(root, "privacy-fix.js"),
      "export const fixed = true;\n",
    );
    git(root, ["add", "privacy-fix.js"]);
    git(root, ["commit", "-qam", "fix: remediate privacy review"]);
    const descendantHead = git(root, ["rev-parse", "HEAD"]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const directory = path.join(
        path.dirname(manifest),
        `incomplete-review-${attempt}`,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "artifact-inventory.json"),
        JSON.stringify({
          schemaVersion: 1,
          provider: "review-incomplete",
          files: [],
        }),
      );
    }
    const bin = mkdtempSync(path.join(tmpdir(), "quality-descendant-gh-"));
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1 $2" = "pr view" ]; then
  printf '%s\\n' '{"headRefName":"feature","headRefOid":"${descendantHead}","headRepository":{"nameWithOwner":"${repository}"},"isCrossRepository":false}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' '${repository}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);

    try {
      const unsignedAdvance = spawnSync(
        "bash",
        [BOOTSTRAP, "--manifest", manifest],
        {
          cwd: root,
          encoding: "utf8",
          env: withoutAmbientGitHubIdentity({
            BS_QUALITY_APPROVAL_ONLY: "1",
            BS_QUALITY_APPROVAL_EXPECTED_PR: "23",
            BS_QUALITY_APPROVAL_EXPECTED_HEAD: descendantHead,
            BS_QUALITY_APPROVAL_SCOPE: "operator-nonstrict-refcas-override",
            BS_QUALITY_APPROVAL_ACCEPTED_CONDITIONS:
              "review:provider-exhaustion,base:protected-nonstrict,pr:non-atomic-state",
            CLAUDE_SETUP_ROOT: ROOT,
            PATH: `${bin}:${process.env.PATH}`,
          }),
        },
      );
      expect(unsignedAdvance.status).not.toBe(0);
      expect(unsignedAdvance.stderr).toMatch(
        /signed advance pre-authorization/,
      );
      expect(
        JSON.parse(readFileSync(manifest, "utf8")).revisions.currentHead,
      ).toBe(initial.revisions.currentHead);
      const keyPair = generateKeyPairSync("ed25519");
      const challenge = randomBytes(32).toString("hex");
      const publicKey = keyPair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64");
      const advanceAuthorization = prepareDescendantAdvanceAuthorization(
        manifest,
        {
          expectedHead: descendantHead,
          expectedPr: 23,
          scope: "operator-nonstrict-refcas-override",
          reason: "provider review exhausted before the privacy fix",
          acceptedConditions: [
            "review:provider-exhaustion",
            "base:protected-nonstrict",
            "pr:non-atomic-state",
          ],
        },
        { challenge, keyPair, publicKey },
      );
      const advance = spawnSync("bash", [BOOTSTRAP, "--manifest", manifest], {
        cwd: root,
        encoding: "utf8",
        env: withoutAmbientGitHubIdentity({
          BS_QUALITY_APPROVAL_ONLY: "1",
          BS_QUALITY_APPROVAL_EXPECTED_PR: "23",
          BS_QUALITY_APPROVAL_EXPECTED_HEAD: descendantHead,
          BS_QUALITY_APPROVAL_SCOPE: "operator-nonstrict-refcas-override",
          BS_QUALITY_APPROVAL_ACCEPTED_CONDITIONS:
            "review:provider-exhaustion,base:protected-nonstrict,pr:non-atomic-state",
          BS_QUALITY_ADVANCE_AUTHORIZATION_ARTIFACT: advanceAuthorization,
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        }),
      });
      expect(advance.status, advance.stderr).toBe(0);
      const advanced = JSON.parse(readFileSync(manifest, "utf8"));
      expect(advanced.revisions.currentHead).toBe(descendantHead);
      expect(advanced.revisions.exhaustedReviewAdvance).toMatchObject({
        acceptedCondition: "review:provider-exhaustion",
        priorTo: initial.revisions.currentHead,
        head: descendantHead,
      });
      expect(advanced.terminalState.state).toBe("provider-incomplete");
      expect(existsSync(advanceAuthorization)).toBe(true);
      expect(() =>
        invocation.validateDescendantAdvanceAuthorization(
          advanced,
          advanceAuthorization,
          {
            head: descendantHead,
            acceptedConditions: [
              "review:provider-exhaustion",
              "base:protected-nonstrict",
              "pr:non-atomic-state",
            ],
          },
        ),
      ).toThrow(/identity or conditions do not match/);

      for (const gate of ["lint", "test", "security"]) {
        recordGateFixtureLocal(manifest, gate);
      }
      const override = spawnSync("node", [WRAPPER, BOOTSTRAP], {
        cwd: root,
        input: JSON.stringify({
          argv: [
            "override",
            "--manifest",
            manifest,
            "--pr",
            "23",
            "--head",
            descendantHead,
            "--reason",
            "provider review exhausted before the privacy fix; deterministic gates passed at the exact new head",
            "--accept",
            "review:provider-exhaustion",
            "--i-understand-missing-review",
          ],
        }),
        encoding: "utf8",
        env: withoutAmbientGitHubIdentity({
          BREAK_GLASS_APPROVER: "brett",
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        }),
      });
      expect(override.status, override.stderr).toBe(0);
      const approved = JSON.parse(readFileSync(manifest, "utf8"));
      expect(approved.approval.acceptedConditions).toEqual([
        "review:provider-exhaustion",
      ]);
      expect(approved.approval.head).toBe(descendantHead);
    } finally {
      lease.release(manifest, credential.token, "test-complete");
      if (priorToken === undefined)
        delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
      else process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = priorToken;
    }
  }, 120_000);

  it("mints a signed capability bound to reason, accepted conditions, and a short TTL, and produces distinct merge trailers", () => {
    const root = repo("e2e");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = githubShimBin(head, base, 21);

    // Bootstrap never runs gates itself (they are only recorded by explicit
    // quality-run-gate.sh calls later in the skill), so at mint time
    // lint/test/security are all diagnosed as failing — the accept-list must
    // name all three.
    const result = bootstrapWithOverride(root, bin, {
      pr: 21,
      head,
      extraArgv: [
        "--reason",
        "gate flaked in CI, verified locally",
        "--accept",
        "gate:lint,gate:test,gate:security",
        "--i-understand-security-risk",
        "--i-understand-test-risk",
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("operator override approval created");
    expect(result.stdout).toContain(
      "Reason: gate flaked in CI, verified locally",
    );
    expect(result.stdout).toContain(
      "Accepted conditions: gate:lint, gate:test, gate:security",
    );
    // Diagnosis + evidence snapshot is printed before the capability line.
    expect(result.stdout).toContain("QUALITY TERMINAL DIAGNOSIS");
    expect(result.stdout).toContain("OPERATOR OVERRIDE — CONDITIONS TO ACCEPT");
    expect(result.stdout).toContain("gate:lint");

    const manifest = manifestPathFromStdout(result.stdout);
    expect(manifest).toBeTruthy();
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    expect(parsed.approval.scope).toBe("operator-quality-override");
    expect(parsed.approval.reason).toMatch(/gate flaked/);
    expect(parsed.approval.acceptedConditions).toEqual([
      "gate:lint",
      "gate:test",
      "gate:security",
    ]);
    expect(parsed.approval.baseSha).toBe(parsed.revisions.baseSha);

    const issuedAt = Date.parse(parsed.approval.issuedAt);
    const expiresAt = Date.parse(parsed.approval.expiresAt);
    // Default override TTL (900s) is shorter than the standard 3600s default.
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(900_000 + 5_000);

    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    // Every failing gate was named in the accept list, so review-authorization
    // must succeed with none of them ever recorded.

    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }),
    );
    expect(authorization.operatorOverride).toBe(true);
    expect(authorization.overrideReason).toMatch(/gate flaked/);
    expect(authorization.overrideAcceptedConditions).toEqual([
      "gate:lint",
      "gate:test",
      "gate:security",
    ]);
    expect(authorization.overrideApprover).toBe("brett");

    const trailers = execFileSync("node", [INVOCATION, "trailers", manifest], {
      cwd: root,
    }).toString();
    expect(trailers).toContain("Quality-Override: operator-quality-override");
    expect(trailers).toContain(
      "Quality-Override-Reason: gate flaked in CI, verified locally",
    );
    expect(trailers).toContain(
      "Quality-Override-Accepted: gate:lint,gate:test,gate:security",
    );
    expect(trailers).toContain("Quality-Override-Approver: brett");
  }, 120_000);

  it("still requires a gate that was never named in the accepted list, even under an active override", () => {
    const root = repo("partial-accept");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = githubShimBin(head, base, 22);

    // Every currently-diagnosed condition must be named for the capability
    // to mint at all — so an operator who only wants to accept lint/test
    // must first make security genuinely pass (recording real evidence),
    // not merely omit it from --accept.
    const bootstrapOnly = execFileSync(
      "node",
      [
        INVOCATION,
        "create",
        "--repo",
        root,
        "--base-ref",
        "origin/main",
        "--pr",
        "22",
        "--github-repo",
        "owner/repo",
        "--head-ref",
        "feature",
        "--head-repository",
        "owner/repo",
        "--cross-repository",
        "false",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync("bash", [RISK, "--manifest", bootstrapOnly], { cwd: root });
    recordGateFixtureLocal(bootstrapOnly, "security");

    const result = bootstrapWithOverride(root, bin, {
      pr: 22,
      head,
      extraArgv: [
        "--reason",
        "lint and test only, security genuinely passed",
        "--accept",
        "gate:lint,gate:test",
        "--i-understand-test-risk",
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = manifestPathFromStdout(result.stdout);
    expect(manifest).toBe(bootstrapOnly);
    // Security was never accepted, but it also was never diagnosed as
    // failing (real evidence already exists) — merge succeeds because the
    // gate is genuinely satisfied, not because override silently waived it.
    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }),
    );
    expect(authorization.overrideAcceptedConditions).toEqual([
      "gate:lint",
      "gate:test",
    ]);
  }, 120_000);

  it("rejects an --accept list that is missing a diagnosed high-tier condition (multi-condition acknowledgement)", () => {
    const root = repo("multi-condition");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = githubShimBin(head, base, 23);

    // lint/test/security are all diagnosed as failing at mint time; naming
    // only lint (omitting test and security) must be rejected as incomplete.
    const result = bootstrapWithOverride(root, bin, {
      pr: 23,
      head,
      extraArgv: [
        "--reason",
        "partial accept",
        "--accept",
        "gate:lint",
        "--i-understand-security-risk",
        "--i-understand-test-risk",
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing diagnosed condition/);
  }, 120_000);

  it("refuses reuse of an override capability after HEAD drift", () => {
    const root = repo("head-drift");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = githubShimBin(head, base, 24);

    const result = bootstrapWithOverride(root, bin, {
      pr: 24,
      head,
      extraArgv: [
        "--reason",
        "initial accept",
        "--accept",
        "gate:lint,gate:test,gate:security",
        "--i-understand-security-risk",
        "--i-understand-test-risk",
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = manifestPathFromStdout(result.stdout);
    expect(JSON.parse(readFileSync(manifest, "utf8")).approval.scope).toBe(
      "operator-quality-override",
    );

    // Advance HEAD with a new commit — the capability was signed for the old
    // HEAD and must not silently carry forward to the new one.
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "drift"]);
    const drifted = git(root, ["rev-parse", "HEAD"]);
    expect(drifted).not.toBe(head);

    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const after = JSON.parse(readFileSync(manifest, "utf8"));
    expect(after.approval.approved).toBe(false);
  }, 120_000);

  it("expires the capability and refuses reuse after expiry", () => {
    const root = repo("expiry");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = githubShimBin(head, base, 25);

    const result = bootstrapWithOverride(root, bin, {
      pr: 25,
      head,
      extraArgv: [
        "--reason",
        "short-lived accept",
        "--accept",
        "gate:lint,gate:test,gate:security",
        "--i-understand-security-risk",
        "--i-understand-test-risk",
      ],
      // The complete suite can spend more than a second setting up this
      // fixture. Keep the expiry test short while leaving enough time for the
      // capability to be minted before its deliberate expiry check.
      env: { BS_QUALITY_OVERRIDE_APPROVAL_TTL_SECONDS: "5" },
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = manifestPathFromStdout(result.stdout);
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    expect(
      Date.parse(parsed.approval.expiresAt) -
        Date.parse(parsed.approval.issuedAt),
    ).toBeLessThanOrEqual(5000);

    // Sleep past expiry, then confirm approvalValid() reports false.
    const deadline = Date.now() + 5500;
    while (Date.now() < deadline) {
      /* busy-wait a fraction of a second: TTL=1s is intentionally tiny */
    }
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], { cwd: root })
        .status,
    ).toBe(1);
  }, 120_000);

  it("leaves the normal (non-override) approve path and its TTL unchanged", () => {
    const root = repo("normal-unchanged");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = githubShimBin(head, base, 26);

    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: [
          "approve",
          "--target-dir",
          root,
          "--pr",
          "26",
          "--head",
          head,
          "--level",
          "98",
        ],
      }),
      encoding: "utf8",
      env: withoutAmbientGitHubIdentity({
        BREAK_GLASS_APPROVER: "brett",
        CLAUDE_SETUP_ROOT: ROOT,
        PATH: `${bin}:${process.env.PATH}`,
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("break-glass approval created");
    expect(result.stdout).not.toContain("operator override");
    const manifest = manifestPathFromStdout(result.stdout);
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    expect(parsed.approval.scope).toBe("standard");
    expect(parsed.approval.reason).toBeNull();
    expect(parsed.approval.acceptedConditions).toEqual([]);
    const issuedAt = Date.parse(parsed.approval.issuedAt);
    const expiresAt = Date.parse(parsed.approval.expiresAt);
    // Standard TTL default remains 3600s, unaffected by the override default.
    expect(expiresAt - issuedAt).toBeGreaterThan(900_000);
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(3_600_000 + 5_000);
  }, 120_000);
});
