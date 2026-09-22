const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const { recoveryInvocation } = require("../harness-certification-recover.js");

function git(directory, args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function receipt(directory, state = "RUNNING") {
  return {
    schemaVersion: 1,
    kind: "frozen-harness-certification",
    state,
    owner: {
      pid: 999999,
      started: "Thu Jan  1 00:00:00 1970",
      command: "dead",
    },
    baseline: { directory: ROOT, sha: git(ROOT, ["rev-parse", "HEAD"]) },
    executor: {
      kind: "docker-container",
      image: `example.test/harness@sha256:${"a".repeat(64)}`,
    },
    candidate: {
      directory,
      sha: "a".repeat(40),
      baseSha: "b".repeat(40),
      profile: "agent-kit",
      claim: "engineering",
      githubRepository: "buildproven/agent-kit",
      pullRequest: 624,
    },
    gates: [],
  };
}

describe("harness-certification-recover", () => {
  it("restarts only from the recorded immutable baseline and identity", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-recover-"),
    );
    try {
      const candidate = path.join(directory, "candidate");
      fs.mkdirSync(candidate);
      const prior = path.join(directory, "prior.json");
      const out = path.join(directory, "new.json");
      fs.writeFileSync(prior, JSON.stringify(receipt(candidate)));
      const invocation = recoveryInvocation(prior, out);
      expect(invocation.runner).toBe(
        path.join(ROOT, "scripts", "harness-certify.js"),
      );
      expect(invocation.args).toContain("--candidate-head");
      expect(invocation.args).toContain("a".repeat(40));
      expect(invocation.args).toContain("--pr");
      expect(invocation.args).toContain("624");
      expect(invocation.args).toContain("--container-image");
      expect(invocation.args).toContain(
        `example.test/harness@sha256:${"a".repeat(64)}`,
      );
      expect(() =>
        recoveryInvocation(prior, path.join(candidate, "new.json")),
      ).toThrow("outside the baseline and candidate checkouts");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a live or completed prior certification", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-recover-"),
    );
    try {
      const prior = path.join(directory, "prior.json");
      fs.writeFileSync(prior, JSON.stringify(receipt(directory, "passed")));
      expect(() =>
        recoveryInvocation(prior, path.join(directory, "new.json")),
      ).toThrow("not safely recoverable");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a baseline outside the executing checkout", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-recover-"),
    );
    try {
      const prior = path.join(directory, "prior.json");
      const value = receipt(directory);
      value.baseline.directory = directory;
      fs.writeFileSync(prior, JSON.stringify(value));
      expect(() =>
        recoveryInvocation(prior, path.join(directory, "new.json")),
      ).toThrow("does not match the executing checkout");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses recovery when the pinned container identity is absent", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-recover-"),
    );
    try {
      const prior = path.join(directory, "prior.json");
      const value = receipt(directory);
      delete value.executor;
      fs.writeFileSync(prior, JSON.stringify(value));
      expect(() =>
        recoveryInvocation(prior, path.join(directory, "new.json")),
      ).toThrow("complete certification identity");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
