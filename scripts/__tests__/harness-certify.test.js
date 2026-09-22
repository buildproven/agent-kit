const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CERTIFY = path.join(ROOT, "scripts", "harness-certify.js");
const { frozenCommand, receiptPath, runGate, selectedTestGates } = require(
  CERTIFY,
);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepository(directory) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "test@example.test"]);
  git(directory, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(directory, "README"), "fixture\n");
  git(directory, ["add", "README"]);
  git(directory, ["commit", "-qm", "fixture"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

describe("harness-certify", () => {
  it("resolves executable paths from the frozen baseline, never candidate node_modules", () => {
    expect(frozenCommand(ROOT, ["node_modules/.bin/eslint", "."])).toEqual([
      path.join(ROOT, "node_modules/.bin/eslint"),
      ".",
    ]);
    expect(() => frozenCommand(ROOT, ["sh", "candidate-command"])).toThrow(
      "does not permit executable",
    );
  });

  it("rejects a candidate-controlled or pre-existing receipt path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const candidate = path.join(root, "candidate");
      fs.mkdirSync(candidate);
      expect(() =>
        receiptPath(candidate, path.join(candidate, "receipt.json")),
      ).toThrow("outside the candidate checkout");
      const out = path.join(root, "receipt.json");
      fs.writeFileSync(out, "prior evidence\n");
      expect(() => receiptPath(candidate, out)).toThrow("already exists");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a claim that could imply product acceptance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const candidate = path.join(root, "candidate");
      const candidateHead = initRepository(candidate);
      const result = spawnSync(
        "node",
        [
          CERTIFY,
          "--baseline-sha",
          git(ROOT, ["rev-parse", "HEAD"]),
          "--candidate-dir",
          candidate,
          "--candidate-head",
          candidateHead,
          "--base-sha",
          candidateHead,
          "--profile",
          "agent-kit",
          "--claim",
          "contract",
          "--github-repo",
          "buildproven/agent-kit",
          "--pr",
          "1",
          "--out",
          path.join(root, "receipt.json"),
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("requires --claim engineering");
      expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a baseline identity that does not match its executing checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const candidate = path.join(root, "candidate");
      const candidateHead = initRepository(candidate);
      const result = spawnSync(
        "node",
        [
          CERTIFY,
          "--baseline-sha",
          "0000000000000000000000000000000000000000",
          "--candidate-dir",
          candidate,
          "--candidate-head",
          candidateHead,
          "--base-sha",
          candidateHead,
          "--profile",
          "agent-kit",
          "--claim",
          "engineering",
          "--github-repo",
          "buildproven/agent-kit",
          "--pr",
          "1",
          "--out",
          path.join(root, "receipt.json"),
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("baseline HEAD");
      expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects tests from the frozen baseline policy, not candidate commands", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const candidate = path.join(root, "candidate");
      const base = initRepository(candidate);
      const target = path.join(candidate, "scripts", "harness-certify.js");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "module.exports = {};\n");
      git(candidate, ["add", "scripts/harness-certify.js"]);
      git(candidate, ["commit", "-qm", "candidate change"]);
      const plan = selectedTestGates(
        ROOT,
        candidate,
        base,
        git(candidate, ["rev-parse", "HEAD"]),
      );
      expect(plan).toMatchObject({ mode: "focused" });
      expect(plan.gates[0][0]).toBe("test-1");
      expect(plan.gates[0][1].slice(0, 3)).toEqual([
        "npx",
        "vitest",
        "related",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates a timed-out fixed gate and reports the timeout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const executable = path.join(root, "node_modules", ".bin", "hang");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "#!/bin/sh\nsleep 60 &\nwait\n", {
        mode: 0o755,
      });
      const result = await runGate(
        root,
        root,
        "bounded",
        ["node_modules/.bin/hang"],
        { timeoutMs: 40, killGraceMs: 10 },
      );
      expect(result).toMatchObject({
        name: "bounded",
        status: "failed",
        timedOut: true,
      });
      expect(result.signal).toBeTruthy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
