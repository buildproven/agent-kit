const { execFileSync, spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(
  import.meta.dirname,
  "..",
  "bash-pretooluse-dispatcher.js",
);

let repo;

function runRaw(input, { cwd = repo, env = {} } = {}) {
  const result = spawnSync("node", [HOOK], {
    input,
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    code: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function run(command, options) {
  return runRaw(JSON.stringify({ tool_input: { command } }), options);
}

const git = (args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function signalHelper(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "bash-pretooluse-dispatcher-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["remote", "add", "origin", "git@github.com:example/repo.git"]);
  writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(["add", "."]);
  git(["commit", "-m", "seed"]);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("bash-pretooluse-dispatcher.js", () => {
  it.each(["guard", "classifier", "admission"])(
    "terminates descendants of a timed-out %s",
    (stage) => {
      const guardDir = mkdtempSync(path.join(tmpdir(), "guard-descendants-"));
      const pidFile = path.join(guardDir, "helper.pid");
      let helperPid;
      try {
        const staged = path.join(guardDir, "bash-pretooluse-dispatcher.js");
        writeFileSync(staged, readFileSync(HOOK, "utf8"));
        // Model a delayed interpreter startup before the helper is created.
        const hang = `sleep 0.6\nsleep 30 &\nprintf '%s' "$!" > '${pidFile}'\nwait\n`;
        for (const name of [
          "block-destructive-paths.sh",
          "block-push-main.sh",
          "block-commit-main.sh",
          "branch-drift-guard.sh",
        ]) {
          let body = "exit 0\n";
          if (name === "block-push-main.sh") {
            if (stage === "guard") body = hang;
            if (stage === "classifier")
              body = `if [ "$1" = "--ci-budget-classify" ]; then\n${hang}fi\nexit 0\n`;
          }
          writeFileSync(path.join(guardDir, name), `#!/bin/sh\n${body}`);
        }
        writeFileSync(
          path.join(guardDir, "ci-budget-admission.js"),
          stage === "admission"
            ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600); const fs=require('fs'); const child=require('child_process').spawn('sleep',['30'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);\n`
            : "process.exit(0);\n",
        );
        let result;
        // A busy CI worker can reject the test's initial subprocess launch
        // with EPIPE before the staged helper starts. That does prove the
        // dispatcher fails closed, but it cannot prove process-group cleanup.
        // Retry that pre-start infrastructure error only; once a helper exists,
        // the timeout and descendant-death assertions below remain mandatory.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          result = spawnSync(process.execPath, [staged], {
            input: JSON.stringify({
              tool_input: { command: "git push origin topic" },
            }),
            encoding: "utf8",
            env: { ...process.env, BS_GUARD_TIMEOUT_MS: "2000" },
            timeout: 8000,
            killSignal: "SIGKILL",
          });
          helperPid = existsSync(pidFile)
            ? Number(readFileSync(pidFile, "utf8"))
            : undefined;
          if (
            Number.isSafeInteger(helperPid) ||
            !String(result.stderr || "").includes("EPIPE")
          ) {
            break;
          }
        }
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(2);
        if (!Number.isSafeInteger(helperPid) || helperPid <= 1) {
          expect(result.stderr).toContain("EPIPE");
          return;
        }
        expect(result.stderr).toMatch(/did not finish within 2000ms/);
        expect(Number.isSafeInteger(helperPid) && helperPid > 1).toBe(true);
        const deadline = Date.now() + 500;
        let alive = true;
        while (alive && Date.now() < deadline) {
          alive = signalHelper(helperPid, 0);
          if (alive)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        expect(alive).toBe(false);
      } finally {
        if (Number.isSafeInteger(helperPid) && helperPid > 1) {
          signalHelper(helperPid, "SIGKILL");
        }
        rmSync(guardDir, { recursive: true, force: true });
      }
    },
  );

  it("shares one deadline across sequential guards below the configured hook limit", () => {
    const guardDir = mkdtempSync(path.join(tmpdir(), "aggregate-guards-"));
    try {
      const staged = path.join(guardDir, "bash-pretooluse-dispatcher.js");
      writeFileSync(staged, readFileSync(HOOK, "utf8"));
      for (const name of [
        "block-destructive-paths.sh",
        "block-push-main.sh",
        "block-commit-main.sh",
        "branch-drift-guard.sh",
      ]) {
        writeFileSync(path.join(guardDir, name), "#!/bin/sh\nexec sleep 1.5\n");
      }
      const settings = JSON.parse(
        readFileSync(path.join(HOOK, "../../config/settings.json"), "utf8"),
      );
      const outer =
        settings.hooks.PreToolUse.find((matcher) => matcher.matcher === "Bash")
          .hooks[0].timeout * 1000;
      const result = spawnSync(process.execPath, [staged], {
        input: JSON.stringify({
          tool_input: {
            command: "rm temp; git commit -m x; git push origin topic",
          },
        }),
        encoding: "utf8",
        env: { ...process.env, BS_GUARD_TIMEOUT_MS: "5000" },
        timeout: outer,
        killSignal: "SIGKILL",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(
        /block-commit-main.sh did not finish within/,
      );
    } finally {
      rmSync(guardDir, { recursive: true, force: true });
    }
  }, 8000);

  it.each(["classifier", "admission"])(
    "bounds the %s child and denies before the outer timeout",
    (stage) => {
      // A real process launch can take longer than 100ms on a busy CI worker.
      // Keep this behavioral proof below the hook's four-second shared budget,
      // but give the preceding real Bash guards enough time that the asserted
      // child, rather than scheduler noise, determines the outcome.
      const childTimeoutMs = 1000;
      const guardDir = mkdtempSync(path.join(tmpdir(), "bounded-push-"));
      try {
        const staged = path.join(guardDir, "bash-pretooluse-dispatcher.js");
        writeFileSync(staged, readFileSync(HOOK, "utf8"));
        for (const name of [
          "block-push-main.sh",
          "block-destructive-paths.sh",
          "block-commit-main.sh",
          "branch-drift-guard.sh",
        ]) {
          const body =
            name === "block-push-main.sh" && stage === "classifier"
              ? '#!/bin/sh\nif [ "$1" = "--ci-budget-classify" ]; then cat >/dev/null; exec sleep 600; fi\nexit 0\n'
              : "#!/bin/sh\nexit 0\n";
          writeFileSync(path.join(guardDir, name), body);
        }
        writeFileSync(
          path.join(guardDir, "ci-budget-admission.js"),
          stage === "admission"
            ? "setInterval(() => {}, 1000);\n"
            : "process.exit(0);\n",
        );
        let result;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          result = spawnSync(process.execPath, [staged], {
            input: JSON.stringify({
              tool_input: { command: "git push origin topic" },
            }),
            encoding: "utf8",
            env: {
              ...process.env,
              BS_GUARD_TIMEOUT_MS: String(childTimeoutMs),
            },
            timeout: childTimeoutMs + 2000,
            killSignal: "SIGKILL",
          });
          if (!String(result.stderr || "").includes("EPIPE")) break;
        }
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(
          new RegExp(
            `CI budget ${stage} did not finish within ${childTimeoutMs}ms`,
          ),
        );
      } finally {
        rmSync(guardDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "after its deadline",
      "1200",
      /CI budget admission did not finish within 1000ms/,
    ],
    [
      "before its deadline",
      "0",
      /could not execute CI budget admission:.*EPIPE/,
    ],
  ])(
    "classifies an EPIPE %s without weakening the denial",
    (_timing, delayMs, expected) => {
      const childTimeoutMs = 1000;
      const guardDir = mkdtempSync(path.join(tmpdir(), "bounded-epipe-"));
      try {
        const staged = path.join(guardDir, "bash-pretooluse-dispatcher.js");
        const preload = path.join(guardDir, "epipe-after-deadline.cjs");
        writeFileSync(staged, readFileSync(HOOK, "utf8"));
        for (const name of [
          "block-push-main.sh",
          "block-destructive-paths.sh",
          "block-commit-main.sh",
          "branch-drift-guard.sh",
        ]) {
          writeFileSync(path.join(guardDir, name), "#!/bin/sh\nexit 0\n");
        }
        writeFileSync(
          path.join(guardDir, "ci-budget-admission.js"),
          "process.exit(0);\n",
        );
        writeFileSync(
          preload,
          `const child = require("node:child_process");
const realSpawnSync = child.spawnSync;
child.spawnSync = (...args) => {
  const [executable, childArgs] = args;
  const isGuard =
    executable === "bash" &&
    Array.isArray(childArgs) &&
    /\\.sh$/.test(childArgs[0]);
  // This fixture is about the dispatcher's CI-admission child.  Do not let a
  // saturated CI worker turn one of the preceding real Bash launches into an
  // unrelated EPIPE before the fixture reaches that child.
  if (isGuard) {
    const classifier = childArgs.includes("--ci-budget-classify");
    return {
      pid: 999998,
      status: 0,
      stdout: classifier ? "ci\\n" : "",
      stderr: "",
    };
  }
  const isCiBudgetAdmission =
    executable === process.execPath &&
    Array.isArray(childArgs) &&
    /\\/ci-budget-admission\\.js$/.test(childArgs[0]);
  if (!isCiBudgetAdmission) return realSpawnSync(...args);
  const delayMs = Number(process.env.BS_TEST_EPIPE_DELAY_MS || "0");
  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  const error = new Error("spawnSync node EPIPE");
  error.code = "EPIPE";
  return { error, pid: 999999, stdout: "", stderr: "" };
};
`,
        );
        const result = spawnSync(
          process.execPath,
          ["--require", preload, staged],
          {
            input: JSON.stringify({
              tool_input: { command: "git push origin topic" },
            }),
            encoding: "utf8",
            env: {
              ...process.env,
              BS_GUARD_TIMEOUT_MS: String(childTimeoutMs),
              BS_TEST_EPIPE_DELAY_MS: delayMs,
            },
            timeout: childTimeoutMs + 3000,
            killSignal: "SIGKILL",
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(expected);
      } finally {
        rmSync(guardDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "0",
    "-1",
    "not-a-number",
    "5001",
    "1.5",
    "1500ms",
    "Infinity",
    " ",
  ])("denies invalid guard timeout %s with an actionable error", (value) => {
    const result = run("git status", {
      env: { BS_GUARD_TIMEOUT_MS: value },
    });
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/BS_GUARD_TIMEOUT_MS.*integer.*1.*5000/);
    expect(result.output).not.toMatch(/RangeError/);
  });

  it("allows an ordinary command without invoking a guard", () => {
    expect(run("printf ok").code).toBe(0);
  });

  it("fails closed for malformed JSON", () => {
    const result = runRaw("{");
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/invalid JSON/i);
  });

  it("fails closed when command is not a string", () => {
    const result = runRaw(JSON.stringify({ tool_input: { command: 42 } }));
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/not a string/i);
  });

  it("preserves the destructive-path guard", () => {
    const result = run("rm -rf ~/Projects");
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/destructive command/i);
  });

  it("preserves protected-push enforcement", () => {
    const result = run("git push origin main");
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/main/i);
  });

  it("preserves primary-checkout commit enforcement", () => {
    const result = run("git commit -m next");
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/primary checkout|git commit on main/i);
  });

  it("preserves the ordinary git command path", () => {
    expect(
      run("git status", { env: { SESSION_ID: "dispatcher-status" } }).code,
    ).toBe(0);
  });

  it("admits the first topic push but budgets later open-PR pushes", () => {
    git(["checkout", "-q", "-b", "feat/budget"]);
    const fixture = mkdtempSync(path.join(tmpdir(), "dispatcher-budget-"));
    const bin = path.join(fixture, "bin");
    const policy = path.join(fixture, "policy.json");
    const snapshot = path.join(fixture, "snapshot.json");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "gh"),
      '#!/bin/sh\nprintf "%s\\n" "${OPEN_PRS_JSON:-[]}"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      policy,
      JSON.stringify({
        accountType: "organization",
        account: "example",
        includedMinutes: 100,
        softLimitPercent: 75,
        hardLimitPercent: 90,
        cacheHours: 6,
        staleHours: 24,
      }),
    );
    writeFileSync(
      snapshot,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        usedMinutes: 100,
        includedMinutes: 100,
      }),
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      CI_BUDGET_POLICY: policy,
      CI_BUDGET_SNAPSHOT: snapshot,
      SESSION_ID: "dispatcher-budget",
    };

    expect(run("git push -u origin feat/budget", { env }).code).toBe(0);
    const synchronized = run("git push -u origin feat/budget", {
      env: { ...env, OPEN_PRS_JSON: '[{"number":394}]' },
    });
    expect(synchronized.code).toBe(2);
    expect(synchronized.output).toMatch(/minute policy denied/i);
  });

  it("terminates a hung guard and denies rather than proceeding unchecked", () => {
    // A guard that never returns used to block the tool call indefinitely:
    // spawnSync was called with no timeout, and Claude Code's hook `timeout`
    // is SECONDS with a 600 default, so nothing reacted for ten minutes.
    //
    // This is reachable, not theoretical. These guards parse their own argv,
    // and a `shift 2` arm with no remaining value spins its option loop
    // forever (BUI-844). Silence must never read as approval.
    const guardDir = mkdtempSync(path.join(tmpdir(), "hung-guard-"));
    const hung = path.join(guardDir, "block-commit-main.sh");
    writeFileSync(hung, "#!/usr/bin/env bash\nsleep 600\n", { mode: 0o755 });

    const staged = path.join(guardDir, "bash-pretooluse-dispatcher.js");
    writeFileSync(staged, readFileSync(HOOK, "utf8"));
    for (const sibling of [
      "block-push-main.sh",
      "block-destructive-paths.sh",
      "branch-drift-guard.sh",
    ]) {
      writeFileSync(
        path.join(guardDir, sibling),
        "#!/usr/bin/env bash\nexit 0\n",
        { mode: 0o755 },
      );
    }

    const started = Date.now();
    const result = spawnSync("node", [staged], {
      input: JSON.stringify({
        tool_input: { command: "git commit -m x" },
        cwd: repo,
      }),
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, BS_GUARD_TIMEOUT_MS: "1500" },
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /did not finish within 1500ms/i,
    );
    // Bounded well below the 600s the guard would otherwise have slept.
    expect(elapsed).toBeLessThan(10_000);

    rmSync(guardDir, { recursive: true, force: true });
  });
});
