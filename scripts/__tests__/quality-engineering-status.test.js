import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const INVOCATION = path.join(ROOT, "scripts", "quality-invocation.js");
const STATUS = path.join(ROOT, "scripts", "quality-engineering-status.js");
const invocation = createRequire(import.meta.url)(INVOCATION);
const selection = createRequire(import.meta.url)(
  "../quality-agent-selection.js",
);

function prepareReview(root, manifestFile, incomplete = false) {
  invocation.withManifestLock(manifestFile, (manifest) => {
    invocation.setRisk(manifest, {
      tier: incomplete ? "medium" : "low",
      taskType: "docs",
      score: incomplete ? 30 : 5,
      agents: incomplete ? 1 : 0,
      "codex-depth": incomplete ? "medium" : "low",
      "codex-rounds": 1,
    });
    const panel = selection.selectReviewersForRange({
      tier: manifest.risk.tier,
      repo: root,
      base: manifest.revisions.baseSha,
      head: manifest.revisions.currentHead,
    });
    invocation.setAgents(manifest, panel.agents, {
      domain: panel.domain,
      rule: panel.rule,
    });
    for (const required of manifest.requiredGates) {
      const log = path.join(manifest.stateRoot, `${required.name}.log`);
      writeFileSync(log, "fixture gate passed\n");
      invocation.recordGate(manifest, {
        name: required.name,
        command: required.command,
        source: required.source,
        log,
      });
    }
  });
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "quality-run-governor.js"),
      "bump-round",
      manifestFile,
    ],
    { cwd: root },
  );
  const manifest = invocation.loadManifest(manifestFile).manifest;
  const info = invocation.reviewInfo(manifest);
  const identity = invocation.reviewIdentity(manifest);
  mkdirSync(info.artifactDir, { recursive: true });
  const diff = execFileSync("git", ["diff", `${info.from}..${info.to}`], {
    cwd: root,
  });
  const diffSha256 = createHash("sha256").update(diff).digest("hex");
  writeFileSync(path.join(info.artifactDir, "diff.txt"), diff);
  writeFileSync(
    path.join(info.artifactDir, "identity.json"),
    JSON.stringify(identity),
  );
  writeFileSync(
    path.join(info.artifactDir, "review-focus.txt"),
    "fixture review focus\n",
  );
  const provider = incomplete ? "review-incomplete" : "policy-exempt";
  writeFileSync(
    path.join(info.artifactDir, `${provider}.findings.txt`),
    incomplete
      ? "AI REVIEW INCOMPLETE: provider unavailable.\n"
      : "AI REVIEW NOT REQUIRED. Exact diff is covered by low-risk zero-reviewer policy.\n",
  );
  const result = incomplete
    ? { status: "incomplete", failureCategory: "provider-unavailable" }
    : {
        schemaVersion: 1,
        aiReviewRequired: false,
        head: identity.headSha,
        tier: identity.tier,
        reviewContractVersion: identity.reviewContractVersion,
        reviewPolicyDigest: identity.reviewPolicyDigest,
        agentsSha256: identity.agentsSha256,
        domain: identity.panelDomain,
        selectionRule: identity.panelRule,
        diffSha256,
      };
  writeFileSync(
    path.join(info.artifactDir, `${provider}.result.json`),
    JSON.stringify(result),
  );
  invocation.writeArtifactInventory(manifest, info.artifactDir, provider, {
    exempt: !incomplete,
    incomplete,
  });
  execFileSync(
    process.execPath,
    [
      INVOCATION,
      incomplete ? "record-incomplete-review" : "record-policy-exempt-review",
      manifestFile,
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
      diffSha256,
      ...(incomplete
        ? [
            "--failed-provider",
            "claude",
            "--failure-category",
            "provider-unavailable",
          ]
        : []),
    ],
    { cwd: root },
  );
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function campaign() {
  const root = realpathSync(makeTempDir("engineering-status-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Quality Test"]);
  git(root, ["config", "user.email", "quality@example.com"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "true", lint: "true", "security:audit": "true" },
    }),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  git(root, ["remote", "add", "origin", root]);
  git(root, ["fetch", "-q", "origin", "main"]);
  git(root, ["switch", "-qc", "feature"]);
  writeFileSync(path.join(root, "README.md"), "changed\n");
  git(root, ["commit", "-qam", "change"]);
  const manifest = execFileSync(
    process.execPath,
    [
      INVOCATION,
      "create",
      "--repo",
      root,
      "--base-ref",
      "origin/main",
      "--level",
      "auto",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  return { root, manifest };
}

function status(manifest, args = [], env = process.env) {
  return spawnSync(
    process.execPath,
    [STATUS, "--manifest", manifest, ...args],
    { encoding: "utf8", env },
  );
}

describe("engineering status public CLI", () => {
  it("reports exact identity and missing gate/review/CI evidence without any manifest or budget mutation", () => {
    const { root, manifest } = campaign();
    const before = readFileSync(manifest, "utf8");
    const result = status(manifest);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      interface: "engineering-status",
      schemaVersion: 1,
      readOnly: true,
      repository: { root },
      revisions: {
        head: git(root, ["rev-parse", "HEAD"]),
        base: git(root, ["rev-parse", "origin/main"]),
      },
      workingTreeClean: true,
      engineering: {
        status: "not-ready",
        gateAndReviewEvidence: { status: "unverified" },
        ci: { status: "unknown" },
      },
      admission: { status: "unknown" },
      mergeAuthorized: false,
    });
    expect(report.recordedGates).toContainEqual({
      name: "test",
      recordedStatus: "missing",
    });
    expect(readFileSync(manifest, "utf8")).toBe(before);
  });

  it("never promotes a verified-unmerged terminal label to verified evidence", () => {
    const { manifest } = campaign();
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    data.terminalState = {
      state: "verified-unmerged",
      head: data.revisions.currentHead,
    };
    data.merge = {
      admissionBlock: {
        head: data.revisions.currentHead,
        conditions: ["ci:failed"],
      },
    };
    writeFileSync(manifest, JSON.stringify(data));
    const before = readFileSync(manifest, "utf8");
    const report = JSON.parse(status(manifest).stdout);
    expect(report).toMatchObject({
      recordedTerminal: { state: "verified-unmerged" },
      engineering: { status: "not-ready", ci: { status: "unknown" } },
      admission: {
        status: "unknown",
        recordedBlock: { conditions: ["ci:failed"] },
      },
    });
    expect(readFileSync(manifest, "utf8")).toBe(before);
  });

  it.each([false, true])(
    "rejects a changed HEAD, including an empty stamp descendant (%s)",
    (empty) => {
      const { root, manifest } = campaign();
      if (!empty) writeFileSync(path.join(root, "README.md"), "next\n");
      git(root, ["commit", "--allow-empty", "-qam", "next"]);
      const result = status(manifest);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /exact manifest HEAD|revision identity mismatch/,
      );
    },
  );

  it("reports dirty and untracked work as not ready", () => {
    const { root, manifest } = campaign();
    writeFileSync(path.join(root, "untracked.js"), "new behavior\n");
    expect(JSON.parse(status(manifest).stdout)).toMatchObject({
      workingTreeClean: false,
      engineering: { status: "not-ready" },
    });
  });

  it("reports missing GitHub identity as unknown when live CI is requested", () => {
    const { manifest } = campaign();
    expect(
      JSON.parse(status(manifest, ["--ci"]).stdout).engineering.ci,
    ).toEqual({
      status: "unknown",
      reason: "manifest has no GitHub repository identity",
    });
  });

  it.each([
    ["success", "missing"],
    ["failure", "missing"],
    ["pending", "missing"],
    ["success", "complete"],
    ["success", "stale"],
    ["success", "incomplete"],
  ])(
    "checks exact-head CI %s with %s review evidence without dispatch or merge",
    (conclusion, evidence) => {
      const { root, manifest } = campaign();
      const data = JSON.parse(readFileSync(manifest, "utf8"));
      data.repo.githubRepository = "owner/repo";
      writeFileSync(manifest, JSON.stringify(data));
      if (evidence !== "missing")
        prepareReview(root, manifest, evidence === "incomplete");
      if (evidence === "stale") {
        const stale = JSON.parse(readFileSync(manifest, "utf8"));
        stale.governor.lastActivityAt = "2000-01-01T00:00:00Z";
        writeFileSync(manifest, JSON.stringify(stale));
      }
      const before = readFileSync(manifest, "utf8");
      const bin = makeTempDir("engineering-gh-");
      const log = path.join(bin, "calls.jsonl");
      const run = {
        id: 1,
        name: "quality",
        app: { id: 15368 },
        head_sha: data.revisions.currentHead,
        status: conclusion === "pending" ? "in_progress" : "completed",
        conclusion,
        started_at: "2026-09-09T00:00:00Z",
        completed_at: "2026-09-09T00:01:00Z",
      };
      writeFileSync(
        path.join(bin, "gh"),
        `#!${process.execPath}\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nconst route = args.find(arg => arg.startsWith('repos/')) || '';\nif (route.endsWith('/protection/required_status_checks')) process.stdout.write(JSON.stringify({contexts:['quality'], checks:[{context:'quality', app_id:15368}]}));\nelse if (route.includes('/rules/branches/main')) process.stdout.write('[]');\nelse if (route.includes('/commits/${data.revisions.currentHead}/check-runs')) process.stdout.write(JSON.stringify({check_runs:[${JSON.stringify(run)}]}));\nelse { process.stderr.write('unexpected operation: '+args.join(' ')); process.exitCode=1; }\n`,
        { mode: 0o755 },
      );
      const result = status(manifest, ["--ci"], {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
      });
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.engineering.ci.status).toBe(
        conclusion === "success" ? "verified" : "unverified",
      );
      expect(report.engineering.status).toBe(
        evidence === "complete" ? "ready" : "not-ready",
      );
      if (["complete", "stale"].includes(evidence)) {
        expect(report.engineering.gateAndReviewEvidence.status).toBe(
          "verified",
        );
      }
      if (evidence === "stale") expect(report.lifecycleStale).toBe(true);
      if (evidence === "incomplete")
        expect(report.engineering.gateAndReviewEvidence.status).not.toBe(
          "verified",
        );
      expect(report.mergeAuthorized).toBe(false);
      expect(readFileSync(manifest, "utf8")).toBe(before);
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain(
        `/commits/${data.revisions.currentHead}/check-runs`,
      );
      expect(calls).not.toMatch(/dispatch|merge|POST|PATCH/);
    },
  );

  it("rejects a foreign origin and a symlink manifest", () => {
    const { root, manifest } = campaign();
    const link = path.join(makeTempDir("engineering-link-"), "manifest.json");
    symlinkSync(manifest, link);
    expect(status(link).stderr).toContain("must not be a symlink");
    git(root, [
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/foreign.git",
    ]);
    expect(status(manifest).status).toBe(1);
  });

  it("requires an exact manifest and rejects action flags", () => {
    const result = spawnSync(process.execPath, [STATUS], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--manifest <exact-path>");
    const { manifest } = campaign();
    expect(status(manifest, ["--merge"]).status).toBe(1);
  });
});
