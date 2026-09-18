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
const CORE_RELEASE_REPOSITORY = "buildproven/agent-kit";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Review the exact gitlink transition with its source. A provider cannot
// review a commit ID in place of the code it introduces. Keep the source
// evidence below the smallest supported provider input limit; larger changes
// fail closed and must use a separately admitted source delivery.
const MAX_SUBMODULE_REVIEW_BYTES = 768 * 1024;

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
  const coreDir = path.join(root, "core");
  if (!fs.existsSync(path.join(coreDir, ".git"))) {
    throw new Error(
      "changed core gitlink requires an initialized checkout for recursive review",
    );
  }
  let coreDiff;
  try {
    coreDiff = execFileSync(
      "git",
      ["-C", "core", "diff", "--submodule=diff", baseCore, headCore],
      {
        cwd: root,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_SUBMODULE_REVIEW_BYTES + 1,
      },
    );
  } catch (error) {
    if (
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      error.code === "ENOBUFS"
    ) {
      return admittedCoreReleaseBuffer(root, diff, headCore, error);
    }
    throw error;
  }
  if (coreDiff.length > MAX_SUBMODULE_REVIEW_BYTES) {
    return admittedCoreReleaseBuffer(root, diff, headCore);
  }
  return Buffer.concat([
    diff,
    Buffer.from(
      `\n===== recursive submodule diff: core ${baseCore}..${headCore} =====\n`,
    ),
    coreDiff,
    Buffer.from("===== end recursive submodule diff: core =====\n"),
  ]);
}

function admittedCoreReleaseBuffer(root, diff, headCore, cause) {
  const coreRoot = path.join(root, "core");
  const remote = git(coreRoot, ["remote", "get-url", "origin"]);
  let repository;
  try {
    repository = execFileSync(
      "gh",
      [
        "repo",
        "view",
        remote,
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    throw new Error(
      "core release admission could not resolve canonical repository identity",
      { cause: error },
    );
  }
  if (repository !== CORE_RELEASE_REPOSITORY) {
    throw new Error(
      `core recursive review diff exceeds ${MAX_SUBMODULE_REVIEW_BYTES} bytes and canonical repository is not ${CORE_RELEASE_REPOSITORY}`,
      { cause },
    );
  }
  const tags = git(coreRoot, [
    "tag",
    "--points-at",
    headCore,
    "--list",
    "v[0-9]*",
  ])
    .split("\n")
    .filter(Boolean);
  for (const tag of tags) {
    try {
      const release = JSON.parse(
        execFileSync(
          "gh",
          ["api", `repos/${CORE_RELEASE_REPOSITORY}/releases/tags/${tag}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      if (release.draft !== false || typeof release.published_at !== "string") {
        continue;
      }
      let target = release.target_commitish;
      if (typeof target !== "string" || target.length === 0) continue;
      if (!/^[0-9a-f]{40}$/i.test(target)) {
        target = execFileSync(
          "gh",
          [
            "api",
            `repos/${CORE_RELEASE_REPOSITORY}/commits/${target}`,
            "--jq",
            ".sha",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      }
      if (target === headCore) {
        return Buffer.concat([
          diff,
          Buffer.from(
            `\n===== separately admitted core release: ${CORE_RELEASE_REPOSITORY} ${tag} ${headCore} =====\n`,
          ),
          Buffer.from("===== end separately admitted core release =====\n"),
        ]);
      }
    } catch {
      // A local tag is not admission evidence. Try the next exact tag.
    }
  }
  throw new Error(
    `core recursive review diff exceeds ${MAX_SUBMODULE_REVIEW_BYTES} bytes and ${headCore} has no exact published ${CORE_RELEASE_REPOSITORY} release admission`,
    { cause },
  );
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

if (require.main === module) {
  const [command, root, from, to] = process.argv.slice(2);
  if (command !== "review-diff" || !root || !from || !to) {
    process.stderr.write(
      "usage: quality-git-identity.js review-diff <root> <from> <to>\n",
    );
    process.exit(1);
  }
  try {
    process.stdout.write(reviewDiffBuffer(root, from, to));
  } catch (error) {
    process.stderr.write(`quality-git-identity: ${error.message}\n`);
    process.exit(1);
  }
}
