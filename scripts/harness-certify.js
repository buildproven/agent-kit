#!/usr/bin/env node
"use strict";

// Certifies a harness candidate from an already-merged agent-kit checkout.
// It deliberately does not import candidate JavaScript, package scripts, or
// quality runtime code. Candidate code is only the subject of fixed native
// commands defined below.

const crypto = require("crypto");
const fs = require("fs");
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
    ["-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    },
  ).trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeReceipt(out, receipt) {
  const temporary = `${out}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
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
  const out = path.resolve(suppliedPath);
  const parent = fs.realpathSync(path.dirname(out));
  if (isWithin(fs.realpathSync(candidateDir), parent)) {
    fail("--out must be outside the candidate checkout");
  }
  if (fs.existsSync(out)) {
    fail("--out already exists; preserve prior certification evidence");
  }
  return out;
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

function frozenCommand(baselineDir, command) {
  const [file, ...args] = command;
  if (file.startsWith("node_modules/")) {
    return [path.join(baselineDir, file), ...args];
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
  { timeoutMs = 15 * 60 * 1000, killGraceMs = 5_000 } = {},
) {
  const [file, ...args] = frozenCommand(baselineDir, command);
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd: candidateDir,
      detached: true,
      env: {
        ...process.env,
        PATH: `${path.join(baselineDir, "node_modules", ".bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
        npm_config_globalconfig: "/dev/null",
        npm_config_ignore_scripts: "true",
        npm_config_registry: "https://registry.npmjs.org",
        npm_config_userconfig: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      });
    });
  });
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
  const selector = path.join(baselineDir, "scripts", "test-impact.js");
  const result = spawnSync(
    "node",
    [selector, "--policy-root", baselineDir, "--", ...files],
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
  return {
    mode: plan.mode,
    reason: plan.reason || null,
    files,
    gates: commands.map((command, index) => [
      `test-${index + 1}`,
      [command.executable, ...command.args],
    ]),
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const baselineDir = fs.realpathSync(process.cwd());
  const candidateDir = fs.realpathSync(options["candidate-dir"]);
  const baselineHead = git(baselineDir, ["rev-parse", "HEAD"]);
  if (baselineHead !== options["baseline-sha"]) {
    fail(
      `baseline HEAD ${baselineHead} does not equal declared ${options["baseline-sha"]}`,
    );
  }
  const candidateHead = git(candidateDir, ["rev-parse", "HEAD"]);
  if (candidateHead !== options["candidate-head"]) {
    fail(
      `candidate HEAD ${candidateHead} does not equal declared ${options["candidate-head"]}`,
    );
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
  const receipt = {
    schemaVersion: 1,
    kind: "frozen-harness-certification",
    recordedAt: new Date().toISOString(),
    baseline: { directory: baselineDir, sha: baselineHead },
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
  writeReceipt(out, receipt);
  for (const [name, command] of [
    ...PROFILES[options.profile],
    ...testPlan.gates,
  ]) {
    receipt.gates.push(await runGate(baselineDir, candidateDir, name, command));
    writeReceipt(out, receipt);
  }
  receipt.state = receipt.gates.every((gate) => gate.status === "success")
    ? "passed"
    : "failed";
  receipt.completedAt = new Date().toISOString();
  writeReceipt(out, receipt);
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
  frozenCommand,
  receiptPath,
  parse,
  runGate,
  selectedTestGates,
  writeReceipt,
};
