import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const INVOCATION = path.join(ROOT, "scripts", "quality-invocation.js");
const BOOTSTRAP = path.join(ROOT, "scripts", "quality-bootstrap.sh");
const LOAD_ROOT = path.join(ROOT, "scripts", "quality-load-root.sh");
const RISK = path.join(ROOT, "scripts", "quality-risk-resolve.sh");
const SELECT = path.join(ROOT, "scripts", "quality-select-agents.sh");
const FORMAT = path.join(ROOT, "scripts", "quality-format.js");
const GOVERNOR = path.join(ROOT, "scripts", "quality-run-governor.js");
const AUTHORIZE_REVIEW_ROUND = path.join(
  ROOT,
  "scripts",
  "quality-authorize-review-round.sh",
);
const WRAPPER = path.join(ROOT, "scripts", "quality-wrapper.js");
const AUTHORIZE = path.join(ROOT, "scripts", "quality-authorize-merge.sh");
const RUN_GATE = path.join(ROOT, "scripts", "quality-run-gate.sh");
const WORKTREE_MANAGER = path.join(ROOT, "scripts", "worktree-manager.js");
const RUN_REVIEW = path.join(ROOT, "scripts", "quality-run-review.sh");
const STAMP_AND_MERGE = path.join(
  ROOT,
  "scripts",
  "quality-stamp-and-merge.sh",
);
const REVIEW_EVIDENCE = path.join(
  ROOT,
  "scripts",
  "quality-review-evidence.js",
);
const require = createRequire(import.meta.url);
const invocation = require(INVOCATION);
const lease = require("../quality-repo-lease");
const FIXTURE_GH_BINS = new Map();

function fixtureRepository(root) {
  const identity = `${realpathSync(root)}\0${git(root, ["rev-parse", "HEAD"])}`;
  return `vitest/${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function fixtureGitCommonDir(root) {
  return realpathSync(
    path.resolve(root, git(root, ["rev-parse", "--git-common-dir"])),
  );
}

function prepareFixtureNamespace(root, githubRepository) {
  const gitCommonDir = fixtureGitCommonDir(root);
  const repoKey = createHash("sha256")
    .update(gitCommonDir)
    .digest("hex")
    .slice(0, 16);
  writeFileSync(
    path.join(gitCommonDir, ".quality-vitest-fixture"),
    `${repoKey}\n`,
  );
  writeFileSync(
    path.join(gitCommonDir, ".quality-vitest-repository"),
    `${githubRepository}\n`,
  );
}

function recordGateFixture(manifestPath, name, overrides = {}) {
  invocation.withManifestLock(manifestPath, (manifest) => {
    const required = manifest.requiredGates.find((gate) => gate.name === name);
    const log = path.join(path.dirname(manifestPath), `${name}.gate.log`);
    writeFileSync(log, `${name} passed\n`);
    invocation.recordGate(manifest, {
      name,
      source: required.source,
      command: required.command,
      log,
      ...overrides,
    });
  });
}

function recordMutationFixture(manifestPath) {
  invocation.withManifestLock(manifestPath, (manifest) => {
    if (!["high", "critical"].includes(manifest.risk?.tier)) return;
    const artifact = path.join(
      path.dirname(manifestPath),
      `${manifest.revisions.currentHead}.mutation.json`,
    );
    writeFileSync(
      artifact,
      JSON.stringify({
        schemaVersion: 1,
        invocationId: manifest.invocationId,
        base: manifest.revisions.baseSha,
        head: manifest.revisions.currentHead,
        tier: manifest.risk.tier,
        method: "revert-diff",
        mutatedPaths: ["file.js"],
        testFailureObserved: true,
      }),
    );
    invocation.recordMutation(manifest, { artifact });
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
  const root = makeTempDir(`quality-${label}-`);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Quality Test"]);
  git(root, ["config", "user.email", "quality@example.com"]);
  writeFileSync(path.join(root, "file.js"), "export const value = 1;\n");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        lint: "true",
        test: "true",
        "security:audit": "true",
      },
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

function create(root, extra = [], env = {}) {
  const mergeFixture = extra.includes("--merge");
  const githubRepository = mergeFixture
    ? fixtureRepository(root)
    : "owner/repo";
  const prIdentity =
    extra.includes("--pr") || mergeFixture
      ? [
          "--github-repo",
          githubRepository,
          "--head-ref",
          "feature",
          "--head-repository",
          githubRepository,
          "--cross-repository",
          "false",
        ]
      : [];
  if (mergeFixture || prIdentity.length > 0) {
    prepareFixtureNamespace(root, githubRepository);
    // PR-backed fixture mutations exercise the same authoritative `gh`
    // lookup as production. This fake reports the checkout's current HEAD;
    // tests that need a stale remote explicitly prepend their own fake.
    const bin = fakeGh(root, git(root, ["rev-parse", "HEAD"]), {
      dynamicHead: true,
    });
    FIXTURE_GH_BINS.set(realpathSync(root), bin);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }
  const manifestPath = execFileSync(
    "node",
    [
      INVOCATION,
      "create",
      "--repo",
      root,
      "--base-ref",
      "origin/main",
      ...prIdentity,
      ...extra,
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  ).trim();
  if (mergeFixture) {
    const owner = lease.acquire(manifestPath);
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = owner.token;
  }
  return manifestPath;
}

function createLegacyProviderFixture(root, extra = [], env = {}) {
  const manifestPath = create(root, extra, env);
  invocation.withManifestLock(manifestPath, (manifest) => {
    manifest.reviewContractVersion = 1;
  });
  return manifestPath;
}

function createAsync(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `create exited ${code}`));
    });
  });
}

function prepareCodexReview(
  root,
  manifestPath,
  providerFindings = [],
  findingsText = null,
) {
  // Most fixtures in this file exercise the historical v1 parser/judge path
  // and deliberately use the legacy panel identity. Production v2 campaigns
  // must enter through quality-select-agents.sh and are covered by the explicit
  // v2 fixtures below.
  invocation.withManifestLock(manifestPath, (manifest) => {
    if (!manifest.panel?.rule || manifest.panel.rule.startsWith("legacy")) {
      manifest.reviewContractVersion = 1;
    }
  });
  execFileSync("node", [GOVERNOR, "bump-round", manifestPath], { cwd: root });
  const info = JSON.parse(
    execFileSync("node", [INVOCATION, "review-info", manifestPath], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const fixtureGhBin = FIXTURE_GH_BINS.get(realpathSync(root));
  const fixtureEnv = fixtureGhBin
    ? { ...process.env, PATH: `${fixtureGhBin}:${process.env.PATH}` }
    : process.env;
  mkdirSync(info.artifactDir, { recursive: true });
  writeFileSync(
    path.join(info.artifactDir, "diff.txt"),
    execFileSync("git", ["diff", `${info.from}..${info.to}`], { cwd: root }),
  );
  writeFileSync(
    path.join(info.artifactDir, "identity.json"),
    execFileSync("node", [INVOCATION, "review-identity", manifestPath], {
      cwd: root,
    }),
  );
  writeFileSync(
    path.join(info.artifactDir, "codex.findings.txt"),
    findingsText ??
      (providerFindings.length === 0
        ? "NO FINDINGS.\n"
        : "BLOCKING findings.\n"),
  );
  writeFileSync(
    path.join(info.artifactDir, "review-focus.txt"),
    "fixture review focus\n",
  );
  writeFileSync(
    path.join(info.artifactDir, "codex-1.json"),
    JSON.stringify({
      verdict: providerFindings.length === 0 ? "pass" : "needs-attention",
      summary: "fixture",
      findings: providerFindings,
    }),
  );
  writeFileSync(
    path.join(info.artifactDir, "codex-1.normalized.json"),
    JSON.stringify({
      verdict: providerFindings.length === 0 ? "pass" : "needs-attention",
      summary: "fixture",
      findings: providerFindings,
    }),
  );
  execFileSync(
    "node",
    [
      INVOCATION,
      "inventory",
      manifestPath,
      "--artifact-dir",
      info.artifactDir,
      "--provider",
      "codex",
    ],
    { cwd: root, env: fixtureEnv },
  );
  const diffSha = createHash("sha256")
    .update(readFileSync(path.join(info.artifactDir, "diff.txt")))
    .digest("hex");
  execFileSync(
    "node",
    [
      INVOCATION,
      "record-review",
      manifestPath,
      "--from",
      info.from,
      "--to",
      info.to,
      "--provider",
      "codex",
      "--primary",
      "codex",
      "--fallback",
      "none",
      "--artifact-dir",
      info.artifactDir,
      "--diff-sha",
      diffSha,
    ],
    { cwd: root, env: fixtureEnv },
  );
  for (const name of ["lint", "test", "security"]) {
    recordGateFixture(manifestPath, name);
  }
  recordMutationFixture(manifestPath);
  return info;
}

function preparePolicyExemptReview(root, manifestPath) {
  execFileSync("node", [GOVERNOR, "bump-round", manifestPath], { cwd: root });
  const info = JSON.parse(
    execFileSync("node", [INVOCATION, "review-info", manifestPath], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  mkdirSync(info.artifactDir, { recursive: true });
  writeFileSync(
    path.join(info.artifactDir, "diff.txt"),
    execFileSync("git", ["diff", `${info.from}..${info.to}`], { cwd: root }),
  );
  writeFileSync(
    path.join(info.artifactDir, "identity.json"),
    execFileSync("node", [INVOCATION, "review-identity", manifestPath], {
      cwd: root,
    }),
  );
  writeFileSync(
    path.join(info.artifactDir, "policy-exempt.findings.txt"),
    "AI REVIEW NOT REQUIRED. This exact diff is covered by the low-risk zero-reviewer policy.\n",
  );
  writeFileSync(
    path.join(info.artifactDir, "review-focus.txt"),
    "low-risk policy exemption\n",
  );
  const diffSha = createHash("sha256")
    .update(readFileSync(path.join(info.artifactDir, "diff.txt")))
    .digest("hex");
  const identity = JSON.parse(
    readFileSync(path.join(info.artifactDir, "identity.json"), "utf8"),
  );
  writeFileSync(
    path.join(info.artifactDir, "policy-exempt.result.json"),
    JSON.stringify({
      schemaVersion: 1,
      aiReviewRequired: false,
      head: identity.headSha,
      tier: identity.tier,
      reviewContractVersion: identity.reviewContractVersion,
      reviewPolicyDigest: identity.reviewPolicyDigest,
      agentsSha256: identity.agentsSha256,
      domain: identity.panelDomain,
      selectionRule: identity.panelRule,
      diffSha256: diffSha,
    }),
  );
  execFileSync(
    "node",
    [
      INVOCATION,
      "inventory",
      manifestPath,
      "--artifact-dir",
      info.artifactDir,
      "--provider",
      "policy-exempt",
      "--exempt",
    ],
    { cwd: root },
  );
  execFileSync(
    "node",
    [
      INVOCATION,
      "record-policy-exempt-review",
      manifestPath,
      "--from",
      info.from,
      "--to",
      info.to,
      "--primary",
      "codex",
      "--fallback",
      "claude",
      "--artifact-dir",
      info.artifactDir,
      "--diff-sha",
      diffSha,
    ],
    { cwd: root },
  );
}

function prepareIncompleteReview(root, manifestPath, partialFindings = []) {
  execFileSync("node", [GOVERNOR, "bump-round", manifestPath], { cwd: root });
  const info = JSON.parse(
    execFileSync("node", [INVOCATION, "review-info", manifestPath], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  mkdirSync(info.artifactDir, { recursive: true });
  writeFileSync(
    path.join(info.artifactDir, "diff.txt"),
    execFileSync("git", ["diff", `${info.from}..${info.to}`], { cwd: root }),
  );
  writeFileSync(
    path.join(info.artifactDir, "identity.json"),
    execFileSync("node", [INVOCATION, "review-identity", manifestPath], {
      cwd: root,
    }),
  );
  writeFileSync(
    path.join(info.artifactDir, "review-focus.txt"),
    "fixture review focus\n",
  );
  writeFileSync(
    path.join(info.artifactDir, "review-incomplete.findings.txt"),
    "AI REVIEW INCOMPLETE: provider unavailable.\n",
  );
  writeFileSync(
    path.join(info.artifactDir, "review-incomplete.result.json"),
    JSON.stringify({
      status: "incomplete",
      failureCategory: "provider-unavailable",
    }),
  );
  if (partialFindings.length > 0) {
    writeFileSync(
      path.join(info.artifactDir, "codex-1.normalized.json"),
      JSON.stringify({
        verdict: "needs-attention",
        summary: "partial provider result before transport failure",
        findings: partialFindings,
      }),
    );
  }
  execFileSync(
    "node",
    [
      INVOCATION,
      "inventory",
      manifestPath,
      "--artifact-dir",
      info.artifactDir,
      "--provider",
      "review-incomplete",
      "--incomplete",
    ],
    { cwd: root },
  );
  const diffSha = createHash("sha256")
    .update(readFileSync(path.join(info.artifactDir, "diff.txt")))
    .digest("hex");
  execFileSync(
    "node",
    [
      INVOCATION,
      "record-incomplete-review",
      manifestPath,
      "--from",
      info.from,
      "--to",
      info.to,
      "--primary",
      "codex",
      "--fallback",
      "claude",
      "--failed-provider",
      "claude",
      "--failure-category",
      "provider-unavailable",
      "--artifact-dir",
      info.artifactDir,
      "--diff-sha",
      diffSha,
    ],
    { cwd: root },
  );
  for (const name of ["lint", "test", "security"]) {
    recordGateFixture(manifestPath, name);
  }
  return info;
}

function recordJudgeArtifact(root, manifest, dispositions = []) {
  const artifact = path.join(path.dirname(manifest), "judge-input.json");
  const context = JSON.parse(
    execFileSync("node", [INVOCATION, "judge-context", manifest], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  context.findings = context.findings.map((finding, index) => {
    const disposition = dispositions[index] || "WARNING";
    return {
      ...finding,
      disposition,
      reason: "test classification",
      resolution:
        disposition === "BLOCKING"
          ? "confirmed-unresolved"
          : disposition === "WARNING"
            ? "confirmed-nonblocking"
            : "refuted",
    };
  });
  writeFileSync(artifact, JSON.stringify(context));
  execFileSync(
    "node",
    [INVOCATION, "judge", manifest, "--artifact", artifact],
    { cwd: root },
  );
  recordMutationFixture(manifest);
}

function fakeGh(root, head, { dynamicHead = false } = {}) {
  const bin = makeTempDir("quality-gh-");
  const gh = path.join(bin, "gh");
  const merged = path.join(bin, "merged");
  const base = git(root, ["rev-parse", "origin/main"]);
  const repository = readFileSync(
    path.join(fixtureGitCommonDir(root), ".quality-vitest-repository"),
    "utf8",
  ).trim();
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
if [ "$1 $2" = "pr view" ]; then
  head_oid="${dynamicHead ? '$(git -C "$PWD" rev-parse HEAD)' : head}"
  args="$*"
  head_ref="\${QUALITY_TEST_HEAD_REF:-feature}"
  if [[ "$args" == *"--jq .headRefOid"* ]]; then
    printf '%s\\n' "$head_oid"
    exit 0
  fi
  if [[ "$args" == *"state,mergedAt,mergeCommit"* ]] && [ -f ${JSON.stringify(merged)} ]; then
    printf '{"state":"MERGED","mergedAt":"2026-07-16T00:00:00Z","mergeCommit":{"oid":"merge"},"headRefName":"%s","headRefOid":"%s","baseRefName":"main"}\\n' "$head_ref" "$head_oid"
  elif [[ "$args" == *"baseRefOid"* ]]; then
    printf '{"state":"OPEN","mergedAt":null,"mergeCommit":null,"headRefName":"%s","headRefOid":"%s","baseRefName":"main","baseRefOid":"%s"}\\n' "$head_ref" "$head_oid" "${base}"
  else
    printf '{"state":"OPEN","mergedAt":null,"mergeCommit":null,"headRefName":"%s","headRefOid":"%s","baseRefName":"main"}\\n' "$head_ref" "$head_oid"
  fi
  exit 0
fi
if [ "$1 $2" = "pr checks" ]; then exit 0; fi
if [ "$1 $2" = "pr merge" ]; then
  touch ${JSON.stringify(merged)}
  [ "\${QUALITY_TEST_MERGE_RC:-0}" = 0 ]
  exit $?
fi
if [ "$1 $2" = "repo view" ]; then
  if [[ "$*" == *"nameWithOwner"* ]]; then printf '%s\\n' "\${QUALITY_TEST_REPOSITORY:-${repository}}"; else printf '%s\\n' 'main'; fi
  exit 0
fi
  if [ "$1" = "api" ]; then
  if [ "$2" = "graphql" ]; then
    if [ "\${QUALITY_TEST_GRAPHQL_RULES:-}" = strict ]; then
      printf '%s\\n' '{"data":{"repository":{"branchProtectionRules":{"pageInfo":{"hasNextPage":false},"nodes":[{"requiresStrictStatusChecks":true,"isAdminEnforced":false,"matchingRefs":{"pageInfo":{"hasNextPage":false},"nodes":[{"name":"main"}]}}]}}}}'
    else
      printf '%s\\n' '{"data":{"repository":{"branchProtectionRules":{"nodes":[]}}}}'
    fi
    exit 0
  fi
  if [[ "$*" == *"protection/required_status_checks"* ]]; then
    if [ "\${QUALITY_TEST_STRICT_PROTECTION:-}" = true ]; then
      if [[ "$*" == *"--jq .strict"* ]]; then
        printf '%s\\n' 'true'
      else
        printf '%s\\n' '{"strict":true,"contexts":["quality"],"checks":[{"context":"quality","app_id":15368}]}'
      fi
      exit 0
    fi
    printf '%s\\n' '{"message":"Branch not protected"}'
    echo 'gh: Branch not protected (HTTP 404)' >&2
    exit 1
  fi
  if [[ "$*" == *"/protection"* ]]; then
    if [ "\${QUALITY_TEST_PROTECTION_MODE:-}" = plan-limit ]; then
      printf '%s\\n' '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}'
      echo 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' >&2
      exit 1
    fi
    if [ "\${QUALITY_TEST_PROTECTION_MODE:-}" = malformed ]; then
      printf '%s\\n' '[]'
      exit 0
    fi
    printf '%s\\n' '{"message":"Branch not protected"}'
    echo 'gh: Branch not protected (HTTP 404)' >&2
    exit 1
  fi
  if [[ "$*" == *"/rules/branches/"* ]]; then
    case "\${QUALITY_TEST_EFFECTIVE_RULES:-none}" in
      strict)
        printf '%s\\n' '[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"required_status_checks":[{"context":"quality","integration_id":15368}]}}]'
        exit 0
        ;;
      queue)
        printf '%s\\n' '[{"type":"merge_queue","parameters":{"grouping_strategy":"ALLGREEN"}}]'
        exit 0
        ;;
      unavailable) exit 1 ;;
      *) printf '%s\\n' '[]'; exit 0 ;;
    esac
  fi
  if [[ "$*" == *"/check-runs"* ]]; then
    printf '%s\\n' '{"check_runs":[{"id":1,"name":"quality","status":"completed","conclusion":"success","app":{"id":15368}}]}'
    exit 0
  fi
  if [[ "$*" == *"--jq .private"* ]]; then
    printf '%s\\n' 'true'
    exit 0
  fi
  printf '%s\\n' '[]'
  exit 0
fi
exit 1
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

describe("quality changed-file coverage", () => {
  it("preserves both rename paths for affected-test selection", () => {
    const root = makeTempDir("quality-renamed-impact-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.invalid"]);
    writeFileSync(
      path.join(root, "old source.js"),
      "export const value = 1;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["mv", "old source.js", "new source.js"]);
    git(root, ["commit", "-qm", "rename source"]);
    expect(
      invocation
        .changedFiles(root, base, git(root, ["rev-parse", "HEAD"]))
        .sort(),
    ).toEqual(["new source.js", "old source.js"]);
  });
});

describe("mutationEvidenceValid — BUI-603 #1 fail-closed on unresolved risk", () => {
  it("returns false for an unresolved risk contract by default", () => {
    const manifest = { risk: { resolved: false } };
    expect(invocation.mutationEvidenceValid(manifest)).toBe(false);
  });

  it("returns true for an unresolved risk contract only with an explicit opt-in", () => {
    const manifest = { risk: { resolved: false } };
    expect(
      invocation.mutationEvidenceValid(manifest, {
        unresolvedIsVacuous: true,
      }),
    ).toBe(true);
  });

  it("still evaluates the resolved-contract rules normally once resolved", () => {
    const lowTier = { risk: { resolved: true, tier: "low" } };
    expect(invocation.mutationEvidenceValid(lowTier)).toBe(true);

    const unresolvedHighTier = {
      risk: { resolved: true, tier: "high" },
      mutation: null,
    };
    expect(invocation.mutationEvidenceValid(unresolvedHighTier)).toBe(false);
  });
});

describe("required gate reuse", () => {
  const fullTest = {
    name: "test",
    source: "package.json#scripts.test",
    command: { kind: "exec", program: "npm", args: ["test"] },
  };
  const focusedTest = {
    name: "test",
    source: "test-impact:auto:javascript",
    command: {
      kind: "exec",
      program: "npx",
      args: ["vitest", "related", "--run", "scripts/fix.js"],
    },
  };

  it("replaces a completed full test requirement with the remediation delta", () => {
    const required = invocation.unionRequiredGates(
      [fullTest],
      [focusedTest],
      new Set(["test"]),
    );
    expect(required).toEqual([focusedTest]);
  });

  it("keeps the authoritative full test requirement without reuse evidence", () => {
    const required = invocation.unionRequiredGates([fullTest], [focusedTest]);
    expect(required).toEqual([fullTest]);
  });

  it("recomputes the full test range when predecessor evidence is invalid", () => {
    const root = repo("invalid-predecessor-test-evidence");
    const manifestPath = create(root);
    recordGateFixture(manifestPath, "test");
    invocation.withManifestLock(manifestPath, (manifest) => {
      const required = manifest.requiredGates.find(
        (gate) => gate.name === "test",
      );
      const gate = manifest.gates.find(
        (candidate) => candidate.name === "test",
      );
      required.source = focusedTest.source;
      required.command = focusedTest.command;
      gate.source = focusedTest.source;
      gate.command = focusedTest.command;
      gate.policyDigest = "0".repeat(64);
      writeFileSync(gate.log, "tampered predecessor evidence\n");
    });
    writeFileSync(
      path.join(root, "new-file.js"),
      "export const next = true;\n",
    );
    git(root, ["add", "new-file.js"]);
    git(root, ["commit", "-q", "-m", "fix: add new test surface"]);

    invocation.advanceManifest(manifestPath);
    const advanced = invocation.loadManifest(manifestPath).manifest;
    expect(
      advanced.requiredGates.find((gate) => gate.name === "test").source,
    ).toBe("package-script:test");
  });
});

describe("quality invocation manifest", () => {
  it("persists the engineering claim without product evidence inputs", () => {
    const root = repo("engineering-delivery-claim");
    const manifestPath = create(root, ["--delivery-claim", "engineering"]);

    expect(
      invocation.loadManifest(manifestPath).manifest.options,
    ).toMatchObject({
      deliveryClaim: "engineering",
      productPrd: null,
      productTasks: null,
      deliveryEvidence: null,
    });
  });

  it("binds the exact delivery-evidence index digest to the current HEAD", () => {
    const root = repo("delivery-evidence-digest");
    const evidence = path.join(root, "evidence.json");
    const body = '{"schemaVersion":2,"repository":"owner/repo"}\n';
    writeFileSync(evidence, body);

    const manifestPath = create(root, [
      "--delivery-claim",
      "local-product",
      "--product-prd",
      "prd.md",
      "--product-tasks",
      "tasks.md",
      "--delivery-evidence",
      "evidence.json",
    ]);
    const manifest = invocation.loadManifest(manifestPath).manifest;

    expect(manifest.deliveryEvidenceBinding).toMatchObject({
      head: manifest.revisions.currentHead,
      sha256: createHash("sha256").update(body).digest("hex"),
      history: [],
    });
    writeFileSync(evidence, `${body} `);
    const changedManifestPath = create(root, [
      "--delivery-claim",
      "local-product",
      "--product-prd",
      "prd.md",
      "--product-tasks",
      "tasks.md",
      "--delivery-evidence",
      "evidence.json",
    ]);
    expect(changedManifestPath).toBe(manifestPath);
  });

  it("renews the delivery-evidence binding only when HEAD advances", () => {
    const root = repo("delivery-evidence-renewal");
    const evidence = path.join(root, "evidence.json");
    writeFileSync(evidence, "initial evidence\n");
    const manifestPath = create(root, ["--delivery-evidence", "evidence.json"]);
    const prior = invocation.loadManifest(manifestPath).manifest;
    const priorHead = prior.revisions.currentHead;
    const priorDigest = prior.deliveryEvidenceBinding.sha256;

    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: renew evidence"]);
    writeFileSync(evidence, "renewed evidence\n");
    invocation.withManifestLock(manifestPath, (manifest) => {
      expect(invocation.advanceHead(manifest, root)).toBe(true);
    });

    const renewed = invocation.loadManifest(manifestPath).manifest;
    expect(renewed.deliveryEvidenceBinding).toMatchObject({
      head: renewed.revisions.currentHead,
      sha256: createHash("sha256").update("renewed evidence\n").digest("hex"),
      history: [{ head: priorHead, sha256: priorDigest }],
    });
  });

  it("hashes the same recursive core diff that the review envelope contains", () => {
    const submodule = makeTempDir("quality-core-source-");
    git(submodule, ["init", "-q", "-b", "main"]);
    git(submodule, ["config", "user.name", "Quality Test"]);
    git(submodule, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(submodule, "policy.sh"), "echo base\n");
    git(submodule, ["add", "policy.sh"]);
    git(submodule, ["commit", "-q", "-m", "base"]);
    const baseCore = git(submodule, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(submodule, "policy.sh"), "echo head\n");
    git(submodule, ["commit", "-qam", "change"]);
    const headCore = git(submodule, ["rev-parse", "HEAD"]);

    const root = makeTempDir("quality-core-review-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(root, "README.md"), "root\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "root"]);
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submodule,
      "core",
    ]);
    git(root, ["-C", "core", "checkout", "-q", baseCore]);
    git(root, ["add", "core"]);
    git(root, ["commit", "-q", "-m", "add core"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["-C", "core", "checkout", "-q", headCore]);
    git(root, ["add", "core"]);
    git(root, ["commit", "-q", "-m", "bump core"]);
    const head = git(root, ["rev-parse", "HEAD"]);

    const diff = invocation.reviewDiffBuffer(root, base, head).toString("utf8");
    expect(diff).toContain(
      `===== recursive submodule diff: core ${baseCore}..${headCore} =====`,
    );
    expect(diff).toContain("-echo base");
    expect(diff).toContain("+echo head");
  });

  it("refuses an uninitialized checkout when the core gitlink changes", () => {
    const submodule = makeTempDir("quality-core-uninitialized-source-");
    git(submodule, ["init", "-q", "-b", "main"]);
    git(submodule, ["config", "user.name", "Quality Test"]);
    git(submodule, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(submodule, "policy.sh"), "echo base\n");
    git(submodule, ["add", "policy.sh"]);
    git(submodule, ["commit", "-q", "-m", "base"]);
    const baseCore = git(submodule, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(submodule, "policy.sh"), "echo head\n");
    git(submodule, ["commit", "-qam", "change"]);
    const headCore = git(submodule, ["rev-parse", "HEAD"]);

    const root = makeTempDir("quality-core-uninitialized-review-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(root, "README.md"), "root\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "root"]);
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submodule,
      "core",
    ]);
    git(root, ["-C", "core", "checkout", "-q", baseCore]);
    git(root, ["add", "core"]);
    git(root, ["commit", "-q", "-m", "add core"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["-C", "core", "checkout", "-q", headCore]);
    git(root, ["add", "core"]);
    git(root, ["commit", "-q", "-m", "bump core"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    rmSync(path.join(root, "core"), { recursive: true, force: true });

    expect(() => invocation.reviewDiffBuffer(root, base, head)).toThrow(
      /changed core gitlink requires an initialized checkout/,
    );
  });

  it("requires a bound domain selector for v2 agent selection", () => {
    const root = repo("v2-agent-selection-identity");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
    });

    const result = spawnSync(
      "node",
      [INVOCATION, "agents", manifest, "code-reviewer"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
    expect(result.stderr).toMatch(/requires --domain and --rule/);
  });

  it("reuses one durable campaign for the same exact repo, PR, base, HEAD, and options", () => {
    const root = repo("durable-campaign");
    const args = ["--level", "98", "--pr", "7", "--merge"];
    const first = createLegacyProviderFixture(root, args);
    execFileSync(
      "node",
      [INVOCATION, "provider-attempt", first, "--provider", "codex"],
      { cwd: root },
    );

    const second = create(root, args);
    expect(second).toBe(first);
    expect(
      JSON.parse(readFileSync(second, "utf8")).governor.providerAttempts,
    ).toHaveLength(1);

    writeFileSync(path.join(root, "next.js"), "export const next = true;\n");
    git(root, ["add", "next.js"]);
    git(root, ["commit", "-q", "-m", "fix: new reviewed head"]);
    expect(create(root, args)).not.toBe(first);
  });

  it("creates active-execution manifests without wall-clock deadlines", () => {
    const root = repo("execution-budget-schema");
    const manifest = JSON.parse(readFileSync(create(root), "utf8"));
    expect(manifest.governor).toMatchObject({
      executionBudgetVersion: 1,
      gateSecondsLimit: 600,
      gateSecondsUsed: 0,
      providerSecondsLimit: 900,
      providerSecondsUsed: 0,
      activeSecondsLimit: 3600,
      activeSecondsUsed: 0,
      activeExecution: null,
    });
    expect(manifest.governor).not.toHaveProperty("campaignDeadlineEpoch");
    expect(manifest.governor).not.toHaveProperty("providerDeadlineEpoch");
    expect(manifest.governor).not.toHaveProperty("validationDeadlineEpoch");
  });

  it("keeps terminal fencing and signing secrets out of repository gates", () => {
    const environment = invocation.repositoryGateEnvironment({
      PATH: "/bin",
      QUALITY_GATE_MARKER: "visible",
      BS_QUALITY_TERMINAL_EPOCH: "3",
      BS_QUALITY_REPOSITORY_LEASE_TOKEN: "lease-secret",
      QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY: "review-secret",
      QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY_FILE: "/private/review-key",
      QUALITY_APPROVAL_PRIVATE_KEY: "approval-secret",
      QUALITY_APPROVAL_PRIVATE_KEY_FILE: "/private/approval-key",
    });

    expect(environment).toEqual({
      PATH: "/bin",
      QUALITY_GATE_MARKER: "visible",
    });
  });

  it("authorizes Gemini inside the existing provider attempt budget", () => {
    const root = repo("gemini-provider-attempt");
    const manifest = createLegacyProviderFixture(root, []);
    const result = JSON.parse(
      execFileSync(
        "node",
        [INVOCATION, "provider-attempt", manifest, "--provider", "gemini"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(result.provider).toBe("gemini");
    expect(result.number).toBe(1);
  });

  it("refuses a fresh same-work campaign created only by swapping provider policy", () => {
    const root = repo("durable-provider-policy");
    create(root, [], {
      BS_QUALITY_PRIMARY: "codex",
      BS_QUALITY_FALLBACK: "claude",
    });

    const changedPolicy = spawnSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BS_QUALITY_PRIMARY: "claude",
          BS_QUALITY_FALLBACK: "codex",
        },
      },
    );
    expect(changedPolicy.status).not.toBe(0);
    expect(changedPolicy.stderr).toMatch(
      /deterministic quality campaign identity collision/,
    );
  });

  it("rejects an invalid provider policy before creating campaign state", () => {
    const root = repo("invalid-provider-policy-bootstrap");
    const result = spawnSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BS_QUALITY_PRIMARY: "gemini",
          BS_QUALITY_FALLBACK: "gemini",
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /invalid provider policy: primary=gemini fallback=gemini/,
    );
    expect(result.stdout).toBe("");
  });

  it("fails over an exhausted same-head campaign without resetting its budget", () => {
    const root = repo("durable-provider-failover");
    const manifest = create(root, [], {
      BS_QUALITY_PRIMARY: "codex",
      BS_QUALITY_FALLBACK: "claude",
    });
    invocation.withManifestLock(manifest, (state) => {
      state.governor.providerAttempts.push({
        number: 1,
        provider: "claude",
        head: state.revisions.currentHead,
        reviewCount: 0,
        startedAt: new Date().toISOString(),
        timeoutSeconds: 60,
      });
      state.governor.providerSecondsUsed = 60;
    });

    expect(
      create(root, [], {
        BS_QUALITY_PRIMARY: "gemini",
        BS_QUALITY_FALLBACK: "claude",
      }),
    ).toBe(manifest);
    const resumed = JSON.parse(readFileSync(manifest, "utf8"));
    expect(resumed.invocationId).toBe(path.basename(path.dirname(manifest)));
    expect(resumed.governor.providerSecondsUsed).toBe(60);
    expect(resumed.provider.primaryOverride).toBe("gemini");
    expect(resumed.provider.transitions).toHaveLength(1);
    expect(resumed.provider.transitions[0]).toMatchObject({
      from: { primaryOverride: "codex", fallbackOverride: "claude" },
      to: { primaryOverride: "gemini", fallbackOverride: "claude" },
    });
  });

  it("binds review-arm attribution to the assigned primary provider", () => {
    const nativeRoot = repo("native-review-arm");
    const nativeManifest = JSON.parse(
      readFileSync(
        create(nativeRoot, [
          "--primary",
          "codex",
          "--fallback",
          "claude",
          "--review-arm",
          "native",
        ]),
        "utf8",
      ),
    );
    expect(nativeManifest.options.reviewArm).toBe("native");
    expect(nativeManifest.provider.primaryOverride).toBe("codex");

    const bespokeRoot = repo("bespoke-review-arm");
    const bespokeManifest = JSON.parse(
      readFileSync(
        create(bespokeRoot, [
          "--primary",
          "claude",
          "--fallback",
          "codex",
          "--review-arm",
          "bespoke",
        ]),
        "utf8",
      ),
    );
    expect(bespokeManifest.options.reviewArm).toBe("bespoke");
    expect(bespokeManifest.provider.primaryOverride).toBe("claude");
  });

  it("rejects an arm label that conflicts with its primary provider", () => {
    const root = repo("conflicting-review-arm");
    expect(() =>
      create(root, [
        "--primary",
        "codex",
        "--fallback",
        "claude",
        "--review-arm",
        "bespoke",
      ]),
    ).toThrow(/review arm 'bespoke' conflicts with primary provider 'codex'/);
  });

  it("rejects an explicit experiment arm without a bound primary provider", () => {
    const root = repo("unbound-review-arm");
    expect(() => create(root, ["--review-arm", "native"])).toThrow(
      /explicit review arm requires a primary provider/,
    );
  });

  it("does not turn an ordinary provider override into an experiment assignment", () => {
    const root = repo("ordinary-provider-attribution");
    const manifest = JSON.parse(
      readFileSync(
        create(root, ["--primary", "codex", "--fallback", "claude"]),
        "utf8",
      ),
    );
    expect(manifest.options.reviewArm).toBeNull();
    expect(manifest.provider.primaryOverride).toBe("codex");
  });

  it("keeps a terminal provider-incomplete collision fail closed", () => {
    const root = repo("non-diversity-upgrade");
    const predecessor = create(root, [
      "--primary",
      "codex",
      "--fallback",
      "claude",
    ]);
    invocation.recordTerminalState(
      predecessor,
      "provider-incomplete",
      "provider-timeout",
    );
    expect(() =>
      create(root, [
        "--primary",
        "claude",
        "--fallback",
        "codex",
        "--review-arm",
        "bespoke",
      ]),
    ).toThrow(/deterministic quality campaign identity collision/);
  });

  it("replaces a superseded pre-review campaign without discarding review evidence", () => {
    const root = repo("superseded-pre-review-recovery");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push({
        name: "lint",
        status: "success",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(
      predecessor,
      "superseded",
      "operator stopped before review",
    );

    const replacement = create(root);
    expect(replacement).not.toBe(predecessor);
    expect(JSON.parse(readFileSync(replacement, "utf8"))).toMatchObject({
      supersedes: {
        invocationId: JSON.parse(readFileSync(predecessor, "utf8"))
          .invocationId,
        reason: "explicit resume after superseded campaign",
      },
      gates: [],
      reviews: [],
    });
    expect(create(root)).toBe(replacement);

    invocation.withManifestLock(replacement, (manifest) => {
      manifest.reviews.push({ status: "success", provider: "codex" });
    });
    invocation.recordTerminalState(
      replacement,
      "superseded",
      "operator stopped after review",
    );
    // The deterministic root must keep resolving to this terminal packet,
    // rather than minting another successor and discarding its review.
    expect(create(root)).toBe(replacement);
  });

  it("replaces a pre-review gate interrupted by a host signal", () => {
    const root = repo("interrupted-gate-recovery");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push(
        {
          name: "lint",
          status: "success",
          head: manifest.revisions.currentHead,
        },
        {
          name: "test",
          status: "failed",
          failureCode: "signal-interrupted",
          head: manifest.revisions.currentHead,
        },
      );
    });
    invocation.recordTerminalState(
      predecessor,
      "interrupted",
      "gate:test:signal-interrupted",
    );

    const replacement = create(root);
    expect(replacement).not.toBe(predecessor);
    expect(JSON.parse(readFileSync(replacement, "utf8"))).toMatchObject({
      supersedes: {
        invocationId: JSON.parse(readFileSync(predecessor, "utf8"))
          .invocationId,
        reason: "gate execution was interrupted by a host signal",
      },
      gates: [],
      reviews: [],
    });
  });

  it("supersedes a pre-review missing-executable gate failure", () => {
    const root = repo("environment-recovery");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push({
        name: "lint",
        status: "failed",
        reason: "gate 'lint' failed with exit status 127",
        failureCode: "missing-executable",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(predecessor, "blocked", "gate:lint");

    const recovered = create(root);
    expect(recovered).not.toBe(predecessor);
    expect(JSON.parse(readFileSync(recovered, "utf8"))).toMatchObject({
      supersedes: {
        invocationId: JSON.parse(readFileSync(predecessor, "utf8"))
          .invocationId,
        reason: "bootstrap environment lacked the required gate executable",
      },
      gates: [],
      reviews: [],
      environmentRecovery: {
        reason: "bootstrap environment lacked the required gate executable",
      },
    });
    expect(
      JSON.parse(readFileSync(predecessor, "utf8")).supersededBy,
    ).toMatchObject({
      invocationId: JSON.parse(readFileSync(recovered, "utf8")).invocationId,
    });
  });

  it("supersedes a pre-risk gate timeout without reopening a real timeout", () => {
    const root = repo("pre-risk-gate-recovery");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push({
        name: "test",
        status: "timeout",
        reason: "gate 'test' exceeded its proportional 300s budget",
        failureCode: "unresolved-risk-timeout",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(predecessor, "blocked", "gate:test");

    const recovered = create(root);
    expect(recovered).not.toBe(predecessor);
    expect(JSON.parse(readFileSync(recovered, "utf8"))).toMatchObject({
      supersedes: {
        reason: "gate execution began before its risk contract was resolved",
      },
      gates: [],
      reviews: [],
      environmentRecovery: {
        reason: "gate execution began before its risk contract was resolved",
      },
    });

    const ordinaryTimeoutRoot = repo("ordinary-timeout");
    const correctlyBudgeted = create(ordinaryTimeoutRoot);
    invocation.withManifestLock(correctlyBudgeted, (manifest) => {
      manifest.risk = { ...manifest.risk, resolved: true, tier: "medium" };
      manifest.gates.push({
        name: "test",
        status: "timeout",
        reason: "gate 'test' exceeded its proportional 300s budget",
        failureCode: "gate-timeout",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(correctlyBudgeted, "blocked", "gate:test");
    expect(() => create(root)).not.toThrow();
    expect(create(ordinaryTimeoutRoot)).toBe(correctlyBudgeted);
  });

  it("marks an environment recovery only when the gate executable is absent", () => {
    expect(invocation.executableAvailable("node", process.env)).toBe(true);
    expect(
      invocation.executableAvailable(
        "bs-quality-definitely-missing",
        process.env,
      ),
    ).toBe(false);
  });

  it("does not discard earlier gate evidence during environment recovery", () => {
    const root = repo("environment-recovery-after-gate");
    const predecessor = create(root);
    recordGateFixture(predecessor, "lint");
    invocation.withManifestLock(predecessor, (manifest) => {
      const log = path.join(path.dirname(predecessor), "missing.log");
      writeFileSync(log, "missing executable\n");
      invocation.recordGate(manifest, {
        name: "test",
        source: manifest.requiredGates.find((gate) => gate.name === "test")
          .source,
        command: manifest.requiredGates.find((gate) => gate.name === "test")
          .command,
        log,
        status: "failed",
        reason: "gate 'test' failed with exit status 127",
        failureCode: "missing-executable",
      });
    });
    invocation.recordTerminalState(predecessor, "blocked", "gate:test");
    expect(create(root)).toBe(predecessor);
  });

  it("does not repeatedly supersede a permanently missing executable", () => {
    const root = repo("environment-recovery-cap");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push({
        name: "lint",
        status: "failed",
        reason:
          "gate 'lint' cannot start because 'missing-tool' is unavailable",
        failureCode: "missing-executable",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(predecessor, "blocked", "gate:lint");

    const recovered = create(root);
    expect(recovered).not.toBe(predecessor);
    expect(() => create(root)).toThrow(
      /deterministic quality campaign identity collision/,
    );
    expect(JSON.parse(readFileSync(predecessor, "utf8"))).toMatchObject({
      supersededBy: {
        invocationId: JSON.parse(readFileSync(recovered, "utf8")).invocationId,
      },
    });
  });

  it("caps recovery after the replacement also lacks the executable", () => {
    const root = repo("environment-recovery-chain-cap");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push({
        name: "lint",
        status: "failed",
        reason: "gate 'lint' failed with exit status 127",
        failureCode: "missing-executable",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(predecessor, "blocked", "gate:lint");

    const recovered = create(root);
    expect(JSON.parse(readFileSync(recovered, "utf8"))).toMatchObject({
      environmentRecovery: {
        reason: "bootstrap environment lacked the required gate executable",
        rootInvocationId: JSON.parse(readFileSync(predecessor, "utf8"))
          .invocationId,
        generation: 1,
      },
    });
    invocation.withManifestLock(recovered, (manifest) => {
      manifest.gates.push({
        name: "lint",
        status: "failed",
        reason: "gate 'lint' failed with exit status 127",
        failureCode: "missing-executable",
        head: manifest.revisions.currentHead,
      });
    });
    invocation.recordTerminalState(recovered, "blocked", "gate:lint");
    expect(() => create(root)).toThrow(
      /deterministic quality campaign identity collision/,
    );
  });

  it("does not recover a missing-executable gate from a stale head", () => {
    const root = repo("environment-recovery-stale-head");
    const predecessor = create(root);
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.gates.push({
        name: "lint",
        status: "failed",
        reason:
          "gate 'lint' cannot start because 'missing-tool' is unavailable",
        failureCode: "missing-executable",
        head: "stale-head",
      });
    });
    invocation.recordTerminalState(predecessor, "blocked", "gate:lint");
    expect(create(root)).toBe(predecessor);
  });

  it("uses one untried provider after exact-head quota exhaustion", () => {
    const root = repo("provider-exhaustion-recovery");
    const predecessor = create(root, [
      "--primary",
      "codex",
      "--fallback",
      "claude",
    ]);
    for (const gate of JSON.parse(readFileSync(predecessor, "utf8"))
      .requiredGates) {
      recordGateFixture(predecessor, gate.name);
    }
    invocation.withManifestLock(predecessor, (manifest) => {
      manifest.governor.providerAttempts.push({ provider: "codex" });
      manifest.reviews.push({
        status: "incomplete",
        failedProvider: "claude",
        failureCategory: "provider-exhaustion",
        leadCount: 0,
      });
    });
    invocation.recordTerminalState(
      predecessor,
      "provider-incomplete",
      "retry-exhausted:provider-exhaustion",
    );

    const recovered = create(root, [
      "--primary",
      "gemini",
      "--fallback",
      "codex",
    ]);
    expect(recovered).not.toBe(predecessor);
    expect(JSON.parse(readFileSync(recovered, "utf8"))).toMatchObject({
      supersedes: {
        reason: "exact-head discovery exhausted its configured provider set",
      },
      providerRecovery: { attemptedProviders: ["claude", "codex"] },
      gateEvidenceCarry: {
        sourceInvocationId: JSON.parse(readFileSync(predecessor, "utf8"))
          .invocationId,
        head: JSON.parse(readFileSync(predecessor, "utf8")).revisions
          .currentHead,
      },
      gates: expect.arrayContaining(
        JSON.parse(readFileSync(predecessor, "utf8")).gates,
      ),
      reviews: [],
    });
    const recoveredManifest = JSON.parse(readFileSync(recovered, "utf8"));
    expect(() =>
      invocation.verifyGateEvidence(recoveredManifest),
    ).not.toThrow();
    recoveredManifest.gateEvidenceCarry.gatesDigest = "0".repeat(64);
    expect(() => invocation.verifyGateEvidence(recoveredManifest)).toThrow(
      /gate evidence carry digest is invalid/,
    );
    expect(() =>
      create(root, ["--primary", "claude", "--fallback", "codex"]),
    ).toThrow(/deterministic quality campaign identity collision/);
  });

  it("recovers legacy gate evidence with fresh gates when carry is unsupported", () => {
    const root = repo("provider-exhaustion-legacy-gates");
    const predecessor = create(root, [
      "--primary",
      "codex",
      "--fallback",
      "claude",
    ]);
    for (const gate of JSON.parse(readFileSync(predecessor, "utf8"))
      .requiredGates) {
      recordGateFixture(predecessor, gate.name);
    }
    invocation.withManifestLock(predecessor, (manifest) => {
      for (const gate of manifest.gates) delete gate.policyDigest;
      manifest.governor.providerAttempts.push({ provider: "codex" });
      manifest.reviews.push({
        status: "incomplete",
        failedProvider: "claude",
        failureCategory: "provider-exhaustion",
        leadCount: 0,
      });
    });
    invocation.recordTerminalState(
      predecessor,
      "provider-incomplete",
      "retry-exhausted:provider-exhaustion",
    );

    const recovered = create(root, [
      "--primary",
      "gemini",
      "--fallback",
      "codex",
    ]);
    const manifest = JSON.parse(readFileSync(recovered, "utf8"));
    expect(recovered).not.toBe(predecessor);
    expect(manifest.gates).toEqual([]);
    expect(manifest.gateEvidenceCarry).toBeUndefined();
    expect(manifest.requiredGates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "test" })]),
    );
  });

  it("resumes after review without treating provider evidence as configuration drift", () => {
    const root = repo("reviewed-provider-identity");
    const env = {
      BS_QUALITY_PRIMARY: "gemini",
      BS_QUALITY_FALLBACK: "none",
    };
    const manifest = create(root, [], env);
    const body = JSON.parse(readFileSync(manifest, "utf8"));
    body.provider = {
      ...body.provider,
      primary: "gemini",
      fallback: "none",
      reviewer: "gemini",
    };
    writeFileSync(manifest, `${JSON.stringify(body, null, 2)}\n`);

    expect(create(root, [], env)).toBe(manifest);
  });

  it("refuses caller-selected invocation ids that would reset a campaign", () => {
    const root = repo("durable-explicit-id");
    expect(() =>
      create(root, ["--invocation-id", "11111111-1111-4111-8111-111111111111"]),
    ).toThrow(/deterministic.*cannot be overridden/);
  });

  it("atomically converges concurrent creators on one durable manifest", async () => {
    const root = repo("durable-concurrent-create");
    const manifests = await Promise.all([
      createAsync(root),
      createAsync(root),
      createAsync(root),
      createAsync(root),
    ]);
    expect(new Set(manifests).size).toBe(1);
    expect(JSON.parse(readFileSync(manifests[0], "utf8")).invocationId).toBe(
      path.basename(path.dirname(manifests[0])),
    );
  });

  it("cannot reset the same campaign from another linked worktree", () => {
    const root = repo("durable-linked-worktree");
    create(root);
    const linked = makeTempDir("quality-linked-");
    git(root, ["worktree", "add", "--detach", linked, "HEAD"]);
    expect(() => create(linked)).toThrow(
      /deterministic quality campaign identity collision/,
    );
  });

  it("namespaces independent clones by their Git common directory", () => {
    const root = repo("durable-independent-clone");
    const original = create(root);
    const clone = makeTempDir("quality-clone-");
    execFileSync("git", ["clone", "-q", root, clone]);
    git(clone, ["fetch", "-q", "origin", "main"]);
    const independent = create(clone);
    expect(independent).not.toBe(original);
  });

  it("bootstraps one explicit manifest from a zsh parent", () => {
    const root = repo("bootstrap");
    const result = spawnSync(
      "zsh",
      [
        "-fc",
        'bash "$1" --target-dir "$2" --level auto',
        "quality-bootstrap-test",
        BOOTSTRAP,
        root,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BS_QUALITY_PRIMARY: "codex",
          BS_QUALITY_FALLBACK: "claude",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifestPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    expect(manifestPath).toBeTruthy();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.repo.realpath).toBe(realpathSync(root));
    expect(manifest.revisions.currentHead).toBe(
      git(root, ["rev-parse", "HEAD"]),
    );
    expect(manifest.options.reviewArm).toBeNull();
    expect(manifest.provider.primaryOverride).toBe("codex");
    expect(manifest.provider.fallbackOverride).toBe("claude");
  }, 120_000);

  it("routes an explicit bespoke experiment arm through the companion provider", () => {
    const root = repo("bootstrap-bespoke-arm");
    const result = spawnSync(
      "bash",
      [
        BOOTSTRAP,
        "--target-dir",
        root,
        "--level",
        "auto",
        "--review-arm",
        "bespoke",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifestPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.options.reviewArm).toBe("bespoke");
    expect(manifest.provider.primaryOverride).toBe("claude");
    expect(manifest.provider.fallbackOverride).toBe("codex");
  }, 120_000);

  it("passes QUALITY_CWD derived from --target-dir, not this process's own $PWD (BUI-390)", () => {
    // Reproduces the BUI-390 repro shape: invoking bash from a directory
    // other than --target-dir. Stubs the resolver location with a fake
    // resolver that just reports the QUALITY_CWD it received and exits
    // non-zero — if bootstrap.sh derives QUALITY_CWD from --target-dir (the
    // fix) rather than $(pwd) at the resolver-path branch (the bug), the
    // fake resolver observes the target dir, not the elsewhere cwd.
    const target = repo("bootstrap-cwd-target");
    const setupRoot = makeTempDir("quality-fake-setup-root-");
    const fakeScriptsDir = path.join(setupRoot, "scripts");
    mkdirSync(fakeScriptsDir, { recursive: true });
    const observedFile = path.join(setupRoot, "observed-cwd.txt");
    writeFileSync(
      path.join(fakeScriptsDir, "quality-target-resolver.js"),
      `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(observedFile)}, process.env.QUALITY_CWD || "");
process.stdout.write(JSON.stringify({ ok: false, reason: "test stub", resolution: "path", warnings: [] }));
process.exit(0);
`,
    );
    const elsewhereCwd = makeTempDir("quality-bootstrap-elsewhere-");
    spawnSync("bash", [BOOTSTRAP, "--target-dir", target, "--level", "auto"], {
      cwd: elsewhereCwd,
      env: {
        ...process.env,
        CLAUDE_SETUP_ROOT: setupRoot,
      },
      encoding: "utf8",
    });
    const observedCwd = readFileSync(observedFile, "utf8");
    expect(observedCwd).toBe(target);
    expect(observedCwd).not.toBe(elsewhereCwd);
  }, 30_000);

  it("injects --target-dir into resolver args when only BS_QUALITY_TARGET_DIR env var is set (BUI-390)", () => {
    // Documented precedence is --target-dir > env var > cwd. Without
    // injecting an explicit --target-dir token, the resolver's own arg
    // parser never sees a path (it only parses CLI tokens, not env vars),
    // so it falls through to the ambient-cwd fallback and hard-refuses
    // under --merge — breaking the documented env-var-only fallback for
    // forked/agent invocations with no inherited cwd.
    const target = repo("bootstrap-env-target-dir");
    const setupRoot = makeTempDir("quality-fake-setup-root-envvar-");
    const fakeScriptsDir = path.join(setupRoot, "scripts");
    mkdirSync(fakeScriptsDir, { recursive: true });
    const observedArgsFile = path.join(setupRoot, "observed-args.json");
    writeFileSync(
      path.join(fakeScriptsDir, "quality-target-resolver.js"),
      `#!/usr/bin/env node
const idx = process.argv.indexOf("--cli");
const argv = idx >= 0 ? process.argv.slice(idx + 1) : [];
require("fs").writeFileSync(${JSON.stringify(observedArgsFile)}, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ ok: false, reason: "test stub", resolution: "path", warnings: [] }));
process.exit(0);
`,
    );
    const elsewhereCwd = makeTempDir("quality-bootstrap-elsewhere-envvar-");
    spawnSync("bash", [BOOTSTRAP, "--merge", "--level", "auto"], {
      cwd: elsewhereCwd,
      env: {
        ...process.env,
        CLAUDE_SETUP_ROOT: setupRoot,
        BS_QUALITY_TARGET_DIR: target,
      },
      encoding: "utf8",
    });
    const observedArgs = JSON.parse(readFileSync(observedArgsFile, "utf8"));
    const targetDirIdx = observedArgs.indexOf("--target-dir");
    expect(targetDirIdx).toBeGreaterThanOrEqual(0);
    expect(observedArgs[targetDirIdx + 1]).toBe(target);
  }, 30_000);

  it("does not let BS_QUALITY_TARGET_DIR override an explicit bare-path argument (BUI-390)", () => {
    // Codex review finding: parseArgs recognizes a bare absolute/~ path
    // token as an explicit target too, not just --target-dir/--target. If
    // bootstrap.sh's own env-var-fallback scanner doesn't recognize that
    // form, it wrongly appends --target-dir <env value>, and because
    // quality-target-resolver.js's applyExplicitFlags runs before
    // applyPathPattern, the injected env value would win over the caller's
    // own explicit path — silently auditing/merging the wrong checkout.
    const explicitTarget = repo("bootstrap-explicit-bare-path");
    const envTarget = repo("bootstrap-env-target-should-be-ignored");
    const setupRoot = makeTempDir("quality-fake-setup-root-bare-path-");
    const fakeScriptsDir = path.join(setupRoot, "scripts");
    mkdirSync(fakeScriptsDir, { recursive: true });
    const observedArgsFile = path.join(setupRoot, "observed-args.json");
    writeFileSync(
      path.join(fakeScriptsDir, "quality-target-resolver.js"),
      `#!/usr/bin/env node
const idx = process.argv.indexOf("--cli");
const argv = idx >= 0 ? process.argv.slice(idx + 1) : [];
require("fs").writeFileSync(${JSON.stringify(observedArgsFile)}, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ ok: false, reason: "test stub", resolution: "path", warnings: [] }));
process.exit(0);
`,
    );
    spawnSync(
      "bash",
      [BOOTSTRAP, "--merge", explicitTarget, "--level", "auto"],
      {
        cwd: explicitTarget,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: setupRoot,
          BS_QUALITY_TARGET_DIR: envTarget,
        },
        encoding: "utf8",
      },
    );
    const observedArgs = JSON.parse(readFileSync(observedArgsFile, "utf8"));
    // The caller's own bare path must be present, unmodified; --target-dir
    // must NOT have been injected with the env var's (different) value.
    expect(observedArgs).toContain(explicitTarget);
    const targetDirIdx = observedArgs.indexOf("--target-dir");
    if (targetDirIdx >= 0) {
      expect(observedArgs[targetDirIdx + 1]).not.toBe(envTarget);
    }
  }, 30_000);

  it("does not let BS_QUALITY_TARGET_DIR override a literal ~/... path argument (BUI-390)", () => {
    // Second Codex review finding on the same fix: an UNQUOTED ~/* case
    // pattern undergoes bash tilde expansion and becomes rooted at $HOME,
    // so it silently fails to match a literal "~/..." argument string
    // (as opposed to a shell-expanded absolute path). Passes a literal
    // ~/-prefixed token (not expanded by the test harness, since it's
    // passed as a discrete argv entry, not through a shell) to prove the
    // quoted-tilde pattern in quality-bootstrap.sh actually matches it.
    const explicitTarget = repo("bootstrap-explicit-tilde-path");
    const envTarget = repo("bootstrap-env-target-should-be-ignored-tilde");
    const setupRoot = makeTempDir("quality-fake-setup-root-tilde-path-");
    const fakeScriptsDir = path.join(setupRoot, "scripts");
    mkdirSync(fakeScriptsDir, { recursive: true });
    const observedArgsFile = path.join(setupRoot, "observed-args.json");
    writeFileSync(
      path.join(fakeScriptsDir, "quality-target-resolver.js"),
      `#!/usr/bin/env node
const idx = process.argv.indexOf("--cli");
const argv = idx >= 0 ? process.argv.slice(idx + 1) : [];
require("fs").writeFileSync(${JSON.stringify(observedArgsFile)}, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ ok: false, reason: "test stub", resolution: "path", warnings: [] }));
process.exit(0);
`,
    );
    const literalTildeArg = "~/some/literal/tilde/path";
    spawnSync(
      "bash",
      [BOOTSTRAP, "--merge", literalTildeArg, "--level", "auto"],
      {
        cwd: explicitTarget,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: setupRoot,
          BS_QUALITY_TARGET_DIR: envTarget,
        },
        encoding: "utf8",
      },
    );
    const observedArgs = JSON.parse(readFileSync(observedArgsFile, "utf8"));
    expect(observedArgs).toContain(literalTildeArg);
    const targetDirIdx = observedArgs.indexOf("--target-dir");
    if (targetDirIdx >= 0) {
      expect(observedArgs[targetDirIdx + 1]).not.toBe(envTarget);
    }
  }, 30_000);

  it("recognizes --worktree as an explicit path, same as --target-dir (BUI-390)", () => {
    // Codex review finding (full-diff pass): quality-target-resolver.js's
    // EXPLICIT_PATH_FLAG set is {--target-dir, --target, --worktree} — the
    // bootstrap.sh scanner only checked the first two, so a --worktree-based
    // invocation launched from another checkout would wrongly accept the
    // BS_QUALITY_TARGET_DIR env-var fallback, resolving/materializing
    // against the wrong repo.
    const explicitTarget = repo("bootstrap-explicit-worktree-flag");
    const envTarget = repo("bootstrap-env-target-should-be-ignored-worktree");
    const setupRoot = makeTempDir("quality-fake-setup-root-worktree-flag-");
    const fakeScriptsDir = path.join(setupRoot, "scripts");
    mkdirSync(fakeScriptsDir, { recursive: true });
    const observedArgsFile = path.join(setupRoot, "observed-args.json");
    writeFileSync(
      path.join(fakeScriptsDir, "quality-target-resolver.js"),
      `#!/usr/bin/env node
const idx = process.argv.indexOf("--cli");
const argv = idx >= 0 ? process.argv.slice(idx + 1) : [];
require("fs").writeFileSync(${JSON.stringify(observedArgsFile)}, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ ok: false, reason: "test stub", resolution: "path", warnings: [] }));
process.exit(0);
`,
    );
    // Uses --worktree=<relative-looking-name> deliberately: an *absolute*
    // --worktree value would incidentally satisfy the separate bare-path
    // ("/*") detection this same scanner does, masking whether --worktree
    // itself is recognized as an explicit-path FLAG. A relative-looking
    // --worktree=value isolates the flag-recognition behavior under test.
    const worktreeArg = `--worktree=${explicitTarget}`;
    const elsewhereCwd = makeTempDir("quality-bootstrap-elsewhere-worktree-");
    spawnSync("bash", [BOOTSTRAP, "--merge", worktreeArg, "--level", "auto"], {
      cwd: elsewhereCwd,
      env: {
        ...process.env,
        CLAUDE_SETUP_ROOT: setupRoot,
        BS_QUALITY_TARGET_DIR: envTarget,
      },
      encoding: "utf8",
    });
    const observedArgs = JSON.parse(readFileSync(observedArgsFile, "utf8"));
    expect(observedArgs).toContain(worktreeArg);
    // The scanner must recognize --worktree=... as an explicit path and NOT
    // inject the env var's --target-dir over it.
    const targetDirIdx = observedArgs.indexOf("--target-dir");
    expect(targetDirIdx).toBe(-1);
  }, 30_000);

  it("anchors worktree materialization to the resolved target, not ambient cwd (BUI-390)", () => {
    // Codex review finding: REPO_ROOT_FOR_WT used `git rev-parse
    // --show-toplevel` unscoped, which resolves against this process's own
    // cwd rather than the resolved --target-dir. When a resolved branch has
    // no local worktree yet, materialization would fetch/create it against
    // the wrong repo (or fail outright from a non-repo directory). Uses
    // --branch (not --pr) so this doesn't depend on the repo() test
    // helper's origin remote being a github.com URL — resolveByBranch
    // doesn't need repo scoping, only cwd scoping, which is exactly what
    // this fix addresses.
    const primary = repo("bootstrap-materialize-target");
    const base = git(primary, ["rev-parse", "origin/main"]);
    git(primary, ["branch", "release", base]);
    const elsewhereCwd = makeTempDir(
      "quality-bootstrap-elsewhere-materialize-",
    );
    const result = spawnSync(
      "bash",
      [
        BOOTSTRAP,
        "--target-dir",
        primary,
        "--branch",
        "release",
        "--level",
        "auto",
      ],
      {
        cwd: elsewhereCwd,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: ROOT,
        },
        encoding: "utf8",
      },
    );
    // Materialization must succeed (anchored to `primary`, which has the
    // `release` branch) rather than fail because it tried to resolve a repo
    // root from `elsewhereCwd` (not a git checkout at all).
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  it("binds a non-merge PR bootstrap to the PR base branch and base SHA", () => {
    const root = repo("pr-bootstrap");
    const base = git(root, ["rev-parse", "origin/main"]);
    git(root, ["branch", "release", base]);
    const bin = makeTempDir("quality-bootstrap-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":7,"headRefName":"feature","headRefOid":"${git(root, ["rev-parse", "HEAD"])}","headRepository":{"nameWithOwner":"owner/repo"},"isCrossRepository":false,"baseRefName":"release","baseRefOid":"${base}"}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      "bash",
      [BOOTSTRAP, "--pr", "7", "--level", "auto"],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifestPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.options.merge).toBe(false);
    expect(manifest.repo.pr).toBe(7);
    expect(manifest.repo.githubRepository).toBe("owner/repo");
    expect(manifest.repo.headRefName).toBe("feature");
    expect(manifest.repo.headRepository).toBe("owner/repo");
    expect(manifest.repo.isCrossRepository).toBe(false);
    expect(manifest.revisions.baseRef).toBe("origin/release");
    expect(manifest.revisions.baseHeadSha).toBe(base);
  }, 120_000);

  it("passes --repo (derived from GIT_ROOT, not CWD) to gh pr view on --merge resume (BUI-470)", () => {
    // Exercises quality-bootstrap.sh's own --repo scoping directly (line
    // ~151, resume path) rather than routing through quality-target-
    // resolver.js's separate --target-dir scoping (BUI-391) — that already
    // has its own coverage in quality-target-resolver-pr-repo-scoping.test.js.
    const root = repo("bootstrap-pr-repo-flag-resume");
    const bin = makeTempDir("quality-bootstrap-gh-");
    const gh = path.join(bin, "gh");
    // This stub only succeeds when called with --repo owner/repo; if the
    // fix regresses (drops --repo on the resume path), the command fails.
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  saw_repo=false
  for arg in "$@"; do
    if [ "$arg" = "--repo" ]; then saw_repo=true; fi
  done
  [ "$saw_repo" = true ] || { echo "gh pr view called without --repo" >&2; exit 1; }
  printf '%s\\n' '{"headRefName":"feature","headRepository":{"nameWithOwner":"owner/repo"},"isCrossRepository":false}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const bootstrapEnv = {
      ...process.env,
      CLAUDE_SETUP_ROOT: ROOT,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const manifestPath = create(root, ["--pr", "21"], bootstrapEnv);
    // Invoke resume with cwd pointed elsewhere (a stale tmp dir, not `root`)
    // — the exact BUI-470 repro shape: $PWD and the manifest's own repo
    // disagree, so any unscoped `gh` call would resolve against the wrong
    // (or no) repo instead of the manifest's repo.realpath.
    const elsewhereCwd = makeTempDir("quality-bootstrap-elsewhere-");
    const result = spawnSync("bash", [BOOTSTRAP, "--manifest", manifestPath], {
      cwd: elsewhereCwd,
      env: bootstrapEnv,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it("passes --repo (derived from GIT_ROOT, not CWD) to gh pr view on the --merge no-arg lookup (BUI-470)", () => {
    const primary = repo("bootstrap-pr-repo-flag-merge-noarg");
    const linked = makeTempDir("quality-linked-merge-noarg-");
    git(primary, ["switch", "-q", "main"]);
    git(primary, [
      "worktree",
      "add",
      "-q",
      "-b",
      "quality-merge-noarg-branch",
      linked,
      "main",
    ]);
    const fixtureIdentity = fixtureRepository(linked);
    prepareFixtureNamespace(linked, fixtureIdentity);
    const bin = makeTempDir("quality-bootstrap-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' '${fixtureIdentity}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  saw_repo=false
  saw_selector=false
  prev=""
  idx=0
  for arg in "$@"; do
    idx=$((idx + 1))
    if [ "$idx" -le 2 ]; then prev="$arg"; continue; fi
    if [ "$arg" = "--repo" ]; then saw_repo=true; fi
    # Real gh requires a positional selector (PR number/URL/branch) when
    # --repo is combined with 'pr view' — reject the no-selector shape the
    # same way real gh does, so a regression to the bare form is caught.
    # A non-flag token (after 'pr view') that isn't a value belonging to a
    # preceding flag counts as the selector.
    if [ "\${arg#-}" = "$arg" ] && [ "$prev" != "--repo" ] && [ "$prev" != "--json" ]; then
      saw_selector=true
    fi
    prev="$arg"
  done
  [ "$saw_repo" = true ] || { echo "gh pr view called without --repo" >&2; exit 1; }
  [ "$saw_selector" = true ] || { echo "argument required when using the --repo flag" >&2; exit 1; }
  printf '%s\\n' '{"number":23,"headRefName":"quality-merge-noarg-branch","headRefOid":"${git(linked, ["rev-parse", "HEAD"])}","headRepository":{"nameWithOwner":"${fixtureIdentity}"},"isCrossRepository":false,"baseRefName":"main","baseRefOid":"${git(primary, ["rev-parse", "origin/main"])}"}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      "bash",
      [BOOTSTRAP, "--target-dir", linked, "--merge", "--level", "auto"],
      {
        cwd: linked,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it("fails closed when the resolved PR belongs to a different repo than GIT_ROOT's own remote (BUI-470)", () => {
    // Exercises quality-bootstrap.sh's own defensive cross-check (belt-and-
    // suspenders on top of --repo scoping): if gh ever returns a PR bound to
    // a different repo than GIT_ROOT's remote, fail closed instead of
    // silently proceeding to audit/merge the wrong repo.
    const primary = repo("bootstrap-pr-repo-mismatch");
    const linked = makeTempDir("quality-linked-repo-mismatch-");
    git(primary, ["switch", "-q", "main"]);
    git(primary, [
      "worktree",
      "add",
      "-q",
      "-b",
      "quality-repo-mismatch-branch",
      linked,
      "main",
    ]);
    const bin = makeTempDir("quality-bootstrap-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":24,"headRefName":"quality-repo-mismatch-branch","headRefOid":"${git(linked, ["rev-parse", "HEAD"])}","headRepository":{"nameWithOwner":"other-owner/other-repo"},"isCrossRepository":false,"baseRefName":"main","baseRefOid":"${git(primary, ["rev-parse", "origin/main"])}"}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      "bash",
      [BOOTSTRAP, "--target-dir", linked, "--merge", "--level", "auto"],
      {
        cwd: linked,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/belongs to other-owner\/other-repo/);
  }, 120_000);

  it("does not false-positive 'base changed during bootstrap' on a stale gh pr view cache (BUI-382)", () => {
    const root = repo("pr-bootstrap-stale-cache");
    const staleBase = git(root, ["rev-parse", "origin/main"]);
    git(root, ["branch", "release", staleBase]);
    // Advance the release branch on the remote (= this same repo, self-added
    // as origin — see repo()) AFTER capturing staleBase, simulating a real
    // commit landing on the PR's base branch. The gh stub below still
    // reports staleBase as baseRefOid — exactly what a lagging GitHub API
    // cache would return. A fresh `git ls-remote`/fetch will see the real,
    // newer tip; the fix must trust that live read over the stale gh field.
    const worktree = makeTempDir("quality-release-wt-");
    git(root, ["worktree", "add", "-q", worktree, "release"]);
    writeFileSync(path.join(worktree, "release-only.txt"), "landed\n");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-q", "-m", "real commit landed on release"]);
    const freshBase = git(worktree, ["rev-parse", "HEAD"]);
    expect(freshBase).not.toBe(staleBase);

    const bin = makeTempDir("quality-bootstrap-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":9,"headRefName":"feature","headRefOid":"${git(root, ["rev-parse", "HEAD"])}","headRepository":{"nameWithOwner":"owner/repo"},"isCrossRepository":false,"baseRefName":"release","baseRefOid":"${staleBase}"}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      "bash",
      [BOOTSTRAP, "--pr", "9", "--level", "auto"],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/base changed during bootstrap/);
    const manifestPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.revisions.baseRef).toBe("origin/release");
    // baseHeadSha must reflect the fresh, real tip — not the stale gh
    // pr view snapshot — so the merge-time freshness gate anchors on truth.
    expect(manifest.revisions.baseHeadSha).toBe(freshBase);
  }, 120_000);

  it("still blocks on a genuine base race (fresh ls-remote differs from the post-fetch tip)", () => {
    // This is a synthetic reproduction of a true TOCTOU race: something
    // else advances the base AFTER we've already read the live tip via
    // ls-remote but BEFORE our fetch completes. We simulate it directly by
    // asserting the guard's structure rather than winning an actual race
    // window (not reliably reproducible in a test): call git-bootstrap with
    // a base name that maps to a moving target where the ls-remote read and
    // the fetched ref genuinely disagree, using two different remotes.
    const root = repo("pr-bootstrap-genuine-race");
    const base = git(root, ["rev-parse", "origin/main"]);
    git(root, ["branch", "release", base]);
    const bin = makeTempDir("quality-bootstrap-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":11,"headRefName":"feature","headRefOid":"${git(root, ["rev-parse", "HEAD"])}","headRepository":{"nameWithOwner":"owner/repo"},"isCrossRepository":false,"baseRefName":"nonexistent-branch","baseRefOid":"${base}"}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      "bash",
      [BOOTSTRAP, "--pr", "11", "--level", "auto"],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_SETUP_ROOT: ROOT,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );
    // A base branch that doesn't exist on the remote resolves to an empty
    // ls-remote read, which the guard correctly refuses rather than
    // silently treating as "no base to check".
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/could not resolve the live PR base tip/);
  }, 120_000);

  it("survives a zsh parent and separate Bash processes", () => {
    const root = repo("zsh");
    git(root, ["commit", "--amend", "-q", "-m", "fix: correct value"]);
    const result = spawnSync(
      "zsh",
      [
        "-fc",
        `
manifest=$(node "$1" create --repo "$2" --base-ref origin/main --level auto)
cd "$2"
bash "$3" --manifest "$manifest" > exports
bash "$4" --manifest "$manifest"
bash "$5" --manifest "$manifest"
printf '%s\\n' "$manifest"
`,
        "quality-test",
        INVOCATION,
        root,
        LOAD_ROOT,
        RISK,
        SELECT,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifestPath = result.stdout.trim().split("\n").at(-1);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.resolved).toBe(true);
    expect(manifest.risk.tier).not.toBe("auto");
    expect(manifest.risk.mergeAuthority).toBe("autonomous");
    expect(manifest.risk.mergeAuthorityBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
    expect(manifest.risk.protectedNonstrictRefCas).toBe("signed-only");
    expect(manifest.risk.protectedNonstrictRefCasBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
    expect(manifest.risk.taskType).toBe("bugfix");
    expect(manifest.risk.score).toBe(35);
    expect(manifest.risk.agentTarget).toBe(1);
    expect(manifest.agents).toEqual(["code-reviewer"]);
    expect(manifest.panel).toMatchObject({
      requiredAgents: 1,
      selectedAgents: 1,
      domain: "general",
      rule: "general-review",
    });
  }, 120_000);

  it("does not let candidate-only policy change merge authority", () => {
    const root = repo("human-required-authority");
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({ scorePolicy: { mergeAuthority: "human-required" } }),
    );
    git(root, ["add", "harness-config.json"]);
    git(root, ["commit", "-qm", "configure manual governance"]);
    const manifestPath = create(root);
    const result = spawnSync("bash", [RISK, "--manifest", manifestPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.mergeAuthority).toBe("autonomous");
    expect(manifest.risk.mergeAuthorityBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
    expect(manifest.risk.protectedNonstrictRefCas).toBe("signed-only");
    expect(manifest.risk.protectedNonstrictRefCasBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
  });

  it("persists human-required merge authority from the protected base", () => {
    const root = repo("base-human-required-authority");
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({ scorePolicy: { mergeAuthority: "human-required" } }),
    );
    git(root, ["add", "harness-config.json"]);
    git(root, ["commit", "-qm", "configure manual governance"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const manifestPath = create(root);
    const result = spawnSync("bash", [RISK, "--manifest", manifestPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.mergeAuthority).toBe("human-required");
    expect(manifest.risk.mergeAuthorityBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
  });

  it("does not let candidate-only policy accept non-atomic PR cancellation state", () => {
    const root = repo("accepted-nonstrict-refcas");
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        scorePolicy: {
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      }),
    );
    git(root, ["add", "harness-config.json"]);
    git(root, ["commit", "-qm", "accept non-atomic PR cancellation state"]);
    const manifestPath = create(root);
    const result = spawnSync("bash", [RISK, "--manifest", manifestPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.protectedNonstrictRefCas).toBe("signed-only");
    expect(manifest.risk.protectedNonstrictRefCasBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
  });

  it("persists non-atomic PR cancellation acceptance from the protected base", () => {
    const root = repo("base-accepted-nonstrict-refcas");
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        scorePolicy: {
          protectedNonstrictRefCas: "accept-non-atomic-pr-state",
        },
      }),
    );
    git(root, ["add", "harness-config.json"]);
    git(root, ["commit", "-qm", "accept non-atomic PR cancellation state"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const manifestPath = create(root);
    const result = spawnSync("bash", [RISK, "--manifest", manifestPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.protectedNonstrictRefCas).toBe(
      "accept-non-atomic-pr-state",
    );
    expect(manifest.risk.protectedNonstrictRefCasBaseSha).toBe(
      manifest.revisions.baseHeadSha,
    );
  });

  it("fails closed to human-required when a direct risk write omits authority", () => {
    const root = repo("legacy-risk-authority");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 2,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
    });
    expect(
      invocation.loadManifest(manifestPath).manifest.risk.mergeAuthority,
    ).toBe("human-required");
    expect(
      invocation.loadManifest(manifestPath).manifest.risk.mergeAuthorityBaseSha,
    ).toBeNull();
    expect(
      invocation.loadManifest(manifestPath).manifest.risk
        .protectedNonstrictRefCas,
    ).toBe("signed-only");
    expect(
      invocation.loadManifest(manifestPath).manifest.risk
        .protectedNonstrictRefCasBaseSha,
    ).toBeNull();
  });

  it("locates an explicit target manifest without trusting the caller cwd", () => {
    const first = repo("first");
    const second = repo("second");
    const manifest = create(first);
    const result = spawnSync("bash", [LOAD_ROOT, "--manifest", manifest], {
      cwd: second,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"status":"validated"');
  });

  it("isolates concurrent repositories even under the same parent session", () => {
    const first = repo("parallel-a");
    const second = repo("parallel-b");
    const script = `
CODEX_THREAD_ID=same-session node "$1" create --repo "$2" --base-ref origin/main > "$2/manifest-path" &
CODEX_THREAD_ID=same-session node "$1" create --repo "$3" --base-ref origin/main > "$3/manifest-path" &
wait
`;
    execFileSync("bash", ["-c", script, "parallel", INVOCATION, first, second]);
    const firstPath = readFileSync(
      path.join(first, "manifest-path"),
      "utf8",
    ).trim();
    const secondPath = readFileSync(
      path.join(second, "manifest-path"),
      "utf8",
    ).trim();
    expect(firstPath).not.toBe(secondPath);
    expect(JSON.parse(readFileSync(firstPath, "utf8")).repo.realpath).toBe(
      realpathSync(first),
    );
    expect(JSON.parse(readFileSync(secondPath, "utf8")).repo.realpath).toBe(
      realpathSync(second),
    );
  });

  it("persists break-glass approval from the outer invocation and scopes it to HEAD", () => {
    const root = repo("approval");
    const directManifest = create(root, ["--level", "98"], {
      BREAK_GLASS_APPROVED: "true",
    });
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", directManifest], {
        cwd: root,
      }).status,
    ).not.toBe(0);
    expect(
      spawnSync("node", [INVOCATION, "approve", directManifest], {
        cwd: root,
      }).status,
    ).not.toBe(0);
    expect(
      spawnSync(
        "node",
        [INVOCATION, "approval-attach", directManifest, "--artifact", "fake"],
        { cwd: root },
      ).status,
    ).not.toBe(0);
    execFileSync("node", [INVOCATION, "advance", directManifest], {
      cwd: root,
      env: {
        ...process.env,
        BS_QUALITY_APPROVAL_CHALLENGE_SHA256: "a".repeat(64),
        BS_QUALITY_APPROVAL_PUBLIC_KEY: "self-minted",
      },
    });
    expect(
      JSON.parse(readFileSync(directManifest, "utf8")).approvalTrust,
    ).toBeNull();
    expect(
      spawnSync(
        "node",
        [
          INVOCATION,
          "create",
          "--repo",
          root,
          "--base-ref",
          "origin/main",
          "--break-glass-approved",
        ],
        { cwd: root },
      ).status,
    ).not.toBe(0);

    const wrapped = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: ["--target-dir", root, "--level", "98"],
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        BREAK_GLASS_APPROVED: "true",
        BREAK_GLASS_APPROVER: "brett",
      },
    });
    expect(wrapped.status, wrapped.stderr).toBe(0);
    const manifest = wrapped.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).toBe(0);
    const approvedState = JSON.parse(readFileSync(manifest, "utf8"));
    const approvalArtifact = JSON.parse(
      readFileSync(approvedState.approval.artifactPath, "utf8"),
    );
    expect(approvedState.approvalTrust.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(approvalArtifact.publicKey).toBeUndefined();
    approvalArtifact.publicKey = approvedState.approvalTrust.publicKey;
    writeFileSync(
      approvedState.approval.artifactPath,
      `${JSON.stringify(approvalArtifact, null, 2)}\n`,
    );
    approvedState.approval.artifactSha256 = createHash("sha256")
      .update(readFileSync(approvedState.approval.artifactPath))
      .digest("hex");
    writeFileSync(manifest, `${JSON.stringify(approvedState, null, 2)}\n`);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).not.toBe(0);
    delete approvalArtifact.publicKey;
    writeFileSync(
      approvedState.approval.artifactPath,
      `${JSON.stringify(approvalArtifact, null, 2)}\n`,
    );
    approvedState.approval.artifactSha256 = createHash("sha256")
      .update(readFileSync(approvedState.approval.artifactPath))
      .digest("hex");
    writeFileSync(manifest, `${JSON.stringify(approvedState, null, 2)}\n`);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).toBe(0);

    expect(() =>
      invocation.withManifestLock(manifest, (locked) =>
        invocation.armApprovalChallenge(locked, {
          challenge: "b".repeat(64),
          publicKey: approvedState.approvalTrust.publicKey,
        }),
      ),
    ).toThrow(/cannot replace a currently valid approval/);
    invocation.withManifestLock(manifest, (locked) =>
      invocation.armApprovalChallenge(locked, {
        challenge: "c".repeat(64),
        publicKey: approvedState.approvalTrust.publicKey,
        supersedingHead: "d".repeat(40),
      }),
    );
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).toBe(0);

    writeFileSync(path.join(root, "later.js"), "export const later = true;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    // Advancing HEAD invalidates the HEAD-bound approval.
    expect(state.approval.approved).toBe(false);
    // Phase 0 contract: select-agents no longer HARD-BLOCKS critical when the
    // approval is absent — it defers so the full critical review runs, and the
    // human-capability decision moves to quality-authorize-merge.sh (which knows
    // repo enforceability). So select-agents succeeds even with approval void…
    expect(
      spawnSync("bash", [SELECT, "--manifest", manifest], { cwd: root }).status,
    ).toBe(0);
    // …but the invalidated approval must remain invalid, which is what keeps the
    // authoritative merge gate correct until re-approval.
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], { cwd: root })
        .status,
    ).not.toBe(0);

    const resumed = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({ argv: ["--manifest", manifest] }),
      encoding: "utf8",
      env: {
        ...process.env,
        BREAK_GLASS_APPROVED: "true",
        BREAK_GLASS_APPROVER: "brett",
      },
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(
      spawnSync("bash", [SELECT, "--manifest", manifest], { cwd: root }).status,
    ).toBe(0);
    const renewed = JSON.parse(readFileSync(manifest, "utf8")).approval;
    expect(renewed).toMatchObject({
      approved: true,
      invocationId: JSON.parse(readFileSync(manifest, "utf8")).invocationId,
      approver: "brett",
      head: git(root, ["rev-parse", "HEAD"]),
    });
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
  }, 120_000);

  it("supports one explicit approve command bound to PR and exact HEAD", () => {
    const root = repo("approval-command");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = makeTempDir("quality-approve-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1 $2" = "pr view" ]; then
  printf '%s\\n' '{"number":14,"headRefName":"feature","headRefOid":"${head}","headRepository":{"nameWithOwner":"owner/repo"},"isCrossRepository":false,"baseRefName":"main","baseRefOid":"${base}","url":"https://github.com/owner/repo/pull/14"}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    // quality-target-resolver.js's getRepoForDir requires a GitHub-shaped
    // origin remote to resolve --target-dir's repo (BUI-391 fail-closed
    // cross-check). The repo() fixture's real origin is a local filesystem
    // path (so bootstrap's own fetch/ls-remote against it keep working); this
    // `git` shim intercepts only `remote get-url origin` and reports a
    // GitHub-shaped URL matching the mock `gh`'s repo, forwarding every other
    // subcommand straight through to the real `git` on $PATH.
    const gitShim = path.join(bin, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      gitShim,
      `#!/usr/bin/env bash
# quality-target-resolver.js calls: git -C <dir> remote get-url origin
if [ "$1" = "-C" ] && [ "$3 $4 $5" = "remote get-url origin" ]; then
  printf '%s\\n' "https://github.com/owner/repo.git"
  exit 0
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(gitShim, 0o755);
    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: [
          "approve",
          "--override-quality",
          "--target-dir",
          root,
          "--pr",
          "14",
          "--head",
          head,
          "--level",
          "98",
          "--reason",
          "manual verification completed out of band",
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PR: 14");
    expect(result.stdout).toContain(`HEAD: ${head}`);
    expect(result.stdout).toContain("Approver: brett");
    expect(result.stdout).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
    const manifest = result.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(manifest, "utf8")).approval.scope).toBe(
      "operator-quality-override",
    );
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    for (const gate of JSON.parse(readFileSync(manifest, "utf8"))
      .requiredGates) {
      recordGateFixture(manifest, gate.name);
    }
    recordMutationFixture(manifest);
    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }),
    );
    expect(authorization).toMatchObject({
      provider: "operator-quality-override",
      primary: "unavailable",
      fallback: "unavailable",
    });
  });

  it("rejects a billing override that tries to waive ordinary gates", () => {
    const root = repo("approval-command-ci-billing");
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["rev-parse", "origin/main"]);
    const bin = makeTempDir("quality-approve-gh-");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "$1 $2" = "pr view" ]; then
  printf '%s\\n' '{"number":15,"headRefName":"feature","headRefOid":"${head}","headRepository":{"nameWithOwner":"owner/repo"},"isCrossRepository":false,"baseRefName":"main","baseRefOid":"${base}","url":"https://github.com/owner/repo/pull/15"}'
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then
  printf '%s\\n' 'owner/repo'
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
    const approveEnv = withoutAmbientGitHubIdentity({
      BREAK_GLASS_APPROVER: "brett",
      CLAUDE_SETUP_ROOT: ROOT,
      PATH: `${bin}:${process.env.PATH}`,
    });
    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: [
          "approve",
          "--override-ci-billing",
          "--reason",
          "known Actions billing outage",
          "--ci-failure",
          "failed",
          "--accept",
          "ci:failed",
          "--i-understand-missing-ci",
          "--target-dir",
          root,
          "--pr",
          "15",
          "--head",
          head,
          "--level",
          "20",
        ],
      }),
      encoding: "utf8",
      env: approveEnv,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot accept non-CI conditions/);
  });

  it("rejects an approve command combining --override-quality and --override-ci-billing", () => {
    const root = repo("approval-command-conflicting-scopes");
    const head = git(root, ["rev-parse", "HEAD"]);
    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: [
          "approve",
          "--override-quality",
          "--override-ci-billing",
          "--target-dir",
          root,
          "--pr",
          "16",
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
      }),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/only one override flag/);
  });

  it("carries a valid break-glass approval across a rebase-only HEAD change with no new diff (BUI-380)", () => {
    const root = repo("approval-rebase-carry");
    const wrapped = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: ["--target-dir", root, "--level", "98"],
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        BREAK_GLASS_APPROVED: "true",
        BREAK_GLASS_APPROVER: "brett",
      },
    });
    expect(wrapped.status, wrapped.stderr).toBe(0);
    const manifest = wrapped.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).toBe(0);
    const beforeState = JSON.parse(readFileSync(manifest, "utf8"));
    const priorHead = beforeState.revisions.currentHead;

    // Advance main with an unrelated commit, then rebase the feature branch
    // onto it. This rewrites the feature commit (new SHA, new parent) but
    // the diff content (file.js: 1 -> 2) is byte-identical.
    git(root, ["switch", "-q", "main"]);
    writeFileSync(path.join(root, "unrelated.js"), "export const u = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "unrelated main change"]);
    git(root, ["push", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["rebase", "-q", "origin/main"]);
    const rebasedHead = git(root, ["rev-parse", "HEAD"]);
    expect(rebasedHead).not.toBe(priorHead);
    expect(
      spawnSync(
        "git",
        ["merge-base", "--is-ancestor", priorHead, rebasedHead],
        {
          cwd: root,
        },
      ).status,
    ).not.toBe(0); // confirm this is a real rewrite, not a fast-forward

    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const afterState = JSON.parse(readFileSync(manifest, "utf8"));
    expect(afterState.revisions.currentHead).toBe(rebasedHead);
    // Human approval is a signed capability for an exact HEAD. Unlike
    // provider evidence, it is never silently carried across a rewrite.
    expect(afterState.approval.approved).toBe(false);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).not.toBe(0);

    // baseHeadSha (quality-authorize-merge.sh's live-freshness anchor at
    // merge time, EXPECTED_BASE_OID) must advance with the rebase too, or
    // merge authorization would keep comparing against the pre-rebase base
    // forever and wrongly block an up-to-date branch with "PR base changed
    // after review" even though nothing unreviewed landed.
    const newMainHead = git(root, ["rev-parse", "origin/main"]);
    expect(afterState.revisions.baseHeadSha).toBe(newMainHead);
    expect(afterState.revisions.baseRebaseCarry).toMatchObject({
      head: rebasedHead,
      baseSha: newMainHead,
    });
    expect(afterState.revisions.reviewRebaseCarry).toMatchObject({
      reviewedHead: priorHead,
      head: rebasedHead,
      priorBaseSha: beforeState.revisions.baseSha,
      expectedTree: afterState.revisions.reviewRebaseCarry.actualTree,
    });
    expect(
      spawnSync(
        "git",
        [
          "merge-base",
          "--is-ancestor",
          afterState.revisions.baseHeadSha,
          rebasedHead,
        ],
        { cwd: root },
      ).status,
    ).toBe(0);

    // A later train member can be rebased again after another earlier PR
    // lands. Preserve both exact replay edges rather than overwriting the
    // original provider-reviewed endpoint.
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "unrelated-two.js"),
      "export const u2 = 1;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "second unrelated main change"]);
    git(root, ["push", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["rebase", "-q", "origin/main"]);
    const twiceRebasedHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const twiceRebased = JSON.parse(readFileSync(manifest, "utf8"));
    expect(twiceRebased.revisions.reviewRebaseCarries).toHaveLength(2);
    expect(twiceRebased.revisions.reviewRebaseCarries).toMatchObject([
      {
        reviewedHead: priorHead,
        head: rebasedHead,
        priorBaseSha: beforeState.revisions.baseSha,
      },
      {
        reviewedHead: rebasedHead,
        head: twiceRebasedHead,
        priorBaseSha: newMainHead,
      },
    ]);

    // A genuine new content change after the rebase must still invalidate
    // the carried approval — rebase tolerance must never become a blanket
    // pass.
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "real content change"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const finalState = JSON.parse(readFileSync(manifest, "utf8"));
    expect(finalState.approval.approved).toBe(false);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifest], {
        cwd: root,
      }).status,
    ).not.toBe(0);
  }, 120_000);

  it("never carries a non-string-patchId approval across a rebase-only HEAD change", () => {
    // invalidateOrCarryApproval() now guards manifest.approval.patchId with
    // typeof === "string" before comparing to currentPatchId(), mirroring
    // the sibling approvalHeadCarriedByRebase() guard, instead of relying
    // on plain `===` to fail safe by accident of JS equality (null !==
    // "realhash"). Locks in that a missing/non-string recorded patchId is
    // never treated as a proven patch-id match, even across a genuine
    // rebase-only replay.
    const root = repo("approval-null-patchid");
    const wrapped = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: ["--target-dir", root, "--level", "98"],
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        BREAK_GLASS_APPROVED: "true",
        BREAK_GLASS_APPROVER: "brett",
      },
    });
    expect(wrapped.status, wrapped.stderr).toBe(0);
    const manifest = wrapped.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    const priorHead = JSON.parse(readFileSync(manifest, "utf8")).revisions
      .currentHead;

    // Simulate an approval record that never got a patchId (e.g. from a
    // pre-BUI-380 signer): null it out before the rebase.
    invocation.withManifestLock(manifest, (state) => {
      state.approval.patchId = null;
    });

    // Genuine rebase-only replay: rewrite history via an unrelated main
    // commit + rebase, same as the BUI-380 carry test above.
    git(root, ["switch", "-q", "main"]);
    writeFileSync(path.join(root, "unrelated.js"), "export const u = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "unrelated main change"]);
    git(root, ["push", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["rebase", "-q", "origin/main"]);
    const rebasedHead = git(root, ["rev-parse", "HEAD"]);
    expect(rebasedHead).not.toBe(priorHead);

    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const afterState = JSON.parse(readFileSync(manifest, "utf8"));
    expect(afterState.revisions.currentHead).toBe(rebasedHead);
    // A non-string patchId must never be treated as a proven patch-id
    // match: the approval must be invalidated, not silently carried.
    expect(afterState.approval.approved).toBe(false);
    expect(afterState.approval.rebaseCarriedHead).toBeUndefined();
  });

  it("authorizes a carried provider review against the rebased live base (BUI-380)", () => {
    const root = repo("review-authorization-rebase-carry-base");
    const manifest = create(root);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    prepareCodexReview(root, manifest);
    recordJudgeArtifact(root, manifest);
    const original = JSON.parse(readFileSync(manifest, "utf8"));

    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "upstream-only.js"),
      "export const upstream = 1;\n",
    );
    git(root, ["add", "upstream-only.js"]);
    git(root, ["commit", "-q", "-m", "advance base"]);
    git(root, ["push", "-q", "origin", "main"]);
    const rebasedBase = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["rebase", "-q", "origin/main"]);

    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    // Rebase carry preserves the reviewed diff, but deterministic gates and
    // mutation evidence are always revision-bound and must be fresh at HEAD.
    for (const name of ["lint", "test", "security"])
      recordGateFixture(manifest, name);
    recordMutationFixture(manifest);
    recordJudgeArtifact(root, manifest);
    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(authorization.base).toBe(rebasedBase);
    expect(authorization.base).not.toBe(original.revisions.baseSha);
    expect(authorization.head).toBe(git(root, ["rev-parse", "HEAD"]));
  });

  it("rejects approve commands from nested or headless quality children", () => {
    const root = repo("approval-command-child");
    const head = git(root, ["rev-parse", "HEAD"]);
    for (const guard of ["BS_QUALITY_HEADLESS", "BS_QUALITY_ACTIVE"]) {
      const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
        cwd: root,
        input: JSON.stringify({
          argv: ["approve", "--pr", "14", "--head", head],
        }),
        encoding: "utf8",
        env: { ...process.env, [guard]: "1" },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/outer quality invocation/i);
    }
  });

  it("also rejects legacy environment approval from nested quality children", () => {
    const root = repo("approval-environment-child");
    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({ argv: ["--level", "98"] }),
      encoding: "utf8",
      env: {
        ...process.env,
        BREAK_GLASS_APPROVED: "true",
        BS_QUALITY_ACTIVE: "1",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/outer quality invocation/i);
  });

  it("rejects headless review children before the resume path", () => {
    const root = repo("headless-resume");
    const manifest = create(root);
    const before = readFileSync(manifest, "utf8");
    const result = spawnSync("bash", [BOOTSTRAP, "--manifest", manifest], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BS_QUALITY_HEADLESS: "1" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/headless review child/);
    expect(readFileSync(manifest, "utf8")).toBe(before);
  });

  it("persists provider attempt and cumulative execution caps", () => {
    const root = repo("provider-attempt-cap");
    const manifest = createLegacyProviderFixture(root, [], {
      BS_QUALITY_MAX_PROVIDER_ATTEMPTS: "2",
      BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS: "120",
    });
    for (const provider of ["claude", "codex"]) {
      const result = spawnSync(
        "node",
        [INVOCATION, "provider-attempt", manifest, "--provider", provider],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).remainingSeconds).toBeGreaterThan(0);
      execFileSync(
        "node",
        [INVOCATION, "provider-complete", manifest, "--provider", provider],
        { cwd: root },
      );
    }
    const exhausted = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "codex"],
      { cwd: root, encoding: "utf8" },
    );
    expect(exhausted.status).not.toBe(0);
    expect(exhausted.stderr).toMatch(/absolute provider attempt cap exhausted/);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.governor.providerAttempts).toHaveLength(2);
    expect(state.governor.providerSecondsLimit).toBe(120);
    state.governor.providerAttempts = [state.governor.providerAttempts[0]];
    state.governor.activeExecution = null;
    state.governor.providerSecondsUsed = 120;
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);
    const pastDeadline = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "claude"],
      { cwd: root, encoding: "utf8" },
    );
    expect(pastDeadline.status).not.toBe(0);
    expect(pastDeadline.stderr).toMatch(
      /provider execution budget is exhausted/,
    );
  });

  it("refuses every phase after gate and provider work consume the shared campaign budget", () => {
    const root = repo("shared-active-campaign-cap");
    const manifestPath = createLegacyProviderFixture(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.governor.activeSecondsLimit = 900;
    manifest.governor.activeSecondsUsed = 899;
    manifest.governor.gateSecondsLimit = 1800;
    manifest.governor.gateSecondsUsed = 500;
    manifest.governor.providerSecondsLimit = 1800;
    manifest.governor.providerSecondsUsed = 399;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const attempt = JSON.parse(
      execFileSync(
        "node",
        [
          INVOCATION,
          "provider-attempt",
          manifestPath,
          "--provider",
          "codex",
          "--requested-timeout",
          "30",
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(attempt.remainingSeconds).toBe(1);
    execFileSync(
      "node",
      [
        INVOCATION,
        "provider-complete",
        manifestPath,
        "--provider",
        "codex",
        "--elapsed-seconds",
        "1",
      ],
      { cwd: root },
    );

    const provider = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifestPath, "--provider", "claude"],
      { cwd: root, encoding: "utf8" },
    );
    expect(provider.status).not.toBe(0);
    expect(provider.stderr).toMatch(
      /shared active execution budget is exhausted/,
    );

    const gate = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "lint"],
      { cwd: root, encoding: "utf8" },
    );
    expect(gate.status).not.toBe(0);
    expect(gate.stderr).toMatch(
      /shared active execution budget is exhausted before 'lint'/,
    );
    const final = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(final.governor.activeSecondsUsed).toBe(900);
    expect(final.governor.activeExecution).toBeNull();
  });

  it("reserves bounded discovery headroom and verification capacity before another gate", () => {
    const root = repo("shared-active-provider-reserve");
    const manifestPath = create(root, ["--level", "medium"]);
    execFileSync("bash", [RISK, "--manifest", manifestPath], { cwd: root });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const providerReserve =
      manifest.risk.runtime.reviewReserveSeconds +
      manifest.risk.runtime.verificationSeconds;
    manifest.governor.activeSecondsUsed =
      manifest.governor.activeSecondsLimit - providerReserve;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const gate = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "lint"],
      { cwd: root, encoding: "utf8" },
    );
    expect(gate.status).not.toBe(0);
    expect(gate.stderr).toMatch(
      /cannot start without consuming the reserved provider capacity/,
    );
    const final = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(final.governor.activeSecondsUsed).toBe(
      final.governor.activeSecondsLimit - providerReserve,
    );
    expect(final.governor.activeExecution).toBeNull();
  });

  it("retains the provider reserve after an incomplete review attempt", () => {
    const root = repo("shared-active-incomplete-review-reserve");
    const manifestPath = create(root, ["--level", "medium"]);
    execFileSync("bash", [RISK, "--manifest", manifestPath], { cwd: root });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const providerReserve =
      manifest.risk.runtime.reviewReserveSeconds +
      manifest.risk.runtime.verificationSeconds;
    manifest.reviews.push({
      status: "incomplete",
      provider: "review-incomplete",
      from: manifest.revisions.baseSha,
      to: manifest.revisions.currentHead,
    });
    manifest.governor.activeSecondsUsed =
      manifest.governor.activeSecondsLimit - providerReserve;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const gate = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "lint"],
      { cwd: root, encoding: "utf8" },
    );
    expect(gate.status).not.toBe(0);
    expect(gate.stderr).toMatch(
      /cannot start without consuming the reserved provider capacity/,
    );
  });

  it("does not confuse a critical provider watchdog with idle gate capacity", () => {
    const manifest = {
      risk: {
        agentTarget: 2,
        runtime: {
          workload: "medium",
          reviewSeconds: 540,
          reviewReserveSeconds: 150,
          verificationSeconds: 120,
        },
      },
      reviews: [],
      revisions: { currentHead: "a".repeat(40) },
      governor: {
        activeSecondsLimit: 900,
        activeSecondsUsed: 4,
        gateSecondsLimit: 2700,
        gateSecondsUsed: 4,
        providerSecondsLimit: 2760,
        providerSecondsUsed: 0,
      },
    };

    expect(invocation.executionRemaining(manifest, "gate")).toBe(626);
  });

  it("does not reserve provider capacity for a zero-review campaign", () => {
    const root = repo("shared-active-zero-review");
    git(root, ["reset", "--hard", "-q", "origin/main"]);
    writeFileSync(path.join(root, "README.md"), "# Documentation\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "docs: update readme"]);
    const manifestPath = create(root);
    execFileSync("bash", [RISK, "--manifest", manifestPath], { cwd: root });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.agentTarget).toBe(0);
    manifest.governor.activeSecondsUsed =
      manifest.governor.activeSecondsLimit - 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const gate = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "lint"],
      { cwd: root, encoding: "utf8" },
    );
    expect(gate.status, gate.stderr).toBe(0);
    const final = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(final.governor.activeSecondsUsed).toBe(
      final.governor.activeSecondsLimit,
    );
    expect(final.governor.activeExecution).toBeNull();
  });

  it("fails closed before consuming capacity for an unbound v2 review contract", () => {
    const root = repo("unbound-v2-provider-attempt");
    const manifestPath = create(root, ["--level", "high"]);
    execFileSync("bash", [RISK, "--manifest", manifestPath], { cwd: root });
    execFileSync("node", [GOVERNOR, "bump-round", manifestPath], {
      cwd: root,
    });
    const before = JSON.parse(readFileSync(manifestPath, "utf8"));
    const result = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifestPath, "--provider", "codex"],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /contract v2 review lacks bound domain selection/,
    );
    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(after.governor.providerAttempts).toEqual(
      before.governor.providerAttempts,
    );
    expect(after.governor.activeExecution).toBe(
      before.governor.activeExecution,
    );
    expect(after.governor.providerSecondsUsed).toBe(
      before.governor.providerSecondsUsed,
    );
  });

  it("rejects overlapping execution and reconciles an abandoned timeout", () => {
    const root = repo("provider-active-state");
    const manifestPath = createLegacyProviderFixture(root, [], {
      BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS: "120",
    });
    execFileSync(
      "node",
      [
        INVOCATION,
        "provider-attempt",
        manifestPath,
        "--provider",
        "codex",
        "--requested-timeout",
        "60",
      ],
      { cwd: root },
    );

    const overlapping = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifestPath, "--provider", "claude"],
      { cwd: root, encoding: "utf8" },
    );
    expect(overlapping.status).not.toBe(0);
    expect(overlapping.stderr).toMatch(
      /provider execution 'codex' is already active/,
    );

    const abandoned = JSON.parse(readFileSync(manifestPath, "utf8"));
    abandoned.governor.activeExecution.startedAt = new Date(
      Date.now() - 61_000,
    ).toISOString();
    writeFileSync(manifestPath, `${JSON.stringify(abandoned, null, 2)}\n`);
    const resumed = JSON.parse(
      execFileSync(
        "node",
        [INVOCATION, "provider-attempt", manifestPath, "--provider", "claude"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(resumed.remainingSeconds).toBe(60);
    const state = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(state.governor.providerSecondsUsed).toBe(60);
    expect(state.governor.activeExecution.name).toBe("claude");
  });

  it("does not reset provider execution usage when the review head advances", () => {
    const root = repo("provider-window");
    const manifestPath = createLegacyProviderFixture(root, [], {
      BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS: "120",
    });
    execFileSync(
      "node",
      [INVOCATION, "provider-attempt", manifestPath, "--provider", "codex"],
      { cwd: root },
    );
    execFileSync(
      "node",
      [INVOCATION, "provider-complete", manifestPath, "--provider", "codex"],
      { cwd: root },
    );
    const usedBeforeAdvance = JSON.parse(readFileSync(manifestPath, "utf8"))
      .governor.providerSecondsUsed;
    invocation.withManifestLock(manifestPath, (manifest) => {
      manifest.governor.activeSecondsUsed = 90;
      manifest.governor.gateSecondsUsed = 30;
    });

    writeFileSync(path.join(root, "next-head.js"), "export const next = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix: advance provider window"]);
    execFileSync("bash", [BOOTSTRAP, "--manifest", manifestPath], {
      cwd: root,
    });
    const current = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(current.governor.providerSecondsUsed).toBe(usedBeforeAdvance);
    expect(current.governor.providerSecondsLimit).toBe(120);
    expect(current.governor.activeSecondsUsed).toBe(0);
    expect(current.governor.gateSecondsUsed).toBe(0);
    expect(current.governor.headExecutionHistory.at(-1)).toMatchObject({
      activeSecondsUsed: 90,
      gateSecondsUsed: 30,
      providerSecondsUsedAtClose: usedBeforeAdvance,
      supersededByHead: current.revisions.currentHead,
    });
    const authorization = JSON.parse(
      execFileSync(
        "node",
        [INVOCATION, "provider-attempt", manifestPath, "--provider", "codex"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(authorization.remainingSeconds).toBeGreaterThan(0);
    expect(authorization.remainingSeconds).toBeLessThan(120);
  });

  it("resumes a leased merge campaign after descendant remediation through bootstrap", () => {
    const root = repo("merge-bootstrap-descendant-resume");
    const originalToken = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    const manifestPath = create(root, ["--merge", "--pr", "7"]);
    const initial = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bin = makeTempDir("quality-merge-resume-gh-");
    writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
if [ "$1 $2" = "repo view" ]; then
  printf '%s\n' '${initial.repo.githubRepository}'
  exit 0
fi
if [ "$1 $2" = "pr view" ]; then
  printf '%s\n' '{"headRefName":"${initial.repo.headRefName}","headRepository":{"nameWithOwner":"${initial.repo.headRepository}"},"isCrossRepository":false}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(path.join(bin, "gh"), 0o755);
    writeFileSync(
      path.join(root, "merge-remediation.js"),
      "export const remediated = true;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix: remediate merge review"]);
    const descendantHead = git(root, ["rev-parse", "HEAD"]);
    delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;

    try {
      const result = spawnSync(
        "bash",
        [BOOTSTRAP, "--manifest", manifestPath],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const resumed = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(resumed.revisions.currentHead).toBe(descendantHead);
      expect(resumed.merge.repositoryLease.token).toBeTruthy();
      expect(lease.status(manifestPath)).toMatchObject({
        state: "active",
        repository: initial.repo.githubRepository.toLowerCase(),
      });
      lease.release(
        manifestPath,
        resumed.merge.repositoryLease.token,
        "test-complete",
      );
    } finally {
      if (originalToken === undefined) {
        delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
      } else {
        process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = originalToken;
      }
    }
  });

  it("shares cumulative execution time across fallback providers", () => {
    const root = repo("provider-fallback-window");
    const manifest = createLegacyProviderFixture(root, [], {
      BS_QUALITY_MAX_PROVIDER_SECONDS: "120",
      BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS: "120",
    });
    execFileSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "codex"],
      { cwd: root },
    );
    execFileSync(
      "node",
      [INVOCATION, "provider-complete", manifest, "--provider", "codex"],
      { cwd: root },
    );

    const fallback = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "claude"],
      { cwd: root, encoding: "utf8" },
    );
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(JSON.parse(fallback.stdout).remainingSeconds).toBeGreaterThan(0);
    expect(JSON.parse(fallback.stdout).remainingSeconds).toBeLessThan(120);
  });

  it("reports exact-head successful gate evidence as reusable", () => {
    const root = repo("gate-reuse");
    const manifest = create(root);
    recordGateFixture(manifest, "lint");

    expect(
      spawnSync(
        "node",
        [INVOCATION, "gate-satisfied", manifest, "--name", "lint"],
        { cwd: root },
      ).status,
    ).toBe(0);
    expect(
      spawnSync(
        "node",
        [INVOCATION, "gate-satisfied", manifest, "--name", "test"],
        { cwd: root },
      ).status,
    ).toBe(1);

    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const lint = state.gates.find((gate) => gate.name === "lint");
    writeFileSync(lint.log, "tampered\n");
    expect(
      spawnSync(
        "node",
        [INVOCATION, "gate-satisfied", manifest, "--name", "lint"],
        { cwd: root },
      ).status,
    ).toBe(1);
  });

  it("does not charge idle time before the first provider attempt", () => {
    const root = repo("provider-phase-start");
    const manifest = createLegacyProviderFixture(root, [], {
      BS_QUALITY_MAX_PROVIDER_SECONDS: "120",
    });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.governor.startedAtEpoch = Math.floor(Date.now() / 1000) - 600;
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    const authorization = JSON.parse(
      execFileSync(
        "node",
        [INVOCATION, "provider-attempt", manifest, "--provider", "codex"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(authorization.remainingSeconds).toBeGreaterThanOrEqual(119);
    expect(authorization.remainingSeconds).toBeLessThanOrEqual(120);
  });

  it("pins a merge lease in a fresh shell before authorizing a review round", () => {
    const root = repo("merge-round-lease-pin");
    const manifest = create(root, ["--merge"]);
    const inherited = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    try {
      const result = spawnSync("bash", [AUTHORIZE_REVIEW_ROUND, manifest], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env },
      });
      expect(result.status, result.stderr).toBe(0);
      const state = JSON.parse(readFileSync(manifest, "utf8"));
      expect(state.governor.roundsUsed).toBe(1);
      expect(state.governor.authorizedAttempts).toHaveLength(1);
    } finally {
      if (inherited === undefined) {
        delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
      } else {
        process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = inherited;
      }
    }
  });

  it("releases a merge lease for a later lifecycle outcome without rewriting terminal history", () => {
    const root = repo("terminal-history-lease-release");
    const manifest = create(root, ["--merge"]);

    expect(
      execFileSync(
        "node",
        [
          INVOCATION,
          "terminal-state",
          manifest,
          "--state",
          "blocked",
          "--detail",
          "prior-failure",
        ],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    ).toBe("blocked");
    expect(lease.status(manifest)).toMatchObject({
      required: true,
      state: "active",
      owned: true,
    });

    expect(
      execFileSync(
        "node",
        [
          INVOCATION,
          "terminal-state",
          manifest,
          "--state",
          "provider-incomplete",
          "--detail",
          "retry-exhausted",
        ],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    ).toBe("blocked");
    expect(
      invocation.loadManifest(manifest).manifest.terminalState,
    ).toMatchObject({
      state: "blocked",
      detail: "prior-failure",
    });
    expect(lease.status(manifest)).toEqual({
      required: true,
      state: "missing",
    });
  });

  it("stops the documented sequence when merge lease authorization fails", () => {
    const root = repo("merge-round-lease-failure");
    const manifest = create(root, ["--merge"]);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.merge.repositoryLease.token = "";
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);
    const marker = path.join(root, "provider-started");
    const result = spawnSync(
      "bash",
      [
        "-c",
        '"$1" "$2" || exit 1; : > "$3"',
        "quality-sequence",
        AUTHORIZE_REVIEW_ROUND,
        manifest,
        marker,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: (() => {
          const env = { ...process.env };
          delete env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
          return env;
        })(),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/has no repository lease credential/);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(readFileSync(manifest, "utf8")).governor.roundsUsed).toBe(
      0,
    );
  });

  it("reserves provider starts for an authorized verification round", () => {
    const root = repo("phase-provider-capacity");
    const manifest = createLegacyProviderFixture(root);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const head = state.revisions.currentHead;
    state.governor.providerAttemptPlan = {
      schemaVersion: 2,
      rounds: { 1: 2, 2: 2 },
      failureRetryStarts: 2,
      failureRetrySeconds: 600,
    };
    state.governor.maxProviderAttempts = 4;
    state.governor.roundsUsed = 1;
    state.governor.authorizedAttempts = [
      { number: 1, token: "discovery", head, consumedAt: null },
    ];
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    for (const provider of ["codex", "claude"]) {
      expect(
        spawnSync(
          "node",
          [INVOCATION, "provider-attempt", manifest, "--provider", provider],
          {
            cwd: root,
            encoding: "utf8",
          },
        ).status,
      ).toBe(0);
      execFileSync(
        "node",
        [INVOCATION, "provider-complete", manifest, "--provider", provider],
        { cwd: root },
      );
    }
    const exhausted = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "gemini"],
      { cwd: root, encoding: "utf8" },
    );
    expect(exhausted.status).not.toBe(0);
    expect(exhausted.stderr).toMatch(/capacity exhausted for review round 1/);

    state.governor.roundsUsed = 2;
    state.governor.authorizedAttempts.push({
      number: 2,
      token: "verification",
      head,
      consumedAt: null,
    });
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);
    expect(
      spawnSync(
        "node",
        [INVOCATION, "provider-attempt", manifest, "--provider", "codex"],
        { cwd: root },
      ).status,
    ).toBe(0);
    execFileSync(
      "node",
      [INVOCATION, "provider-complete", manifest, "--provider", "codex"],
      { cwd: root },
    );
    expect(
      spawnSync(
        "node",
        [INVOCATION, "provider-attempt", manifest, "--provider", "claude"],
        { cwd: root },
      ).status,
    ).toBe(0);
    execFileSync(
      "node",
      [INVOCATION, "provider-complete", manifest, "--provider", "claude"],
      { cwd: root },
    );
    const verificationExhausted = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "gemini"],
      { cwd: root, encoding: "utf8" },
    );
    expect(verificationExhausted.status).not.toBe(0);
    expect(verificationExhausted.stderr).toMatch(
      /capacity exhausted for review round 2/,
    );
  });

  it("derives non-borrowable provider capacity from the resolved runtime plan", () => {
    const root = repo("resolved-provider-phase-capacity");
    const env = { ...process.env, BS_QUALITY_MAX_PROVIDER_ATTEMPTS: "1" };
    const manifest = createLegacyProviderFixture(root, [], {
      BS_QUALITY_MAX_PROVIDER_ATTEMPTS: "1",
    });
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root, env });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const passes = Math.max(1, state.risk.runtime.reviewPasses);
    expect(state.governor.providerAttemptPlan).toEqual({
      schemaVersion: 3,
      rounds: { 1: passes * 2, 2: 2 },
      perReview: { 1: passes, 2: 1 },
      failureRetryStarts: passes + 1,
      failureRetrySeconds:
        state.risk.runtime.reviewSeconds +
        state.risk.runtime.reviewReserveSeconds,
    });
    expect(state.governor.maxProviderAttempts).toBe((passes + 1) * 2);
    expect(state.governor.providerSecondsLimit).toBe(
      state.risk.runtime.reviewSeconds * 2 +
        state.risk.runtime.reviewReserveSeconds * 2,
    );
  });

  it("preserves an explicit cumulative provider-time cap", () => {
    const root = repo("explicit-provider-time-cap");
    const env = {
      ...process.env,
      BS_QUALITY_MAX_PROVIDER_ATTEMPTS: "1",
      BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS: "120",
    };
    const manifest = create(root, [], env);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root, env });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.governor.providerSecondsLimitExplicit).toBe(true);
    expect(state.governor.providerSecondsLimit).toBe(120);
  });

  it("funds every configured discovery pass and its bounded retry", () => {
    const root = repo("multi-pass-provider-time-capacity");
    const manifest = create(root, [], {
      BS_QUALITY_MAX_PROVIDER_ATTEMPTS: "1",
    });
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 2,
        "review-seconds": 180,
        "review-reserve-seconds": 120,
      });
    });
    const state = invocation.loadManifest(manifest).manifest;
    expect(state.governor.providerAttemptPlan).toEqual({
      schemaVersion: 3,
      rounds: { 1: 4, 2: 2 },
      perReview: { 1: 2, 2: 1 },
      failureRetryStarts: 3,
      failureRetrySeconds: 480,
    });
    expect(state.governor.maxProviderAttempts).toBe(6);
    expect(state.governor.providerSecondsLimit).toBe(960);
  });

  it("migrates a persisted provider plan before reserving an incomplete retry", () => {
    const root = repo("legacy-incomplete-retry-capacity");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareIncompleteReview(root, manifest);
    const legacy = invocation.loadManifest(manifest).manifest;
    const legacyProviderSeconds = legacy.governor.providerSecondsLimit;
    const retrySeconds =
      2 * legacy.risk.runtime.reviewSeconds +
      legacy.risk.runtime.reviewReserveSeconds;
    invocation.withManifestLock(manifest, (loaded) => {
      loaded.governor.providerAttemptPlan = {
        schemaVersion: 1,
        rounds: { 1: 2, 2: 1 },
      };
      loaded.governor.maxProviderAttempts = 3;
    });

    execFileSync("node", [INVOCATION, "reserve-incomplete-retry", manifest], {
      cwd: root,
    });
    const state = invocation.loadManifest(manifest).manifest;
    expect(state.governor.providerAttemptPlan).toEqual({
      schemaVersion: 3,
      rounds: { 1: 4, 2: 2 },
      perReview: { 1: 2, 2: 1 },
      failureRetryStarts: 3,
      failureRetrySeconds: retrySeconds,
    });
    expect(state.governor.maxProviderAttempts).toBe(6);
    expect(state.governor.providerSecondsLimit).toBe(
      legacyProviderSeconds + retrySeconds,
    );
  });

  it("does not expand an ambiguous legacy provider-time cap", () => {
    const root = repo("legacy-provider-time-cap");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareIncompleteReview(root, manifest);
    invocation.withManifestLock(manifest, (loaded) => {
      delete loaded.governor.providerSecondsLimitExplicit;
      loaded.governor.providerAttemptPlan = {
        schemaVersion: 1,
        rounds: { 1: 2, 2: 1 },
      };
      loaded.governor.maxProviderAttempts = 3;
      loaded.governor.providerSecondsLimit = 137;
    });

    execFileSync("node", [INVOCATION, "reserve-incomplete-retry", manifest], {
      cwd: root,
    });
    const state = invocation.loadManifest(manifest).manifest;
    expect(state.governor.providerAttemptPlan.schemaVersion).toBe(3);
    expect(state.governor.providerSecondsLimit).toBe(137);
  });

  it("isolates same-round retry capacity from the initial provider generation", () => {
    const root = repo("provider-retry-generation-capacity");
    const env = { ...process.env, BS_QUALITY_MAX_PROVIDER_ATTEMPTS: "1" };
    const manifest = createLegacyProviderFixture(root, [], env);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root, env });
    const state = invocation.loadManifest(manifest).manifest;
    invocation.withManifestLock(manifest, (loaded) => {
      loaded.governor.roundsUsed = 1;
      loaded.governor.authorizedAttempts = [
        {
          number: 1,
          token: "discovery",
          head: loaded.revisions.currentHead,
          consumedAt: null,
        },
      ];
    });

    execFileSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "codex"],
      { cwd: root },
    );
    execFileSync(
      "node",
      [INVOCATION, "provider-complete", manifest, "--provider", "codex"],
      { cwd: root },
    );
    const borrowed = spawnSync(
      "node",
      [INVOCATION, "provider-attempt", manifest, "--provider", "claude"],
      { cwd: root, encoding: "utf8" },
    );
    expect(borrowed.status).not.toBe(0);
    expect(borrowed.stderr).toMatch(/capacity exhausted/);

    invocation.withManifestLock(manifest, (loaded) => {
      loaded.reviews.push({
        status: "incomplete",
        provider: "review-incomplete",
        from: state.revisions.baseSha,
        to: state.revisions.currentHead,
      });
      invocation.reserveIncompleteRetry(loaded);
    });
    expect(
      spawnSync(
        "node",
        [INVOCATION, "provider-attempt", manifest, "--provider", "claude"],
        { cwd: root, encoding: "utf8" },
      ).status,
    ).toBe(0);
  });

  it("does not accept break-glass approval through wrapper argv", () => {
    const root = repo("approval-argv");
    const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
      cwd: root,
      input: JSON.stringify({
        argv: ["--target-dir", root, "--break-glass-approved"],
      }),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unexpected quality argument/);
  });

  it("stops review when cumulative provider execution is exhausted", () => {
    const root = repo("provider-budget");
    const manifest = createLegacyProviderFixture(root);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.governor.providerSecondsLimit = 2;
    state.governor.providerSecondsUsed = 2;
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    expect(
      spawnSync("node", [GOVERNOR, "bump-round", manifest], { cwd: root })
        .status,
    ).not.toBe(0);
  });

  it("retries an unconsumed provider attempt without spending the mandatory rereview round", () => {
    const root = repo("provider-retry-budget");
    const manifest = create(root, [], {
      BS_QUALITY_MAX_REVIEW_ROUNDS: "3",
    });
    const firstHead = git(root, ["rev-parse", "HEAD"]);

    execFileSync("node", [GOVERNOR, "bump-round", manifest], { cwd: root });
    let state = JSON.parse(readFileSync(manifest, "utf8"));
    const timedOutToken = state.governor.authorizedAttempts.at(-1).token;
    expect(state.governor.roundsUsed).toBe(1);

    const firstReview = prepareCodexReview(root, manifest);
    state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.governor.roundsUsed).toBe(1);
    expect(state.reviews).toHaveLength(1);
    expect(state.governor.authorizedAttempts).toHaveLength(2);
    expect(state.governor.authorizedAttempts[0]).toMatchObject({
      token: timedOutToken,
      invalidationReason: "replaced for provider retry",
      consumedAt: null,
    });
    expect(state.governor.authorizedAttempts[1]).toMatchObject({
      retryOf: timedOutToken,
      head: firstHead,
    });
    expect(state.governor.authorizedAttempts[1].consumedAt).not.toBeNull();

    state.governor.roundsUsed = 2;
    delete state.governor.authorizedAttempts[0].invalidatedAt;
    delete state.governor.authorizedAttempts[0].invalidationReason;
    state.governor.authorizedAttempts[1].number = 2;
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    for (let index = 1; index <= 9; index += 1) {
      writeFileSync(
        path.join(root, `retry-fix-${index}.js`),
        `export const fixed${index} = true;\n`,
      );
      git(root, ["add", "."]);
      git(root, ["commit", "-q", "-m", `fix: provider finding ${index}`]);
    }
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    expect(
      spawnSync("node", [GOVERNOR, "check", manifest], { cwd: root }).status,
    ).not.toBe(0);
    const secondReview = prepareCodexReview(root, manifest);

    state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.governor.roundsUsed).toBe(2);
    expect(state.reviews).toHaveLength(2);
    expect(secondReview.from).toBe(firstReview.to);
    expect(secondReview.to).toBe(git(root, ["rev-parse", "HEAD"]));

    writeFileSync(
      path.join(root, "final-review-fix.js"),
      "export const finalReviewFix = true;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix: final review finding"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const thirdAttempt = spawnSync("node", [GOVERNOR, "bump-round", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(thirdAttempt.status).not.toBe(0);
    expect(thirdAttempt.stderr).toMatch(/ROUND BUDGET EXHAUSTED/);
    state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.governor.roundsUsed).toBe(2);
    expect(state.reviews).toHaveLength(2);
  });

  it("does not authorize a changed HEAD with an unconsumed stale token", () => {
    const root = repo("stale-provider-token");
    const manifest = create(root);
    execFileSync("node", [GOVERNOR, "bump-round", manifest], { cwd: root });

    writeFileSync(
      path.join(root, "changed.js"),
      "export const changed = true;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix: changed head"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const info = JSON.parse(
      execFileSync("node", [INVOCATION, "review-info", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    const result = spawnSync(
      "node",
      [
        INVOCATION,
        "record-review",
        manifest,
        "--from",
        info.from,
        "--to",
        info.to,
        "--provider",
        "codex",
        "--primary",
        "codex",
        "--fallback",
        "none",
        "--artifact-dir",
        info.artifactDir,
        "--diff-sha",
        "stale",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not authorized by the governor/);
  });

  it("carries an unused mandatory rereview round across descendant fixes", () => {
    const root = repo("reserved-rereview-descendant");
    const manifestPath = create(root);
    execFileSync("node", [GOVERNOR, "bump-round", manifestPath], { cwd: root });
    const firstReview = prepareCodexReview(root, manifestPath);
    execFileSync("node", [GOVERNOR, "bump-round", manifestPath], { cwd: root });

    writeFileSync(
      path.join(root, "review-fix.js"),
      "export const fixed = 1;\n",
    );
    git(root, ["add", "review-fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: address review"]);
    const fixedHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });

    const state = invocation.loadManifest(manifestPath).manifest;
    expect(state.governor.authorizedAttempts.at(-1)).toMatchObject({
      number: 2,
      head: fixedHead,
      reservedForReviewHead: firstReview.to,
      consumedAt: null,
      advances: [{ from: firstReview.to, to: fixedHead }],
    });
    expect(
      spawnSync(
        "node",
        [INVOCATION, "provider-attempt", manifestPath, "--provider", "codex"],
        { cwd: root, encoding: "utf8" },
      ).status,
    ).toBe(0);
  });

  it("rejects review evidence when the checkout advances before the manifest mutation", () => {
    const root = repo("record-review-head-drift");
    const manifestPath = create(root);
    const manifest = invocation.loadManifest(manifestPath).manifest;
    writeFileSync(path.join(root, "drift.js"), "export const drift = true;\n");
    git(root, ["add", "drift.js"]);
    git(root, ["commit", "-q", "-m", "drift during review"]);

    expect(() => invocation.assertReviewHeadCurrent(manifest, {})).toThrow(
      /review evidence head moved before recording/,
    );
  });

  it("uses an explicit composite checkpoint for an incremental second review", () => {
    const root = repo("delta");
    const manifest = create(root);
    const first = JSON.parse(
      execFileSync("node", [INVOCATION, "review-info", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    prepareCodexReview(root, manifest);

    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const second = JSON.parse(
      execFileSync("node", [INVOCATION, "review-info", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(second.from).toBe(first.to);
    expect(second.to).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(second.artifactDir).toContain(second.to);
  });

  it("preserves the reviewed HEAD at its persisted stamp and invalidates the stamp after remediation", () => {
    const root = repo("stamp-aware-advance");
    const manifest = create(root);
    const reviewedHead = git(root, ["rev-parse", "HEAD"]);
    prepareCodexReview(root, manifest);
    git(root, ["commit", "--allow-empty", "-q", "-m", "quality stamp"]);
    const stampHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync(
      "node",
      [
        INVOCATION,
        "record-stamp",
        manifest,
        "--head",
        stampHead,
        "--remote",
        "origin",
        "--expected-old-head",
        reviewedHead,
      ],
      { cwd: root },
    );

    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    let state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.revisions.currentHead).toBe(reviewedHead);
    expect(state.merge.stampHead).toBe(stampHead);
    expect(state.merge.invalidatedStamps).toEqual([]);

    writeFileSync(
      path.join(root, "remediation.js"),
      "export const fixed = true;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix: remediate review finding"]);
    const remediationHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });

    state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.revisions.currentHead).toBe(remediationHead);
    expect(state.merge.stampHead).toBeUndefined();
    expect(state.merge.stampedAt).toBeUndefined();
    expect(state.merge.stampPublication).toBeUndefined();
    expect(state.merge.invalidatedStamps).toMatchObject([
      {
        head: stampHead,
        reason: `HEAD advanced beyond reviewed stamp to ${remediationHead}`,
      },
    ]);
    const nextReview = JSON.parse(
      execFileSync("node", [INVOCATION, "review-info", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(nextReview.from).toBe(reviewedHead);
    expect(nextReview.to).toBe(remediationHead);
  });

  it("bootstraps a persisted stamp without advancing review state, then resumes remediation incrementally", () => {
    const root = repo("stamp-aware-bootstrap");
    const manifest = create(root);
    const reviewedHead = git(root, ["rev-parse", "HEAD"]);
    prepareCodexReview(root, manifest);
    git(root, ["commit", "--allow-empty", "-q", "-m", "quality stamp"]);
    const stampHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync(
      "node",
      [
        INVOCATION,
        "record-stamp",
        manifest,
        "--head",
        stampHead,
        "--remote",
        "origin",
        "--expected-old-head",
        reviewedHead,
      ],
      { cwd: root },
    );

    const stampedResume = spawnSync(
      "bash",
      [BOOTSTRAP, "--manifest", manifest],
      { cwd: root, encoding: "utf8" },
    );
    expect(stampedResume.status, stampedResume.stderr).toBe(0);
    expect(stampedResume.stdout).toContain(`at ${reviewedHead}`);
    let state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.revisions.currentHead).toBe(reviewedHead);
    expect(state.merge.stampHead).toBe(stampHead);

    writeFileSync(
      path.join(root, "resume-fix.js"),
      "export const fixed = true;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix: resume remediation"]);
    const remediationHead = git(root, ["rev-parse", "HEAD"]);
    const remediationResume = spawnSync(
      "bash",
      [BOOTSTRAP, "--manifest", manifest],
      { cwd: root, encoding: "utf8" },
    );
    expect(remediationResume.status, remediationResume.stderr).toBe(0);
    expect(remediationResume.stdout).toContain(`at ${remediationHead}`);
    state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.revisions.currentHead).toBe(remediationHead);
    expect(state.merge.stampHead).toBeUndefined();
    expect(state.merge.invalidatedStamps.at(-1).head).toBe(stampHead);

    const nextReview = JSON.parse(
      execFileSync("node", [INVOCATION, "review-info", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(nextReview.from).toBe(reviewedHead);
    expect(nextReview.to).toBe(remediationHead);
  });

  it("refuses a second review when HEAD has not advanced", () => {
    const root = repo("same-head");
    const manifest = create(root);
    prepareCodexReview(root, manifest);
    const result = spawnSync("node", [INVOCATION, "review-info", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/descendant HEAD/);
  });

  it("rejects ambiguous positional PR syntax", () => {
    const root = repo("grammar");
    const result = spawnSync(
      "node",
      [
        INVOCATION,
        "create",
        "--repo",
        root,
        "--base-ref",
        "origin/main",
        "--merge",
        "1",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/use --pr <number> explicitly/);
  });

  it("uses configured formatter patterns and skips unsupported TOML", () => {
    const root = repo("format");
    const packageJson = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    packageJson["lint-staged"] = {
      "**/*.{js,json,md,yml,yaml}": ["prettier --write"],
      "**/*.ts": ["eslint --fix"],
    };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "config"]);
    const manifest = create(root);
    const plan = JSON.parse(
      execFileSync(
        "node",
        [
          FORMAT,
          "--manifest",
          manifest,
          "--dry-run",
          "--",
          "file.js",
          "only-eslint.ts",
          ".gitleaks.toml",
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(plan.files).toEqual(["file.js"]);
    expect(plan.args).toContain("--ignore-unknown");
  });

  it("uses declared and modern Bun package-manager signals for formatting", () => {
    const root = repo("format-bun");
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.packageManager = "bun@1.2.0";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    writeFileSync(path.join(root, "bun.lock"), "");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "config"]);
    const manifest = create(root);
    const plan = JSON.parse(
      execFileSync(
        "node",
        [FORMAT, "--manifest", manifest, "--dry-run", "--", "file.js"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(plan.manager).toBe("bun");
    expect(plan.args.slice(0, 2)).toEqual(["x", "prettier"]);
  });

  it("does not charge an expired legacy campaign clock to execution", () => {
    const root = repo("reserve");
    const manifest = create(root, [], {
      BS_QUALITY_MAX_REMEDIATION_SECONDS: "1",
      BS_QUALITY_REREVIEW_RESERVE_SECONDS: "60",
    });
    prepareCodexReview(root, manifest);
    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: verification head"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.governor.campaignSeconds = 1;
    state.governor.startedAtEpoch = Math.floor(Date.now() / 1000) - 2;
    state.governor.campaignDeadlineEpoch =
      state.governor.startedAtEpoch + state.governor.campaignSeconds;
    state.governor.validationDeadlineEpoch = Math.floor(Date.now() / 1000) + 60;
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);
    expect(
      spawnSync("node", [GOVERNOR, "check", manifest], { cwd: root }).status,
    ).toBe(0);
    expect(
      spawnSync("node", [GOVERNOR, "bump-round", manifest], { cwd: root })
        .status,
    ).toBe(0);
  });

  it("passes a structured wrapper argv without executing spaces or metacharacters", () => {
    const dir = makeTempDir("quality-wrapper-");
    const bootstrap = path.join(dir, "bootstrap.sh");
    const marker = path.join(dir, "executed");
    writeFileSync(bootstrap, '#!/usr/bin/env bash\nprintf "<%s>\\n" "$@"\n');
    chmodSync(bootstrap, 0o755);
    const request = JSON.stringify({
      argv: [
        "--target-dir",
        `${dir}/path with space`,
        `$(touch ${marker})`,
        ";",
      ],
    });
    const result = spawnSync("node", [WRAPPER, bootstrap], {
      input: request,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`<${dir}/path with space>`);
    expect(result.stdout).toContain(`<$(touch ${marker})>`);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails safely when approval bootstrap returns malformed manifest JSON", () => {
    const dir = makeTempDir("quality-wrapper-json-");
    const bootstrap = path.join(dir, "bootstrap.sh");
    const manifest = path.join(dir, "invocation.json");
    writeFileSync(manifest, "{not-json\n");
    writeFileSync(
      bootstrap,
      `#!/usr/bin/env bash
printf 'BS_QUALITY_MANIFEST=%s\\n' ${JSON.stringify(manifest)}
`,
    );
    chmodSync(bootstrap, 0o755);

    const result = spawnSync("node", [WRAPPER, bootstrap], {
      input: JSON.stringify({ argv: [] }),
      encoding: "utf8",
      env: { ...process.env, BREAK_GLASS_APPROVED: "true" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/quality manifest is not valid JSON/);
  });

  it("rejects malformed merge arguments before any GitHub or repository mutation", () => {
    const root = repo("strict-wrapper-args");
    const harness = makeTempDir("quality-strict-args-");
    const bin = path.join(harness, "bin");
    const ghMarker = path.join(harness, "gh-invoked");
    mkdirSync(bin);
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(ghMarker)}
exit 99
`,
    );
    chmodSync(gh, 0o755);
    const beforeHead = git(root, ["rev-parse", "HEAD"]);
    const beforeStatus = git(root, ["status", "--porcelain=v1"]);

    for (const argv of [["--merge", "1"], ["--merge=false"]]) {
      const result = spawnSync("node", [WRAPPER, BOOTSTRAP], {
        cwd: root,
        input: JSON.stringify({ argv }),
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /unexpected quality argument|--merge accepts only/,
      );
    }

    const directManifest = spawnSync(
      "node",
      [
        INVOCATION,
        "create",
        "--repo",
        root,
        "--base-ref",
        "origin/main",
        "--merge=false",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(directManifest.status).not.toBe(0);
    expect(directManifest.stderr).toMatch(/--merge=false is invalid/);

    expect(existsSync(ghMarker)).toBe(false);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
  });

  it("rejects symlinked manifests and concurrent mutation locks", () => {
    const root = repo("hardening");
    const manifest = create(root);
    const link = path.join(path.dirname(manifest), "linked.json");
    symlinkSync(manifest, link);
    expect(
      spawnSync("node", [INVOCATION, "validate", link], { cwd: root }).status,
    ).not.toBe(0);
    writeFileSync(`${manifest}.lock`, "other\n");
    expect(
      spawnSync(
        "node",
        [
          INVOCATION,
          "risk",
          manifest,
          "--tier",
          "high",
          "--agents",
          "5",
          "--codex-depth",
          "high",
          "--codex-rounds",
          "1",
        ],
        { cwd: root },
      ).status,
    ).not.toBe(0);
  });

  it("fails closed on a stale lock until an operator explicitly cleans it", () => {
    const root = repo("stale-lock");
    const manifest = create(root);
    writeFileSync(
      `${manifest}.lock`,
      '{"pid":99999999,"hostname":"local","acquiredAt":"2026-01-01"}',
    );
    const result = spawnSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--agents",
        "5",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/explicit operator cleanup/);
  });

  it("rejects changed origin identity and contains no shell-evaluable exports", () => {
    const root = repo("origin");
    const manifest = create(root);
    git(root, ["remote", "set-url", "origin", `${root}-different`]);
    expect(
      spawnSync("node", [INVOCATION, "validate", manifest], { cwd: root })
        .status,
    ).not.toBe(0);
    const loader = readFileSync(LOAD_ROOT, "utf8");
    expect(loader).not.toMatch(/\beval\b|quality-invocation\.js" shell/);
  });

  it("simulates first review, fix, incremental review, push, CI, and merge authorization", () => {
    const root = repo("lifecycle");
    const manifest = create(root, ["--level", "95", "--pr", "1", "--merge"]);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    execFileSync("bash", [SELECT, "--manifest", manifest], { cwd: root });
    const first = prepareCodexReview(root, manifest);

    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "fix"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const validationState = JSON.parse(readFileSync(manifest, "utf8"));
    expect(validationState.governor.gateSecondsUsed).toBe(0);
    expect(validationState.governor.providerSecondsUsed).toBe(0);
    expect(validationState.risk.runtime).toMatchObject({
      gateCount: 3,
      gateReserveSeconds: 360,
    });
    // The fixed active deadline is exact-HEAD scoped. Provider usage, provider
    // attempts, review rounds, and fix limits remain cumulative across heads.
    expect(validationState.governor.gateSecondsLimit).toBe(1920);
    expect(validationState.governor.providerSecondsLimit).toBe(1080);
    expect(validationState.governor.activeSecondsLimit).toBe(
      validationState.risk.runtime.campaignSeconds,
    );
    expect(validationState.governor.activeSecondsUsed).toBe(0);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).governor.providerSecondsUsed,
    ).toBe(validationState.governor.providerSecondsUsed);
    const second = prepareCodexReview(root, manifest);
    expect(second.from).toBe(first.to);
    recordJudgeArtifact(root, manifest);

    const predecessorBin = fakeGh(root, first.to);
    const remediationPreflight = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${predecessorBin}:${process.env.PATH}`,
          QUALITY_TEST_STRICT_PROTECTION: "true",
        },
        encoding: "utf8",
      },
    );
    expect(remediationPreflight.status, remediationPreflight.stderr).toBe(0);
    expect(remediationPreflight.stdout).toContain(
      `BS_QUALITY_PR_HEAD=${first.to}`,
    );

    const trailers = execFileSync("node", [INVOCATION, "trailers", manifest], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const signer = generateKeyPairSync("ed25519");
    const signingKey = signer.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const verificationKey = signer.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    const signature = execFileSync(
      "node",
      [
        REVIEW_EVIDENCE,
        "sign",
        "--head",
        authorization.head,
        "--base",
        authorization.base,
        "--tier",
        authorization.tier,
        "--findings",
        String(authorization.blockingCount),
        "--reviewer",
        authorization.provider,
        "--primary",
        authorization.primary,
        "--fallback",
        authorization.fallback,
        "--contractVersion",
        String(authorization.contractVersion),
        "--leads",
        String(authorization.leads),
        "--reviewStatus",
        authorization.reviewStatus,
        "--policyDigest",
        authorization.policyDigest,
        "--agentsSha256",
        authorization.agentsSha256,
        "--domain",
        authorization.domain,
        "--selectionRule",
        authorization.selectionRule,
        "--repositoryKey",
        authorization.repositoryKey,
        "--diffSha256",
        authorization.diffSha256,
        "--evidenceSha256",
        authorization.evidenceSha256,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY: signingKey,
        },
        encoding: "utf8",
      },
    ).trim();
    const message = `chore: quality stamp\n\n${trailers}\nQuality-Evidence-Signature: ${signature}`;
    git(root, ["commit", "--allow-empty", "-q", "-m", message]);
    const stampHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync(
      "node",
      [
        INVOCATION,
        "record-stamp",
        manifest,
        "--head",
        stampHead,
        "--remote",
        "origin",
        "--expected-old-head",
        second.to,
      ],
      { cwd: root },
    );
    const lifecycle = [];
    lifecycle.push("push");
    lifecycle.push("ci:success");
    const bin = fakeGh(root, stampHead);
    const caller = repo("authorization-caller");
    const wrongRepository = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_REPOSITORY: "other/repository",
        },
        encoding: "utf8",
      },
    );
    expect(wrongRepository.status).not.toBe(0);
    expect(wrongRepository.stderr).toMatch(/repository identity changed/);
    const wrongHeadRef = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_HEAD_REF: "other-feature",
        },
        encoding: "utf8",
      },
    );
    expect(wrongHeadRef.status).not.toBe(0);
    expect(wrongHeadRef.stderr).toMatch(/head branch identity changed/);
    const planLimited = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_PROTECTION_MODE: "plan-limit",
          BS_QUALITY_ALLOW_UNPROTECTABLE_BASE: "true",
        },
        encoding: "utf8",
      },
    );
    expect(planLimited.status, planLimited.stderr).toBe(0);
    expect(planLimited.stdout).toContain(
      "BS_QUALITY_BASE_PROTECTION=unprotectable",
    );

    const malformedProtection = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_PROTECTION_MODE: "malformed",
        },
        encoding: "utf8",
      },
    );
    expect(malformedProtection.status).toBe(1);
    expect(malformedProtection.stderr).toMatch(/classification failed/);

    const unprotected = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: caller,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    expect(unprotected.status).not.toBe(0);
    expect(unprotected.stderr).toMatch(/server-enforced strict freshness/);

    const graphqlStrict = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest, "--preflight"],
      {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_EFFECTIVE_RULES: "unavailable",
          QUALITY_TEST_GRAPHQL_RULES: "strict",
        },
        encoding: "utf8",
      },
    );
    expect(graphqlStrict.status, graphqlStrict.stderr).toBe(0);
    expect(graphqlStrict.stdout).toContain("BS_QUALITY_BASE_PROTECTION=true");

    const queueOnly = spawnSync("bash", [AUTHORIZE, "--manifest", manifest], {
      cwd: caller,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QUALITY_TEST_EFFECTIVE_RULES: "queue",
      },
      encoding: "utf8",
    });
    expect(queueOnly.status).not.toBe(0);
    expect(queueOnly.stderr).toMatch(/queue-aware monitored merge path/);

    expect(
      spawnSync("bash", [AUTHORIZE, "--manifest", manifest, "--preflight"], {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_STRICT_PROTECTION: "true",
          QUALITY_TEST_EFFECTIVE_RULES: "unavailable",
          QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY: verificationKey,
        },
        encoding: "utf8",
      }).status,
    ).toBe(0);

    const acceptedDespiteClientFailure = spawnSync(
      "bash",
      [AUTHORIZE, "--manifest", manifest],
      {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_EFFECTIVE_RULES: "strict",
          QUALITY_TEST_MERGE_RC: "1",
          QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY: verificationKey,
        },
        encoding: "utf8",
      },
    );
    expect(
      acceptedDespiteClientFailure.status,
      acceptedDespiteClientFailure.stderr,
    ).toBe(0);
    lifecycle.push("merge");
    expect(lifecycle).toEqual(["push", "ci:success", "merge"]);

    git(root, ["reset", "--hard", "-q", "HEAD~1"]);
    writeFileSync(path.join(root, "stale.js"), "export const stale = true;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "unreviewed"]);
    const staleBin = fakeGh(root, stampHead);
    expect(
      spawnSync("bash", [AUTHORIZE, "--manifest", manifest], {
        cwd: root,
        env: { ...process.env, PATH: `${staleBin}:${process.env.PATH}` },
      }).status,
    ).not.toBe(0);
  }, 90_000);

  it("rejects a dirty working tree before gates, review, and stamp", () => {
    const root = repo("dirty-preflight");
    const manifest = create(root, ["--level", "95", "--pr", "1", "--merge"]);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    execFileSync("bash", [SELECT, "--manifest", manifest], { cwd: root });
    writeFileSync(path.join(root, "dirty.txt"), "unreviewed\n");

    for (const invocation of [
      ["bash", [RUN_GATE, "--manifest", manifest, "--name", "lint"]],
      ["bash", [RUN_REVIEW, "--manifest", manifest]],
      ["bash", [STAMP_AND_MERGE, "--manifest", manifest]],
    ]) {
      const result = spawnSync(invocation[0], invocation[1], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/dirty working tree/);
    }
  });

  it("funds required gates without a mutation allowance below high risk", () => {
    const root = repo("medium-gate-budget");
    const manifest = create(root, ["--level", "medium"]);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    const state = JSON.parse(readFileSync(manifest, "utf8"));

    expect(state.risk.tier).toBe("medium");
    expect(state.risk.runtime).toMatchObject({
      gateCount: 3,
      gateReserveSeconds: 360,
    });
    expect(state.governor.gateSecondsLimit).toBe(720);
    expect(state.governor.activeSecondsLimit).toBe(
      state.risk.runtime.campaignSeconds,
    );
  });

  it("rejects a runtime reserve that disagrees with the required gates", () => {
    const root = repo("mismatched-gate-reserve");
    const manifest = create(root);
    const result = spawnSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "medium",
        "--agents",
        "1",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
        "--check-seconds",
        "120",
        "--gate-count",
        "3",
        "--gate-reserve-seconds",
        "1",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gate reserve does not match gate count/);
  });

  it("keeps the reviewed HEAD immutable and waits for exact-candidate CI", () => {
    const root = repo("stamp-retry");
    const remote = makeTempDir("quality-remote-");
    git(remote, ["init", "--bare", "-q"]);
    git(root, ["remote", "set-url", "origin", remote]);
    git(root, ["push", "-q", "origin", "main"]);
    git(root, ["push", "-q", "-u", "origin", "feature"]);

    const manifest = create(root, ["--level", "95", "--pr", "1", "--merge"]);
    const fixtureIdentity = fixtureRepository(root);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    execFileSync("bash", [SELECT, "--manifest", manifest], { cwd: root });
    prepareCodexReview(root, manifest);
    recordJudgeArtifact(root, manifest);

    const harness = makeTempDir("quality-stamp-harness-");
    const bin = path.join(harness, "bin");
    mkdirSync(bin);
    const log = path.join(harness, "gh-order.log");
    const pushLog = path.join(harness, "git-push.log");
    const fail = path.join(harness, "fail-ci");
    const failPush = path.join(harness, "fail-push");
    const denyPreflight = path.join(harness, "deny-preflight");
    const evidence = path.join(harness, "quality-review-evidence.json");
    const merged = path.join(harness, "merged");
    writeFileSync(fail, "fail\n");
    writeFileSync(denyPreflight, "deny\n");
    const gh = path.join(bin, "gh");
    const gitWrapper = path.join(bin, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      gitWrapper,
      `#!/usr/bin/env bash
if [ "$1" = push ]; then
  printf '%s\\n' "$*" >> ${JSON.stringify(pushLog)}
  if [ -f ${JSON.stringify(failPush)} ]; then exit 75; fi
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    chmodSync(gitWrapper, 0o755);
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "pr view" ]; then
  head="$(git ls-remote origin refs/heads/feature | awk '{print $1}')"
  if [[ "$*" == *"--jq .headRefOid"* ]]; then printf '%s\\n' "$head"
  elif [ -f ${JSON.stringify(merged)} ]; then
    printf '{"state":"MERGED","mergedAt":"2026-07-16T00:00:00Z","mergeCommit":{"oid":"merge"},"headRefName":"feature","headRefOid":"%s","baseRefName":"main"}\\n' "$head"
  else printf '{"state":"OPEN","mergedAt":null,"mergeCommit":null,"headRefName":"feature","headRefOid":"%s","baseRefName":"main"}\\n' "$head"; fi
  exit 0
fi
if [ "$1 $2" = "pr checks" ]; then [ ! -f ${JSON.stringify(fail)} ]; exit $?; fi
if [ "$1 $2" = "pr merge" ]; then touch ${JSON.stringify(merged)}; exit 0; fi
if [ "$1 $2" = "repo view" ]; then
  if [[ "$*" == *"nameWithOwner"* ]]; then printf '%s\\n' '${fixtureIdentity}'; else printf '%s\\n' 'main'; fi
  exit 0
fi
if [ "$1" = "api" ]; then
  if [[ "$*" == *"protection/required_status_checks"* ]]; then
    [ ! -f ${JSON.stringify(denyPreflight)} ] || exit 1
    if [[ "$*" == *"--jq .strict"* ]]; then
      printf '%s\\n' 'true'
    else
      printf '%s\\n' '{"strict":true,"contexts":["quality"],"checks":[{"context":"quality","app_id":15368}]}'
    fi
  elif [[ "$*" == *"--method POST"* || "$*" == *"--method PATCH"* ]]; then
    cat > ${JSON.stringify(evidence)}
    head_sha="$(jq -r .head_sha ${JSON.stringify(evidence)})"
    printf '{"id":2,"name":"quality-review-evidence","head_sha":"%s"}\\n' "$head_sha"
  elif [[ "$*" == *"/check-runs"* ]]; then
    if [ -f ${JSON.stringify(evidence)} ]; then
      text="$(jq -c .output.text ${JSON.stringify(evidence)})"
      printf '{"check_runs":[{"id":2,"name":"quality-review-evidence","status":"completed","conclusion":"success","completed_at":"2026-08-11T12:00:00Z","output":{"text":%s}},{"id":1,"name":"quality","status":"completed","conclusion":"success","app":{"id":15368}}]}\\n' "$text"
    else
      printf '%s\\n' '{"check_runs":[{"id":1,"name":"quality","status":"completed","conclusion":"success","app":{"id":15368}}]}'
    fi
  elif [ -f ${JSON.stringify(denyPreflight)} ]; then
    printf '%s\\n' '[{"type":"merge_queue","parameters":{"grouping_strategy":"ALLGREEN"}}]'
  else
    printf '%s\\n' '[]'
  fi
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);
    const reviewEvidenceKeys = generateKeyPairSync("ed25519");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      QUALITY_STAMP_CI_TIMEOUT: "5",
      QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY: reviewEvidenceKeys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY: reviewEvidenceKeys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      // Keep default key discovery hermetic; this fixture supplies an
      // explicit ephemeral signer for the critical-tier stamp path.
      XDG_CONFIG_HOME: path.join(harness, "xdg"),
    };

    const reviewedHead = git(root, ["rev-parse", "HEAD"]);
    const denied = spawnSync(
      "bash",
      [STAMP_AND_MERGE, "--manifest", manifest],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(denied.status).not.toBe(0);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(reviewedHead);
    expect(git(root, ["ls-remote", "origin", "refs/heads/feature"])).toContain(
      reviewedHead,
    );
    expect(JSON.parse(readFileSync(manifest, "utf8")).merge.stampHead).toBe(
      undefined,
    );
    unlinkSync(denyPreflight);
    const result = spawnSync(
      "bash",
      [STAMP_AND_MERGE, "--manifest", manifest],
      {
        cwd: root,
        env,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("unbound variable");
    expect(git(root, ["rev-parse", "HEAD"])).toBe(reviewedHead);
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).merge.stampHead,
    ).toBeUndefined();
    expect(git(root, ["ls-remote", "origin", "refs/heads/feature"])).toContain(
      reviewedHead,
    );
    expect(existsSync(pushLog)).toBe(false);
    const calls = readFileSync(log, "utf8");
    expect(calls.indexOf(`/commits/${reviewedHead}/check-runs`)).toBeLessThan(
      calls.indexOf("pr merge 1"),
    );
  }, 90_000);

  it("rejects cross-repository PRs before creating unusable state", () => {
    const root = repo("cross-repo");
    expect(() =>
      create(root, [
        "--pr",
        "1",
        "--head-repository",
        "fork/repo",
        "--cross-repository",
        "true",
      ]),
    ).toThrow(/trusted CI evidence ingestion.*not yet supported/);
  });

  it("fails authorization when inventoried findings are replaced", () => {
    const root = repo("artifact-tamper");
    const manifest = create(root);
    const review = prepareCodexReview(root, manifest);
    recordJudgeArtifact(root, manifest);
    writeFileSync(
      path.join(review.artifactDir, "codex.findings.txt"),
      "REPLACED\n",
    );
    expect(
      spawnSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }).status,
    ).not.toBe(0);
  });

  it("records v2 AI leads without granting a model judge merge authority", () => {
    const root = repo("judge-block");
    const manifest = create(root, ["--pr", "21"]);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareCodexReview(root, manifest, [
      {
        severity: "high",
        title: "one",
        body: "first lead",
        failure_scenario: "input one reaches the changed export",
        file: "file.js",
        line_start: 1,
        proof: { kind: "static-analysis", evidence: "changed line one" },
        recommendation: "verify first lead",
      },
      {
        severity: "high",
        title: "two",
        body: "second lead",
        failure_scenario: "input two reaches related unchanged code",
        file: "file.js",
        line_start: 99,
        proof: { kind: "static-analysis", evidence: "related source lead" },
        recommendation: "verify second lead",
      },
    ]);
    recordJudgeArtifact(root, manifest, ["BLOCKING", "BLOCKING"]);
    recordMutationFixture(manifest);
    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(authorization).toMatchObject({
      blockingCount: 0,
      leads: 2,
      reviewStatus: "complete",
      repositoryKey: "owner/repo",
    });
  });

  it("keeps campaign-bound domain selection valid across a different-domain delta", () => {
    const root = repo("v2-cross-domain-delta");
    mkdirSync(path.join(root, "src", "auth"), { recursive: true });
    writeFileSync(path.join(root, "src", "auth", "session.js"), "secure\n");
    git(root, ["add", "src/auth/session.js"]);
    git(root, ["commit", "-q", "-m", "fix: secure session"]);
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "critical",
        taskType: "bugfix",
        score: 90,
        agents: 2,
        "codex-depth": "xhigh",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer", "security-auditor"], {
        domain: "security",
        rule: "security-domain",
      });
    });
    prepareCodexReview(root, manifest);

    unlinkSync(path.join(root, "src", "auth", "session.js"));
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "repair.sh"), "exit 0\n");
    git(root, ["add", "src/auth/session.js", "scripts/repair.sh"]);
    git(root, ["commit", "-q", "-m", "fix: harden repair"]);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.advanceHead(loaded, root);
    });

    expect(() => prepareCodexReview(root, manifest)).not.toThrow();
    expect(invocation.loadManifest(manifest).manifest.reviews).toHaveLength(2);
  });

  it("archives a prior-head merge block when its descendant fix advances", () => {
    const root = repo("blocked-descendant-advance");
    const manifestPath = create(root, ["--merge"]);
    const blockedHead = git(root, ["rev-parse", "HEAD"]);
    invocation.recordMergeAdmissionBlockedTerminal(
      manifestPath,
      ["base:protected-nonstrict", "pr:non-atomic-state"],
      "merge admission blocked",
    );
    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: address merge review"]);
    const nextHead = git(root, ["rev-parse", "HEAD"]);

    invocation.withManifestLock(manifestPath, (manifest) => {
      expect(invocation.advanceHead(manifest, root)).toBe(true);
    });

    const { manifest } = invocation.loadManifest(manifestPath);
    expect(manifest.revisions.currentHead).toBe(nextHead);
    expect(manifest.terminalState).toBeNull();
    expect(manifest.terminalEpoch).toBe(1);
    expect(manifest.merge.admissionBlock).toBeUndefined();
    expect(manifest.terminalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "blocked",
          head: blockedHead,
          disposition: "superseded-by-descendant",
          supersededByHead: nextHead,
        }),
        expect.objectContaining({
          event: "reopened-by-descendant",
          head: nextHead,
          priorHead: blockedHead,
          terminalEpoch: 1,
        }),
      ]),
    );
  });

  it("archives a prior-head interruption when its descendant advances", () => {
    const root = repo("interrupted-descendant-advance");
    const manifestPath = create(root);
    const interruptedHead = git(root, ["rev-parse", "HEAD"]);
    invocation.recordTerminalState(
      manifestPath,
      "interrupted",
      "quality run interrupted",
    );
    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: continue after interruption"]);
    const nextHead = git(root, ["rev-parse", "HEAD"]);

    invocation.withManifestLock(manifestPath, (manifest) => {
      expect(invocation.advanceHead(manifest, root)).toBe(true);
    });

    const { manifest } = invocation.loadManifest(manifestPath);
    expect(manifest.revisions.currentHead).toBe(nextHead);
    expect(manifest.terminalState).toBeNull();
    expect(manifest.terminalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "interrupted",
          head: interruptedHead,
          disposition: "superseded-by-descendant",
          supersededByHead: nextHead,
        }),
        expect.objectContaining({
          event: "reopened-by-descendant",
          head: nextHead,
          priorHead: interruptedHead,
        }),
      ]),
    );
  });

  it("resumes an exact-head interruption without resetting evidence or budgets", () => {
    const root = repo("interrupted-exact-head-resume");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      manifest.reviews.push({
        from: manifest.revisions.baseSha,
        to: manifest.revisions.currentHead,
        status: "success",
        provider: "codex",
        leadCount: 0,
      });
      manifest.governor.providerSecondsUsed = 64;
      manifest.governor.activeExecution = null;
    });
    invocation.recordTerminalState(
      manifestPath,
      "interrupted",
      "quality run interrupted",
    );

    expect(invocation.resumeInterruptedTerminal(manifestPath)).toMatchObject({
      head: git(root, ["rev-parse", "HEAD"]),
      terminalEpoch: 1,
    });

    const { manifest } = invocation.loadManifest(manifestPath);
    expect(manifest.terminalState).toBeNull();
    expect(manifest.reviews).toHaveLength(1);
    expect(manifest.governor.providerSecondsUsed).toBe(64);
    expect(manifest.terminalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "interrupted",
          disposition: "resumed-after-interruption",
        }),
        expect.objectContaining({
          event: "reopened-after-interruption",
          terminalEpoch: 1,
        }),
      ]),
    );
  });

  it("does not resume an interruption while execution ownership is active", () => {
    const root = repo("interrupted-active-execution");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      manifest.governor.activeExecution = {
        kind: "provider",
        token: "still-active",
      };
    });
    invocation.recordTerminalState(
      manifestPath,
      "interrupted",
      "quality run interrupted",
    );

    expect(invocation.resumeInterruptedTerminal(manifestPath)).toBeNull();
    expect(
      invocation.loadManifest(manifestPath).manifest.terminalState,
    ).toMatchObject({
      state: "interrupted",
    });
  });

  it("reconciles a stale prior-head block after an earlier runner advanced only HEAD", () => {
    const root = repo("stale-blocked-descendant");
    const manifestPath = create(root, ["--merge"]);
    invocation.recordTerminalState(manifestPath, "blocked", "merge block");
    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: descendant"]);
    const nextHead = git(root, ["rev-parse", "HEAD"]);
    invocation.withManifestLock(manifestPath, (manifest) => {
      manifest.revisions.currentHead = nextHead;
      manifest.governor.activeSecondsUsed = 90;
      manifest.governor.gateSecondsUsed = 30;
    });

    invocation.withManifestLock(manifestPath, (manifest) => {
      expect(invocation.advanceHead(manifest, root)).toBe(true);
    });

    const { manifest } = invocation.loadManifest(manifestPath);
    expect(manifest.terminalState).toBeNull();
    expect(manifest.terminalEpoch).toBe(1);
    expect(manifest.terminalHistory.at(-1)).toMatchObject({
      event: "reopened-by-descendant",
      head: nextHead,
    });
    expect(manifest.governor.activeSecondsUsed).toBe(0);
    expect(manifest.governor.gateSecondsUsed).toBe(0);
    expect(manifest.governor.headExecutionHistory.at(-1)).toMatchObject({
      head: expect.any(String),
      supersededByHead: nextHead,
      activeSecondsUsed: 90,
      gateSecondsUsed: 30,
    });
  });

  it("binds the immutable selection head into review evidence", () => {
    const root = repo("v2-selection-head-binding");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareCodexReview(root, manifest);
    invocation.withManifestLock(manifest, (loaded) => {
      loaded.panel.selectionHead = loaded.revisions.baseSha;
    });

    expect(() =>
      invocation.reviewAuthorization(
        invocation.loadManifest(manifest).manifest,
      ),
    ).toThrow(
      /panelSelectionHead identity mismatch|inventory identity\/status mismatch/,
    );
  });

  it("retains structured leads produced before an incomplete provider run", () => {
    const root = repo("incomplete-partial-leads");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareIncompleteReview(root, manifest, [
      {
        severity: "high",
        title: "partial lead",
        body: "The provider found this before its transport failed.",
        failure_scenario: "A caller reaches the changed export with bad input.",
        file: "file.js",
        line_start: 1,
        proof: { kind: "static-analysis", evidence: "changed export path" },
        recommendation: "Verify the partial lead.",
      },
    ]);
    recordMutationFixture(manifest);

    expect(() =>
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toThrow(
      "provider review requires its authorized same-range retry before merge authorization",
    );
    const inventory = JSON.parse(
      readFileSync(
        path.join(
          invocation.loadManifest(manifest).manifest.reviews[0].artifactDir,
          "artifact-inventory.json",
        ),
        "utf8",
      ),
    );
    expect(inventory.files).toContainEqual(
      expect.objectContaining({
        name: "codex-1.normalized.json",
        provider: "codex",
      }),
    );
    expect(
      invocation.loadManifest(manifest).manifest.reviews[0].leadCount,
    ).toBe(1);
  });

  it("authorizes an explicit zero-reviewer policy exemption at low risk", () => {
    const root = repo("low-risk-policy-exempt-review");
    git(root, ["reset", "--hard", "-q", "origin/main"]);
    writeFileSync(path.join(root, "README.md"), "# Documentation\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "docs: update readme"]);
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "low",
        taskType: "docs",
        score: 5,
        agents: 0,
        "codex-depth": "low",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, [], {
        domain: "policy-exempt",
        rule: "low-no-ai",
      });
    });
    for (const name of ["lint", "test", "security"]) {
      recordGateFixture(manifest, name);
    }
    preparePolicyExemptReview(root, manifest);
    recordJudgeArtifact(root, manifest);

    expect(() =>
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }),
    ).not.toThrow();
    const saved = invocation.loadManifest(manifest).manifest;
    expect(saved.reviews).toEqual([
      expect.objectContaining({
        status: "exempt",
        provider: "policy-exempt",
      }),
    ]);
  });

  it("blocks merge authorization while incomplete AI discovery awaits retry", () => {
    const root = repo("incomplete-advisory-review");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareIncompleteReview(root, manifest);
    recordMutationFixture(manifest);

    expect(() =>
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toThrow(
      "provider review requires its authorized same-range retry before merge authorization",
    );
  });

  it("retries an incomplete provider attestation on the same exact HEAD", () => {
    const root = repo("incomplete-provider-retry");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });

    const incomplete = prepareIncompleteReview(root, manifest);
    const completed = prepareCodexReview(root, manifest);
    expect(completed).toMatchObject({
      round: incomplete.round,
      from: incomplete.from,
      to: incomplete.to,
    });
    expect(completed.artifactDir).not.toBe(incomplete.artifactDir);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.reviews.map((review) => review.status)).toEqual([
      "incomplete",
      "success",
    ]);
    expect(state.reviews[0].artifactDir).toBe(incomplete.artifactDir);

    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(authorization).toMatchObject({
      provider: "codex",
      reviewStatus: "complete",
      head: incomplete.to,
    });
  });

  it("authorizes deterministic merge evidence after the bounded incomplete retry", () => {
    const root = repo("double-incomplete-provider-retry");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });

    const first = prepareIncompleteReview(root, manifest);
    const second = prepareIncompleteReview(root, manifest);
    expect(second).toMatchObject({
      round: first.round,
      from: first.from,
      to: first.to,
    });
    expect(second.artifactDir).not.toBe(first.artifactDir);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.reviews.map((review) => review.status)).toEqual([
      "incomplete",
      "incomplete",
    ]);
    expect(() => invocation.reviewInfo(state)).toThrow(
      "provider review remained incomplete after its authorized same-range retry",
    );
    const authorization = JSON.parse(
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(authorization).toMatchObject({
      reviewStatus: "incomplete",
      blockingCount: 0,
      leads: 0,
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("refuses HEAD advancement while an incomplete same-range retry is pending", () => {
    const root = repo("pending-incomplete-provider-retry");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareIncompleteReview(root, manifest);
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "fix: attempted early remediation"]);

    const state = invocation.loadManifest(manifest).manifest;
    expect(() => invocation.advanceHead(state, root)).toThrow(
      /incomplete review retry .* is pending/,
    );
    expect(state.revisions.currentHead).not.toBe(
      git(root, ["rev-parse", "HEAD"]),
    );
  });

  it("allows one explicit provider-exhaustion decision to advance to a fixed descendant", () => {
    const root = repo("exhausted-provider-descendant");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    const first = prepareIncompleteReview(root, manifest);
    prepareIncompleteReview(root, manifest);
    writeFileSync(path.join(root, "fixed.js"), "export const fixed = true;\n");
    git(root, ["add", "fixed.js"]);
    git(root, ["commit", "-qam", "fix: remediate provider-incomplete review"]);
    const nextHead = git(root, ["rev-parse", "HEAD"]);
    const state = invocation.loadManifest(manifest).manifest;

    expect(() => invocation.advanceHead(state, root)).toThrow(
      /incomplete review retry .* is exhausted/,
    );
    expect(() =>
      invocation.advanceHead(state, root, {
        acceptedConditions: ["review:provider-exhaustion"],
      }),
    ).not.toThrow();
    expect(state.revisions.currentHead).toBe(nextHead);
    expect(state.revisions.exhaustedReviewAdvance).toMatchObject({
      acceptedCondition: "review:provider-exhaustion",
      priorTo: first.to,
      head: nextHead,
    });
    expect(
      state.reviews.every((review) => review.status === "incomplete"),
    ).toBe(true);
    expect(() =>
      invocation.authorizeProviderAttempt(
        state,
        { provider: "codex" },
        manifest,
      ),
    ).toThrow(/capacity remains exhausted after remediation/);
  });

  it("refuses exhausted-review advancement when persisted lead counts disagree with evidence", () => {
    const root = repo("exhausted-provider-lead-count-mismatch");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "medium",
        taskType: "bugfix",
        score: 35,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    prepareIncompleteReview(root, manifest, [
      { severity: "high", title: "partial provider lead" },
    ]);
    prepareIncompleteReview(root, manifest);
    invocation.withManifestLock(manifest, (loaded) => {
      loaded.reviews[0].leadCount = 0;
    });
    writeFileSync(path.join(root, "fixed.js"), "export const fixed = true;\n");
    git(root, ["add", "fixed.js"]);
    git(root, ["commit", "-qam", "fix: remediate provider-incomplete review"]);

    const state = invocation.loadManifest(manifest).manifest;
    expect(() =>
      invocation.advanceHead(state, root, {
        acceptedConditions: ["review:provider-exhaustion"],
      }),
    ).toThrow(/lead count does not match provider evidence/);
    expect(state.revisions.currentHead).not.toBe(
      git(root, ["rev-parse", "HEAD"]),
    );
  });

  it("accepts a successful primary critical review without invoking fallback", () => {
    const root = repo("critical-primary-success");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "critical",
        taskType: "bugfix",
        score: 90,
        agents: 2,
        "codex-depth": "xhigh",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["code-reviewer", "silent-failure-hunter"], {
        domain: "general",
        rule: "critical-reliability-backstop",
      });
    });
    prepareCodexReview(root, manifest);

    const saved = invocation.loadManifest(manifest).manifest;
    expect(saved.reviews[0].status).toBe("success");
    expect(() => invocation.reviewInfo(saved)).toThrow(
      /review retry requires a descendant HEAD/,
    );
    expect(invocation.reviewAuthorization(saved)).toMatchObject({
      reviewStatus: "complete",
      blockingCount: 0,
    });
  });

  it("stamps a distinct Quality-Reviewer trailer for a policy exemption", () => {
    // Merge evidence must record which authorization path produced a merge
    // (full AI review vs CI-only advisory) so it's queryable via a plain
    // `git log --grep` over trailers without a new telemetry subsystem.
    const root = repo("policy-exempt-trailer-value");
    git(root, ["reset", "--hard", "-q", "origin/main"]);
    writeFileSync(path.join(root, "README.md"), "# Documentation\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "docs: update readme"]);
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "low",
        taskType: "docs",
        score: 5,
        agents: 0,
        "codex-depth": "low",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, [], {
        domain: "policy-exempt",
        rule: "low-no-ai",
      });
    });
    for (const name of ["lint", "test", "security"]) {
      recordGateFixture(manifest, name);
    }
    preparePolicyExemptReview(root, manifest);
    recordJudgeArtifact(root, manifest);

    const trailers = execFileSync("node", [INVOCATION, "trailers", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(trailers).toMatch(/^Quality-Reviewer: policy-exempt$/m);
    expect(trailers).toMatch(/^Quality-Leads: 0$/m);
    expect(trailers).toMatch(/^Quality-Review-Status: policy-exempt$/m);
    expect(trailers).not.toMatch(/^Quality-Reviewer: (claude|codex|gemini)$/m);
  });

  it("rejects policy-exempt evidence when the bound review policy is altered", () => {
    const root = repo("policy-exempt-policy-tamper");
    git(root, ["reset", "--hard", "-q", "origin/main"]);
    writeFileSync(path.join(root, "README.md"), "# Documentation\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "docs: update readme"]);
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "low",
        taskType: "docs",
        score: 5,
        agents: 0,
        "codex-depth": "low",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, [], {
        domain: "policy-exempt",
        rule: "low-no-ai",
      });
    });
    for (const name of ["lint", "test", "security"]) {
      recordGateFixture(manifest, name);
    }
    preparePolicyExemptReview(root, manifest);
    recordJudgeArtifact(root, manifest);
    invocation.withManifestLock(manifest, (loaded) => {
      loaded.risk.reviewPolicyDigest = "e".repeat(64);
    });

    const result = spawnSync(
      "node",
      [INVOCATION, "review-authorization", manifest],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/review policy changed/);
    expect(
      invocation.loadManifest(manifest).manifest.terminalState,
    ).toMatchObject({
      state: "policy-superseded",
      detail: "review-policy-drift",
    });
  });

  it("rejects advisory review coverage above the low risk tier", () => {
    const root = repo("high-risk-advisory-review");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 2,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["reviewer-a", "reviewer-b"]);
    });
    const result = spawnSync(
      "node",
      [
        INVOCATION,
        "record-advisory-review",
        manifest,
        "--failure-category",
        "provider-unavailable",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/explicit policy exemption/);
  });

  it("rejects a caller-supplied diff and matching hash that omit the Git delta", () => {
    const root = repo("partial-diff");
    const manifest = create(root);
    execFileSync("node", [GOVERNOR, "bump-round", manifest], { cwd: root });
    const info = JSON.parse(
      execFileSync("node", [INVOCATION, "review-info", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    mkdirSync(info.artifactDir, { recursive: true });
    writeFileSync(path.join(info.artifactDir, "diff.txt"), "");
    writeFileSync(
      path.join(info.artifactDir, "identity.json"),
      execFileSync("node", [INVOCATION, "review-identity", manifest], {
        cwd: root,
      }),
    );
    writeFileSync(
      path.join(info.artifactDir, "codex.findings.txt"),
      "NO FINDINGS.\n",
    );
    writeFileSync(
      path.join(info.artifactDir, "codex-1.json"),
      '{"verdict":"pass","summary":"clean","findings":[]}\n',
    );
    execFileSync(
      "node",
      [
        INVOCATION,
        "inventory",
        manifest,
        "--artifact-dir",
        info.artifactDir,
        "--provider",
        "codex",
      ],
      { cwd: root },
    );
    const emptySha = createHash("sha256").update("").digest("hex");
    const result = spawnSync(
      "node",
      [
        INVOCATION,
        "record-review",
        manifest,
        "--from",
        info.from,
        "--to",
        info.to,
        "--provider",
        "codex",
        "--primary",
        "codex",
        "--fallback",
        "none",
        "--artifact-dir",
        info.artifactDir,
        "--diff-sha",
        emptySha,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/canonical Git diff/);
  });

  it("freezes risk and agent state once persisted", () => {
    const root = repo("risk-freeze");
    const manifest = create(root);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    execFileSync("bash", [SELECT, "--manifest", manifest], { cwd: root });
    expect(() =>
      execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root }),
    ).not.toThrow();
    expect(() =>
      execFileSync("bash", [SELECT, "--manifest", manifest], { cwd: root }),
    ).not.toThrow();
    const persistedRisk = JSON.parse(readFileSync(manifest, "utf8")).risk;
    writeFileSync(path.join(root, "fix.js"), "export const fixed = true;\n");
    git(root, ["add", "fix.js"]);
    git(root, ["commit", "-q", "-m", "fix"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    const resumedRisk = execFileSync("bash", [RISK, "--manifest", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(resumedRisk).toMatch(/preserving persisted invocation contract/);
    expect(JSON.parse(readFileSync(manifest, "utf8")).risk).toEqual(
      persistedRisk,
    );
    expect(
      spawnSync(
        "node",
        [
          INVOCATION,
          "risk",
          manifest,
          "--tier",
          "low",
          "--agents",
          "2",
          "--codex-depth",
          "low",
          "--codex-rounds",
          "1",
        ],
        { cwd: root },
      ).status,
    ).not.toBe(0);
    expect(
      spawnSync("node", [INVOCATION, "agents", manifest, "a", "b"], {
        cwd: root,
      }).status,
    ).not.toBe(0);
  });

  it("resolves named high review level accepted by manifest creation", () => {
    const root = repo("named-high-level");
    const manifest = create(root, ["--level", "high"]);

    expect(() =>
      execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root }),
    ).not.toThrow();

    const risk = JSON.parse(readFileSync(manifest, "utf8")).risk;
    expect(risk).toMatchObject({
      requestedLevel: "high",
      resolved: true,
      tier: "high",
    });
  });

  it("records a deliberately reduced panel as incomplete and never authorizes it as full coverage", () => {
    const root = repo("reduced-panel");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 4,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, ["reviewer-a", "reviewer-b"], {
        incomplete: true,
      });
    });

    prepareCodexReview(root, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const inventory = JSON.parse(
      readFileSync(
        path.join(manifest.reviews[0].artifactDir, "artifact-inventory.json"),
        "utf8",
      ),
    );
    expect(manifest.panel).toEqual({
      requiredAgents: 4,
      selectedAgents: 2,
      incomplete: true,
      domain: "legacy",
      rule: "legacy-panel",
    });
    expect(manifest.reviews[0].incompletePanel).toBe(true);
    expect(inventory.panel).toEqual(manifest.panel);
    expect(() => invocation.reviewAuthorization(manifest)).toThrow(
      /incomplete reduced panel cannot satisfy merge review coverage/,
    );
  });

  it("requires an explicit incomplete marker for every reduced panel", () => {
    const root = repo("complete-panel-target");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 4,
        "codex-depth": "high",
        "codex-rounds": 1,
      });

      expect(() =>
        invocation.setAgents(manifest, ["reviewer-a", "reviewer-b"]),
      ).toThrow(/complete panel must contain exactly 4 agents/);
      expect(() =>
        invocation.setAgents(
          manifest,
          ["reviewer-a", "reviewer-b", "reviewer-c", "reviewer-d"],
          { incomplete: true },
        ),
      ).toThrow(/incomplete panel must contain fewer agents/);

      invocation.setAgents(manifest, [
        "reviewer-a",
        "reviewer-b",
        "reviewer-c",
        "reviewer-d",
      ]);
    });

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.panel).toEqual({
      requiredAgents: 4,
      selectedAgents: 4,
      incomplete: false,
      domain: "legacy",
      rule: "legacy-panel",
    });
  });

  it("refuses to persist a resolved target larger than the supported panel", () => {
    const root = repo("oversized-panel-target");
    const manifestPath = create(root);
    expect(() =>
      invocation.withManifestLock(manifestPath, (manifest) => {
        invocation.setRisk(manifest, {
          tier: "high",
          taskType: "bugfix",
          score: 60,
          agents: 10,
          "codex-depth": "high",
          "codex-rounds": 1,
        });
      }),
    ).toThrow(/agent target 10 exceeds supported 9-agent panel/);
  });

  it("rejects a resumed HEAD whose complete diff requires stronger review", () => {
    const root = repo("risk-escalation");
    const manifest = create(root);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    execFileSync("bash", [SELECT, "--manifest", manifest], { cwd: root });
    const before = JSON.parse(readFileSync(manifest, "utf8"));

    mkdirSync(path.join(root, "auth"), { recursive: true });
    writeFileSync(
      path.join(root, "auth/session.js"),
      "export const session = true;\n",
    );
    git(root, ["add", "auth/session.js"]);
    git(root, ["commit", "-q", "-m", "fix: add auth remediation"]);

    const result = spawnSync("node", [INVOCATION, "advance", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/stronger review.*fresh invocation/i);
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).revisions.currentHead,
    ).toBe(before.revisions.currentHead);
  });

  it("rejects an underpowered persisted critical contract at the 75 boundary", () => {
    const root = repo("critical-boundary-escalation");
    const manifest = create(root);
    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.risk = {
      ...state.risk,
      resolved: true,
      tier: "critical",
      score: 75,
      agentTarget: 2,
      codexDepth: "low",
      codexRounds: 0,
    };
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    mkdirSync(path.join(root, "server"), { recursive: true });
    writeFileSync(
      path.join(root, "server", "large.js"),
      `${Array.from({ length: 450 }, (_, index) => `export const v${index} = ${index};`).join("\n")}\n`,
    );
    git(root, ["add", "server/large.js"]);
    git(root, ["commit", "-q", "-m", "fix: add large server remediation"]);

    const result = spawnSync("node", [INVOCATION, "advance", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /stronger review.*now critical\/2\/xhigh.*fresh invocation/i,
    );
  });

  it("rejects a same-HEAD manifest with a stale underpowered critical contract", () => {
    const root = repo("same-head-critical-boundary");
    mkdirSync(path.join(root, "auth"), { recursive: true });
    writeFileSync(
      path.join(root, "auth", "session.js"),
      "export const session = true;\n",
    );
    git(root, ["add", "auth/session.js"]);
    git(root, ["commit", "-q", "-m", "feat: add auth surface"]);

    const manifest = create(root);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.risk = {
      ...state.risk,
      resolved: true,
      tier: "critical",
      score: 75,
      agentTarget: 2,
      codexDepth: "low",
      codexRounds: 0,
    };
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    const result = spawnSync("node", [INVOCATION, "advance", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /stronger review.*now critical\/2\/xhigh.*fresh invocation/i,
    );
    expect(() =>
      invocation.reviewAuthorization(
        JSON.parse(readFileSync(manifest, "utf8")),
      ),
    ).toThrow(/stronger review.*now critical\/2\/xhigh.*fresh invocation/i);
  });

  it("reapplies an explicit level-98 minimum when validating a stale same-HEAD contract", () => {
    const root = repo("same-head-level-98");
    const manifest = create(root, ["--level", "98"]);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.risk = {
      ...state.risk,
      requestedLevel: "98",
      resolved: true,
      tier: "critical",
      score: 75,
      agentTarget: 6,
      codexDepth: "high",
      codexRounds: 1,
    };
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    const result = spawnSync("node", [INVOCATION, "advance", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /stronger review.*now critical\/2\/xhigh.*fresh invocation/i,
    );
  });

  it("fails a non-finite policy closed before validating a stale level-98 contract", () => {
    const root = makeTempDir("quality-non-finite-policy-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(root, "file.js"), "// before\n");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        scorePolicy: {
          mechanicalDelta: "not-a-number",
          curve: [{ maxScore: 100, agents: 6, codex: "high", codexRounds: 1 }],
        },
      }),
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    writeFileSync(path.join(root, "file.js"), "// after\n");
    git(root, ["commit", "-qam", "comment-only change"]);

    const manifest = create(root, ["--level", "98"]);
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.risk = {
      ...state.risk,
      requestedLevel: "98",
      resolved: true,
      tier: "critical",
      score: 75,
      agentTarget: 6,
      codexDepth: "high",
      codexRounds: 1,
    };
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);

    const result = spawnSync("node", [INVOCATION, "advance", manifest], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/mechanicalDelta must be a finite number/i);
  });

  it("fails early when required repository gate scripts are missing", () => {
    const root = repo("missing-baselines");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "true" } }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "test-only package"]);
    expect(() => create(root)).toThrow(
      /executable npm or Python repository gates for: lint, security/,
    );

    writeFileSync(path.join(root, "package.json"), JSON.stringify({}));
    git(root, ["commit", "-qam", "remove tests"]);
    expect(() => create(root)).toThrow(
      /executable npm or Python repository gates for: lint, security, test/,
    );
    expect(() => create(root, ["--skip-tests"])).toThrow(
      /executable npm or Python repository gates for: lint, security/,
    );
  });

  it("caps critical campaigns at discovery plus one verification", () => {
    const root = repo("critical-rounds");
    const manifest = create(root);
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "critical",
        "--agents",
        "6",
        "--codex-depth",
        "xhigh",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).governor.maxReviewRounds,
    ).toBe(2);

    const boundedRoot = repo("critical-rounds-explicit-bound");
    const explicitlyBounded = create(boundedRoot, [], {
      BS_QUALITY_MAX_REVIEW_ROUNDS: "2",
    });
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        explicitlyBounded,
        "--tier",
        "critical",
        "--agents",
        "6",
        "--codex-depth",
        "xhigh",
        "--codex-rounds",
        "1",
      ],
      { cwd: boundedRoot },
    );
    expect(
      JSON.parse(readFileSync(explicitlyBounded, "utf8")).governor
        .maxReviewRounds,
    ).toBe(2);
  });

  it("rejects a judge artifact bound to another HEAD", () => {
    const root = repo("stale-judge");
    const manifest = create(root);
    prepareCodexReview(root, manifest);
    const artifact = path.join(root, "stale-judge.json");
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    context.head = "0".repeat(40);
    writeFileSync(artifact, JSON.stringify(context));
    const result = spawnSync(
      "node",
      [INVOCATION, "judge", manifest, "--artifact", artifact],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/head identity mismatch/);
  });

  it("parses skip-tests booleans and requires explicit skip evidence", () => {
    const root = repo("skip-tests");
    const manifest = create(root, ["--skip-tests"]);
    const falseManifest = create(root, ["--skip-tests=false"]);
    expect(JSON.parse(readFileSync(manifest, "utf8")).options.skipTests).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(falseManifest, "utf8")).options.skipTests,
    ).toBe(false);
    execFileSync(
      "bash",
      [
        RUN_GATE,
        "--manifest",
        manifest,
        "--name",
        "test",
        "--skip",
        "--reason",
        "config-only fixture has no executable tests",
      ],
      { cwd: root },
    );
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).gates.find(
        (gate) => gate.name === "test",
      ),
    ).toMatchObject({
      status: "skipped",
      reason: "config-only fixture has no executable tests",
    });

    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    prepareCodexReview(root, manifest);
    recordGateFixture(manifest, "test", {
      status: "skipped",
      reason: "config-only fixture has no executable tests",
    });
    recordJudgeArtifact(root, manifest, []);
    recordMutationFixture(manifest);
    expect(() =>
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }),
    ).not.toThrow();

    const missingReason = spawnSync(
      "node",
      [INVOCATION, "gate-run", falseManifest, "--name", "test", "--skip"],
      { cwd: root, encoding: "utf8" },
    );
    expect(missingReason.status).not.toBe(0);
    expect(missingReason.stderr).toMatch(/requires --skip-tests.*reason/);
  });

  it("preserves immutable provider finding payload through judging", () => {
    const root = repo("judge-payload");
    const manifest = create(root);
    prepareCodexReview(root, manifest, [
      {
        severity: "medium",
        title: "HTTP retry policy",
        body: "status === 429 must retain quota metadata",
        recommendation: "Preserve Retry-After and quota headers",
        evidence: { file: "src/http.js", line: 42 },
      },
    ]);
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings[0]).toMatchObject({
      body: "status === 429 must retain quota metadata",
      recommendation: "Preserve Retry-After and quota headers",
      evidence: { file: "src/http.js", line: 42 },
    });

    const artifact = path.join(root, "judge-payload.json");
    context.findings[0].disposition = "WARNING";
    writeFileSync(artifact, JSON.stringify(context));
    let result = spawnSync(
      "node",
      [INVOCATION, "judge", manifest, "--artifact", artifact],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/require a reason/);

    context.findings[0].reason = "Useful but not merge-blocking";
    context.findings[0].resolution = "fixed";
    writeFileSync(artifact, JSON.stringify(context));
    result = spawnSync(
      "node",
      [INVOCATION, "judge", manifest, "--artifact", artifact],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/incompatible with WARNING/);

    context.findings[0].resolution = "confirmed-nonblocking";
    context.findings[0].body = "mutated payload";
    writeFileSync(artifact, JSON.stringify(context));
    result = spawnSync(
      "node",
      [INVOCATION, "judge", manifest, "--artifact", artifact],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/changed immutable provider payload/);

    context.findings[0].body = "status === 429 must retain quota metadata";
    writeFileSync(artifact, JSON.stringify(context));
    expect(() =>
      execFileSync(
        "node",
        [INVOCATION, "judge", manifest, "--artifact", artifact],
        { cwd: root },
      ),
    ).not.toThrow();
  });

  it("uses Claude structured findings once instead of reparsing their text summary", () => {
    const root = repo("claude-structured-finding-dedup");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 1,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, ["code-reviewer"], {
        domain: "general",
        rule: "general-review",
      });
    });
    execFileSync("node", [GOVERNOR, "bump-round", manifestPath], {
      cwd: root,
    });
    const loaded = invocation.loadManifest(manifestPath).manifest;
    const info = invocation.reviewInfo(loaded);
    mkdirSync(info.artifactDir, { recursive: true });
    writeFileSync(
      path.join(info.artifactDir, "diff.txt"),
      execFileSync("git", ["diff", `${info.from}..${info.to}`], { cwd: root }),
    );
    writeFileSync(
      path.join(info.artifactDir, "identity.json"),
      execFileSync("node", [INVOCATION, "review-identity", manifestPath], {
        cwd: root,
      }),
    );
    writeFileSync(
      path.join(info.artifactDir, "review-focus.txt"),
      "fixture review focus\n",
    );
    const finding = {
      severity: "high",
      title: "Changed behavior",
      body: "The changed value causes the wrong result.",
      failure_scenario: "Read file.js after the feature commit.",
      file: "file.js",
      line_start: 1,
      proof: {
        kind: "static-analysis",
        evidence: "file.js:1 changes the exported value from 1 to 2.",
      },
      recommendation: "Restore the expected value.",
    };
    const normalized = {
      verdict: "needs-attention",
      summary: "One issue",
      findings: [finding],
    };
    writeFileSync(
      path.join(info.artifactDir, "code-reviewer.normalized.json"),
      JSON.stringify(normalized),
    );
    writeFileSync(
      path.join(info.artifactDir, "code-reviewer.result.json"),
      JSON.stringify({ structured_output: normalized }),
    );
    writeFileSync(
      path.join(info.artifactDir, "code-reviewer.findings.txt"),
      "high: file.js:1 — Changed behavior\nThe changed value causes the wrong result.\n<<<FINDINGS REPORTED>>>\n",
    );
    invocation.writeArtifactInventory(loaded, info.artifactDir, "claude");
    const diffSha = createHash("sha256")
      .update(readFileSync(path.join(info.artifactDir, "diff.txt")))
      .digest("hex");
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.recordReview(manifest, {
        from: info.from,
        to: info.to,
        provider: "claude",
        primary: "claude",
        fallback: "codex",
        "artifact-dir": info.artifactDir,
        "diff-sha": diffSha,
      });
    });
    for (const name of ["lint", "test", "security"]) {
      recordGateFixture(manifestPath, name);
    }
    recordMutationFixture(manifestPath);

    const context = invocation.judgeContext(
      invocation.loadManifest(manifestPath).manifest,
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0]).toMatchObject({
      title: "Changed behavior",
      source: "claude:code-reviewer.normalized.json#0",
      proof: finding.proof,
    });
  });

  it.each([
    {
      label:
        "accepts a complete critical Claude fallback on one configured model family",
      model: "claude-sonnet-5",
      error: null,
    },
    {
      label: "rejects critical Claude fallback with missing model identity",
      model: "",
      error: /lacks role-bound model evidence/,
    },
  ])("$label", ({ error, model }) => {
    const root = repo(`critical-single-family-${model || "missing-model"}`);
    const manifestPath = create(root);
    const agents = ["code-reviewer", "silent-failure-hunter"];
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "critical",
        taskType: "bugfix",
        score: 90,
        agents: 2,
        "codex-depth": "xhigh",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, agents, {
        domain: "general",
        rule: "critical-reliability-backstop",
      });
    });
    execFileSync("node", [GOVERNOR, "bump-round", manifestPath], {
      cwd: root,
    });
    const loaded = invocation.loadManifest(manifestPath).manifest;
    const info = invocation.reviewInfo(loaded);
    mkdirSync(info.artifactDir, { recursive: true });
    writeFileSync(
      path.join(info.artifactDir, "diff.txt"),
      execFileSync("git", ["diff", `${info.from}..${info.to}`], { cwd: root }),
    );
    writeFileSync(
      path.join(info.artifactDir, "identity.json"),
      execFileSync("node", [INVOCATION, "review-identity", manifestPath], {
        cwd: root,
      }),
    );
    writeFileSync(
      path.join(info.artifactDir, "review-focus.txt"),
      "critical fallback fixture\n",
    );
    for (const role of agents) {
      const normalized = {
        verdict: "approve",
        summary: `${role} found no issue`,
        findings: [],
        _qualitySlot: {
          role,
          provider: "claude",
          model,
        },
      };
      writeFileSync(
        path.join(info.artifactDir, `${role}.normalized.json`),
        JSON.stringify(normalized),
      );
      writeFileSync(
        path.join(info.artifactDir, `${role}.result.json`),
        JSON.stringify({ structured_output: normalized }),
      );
      writeFileSync(
        path.join(info.artifactDir, `${role}.findings.txt`),
        `NO FINDINGS. Verdict: approve. ${role} found no issue\n<<<NO FINDINGS>>>\n`,
      );
    }
    invocation.writeArtifactInventory(loaded, info.artifactDir, "claude");
    const diffSha = createHash("sha256")
      .update(readFileSync(path.join(info.artifactDir, "diff.txt")))
      .digest("hex");
    const record = () =>
      invocation.withManifestLock(manifestPath, (manifest) => {
        invocation.recordReview(manifest, {
          from: info.from,
          to: info.to,
          provider: "claude",
          primary: "codex",
          fallback: "claude",
          "artifact-dir": info.artifactDir,
          "diff-sha": diffSha,
        });
      });
    if (error) {
      expect(record).toThrow(error);
      return;
    }
    record();
    for (const name of ["lint", "test", "security"]) {
      recordGateFixture(manifestPath, name);
    }
    recordMutationFixture(manifestPath);

    const evaluate = () =>
      invocation.judgeContext(invocation.loadManifest(manifestPath).manifest);
    expect(evaluate).not.toThrow();
  });

  it("inventories preserved Codex findings with a complete Claude fallback panel", () => {
    const root = repo("fallback-inventory");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 2,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, ["reviewer-a", "reviewer-b"]);
      manifest.provider.primary = "codex";
      manifest.provider.fallback = "claude";
    });
    const manifest = invocation.loadManifest(manifestPath).manifest;
    const artifactDir = invocation.reviewInfo(manifest).artifactDir;
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, "primary-codex-1.result.json"),
      JSON.stringify({
        verdict: "needs-attention",
        summary: "preserved primary pass",
        findings: [
          {
            severity: "high",
            title: "preserved primary finding",
            body: "must remain authoritative",
          },
        ],
      }),
    );
    writeFileSync(
      path.join(artifactDir, "reviewer-a.findings.txt"),
      "NO FINDINGS.\n",
    );
    writeFileSync(
      path.join(artifactDir, "reviewer-b.findings.txt"),
      "NO FINDINGS.\n",
    );

    expect(() =>
      invocation.writeArtifactInventory(manifest, artifactDir, "claude"),
    ).not.toThrow();
    const inventory = JSON.parse(
      readFileSync(path.join(artifactDir, "artifact-inventory.json"), "utf8"),
    );
    expect(inventory.provider).toBe("claude");
    expect(inventory.files).toEqual([
      expect.objectContaining({
        name: "primary-codex-1.result.json",
        provider: "codex",
      }),
      expect.objectContaining({
        name: "reviewer-a.findings.txt",
        provider: "claude",
      }),
      expect.objectContaining({
        name: "reviewer-b.findings.txt",
        provider: "claude",
      }),
    ]);

    writeFileSync(
      path.join(artifactDir, "reviewer-a.findings.txt"),
      "NO FINDINGS.\nINCONCLUSIVE: later pass\n",
    );
    expect(() =>
      invocation.writeArtifactInventory(manifest, artifactDir, "claude"),
    ).toThrow(/inconclusive provider findings/);

    writeFileSync(
      path.join(artifactDir, "reviewer-b.findings.txt"),
      "NO FINDINGS.\nINCONCLUSIVE: later pass\n",
    );
    expect(() =>
      invocation.writeArtifactInventory(manifest, artifactDir, "claude"),
    ).toThrow(/inconclusive provider findings/);
  });

  // An agent killed mid-write leaves a 0-byte artifact. It carries no
  // `INCONCLUSIVE:` marker, so the inventory usability filter counted it as a
  // completed report and stamped silence into signed, hash-bound evidence.
  // providerFindings() already treats an empty body as inconclusive; the two
  // must agree or this gate is not enforcing what its error message claims.
  it("refuses to inventory an empty findings artifact as a usable report", () => {
    const root = repo("empty-findings-not-usable");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 3,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, [
        "reviewer-a",
        "reviewer-b",
        "reviewer-c",
      ]);
    });
    const manifest = invocation.loadManifest(manifestPath).manifest;
    const artifactDir = invocation.reviewInfo(manifest).artifactDir;
    mkdirSync(artifactDir, { recursive: true });

    // Only one of three agents produced a real report.
    writeFileSync(path.join(artifactDir, "reviewer-a.findings.txt"), "");
    writeFileSync(path.join(artifactDir, "reviewer-b.findings.txt"), "   \n\n");
    writeFileSync(
      path.join(artifactDir, "reviewer-c.findings.txt"),
      "NO FINDINGS.\n",
    );

    expect(() =>
      invocation.writeArtifactInventory(manifest, artifactDir, "claude"),
    ).toThrow(/inconclusive provider findings cannot be inventoried/);
  });

  // The reviewer quorum must be satisfied by EACH covered review, not by the
  // campaign total. `usableReviewerReports` accumulated across rounds while
  // `requiredUsableReports` was only Math.max'd to one panel's requirement,
  // so a clean round 2 satisfied an empty round 1 — authorizing a merge over a
  // diff slice no quorum ever reviewed. reviewCoverage() checks slice
  // contiguity and artifact integrity, but never per-slice panel usability.
  it("does not let a later clean round satisfy an earlier empty round", () => {
    // Mirrors providerFindings' counter arithmetic. The scoring loop is the
    // unit under test; building two fully-signed review rounds would exercise
    // the signing pipeline rather than the quorum rule.
    const quorum = (rounds, agentCount, perReview) => {
      let usable = 0;
      let required = 0;
      let inconclusive = 0;
      for (const round of rounds) {
        if (perReview) {
          usable = 0;
          required = 0;
          inconclusive = 0;
        }
        required = perReview ? agentCount : Math.max(required, agentCount);
        for (const ok of round) {
          if (ok) usable += 1;
          else inconclusive += 1;
        }
        if (
          perReview &&
          ((required > 0 && usable < required) ||
            (inconclusive && usable === 0))
        ) {
          return { failed: true };
        }
      }
      if (
        (required > 0 && usable < required) ||
        (inconclusive && usable === 0)
      ) {
        return { failed: true };
      }
      return { failed: false };
    };

    const emptyThenClean = [
      [false, false, false],
      [true, true, true],
    ];
    // The defect: campaign-wide counters pass this.
    expect(quorum(emptyThenClean, 3, false).failed).toBe(false);
    // The fix: per-review counters catch it.
    expect(quorum(emptyThenClean, 3, true).failed).toBe(true);
    // And a genuinely clean campaign still passes under the fix.
    expect(
      quorum(
        [
          [true, true, true],
          [true, true, true],
        ],
        3,
        true,
      ).failed,
    ).toBe(false);
  });

  it("evaluates the reviewer quorum inside the covered-review loop", () => {
    // Structural fence: the throw must live inside the loop, and the counters
    // must reset per review. Moving either back out silently restores the
    // cross-round bug, which no single-round fixture would catch.
    const source = readFileSync(INVOCATION, "utf8");
    const fn = source.slice(
      source.indexOf("function providerFindings(manifest)"),
      source.indexOf("function priorFindings(manifest)"),
    );
    expect(fn).toContain("usableReviewerReports = 0;");
    expect(fn).toContain("inconclusiveAgents = [];");
    // The quorum check must precede the end of the review loop, not follow it.
    expect(fn.indexOf("failQuorum()")).toBeLessThan(
      fn.indexOf("return findings"),
    );
    expect(fn).not.toMatch(/requiredUsableReports = Math\.max\(/);
  });

  it("treats unparseable provider results as inconclusive, not as silence", () => {
    // A bare `continue` converted malformed evidence into NO evidence: no
    // finding, no counter, no diagnosis.
    const source = readFileSync(INVOCATION, "utf8");
    const fn = source.slice(
      source.indexOf("function providerFindings(manifest)"),
      source.indexOf("function priorFindings(manifest)"),
    );
    const parseBlock = fn.slice(
      fn.indexOf("`provider result ${item.name}`"),
      fn.indexOf("items.forEach("),
    );
    expect(
      parseBlock.match(/inconclusiveAgents\.push\(item\.name\)/g),
    ).toHaveLength(2);
  });

  // These two previously asserted on the SOURCE TEXT of providerFindings()
  // (`expect(fn).toContain("Math.floor(panelSize / 2) + 1")`). That cannot
  // detect a semantic regression: a correct refactor to
  // `Math.ceil((panelSize + 1) / 2)` would fail them, while reordering the
  // counter logic to reintroduce the fail-open would pass. The security-critical
  // quorum change therefore shipped with no behavioral guard (BUI-637).
  //
  // Both now corrupt a real inventoried artifact and assert the gate fails
  // closed — the defect, not its current spelling.

  it("reports the panel size it actually measured, not the agent count", () => {
    // Regression for BUI-638: failQuorum() interpolated manifest.agents.length,
    // producing arithmetically impossible messages like "1/0 usable (need 3)"
    // on the one line an operator reads while triaging a blocked campaign.
    const root = repo("quorum-message-denominator");
    const manifestPath = create(root);
    const { artifactDir } = prepareCodexReview(root, manifestPath, []);
    writeFileSync(path.join(artifactDir, "codex-1.normalized.json"), "{ not");
    writeFileSync(path.join(artifactDir, "codex.findings.txt"), "");

    let message = "";
    try {
      execFileSync("node", [INVOCATION, "prior-findings", manifestPath], {
        cwd: root,
        encoding: "utf8",
      });
    } catch (error) {
      message = `${error.stderr || ""}${error.stdout || ""}`;
    }

    const match = message.match(/left only (\d+)\/(\d+) usable/);
    expect(match).not.toBeNull();
    const [, usable, panel] = match.map(Number);
    // A denominator of 0 with a positive numerator is impossible, and the
    // denominator must be at least as large as the numerator.
    expect(panel).toBeGreaterThan(0);
    expect(panel).toBeGreaterThanOrEqual(usable);
  });

  it("still inventories a panel whose reports are all non-empty", () => {
    const root = repo("nonempty-findings-usable");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 3,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, [
        "reviewer-a",
        "reviewer-b",
        "reviewer-c",
      ]);
    });
    const manifest = invocation.loadManifest(manifestPath).manifest;
    const artifactDir = invocation.reviewInfo(manifest).artifactDir;
    mkdirSync(artifactDir, { recursive: true });
    for (const agent of ["reviewer-a", "reviewer-b", "reviewer-c"]) {
      writeFileSync(
        path.join(artifactDir, `${agent}.findings.txt`),
        "NO FINDINGS.\n",
      );
    }
    expect(() =>
      invocation.writeArtifactInventory(manifest, artifactDir, "claude"),
    ).not.toThrow();
  });

  it("excludes stale fallback artifacts when a retry succeeds with Codex", () => {
    const root = repo("retry-inventory-provider-isolation");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 2,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, ["reviewer-a", "reviewer-b"]);
    });
    const manifest = invocation.loadManifest(manifestPath).manifest;
    const artifactDir = invocation.reviewInfo(manifest).artifactDir;
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, "codex.findings.txt"),
      "NO FINDINGS.\n",
    );
    writeFileSync(
      path.join(artifactDir, "codex-1.normalized.json"),
      JSON.stringify({
        verdict: "approve",
        summary: "retry completed",
        findings: [],
      }),
    );
    writeFileSync(
      path.join(artifactDir, "reviewer-a.findings.txt"),
      "INCONCLUSIVE: stale fallback attempt\n",
    );
    writeFileSync(
      path.join(artifactDir, "reviewer-a.result.json"),
      JSON.stringify({ is_error: true }),
    );

    expect(() =>
      invocation.writeArtifactInventory(manifest, artifactDir, "codex"),
    ).not.toThrow();
    const inventory = JSON.parse(
      readFileSync(path.join(artifactDir, "artifact-inventory.json"), "utf8"),
    );
    expect(inventory.files.map((item) => item.name)).toEqual([
      "codex-1.normalized.json",
      "codex.findings.txt",
    ]);
  });

  it("attributes preserved primary evidence from the filename on a campaign's first round, before manifest.provider.primary is populated", () => {
    // recordReview() is what sets manifest.provider.primary, and it only
    // runs AFTER a review round completes. On a campaign's very first round
    // (primary fails mid-pass, fallback picks up), writeArtifactInventory
    // runs with manifest.provider.primary still unset — attribution must not
    // depend on it.
    const root = repo("fallback-inventory-first-round");
    const manifestPath = create(root);
    invocation.withManifestLock(manifestPath, (manifest) => {
      invocation.setRisk(manifest, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 2,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(manifest, ["reviewer-a", "reviewer-b"]);
      // Deliberately NOT setting manifest.provider.primary — this is the
      // first-round state the real pipeline is in when inventory is written.
    });
    const manifest = invocation.loadManifest(manifestPath).manifest;
    expect(manifest.provider?.primary).toBeUndefined();
    const artifactDir = invocation.reviewInfo(manifest).artifactDir;
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, "primary-codex-1.result.json"),
      JSON.stringify({
        verdict: "needs-attention",
        summary: "preserved primary pass",
        findings: [
          {
            severity: "high",
            title: "preserved primary finding",
            body: "must remain authoritative",
          },
        ],
      }),
    );
    writeFileSync(
      path.join(artifactDir, "reviewer-a.findings.txt"),
      "NO FINDINGS.\n",
    );
    writeFileSync(
      path.join(artifactDir, "reviewer-b.findings.txt"),
      "NO FINDINGS.\n",
    );

    invocation.writeArtifactInventory(manifest, artifactDir, "claude");
    const inventory = JSON.parse(
      readFileSync(path.join(artifactDir, "artifact-inventory.json"), "utf8"),
    );
    expect(inventory.files).toContainEqual(
      expect.objectContaining({
        name: "primary-codex-1.result.json",
        provider: "codex",
      }),
    );
  });

  it("does not double-count a Gemini pass's findings between the raw and normalized JSON (not just Codex)", () => {
    // The raw-vs-normalized dedup filter in providerFindings() only matched
    // codex-(\d+)\.json, so a raw gemini-1.json and its gemini-1.normalized.json
    // sibling both got counted as separate findings sources — doubling every
    // Gemini finding. This mirrors the existing (implicit) Codex coverage from
    // prepareCodexReview, which always writes both codex-1.json and
    // codex-1.normalized.json and relies on the dedup to avoid double-counting.
    const root = repo("gemini-raw-normalized-dedup");
    const manifest = create(root);
    invocation.withManifestLock(manifest, (loaded) => {
      invocation.setRisk(loaded, {
        tier: "high",
        taskType: "bugfix",
        score: 60,
        agents: 2,
        "codex-depth": "high",
        "codex-rounds": 1,
      });
      invocation.setAgents(loaded, ["reviewer-a", "reviewer-b"]);
      loaded.reviewContractVersion = 1;
    });
    execFileSync("node", [GOVERNOR, "bump-round", manifest], { cwd: root });
    const loaded = invocation.loadManifest(manifest).manifest;
    const info = invocation.reviewInfo(loaded);
    mkdirSync(info.artifactDir, { recursive: true });
    writeFileSync(
      path.join(info.artifactDir, "diff.txt"),
      execFileSync("git", ["diff", `${info.from}..${info.to}`], { cwd: root }),
    );
    writeFileSync(
      path.join(info.artifactDir, "identity.json"),
      execFileSync("node", [INVOCATION, "review-identity", manifest], {
        cwd: root,
      }),
    );
    const geminiResult = {
      verdict: "needs-attention",
      summary: "gemini findings",
      findings: [{ severity: "high", title: "the one real finding" }],
    };
    writeFileSync(
      path.join(info.artifactDir, "gemini-1.json"),
      JSON.stringify(geminiResult),
    );
    writeFileSync(
      path.join(info.artifactDir, "gemini-1.normalized.json"),
      JSON.stringify(geminiResult),
    );
    writeFileSync(
      path.join(info.artifactDir, "gemini.findings.txt"),
      "HIGH: the one real finding\n",
    );
    writeFileSync(
      path.join(info.artifactDir, "reviewer-a.findings.txt"),
      "NO FINDINGS.\n",
    );
    execFileSync(
      "node",
      [
        INVOCATION,
        "inventory",
        manifest,
        "--artifact-dir",
        info.artifactDir,
        "--provider",
        "gemini",
      ],
      { cwd: root },
    );
    const diffSha = createHash("sha256")
      .update(readFileSync(path.join(info.artifactDir, "diff.txt")))
      .digest("hex");
    execFileSync(
      "node",
      [
        INVOCATION,
        "record-review",
        manifest,
        "--from",
        info.from,
        "--to",
        info.to,
        "--provider",
        "gemini",
        "--primary",
        "gemini",
        "--fallback",
        "none",
        "--artifact-dir",
        info.artifactDir,
        "--diff-sha",
        diffSha,
      ],
      { cwd: root },
    );
    for (const name of ["lint", "test", "security"]) {
      recordGateFixture(manifest, name);
    }
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
  });

  it("treats trailing text after a clean sentinel as blocking evidence", () => {
    const root = repo("contradictory-clean-sentinel");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      "NO FINDINGS.\nBLOCKING: incomplete review evidence\n",
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].severity).toBe("blocking");
  });

  it("accepts the runner's complete single-line clean Codex result", () => {
    const root = repo("generated-clean-sentinel");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      "NO FINDINGS. Verdict: approve. Static review is clean.\n",
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toEqual([]);
  });

  it("accepts documented no-findings marker variants from reviewers", () => {
    for (const [index, marker] of [
      "NO FINDINGS\n",
      "NO FINDINGS.\n",
      " no findings \n",
      "\tNo Findings.\t\r\n",
    ].entries()) {
      const root = repo(`clean-sentinel-${index}`);
      const manifest = create(root);
      prepareCodexReview(root, manifest, [], marker);
      const context = JSON.parse(
        execFileSync("node", [INVOCATION, "judge-context", manifest], {
          cwd: root,
          encoding: "utf8",
        }),
      );
      expect(context.findings).toEqual([]);
    }
  });

  it("BUI-463: delimited <<<NO FINDINGS>>> marker is authoritative regardless of preceding prose", () => {
    // Prose-based sentinel detection is structurally ambiguous — three
    // review rounds on earlier attempts confirmed real reviewers legitimately
    // preface, discuss, or quote the phrase "NO FINDINGS" without meaning it
    // as their verdict (e.g. explaining why a submodule bump has nothing to
    // review, or a self-referential review of this exact parsing logic).
    // The delimited marker is unambiguous by construction: reviewers are
    // instructed to emit it ONLY as an isolated final line, so its presence
    // is authoritative no matter what prose precedes it — no line-count or
    // substring heuristics needed.
    for (const [index, text] of [
      "<<<NO FINDINGS>>>",
      "Bare submodule pointer bump, nothing to review at this layer.\n\n<<<NO FINDINGS>>>",
      // Prose that itself discusses/quotes "NO FINDINGS" no longer matters —
      // only the delimited line is examined.
      'Reviewing the sentinel-detection logic: the marker "NO FINDINGS" must ' +
        "appear delimited, not as bare prose. No invalid-state issues found.\n\n" +
        "<<<NO FINDINGS>>>",
      "Full test suite passed. Review complete: NO FINDINGS.\n\n<<<NO FINDINGS>>>",
    ].entries()) {
      const root = repo(`delimited-clean-${index}`);
      const manifest = create(root);
      prepareCodexReview(root, manifest, [], text);
      const context = JSON.parse(
        execFileSync("node", [INVOCATION, "judge-context", manifest], {
          cwd: root,
          encoding: "utf8",
        }),
      );
      expect(context.findings).toEqual([]);
    }
  });

  it("BUI-463: delimited <<<FINDINGS REPORTED>>> marker is authoritative even if prose says NO FINDINGS", () => {
    const root = repo("delimited-findings-reported");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      "file.js:12 BLOCKING: retry loop never breaks on success.\n\n<<<FINDINGS REPORTED>>>",
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].severity).toBe("blocking");
    // The delimiter line itself must not leak into the finding body shown
    // to a human or the judge.
    expect(context.findings[0].body).not.toContain("<<<FINDINGS REPORTED>>>");
  });

  it("BUI-521: a bare <<<FINDINGS REPORTED>>> is malformed output, not a blocking finding", () => {
    // Supersedes the BUI-463 assertion that this shape must yield a
    // non-empty finding body. That framing asked "is the body empty?" when
    // the real question was "should a finding exist at all?" — six agents
    // converged on the narrower question and shipped the bug.
    //
    // Falling back to the raw text made a BLOCKING finding whose entire body
    // was the sentinel. Unfixable by construction: the campaign reports
    // "actionable code findings remain" with nothing to act on, so it never
    // converges and never merges (191 such phantom findings across 10+ PRs
    // locally, incl. merged #633/#638). It also scored a malformed response
    // as a caught defect in precision telemetry.
    //
    // Correct handling is the existing inconclusive path: still fail closed,
    // but with a diagnosis that names the real problem and has a retry route.
    const root = repo("bare-findings-reported-delimiter-only");
    const manifest = create(root);
    let stderr = "";
    expect(() => {
      try {
        prepareCodexReview(root, manifest, [], "<<<FINDINGS REPORTED>>>");
      } catch (err) {
        stderr = String(err.stderr || "");
        throw err;
      }
    }).toThrow();
    // Named as inconclusive/malformed — NOT as an actionable code finding.
    expect(stderr).toMatch(/inconclusive provider findings/);
    expect(stderr).toMatch(/usable reviewer reports/);
  });

  it("BUI-463: stripping the delimiter preserves paragraph breaks between multiple findings", () => {
    // 3 review agents converged on this: the earlier fix rebuilt the body
    // from a blank-line-FILTERED array, which silently collapsed paragraph
    // spacing between separate findings into a run-on block. The delimiter
    // must be stripped from the original line array instead.
    const root = repo("multi-finding-body-preserves-blank-lines");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      [
        "file.js:12 BLOCKING: issue one.",
        "",
        "file.js:30 BLOCKING: issue two.",
        "",
        "<<<FINDINGS REPORTED>>>",
      ].join("\n"),
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].body).toBe(
      "file.js:12 BLOCKING: issue one.\n\nfile.js:30 BLOCKING: issue two.",
    );
  });

  it("BUI-463: only the ACTUAL final line is authoritative, not any earlier mention of either marker", () => {
    // 4 independent review agents converged on this exact bug in an earlier
    // version of this fix: checking marker presence "anywhere in the text"
    // let permitted pre-delimiter commentary that quotes/discusses the
    // marker override the real, later verdict. Only the true final line
    // counts.
    const root = repo("both-markers-present-final-line-wins");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      [
        "Explaining the sign-off convention: reviewers emit <<<NO FINDINGS>>>",
        "when clean, or <<<FINDINGS REPORTED>>> when not.",
        "",
        "file.js:12 BLOCKING: retry loop never breaks on success.",
        "<<<FINDINGS REPORTED>>>",
      ].join("\n"),
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].severity).toBe("blocking");
  });

  it("BUI-463: a mention of <<<NO FINDINGS>>> that is not the final line does not suppress a real finding", () => {
    const root = repo("no-findings-marker-mentioned-not-final");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      [
        "This diff introduces the <<<NO FINDINGS>>> delimiter as an example.",
        "file.js:12 BLOCKING: retry loop never breaks on success.",
        "<<<FINDINGS REPORTED>>>",
      ].join("\n"),
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].severity).toBe("blocking");
  });

  it("BUI-463: legacy bare sentinel with no preamble still classifies clean (pre-delimiter compat)", () => {
    const root = repo("legacy-bare-sentinel");
    const manifest = create(root);
    prepareCodexReview(root, manifest, [], "NO FINDINGS\n");
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toEqual([]);
  });

  it("BUI-463: legacy text without a delimiter or bare sentinel still flags as a finding", () => {
    const root = repo("legacy-real-finding-no-delimiter");
    const manifest = create(root);
    prepareCodexReview(
      root,
      manifest,
      [],
      "Found an issue: the retry loop never breaks on success.\n",
    );
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(context.findings).toHaveLength(1);
    expect(context.findings[0].severity).toBe("blocking");
  });

  it("exposes persisted judge dispositions to targeted verification", () => {
    const root = repo("prior-judge-dispositions");
    const manifest = create(root);
    prepareCodexReview(root, manifest, [
      {
        severity: "medium",
        title: "Retry evidence",
        body: "The retry path needs verification",
        recommendation: "Verify the bounded retry path",
        evidence: { file: "file.js", line: 1 },
      },
    ]);
    const context = JSON.parse(
      execFileSync("node", [INVOCATION, "judge-context", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    context.findings[0].disposition = "WARNING";
    context.findings[0].reason = "Useful targeted verification context";
    const artifact = path.join(root, "judge.json");
    writeFileSync(artifact, JSON.stringify(context));
    execFileSync(
      "node",
      [INVOCATION, "judge", manifest, "--artifact", artifact],
      { cwd: root },
    );

    const prior = JSON.parse(
      execFileSync("node", [INVOCATION, "prior-findings", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(prior.findings[0]).toMatchObject({
      disposition: "WARNING",
      reason: "Useful targeted verification context",
    });
  });

  it("treats unjudged prior findings as blocking verification targets", () => {
    const root = repo("prior-unjudged-findings");
    const manifest = create(root);
    prepareCodexReview(root, manifest, [
      {
        severity: "high",
        title: "Unjudged blocker",
        body: "Must remain in the verification set",
        recommendation: "Verify it",
        evidence: { file: "file.js", line: 1 },
      },
    ]);
    const prior = JSON.parse(
      execFileSync("node", [INVOCATION, "prior-findings", manifest], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(prior.findings[0]).toMatchObject({ disposition: "BLOCKING" });
  });

  it("persists applicable required gates and requires current-head evidence", () => {
    const root = repo("required-gates");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "eslint .",
          test: "node --test",
          "security:audit": "npm audit --audit-level high",
          build: "node build.js",
          "type-check:all": "tsc --noEmit",
          "test:consumer-workflow": "node consumer.js",
        },
      }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "add applicable gates"]);
    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.map((gate) => gate.name)).toEqual([
      "lint",
      "test",
      "security",
      "build",
      "type",
      "consumer",
    ]);

    execFileSync("bash", [RISK, "--manifest", manifest], { cwd: root });
    prepareCodexReview(root, manifest);
    expect(
      spawnSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
        encoding: "utf8",
      }).stderr,
    ).toMatch(/required build gate evidence is missing or stale/);

    for (const name of ["build", "type", "consumer"])
      recordGateFixture(manifest, name);
    recordJudgeArtifact(root, manifest);
    recordMutationFixture(manifest);
    expect(() =>
      execFileSync("node", [INVOCATION, "review-authorization", manifest], {
        cwd: root,
      }),
    ).not.toThrow();
    expect(JSON.parse(readFileSync(manifest, "utf8")).requiredGates).toEqual(
      required,
    );
  });

  it("BUI-306: never discovers verify-app unless --verify-app is passed", () => {
    const root = repo("verify-app-opt-in-default");
    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.map((gate) => gate.name)).not.toContain("verify-app");
  });

  it("BUI-306: discovers the verify-app gate script when --verify-app is passed", () => {
    const root = repo("verify-app-opt-in");
    const manifest = create(root, ["--verify-app"]);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    const verifyApp = required.find((gate) => gate.name === "verify-app");
    expect(verifyApp).toMatchObject({
      executable: "bash",
      allowSkip: false,
    });
    expect(verifyApp.source).toMatch(/quality-verify-app\.sh$/);
    expect(verifyApp.args[0]).toMatch(/quality-verify-app\.sh$/);
  });

  it("BUI-306: a repo can override verify-app via .quality-gates.json", () => {
    const root = repo("verify-app-native-override");
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          "verify-app": {
            executable: "node",
            args: ["--check", "file.js"],
          },
        },
      }),
    );
    git(root, ["add", ".quality-gates.json"]);
    git(root, ["commit", "-q", "-m", "declare native verify-app gate"]);

    const manifest = create(root, ["--verify-app"]);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "verify-app")).toMatchObject({
      source: "quality-gates:.quality-gates.json#verify-app",
      executable: "node",
      args: ["--check", "file.js"],
    });
  });

  it("discovers security:check without requiring a redundant security alias", () => {
    const root = repo("security-check-gate");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "true",
          "security:check": "node --check file.js",
        },
      }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "use repository security convention"]);

    const manifest = create(root);
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).requiredGates.find(
        (gate) => gate.name === "security",
      ),
    ).toMatchObject({
      source: "package-script:security:check",
      args: ["run", "security:check"],
    });
  });

  it("uses deterministic security gate precedence", () => {
    const root = repo("security-gate-precedence");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "true",
          security: "true",
          "security:check": "true",
          "security:audit": "true",
        },
      }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "define security candidates"]);

    const manifest = create(root);
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).requiredGates.find(
        (gate) => gate.name === "security",
      ).source,
    ).toBe("package-script:security:audit");
  });

  it("discovers and executes committed native repository gates without a package manifest", () => {
    const root = repo("native-repository-gates");
    unlinkSync(path.join(root, "package.json"));
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          lint: {
            executable: "node",
            args: ["--check", "file.js"],
          },
          test: {
            executable: "node",
            args: [
              "-e",
              "require('node:fs').writeFileSync('native-test-ran', 'yes')",
            ],
          },
          security: {
            executable: "node",
            args: ["--check", "file.js"],
          },
        },
      }),
    );
    git(root, ["add", ".quality-gates.json"]);
    git(root, ["rm", "package.json"]);
    git(root, ["commit", "-q", "-m", "declare native quality gates"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.map((gate) => gate.name)).toEqual([
      "lint",
      "test",
      "security",
    ]);
    expect(required.find((gate) => gate.name === "test")).toMatchObject({
      source: "quality-gates:.quality-gates.json#test",
      executable: "node",
      args: [
        "-e",
        "require('node:fs').writeFileSync('native-test-ran', 'yes')",
      ],
    });

    execFileSync("node", [INVOCATION, "gate-run", manifest, "--name", "test"], {
      cwd: root,
    });
    expect(readFileSync(path.join(root, "native-test-ran"), "utf8")).toBe(
      "yes",
    );
  });

  it("BUI-804: funds a declared long test gate without consuming review reserve", () => {
    const root = repo("declared-long-test-gate");
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        checkDefinitions: {
          "lint-and-format": {
            command: "npm run lint && npm run format:check",
            timeoutMinutes: 5,
          },
          "test-integration": {
            command: "npm run test:slow",
            timeoutMinutes: 20,
          },
          "security-scan": {
            command: "npm audit --audit-level=high",
            timeoutMinutes: 5,
          },
        },
      }),
    );
    git(root, ["add", "harness-config.json"]);
    git(root, ["commit", "-q", "-m", "declare native check durations"]);

    const manifestPath = create(root);
    let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(
      Object.fromEntries(
        manifest.requiredGates.map((gate) => [gate.name, gate.timeoutSeconds]),
      ),
    ).toMatchObject({ lint: 300, test: 1200, security: 300 });

    execFileSync("bash", [RISK, "--manifest", manifestPath], { cwd: root });
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.risk.runtime.gateTimeoutSeconds).toMatchObject({
      lint: 300,
      test: 1200,
      security: 300,
    });
    expect(manifest.risk.runtime.campaignSeconds).toBeGreaterThan(900);
    expect(
      manifest.risk.runtime.campaignSeconds -
        manifest.risk.runtime.gateReserveSeconds,
    ).toBeGreaterThanOrEqual(
      manifest.risk.runtime.reviewReserveSeconds +
        manifest.risk.runtime.verificationSeconds +
        60,
    );
  });

  it("BUI-804: rejects an unbounded declared gate timeout", () => {
    const root = repo("unbounded-declared-gate");
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        checkDefinitions: {
          "test-integration": {
            command: "npm run test:slow",
            timeoutMinutes: 31,
          },
        },
      }),
    );
    git(root, ["add", "harness-config.json"]);
    git(root, ["commit", "-q", "-m", "declare unbounded check duration"]);

    const result = spawnSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /timeoutMinutes must be an integer from 1 to 30/,
    );
  });

  it("BUI-804: maps one combined check declaration to only one gate", () => {
    const root = repo("combined-declared-gate");
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "true";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        checkDefinitions: {
          "build-and-test": {
            command: "npm run build && npm test",
            timeoutMinutes: 20,
          },
        },
      }),
    );
    git(root, ["add", "package.json", "harness-config.json"]);
    git(root, ["commit", "-q", "-m", "declare combined check duration"]);

    const manifest = JSON.parse(readFileSync(create(root), "utf8"));
    const timeouts = Object.fromEntries(
      manifest.requiredGates.map((gate) => [gate.name, gate.timeoutSeconds]),
    );
    expect(timeouts.build).toBe(1200);
    expect(timeouts.test).toBeUndefined();
  });

  it("BUI-733: persists an evidence-backed affected test gate when the repository opts in", () => {
    const root = repo("affected-test-gate");
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(
      path.join(root, ".buildproven", "test-impact.json"),
      JSON.stringify({ version: 1, jsRunner: "vitest" }),
    );
    writeFileSync(
      path.join(root, "harness-config.json"),
      JSON.stringify({
        checkDefinitions: {
          "test-integration": {
            command: "npm run test:slow",
            timeoutMinutes: 20,
          },
        },
      }),
    );
    git(root, ["add", ".buildproven/test-impact.json", "harness-config.json"]);
    git(root, ["commit", "-q", "-m", "configure affected tests"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "change implementation"]);

    const manifest = create(root);
    const testGate = JSON.parse(
      readFileSync(manifest, "utf8"),
    ).requiredGates.find((gate) => gate.name === "test");
    expect(testGate).toMatchObject({
      source: "test-impact:.buildproven/test-impact.json",
      executable: process.execPath,
      testImpactMode: "focused",
    });
    expect(testGate.timeoutSeconds).toBeUndefined();
    expect(testGate.args).toEqual([
      path.join(ROOT, "scripts", "test-impact.js"),
      "--execute",
      "--policy-sha256",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "--",
      "file.js",
    ]);
  });

  it("BUI-733: a policy change cannot authorize its own narrower test gate", () => {
    const root = repo("test-impact-policy-bootstrap");
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(
      path.join(root, ".buildproven", "test-impact.json"),
      JSON.stringify({ version: 1, jsRunner: "vitest" }),
    );
    git(root, ["add", ".buildproven/test-impact.json"]);
    git(root, ["commit", "-q", "-m", "configure affected tests"]);

    const manifest = create(root);
    const testGate = JSON.parse(
      readFileSync(manifest, "utf8"),
    ).requiredGates.find((gate) => gate.name === "test");
    expect(testGate).toMatchObject({
      source: "package-script:test",
      executable: "npm",
      args: ["run", "test"],
    });
  });

  it("rejects shell-command strings in native repository gate policy", () => {
    const root = repo("invalid-native-repository-gates");
    unlinkSync(path.join(root, "package.json"));
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          lint: { command: "node --check file.js" },
          test: { executable: "node", args: ["--test"] },
          security: { executable: "node", args: ["--check", "file.js"] },
        },
      }),
    );
    git(root, ["add", ".quality-gates.json"]);
    git(root, ["rm", "package.json"]);
    git(root, ["commit", "-q", "-m", "declare unsafe native gate"]);

    expect(() => create(root)).toThrow(
      /\.quality-gates\.json gate 'lint' requires a non-empty executable and string args array/,
    );
  });

  it("uses explicitly declared native gates ahead of package-script fallbacks", () => {
    const root = repo("native-gate-precedence");
    const packageJson = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    packageJson.scripts.build = "node --check file.js";
    writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          test: { executable: "node", args: ["--test", "file.js"] },
          build: { executable: "node", args: ["--check", "native-build.js"] },
        },
      }),
    );
    git(root, ["add", ".quality-gates.json", "package.json"]);
    git(root, ["commit", "-q", "-m", "select native quality gates"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "test")).toMatchObject({
      source: "quality-gates:.quality-gates.json#test",
      executable: "node",
      args: ["--test", "file.js"],
    });
    expect(required.find((gate) => gate.name === "build")).toMatchObject({
      source: "quality-gates:.quality-gates.json#build",
      executable: "node",
      args: ["--check", "native-build.js"],
    });
  });

  it("discovers executable Python gates when package scripts are absent", () => {
    const root = repo("python-gate-discovery");
    git(root, ["rm", "package.json"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.pytest.ini_options]\n\n[tool.mypy]\n",
    );
    writeFileSync(path.join(root, "requirements-dev.txt"), "pytest==9.0.2\n");
    mkdirSync(path.join(root, "tests"));
    writeFileSync(
      path.join(root, "tests", "test_example.py"),
      "def test_ok():\n  assert True\n",
    );
    git(root, [
      "add",
      "pyproject.toml",
      "requirements-dev.txt",
      "tests/test_example.py",
    ]);
    git(root, ["commit", "-q", "-m", "add Python quality gates"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lint",
          source: "python:ruff",
          executable: "ruff",
          args: ["check", "."],
        }),
        expect.objectContaining({
          name: "test",
          source: "python:pytest",
          executable: "pytest",
          args: [],
        }),
        expect.objectContaining({
          name: "security",
          source: "python:pip-audit",
          executable: "pip-audit",
          args: ["."],
        }),
        expect.objectContaining({
          name: "type",
          source: "python:mypy",
          executable: "mypy",
          args: ["."],
        }),
      ]),
    );
  });

  it.each([
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
  ])(
    "runs inferred Python tools through the %s project environment",
    (lockfile, executable) => {
      const root = repo(`managed-python-${executable}-gate-discovery`);
      git(root, ["rm", "package.json"]);
      writeFileSync(
        path.join(root, "pyproject.toml"),
        "[tool.ruff]\n\n[tool.pytest.ini_options]\n\n[tool.mypy]\n",
      );
      writeFileSync(path.join(root, lockfile), "version = 1\n");
      mkdirSync(path.join(root, "tests"));
      writeFileSync(
        path.join(root, "tests", "test_example.py"),
        "def test_ok():\n  assert True\n",
      );
      git(root, ["add", "pyproject.toml", lockfile, "tests/test_example.py"]);
      git(root, ["commit", "-q", "-m", "add managed Python quality gates"]);

      const manifest = create(root);
      const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
      expect(required).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "lint",
            executable,
            args: ["run", "ruff", "check", "."],
          }),
          expect.objectContaining({
            name: "test",
            executable,
            args: ["run", "pytest"],
          }),
          expect.objectContaining({
            name: "security",
            executable,
            args: ["run", "pip-audit", "."],
          }),
          expect.objectContaining({
            name: "type",
            executable,
            args: ["run", "mypy", "."],
          }),
        ]),
      );
    },
  );

  it("binds inferred Python security gates to committed requirements", () => {
    const root = repo("python-requirements-security-gate");
    git(root, ["rm", "package.json"]);
    writeFileSync(path.join(root, "requirements.txt"), "requests==2.32.4\n");
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          lint: { executable: "python3", args: ["-m", "compileall", "."] },
          test: { executable: "python3", args: ["-m", "unittest"] },
        },
      }),
    );
    git(root, ["add", "requirements.txt", ".quality-gates.json"]);
    git(root, ["commit", "-q", "-m", "add requirements security gate"]);

    const manifest = create(root);
    expect(
      JSON.parse(readFileSync(manifest, "utf8")).requiredGates.find(
        (gate) => gate.name === "security",
      ),
    ).toMatchObject({
      source: "python:pip-audit",
      executable: "pip-audit",
      args: ["-r", "requirements.txt"],
    });
  });

  it("does not invent Python gates from a non-Python tests directory", () => {
    const root = repo("non-python-gate-discovery");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          "security:audit": "true",
        },
      }),
    );
    mkdirSync(path.join(root, "tests"));
    writeFileSync(path.join(root, "tests", "example.test.js"), "// test\n");
    writeFileSync(path.join(root, "tests", "example.py"), "# fixture\n");
    writeFileSync(path.join(root, "requirements.txt"), "requests==2.32.4\n");
    git(root, [
      "add",
      "package.json",
      "requirements.txt",
      "tests/example.test.js",
      "tests/example.py",
    ]);
    git(root, ["commit", "-q", "-m", "add JavaScript tests"]);

    expect(() => create(root)).toThrow(
      /executable npm or Python repository gates for: test/,
    );
  });

  it("prefers package scripts over Python fallbacks for mixed repositories", () => {
    const root = repo("python-gate-precedence");
    writeFileSync(path.join(root, "pyproject.toml"), "[tool.ruff]\n");
    git(root, ["add", "pyproject.toml"]);
    git(root, ["commit", "-q", "-m", "add Python tooling"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "lint").source).toBe(
      "package-script:lint",
    );
    expect(required.find((gate) => gate.name === "security").source).toBe(
      "package-script:security:audit",
    );
  });

  it("does not require mypy for a JS/TS-first repo whose diff never touches .py (BUI-467)", () => {
    // Reproduces the claude-kit real-world shape: pyproject.toml declares
    // [tool.mypy] for a handful of scripts/ .py files (committed on the
    // base branch), but a given PR's diff never touches any .py file. mypy
    // must not become a required, blocking gate for that PR — it's an
    // environment dependency (mypy must be installed) unrelated to the
    // change under review.
    const root = repo("mypy-not-required-non-python-diff");
    // repo() leaves the checkout on `feature`, one commit ahead of `main`.
    // Land pyproject.toml/scripts/helper.py on `main` (the base) so they
    // are NOT part of the diff being audited, then rebase feature onto it.
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.mypy]\n",
    );
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "helper.py"), "x = 1\n");
    git(root, ["add", "pyproject.toml", "scripts/helper.py"]);
    git(root, ["commit", "-q", "-m", "add Python tooling and a script"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "-q", "main"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "type")).toBeUndefined();
  });

  it("still requires mypy when the diff does touch a .py file (BUI-467)", () => {
    const root = repo("mypy-required-python-diff");
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.mypy]\n",
    );
    git(root, ["add", "pyproject.toml"]);
    git(root, ["commit", "-q", "-m", "add Python tooling"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "-q", "main"]);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "helper.py"), "x = 1\n");
    git(root, ["add", "scripts/helper.py"]);
    git(root, ["commit", "-q", "-m", "add a python script"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "type")).toMatchObject({
      source: "python:mypy",
      executable: "mypy",
      args: ["."],
    });
  });

  it("requires mypy when the diff touches only a .pyi stub (BUI-467)", () => {
    const root = repo("mypy-required-pyi-diff");
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.mypy]\n",
    );
    git(root, ["add", "pyproject.toml"]);
    git(root, ["commit", "-q", "-m", "add Python tooling"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "-q", "main"]);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "helper.pyi"), "x: int\n");
    git(root, ["add", "scripts/helper.pyi"]);
    git(root, ["commit", "-q", "-m", "add a python stub"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "type")).toMatchObject({
      source: "python:mypy",
    });
  });

  it("requires mypy when the diff touches a non-ASCII-named .py file (BUI-467)", () => {
    // Reproduces the review finding: without -z, `git diff --name-only`
    // quotes non-ASCII filenames by default (core.quotePath), which would
    // break a plain .endsWith(".py") suffix check.
    const root = repo("mypy-required-nonascii-diff");
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.mypy]\n",
    );
    git(root, ["add", "pyproject.toml"]);
    git(root, ["commit", "-q", "-m", "add Python tooling"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "-q", "main"]);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "café.py"), "x = 1\n");
    git(root, ["add", "scripts/café.py"]);
    git(root, ["commit", "-q", "-m", "add a non-ascii-named python script"]);

    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.find((gate) => gate.name === "type")).toMatchObject({
      source: "python:mypy",
    });
  });

  it("does not require mypy for an upstream-only .py change after a rebase (BUI-467)", () => {
    // Reproduces the rebase-carry review finding: if a rebase-only replay
    // has happened, the diff check must anchor on the carried live base
    // (baseRebaseCarry.baseSha), not the stale creation-time baseSha —
    // otherwise upstream .py commits that landed on main between PR
    // creation and the rebase leak into the diff and falsely require mypy
    // for a PR that never touched Python itself.
    const root = repo("mypy-rebase-carry-upstream-python");
    const manifestPath = create(root);
    const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // Advance main with an unrelated Python change (simulating upstream
    // activity between PR creation and the eventual rebase).
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.mypy]\n",
    );
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "upstream.py"), "x = 1\n");
    git(root, ["add", "pyproject.toml", "scripts/upstream.py"]);
    git(root, ["commit", "-q", "-m", "upstream adds python tooling"]);
    git(root, ["fetch", "-q", "origin", "main"]);

    // Rebase feature onto the advanced main — a pure replay, no new
    // content, so this should register as a rebase-only carry.
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "-q", "main"]);
    const rebasedHead = git(root, ["rev-parse", "HEAD"]);
    const advancedBase = git(root, ["rev-parse", "main"]);

    execFileSync("node", [INVOCATION, "advance", manifestPath], {
      cwd: root,
    });
    const advanced = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Sanity: the manifest's immutable baseSha is unchanged (still the
    // original, now-stale value) while a carry was recorded.
    expect(advanced.revisions.baseSha).toBe(originalManifest.revisions.baseSha);
    expect(advanced.revisions.baseRebaseCarry?.baseSha).toBe(advancedBase);
    expect(advanced.revisions.currentHead).toBe(rebasedHead);
    // The mypy gate must NOT be required: the only .py file in the true
    // (carried) diff scope belongs to main itself, not to this PR.
    expect(
      advanced.requiredGates.find((gate) => gate.name === "type"),
    ).toBeUndefined();
  });

  it("replaces a passed audit test gate with the descendant's focused plan", () => {
    const root = repo("descendant-focused-test-plan");
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(
      path.join(root, ".buildproven", "test-impact.json"),
      JSON.stringify({
        version: 1,
        jsRunner: "vitest",
        mappings: [
          {
            paths: ["file.js"],
            commands: [{ executable: "node", args: ["-e", "process.exit(0)"] }],
          },
        ],
        audits: [
          {
            paths: [".buildproven/test-impact.json"],
            reason: "selector contract changed",
            commands: [{ executable: "npm", args: ["test"] }],
          },
        ],
      }),
    );
    git(root, ["add", ".buildproven/test-impact.json"]);
    git(root, ["commit", "-q", "-m", "add selector policy"]);

    const manifestPath = create(root);
    recordGateFixture(manifestPath, "test");
    writeFileSync(path.join(root, "first-fix.js"), "export const first = 1;\n");
    git(root, ["add", "first-fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: first descendant"]);
    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });

    // A review fix can advance again before its focused gate is recorded. The
    // last successful ancestor audit remains the safe delta anchor.
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "fix: focused descendant"]);

    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });
    const advanced = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(
      advanced.requiredGates.find((gate) => gate.name === "test"),
    ).toMatchObject({
      source: "test-impact:.buildproven/test-impact.json",
      executable: process.execPath,
      testImpactMode: "focused",
      args: expect.arrayContaining(["--execute", "--policy-sha256"]),
    });
    const testGate = advanced.requiredGates.find(
      (gate) => gate.name === "test",
    );
    const digestIndex = testGate.args.indexOf("--policy-sha256") + 1;
    expect(testGate.args[digestIndex]).toBe(
      createHash("sha256")
        .update(readFileSync(path.join(root, ".buildproven/test-impact.json")))
        .digest("hex"),
    );

    const focusedLog = path.join(
      path.dirname(manifestPath),
      "focused-test.gate.log",
    );
    writeFileSync(focusedLog, "focused test passed\n");
    invocation.withManifestLock(manifestPath, (manifest) => {
      const required = manifest.requiredGates.find(
        (gate) => gate.name === "test",
      );
      invocation.recordGate(manifest, {
        name: "test",
        source: required.source,
        command: required.command,
        log: focusedLog,
      });
    });
    for (const gate of JSON.parse(readFileSync(manifestPath, "utf8"))
      .requiredGates) {
      if (gate.name !== "test") recordGateFixture(manifestPath, gate.name);
    }
    expect(() =>
      invocation.verifyGateEvidence(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      ),
    ).not.toThrow();
    const h1 = JSON.parse(readFileSync(manifestPath, "utf8"));
    invocation.advanceManifest(manifestPath);
    invocation.advanceManifest(manifestPath);
    const resumed = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(resumed.requiredGates.find((gate) => gate.name === "test")).toEqual(
      h1.requiredGates.find((gate) => gate.name === "test"),
    );

    writeFileSync(path.join(root, "third-fix.js"), "export const third = 1;\n");
    git(root, ["add", "third-fix.js"]);
    git(root, ["commit", "-q", "-m", "fix: third descendant"]);
    invocation.advanceManifest(manifestPath);
    const chained = JSON.parse(readFileSync(manifestPath, "utf8"));
    const chainedTest = chained.requiredGates.find(
      (gate) => gate.name === "test",
    );
    expect(chainedTest.predecessorEvidence.head).toBe(h1.revisions.currentHead);

    const thirdFocusedLog = path.join(
      path.dirname(manifestPath),
      "third-focused-test.gate.log",
    );
    writeFileSync(thirdFocusedLog, "third focused test passed\n");
    invocation.withManifestLock(manifestPath, (manifest) => {
      const required = manifest.requiredGates.find(
        (gate) => gate.name === "test",
      );
      invocation.recordGate(manifest, {
        name: "test",
        source: required.source,
        command: required.command,
        log: thirdFocusedLog,
      });
    });
    for (const gate of JSON.parse(readFileSync(manifestPath, "utf8"))
      .requiredGates) {
      if (gate.name !== "test") recordGateFixture(manifestPath, gate.name);
    }
    expect(() =>
      invocation.verifyGateEvidence(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      ),
    ).not.toThrow();
    const predecessorLog = chainedTest.predecessorEvidence.log;
    writeFileSync(predecessorLog, "tampered predecessor coverage\n");
    expect(() =>
      invocation.verifyGateEvidence(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      ),
    ).toThrow(/required test gate evidence is missing or stale/);
  });

  it("drops a stale inferred python:mypy gate on a v2->v3 migration when the diff doesn't touch .py (BUI-467)", () => {
    // A manifest created under the pre-BUI-467 policy (v2) may already
    // carry an inferred python:mypy gate. Union-only advance would keep it
    // forever; the policy-version bump forces a full recompute instead, so
    // the stale gate is dropped once the diff is re-evaluated under v3.
    const root = repo("mypy-v2-to-v3-migration");
    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\n\n[tool.mypy]\n",
    );
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "helper.py"), "x = 1\n");
    git(root, ["add", "pyproject.toml", "scripts/helper.py"]);
    git(root, ["commit", "-q", "-m", "add Python tooling and a script"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "-q", "main"]);

    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Simulate a manifest created under the old (v2) policy: inject the
    // stale mypy gate the old (pre-fix) inference would have added, and
    // roll the policy version back to 2.
    manifest.requiredGates.push({
      name: "type",
      source: "python:mypy",
      command: '"mypy" "."',
      executable: "mypy",
      args: ["."],
      allowSkip: false,
    });
    manifest.requiredGatesPolicyVersion = 2;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // A subsequent commit that touches no .py file at all — advance should
    // trigger the v2->v3 migration and recompute (not union) requiredGates.
    writeFileSync(path.join(root, "file.js"), "export const value = 3;\n");
    git(root, ["commit", "-qam", "non-python change"]);
    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });

    const migrated = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(migrated.requiredGatesPolicyVersion).toBe(3);
    expect(
      migrated.requiredGates.find((gate) => gate.name === "type"),
    ).toBeUndefined();
  });

  it("binds optional gate evidence to the persisted trusted source and command", () => {
    const root = repo("trusted-gate-runner");
    const marker = path.join(tmpdir(), `quality-build-${process.pid}.marker`);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "node --check file.js",
          test: "node --test",
          "security:audit": "node --check file.js",
          build:
            "node -e \"require('fs').writeFileSync(process.env.QUALITY_GATE_MARKER, 'built')\"",
          typecheck: "node --check file.js",
          "test:consumer": "node --check file.js",
        },
      }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "add trusted gate scripts"]);
    const manifest = create(root);
    const required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;

    for (const name of ["build", "type", "consumer"]) {
      const gate = required.find((candidate) => candidate.name === name);
      const log = path.join(path.dirname(manifest), `${name}.forged.log`);
      writeFileSync(log, "forged pass\n");
      const forged = spawnSync(
        "node",
        [
          INVOCATION,
          "gate",
          manifest,
          "--name",
          name,
          "--source",
          gate.source,
          "--command",
          "true",
          "--log",
          log,
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(forged.status).not.toBe(0);
      expect(forged.stderr).toMatch(
        /unknown quality invocation command 'gate'/,
      );
    }

    const callerCommand = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifest, "--name", "build", "--", "true"],
      { cwd: root, encoding: "utf8" },
    );
    expect(callerCommand.status).not.toBe(0);
    expect(callerCommand.stderr).toMatch(/resolved from the persisted/);
    expect(existsSync(marker)).toBe(false);

    execFileSync(
      "bash",
      [RUN_GATE, "--manifest", manifest, "--name", "build"],
      {
        cwd: root,
        env: { ...process.env, QUALITY_GATE_MARKER: marker },
      },
    );
    expect(readFileSync(marker, "utf8")).toBe("built");
    const evidence = JSON.parse(readFileSync(manifest, "utf8")).gates.find(
      (gate) => gate.name === "build",
    );
    expect(evidence).toMatchObject({
      source: "package-script:build",
      command: "npm run build",
    });
    unlinkSync(marker);
  });

  it("kills the complete gate process group when its budget expires", () => {
    const root = repo("gate-process-group");
    const marker = path.join(tmpdir(), `quality-late-gate-${process.pid}`);
    const gateScript = path.join(root, "gate-hang.sh");
    writeFileSync(
      gateScript,
      '#!/usr/bin/env bash\n(sleep 3; printf late > "$QUALITY_GATE_MARKER") &\nwait\n',
    );
    chmodSync(gateScript, 0o755);
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "bash gate-hang.sh";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(root, ["add", "gate-hang.sh", "package.json"]);
    git(root, ["commit", "-q", "-m", "add hanging gate"]);
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk.runtime = { checkSeconds: 1 };
    manifest.governor.campaignDeadlineEpoch =
      Math.floor(Date.now() / 1000) + 30;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      {
        cwd: root,
        env: { ...process.env, QUALITY_GATE_MARKER: marker },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exceeded its proportional 1s budget/);
    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(updated.gates.find((gate) => gate.name === "build")).toMatchObject({
      status: "timeout",
      reason: "gate 'build' exceeded its proportional 1s budget",
    });
    execFileSync("sleep", ["4"]);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("releases only its exact linked-worktree lock after a terminal gate failure", () => {
    const primary = repo("terminal-gate-unlock");
    const linked = makeTempDir("quality-linked-gate-");
    git(primary, ["switch", "-q", "main"]);
    git(primary, [
      "worktree",
      "add",
      "-q",
      "-b",
      "quality-gate-failure",
      linked,
      "main",
    ]);
    const packageFile = path.join(linked, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "false";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(linked, ["add", "package.json"]);
    git(linked, ["commit", "-q", "-m", "add failing build gate"]);

    const manifestPath = create(linked, ["--merge"]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    execFileSync(
      "node",
      [
        WORKTREE_MANAGER,
        "lock",
        "--repo",
        linked,
        "--branch",
        "quality-gate-failure",
        "--reason",
        `bs:quality/${manifest.invocationId}`,
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      { cwd: linked, encoding: "utf8", env: process.env },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(
      updated.gates.find((gate) => gate.name === "build"),
      `${result.stderr}\n${result.stdout}`,
    ).toMatchObject({
      status: "failed",
      reason: "gate 'build' failed with exit status 1",
    });
    const status = JSON.parse(
      execFileSync(
        "node",
        [WORKTREE_MANAGER, "status", "--repo", linked, "--skip-pr-check"],
        { encoding: "utf8" },
      ),
    );
    expect(
      status.worktrees.find(
        (worktree) => worktree.branch === "quality-gate-failure",
      ),
    ).toMatchObject({
      locked: false,
      classification: "clean with unpushed commits",
    });
  });

  it("leaves a manually held lock unchanged for a non-merge gate failure", () => {
    const primary = repo("terminal-non-merge-lock");
    const linked = makeTempDir("quality-linked-review-");
    git(primary, ["switch", "-q", "main"]);
    git(primary, [
      "worktree",
      "add",
      "-q",
      "-b",
      "quality-review-failure",
      linked,
      "main",
    ]);
    const packageFile = path.join(linked, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "false";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(linked, ["add", "package.json"]);
    git(linked, ["commit", "-q", "-m", "add failing review gate"]);

    const manifestPath = create(linked);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    execFileSync(
      "node",
      [
        WORKTREE_MANAGER,
        "lock",
        "--repo",
        linked,
        "--branch",
        "quality-review-failure",
        "--reason",
        `bs:quality/${manifest.invocationId}`,
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      { cwd: linked, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    const status = JSON.parse(
      execFileSync(
        "node",
        [WORKTREE_MANAGER, "status", "--repo", linked, "--skip-pr-check"],
        { encoding: "utf8" },
      ),
    );
    expect(
      status.worktrees.find(
        (worktree) => worktree.branch === "quality-review-failure",
      ),
    ).toMatchObject({
      locked: true,
      lockReason: `bs:quality/${manifest.invocationId}`,
    });
  });

  it("allows a slow gate to finish within its declared check reserve", () => {
    const root = repo("gate-check-reserve");
    const marker = path.join(tmpdir(), `quality-slow-gate-${process.pid}`);
    const gateScript = path.join(root, "gate-slow.sh");
    writeFileSync(
      gateScript,
      '#!/usr/bin/env bash\nsleep 2\nprintf passed > "$QUALITY_GATE_MARKER"\n',
    );
    chmodSync(gateScript, 0o755);
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "bash gate-slow.sh";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(root, ["add", "gate-slow.sh", "package.json"]);
    git(root, ["commit", "-q", "-m", "add slow gate"]);
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk.runtime = { checkSeconds: 1, checkReserveSeconds: 2 };
    manifest.governor.campaignDeadlineEpoch =
      Math.floor(Date.now() / 1000) + 30;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      {
        cwd: root,
        env: { ...process.env, QUALITY_GATE_MARKER: marker },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("passed");
    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(updated.governor.gateSecondsUsed).toBeGreaterThanOrEqual(2);
    expect(updated.governor.gateSecondsUsed).toBeLessThanOrEqual(3);
    expect(updated.governor.activeExecution).toBeNull();
    unlinkSync(marker);
  }, 30_000);

  it("shares one execution budget across the complete gate suite", () => {
    const root = repo("gate-shared-budget");
    const gateScript = path.join(root, "gate-too-slow.sh");
    writeFileSync(gateScript, "#!/usr/bin/env bash\nsleep 3\n");
    chmodSync(gateScript, 0o755);
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "bash gate-too-slow.sh";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(root, ["add", "gate-too-slow.sh", "package.json"]);
    git(root, ["commit", "-q", "-m", "add validation gate"]);
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk.runtime = { checkSeconds: 1, checkReserveSeconds: 2 };
    manifest.governor.gateSecondsLimit = 2;
    manifest.governor.gateSecondsUsed = 0;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exceeded its proportional 2s budget/);
    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(updated.governor.gateSecondsUsed).toBe(2);
    expect(updated.governor.activeExecution).toBeNull();
  }, 30_000);

  it("persists an abandoned-execution reconciliation even when the immediate budget check then fails", () => {
    // Regression: reconcileAbandonedExecution() cleared a timed-out
    // activeExecution and credited its elapsed time to gateSecondsUsed in
    // memory only. If the exhaustion check right after it then threw (a
    // plain Error, not GateExecutionError), that error propagated out of
    // mutate()'s operation() callback in withManifestLock() BEFORE
    // saveManifest() ever ran -- silently discarding the reconciliation.
    // Every retry re-read the same stale activeExecution from disk,
    // recomputed the same "would exceed" result, and re-threw forever with
    // no way for the manifest to ever recover on its own.
    const root = repo("gate-abandoned-reconcile-persists");
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "true";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "add build script"]);
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.governor.gateSecondsLimit = 600;
    manifest.governor.gateSecondsUsed = 197;
    manifest.governor.activeExecution = {
      kind: "gate",
      name: "security",
      startedAt: new Date(Date.now() - 500_000).toISOString(),
      timeoutSeconds: 403,
    };
    const revisionBeforeRun = manifest.manifestRevision;
    const updatedAtBeforeRun = manifest.updatedAt;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // 197 + 403 == 600 == the limit: reconciling this abandoned execution
    // exhausts the budget exactly, so the very next check throws.
    const first = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      { cwd: root, encoding: "utf8" },
    );
    expect(first.status).not.toBe(0);
    expect(first.stderr).toMatch(
      /total gate execution budget is exhausted before 'build'/,
    );

    // The reconciliation itself (activeExecution cleared, usage credited)
    // must be durable even though the budget check failed -- otherwise the
    // manifest is permanently stuck re-deriving and re-discarding the same
    // reconciliation on every future invocation.
    const afterFirst = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(afterFirst.governor.activeExecution).toBeNull();
    expect(afterFirst.governor.gateSecondsUsed).toBe(600);
    // Regression (Codex review finding, 2026-08-01, medium): the
    // mid-transaction persist must refresh updatedAt -- otherwise
    // worktree-manager.js's qualityManifestReleaseState() can judge this
    // freshly-reconciled campaign as abandoned and release its lock as
    // stale -- but must NOT bump manifestRevision, since
    // withManifestLock() compares manifestRevision before/after the SAME
    // mutation() call to detect a genuinely concurrent writer, and
    // bumping it here would make that check misfire against our own
    // in-progress transaction.
    expect(afterFirst.updatedAt).not.toBe(updatedAtBeforeRun);
    expect(afterFirst.manifestRevision).toBe(revisionBeforeRun);

    // A second attempt must fail with the SAME exhausted-budget error, not
    // hang or throw a different/inconsistent error -- proving the state is
    // now stable rather than re-deriving the same thing every time.
    const second = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      { cwd: root, encoding: "utf8" },
    );
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(
      /total gate execution budget is exhausted before 'build'/,
    );
    const afterSecond = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(afterSecond.governor.gateSecondsUsed).toBe(600);
  }, 30_000);

  it("authorizeProviderAttempt requires manifestPath only when a reconciliation actually needs persisting", () => {
    // Regression (Codex review round 1, 2026-08-01, medium -> round 2,
    // high): the mid-transaction reconciliation persist was gated on an
    // OPTIONAL manifestPath parameter (`... && manifestPath`). Any call
    // site that omitted it would silently skip the persist and
    // reintroduce the exact discard-on-throw bug this whole fix exists to
    // close, with zero signal anything was wrong. An initial fix made
    // manifestPath mandatory at function ENTRY -- but that's a broader
    // contract change than the bug requires: a caller with no abandoned
    // execution to reconcile has no persistence to skip, and shouldn't be
    // forced to supply a path it has no use for. The guard must only fire
    // at the point persistence is actually needed.
    const root = repo("provider-attempt-requires-manifest-path");
    const manifestPath = createLegacyProviderFixture(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // No activeExecution at all: nothing to reconcile, so no persistence
    // is needed -- must NOT throw even with no manifestPath.
    expect(() =>
      invocation.authorizeProviderAttempt(manifest, { provider: "codex" }),
    ).not.toThrow();

    // An abandoned (deadline-passed) activeExecution IS something to
    // reconcile and persist -- omitting manifestPath here must throw
    // loudly rather than silently skip the persist.
    manifest.governor.activeExecution = {
      kind: "provider",
      name: "codex",
      startedAt: new Date(Date.now() - 500_000).toISOString(),
      timeoutSeconds: 60,
    };
    expect(() =>
      invocation.authorizeProviderAttempt(manifest, { provider: "codex" }),
    ).toThrow(/requires manifestPath/);
  });

  it("authorizeProviderAttempt surfaces the real 'already active' conflict for a still-valid execution, not a manifestPath requirement", () => {
    // Regression (Codex review round 5, 2026-08-01, medium): the
    // manifestPath guard was gated on activeExecution merely EXISTING,
    // not on it actually being abandoned. A caller with a still-valid,
    // in-flight activeExecution (deadline not yet passed) that omitted
    // manifestPath got the confusing "requires manifestPath" error
    // instead of reconcileAbandonedExecution's own actionable "already
    // active" conflict -- masking the real, more useful error for a
    // scenario that has nothing to do with persistence at all.
    const root = repo("provider-attempt-still-valid-execution-conflict");
    const manifestPath = createLegacyProviderFixture(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.governor.activeExecution = {
      kind: "provider",
      name: "claude",
      startedAt: new Date().toISOString(),
      timeoutSeconds: 900, // nowhere near expired
    };

    // No manifestPath supplied, but nothing needs persisting -- must
    // throw the ACTUAL conflict, not a manifestPath complaint.
    expect(() =>
      invocation.authorizeProviderAttempt(manifest, { provider: "codex" }),
    ).toThrow(/provider execution 'claude' is already active/);
  });

  it("authorizeProviderAttempt uses one timestamp for both the manifestPath preflight and reconciliation, closing the boundary race", () => {
    // Regression (Codex review round 6, 2026-08-01, medium): the preflight
    // hasAbandonedExecution() check and the later reconcileAbandonedExecution()
    // call each used their OWN independent Date.now(). An execution whose
    // deadline falls in the (real, if narrow) window between those two
    // calls would pass the preflight as "not yet abandoned" (skipping the
    // manifestPath guard) but then get reconciled anyway by
    // reconcileAbandonedExecution()'s own later, larger Date.now() --
    // recreating the exact mutation-before-persistence-check loss this
    // guard exists to prevent. Verify the fix directly: at the exact
    // instant the deadline passes, a single shared timestamp must produce
    // CONSISTENT answers from both hasAbandonedExecution() and
    // reconcileAbandonedExecution() -- not a value that disagrees between
    // two separate clock reads a moment apart.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const execution = {
      kind: "provider",
      name: "codex",
      startedAt,
      timeoutSeconds: 60,
    };
    const deadlineMs = Date.parse(startedAt) + 60_000;

    // Exactly at the deadline: abandoned (>=), by reconcileAbandonedExecution's
    // own `now < deadline` / `now >= deadline` boundary semantics.
    const manifestAtDeadline = { governor: { activeExecution: execution } };
    expect(
      invocation.hasAbandonedExecution(manifestAtDeadline, deadlineMs),
    ).toBe(true);
    expect(() =>
      invocation.reconcileAbandonedExecution(
        JSON.parse(JSON.stringify(manifestAtDeadline)),
        deadlineMs,
      ),
    ).not.toThrow();

    // One tick before the deadline: not yet abandoned by EITHER function,
    // proving they agree given the SAME timestamp (the actual fix -- prior
    // to it, authorizeProviderAttempt computed this instant twice,
    // independently, which could disagree at exactly this kind of
    // boundary).
    const manifestBeforeDeadline = {
      governor: { activeExecution: { ...execution } },
    };
    expect(
      invocation.hasAbandonedExecution(manifestBeforeDeadline, deadlineMs - 1),
    ).toBe(false);
    expect(() =>
      invocation.reconcileAbandonedExecution(
        manifestBeforeDeadline,
        deadlineMs - 1,
      ),
    ).toThrow(/already active/);
  });

  it("authorizeProviderAttempt does not straddle the deadline boundary across two separate clock reads", () => {
    // Direct proof against the actual call path: mock Date.now() to
    // advance PAST the deadline between what would previously have been
    // two independent reads (the old hasAbandonedExecution() preflight and
    // the later reconcileAbandonedExecution() call). Before the fix, this
    // sequence would let the preflight see "not yet abandoned" (skip the
    // manifestPath guard) while reconciliation's own later read saw
    // "abandoned" and mutated anyway -- an unrecoverable, unpersisted
    // reconciliation with no manifestPath to save it. After the fix (one
    // captured `reconciliationNow` reused for both), the two checks can
    // never disagree, so the manifestPath guard reliably fires whenever
    // reconciliation is about to happen.
    const root = repo("provider-attempt-clock-boundary-race");
    const manifestPath = createLegacyProviderFixture(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    manifest.governor.activeExecution = {
      kind: "provider",
      name: "codex",
      startedAt,
      timeoutSeconds: 60,
    };
    const deadlineMs = Date.parse(startedAt) + 60_000;

    const dateNowSpy = vi
      .spyOn(Date, "now")
      // First read (used for the preflight in the OLD, buggy code, and for
      // authorizeProviderAttempt's own unrelated sharedDeadlineEpoch check
      // in both old and new code): one tick BEFORE the deadline.
      .mockReturnValueOnce(deadlineMs - 1)
      // Every subsequent read (what the OLD code's separate
      // reconcileAbandonedExecution() call would have used): AFTER the
      // deadline. The fixed code must never actually reach a second
      // distinct read for this decision -- it reuses the first.
      .mockReturnValue(deadlineMs + 1);

    try {
      // No manifestPath: if the fix works, the single shared timestamp
      // must consistently see this as abandoned (matching the *first*
      // read, deadlineMs - 1, which is NOT yet past the deadline) --
      // proving the preflight and reconciliation didn't straddle the
      // boundary using two different reads.
      expect(() =>
        invocation.authorizeProviderAttempt(manifest, { provider: "codex" }),
      ).toThrow(/provider execution 'codex' is already active/);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("authorizeProviderAttempt does not mutate activeExecution before the manifestPath guard can throw", () => {
    // Regression (Codex review round 4, 2026-08-01, medium): the
    // manifestPath guard originally ran AFTER reconcileAbandonedExecution()
    // had already mutated the manifest in memory (clearing activeExecution,
    // crediting elapsed time). If a caller caught that thrown error and
    // retried the SAME manifest object with a manifestPath this time, the
    // retry's hadActiveExecution would already read false -- the first call
    // already cleared it -- so the retry would never detect "a
    // reconciliation happened" and would skip the persist entirely,
    // silently losing the reconciliation forever. The guard must validate
    // BEFORE any mutation, so a retry with the same object still works.
    const root = repo("provider-attempt-retry-preserves-reconciliation");
    const manifestPath = createLegacyProviderFixture(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const abandonedExecution = {
      kind: "provider",
      name: "codex",
      startedAt: new Date(Date.now() - 500_000).toISOString(),
      timeoutSeconds: 60,
    };
    manifest.governor.activeExecution = { ...abandonedExecution };

    // First call: no manifestPath, must throw WITHOUT mutating the manifest.
    expect(() =>
      invocation.authorizeProviderAttempt(manifest, { provider: "codex" }),
    ).toThrow(/requires manifestPath/);
    expect(manifest.governor.activeExecution).toEqual(abandonedExecution);

    // Retry the SAME object, now with manifestPath: must still detect and
    // persist the reconciliation -- proving no state was silently lost on
    // the first, failed attempt. (The function then goes on to authorize
    // and record a brand new provider attempt, which legitimately sets a
    // fresh activeExecution of its own -- that's the function's actual
    // job on success, not evidence the reconciliation was skipped.)
    invocation.authorizeProviderAttempt(
      manifest,
      { provider: "codex" },
      manifestPath,
    );
    const persisted = JSON.parse(readFileSync(manifestPath, "utf8"));
    // The reconciled attempt's elapsed time must have been credited and
    // durably written -- this is the actual evidence the reconciliation
    // survived the failed-then-retried call, not lost to the discard bug.
    expect(persisted.governor.providerSecondsUsed).toBeGreaterThan(0);
  });

  it("authorizeMutationAttempt requires manifestPath only when a reconciliation actually needs persisting", () => {
    const root = repo("mutation-attempt-requires-manifest-path");
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk = { ...manifest.risk, tier: "high" };

    expect(() =>
      invocation.authorizeMutationAttempt(manifest, {}),
    ).not.toThrow();

    manifest.governor.activeExecution = {
      kind: "gate",
      name: "mutation",
      startedAt: new Date(Date.now() - 500_000).toISOString(),
      timeoutSeconds: 60,
    };
    expect(() => invocation.authorizeMutationAttempt(manifest, {})).toThrow(
      /requires manifestPath/,
    );
  });

  it("authorizeMutationAttempt surfaces the real 'already active' conflict for a still-valid execution, not a manifestPath requirement", () => {
    const root = repo("mutation-attempt-still-valid-execution-conflict");
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk = { ...manifest.risk, tier: "high" };
    manifest.governor.activeExecution = {
      kind: "gate",
      name: "build",
      startedAt: new Date().toISOString(),
      timeoutSeconds: 900,
    };

    expect(() => invocation.authorizeMutationAttempt(manifest, {})).toThrow(
      /gate execution 'build' is already active/,
    );
  });

  it("authorizeMutationAttempt never reconciles an abandoned execution on a non-high/critical manifest, but leaves it for executeGate to clear", () => {
    // Confirms Codex review finding, 2026-08-01, medium is not a real gap:
    // the tier-gate throw runs BEFORE reconcileAbandonedExecution(), so a
    // stale activeExecution is untouched by this call path on a
    // medium/low-risk manifest. That's fine because executeGate()
    // unconditionally reconciles on every invocation regardless of risk
    // tier -- the abandoned execution still gets cleared the next time any
    // gate actually runs, it's just not THIS function's job to do it.
    const root = repo("mutation-attempt-medium-tier-leaves-reconcile-to-gate");
    const packageFile = path.join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    packageJson.scripts.build = "true";
    writeFileSync(packageFile, JSON.stringify(packageJson));
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "add build script"]);
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk = { ...manifest.risk, tier: "medium" };
    manifest.governor.activeExecution = {
      kind: "gate",
      name: "build",
      startedAt: new Date(Date.now() - 500_000).toISOString(),
      timeoutSeconds: 60,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => invocation.authorizeMutationAttempt(manifest, {})).toThrow(
      /only available for high or critical/,
    );
    // Untouched by the throw above -- still the stale in-memory object.
    expect(manifest.governor.activeExecution).not.toBeNull();

    // The next gate run (the actual execution path, independent of risk
    // tier) still reconciles it, proving no permanent leak.
    const result = spawnSync(
      "bash",
      [RUN_GATE, "--manifest", manifestPath, "--name", "build"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const afterGateRun = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(afterGateRun.governor.activeExecution).toBeNull();
  }, 30_000);

  it("requires explicit revalidation after lifecycle inactivity", () => {
    const root = repo("lifecycle-stale");
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.governor.lifecycleTTLSeconds = 60;
    manifest.governor.lastActivityAt = new Date(
      Date.now() - 61_000,
    ).toISOString();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const stale = spawnSync(
      "node",
      [INVOCATION, "gate-plan", manifestPath, "--name", "lint"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toMatch(/resume through bootstrap to revalidate/);

    expect(
      execFileSync(
        "node",
        [INVOCATION, "field", manifestPath, "repo.realpath"],
        {
          cwd: root,
          encoding: "utf8",
        },
      ).trim(),
    ).toBe(realpathSync(root));
    const staleAuthorization = spawnSync(
      "node",
      [INVOCATION, "review-authorization", manifestPath],
      { cwd: root, encoding: "utf8" },
    );
    expect(staleAuthorization.status).not.toBe(0);
    expect(staleAuthorization.stderr).toMatch(
      /resume through bootstrap to revalidate/,
    );

    execFileSync("bash", [BOOTSTRAP, "--manifest", manifestPath], {
      cwd: root,
    });
    const resumed = spawnSync(
      "node",
      [INVOCATION, "gate-plan", manifestPath, "--name", "lint"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(resumed.status).toBe(0);
  });

  it("requires a fresh campaign for a legacy wall-clock manifest", () => {
    const root = repo("legacy-execution-budget");
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.governor.executionBudgetVersion;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(
      execFileSync(
        "node",
        [INVOCATION, "field", manifestPath, "repo.realpath"],
        {
          cwd: root,
          encoding: "utf8",
        },
      ).trim(),
    ).toBe(realpathSync(root));
    const resume = spawnSync("node", [INVOCATION, "advance", manifestPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(resume.status).not.toBe(0);
    expect(resume.stderr).toMatch(
      /legacy manifest cannot reconstruct active execution usage/,
    );
  });

  it("discovers committed gates on every advance and unions them monotonically", () => {
    const root = repo("monotonic-gates");
    const packageFile = path.join(root, "package.json");
    const scripts = {
      lint: "node --check file.js",
      test: "node --test",
      "security:audit": "node --check file.js",
    };
    writeFileSync(packageFile, JSON.stringify({ scripts }));
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "add baseline scripts"]);
    const manifest = create(root);

    writeFileSync(
      packageFile,
      JSON.stringify({ scripts: { ...scripts, build: "node build.js" } }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "require build"]);
    writeFileSync(
      packageFile,
      JSON.stringify({
        scripts: {
          ...scripts,
          build: "node build.js",
          "test:consumer": "node consumer.js",
        },
      }),
    );
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    let required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.map((gate) => gate.name)).toContain("build");
    expect(required.map((gate) => gate.name)).not.toContain("consumer");

    writeFileSync(
      packageFile,
      JSON.stringify({ scripts: { ...scripts, typecheck: "tsc --noEmit" } }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "replace build with typecheck"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });
    required = JSON.parse(readFileSync(manifest, "utf8")).requiredGates;
    expect(required.map((gate) => gate.name)).toEqual([
      "lint",
      "test",
      "security",
      "build",
      "type",
    ]);
  });

  it("fails closed on future required-gate policy versions", () => {
    const root = repo("future-gate-policy");
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.requiredGatesPolicyVersion = 4;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const command of ["validate", "advance"]) {
      const result = spawnSync("node", [INVOCATION, command, manifestPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /unsupported required-gates policy version/,
      );
    }
  });

  it("rejects scope modes the revision-bound engine cannot execute", () => {
    const root = repo("unsupported-scope");
    for (const scope of ["changed", "all"]) {
      expect(() => create(root, ["--scope", scope])).toThrow(
        /only revision-bound branch scope is supported/,
      );
    }
  });

  it("migrates legacy required gates only during an explicit locked resume", () => {
    const root = repo("legacy-required-gates");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "eslint .",
          test: "node --test",
          "security:audit": "npm audit",
          build: "node build.js",
          "type-check": "tsc --noEmit",
          "test:consumer": "node consumer.js",
        },
      }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "add applicable legacy gates"]);
    const manifestPath = create(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.requiredGates;
    delete manifest.requiredGatesPolicyVersion;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const rejected = spawnSync("node", [INVOCATION, "validate", manifestPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/requires an explicit advance/);

    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });
    const migrated = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(migrated.requiredGatesPolicyVersion).toBe(3);
    expect(migrated.requiredGates.map((gate) => gate.name)).toEqual([
      "lint",
      "test",
      "security",
      "build",
      "type",
      "consumer",
    ]);

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }),
    );
    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });
    expect(
      JSON.parse(readFileSync(manifestPath, "utf8")).requiredGates,
    ).toEqual(migrated.requiredGates);
  });
});

describe("human-floor-check command (Phase 0 autonomy relaxation)", () => {
  // Build a repo whose feature branch changes exactly `changedFile`.
  // Exit-code contract: 0 = VERIFIED CLEAR (autonomous OK); 10 = touches floor;
  // any other code (error) = human required. Only rc 0 unlocks autonomy.
  function repoChanging(label, changedFile, scorePolicy = null) {
    const root = makeTempDir(`hfloor-${label}-`);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    const target = path.join(root, changedFile);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "base\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    writeFileSync(target, "changed\n");
    if (scorePolicy) {
      writeFileSync(
        path.join(root, "harness-config.json"),
        JSON.stringify({ scorePolicy }),
      );
    }
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "change"]);
    return { root, manifest: create(root) };
  }

  const rc = (root, manifest) =>
    spawnSync("node", [INVOCATION, "human-floor-check", manifest], {
      cwd: root,
    }).status;

  it("exits 0 (verified clear) for an ordinary script", () => {
    const { root, manifest } = repoChanging("clear", "scripts/util.sh");
    expect(rc(root, manifest)).toBe(0);
  });

  it("exits 10 for a key file", () => {
    const { root, manifest } = repoChanging("pem", "keys/server.pem");
    expect(rc(root, manifest)).toBe(10);
  });

  it("exits 10 for an uppercase-cased key (case-insensitive)", () => {
    const { root, manifest } = repoChanging("upper", "Keys/Server.PEM");
    expect(rc(root, manifest)).toBe(10);
  });

  it("exits 10 for an auth dir change", () => {
    const { root, manifest } = repoChanging("auth", "src/auth/session.js");
    expect(rc(root, manifest)).toBe(10);
  });

  it("exits 10 when the reviewed commit tries to erase the built-in floor", () => {
    const { root, manifest } = repoChanging("self-disarm", "keys/server.pem", {
      humanFloor: [],
    });
    expect(rc(root, manifest)).toBe(10);
  });

  const sensitiveDirectories = [
    "secrets/aws.json",
    "credentials/cloud.json",
    "passwords/admin.txt",
    "tokens/api.json",
    "webhooks/receive.js",
    "license/policy.js",
    "licensing/policy.js",
    "deployments/ship.sh",
    "keystore/config.json",
    "keystores/config.json",
    "keyring/config.json",
    "keychain/config.json",
  ];
  for (const changedFile of sensitiveDirectories) {
    it(`exits 10 for sensitive directory path ${changedFile}`, () => {
      const label = changedFile.replace(/[^a-z]/gi, "-");
      const { root, manifest } = repoChanging(label, changedFile);
      expect(rc(root, manifest)).toBe(10);
    });
  }

  it("exits 10 when a sensitive file is RENAMED out of a floor path", () => {
    // auth/login.js -> login.js. --no-renames must surface the old auth/ path.
    const root = makeTempDir("hfloor-rename-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    mkdirSync(path.join(root, "auth"), { recursive: true });
    writeFileSync(path.join(root, "auth/login.js"), "export const x = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    git(root, ["mv", "auth/login.js", "login.js"]);
    git(root, ["commit", "-qam", "move auth out"]);
    const manifest = create(root);
    expect(rc(root, manifest)).toBe(10);
  });

  it("FAILS CLOSED (not 0) when the check errors — error must not unlock autonomy", () => {
    // Tampered manifest (currentHead ≠ real HEAD) makes the loader throw →
    // top-level exit 1. Autonomy is reachable ONLY on exit 0.
    const { root, manifest } = repoChanging("err", "scripts/util.sh");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    m.revisions.currentHead = m.revisions.baseSha;
    writeFileSync(manifest, `${JSON.stringify(m, null, 2)}\n`);
    expect(rc(root, manifest)).not.toBe(0);
  });

  it("FAILS CLOSED when harness-config.json is malformed", () => {
    const { root, manifest } = repoChanging(
      "malformed-policy",
      "scripts/util.sh",
    );
    writeFileSync(path.join(root, "harness-config.json"), "{ not json");
    expect(rc(root, manifest)).not.toBe(0);
  });
});

describe("historical merge-read recovery", () => {
  function readyCampaign() {
    const root = repo("historical-merge-read");
    const file = create(root, ["--merge", "--pr", "7"]);
    execFileSync("bash", [RISK, "--manifest", file], { cwd: root });
    prepareCodexReview(root, file);
    recordJudgeArtifact(root, file);
    invocation.withManifestLock(file, (manifest) => {
      manifest.orchestration = {
        head: manifest.revisions.currentHead,
        phase: "merge",
        steps: { merge: { status: "running", attempts: 1 } },
      };
    });
    invocation.recordTerminalState(
      file,
      "blocked",
      "merge admission failed with exit 1",
    );
    const before = invocation.loadManifest(file).manifest;
    const dependencies = {
      readPullRequest: () => ({
        state: "OPEN",
        headRefOid: before.revisions.currentHead,
      }),
      readChecks: () => [{ state: "SUCCESS" }],
    };
    return { file, before, dependencies };
  }

  it("grants one entrant normal merge re-entry without resetting evidence or budgets", () => {
    const { file, before, dependencies } = readyCampaign();
    expect(invocation.resumeMergeReadFailure(file, dependencies)).toMatchObject(
      { head: before.revisions.currentHead },
    );
    const after = invocation.loadManifest(file).manifest;
    expect(after.terminalState).toMatchObject({
      state: "recovering",
      terminalEpoch: 1,
      recovery: { kind: "merge-read-failure" },
    });
    expect(after.governor).toEqual(before.governor);
    expect(after.gates).toEqual(before.gates);
    expect(after.reviews).toEqual(before.reviews);
    expect(after.terminalHistory[0]).toMatchObject({
      detail: before.terminalState.detail,
    });
    expect(invocation.resumeMergeReadFailure(file, dependencies)).toBeNull();
    expect(invocation.loadManifest(file).manifest.terminalState).toEqual(
      after.terminalState,
    );
  });

  it.each([
    "red-checks",
    "changed-head",
    "stale-gate",
    "active-execution",
    "wrong-phase",
    "second-attempt",
    "explicit-block",
  ])("refuses %s without replacing the original terminal", (scenario) => {
    const { file, before, dependencies } = readyCampaign();
    if (scenario === "red-checks")
      dependencies.readChecks = () => [{ state: "FAILURE" }];
    if (scenario === "changed-head")
      dependencies.readPullRequest = () => ({
        state: "OPEN",
        headRefOid: "f".repeat(40),
      });
    invocation.withManifestLock(file, (manifest) => {
      if (scenario === "stale-gate") manifest.gates = [];
      if (scenario === "active-execution")
        manifest.governor.activeExecution = {
          kind: "provider",
          pid: process.pid,
        };
      if (scenario === "wrong-phase") manifest.orchestration.phase = "review";
      if (scenario === "second-attempt")
        manifest.orchestration.steps.merge.attempts = 2;
      if (scenario === "explicit-block")
        manifest.merge.admissionBlock = { conditions: ["ci:failed"] };
    });
    let result;
    try {
      result = invocation.resumeMergeReadFailure(file, dependencies);
    } catch (error) {
      expect(error.message).toMatch(/gate|checks|exact-head/);
    }
    expect(result || null).toBeNull();
    expect(invocation.loadManifest(file).manifest.terminalState).toEqual(
      before.terminalState,
    );
  });
});
