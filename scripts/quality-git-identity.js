#!/usr/bin/env node
"use strict";

// Git identity and exact-replay proofs, extracted from quality-invocation.js.
//
// These functions share one property that nothing else in the runtime does:
// they answer questions about a repository's history and identity, and they
// touch no manifest state. That makes them the cleanest seam in an 8,275-line
// module holding a dozen responsibilities (BUI-905).
//
// Extracted verbatim. Behaviour is unchanged; the only edit is importing
// canonicalJson, the single name the block referenced from its old home.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { canonicalJson } = require("./quality-canonical-json.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// The review runner expands an initialized `core` gitlink into the exact
// recursive submodule diff so a provider cannot approve an opaque control-
// plane pointer. Canonical verification must hash the same byte stream or a
// valid review is rejected after the provider has already spent its budget.
function reviewDiffBuffer(root, from, to) {
  const diff = execFileSync("git", ["diff", `${from}..${to}`], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
  const treeEntry = (commit) => {
    const row = git(root, ["ls-tree", commit, "--", "core"]);
    const fields = row.split(/\s+/);
    return fields[0] === "160000" && fields[1] === "commit" ? fields[2] : "";
  };
  const baseCore = treeEntry(from);
  const headCore = treeEntry(to);
  const coreCheckout = fs.existsSync(path.join(root, "core", ".git"));
  if (!baseCore && !headCore) return diff;
  if (!baseCore || !headCore) {
    throw new Error("core gitlink exists on only one side of the diff");
  }
  if (baseCore === headCore) return diff;
  if (!coreCheckout) {
    throw new Error(
      "changed core gitlink requires an initialized checkout for recursive review",
    );
  }
  for (const commit of [baseCore, headCore]) {
    execFileSync(
      "git",
      ["-C", "core", "cat-file", "-e", `${commit}^{commit}`],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }
  const recursive = execFileSync(
    "git",
    ["-C", "core", "diff", "--submodule=diff", baseCore, headCore],
    {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 64,
    },
  );
  return Buffer.concat([
    diff,
    Buffer.from(
      `\n===== recursive submodule diff: core ${baseCore}..${headCore} =====\n`,
    ),
    recursive,
    Buffer.from("===== end recursive submodule diff: core =====\n"),
  ]);
}

function canonicalRoot(input) {
  const resolved = fs.realpathSync(input);
  return fs.realpathSync(git(resolved, ["rev-parse", "--show-toplevel"]));
}

// Prove that applying the exact binary diff reviewed at oldHead onto newBase
// produces nextHead's tree. This is stronger than git patch-id: patch-id
// deliberately ignores whitespace and cannot safely authorize a carry.
function replayedTree(root, oldBase, oldHead, newBase) {
  try {
    const diff = execFileSync(
      "git",
      ["diff", "--binary", "--full-index", oldBase, oldHead],
      {
        cwd: root,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 64,
      },
    );
    const indexFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "quality-rebase-index-")),
      "index",
    );
    try {
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      execFileSync("git", ["read-tree", newBase], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync("git", ["apply", "--cached", "--whitespace=nowarn", "-"], {
        cwd: root,
        env,
        input: diff,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 64,
      });
      return execFileSync("git", ["write-tree"], {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } finally {
      fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

function isAncestorOf(root, ancestor, descendant) {
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function gitCommonDir(root) {
  const value = git(root, ["rev-parse", "--git-common-dir"]);
  return fs.realpathSync(path.resolve(root, value));
}

function originIdentity(root) {
  const value = git(root, ["remote", "get-url", "origin"]);
  if (!value) throw new Error("quality requires an origin remote identity");
  return value;
}

function repoKey(root) {
  return crypto
    .createHash("sha256")
    .update(gitCommonDir(root))
    .digest("hex")
    .slice(0, 16);
}

function deterministicInvocationId(identity) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(identity)))
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "5";
  digest[16] = (8 + (parseInt(digest[16], 16) % 4)).toString(16);
  const value = digest.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

module.exports = {
  git,
  reviewDiffBuffer,
  canonicalRoot,
  replayedTree,
  isAncestorOf,
  gitCommonDir,
  originIdentity,
  repoKey,
  deterministicInvocationId,
};
