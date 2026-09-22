const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CERTIFY = path.join(ROOT, "scripts", "harness-certify.js");
const {
  assertNoTrackedNodeModules,
  directoryDigest,
  frozenCommand,
  githubRepository,
  isolatedGitEnvironment,
  receiptPath,
  runGate,
  seatbeltProfile,
  selectedTestGates,
  writeReceipt,
} = require(CERTIFY);

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
    expect(() =>
      frozenCommand(ROOT, ["node_modules/.bin/../../../../usr/bin/curl"]),
    ).toThrow("does not permit executable");
  });

  it.each(["node_modules", "Node_modules"])(
    "rejects a candidate that tracks its own %s toolchain",
    (toolchainDirectory) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      try {
        const candidate = path.join(root, "candidate");
        initRepository(candidate);
        const tracked = path.join(
          candidate,
          toolchainDirectory,
          ".bin",
          "probe",
        );
        fs.mkdirSync(path.dirname(tracked), { recursive: true });
        fs.writeFileSync(tracked, "candidate tool\n");
        git(candidate, ["add", `${toolchainDirectory}/.bin/probe`]);
        git(candidate, ["commit", "-qm", "track candidate tool"]);
        expect(() =>
          assertNoTrackedNodeModules(
            candidate,
            git(candidate, ["rev-parse", "HEAD"]),
          ),
        ).toThrow("refuses candidate-controlled toolchains");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("binds the frozen toolchain digest to the executed file contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const executable = path.join(root, "node_modules", ".bin", "probe");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "baseline tool\n");
      const baseline = directoryDigest(root);
      fs.writeFileSync(executable, "changed tool\n");
      expect(directoryDigest(root)).not.toBe(baseline);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes operator Git configuration before candidate checkout", () => {
    const environment = isolatedGitEnvironment({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.evil.process",
      GIT_CONFIG_VALUE_0: "host-command",
      SAFE_VALUE: "safe",
    });
    expect(environment).toMatchObject({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(Object.keys(environment)).not.toContain("GIT_CONFIG_COUNT");
    expect(environment).toMatchObject({ SAFE_VALUE: "safe" });
  });

  it("derives only a canonical GitHub repository identity from origin", () => {
    expect(githubRepository("git@github.com:buildproven/agent-kit.git")).toBe(
      "buildproven/agent-kit",
    );
    expect(
      githubRepository("https://github.com/buildproven/agent-kit.git"),
    ).toBe("buildproven/agent-kit");
    expect(githubRepository("https://example.test/agent-kit.git")).toBeNull();
  });

  it("rejects a candidate-controlled or pre-existing receipt path", () => {
    const root = fs.mkdtempSync("/Users/Shared/harness-certify-");
    try {
      const candidate = path.join(root, "candidate");
      fs.mkdirSync(candidate);
      expect(() =>
        receiptPath(candidate, path.join(candidate, "receipt.json")),
      ).toThrow("outside the candidate checkout");
      const out = path.join(root, "receipt.json");
      fs.writeFileSync(out, "prior evidence\n");
      expect(() => receiptPath(candidate, out)).toThrow("already exists");
      const link = path.join(root, "receipt-link.json");
      fs.symlinkSync(path.join(root, "missing.json"), link);
      expect(() => receiptPath(candidate, link)).toThrow("already exists");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the initial receipt exclusively", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const out = path.join(root, "receipt.json");
      writeReceipt(out, { state: "RUNNING" }, { create: true });
      expect(() =>
        writeReceipt(out, { state: "RUNNING" }, { create: true }),
      ).toThrow();
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

  it("runs a frozen executable whose interpreter is the pinned Node runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const executable = path.join(root, "node_modules", ".bin", "node-proof");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const result = await runGate(root, root, "node-proof", [
        "node_modules/.bin/node-proof",
      ]);
      expect(result).toMatchObject({ name: "node-proof", status: "success" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies a candidate gate access to a host sentinel", async () => {
    const root = fs.mkdtempSync("/Users/Shared/harness-certify-");
    const homeHost = fs.mkdtempSync(
      path.join(os.homedir(), "harness-certify-host-"),
    );
    const temporaryHost = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-certify-host-"),
    );
    try {
      const baseline = path.join(root, "baseline");
      const candidate = path.join(root, "candidate");
      const scratch = path.join(root, "scratch");
      const homeSentinel = path.join(homeHost, "host-secret");
      const temporarySentinel = path.join(temporaryHost, "host-secret");
      fs.mkdirSync(path.join(baseline, "node_modules", ".bin"), {
        recursive: true,
      });
      fs.mkdirSync(candidate);
      fs.mkdirSync(scratch);
      fs.writeFileSync(homeSentinel, "secret\n");
      fs.writeFileSync(temporarySentinel, "secret\n");
      const executable = path.join(baseline, "node_modules", ".bin", "probe");
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.readFileSync(${JSON.stringify(homeSentinel)});\nfs.readFileSync(${JSON.stringify(temporarySentinel)});\n`,
        { mode: 0o755 },
      );
      const candidateExecutable = path.join(
        candidate,
        "node_modules",
        ".bin",
        "probe",
      );
      fs.mkdirSync(path.dirname(candidateExecutable), { recursive: true });
      fs.copyFileSync(executable, candidateExecutable);
      fs.chmodSync(candidateExecutable, 0o755);
      const profile = path.join(root, "seatbelt.sb");
      fs.writeFileSync(
        profile,
        seatbeltProfile({
          baselineDir: baseline,
          candidateDir: candidate,
          scratchDir: scratch,
          toolchainDir: baseline,
        }),
      );
      const result = await runGate(
        baseline,
        candidate,
        "probe",
        ["node_modules/.bin/probe"],
        {
          sandboxProfile: profile,
          sandboxHome: scratch,
          toolDir: candidate,
          captureOutput: true,
        },
      );
      expect(result.status).toBe("failed");
      fs.writeFileSync(
        candidateExecutable,
        "#!/usr/bin/env node\nprocess.exit(0);\n",
        {
          mode: 0o755,
        },
      );
      const safe = await runGate(
        baseline,
        candidate,
        "safe",
        ["node_modules/.bin/probe"],
        {
          sandboxProfile: profile,
          sandboxHome: scratch,
          toolDir: candidate,
          captureOutput: true,
        },
      );
      expect(safe.status, JSON.stringify(safe)).toBe("success");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(homeHost, { recursive: true, force: true });
      fs.rmSync(temporaryHost, { recursive: true, force: true });
    }
  });
});
