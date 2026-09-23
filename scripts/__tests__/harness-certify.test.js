const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CERTIFY = path.join(ROOT, "scripts", "harness-certify.js");
const HAS_IMMUTABLE_GATE_SANDBOX =
  process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const {
  frozenCommand,
  npmInstallEnvironment,
  assertNoLocalDependencySources,
  assertNpmInstallInputs,
  assertCleanCheckout,
  checkoutSnapshot,
  sealSnapshot,
  snapshotSandboxProfile,
  unsealSnapshot,
  githubRepository,
  receiptPath,
  runGate,
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
  it("rejects local dependency sources before snapshot installation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      fs.writeFileSync(
        path.join(root, "npm-shrinkwrap.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/x": { resolved: "file:/private/secret" },
          },
        }),
      );
      expect(() => assertNoLocalDependencySources(root)).toThrow(
        "local dependency source",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects candidate npm configuration before snapshot installation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
      fs.writeFileSync(
        path.join(root, ".npmrc"),
        "registry=https://example.test\n",
      );
      expect(() => assertNpmInstallInputs(root)).toThrow(
        "candidate-controlled .npmrc",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins snapshot dependency installation writes to harness-owned scratch", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      const environment = npmInstallEnvironment(scratch);
      expect(environment).toMatchObject({
        HOME: scratch,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        npm_config_cache: scratch,
        npm_config_logs_dir: scratch,
        npm_config_prefix: scratch,
        npm_config_userconfig: "/dev/null",
        npm_config_globalconfig: "/dev/null",
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_registry: "https://registry.npmjs.org",
      });
      expect(environment.NPM_TOKEN).toBeUndefined();
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

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

  it("derives only a canonical GitHub repository identity from origin", () => {
    expect(githubRepository("git@github.com:buildproven/agent-kit.git")).toBe(
      "buildproven/agent-kit",
    );
    expect(
      githubRepository("https://github.com/buildproven/agent-kit.git"),
    ).toBe("buildproven/agent-kit");
    expect(githubRepository("https://example.test/agent-kit.git")).toBeNull();
  });

  it("refuses a dirty source checkout before certification", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    try {
      initRepository(root);
      fs.writeFileSync(path.join(root, "README"), "changed\n");
      expect(() => assertCleanCheckout(root, "candidate")).toThrow(
        "candidate checkout is dirty",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs from a detached snapshot that does not observe later source edits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
    const snapshots = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-certify-"),
    );
    try {
      const head = initRepository(root);
      const snapshot = checkoutSnapshot(root, head, "candidate", snapshots);
      fs.writeFileSync(path.join(root, "README"), "changed after snapshot\n");
      expect(fs.readFileSync(path.join(snapshot, "README"), "utf8")).toBe(
        "fixture\n",
      );
      expect(git(snapshot, ["rev-parse", "HEAD"])).toBe(head);
      const executable = path.join(snapshot, "executable");
      fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
      sealSnapshot(snapshot);
      expect(fs.statSync(path.join(snapshot, "README")).mode & 0o222).toBe(0);
      expect(fs.statSync(executable).mode & 0o111).toBe(0o111);
      unsealSnapshot(snapshot);
      execFileSync("git", ["worktree", "remove", "--force", snapshot], {
        cwd: root,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(snapshots, { recursive: true, force: true });
    }
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

  it.skipIf(!HAS_IMMUTABLE_GATE_SANDBOX)(
    "terminates a timed-out fixed gate and reports the timeout",
    async () => {
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
    },
  );

  it.skipIf(!HAS_IMMUTABLE_GATE_SANDBOX)(
    "denies candidate gate writes to the immutable snapshots",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      try {
        const executable = path.join(root, "node_modules", ".bin", "mutate");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, "#!/bin/sh\nprintf changed > marker\n", {
          mode: 0o755,
        });
        const scratch = path.join(root, "scratch");
        fs.mkdirSync(scratch);
        expect(snapshotSandboxProfile(root, root, scratch)).toContain(
          "(deny default)",
        );
        expect(snapshotSandboxProfile(root, root, scratch)).not.toContain(
          "network-outbound",
        );
        const result = await runGate(root, root, "mutation", [
          "node_modules/.bin/mutate",
        ]);
        expect(result.status).toBe("failed");
        expect(fs.existsSync(path.join(root, "marker"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!HAS_IMMUTABLE_GATE_SANDBOX)(
    "denies a gate read of a host-only sentinel",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      const host = fs.mkdtempSync(
        path.join(os.homedir(), "harness-certify-sentinel-"),
      );
      try {
        const sentinel = path.join(host, "secret");
        const executable = path.join(root, "node_modules", ".bin", "read-host");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(sentinel, "secret\n", { mode: 0o600 });
        fs.writeFileSync(
          executable,
          `#!/bin/sh\nif cat '${sentinel}' >/dev/null 2>&1; then exit 1; fi\n`,
          { mode: 0o755 },
        );
        const result = await runGate(root, root, "read-host", [
          "node_modules/.bin/read-host",
        ]);
        expect(result.status).toBe("success");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(host, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!HAS_IMMUTABLE_GATE_SANDBOX)(
    "denies a gate write to the original checkout and receipt directory",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      try {
        const baseline = path.join(root, "baseline");
        const candidate = path.join(root, "candidate");
        const original = path.join(root, "original");
        const receipts = path.join(root, "receipts");
        const executable = path.join(
          baseline,
          "node_modules",
          ".bin",
          "escape",
        );
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.mkdirSync(candidate);
        fs.mkdirSync(original);
        fs.mkdirSync(receipts);
        fs.writeFileSync(
          executable,
          `#!/bin/sh\nprintf original > '${path.join(original, "marker")}'\nprintf receipt > '${path.join(receipts, "receipt.json")}'\n`,
          { mode: 0o755 },
        );
        const result = await runGate(baseline, candidate, "escape", [
          "node_modules/.bin/escape",
        ]);
        expect(result.status).toBe("failed");
        expect(fs.existsSync(path.join(original, "marker"))).toBe(false);
        expect(fs.existsSync(path.join(receipts, "receipt.json"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!HAS_IMMUTABLE_GATE_SANDBOX)(
    "permits a gate write only in its private scratch directory",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      try {
        const executable = path.join(root, "node_modules", ".bin", "scratch");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(
          executable,
          '#!/bin/sh\nprintf ok > "$TMPDIR/marker"\n',
          {
            mode: 0o755,
          },
        );
        const result = await runGate(root, root, "scratch", [
          "node_modules/.bin/scratch",
        ]);
        expect(result.status).toBe("success");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!HAS_IMMUTABLE_GATE_SANDBOX)(
    "runs a frozen executable whose interpreter is the pinned Node runtime",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      try {
        const executable = path.join(
          root,
          "node_modules",
          ".bin",
          "node-proof",
        );
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(
          executable,
          "#!/usr/bin/env node\nprocess.exit(0);\n",
          {
            mode: 0o755,
          },
        );
        const result = await runGate(root, root, "node-proof", [
          "node_modules/.bin/node-proof",
        ]);
        expect(result).toMatchObject({ name: "node-proof", status: "success" });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(HAS_IMMUTABLE_GATE_SANDBOX)(
    "fails closed when immutable gate isolation is unavailable",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-certify-"));
      try {
        const executable = path.join(root, "node_modules", ".bin", "safe");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        expect(() =>
          runGate(root, root, "unsupported", ["node_modules/.bin/safe"]),
        ).toThrow("requires macOS sandbox-exec");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
