#!/usr/bin/env node
"use strict";

// Reap finished quality campaign state.
//
// Campaign manifests accumulate under $TMPDIR/bs-quality/<repoKey>/pr-<n>/
// <baseSha>/<invocationId>/ and nothing has ever removed them: an operator
// machine reached 17,905 manifests across 77,275 directories and 358MB with no
// TTL enforced (BUI-636). `lifecycleStale()` in quality-invocation.js already
// knows when a campaign is finished with, but only to refuse resuming it.
//
// A campaign directory is reaped only when it is genuinely done, in one of two
// shapes:
//   * it holds a manifest with a write-once terminal state AND has been idle
//     past the retention window; or
//   * it holds no manifest at all and is older than the retention window — an
//     orphan with no resumable state and no audit trail.
// A campaign whose manifest has no terminal state is kept regardless of age: it
// is resumable, and its evidence is the audit trail.
//
// Most of the waste is inodes rather than bytes. The machine that motivated
// this carried 80,664 campaign directories, of which 59,847 were empty orphans
// totalling well under a megabyte.
//
// Deletion is confined to directories that sit exactly at campaign depth under
// a state root named `bs-quality`. Anything else is left alone and reported, so
// an unexpected layout fails visible rather than taking a recursive delete
// somewhere it should not.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_RETENTION_DAYS = 7;
const CAMPAIGN_DEPTH = 4;

function stateRoot() {
  const base = fs.realpathSync(process.env.TMPDIR || os.tmpdir());
  return path.join(base, "bs-quality");
}

function parseArgs(argv) {
  const options = { apply: false, retentionDays: DEFAULT_RETENTION_DAYS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--retention-days") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--retention-days must be a positive integer");
      }
      options.retentionDays = value;
      index += 1;
    } else if (argument === "--root") {
      options.root = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument '${argument}'`);
    }
  }
  return options;
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A campaign is reapable only when it reached a terminal state and has been
// idle past the retention window. Unreadable manifests are kept: a campaign we
// cannot classify is not one we should delete.
function classify(directory, now, retentionMilliseconds) {
  const manifestPath = path.join(directory, "invocation.json");
  // A campaign root with no manifest is an orphan: a run that died before
  // writing one, or a fixture left behind by the test suite. It carries no
  // resumable state and no audit trail, so age alone decides. These dominate
  // the waste in practice — 59,847 of 80,664 directories on the machine that
  // motivated BUI-636 were manifest-less and older than a week.
  if (!fs.existsSync(manifestPath)) {
    let modified;
    try {
      modified = fs.statSync(directory).mtimeMs;
    } catch {
      return { reap: false, reason: "unreadable-orphan" };
    }
    if (now - modified < retentionMilliseconds) {
      return { reap: false, reason: "within-retention" };
    }
    return { reap: true, reason: "orphan-no-manifest" };
  }
  const manifest = readManifest(manifestPath);
  if (!manifest) return { reap: false, reason: "unreadable-manifest" };
  const terminal = manifest.terminalState?.state;
  if (!terminal) return { reap: false, reason: "not-terminal" };
  const stamps = [
    manifest.terminalState?.recordedAt,
    manifest.governor?.lastActivityAt,
  ]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0) return { reap: false, reason: "no-timestamp" };
  const idleMilliseconds = now - Math.max(...stamps);
  if (idleMilliseconds < retentionMilliseconds) {
    return { reap: false, reason: "within-retention" };
  }
  return { reap: true, reason: terminal, idleMilliseconds };
}

function campaignDirectories(root) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > CAMPAIGN_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (depth === CAMPAIGN_DEPTH - 1) {
        found.push(child);
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function directorySize(directory) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else {
        try {
          total += fs.statSync(child).size;
        } catch {
          /* raced with another reaper; ignore */
        }
      }
    }
  };
  walk(directory);
  return total;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root ? path.resolve(options.root) : stateRoot();
  if (!fs.existsSync(root)) {
    process.stdout.write(`quality-reap-state: nothing to reap at ${root}\n`);
    return;
  }
  // Refuse to operate anywhere that is not a bs-quality state root, so a
  // mistyped --root cannot turn this into a recursive delete of something else.
  if (path.basename(root) !== "bs-quality") {
    process.stderr.write(
      `quality-reap-state: refusing to reap ${root}; expected a directory named 'bs-quality'\n`,
    );
    process.exit(1);
  }

  const now = Date.now();
  const retentionMilliseconds = options.retentionDays * 24 * 60 * 60 * 1000;
  const directories = campaignDirectories(root);
  const kept = new Map();
  let reapedCount = 0;
  let reapedBytes = 0;

  for (const directory of directories) {
    const verdict = classify(directory, now, retentionMilliseconds);
    if (!verdict.reap) {
      kept.set(verdict.reason, (kept.get(verdict.reason) || 0) + 1);
      continue;
    }
    reapedBytes += directorySize(directory);
    reapedCount += 1;
    if (options.apply) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  const megabytes = (reapedBytes / (1024 * 1024)).toFixed(1);
  const verb = options.apply ? "reaped" : "would reap";
  process.stdout.write(
    `quality-reap-state: ${verb} ${reapedCount} of ${directories.length} campaigns (${megabytes}MB), retention ${options.retentionDays}d\n`,
  );
  for (const [reason, count] of [...kept].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  kept ${count} — ${reason}\n`);
  }
  if (!options.apply && reapedCount > 0) {
    process.stdout.write("  re-run with --apply to delete\n");
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality-reap-state: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { classify, campaignDirectories };
