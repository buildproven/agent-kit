const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CERTIFY = path.join(ROOT, "scripts", "harness-certify.js");
const {
  assertNoTrackedNodeModules,
  containerCommand,
  createGateVolume,
  directoryDigest,
  destroyGateDirectory,
  frozenCommand,
  gateResourceLimits,
  githubRepository,
  isolatedGitEnvironment,
  mountedVolume,
  receiptPath,
  resourceLimitedInvocation,
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
  const macosOnly = process.platform === "darwin" ? it : it.skip;
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

  it("maps only frozen executables into the container toolchain", () => {
    expect(
      containerCommand("/trusted", ["node_modules/.bin/eslint", "."]),
    ).toEqual(["/toolchain/node_modules/.bin/eslint", "."]);
    expect(
      containerCommand("/trusted", ["npx", "vitest", "run", "x.test.js"]),
    ).toEqual(["/toolchain/node_modules/.bin/vitest", "run", "x.test.js"]);
    expect(() => containerCommand("/trusted", ["sh", "-c", "id"])).toThrow(
      "does not permit",
    );
  });

  it.each(["node_modules", "Node_modules", "node_moduleſ"])(
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
      GIT_CONFIG_PARAMETERS: "filter.evil.process=host-command",
      SAFE_VALUE: "safe",
    });
    expect(environment).toMatchObject({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(Object.keys(environment)).not.toContain("GIT_CONFIG_COUNT");
    expect(Object.keys(environment)).not.toContain("GIT_CONFIG_PARAMETERS");
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

  macosOnly(
    "rejects a candidate-controlled or pre-existing receipt path",
    () => {
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
    },
  );

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
      expect(plan.gates[0][1]).toEqual([
        "npx",
        "vitest",
        "run",
        "scripts/__tests__/harness-container-executor.test.js",
        "scripts/__tests__/harness-certify.test.js",
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

  it("uses a fixed trusted launcher for recorded resource limits", () => {
    const limits = {
      cpuSeconds: 3,
      maxOpenFiles: 12,
      maxFileBlocks: 34,
      maxProcesses: 56,
    };
    expect(
      resourceLimitedInvocation("/trusted/tool", ["--check"], limits),
    ).toEqual([
      "/bin/sh",
      "-c",
      'ulimit -t "$1" -n "$2" -f "$3" -u "$4"; shift 4; exec "$@"',
      "harness-certify-resource-limits",
      "3",
      "12",
      "34",
      "56",
      "/trusted/tool",
      "--check",
    ]);
    expect(gateResourceLimits()).toMatchObject({
      cpuSeconds: 300,
      maxOpenFiles: 256,
      maxFileBlocks: 524288,
      volumeSize: "512m",
    });
  });

  macosOnly(
    "enforces an aggregate disk ceiling in a disposable candidate volume",
    () => {
      const root = fs.mkdtempSync("/Users/Shared/harness-certify-volume-");
      let gate;
      try {
        const volume = createGateVolume(root, { size: "16m" });
        gate = { root, volume };
        expect(() =>
          fs.writeFileSync(
            path.join(volume.mount, "beyond-cap"),
            Buffer.alloc(17 * 1024 * 1024),
          ),
        ).toThrow();
      } finally {
        if (gate) destroyGateDirectory(gate);
        else fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed trusted volume metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const metadata = path.join(root, "attach.plist");
      fs.writeFileSync(metadata, "not a property list\n");
      expect(() => mountedVolume(metadata)).toThrow(
        "could not parse bounded candidate volume metadata",
      );
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

  macosOnly("denies a candidate gate access to a host sentinel", async () => {
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

  macosOnly(
    "denies a candidate process the ability to escape its recorded process group",
    async () => {
      const root = fs.mkdtempSync("/Users/Shared/harness-certify-");
      try {
        const baseline = path.join(root, "baseline");
        const candidate = path.join(root, "candidate");
        const scratch = path.join(root, "scratch");
        fs.mkdirSync(path.join(baseline, "node_modules", ".bin"), {
          recursive: true,
        });
        fs.mkdirSync(candidate);
        fs.mkdirSync(scratch);
        const source = path.join(root, "escape.c");
        const escape = path.join(candidate, "escape");
        fs.writeFileSync(
          source,
          "#include <unistd.h>\nint main(){ return (setsid() == -1 && setpgid(0, 0) == -1) ? 0 : 1; }\n",
        );
        execFileSync("/usr/bin/cc", [source, "-o", escape]);
        const executable = path.join(baseline, "node_modules", ".bin", "probe");
        fs.writeFileSync(
          executable,
          `#!/usr/bin/env node\nconst result = require('node:child_process').spawnSync(${JSON.stringify(escape)}); process.exit(result.status ?? 1);\n`,
          { mode: 0o755 },
        );
        const profile = path.join(root, "seatbelt.sb");
        fs.writeFileSync(
          profile,
          seatbeltProfile({
            candidateDir: candidate,
            scratchDir: scratch,
            toolchainDir: baseline,
          }),
        );
        const result = await runGate(
          baseline,
          candidate,
          "escape",
          ["node_modules/.bin/probe"],
          {
            sandboxProfile: profile,
            sandboxHome: scratch,
            toolDir: baseline,
            captureOutput: true,
          },
        );
        expect(result).toMatchObject({ status: "success" });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  macosOnly(
    "prevents a candidate from relaxing inherited resource limits",
    async () => {
      const root = fs.mkdtempSync("/Users/Shared/harness-certify-");
      try {
        const baseline = path.join(root, "baseline");
        const candidate = path.join(root, "candidate");
        const scratch = path.join(root, "scratch");
        fs.mkdirSync(path.join(baseline, "node_modules", ".bin"), {
          recursive: true,
        });
        fs.mkdirSync(candidate);
        fs.mkdirSync(scratch);
        const source = path.join(root, "raise-limit.c");
        const probe = path.join(candidate, "raise-limit");
        fs.writeFileSync(
          source,
          "#include <sys/resource.h>\nint main(){ struct rlimit limit; if (getrlimit(RLIMIT_NOFILE, &limit)) return 2; if (limit.rlim_cur > 256) return 3; limit.rlim_cur = limit.rlim_max; return setrlimit(RLIMIT_NOFILE, &limit) == -1 ? 0 : 4; }\n",
        );
        execFileSync("/usr/bin/cc", [source, "-o", probe]);
        const executable = path.join(baseline, "node_modules", ".bin", "probe");
        fs.writeFileSync(
          executable,
          `#!/usr/bin/env node\nconst result = require('node:child_process').spawnSync(${JSON.stringify(probe)}); process.exit(result.status ?? 1);\n`,
          { mode: 0o755 },
        );
        const profile = path.join(root, "seatbelt.sb");
        fs.writeFileSync(
          profile,
          seatbeltProfile({
            candidateDir: candidate,
            scratchDir: scratch,
            toolchainDir: baseline,
          }),
        );
        const result = await runGate(
          baseline,
          candidate,
          "resource-limits",
          ["node_modules/.bin/probe"],
          {
            sandboxProfile: profile,
            sandboxHome: scratch,
            toolDir: baseline,
            resourceLimits: {
              cpuSeconds: 300,
              maxOpenFiles: 256,
              maxFileBlocks: 524288,
              maxProcesses: gateResourceLimits().maxProcesses,
            },
            captureOutput: true,
          },
        );
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "success",
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
