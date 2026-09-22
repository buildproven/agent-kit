#!/usr/bin/env node
"use strict";

// Certifies a harness candidate from an already-merged agent-kit checkout.
// It deliberately does not import candidate JavaScript, package scripts, or
// quality runtime code. Candidate code is only the subject of fixed native
// commands defined below.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");

const PROFILES = Object.freeze({
  "agent-kit": [
    ["format", ["node_modules/.bin/prettier", "--check", "."]],
    ["lint", ["node_modules/.bin/eslint", "."]],
    ["security", ["npm", "audit", "--audit-level", "high"]],
  ],
});

function fail(message) {
  throw new Error(`harness-certify: ${message}`);
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument '${token}'`);
    const key = token.slice(2);
    if (!key || options[key] !== undefined) fail(`invalid argument '${token}'`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${token} requires a value`);
    options[key] = value;
  }
  for (const key of [
    "baseline-sha",
    "candidate-dir",
    "candidate-head",
    "base-sha",
    "profile",
    "claim",
    "github-repo",
    "pr",
    "out",
  ]) {
    if (!options[key]) fail(`--${key} is required`);
  }
  if (!PROFILES[options.profile]) fail(`unknown profile '${options.profile}'`);
  if (options.claim !== "engineering") {
    fail("harness certification requires --claim engineering");
  }
  return options;
}

function git(cwd, args) {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.pager=cat",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.fsmonitorHookPath=",
      "-c",
      "core.attributesfile=/dev/null",
      "-c",
      "diff.external=",
      "--no-optional-locks",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: isolatedGitEnvironment(),
    },
  ).trim();
}

function assertSafeLocalGitConfig(directory) {
  const marker = path.join(directory, ".git");
  const stat = fs.lstatSync(marker);
  const gitDir = stat.isDirectory()
    ? marker
    : path.resolve(
        directory,
        fs
          .readFileSync(marker, "utf8")
          .trim()
          .replace(/^gitdir:\s*/i, ""),
      );
  const commonDirMarker = path.join(gitDir, "commondir");
  const configDir = fs.existsSync(commonDirMarker)
    ? path.resolve(gitDir, fs.readFileSync(commonDirMarker, "utf8").trim())
    : gitDir;
  const config = path.join(configDir, "config");
  if (!fs.existsSync(config)) return;
  const text = fs.readFileSync(config, "utf8");
  if (
    /^\s*\[\s*(?:include|includeif|filter\b)/im.test(text) ||
    /^\s*(?:fsmonitor|fsmonitorhookpath|hookspath|attributesfile|external)\s*=/im.test(
      text,
    )
  ) {
    fail(
      "candidate local Git config contains an executable or included configuration",
    );
  }
}

function isolatedGitEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertCleanCheckout(directory, role) {
  const status = git(directory, ["status", "--porcelain=v1"]);
  if (status) fail(`${role} checkout is dirty`);
}

function frozenInputsDigest(baselineDir) {
  const inputs = [
    "scripts/harness-certify.js",
    "scripts/test-impact.js",
    ".buildproven/test-impact.json",
    "package-lock.json",
  ];
  const digest = crypto.createHash("sha256");
  for (const input of inputs) {
    const file = path.join(baselineDir, input);
    digest.update(input).update("\0");
    digest.update(fs.existsSync(file) ? fs.readFileSync(file) : "<absent>");
    digest.update("\0");
  }
  return digest.digest("hex");
}

function directoryDigest(directory) {
  const digest = crypto.createHash("sha256");
  const visit = (current, relative = "") => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      const stat = fs.lstatSync(child);
      digest.update(childRelative).update("\0");
      if (stat.isDirectory()) {
        digest.update("directory\0");
        visit(child, childRelative);
      } else if (stat.isSymbolicLink()) {
        digest.update("symlink\0").update(fs.readlinkSync(child)).update("\0");
      } else if (stat.isFile()) {
        digest.update("file\0").update(fs.readFileSync(child)).update("\0");
      } else {
        fail(`frozen toolchain has unsupported entry '${childRelative}'`);
      }
    }
  };
  visit(directory);
  return digest.digest("hex");
}

function createFrozenToolchain(baselineDir) {
  const root = fs.mkdtempSync("/Users/Shared/harness-certify-toolchain-");
  const modules = path.join(root, "node_modules");
  const copied = spawnSync(
    "/bin/cp",
    ["-cR", path.join(baselineDir, "node_modules"), modules],
    { encoding: "utf8" },
  );
  if (copied.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    fail(`could not snapshot frozen baseline toolchain: ${copied.stderr}`);
  }
  return { root, modules, sha256: directoryDigest(modules) };
}

function quoteSeatbelt(value) {
  return JSON.stringify(value);
}

function assertNoTrackedNodeModules(candidateDir, candidateHead) {
  const tracked = git(candidateDir, [
    "ls-tree",
    "-r",
    "--name-only",
    candidateHead,
  ]);
  const hasToolchain = tracked.split("\n").some((entry) => {
    return entry
      .split("/")
      .some(
        (component) =>
          component.normalize("NFC").toLocaleLowerCase("en-US") ===
          "node_modules",
      );
  });
  if (hasToolchain) {
    fail(
      "candidate tracks node_modules; frozen certification refuses candidate-controlled toolchains",
    );
  }
}

function isolatedGateDirectory(candidateDir, candidateHead, toolchain) {
  const root = fs.mkdtempSync("/Users/Shared/harness-certify-gate-");
  try {
    const checkout = path.join(root, "candidate");
    const checkoutSha = (directory, sha) =>
      spawnSync(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", sha],
        {
          cwd: directory,
          encoding: "utf8",
          env: isolatedGitEnvironment(),
        },
      );
    const result = spawnSync(
      "/usr/bin/git",
      ["clone", "--no-local", "--no-checkout", candidateDir, checkout],
      { encoding: "utf8", env: isolatedGitEnvironment() },
    );
    if (result.status !== 0)
      fail(`could not create isolated gate checkout: ${result.stderr}`);
    const checkoutResult = checkoutSha(checkout, candidateHead);
    if (checkoutResult.status !== 0)
      fail(`could not checkout isolated gate SHA: ${checkoutResult.stderr}`);
    assertNoTrackedNodeModules(checkout, candidateHead);
    const scratch = path.join(root, "scratch");
    fs.mkdirSync(scratch, { mode: 0o700 });
    const profile = path.join(root, "seatbelt.sb");
    fs.writeFileSync(
      profile,
      `${seatbeltProfile({ candidateDir: checkout, scratchDir: scratch, toolchainDir: toolchain.root })}\n`,
      { mode: 0o600 },
    );
    return { root, checkout, scratch, profile };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function seatbeltProfile({ candidateDir, scratchDir, toolchainDir }) {
  const nodeExecutable = fs.realpathSync(process.execPath);
  const npmCli = path.resolve(
    path.dirname(nodeExecutable),
    "../lib/node_modules/npm/bin/npm-cli.js",
  );
  const npmRuntime = path.dirname(path.dirname(npmCli));
  const candidate = fs.realpathSync(candidateDir);
  const scratch = fs.realpathSync(scratchDir);
  const toolchain = fs.realpathSync(toolchainDir);
  // sandbox-exec runs in deny-by-default mode. A broad allow plus a list of
  // protected locations is not isolation: an unlisted host path remains open.
  // Permit only macOS runtime paths and the pinned Node runtime. Candidate and
  // scratch are the only writable directories.
  const runtimeReadOnly = [
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library/Apple",
    "/etc",
    "/private/etc",
  ]
    .map(
      (directory) => `(allow file-read* (subpath ${quoteSeatbelt(directory)}))`,
    )
    .join("\n");
  const metadataAncestors = [
    candidate,
    scratch,
    toolchain,
    nodeExecutable,
    npmRuntime,
  ]
    .map(
      (directory) =>
        `(allow file-read-metadata file-test-existence (path-ancestors ${quoteSeatbelt(directory)}))`,
    )
    .join("\n");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow mach-lookup)",
    "(allow mach-register)",
    "(allow syscall*)",
    // A gate is controlled as one detached process group. A candidate must
    // not be able to create another process group or session, or it could
    // survive the bounded gate and escape the recorded lifecycle boundary.
    // Darwin syscall numbers are stable ABI values: kill(2)=37, setpgid(2)=82,
    // and setsid(2)=147. Seatbelt uses last-match rule precedence, so this must
    // follow the broad runtime compatibility allowance above.
    "(deny syscall-unix (syscall-number 37 82 147))",
    "(allow ipc-posix-shm*)",
    "(allow iokit-open)",
    "(allow file-fsctl)",
    "(allow file-ioctl)",
    "(allow system-socket)",
    "(allow user-preference*)",
    "(allow sysctl*)",
    "(allow distributed-notification-post)",
    runtimeReadOnly,
    `(allow file-read* (literal ${quoteSeatbelt(nodeExecutable)}))`,
    `(allow file-read* (subpath ${quoteSeatbelt(npmRuntime)}))`,
    `(allow file-read* (subpath ${quoteSeatbelt(toolchain)}))`,
    '(allow file-read* (literal "/private/etc/localtime"))',
    '(allow file-read* (literal "/private/var/db/timezone"))',
    '(allow file-read* (literal "/private/var/db/DarwinDirectory/local/recordStore.data"))',
    metadataAncestors,
    '(allow file-read* file-test-existence (literal "/") (literal "/tmp") (literal "/var") (literal "/etc"))',
    `(allow file-read* file-write* (subpath ${quoteSeatbelt(candidate)}))`,
    `(allow file-read* file-write* (subpath ${quoteSeatbelt(scratch)}))`,
    "(deny network*)",
  ].join("\n");
}

function writeReceipt(out, receipt, { create = false } = {}) {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (create) {
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, serialized, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${out}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, serialized, { mode: 0o600 });
  fs.renameSync(temporary, out);
}

function isWithin(directory, target) {
  const relative = path.relative(directory, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function receiptPath(candidateDir, suppliedPath) {
  const supplied = path.resolve(suppliedPath);
  const parent = fs.realpathSync(path.dirname(supplied));
  const out = path.join(parent, path.basename(supplied));
  if (isWithin(fs.realpathSync(candidateDir), parent)) {
    fail("--out must be outside the candidate checkout");
  }
  try {
    fs.lstatSync(out);
    fail("--out already exists; preserve prior certification evidence");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return out;
}

function assertFrozenRunner(baselineDir) {
  const committed = execFileSync(
    "/usr/bin/git",
    ["show", "HEAD:scripts/harness-certify.js"],
    { cwd: baselineDir, encoding: "utf8" },
  );
  if (fs.readFileSync(__filename, "utf8") !== committed) {
    fail("frozen certification runner differs from baseline HEAD");
  }
}

function processIdentity(pid) {
  const line = execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8" },
  ).trim();
  const match = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
  if (!match) fail(`could not record process identity for PID ${pid}`);
  return { pid, started: match[1], command: match[2] };
}

function githubRepository(remote) {
  const match = remote.match(
    /(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  return match ? match[1] : null;
}

function frozenCommand(baselineDir, command) {
  const [file, ...args] = command;
  if (/^node_modules\/\.bin\/[A-Za-z0-9_-]+$/.test(file)) {
    const executable = path.resolve(baselineDir, file);
    const allowedDirectory = path.join(baselineDir, "node_modules", ".bin");
    if (!isWithin(allowedDirectory, executable)) {
      fail(`frozen command escapes baseline executable directory '${file}'`);
    }
    return [executable, ...args];
  }
  if (file === "npx" && ["vitest", "jest"].includes(args[0])) {
    return [
      path.join(baselineDir, "node_modules", ".bin", args[0]),
      ...args.slice(1),
    ];
  }
  if (
    file === "npm" &&
    JSON.stringify(args) === JSON.stringify(["audit", "--audit-level", "high"])
  ) {
    const npmCli = path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );
    if (!fs.existsSync(npmCli)) {
      fail("frozen Node runtime does not provide npm-cli.js");
    }
    return [process.execPath, npmCli, ...args];
  }
  fail(`frozen policy does not permit executable '${file}'`);
}

function runGate(
  baselineDir,
  candidateDir,
  name,
  command,
  {
    sandboxProfile,
    sandboxHome,
    toolDir = baselineDir,
    captureOutput = false,
    onStart,
    ...timing
  } = {},
) {
  const { timeoutMs = 15 * 60 * 1000, killGraceMs = 5_000 } = timing;
  const frozenToolDir = fs.realpathSync(toolDir);
  const [file, ...args] = frozenCommand(frozenToolDir, command);
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const invocation = sandboxProfile
      ? ["/usr/bin/sandbox-exec", "-f", sandboxProfile, file, ...args]
      : [file, ...args];
    const child = spawn(invocation[0], invocation.slice(1), {
      cwd: candidateDir,
      detached: true,
      env: {
        PATH: `${path.join(frozenToolDir, "node_modules", ".bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        NODE_PATH: path.join(frozenToolDir, "node_modules"),
        HOME: sandboxHome || os.homedir(),
        TMPDIR: sandboxHome || os.tmpdir(),
        XDG_CACHE_HOME: sandboxHome || os.tmpdir(),
        XDG_CONFIG_HOME: sandboxHome || os.tmpdir(),
        npm_config_ignore_scripts: "true",
        npm_config_registry: "https://registry.npmjs.org",
        npm_config_userconfig: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid && onStart) onStart(child.pid);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const signalTree = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already exited */
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      setTimeout(() => signalTree("SIGKILL"), killGraceMs).unref();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.on("error", (error) => {
      output += error.message;
      finish({
        name,
        command: [file, ...args],
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        timedOut,
        outputSha256: sha256(output),
        status: "failed",
        ...(captureOutput ? { diagnostic: output } : {}),
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        name,
        command: [file, ...args],
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal,
        timedOut,
        outputSha256: sha256(output),
        status: exitCode === 0 && !signal && !timedOut ? "success" : "failed",
        ...(captureOutput ? { diagnostic: output } : {}),
      });
    });
  });
}

async function stopGateGroup(processGroup, killGraceMs = 5_000) {
  if (!Number.isInteger(processGroup)) return;
  try {
    process.kill(-processGroup, 0);
  } catch {
    return;
  }
  process.kill(-processGroup, "SIGTERM");
  const deadline = Date.now() + killGraceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      process.kill(-processGroup, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(-processGroup, "SIGKILL");
  } catch {
    return;
  }
}

function frozenTestPlan(baselineDir, selectorFiles) {
  const selector = path.join(baselineDir, "scripts", "test-impact.js");
  const result = spawnSync(
    "node",
    [selector, "--policy-root", baselineDir, "--", ...selectorFiles],
    { cwd: baselineDir, encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    fail(`frozen test selector failed: ${result.stderr || result.stdout}`);
  }
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    fail("frozen test selector returned invalid JSON");
  }
  if (!plan || !["focused", "none", "audit", "unmapped"].includes(plan.mode)) {
    fail("frozen test selector returned an invalid mode");
  }
  if (plan.mode === "unmapped") {
    fail(
      `candidate coverage is unmapped: ${plan.reason || "no reason provided"}`,
    );
  }
  const commands = Array.isArray(plan.commands) ? plan.commands : [];
  if (
    !commands.every(
      (command) =>
        typeof command?.executable === "string" &&
        Array.isArray(command.args) &&
        command.args.every((argument) => typeof argument === "string"),
    )
  ) {
    fail("frozen test selector returned an invalid command");
  }
  if (plan.mode === "audit" && commands.length === 0) {
    fail("frozen test selector returned an empty audit plan");
  }
  return { mode: plan.mode, reason: plan.reason || null, commands };
}

function selectedTestGates(baselineDir, candidateDir, baseSha, candidateHead) {
  const files = git(candidateDir, [
    "diff",
    "--name-only",
    `${baseSha}..${candidateHead}`,
  ])
    .split("\n")
    .filter(Boolean);
  if (files.length === 0) {
    return { mode: "none", reason: "empty-diff", files, gates: [] };
  }
  const plan = frozenTestPlan(baselineDir, files);
  return {
    mode: plan.mode,
    reason: plan.reason || null,
    files,
    gates: [
      ...plan.commands.map((command, index) => [
        `test-${index + 1}`,
        [command.executable, ...command.args],
      ]),
    ],
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const baselineDir = fs.realpathSync(process.cwd());
  const candidateDir = fs.realpathSync(options["candidate-dir"]);
  assertSafeLocalGitConfig(candidateDir);
  const baselineHead = git(baselineDir, ["rev-parse", "HEAD"]);
  if (baselineHead !== options["baseline-sha"]) {
    fail(
      `baseline HEAD ${baselineHead} does not equal declared ${options["baseline-sha"]}`,
    );
  }
  assertCleanCheckout(baselineDir, "baseline");
  assertFrozenRunner(baselineDir);
  const baselineInputs = frozenInputsDigest(baselineDir);
  const candidateHead = git(candidateDir, ["rev-parse", "HEAD"]);
  if (candidateHead !== options["candidate-head"]) {
    fail(
      `candidate HEAD ${candidateHead} does not equal declared ${options["candidate-head"]}`,
    );
  }
  assertCleanCheckout(candidateDir, "candidate");
  const candidateRepository = githubRepository(
    git(candidateDir, ["remote", "get-url", "origin"]),
  );
  if (candidateRepository !== options["github-repo"]) {
    fail("declared GitHub repository does not match candidate origin");
  }
  let pull;
  try {
    pull = JSON.parse(
      execFileSync(
        "gh",
        [
          "pr",
          "view",
          options.pr,
          "--repo",
          options["github-repo"],
          "--json",
          "state,headRefOid,baseRefOid",
        ],
        { cwd: baselineDir, encoding: "utf8", timeout: 30_000 },
      ),
    );
  } catch {
    fail("could not read the authoritative GitHub pull request identity");
  }
  if (
    pull.state !== "OPEN" ||
    pull.headRefOid !== candidateHead ||
    pull.baseRefOid !== options["base-sha"]
  ) {
    fail(
      "GitHub pull request identity does not match the declared candidate base/head",
    );
  }
  try {
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.pager=cat",
        "merge-base",
        "--is-ancestor",
        options["base-sha"],
        candidateHead,
      ],
      {
        cwd: candidateDir,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "ignore",
      },
    );
  } catch {
    fail(
      `base ${options["base-sha"]} is not an ancestor of candidate ${candidateHead}`,
    );
  }

  const testPlan = selectedTestGates(
    baselineDir,
    candidateDir,
    options["base-sha"],
    candidateHead,
  );
  const out = receiptPath(candidateDir, options.out);
  const toolchain = createFrozenToolchain(baselineDir);
  const receipt = {
    schemaVersion: 1,
    kind: "frozen-harness-certification",
    recordedAt: new Date().toISOString(),
    baseline: {
      directory: baselineDir,
      sha: baselineHead,
      inputsSha256: baselineInputs,
      toolchainSha256: toolchain.sha256,
    },
    candidate: {
      directory: candidateDir,
      sha: candidateHead,
      baseSha: options["base-sha"],
      profile: options.profile,
      claim: options.claim,
      githubRepository: options["github-repo"],
      pullRequest: Number(options.pr),
    },
    testPlan: {
      mode: testPlan.mode,
      reason: testPlan.reason,
      files: testPlan.files,
    },
    owner: processIdentity(process.pid),
    state: "RUNNING",
    gates: [],
  };
  try {
    writeReceipt(out, receipt, { create: true });
    for (const [name, command] of [
      ...PROFILES[options.profile],
      ...testPlan.gates,
    ]) {
      const gate = isolatedGateDirectory(
        candidateDir,
        candidateHead,
        toolchain,
      );
      const recordedGate = {
        name,
        state: "RUNNING",
        processGroup: null,
        process: null,
      };
      receipt.gates.push(recordedGate);
      writeReceipt(out, receipt);
      try {
        Object.assign(
          recordedGate,
          await runGate(toolchain.root, gate.checkout, name, command, {
            sandboxProfile: gate.profile,
            sandboxHome: gate.scratch,
            toolDir: toolchain.root,
            onStart: (pid) => {
              recordedGate.processGroup = pid;
              recordedGate.process = processIdentity(pid);
              writeReceipt(out, receipt);
            },
          }),
        );
        await stopGateGroup(recordedGate.processGroup);
      } finally {
        fs.rmSync(gate.root, { recursive: true, force: true });
      }
      assertCleanCheckout(baselineDir, "baseline");
      assertCleanCheckout(candidateDir, "candidate");
      if (directoryDigest(toolchain.modules) !== toolchain.sha256) {
        fail("frozen toolchain snapshot changed during certification");
      }
      if (frozenInputsDigest(baselineDir) !== baselineInputs) {
        fail("baseline policy inputs changed during certification");
      }
      writeReceipt(out, receipt);
    }
    receipt.state = receipt.gates.every((gate) => gate.status === "success")
      ? "passed"
      : "failed";
    receipt.completedAt = new Date().toISOString();
    writeReceipt(out, receipt);
  } finally {
    fs.rmSync(toolchain.root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ status: receipt.state, out })}\n`);
  process.exitCode = receipt.state === "passed" ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  assertNoTrackedNodeModules,
  assertSafeLocalGitConfig,
  directoryDigest,
  frozenCommand,
  githubRepository,
  isolatedGitEnvironment,
  receiptPath,
  parse,
  runGate,
  seatbeltProfile,
  selectedTestGates,
  stopGateGroup,
  writeReceipt,
};
