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

// Review the exact gitlink transition, not the recursive submodule history.
// A submodule release can contain thousands of files; embedding it makes an
// otherwise one-line pin exceed provider input limits. The two immutable
// commit identities remain reviewable and bind the evidence to the change.
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
  if (!baseCore && !headCore) return diff;
  if (!baseCore || !headCore) {
    throw new Error("core gitlink exists on only one side of the diff");
  }
  if (baseCore === headCore) return diff;
  return Buffer.concat([
    diff,
    Buffer.from(
      `\n===== submodule gitlink: core ${baseCore}..${headCore} =====\n`,
    ),
    Buffer.from("===== end submodule gitlink: core =====\n"),
  ]);
}

function canonicalRoot(input) {
  const resolved = fs.realpathSync(input);
  return fs.realpathSync(git(resolved, ["rev-parse", "--show-toplevel"]));
}

// Resolve committed differences without caller-controlled display/merge policy.
function exactReplayDiff(root, args) {
  return execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "diff",
      "--no-color",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      ...args,
    ],
    {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 64,
    },
  );
}

function replayChangedPaths(root, from, to) {
  const raw = exactReplayDiff(root, ["--name-only", "-z", from, to]);
  const decoded = raw.toString("utf8");
  // Never let lossy pathname decoding collapse distinct committed entries.
  if (!Buffer.from(decoded).equals(raw))
    throw new Error("non-UTF8 replay path");
  return decoded.split("\0").filter(Boolean);
}

// Prove exact direct replay, with already-identical entries satisfied by the
// new base. Callers must still compare this tree with the candidate's tree.
function replayedTree(root, oldBase, oldHead, newBase) {
  try {
    const stillDifferent = new Set(replayChangedPaths(root, oldHead, newBase));
    const paths = replayChangedPaths(root, oldBase, oldHead).filter((file) =>
      stillDifferent.has(file),
    );
    // A whole committed entry already equal on the protected base needs no
    // patch. Partial overlap still requires strict direct application below.
    if (paths.length === 0)
      return git(root, ["rev-parse", `${newBase}^{tree}`]);
    const diff = exactReplayDiff(root, [
      "--binary",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      oldBase,
      oldHead,
      "--",
      ...paths,
    ]);
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
      execFileSync(
        "git",
        [
          "-c",
          "apply.ignoreWhitespace=no",
          "apply",
          "--cached",
          "--no-3way",
          "--whitespace=nowarn",
          "-",
        ],
        {
          cwd: root,
          env,
          input: diff,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024 * 64,
        },
      );
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

// Ordinary repair intervals are counted only when their endpoints establish
// ancestry. Recovery intervals must also be linear, so merged upstream work
// cannot masquerade as repairs. Legacy direct counting remains conservative.
function commitInterval(root, from, to, linear = false) {
  if (!/^[0-9a-f]{7,40}$/i.test(from || "") || !isAncestorOf(root, from, to))
    return null;
  try {
    if (linear && git(root, ["rev-list", "--merges", `${from}..${to}`]))
      return null;
    const count = Number(git(root, ["rev-list", "--count", `${from}..${to}`]));
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

// Pure history seam. The caller supplies trusted carry identities and an exact
// endpoint. Returned carries let authorization consumers verify replay proof
// without duplicating traversal. Reachability is not review coverage.
function repairLineage(root, from, to, carries) {
  if (to !== "HEAD" && !/^[0-9a-f]{40}$/.test(to || "")) return null;
  const direct = commitInterval(root, from, to);
  if (direct !== null) return { count: direct, carries: [] };
  if (!Array.isArray(carries) || !carries.length) return null;
  let current = from;
  let count = 0;
  let endpoint = null;
  const used = [];
  const seen = new Set([current]);
  for (let step = 0; step < carries.length; step++) {
    const eligible = carries.filter(
      (entry) =>
        entry &&
        /^[0-9a-f]{40}$/.test(entry.reviewedHead || "") &&
        /^[0-9a-f]{40}$/.test(entry.head || "") &&
        (entry.reviewedHead === current ||
          isAncestorOf(root, current, entry.reviewedHead)),
    );
    if (!eligible.length) break;
    if (eligible.length !== 1) return null;
    const carry = eligible[0];
    const interval = commitInterval(root, current, carry.reviewedHead, true);
    if (interval === null || seen.has(carry.head)) return null;
    count += interval;
    used.push(carry);
    seen.add(carry.head);
    current = carry.head;
    // Historical review artifacts remain bound to their own endpoint even
    // when the campaign now contains later carries.
    if (endpoint === null && isAncestorOf(root, current, to)) {
      const remaining = commitInterval(root, current, to, true);
      if (remaining === null) return null;
      endpoint = { count: count + remaining, carries: [...used] };
    }
  }
  if (!used.length) return null;
  if (endpoint !== null) return endpoint;
  const remaining = commitInterval(root, current, to, true);
  return remaining === null
    ? null
    : { count: count + remaining, carries: used };
}

function selectionLineageValid(root, from, to, carries) {
  const lineage = repairLineage(root, from, to, carries);
  if (!lineage) return false;
  let selected = from;
  try {
    return lineage.carries.every((carry) => {
      if (
        ![carry.priorBaseSha, carry.baseSha].every((sha) =>
          /^[0-9a-f]{40}$/.test(sha || ""),
        ) ||
        carry.priorBaseSha === selected ||
        !isAncestorOf(root, carry.priorBaseSha, selected) ||
        !isAncestorOf(root, carry.baseSha, carry.head)
      )
        return false;
      const replay = replayedTree(
        root,
        carry.priorBaseSha,
        carry.reviewedHead,
        carry.baseSha,
      );
      const valid =
        replay !== null &&
        replay === git(root, ["rev-parse", `${carry.head}^{tree}`]);
      selected = carry.head;
      return valid;
    });
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
  repairLineage,
  selectionLineageValid,
  gitCommonDir,
  originIdentity,
  repoKey,
  deterministicInvocationId,
};
