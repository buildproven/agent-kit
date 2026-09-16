#!/usr/bin/env node

/**
 * One Bash PreToolUse entrypoint for the four safety guards.
 *
 * Ordinary commands are allowed after one JSON parse. Commands that could
 * reach a guard are delegated to the existing compatibility scripts, in their
 * historical order. Keeping those scripts intact preserves their direct test
 * seams and makes this change reversible while removing three interpreter
 * launches from the common path.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const startedAt = performance.now();

const rawInput = fs.readFileSync(0, "utf8");

function deny(message) {
  process.stderr.write(`Blocked: ${message}\n`);
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(rawInput);
} catch {
  deny("Bash hook payload is invalid JSON.");
}

const command = payload?.tool_input?.command;
if (command === undefined || command === "") process.exit(0);
if (typeof command !== "string") deny("Bash command is not a string.");

const scriptDir = __dirname;
const repositoryRoot = path.resolve(scriptDir, "..", "..");

function resolveGuard(name) {
  // A private claude-setup overlay may intentionally replace a kit guard.
  // Prefer that overlay when this dispatcher is running from setup/core.
  const overlay = path.join(repositoryRoot, "scripts", name);
  if (
    path.resolve(overlay) !== path.resolve(scriptDir, name) &&
    fs.existsSync(overlay)
  ) {
    return overlay;
  }
  return path.join(scriptDir, name);
}

function hasDestructiveSyntax(value) {
  return (
    /\brm\b/.test(value) ||
    /\bfind\b/.test(value) ||
    /\bgit\b[^\n;&|(){}]*\bclean\b/.test(value) ||
    /(^|[\s;&|(){}])(?:\d*&?>|&>)/.test(value)
  );
}

const hasGit = /\bgit\b/.test(command);
const hasPush = hasGit && /\bpush\b/.test(command);
const hasCommit = hasGit && /\bcommit\b/.test(command);
const hasDestructive = hasDestructiveSyntax(command);

const guards = [];
if (hasDestructive) guards.push("block-destructive-paths.sh");
if (hasPush) guards.push("block-push-main.sh");
if (hasCommit) guards.push("block-commit-main.sh");
// branch-drift-guard owns session state for checkout/add/commit/stash and is
// therefore invoked for every git command, including ordinary status calls.
if (hasGit) guards.push("branch-drift-guard.sh");

// Claude command-hook timeout discards the hook decision. Keep every child
// inside a shared four-second budget, below the configured five-second outer
// timeout, so a hung child produces an explicit denial first.
//
// This is not hypothetical: these guards parse their own argv, and a
// `shift 2` arm with no remaining value spins its option loop forever rather
// than erroring. Five seconds is far above the ~50ms these checks take.
const guardTimeout = process.env.BS_GUARD_TIMEOUT_MS || "5000";
const GUARD_TIMEOUT_MS = Number(guardTimeout);
if (
  guards.length > 0 &&
  (!/^[1-9]\d*$/.test(guardTimeout) ||
    !Number.isSafeInteger(GUARD_TIMEOUT_MS) ||
    GUARD_TIMEOUT_MS > 5000)
) {
  deny("BS_GUARD_TIMEOUT_MS must be an integer from 1 through 5000.");
}

function runBounded(executable, args, options, name) {
  if (process.platform === "win32")
    deny(
      "Bash safety checks require POSIX process-group cleanup; run them in WSL.",
    );
  const remaining = Math.floor(4000 - (performance.now() - startedAt));
  if (remaining <= 0) deny("Bash safety checks exhausted their 4000ms budget.");
  const timeout = Math.min(GUARD_TIMEOUT_MS, remaining);
  const childStartedAt = performance.now();
  const result = spawnSync(executable, args, {
    ...options,
    // POSIX guards need their own group: killing only bash leaves helpers alive.
    detached: true,
    timeout,
    killSignal: "SIGKILL",
  });
  const elapsed = performance.now() - childStartedAt;
  const deadlineEpipe = result.error?.code === "EPIPE" && elapsed >= timeout;
  if (result.error?.code === "ETIMEDOUT" || result.signal || deadlineEpipe) {
    if (Number.isSafeInteger(result.pid) && result.pid > 1) {
      try {
        process.kill(-result.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          deny(
            `${name} timed out and process-group cleanup failed: ${error.message}`,
          );
      }
    }
    deny(
      `${name} did not finish within ${timeout}ms and was terminated; ` +
        `refusing the command rather than proceeding unchecked`,
    );
  }
  if (result.error) {
    deny(`could not execute ${name}: ${result.error.message}`);
  }
  return result;
}

for (const name of guards) {
  const result = runBounded(
    "bash",
    [resolveGuard(name)],
    {
      input: rawInput,
      encoding: "utf8",
    },
    name,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status === 2 ? 2 : 2);
  }
}

// A protected-branch push must fail at the branch policy first. Only a push
// that survives those semantic guards reaches fleet budget admission. This
// preserves the actionable root cause while still refusing an allowed direct
// push before it can create another Actions run. Quality's signed exact-head
// path invokes its own nested push after proving the local candidate.
//
// The budget check itself is scoped to pushes that can plausibly consume
// Actions minutes. A current-topic push with no open PR costs zero minutes;
// after the PR opens, the same push triggers pull_request:synchronize and must
// be admitted. Gating the first push made PR creation impossible at the hard
// limit, while exempting every topic push allowed later CI-triggering updates.
// Reuse block-push-main.sh's classifier (already-parsed, shell-injection-safe
// tokenizer) rather than re-deriving "is this main/master" with a second
// regex that could drift from the guard that already ran.
if (hasPush) {
  const classifier = resolveGuard("block-push-main.sh");
  const classification = runBounded(
    "bash",
    [classifier, "--ci-budget-classify"],
    {
      input: rawInput,
      encoding: "utf8",
    },
    "CI budget classifier",
  );
  // Only a proved no-CI push is exempt. Protected, cross-branch, unparseable,
  // and GitHub-unavailable cases all retain normal fail-closed admission.
  const cannotTriggerCi =
    classification.status === 0 && classification.stdout.trim() === "no-ci";
  if (!cannotTriggerCi) {
    const admission = resolveGuard("ci-budget-admission.js");
    if (fs.existsSync(admission)) {
      const result = runBounded(
        process.execPath,
        [admission],
        {
          encoding: "utf8",
        },
        "CI budget admission",
      );
      if (result.status !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        deny(
          "GitHub Actions minute policy denied this push; use the signed exact-head quality path.",
        );
      }
    }
  }
}

process.exit(0);
