#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCHEMA_VERSION = 1;
const DEFAULT_CONTAINER = ".worktrees";
const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_RECENT_MINUTES = 30;
const DEFAULT_QUALITY_LOCK_STALE_HOURS = 24;

class ManagerError extends Error {
  constructor(message, code = "WORKTREE_ERROR", details = {}) {
    super(message);
    this.name = "ManagerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Parse a non-negative numeric CLI option, refusing anything that is not one.
 *
 * `Number(value || fallback)` is unsafe for the thresholds that gate worktree
 * removal. A non-numeric value ("abc", "30m", a shell variable that expanded to
 * garbage) yields NaN, and every comparison against NaN is false — so
 * `ageMinutes < recentMinutes` silently stops protecting anything and the
 * "recently active" guard becomes a no-op that removes live worktrees. It also
 * conflates an explicit `0` with "unset", because `0 || fallback` is the
 * fallback, so asking for no grace period silently got the 24h default.
 *
 * Fail closed instead: an unparseable threshold is a usage error, not a reason
 * to proceed with an unguarded deletion.
 */
// CLI options parsed as non-negative numbers, as [optionKey, flagName].
const NUMERIC_OPTIONS = [
  ["graceHours", "grace-hours"],
  ["recentMinutes", "recent-minutes"],
];

function numericOption(value, fallback, flag) {
  if (value === undefined || value === null || value === "") return fallback;
  // Trim only to tolerate stray padding around a real number. A value that is
  // ENTIRELY whitespace is a mistake, not a request for zero — `Number("")`
  // would quietly make it 0 and disable the guard it was meant to configure.
  const text = typeof value === "number" ? String(value) : String(value).trim();
  const numeric = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new ManagerError(
      `--${flag} must be a non-negative number (got: ${JSON.stringify(value)})`,
      "USAGE",
    );
  }
  return numeric;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new ManagerError(
      `Could not run ${command}: ${result.error.message}`,
      "COMMAND_FAILED",
    );
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new ManagerError(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      "COMMAND_FAILED",
      { command, args, status: result.status },
    );
  }
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function git(repo, args, options = {}) {
  return run("git", ["-C", repo, ...args], options);
}

function realpathExisting(value, label) {
  try {
    return fs.realpathSync(value);
  } catch {
    throw new ManagerError(`${label} does not exist: ${value}`, "NOT_FOUND");
  }
}

function commonDir(repo) {
  const output = git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).stdout;
  return realpathExisting(output, "Git common directory");
}

function sameCommonDir(candidate, expected) {
  try {
    return commonDir(candidate) === expected;
  } catch {
    return false;
  }
}

function primaryRoot(repoInput) {
  const callerRoot = git(repoInput, ["rev-parse", "--show-toplevel"]).stdout;
  const common = commonDir(callerRoot);
  const configured = run(
    "git",
    ["--git-dir", common, "config", "--path", "--get", "core.worktree"],
    { allowFailure: true },
  ).stdout;
  const candidates = [];
  if (configured) {
    candidates.push(path.resolve(common, configured));
  }
  if (path.basename(common) === ".git") {
    candidates.push(path.dirname(common));
  }
  const porcelain = git(callerRoot, ["worktree", "list", "--porcelain"], {
    allowFailure: true,
  }).stdout;
  for (const record of parseWorktrees(porcelain)) {
    if (!record.bare) candidates.push(record.path);
  }
  candidates.push(callerRoot);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && sameCommonDir(candidate, common)) {
      const dotGit = path.join(candidate, ".git");
      if (
        path.basename(common) === ".git" &&
        fs.statSync(dotGit).isDirectory()
      ) {
        return fs.realpathSync(candidate);
      }
      if (
        configured &&
        path.resolve(common, configured) === path.resolve(candidate)
      ) {
        return fs.realpathSync(candidate);
      }
    }
  }
  throw new ManagerError(
    `Could not locate the primary checkout for ${repoInput}. Run repair with an explicit --primary path.`,
    "PRIMARY_NOT_FOUND",
    { callerRoot, commonDir: common },
  );
}

function validateBranch(branch) {
  if (!branch || branch.includes("\0")) {
    throw new ManagerError(
      "A non-empty branch name is required.",
      "INVALID_BRANCH",
    );
  }
  if (/%(?:2e|2f|5c)/i.test(branch)) {
    throw new ManagerError(
      `Encoded traversal or separator sequence is not allowed in a branch name: ${branch}`,
      "INVALID_BRANCH",
    );
  }
  const checked = run("git", ["check-ref-format", "--branch", branch], {
    allowFailure: true,
  });
  if (checked.status !== 0) {
    throw new ManagerError(`Invalid branch name: ${branch}`, "INVALID_BRANCH");
  }
  return branch;
}

function slugBranch(branch) {
  validateBranch(branch);
  const slug = branch
    .normalize("NFKC")
    .toLowerCase()
    .replace(/%2f|%5c/gi, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug === "." || slug === "..") {
    throw new ManagerError(
      `Branch does not produce a safe worktree slug: ${branch}`,
      "INVALID_SLUG",
    );
  }
  return slug.slice(0, 120).replace(/-$/g, "");
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function parseWorktrees(output) {
  const records = [];
  let current = null;
  for (const line of `${output || ""}\n`.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = {
        path: line.slice(9),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked".length).trim() || null;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    } else if (line === "" && current) {
      records.push(current);
      current = null;
    }
  }
  return records;
}

function registeredWorktrees(repoRoot) {
  const records = parseWorktrees(
    git(repoRoot, ["worktree", "list", "--porcelain", "-z"]).stdout.replaceAll(
      "\0",
      "\n",
    ),
  );
  // For an embedded submodule's primary checkout, git reports the submodule's
  // gitdir (.git/modules/<name>) as the `worktree` path instead of the actual
  // working tree — the inverse of a normal repo, where core.worktree points
  // OUT of the gitdir rather than the gitdir being nested under it. Left
  // uncorrected, every caller that treats this path as a real directory (e.g.
  // `create()` reusing a registered worktree for a branch) resolves to a bare
  // gitdir with no files, silently.
  const common = commonDir(repoRoot);
  for (const record of records) {
    if (record.path === common && !record.bare) {
      record.path = primaryRoot(repoRoot);
    }
  }
  return records;
}

function linkedWorktrees(repoRoot) {
  const common = commonDir(repoRoot);
  return registeredWorktrees(repoRoot).filter(
    (record) =>
      record.path !== repoRoot && record.path !== common && !record.bare,
  );
}

function config(repoRoot) {
  const defaults = {
    rootStrategy: "sibling-container",
    containerName: DEFAULT_CONTAINER,
  };
  const candidates = [
    path.join(repoRoot, ".claude", "config.json"),
    path.join(repoRoot, ".codex", "config.json"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const supplied = parsed.worktrees || {};
      if (
        supplied.rootStrategy &&
        supplied.rootStrategy !== "sibling-container"
      ) {
        throw new ManagerError(
          `Unsupported worktree rootStrategy in ${candidate}: ${supplied.rootStrategy}`,
          "INVALID_CONFIG",
        );
      }
      if (
        supplied.containerName &&
        !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(supplied.containerName)
      ) {
        throw new ManagerError(
          `Unsafe worktree containerName in ${candidate}`,
          "INVALID_CONFIG",
        );
      }
      return { ...defaults, ...supplied, source: candidate };
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      throw new ManagerError(
        `Could not parse worktree configuration ${candidate}: ${error.message}`,
        "INVALID_CONFIG",
      );
    }
  }
  return { ...defaults, source: null };
}

function metadataDir(repoRoot) {
  return path.join(commonDir(repoRoot), "worktree-manager");
}

function metadataPath(repoRoot, branch) {
  return path.join(metadataDir(repoRoot), `${stableHash(branch)}.json`);
}

function readMetadata(repoRoot, branch) {
  const file = metadataPath(repoRoot, branch);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeMetadata(repoRoot, branch, patch) {
  const dir = metadataDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = metadataPath(repoRoot, branch);
  const previous = readMetadata(repoRoot, branch) || {};
  const next = {
    schemaVersion: SCHEMA_VERSION,
    branch,
    createdAt: previous.createdAt || new Date().toISOString(),
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  return next;
}

function ensureInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ManagerError(
      `Resolved worktree path escapes or equals its canonical root: ${candidate}`,
      "UNSAFE_PATH",
    );
  }
}

function resolvePlan(options) {
  const repoRoot = primaryRoot(options.repo || process.cwd());
  const branch = validateBranch(options.branch || options.slug);
  const settings = config(repoRoot);
  const repoName = path.basename(repoRoot);
  const worktreeRoot = path.resolve(
    path.dirname(repoRoot),
    settings.containerName,
    repoName,
  );
  const baseSlug = slugBranch(branch);
  const worktrees = registeredWorktrees(repoRoot);
  const conflicting = worktrees.find(
    (record) =>
      record.branch &&
      record.branch !== branch &&
      path.dirname(record.path) === worktreeRoot &&
      path.basename(record.path) === baseSlug,
  );
  const recordMetadata = fs.existsSync(metadataDir(repoRoot))
    ? fs
        .readdirSync(metadataDir(repoRoot))
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          try {
            return JSON.parse(
              fs.readFileSync(path.join(metadataDir(repoRoot), name), "utf8"),
            );
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  const metadataConflict = recordMetadata.find(
    (record) => record.branch !== branch && record.slug === baseSlug,
  );
  const slug =
    conflicting || metadataConflict
      ? `${baseSlug}-${stableHash(branch)}`
      : baseSlug;
  const worktreePath = path.join(worktreeRoot, slug);
  ensureInside(worktreeRoot, worktreePath);
  return {
    repoRoot,
    repoName,
    branch,
    slug,
    worktreeRoot,
    worktreePath,
    baseRef: options.base || null,
    defaultBranch: defaultBranch(repoRoot),
    config: settings,
  };
}

function defaultBranch(repoRoot) {
  const remoteHead = git(
    repoRoot,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true },
  ).stdout;
  if (remoteHead.startsWith("origin/")) return remoteHead.slice(7);
  const configuredDefault = git(
    repoRoot,
    ["config", "--get", "init.defaultBranch"],
    { allowFailure: true },
  ).stdout;
  const primaryBranch = git(
    primaryRoot(repoRoot),
    ["branch", "--show-current"],
    {
      allowFailure: true,
    },
  ).stdout;
  const candidates = [
    configuredDefault,
    primaryBranch,
    "main",
    "master",
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (
      git(
        repoRoot,
        ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
        {
          allowFailure: true,
        },
      ).status === 0
    ) {
      return candidate;
    }
  }
  throw new ManagerError(
    "Could not determine the repository default branch.",
    "BASE_NOT_FOUND",
  );
}

function resolveBase(repoRoot, requested) {
  if (!requested) {
    // Refresh remote-tracking refs before branching from the default branch so a
    // stale local origin/<default> (nobody's fetched recently) can't become
    // the base for a new worktree. A configured origin must refresh
    // successfully; otherwise continuing could silently select stale history.
    const origin = git(repoRoot, ["remote", "get-url", "origin"], {
      allowFailure: true,
    }).stdout;
    if (origin) git(repoRoot, ["fetch", "origin", "--quiet"]);
  }
  const candidates = requested
    ? [requested]
    : [`origin/${defaultBranch(repoRoot)}`, defaultBranch(repoRoot)];
  for (const candidate of candidates) {
    if (
      git(
        repoRoot,
        ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
        {
          allowFailure: true,
        },
      ).status === 0
    ) {
      return candidate;
    }
  }
  throw new ManagerError(
    `Base ref is not a commit: ${requested || candidates.join(" or ")}`,
    "BASE_NOT_FOUND",
  );
}

function worktreeMetadataKey(record) {
  return record.branch || `detached-${record.head}`;
}

// Stale-lock evidence directories are kept for post-mortem triage, but nothing
// removed them, so `<git-common-dir>/worktree-manager/locks/` grew without
// bound — and `help()` tells operators to hand-inspect that directory, which
// gets harder the more debris sits in it.
const STALE_EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function pruneStaleEvidence(lockRoot) {
  let entries;
  try {
    entries = fs.readdirSync(lockRoot, { withFileTypes: true });
  } catch {
    return; // Nothing to prune; never fail an operation over housekeeping.
  }
  const cutoff = Date.now() - STALE_EVIDENCE_RETENTION_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes(".lock.stale-")) continue;
    const full = path.join(lockRoot, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // Raced with another pruner, or not ours to remove — leave it.
    }
  }
}

function withLifecycleLock(repoRoot, key, operation, callback) {
  const lockRoot = path.join(metadataDir(repoRoot), "locks");
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  pruneStaleEvidence(lockRoot);
  const lock = path.join(lockRoot, `${stableHash(key)}.lock`);
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") {
      const ownerFile = path.join(lock, "owner.json");
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      } catch {
        // An unidentifiable lock is retained rather than guessed stale.
      }
      let alive = true;
      if (owner?.hostname === os.hostname() && Number.isInteger(owner.pid)) {
        try {
          process.kill(owner.pid, 0);
        } catch (signalError) {
          alive = signalError.code !== "ESRCH";
        }
      }
      if (!owner || alive) {
        throw new ManagerError(
          `Another process is changing the '${key}' worktree lifecycle. Retry after it finishes.`,
          "LIFECYCLE_BUSY",
          { operation, owner },
        );
      }
      // Stealing a stale lock must be atomic against a specific directory, not
      // a check-then-act. Two processes can both observe the same dead owner
      // and both decide to steal; without this, the second one renames the
      // FIRST one's freshly-created live lock and then creates its own, so both
      // believe they hold the mutex — and this mutex is the only serialization
      // for removal.
      //
      // rename() is atomic: exactly one stealer can move a given directory, and
      // the loser gets ENOENT. The winner then re-creates the lock; if that
      // hits EEXIST, someone else got there first and we must back off rather
      // than proceed unlocked. The evidence name includes the pid so two
      // stealers in the same millisecond cannot collide on the destination.
      const evidence = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(lock, evidence);
      } catch (renameError) {
        if (renameError.code === "ENOENT") {
          throw new ManagerError(
            `Another process is recovering the '${key}' worktree lifecycle lock. Retry after it finishes.`,
            "LIFECYCLE_BUSY",
            { operation, owner },
          );
        }
        throw renameError;
      }
      try {
        fs.mkdirSync(lock);
      } catch (recreateError) {
        if (recreateError.code === "EEXIST") {
          throw new ManagerError(
            `Another process claimed the '${key}' worktree lifecycle lock during recovery. Retry after it finishes.`,
            "LIFECYCLE_BUSY",
            { operation, owner },
          );
        }
        throw recreateError;
      }
    } else {
      throw error;
    }
  }
  const ownerFile = path.join(lock, "owner.json");
  fs.writeFileSync(
    ownerFile,
    `${JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      operation,
      key,
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  try {
    return callback();
  } finally {
    // Releasing must never mask the operation's real outcome. A throw from a
    // `finally` REPLACES the callback's return value — or, worse, the original
    // error — so a bare unlinkSync here turned an actionable `UNPUSHED`
    // refusal into a confusing `ENOENT`/`UNEXPECTED` whenever the lock had
    // already been reclaimed (by a stale-lock stealer, or by an operator
    // following the manual cleanup guidance in `help()`).
    try {
      fs.unlinkSync(ownerFile);
    } catch {
      // Lock already reclaimed by another process or cleaned up by hand.
    }
    try {
      fs.rmdirSync(lock);
    } catch {
      // Same: releasing a lock we no longer own is not this call's failure.
    }
  }
}

function create(options) {
  const initialPlan = resolvePlan(options);
  return withLifecycleLock(
    initialPlan.repoRoot,
    initialPlan.worktreePath,
    "create",
    () => {
      const plan = resolvePlan(options);
      const existing = registeredWorktrees(plan.repoRoot);
      const forBranch = existing.find(
        (record) => record.branch === plan.branch,
      );
      if (forBranch) {
        if (!fs.existsSync(forBranch.path)) {
          throw new ManagerError(
            `Branch '${plan.branch}' has stale worktree registration at ${forBranch.path}. Run reconcile --repair-stale before retrying.`,
            "STALE_REGISTRATION",
            { worktreePath: forBranch.path },
          );
        }
        if (forBranch.locked && !options.lockReason) {
          throw new ManagerError(
            `Branch '${plan.branch}' is already locked by '${forBranch.lockReason || "unknown"}'; reuse requires an explicit matching --lock-reason.`,
            "LOCKED",
          );
        }
        const existingMetadata = readMetadata(plan.repoRoot, plan.branch);
        if (existingMetadata?.state === "recovery-required") {
          throw new ManagerError(
            `Branch '${plan.branch}' requires ownership recovery before reuse. Run repair --repo '${plan.repoRoot}' --apply --owner '${existingMetadata.lockReason || "<recorded owner>"}'.`,
            "RECOVERY_REQUIRED",
          );
        }
        let metadata;
        if (options.lockReason) {
          metadata = lockRecord(plan.repoRoot, forBranch, {
            creator: options.creator,
            purpose: options.purpose,
            invocation: options.invocation,
            reason: options.lockReason,
            recover: options.recover,
            takeoverOwner: options.takeoverOwner,
          }).metadata;
        } else {
          metadata = writeMetadata(plan.repoRoot, plan.branch, {
            creator: options.creator || null,
            purpose: options.purpose || null,
            invocation: options.invocation || null,
            worktreePath: forBranch.path,
            slug: path.basename(forBranch.path),
            state: "active",
          });
        }
        return {
          ...plan,
          worktreePath: forBranch.path,
          reused: true,
          metadata,
        };
      }
      if (fs.existsSync(plan.worktreePath)) {
        throw new ManagerError(
          `Canonical path is occupied but not registered for '${plan.branch}': ${plan.worktreePath}`,
          "PATH_OCCUPIED",
        );
      }
      const branchExists =
        git(
          plan.repoRoot,
          ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`],
          { allowFailure: true },
        ).status === 0;
      const baseRef = branchExists
        ? null
        : resolveBase(plan.repoRoot, options.base);
      const args = ["worktree", "add"];
      if (!branchExists) args.push("-b", plan.branch);
      args.push(plan.worktreePath, branchExists ? plan.branch : baseRef);
      git(plan.repoRoot, args);
      const metadata = writeMetadata(plan.repoRoot, plan.branch, {
        creator: options.creator || null,
        purpose: options.purpose || null,
        invocation: options.invocation || null,
        worktreePath: plan.worktreePath,
        slug: plan.slug,
        baseRef,
        state: "active",
        prNumber: options.pr ? Number(options.pr) : null,
      });
      if (options.lockReason) {
        lockRecord(
          plan.repoRoot,
          {
            path: plan.worktreePath,
            branch: plan.branch,
            head: git(plan.worktreePath, ["rev-parse", "HEAD"]).stdout,
            locked: false,
            lockReason: null,
          },
          {
            creator: options.creator,
            purpose: options.purpose,
            invocation: options.invocation,
            reason: options.lockReason,
          },
        );
      }
      return { ...plan, baseRef, reused: false, metadata };
    },
  );
}

function recordFor(options) {
  const repoRoot = primaryRoot(options.repo || process.cwd());
  const records = registeredWorktrees(repoRoot);
  let record = null;
  if (options.branch) {
    record = records.find((candidate) => candidate.branch === options.branch);
  } else if (options.path) {
    const exact = realpathExisting(options.path, "Worktree path");
    record = records.find(
      (candidate) =>
        fs.existsSync(candidate.path) &&
        fs.realpathSync(candidate.path) === exact,
    );
  }
  if (!record) {
    throw new ManagerError(
      `No registered worktree found for ${options.branch || options.path || "request"}.`,
      "WORKTREE_NOT_FOUND",
    );
  }
  return { repoRoot, record };
}

function expectedLockOwner(repoRoot, record) {
  const metadata = readMetadata(repoRoot, worktreeMetadataKey(record));
  if (
    record.locked &&
    record.lockReason &&
    metadata?.lockReason &&
    record.lockReason !== metadata.lockReason
  ) {
    throw new ManagerError(
      `Git lock owner '${record.lockReason}' disagrees with lifecycle metadata owner '${metadata.lockReason}'. Reconcile ownership explicitly before continuing.`,
      "LOCK_METADATA_DIVERGED",
    );
  }
  return record.lockReason || metadata?.lockReason || null;
}

function lockRecord(repoRoot, record, options) {
  const reason = options.reason || options.owner || options.invocation;
  if (!reason) {
    throw new ManagerError(
      "lock requires --reason, --owner, or --invocation.",
      "OWNER_REQUIRED",
    );
  }
  const expected = expectedLockOwner(repoRoot, record);
  if (record.locked && expected !== reason) {
    if (
      !options.recover ||
      !options.takeoverOwner ||
      options.takeoverOwner !== expected
    ) {
      throw new ManagerError(
        `Worktree is already locked by '${expected || "unknown"}'. Explicit recovery requires --recover --takeover-owner '${expected || "<lock reason>"}'.`,
        "LOCKED",
      );
    }
    git(repoRoot, ["worktree", "unlock", record.path]);
    try {
      git(repoRoot, ["worktree", "lock", "--reason", reason, record.path]);
    } catch (error) {
      git(repoRoot, ["worktree", "lock", "--reason", expected, record.path], {
        allowFailure: true,
      });
      throw error;
    }
  }
  if (!record.locked) {
    git(repoRoot, ["worktree", "lock", "--reason", reason, record.path]);
  }
  const metadataPatch = {
    worktreePath: record.path,
    lockReason: reason,
    state: "active",
  };
  if (options.creator) metadataPatch.creator = options.creator;
  if (options.purpose) metadataPatch.purpose = options.purpose;
  if (options.invocation) metadataPatch.invocation = options.invocation;
  const metadata = writeMetadata(
    repoRoot,
    worktreeMetadataKey(record),
    metadataPatch,
  );
  return { repoRoot, ...record, locked: true, lockReason: reason, metadata };
}

function lock(options) {
  const initial = recordFor(options);
  return withLifecycleLock(
    initial.repoRoot,
    initial.record.path,
    "lock",
    () => {
      const { repoRoot, record } = recordFor(options);
      return lockRecord(repoRoot, record, options);
    },
  );
}

function unlockRecord(repoRoot, record, options) {
  if (!record.locked) return { repoRoot, ...record, unlocked: false };
  const expected = expectedLockOwner(repoRoot, record);
  if (!options.owner || options.owner !== expected) {
    throw new ManagerError(
      `Unlock refused. Supply the exact ownership identity with --owner '${expected || "<lock reason>"}'.`,
      "OWNER_MISMATCH",
    );
  }
  git(repoRoot, ["worktree", "unlock", record.path]);
  writeMetadata(repoRoot, worktreeMetadataKey(record), {
    lockReason: null,
    state: options.terminal ? "terminal" : "unlocked",
  });
  return { repoRoot, ...record, locked: false, unlocked: true };
}

function unlock(options) {
  const initial = recordFor(options);
  return withLifecycleLock(
    initial.repoRoot,
    initial.record.path,
    "unlock",
    () => {
      const { repoRoot, record } = recordFor(options);
      return unlockRecord(repoRoot, record, options);
    },
  );
}

function dirty(record) {
  if (!fs.existsSync(record.path)) return null;
  const result = git(
    record.path,
    ["status", "--porcelain", "--ignore-submodules=none"],
    {
      allowFailure: true,
    },
  );
  if (result.status !== 0) {
    throw new ManagerError(
      `Could not inspect worktree cleanliness at ${record.path}: ${result.stderr || "git status failed"}`,
      "STATUS_UNKNOWN",
    );
  }
  return result.stdout;
}

function restoreRecoveredLock(repoRoot, record, recoveryOwner, removalError) {
  if (!recoveryOwner) throw removalError;
  try {
    lockRecord(
      repoRoot,
      { ...record, locked: false, lockReason: null },
      { reason: recoveryOwner, creator: "recovery-rollback" },
    );
  } catch (rollbackError) {
    writeMetadata(repoRoot, worktreeMetadataKey(record), {
      state: "recovery-required",
      lockReason: recoveryOwner,
      removalError: removalError.message,
      rollbackError: rollbackError.message,
      recoveryRequiredAt: new Date().toISOString(),
    });
    throw new ManagerError(
      `Worktree removal failed and ownership could not be restored. Original error: ${removalError.message}. Lock recovery error: ${rollbackError.message}. Worktree retained at ${record.path}; run repair --repo '${repoRoot}' and restore owner '${recoveryOwner}' before continuing.`,
      "LOCK_RECOVERY_FAILED",
      { worktreePath: record.path, owner: recoveryOwner },
    );
  }
  throw removalError;
}

function inspectDirty(record) {
  try {
    return { available: true, changes: dirty(record), error: null };
  } catch (error) {
    return { available: false, changes: null, error };
  }
}

function upstreamState(repoRoot, branch) {
  if (!branch) {
    return {
      upstream: null,
      ahead: null,
      unpushed: true,
      localHead: null,
    };
  }
  const localHead =
    git(repoRoot, ["rev-parse", `refs/heads/${branch}`], {
      allowFailure: true,
    }).stdout || null;
  const upstream = git(
    repoRoot,
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
    { allowFailure: true },
  ).stdout;
  const remote =
    upstream ||
    (git(
      repoRoot,
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { allowFailure: true },
    ).status === 0
      ? `origin/${branch}`
      : null);
  if (remote) {
    const ahead = Number(
      git(repoRoot, ["rev-list", "--count", `${remote}..${branch}`], {
        allowFailure: true,
      }).stdout || "0",
    );
    const base = defaultBranch(repoRoot);
    const localMerged =
      git(
        repoRoot,
        ["merge-base", "--is-ancestor", branch, `refs/heads/${base}`],
        { allowFailure: true },
      ).status === 0 ||
      git(
        repoRoot,
        ["merge-base", "--is-ancestor", branch, `refs/remotes/origin/${base}`],
        { allowFailure: true },
      ).status === 0;
    return {
      upstream: remote,
      ahead,
      unpushed: ahead > 0,
      localMerged,
      localHead,
    };
  }
  const base = defaultBranch(repoRoot);
  const merged =
    git(
      repoRoot,
      ["merge-base", "--is-ancestor", branch, `refs/heads/${base}`],
      { allowFailure: true },
    ).status === 0 ||
    git(
      repoRoot,
      ["merge-base", "--is-ancestor", branch, `refs/remotes/origin/${base}`],
      { allowFailure: true },
    ).status === 0;
  return {
    upstream: null,
    ahead: null,
    // Tree equality is not merge evidence: an unmerged local commit can
    // reproduce a historical default-branch tree. A squash merge is handled
    // later only when GitHub proves that this exact branch head was merged.
    unpushed: !merged,
    localMerged: merged,
    localHead,
  };
}

function lookupPr(repoRoot, branch) {
  if (
    !branch ||
    run("gh", ["--version"], { allowFailure: true }).status !== 0
  ) {
    return { available: false, state: "UNKNOWN", number: null };
  }
  const result = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      git(repoRoot, ["config", "--get", "remote.origin.url"], {
        allowFailure: true,
      }).stdout,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,state,mergedAt,closedAt,headRefName,headRefOid",
    ],
    { cwd: repoRoot, allowFailure: true },
  );
  if (result.status !== 0) {
    return { available: false, state: "UNKNOWN", number: null };
  }
  try {
    const [pr] = JSON.parse(result.stdout || "[]");
    if (!pr) return { available: true, state: "NONE", number: null };
    return {
      available: true,
      state: pr.mergedAt ? "MERGED" : pr.state,
      number: pr.number,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      headRefOid: pr.headRefOid || null,
    };
  } catch {
    return { available: false, state: "UNKNOWN", number: null };
  }
}

const ACTIVITY_EXCLUDES = new Set([".git", ".next", "dist", "node_modules"]);

function latestFileMtime(directory) {
  let latest = null;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ACTIVITY_EXCLUDES.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(candidate);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(candidate);
      if (stat.isFile() && (latest === null || stat.mtimeMs > latest)) {
        latest = stat.mtimeMs;
      }
    }
  }
  return latest;
}

function activityAgeMinutes(repoRoot, record) {
  const metadata = record.branch ? readMetadata(repoRoot, record.branch) : null;
  const candidates = [metadata?.updatedAt, metadata?.createdAt]
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (fs.existsSync(record.path)) {
    try {
      const fileMtime = latestFileMtime(record.path);
      if (fileMtime !== null) candidates.push(fileMtime);
      const index = git(record.path, ["rev-parse", "--git-path", "index"], {
        allowFailure: true,
      }).stdout;
      if (index && fs.existsSync(index))
        candidates.push(fs.statSync(index).mtimeMs);
    } catch {
      // State classification remains conservative when activity cannot be read.
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(0, (Date.now() - Math.max(...candidates)) / 60000);
}

function qualityLockInvocation(lockReason) {
  const match = /^bs:quality\/([0-9a-f-]{36})$/i.exec(lockReason || "");
  return match ? match[1] : null;
}

function qualityStateDirectory(repoRoot) {
  try {
    const temporaryRoot = fs.realpathSync(process.env.TMPDIR || os.tmpdir());
    return path.join(
      temporaryRoot,
      "bs-quality",
      crypto
        .createHash("sha256")
        .update(commonDir(repoRoot))
        .digest("hex")
        .slice(0, 16),
    );
  } catch {
    return null;
  }
}

function safeQualityDirectories(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch {
    return null;
  }
}

function validateQualityManifest(repoRoot, invocation, manifestPath) {
  let stat;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch {
    return { state: "missing" };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { state: "inconclusive", reason: "quality manifest is unsafe" };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.invocationId !== invocation) {
      return {
        state: "inconclusive",
        reason: "quality manifest invocation does not match the lock",
      };
    }
    if (manifest.repo?.gitCommonDir !== commonDir(repoRoot)) {
      return {
        state: "inconclusive",
        reason: "quality manifest repository does not match the lock",
      };
    }
    let declaredStateRoot;
    let actualStateRoot;
    try {
      // Invocation writers and this reader may observe macOS's /var → /private
      // alias differently. Compare canonical paths so a legitimate manifest is
      // not retained forever solely because TMPDIR was spelled differently.
      declaredStateRoot = fs.realpathSync(manifest.stateRoot || "");
      actualStateRoot = fs.realpathSync(path.dirname(manifestPath));
    } catch {
      return {
        state: "inconclusive",
        reason: "quality manifest state path cannot be resolved safely",
      };
    }
    if (declaredStateRoot !== actualStateRoot) {
      return {
        state: "inconclusive",
        reason: "quality manifest state path does not match the lock",
      };
    }
    return { state: "present", manifest, manifestPath };
  } catch {
    return { state: "inconclusive", reason: "quality manifest is invalid" };
  }
}

function manifestForQualityInvocation(repoRoot, invocation) {
  const stateDirectory = qualityStateDirectory(repoRoot);
  if (!stateDirectory || !fs.existsSync(stateDirectory)) {
    return { state: "missing" };
  }
  const prDirectories = safeQualityDirectories(stateDirectory);
  if (!prDirectories) {
    return { state: "inconclusive", reason: "quality state cannot be read" };
  }
  for (const prDirectory of prDirectories) {
    const prPath = path.join(stateDirectory, prDirectory.name);
    const baseDirectories = safeQualityDirectories(prPath);
    if (!baseDirectories) continue;
    for (const baseDirectory of baseDirectories) {
      const manifestPath = path.join(
        prPath,
        baseDirectory.name,
        invocation,
        "invocation.json",
      );
      const manifest = validateQualityManifest(
        repoRoot,
        invocation,
        manifestPath,
      );
      if (manifest.state !== "missing") return manifest;
    }
  }
  return { state: "missing" };
}

function qualityManifestReleaseState(manifest, manifestPath, now) {
  const declaredUpdatedAt = Date.parse(
    manifest.updatedAt || manifest.createdAt || "",
  );
  let observedUpdatedAt = declaredUpdatedAt;
  let timestampSource = "quality manifest";
  if (!Number.isFinite(observedUpdatedAt)) {
    try {
      observedUpdatedAt = fs.statSync(manifestPath).mtimeMs;
      timestampSource = "quality manifest file";
    } catch {
      return {
        releasable: false,
        reason: "quality manifest timestamp cannot be read safely",
      };
    }
  }
  const stale =
    now - observedUpdatedAt >= DEFAULT_QUALITY_LOCK_STALE_HOURS * 3600000;
  // quality-invocation's recordGate replaces a prior result for the same gate.
  // Still reduce to the latest result defensively: a legacy or manually
  // repaired manifest must not release an active lock because of an obsolete
  // failed attempt followed by a successful retry.
  const latestGateStatus = new Map();
  for (const gate of manifest.gates || []) {
    if (typeof gate?.name === "string") {
      latestGateStatus.set(gate.name, gate.status);
    }
  }
  const terminal = [...latestGateStatus.values()].some((status) =>
    ["failed", "timeout"].includes(status),
  );
  if (terminal) {
    return {
      releasable: true,
      reason: "quality manifest records a terminal gate failure",
    };
  }
  if (stale) {
    return {
      releasable: true,
      reason: `${timestampSource} is older than ${DEFAULT_QUALITY_LOCK_STALE_HOURS}h`,
    };
  }
  return { releasable: false, reason: "quality manifest is still active" };
}

function qualityLockState(repoRoot, record, metadata, now = Date.now()) {
  const invocation = qualityLockInvocation(record.lockReason);
  if (!invocation) return null;
  if (metadata?.invocation && metadata.invocation !== invocation) {
    return {
      releasable: false,
      reason: "quality lock metadata invocation disagrees with the Git lock",
    };
  }
  const manifest = manifestForQualityInvocation(repoRoot, invocation);
  if (manifest.state === "inconclusive") {
    return { releasable: false, reason: manifest.reason };
  }
  if (manifest.state === "present") {
    return {
      ...qualityManifestReleaseState(
        manifest.manifest,
        manifest.manifestPath,
        now,
      ),
      manifestPath: manifest.manifestPath,
    };
  }
  const metadataUpdatedAt = Date.parse(metadata?.updatedAt || "");
  if (
    Number.isFinite(metadataUpdatedAt) &&
    now - metadataUpdatedAt >= DEFAULT_QUALITY_LOCK_STALE_HOURS * 3600000
  ) {
    return {
      releasable: true,
      reason: `quality manifest is missing and lock metadata is older than ${DEFAULT_QUALITY_LOCK_STALE_HOURS}h`,
    };
  }
  return {
    releasable: false,
    reason: "quality manifest is missing but lock metadata is recent",
  };
}

function classify(repoRoot, record, options = {}) {
  if (!fs.existsSync(record.path)) {
    return {
      ...record,
      classification: "stale/missing path",
      removable: false,
      reason: "registered path is missing",
    };
  }
  const metadata = readMetadata(repoRoot, worktreeMetadataKey(record));
  if (metadata?.state === "recovery-required") {
    return {
      ...record,
      classification: "unknown/inconclusive",
      removable: false,
      reason: `ownership recovery required for '${metadata.lockReason || "unknown owner"}'`,
      errorCode: "RECOVERY_REQUIRED",
    };
  }
  if (record.locked) {
    const qualityLock = qualityLockState(repoRoot, record, metadata);
    if (qualityLock?.releasable) {
      return {
        ...record,
        classification: "stale quality lock",
        removable: false,
        releasable: true,
        reason: qualityLock.reason,
        qualityManifestPath: qualityLock.manifestPath || null,
      };
    }
    return {
      ...record,
      classification: "active and locked",
      removable: false,
      reason: qualityLock?.reason || record.lockReason || "Git worktree lock",
    };
  }
  const cleanliness = inspectDirty(record);
  if (!cleanliness.available) {
    return {
      ...record,
      classification: "unknown/inconclusive",
      removable: false,
      reason: cleanliness.error.message,
      errorCode: cleanliness.error.code,
    };
  }
  const changes = cleanliness.changes;
  if (changes) {
    return {
      ...record,
      classification: "dirty",
      removable: false,
      reason: "uncommitted changes",
    };
  }
  if (!record.branch) {
    return {
      ...record,
      classification: "unknown/inconclusive",
      removable: false,
      reason: "detached HEAD",
    };
  }
  const push = upstreamState(repoRoot, record.branch);
  const pr = options.skipPrCheck
    ? { available: false, state: "UNKNOWN", number: null }
    : lookupPr(repoRoot, record.branch);
  const mergedPrCapturesLocalHead =
    pr.state === "MERGED" &&
    Boolean(push.localHead) &&
    pr.headRefOid === push.localHead;
  const mergedPrPush = mergedPrCapturesLocalHead
    ? { ...push, unpushed: false, localMerged: true }
    : push;
  if (pr.state === "OPEN") {
    return {
      ...record,
      ...push,
      pr,
      classification: "clean with open PR",
      removable: false,
      reason: `PR #${pr.number} is open`,
    };
  }
  if (pr.state === "CLOSED") {
    return {
      ...record,
      ...push,
      pr,
      classification: "clean with closed/unmerged PR",
      removable: false,
      reason: `PR #${pr.number} closed without merge`,
    };
  }
  if (mergedPrPush.unpushed) {
    return {
      ...record,
      ...mergedPrPush,
      pr,
      classification: "clean with unpushed commits",
      removable: false,
      reason: "branch contains commits absent from its remote",
    };
  }
  const ageMinutes = activityAgeMinutes(repoRoot, record);
  const recentMinutes = numericOption(
    options.recentMinutes,
    DEFAULT_RECENT_MINUTES,
    "recent-minutes",
  );
  if (
    !options.skipRecencyCheck &&
    ageMinutes !== null &&
    ageMinutes < recentMinutes
  ) {
    return {
      ...record,
      ...push,
      pr,
      ageMinutes,
      classification: "recently active but otherwise removable",
      removable: false,
      reason: `activity within ${recentMinutes} minutes (<${recentMinutes} min)`,
    };
  }
  if (pr.state === "MERGED") {
    const mergedAgeHours = pr.mergedAt
      ? (Date.now() - Date.parse(pr.mergedAt)) / 3600000
      : null;
    const graceHours = numericOption(
      options.graceHours,
      DEFAULT_GRACE_HOURS,
      "grace-hours",
    );
    return {
      ...record,
      ...mergedPrPush,
      pr,
      mergedAgeHours,
      classification: "clean with merged PR",
      removable: mergedAgeHours === null || mergedAgeHours >= graceHours,
      reason:
        mergedAgeHours !== null && mergedAgeHours < graceHours
          ? `merged PR grace period (${graceHours}h)`
          : `PR #${pr.number} merged`,
    };
  }
  if (push.localMerged) {
    return {
      ...record,
      ...push,
      pr,
      classification: "clean local-only branch merged into the default branch",
      removable: true,
      reason: "local branch is contained in the default branch",
    };
  }
  return {
    ...record,
    ...push,
    pr,
    classification: "unknown/inconclusive",
    removable: false,
    reason: pr.available
      ? "no PR and branch lifecycle is inconclusive"
      : "PR state unavailable",
  };
}

function status(options) {
  const repoRoot = primaryRoot(options.repo || process.cwd());
  const records = linkedWorktrees(repoRoot).map((record) => ({
    ...classify(repoRoot, record, options),
    metadata: readMetadata(repoRoot, worktreeMetadataKey(record)),
  }));
  return { repoRoot, worktrees: records };
}

function removeRecord(options) {
  const { repoRoot, record } = recordFor(options);
  if (record.path === repoRoot) {
    throw new ManagerError(
      "The primary checkout cannot be removed.",
      "PRIMARY_REMOVE_REFUSED",
    );
  }
  const lifecycleMetadata = readMetadata(repoRoot, worktreeMetadataKey(record));
  if (lifecycleMetadata?.state === "recovery-required") {
    throw new ManagerError(
      `Worktree removal refused: ownership recovery is required. Run repair --repo '${repoRoot}' --apply --owner '${lifecycleMetadata.lockReason || "<recorded owner>"}'.`,
      "RECOVERY_REQUIRED",
    );
  }
  let recoveryOwner = null;
  if (record.locked) {
    recoveryOwner = expectedLockOwner(repoRoot, record);
    if (!options.recover || !options.owner || options.owner !== recoveryOwner) {
      throw new ManagerError(
        `Locked worktree removal refused. Recovery requires --recover and exact --owner '${recoveryOwner || "<lock reason>"}'.`,
        "LOCKED",
      );
    }
  }
  if (dirty(record)) {
    throw new ManagerError(
      `Dirty worktree removal refused: ${record.path}`,
      "DIRTY",
    );
  }
  if (record.branch) {
    const push = upstreamState(repoRoot, record.branch);
    const pr = options.skipPrCheck
      ? { state: "UNKNOWN", available: false }
      : lookupPr(repoRoot, record.branch);
    const mergedPrCapturesLocalHead =
      pr.state === "MERGED" &&
      Boolean(push.localHead) &&
      pr.headRefOid === push.localHead;
    if (pr.state === "OPEN") {
      throw new ManagerError(
        `Worktree removal refused: PR #${pr.number} is open.`,
        "OPEN_PR",
      );
    }
    if (!options.allowClosed && pr.state === "CLOSED") {
      throw new ManagerError(
        `Worktree removal refused: PR #${pr.number} was closed without merge. Use --allow-closed after explicit review.`,
        "CLOSED_PR",
      );
    }
    if (push.unpushed && !mergedPrCapturesLocalHead) {
      throw new ManagerError(
        `Worktree removal refused: '${record.branch}' has unpushed commits.`,
        "UNPUSHED",
      );
    }
    if (!options.allowUnknown && !pr.available && !push.localMerged) {
      throw new ManagerError(
        "Worktree removal refused because PR state is unavailable.",
        "UNKNOWN",
      );
    }
  }
  // classify() re-checks dirty/unpushed/PR/lock state via recordFor() above,
  // closing the window for those guards. Activity recency lives only in
  // classify() and is not otherwise re-evaluated here, so an automated
  // reconcile --apply pass that classifies as removable and then removes
  // moments later could still remove a worktree a session started editing in
  // that window (unsaved edits don't show up as dirty). Re-check it under
  // the lock, but only on that automated path — an operator's direct,
  // explicit `remove` of one named worktree has no such window and should
  // not gain a new confirmation step.
  if (options.reconcileRecentCheck && !options.allowRecentActivity) {
    const ageMinutes = activityAgeMinutes(repoRoot, record);
    const recentMinutes = numericOption(
      options.recentMinutes,
      DEFAULT_RECENT_MINUTES,
      "recent-minutes",
    );
    if (ageMinutes !== null && ageMinutes < recentMinutes) {
      throw new ManagerError(
        `Worktree removal refused: activity within ${recentMinutes} minutes. Pass --allow-recent-activity after explicit review.`,
        "RECENT_ACTIVITY",
      );
    }
  }
  if (record.locked) {
    unlockRecord(repoRoot, record, {
      owner: recoveryOwner,
      terminal: true,
    });
  }
  let forcedForSubmodules = false;
  try {
    git(repoRoot, ["worktree", "remove", record.path]);
  } catch (error) {
    // Git refuses an otherwise clean, eligible linked worktree when it has
    // initialized submodules. All lifecycle, ownership, dirtiness, push, and
    // PR checks above have already passed, so retry only this known Git refusal
    // with the narrowly scoped force flag. Do not use force for any other
    // removal error.
    try {
      if (
        /work(ing)? trees? containing submodules cannot be moved or removed/i.test(
          error.message,
        )
      ) {
        git(repoRoot, ["worktree", "remove", "--force", record.path]);
        forcedForSubmodules = true;
      } else {
        throw error;
      }
    } catch (removalError) {
      restoreRecoveredLock(repoRoot, record, recoveryOwner, removalError);
    }
  }
  git(repoRoot, ["worktree", "prune", "--expire", "now"]);
  let branchDeleted = false;
  let branchDeletionError = null;
  if (options.deleteBranch && record.branch) {
    const deletion = git(repoRoot, ["branch", "-d", record.branch], {
      allowFailure: true,
    });
    branchDeleted = deletion.status === 0;
    if (!branchDeleted) {
      branchDeletionError =
        deletion.stderr ||
        deletion.stdout ||
        `git branch -d '${record.branch}' failed`;
    }
  }
  if (record.branch) {
    writeMetadata(repoRoot, record.branch, {
      state: "removed",
      removedAt: new Date().toISOString(),
      lockReason: null,
    });
  }
  const container = path.dirname(record.path);
  try {
    if (fs.readdirSync(container).length === 0) fs.rmdirSync(container);
  } catch {
    // Non-empty or already absent is expected.
  }
  return {
    repoRoot,
    removedPath: record.path,
    branch: record.branch,
    branchDeleted,
    branchDeletionError,
    forcedForSubmodules,
    recoverableAs: record.branch,
  };
}

function remove(options) {
  const initial = recordFor(options);
  return withLifecycleLock(
    initial.repoRoot,
    initial.record.path,
    "remove",
    () => removeRecord(options),
  );
}

function reconcile(options) {
  const repoRoot = primaryRoot(options.repo || process.cwd());
  const before = linkedWorktrees(repoRoot);
  const results = [];
  for (const record of before) {
    const state = classify(repoRoot, record, options);
    if (state.classification === "stale quality lock") {
      if (options.apply) {
        try {
          const release = unlock({
            repo: repoRoot,
            path: record.path,
            owner: record.lockReason,
            terminal: true,
          });
          results.push({
            ...state,
            action: "released stale quality lock",
            release,
          });
        } catch (error) {
          results.push({
            ...state,
            action: "skipped",
            error: error.message,
            errorCode: error.code,
          });
        }
      } else {
        results.push({ ...state, action: "report" });
      }
      continue;
    }
    if (state.classification === "stale/missing path") {
      if (options.apply || options.repairStale) {
        git(repoRoot, ["worktree", "prune", "--expire", "now"]);
        results.push({ ...state, action: "pruned stale metadata" });
      } else {
        results.push({ ...state, action: "report" });
      }
      continue;
    }
    // --allow-recent-activity waives ONLY the recency guard, not the other
    // lifecycle checks (merge grace period, PR state, unpushed commits) that
    // classify() short-circuits past when it returns early on recency.
    // Reclassify with just that one check disabled and require the result to
    // be independently removable before treating it as overridden.
    const reclassifiedForOverride =
      state.classification === "recently active but otherwise removable" &&
      options.allowRecentActivity
        ? classify(repoRoot, record, { ...options, skipRecencyCheck: true })
        : null;
    const effectiveState = reclassifiedForOverride || state;
    if (options.apply && effectiveState.removable) {
      try {
        const removed = remove({
          repo: repoRoot,
          path: record.path,
          deleteBranch: Boolean(options.deleteBranch),
          allowUnknown: false,
          recentMinutes: options.recentMinutes,
          allowRecentActivity: Boolean(options.allowRecentActivity),
          reconcileRecentCheck: true,
        });
        results.push({
          ...effectiveState,
          action: "removed",
          removal: removed,
        });
      } catch (error) {
        results.push({
          ...effectiveState,
          action: "skipped",
          error: error.message,
          errorCode: error.code,
        });
      }
    } else {
      results.push({ ...effectiveState, action: "report" });
    }
  }
  return {
    repoRoot,
    applied: Boolean(options.apply),
    summary: results.reduce((counts, result) => {
      counts[result.action] = (counts[result.action] || 0) + 1;
      return counts;
    }, {}),
    worktrees: results,
  };
}

function migrationPlan(options) {
  const repoRoot = primaryRoot(options.repo || process.cwd());
  const records = linkedWorktrees(repoRoot);
  return records.map((record) => {
    if (!record.branch) {
      return {
        currentPath: record.path,
        branch: null,
        safe: false,
        reason: "detached worktree",
      };
    }
    const proposed = resolvePlan({ repo: repoRoot, branch: record.branch });
    const cleanliness = inspectDirty(record);
    const changes = cleanliness.changes;
    const pr = lookupPr(repoRoot, record.branch);
    const canonical = path.resolve(record.path) === proposed.worktreePath;
    let reason = "safe to migrate";
    let safe = true;
    if (!cleanliness.available) {
      safe = false;
      reason = cleanliness.error.message;
    } else if (canonical) {
      safe = false;
      reason = "already canonical";
    } else if (record.locked) {
      safe = false;
      reason = `locked: ${record.lockReason || "unknown owner"}`;
    } else if (changes) {
      safe = false;
      reason = "dirty worktree";
    } else if (fs.existsSync(proposed.worktreePath)) {
      safe = false;
      reason = "destination occupied";
    }
    return {
      currentPath: record.path,
      proposedPath: proposed.worktreePath,
      branch: record.branch,
      dirty: Boolean(changes),
      locked: record.locked,
      lockReason: record.lockReason,
      pr,
      safe,
      reason,
    };
  });
}

function migrate(options) {
  const repoRoot = primaryRoot(options.repo || process.cwd());
  const plans = migrationPlan(options);
  const results = [];
  for (const plan of plans) {
    if (!options.apply || !plan.safe) {
      results.push({ ...plan, action: "report" });
      continue;
    }
    fs.mkdirSync(path.dirname(plan.proposedPath), { recursive: true });
    git(repoRoot, ["worktree", "move", plan.currentPath, plan.proposedPath]);
    git(repoRoot, ["worktree", "repair", plan.proposedPath]);
    writeMetadata(repoRoot, plan.branch, {
      worktreePath: plan.proposedPath,
      slug: path.basename(plan.proposedPath),
      migratedFrom: plan.currentPath,
      migratedAt: new Date().toISOString(),
      state: "active",
    });
    results.push({ ...plan, action: "moved" });
  }
  return {
    repoRoot,
    applied: Boolean(options.apply),
    worktrees: results,
  };
}

function repair(options) {
  const repoRoot = options.primary
    ? realpathExisting(options.primary, "Primary checkout")
    : primaryRoot(options.repo || process.cwd());
  const records = linkedWorktrees(repoRoot);
  const containerName = config(repoRoot).containerName;
  const results = [];
  for (const record of records) {
    if (!fs.existsSync(record.path)) {
      results.push({
        path: record.path,
        branch: record.branch,
        action: "missing; use reconcile --repair-stale",
      });
      continue;
    }
    if (record.locked) {
      const metadataKey = worktreeMetadataKey(record);
      const metadata = readMetadata(repoRoot, metadataKey);
      if (
        metadata?.lockReason &&
        record.lockReason &&
        metadata.lockReason !== record.lockReason
      ) {
        if (!options.apply || options.owner !== record.lockReason) {
          results.push({
            path: record.path,
            branch: record.branch,
            action: "skipped",
            reason: `lock metadata diverged; repair requires --apply --owner '${record.lockReason}'`,
          });
          continue;
        }
        writeMetadata(repoRoot, metadataKey, {
          lockReason: record.lockReason,
          state: "active",
          ownershipRepairedAt: new Date().toISOString(),
        });
      }
    }
    const recoveryMetadata = readMetadata(
      repoRoot,
      worktreeMetadataKey(record),
    );
    if (!record.locked && recoveryMetadata?.state === "recovery-required") {
      if (
        !options.apply ||
        !options.owner ||
        options.owner !== recoveryMetadata.lockReason
      ) {
        results.push({
          path: record.path,
          branch: record.branch,
          action: "skipped",
          reason: `ownership recovery requires --apply --owner '${recoveryMetadata.lockReason || "<recorded owner>"}'`,
        });
        continue;
      }
      git(repoRoot, [
        "worktree",
        "lock",
        "--reason",
        options.owner,
        record.path,
      ]);
      writeMetadata(repoRoot, worktreeMetadataKey(record), {
        state: "active",
        lockReason: options.owner,
        ownershipRecoveredAt: new Date().toISOString(),
      });
    }
    if (
      options.oldRepoName &&
      record.path.includes(
        `${path.sep}${containerName}${path.sep}${options.oldRepoName}${path.sep}`,
      )
    ) {
      const destination = resolvePlan({
        repo: repoRoot,
        branch: record.branch,
      }).worktreePath;
      if (!options.apply) {
        results.push({
          path: record.path,
          destination,
          branch: record.branch,
          action: "would move",
        });
        continue;
      }
      if (record.locked) {
        results.push({
          path: record.path,
          branch: record.branch,
          action: "skipped",
          reason: "locked",
        });
        continue;
      }
      if (fs.existsSync(destination)) {
        throw new ManagerError(
          `Repair destination collision: ${destination}`,
          "PATH_OCCUPIED",
        );
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // A moved primary checkout leaves each linked worktree's .git pointer
      // referring to the old common directory. Repair that exact registration
      // before asking Git to move the dirty-preserving checkout.
      git(repoRoot, ["worktree", "repair", record.path]);
      git(repoRoot, ["worktree", "move", record.path, destination]);
      git(repoRoot, ["worktree", "repair", destination]);
      writeMetadata(repoRoot, record.branch, {
        worktreePath: destination,
        slug: path.basename(destination),
        repairedFrom: record.path,
        repairedAt: new Date().toISOString(),
      });
      results.push({
        path: record.path,
        destination,
        branch: record.branch,
        action: "moved and repaired",
      });
    } else {
      if (options.apply) git(repoRoot, ["worktree", "repair", record.path]);
      results.push({
        path: record.path,
        branch: record.branch,
        action: options.apply ? "repaired" : "would repair",
      });
    }
  }
  return { repoRoot, applied: Boolean(options.apply), worktrees: results };
}

function parseCli(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  const options = {};
  const booleans = new Set([
    "--apply",
    "--dry-run",
    "--recover",
    "--terminal",
    "--delete-branch",
    "--allow-closed",
    "--allow-unknown",
    "--allow-recent-activity",
    "--skip-pr-check",
    "--repair-stale",
    "--json",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (booleans.has(token)) {
      const key = token
        .slice(2)
        .replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      options[key] = token !== "--dry-run";
      continue;
    }
    if (!token.startsWith("--") || index + 1 >= argv.length) {
      throw new ManagerError(`Unexpected argument: ${token}`, "USAGE");
    }
    const key = token
      .slice(2)
      .replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    options[key] = argv[index + 1];
    index += 1;
  }
  // Validate numeric thresholds at parse time, not where they are consumed.
  // These gate worktree removal, and a bad value must be rejected even on a
  // run whose repository happens to have no worktree to classify — otherwise
  // the same typo passes silently today and deletes work tomorrow.
  for (const [key, flag] of NUMERIC_OPTIONS) {
    if (key in options) {
      options[key] = numericOption(options[key], undefined, flag);
    }
  }
  return { command, options };
}

function help() {
  return {
    usage: [
      "worktree-manager resolve --repo <path> --branch <branch>",
      "worktree-manager create --repo <path> --branch <branch> [--base <ref>] [--creator <workflow>] [--purpose <purpose>] [--invocation <id>] [--lock-reason <identity>]",
      "worktree-manager lock --repo <path> (--branch <branch>|--path <path>) --reason <identity> [--takeover-owner <exact prior identity>]",
      "worktree-manager unlock --repo <path> (--branch <branch>|--path <path>) --owner <exact identity> [--terminal]",
      "worktree-manager status --repo <path>",
      "worktree-manager remove --repo <path> (--branch <branch>|--path <path>) [--delete-branch] [--recover --owner <exact identity>]",
      "worktree-manager reconcile --repo <path> [--apply] [--grace-hours <n>] [--recent-minutes <n>] [--delete-branch] [--repair-stale] [--allow-recent-activity]",
      "worktree-manager migrate --repo <path> (--dry-run|--apply)",
      "worktree-manager repair --repo <path> [--primary <path>] [--old-repo-name <name>] [--apply]",
    ],
    notes: [
      "Lifecycle operations (create/lock/unlock/remove/reconcile) serialize per worktree via a lock directory at <git-common-dir>/worktree-manager/locks/<hash>.lock. A lock left by a crashed process on a DIFFERENT host cannot be verified dead (liveness checks only run when owner.hostname matches this machine) and is retained forever rather than guessed stale. If you've independently confirmed the owning host/process is gone, recover by manually deleting that lock directory (recursively) once you've verified it is safe to do so.",
    ],
  };
}

function execute(command, options) {
  switch (command) {
    case "help":
      return help();
    case "resolve":
      return resolvePlan(options);
    case "create":
      return create(options);
    case "lock":
      return lock(options);
    case "unlock":
      return unlock(options);
    case "status":
      return status(options);
    case "remove":
      return remove(options);
    case "reconcile":
      return reconcile(options);
    case "migrate":
      return migrate(options);
    case "repair":
      return repair(options);
    default:
      throw new ManagerError(`Unknown command: ${command}`, "USAGE");
  }
}

module.exports = {
  ManagerError,
  classify,
  config,
  create,
  execute,
  migrate,
  parseCli,
  parseWorktrees,
  primaryRoot,
  reconcile,
  remove,
  repair,
  resolvePlan,
  slugBranch,
  status,
};

if (require.main === module) {
  try {
    const { command, options } = parseCli(process.argv.slice(2));
    const result = execute(command, options);
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`,
    );
  } catch (error) {
    const payload = {
      ok: false,
      error: error.message,
      code: error.code || "UNEXPECTED",
      details: error.details || {},
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = error.code === "USAGE" ? 2 : 1;
  }
}
