const { execFileSync, spawnSync } = require("node:child_process");
const { readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./helpers/tmp.js");
const {
  buildDiagnosis,
  terminalStatus,
  worktreeLockStatus,
} = require("../quality-terminal-status");

const ROOT = path.resolve(__dirname, "..", "..");
const WRAPPER = path.join(ROOT, "scripts", "quality-wrapper.js");
const BOOTSTRAP = path.join(ROOT, "scripts", "quality-bootstrap.sh");
const INVOCATION = path.join(ROOT, "scripts", "quality-invocation.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

describe("quality terminal diagnosis", () => {
  it("distinguishes recoverable interruption state", () => {
    const manifest = {
      revisions: { currentHead: "abc" },
      governor: { activeExecution: null },
      terminalState: { state: "interrupted", head: "abc" },
    };

    expect(terminalStatus(manifest)).toBe(
      "interrupted — exact resume will continue unfinished phases",
    );

    manifest.governor.activeExecution = { token: "active" };
    expect(terminalStatus(manifest)).toBe(
      "interrupted — recovery waits for active execution reconciliation",
    );
  });

  it("skips an unrelated prunable worktree while resolving the target lock", () => {
    const primary = repo("terminal-status-prunable");
    const stale = makeTempDir("quality-a-stale-");
    const target = makeTempDir("quality-z-target-");
    git(primary, ["switch", "-q", "main"]);
    git(primary, ["worktree", "add", "-q", "-b", "stale", stale, "main"]);
    git(primary, ["worktree", "add", "-q", "-b", "target", target, "main"]);
    rmSync(stale, { recursive: true, force: true });

    expect(worktreeLockStatus({ repo: { realpath: target } })).toBe("released");
  });

  it("separates gates, provider exhaustion, approval, CI, and exact recovery", () => {
    const manifest = {
      requiredGates: [{ name: "lint" }, { name: "security" }],
      gates: [
        { name: "lint", head: "abc", status: "success" },
        { name: "security", head: "old", status: "success" },
      ],
      revisions: { currentHead: "abc" },
      reviews: [],
      risk: { tier: "critical", mergeAuthority: "human-required" },
      approval: { approved: false },
    };
    const output = buildDiagnosis("/tmp/exact/invocation.json", manifest, {
      category: "provider-exhaustion",
      provider: "claude",
      resetAt: "2026-07-20T03:00:00.000Z",
    });

    expect(output).toContain(
      "Repository gates: lint=success, security=pending",
    );
    expect(output).toContain(
      "Provider review/checkpoint: blocked — claude exhaustion; reset 2026-07-20T03:00:00.000Z",
    );
    expect(output).toContain("Break-glass: required and missing or stale");
    expect(output).toContain("GitHub CI: not checked by this failure path");
    expect(output).toContain(
      "Retry/resume: /bs:quality --manifest /tmp/exact/invocation.json",
    );
  });

  it("reports autonomous authority at critical tier without asking for break-glass", () => {
    const output = buildDiagnosis(
      "/tmp/exact/invocation.json",
      {
        requiredGates: [],
        gates: [],
        revisions: { currentHead: "abc" },
        reviews: [],
        risk: { tier: "critical", mergeAuthority: "autonomous" },
      },
      {},
    );
    expect(output).toContain(
      "Break-glass: not required (autonomous merge authority)",
    );
  });

  it("does not claim approval is required for a non-critical manual campaign", () => {
    const output = buildDiagnosis(
      "/tmp/exact/invocation.json",
      {
        requiredGates: [],
        gates: [],
        revisions: { currentHead: "abc" },
        reviews: [],
        risk: { tier: "high", mergeAuthority: "human-required" },
      },
      {},
    );
    expect(output).toContain(
      "Break-glass: not required unless the manual security floor applies",
    );
  });

  it("does not collapse malformed review output into provider exhaustion", () => {
    const output = buildDiagnosis(
      "/tmp/exact/invocation.json",
      {
        requiredGates: [],
        gates: [],
        revisions: { currentHead: "abc" },
        reviews: [],
        risk: { tier: "medium" },
      },
      { category: "parser-inconclusive", provider: "codex" },
    );
    expect(output).toContain("codex review output was inconclusive");
    expect(output).not.toContain("exhaustion");
  });

  it("labels billing failures independently", () => {
    const output = buildDiagnosis(
      "/tmp/exact/invocation.json",
      {
        requiredGates: [],
        gates: [],
        revisions: { currentHead: "abc" },
        reviews: [],
        risk: { tier: "medium" },
      },
      { category: "provider-billing", provider: "codex" },
    );
    expect(output).toContain("codex billing or credits failure");
    expect(output).not.toContain("exhaustion");
  });

  it("labels code findings independently from CI and provider failures", () => {
    const output = buildDiagnosis(
      "/tmp/exact/invocation.json",
      {
        requiredGates: [],
        gates: [],
        revisions: { currentHead: "abc" },
        reviews: [{ status: "success" }],
        risk: { tier: "medium" },
      },
      { category: "code-findings" },
    );
    expect(output).toContain("actionable code findings remain");
    expect(output).toContain("GitHub CI: not checked by this failure path");
  });

  // Regression test: breakGlassStatus() must call invocation.approvalValid()
  // with BOTH manifest and root (manifest.repo.realpath). approvalValid()'s
  // rebase-tolerant carry check (BUI-380) needs a real repo root to compute
  // patch-ids against live git state — silently omitting it doesn't throw,
  // it just makes a rebase-carried approval look invalid (fails closed, but
  // wrongly). This must be a real, validly-signed approval against a real
  // repo, not a hand-built fixture, or the missing-root bug is invisible.
  it("reports a genuinely valid break-glass approval as approved (needs manifest.repo.realpath wired through)", () => {
    const root = repo("terminal-status-approval");
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
    const manifestPath = wrapped.stdout
      .split("\n")
      .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
      ?.slice("BS_QUALITY_MANIFEST=".length);
    execFileSync("bash", [
      path.join(ROOT, "scripts", "quality-risk-resolve.sh"),
      "--manifest",
      manifestPath,
    ]);
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifestPath], {
        cwd: root,
      }).status,
    ).toBe(0);

    // A rebase-only HEAD change invalidates a human approval. Provider review
    // carry is separately proven by exact binary replay; a human capability
    // remains bound to the exact commit the human approved.
    git(root, ["switch", "-q", "main"]);
    writeFileSync(path.join(root, "unrelated.js"), "export const u = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "unrelated main change"]);
    git(root, ["push", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["rebase", "-q", "origin/main"]);
    execFileSync("node", [INVOCATION, "advance", manifestPath], { cwd: root });
    expect(
      spawnSync("node", [INVOCATION, "approval-valid", manifestPath], {
        cwd: root,
      }).status,
    ).not.toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.risk.tier = "critical";
    // Legacy signed approval is relevant only for an explicit manual policy.
    manifest.risk.mergeAuthority = "human-required";
    const output = buildDiagnosis(manifestPath, manifest, {});
    expect(output).toMatch(
      new RegExp("Break-glass: required and missing or stale"),
    );
    expect(output).toContain("Worktree lock: not tracked");
  });
});
