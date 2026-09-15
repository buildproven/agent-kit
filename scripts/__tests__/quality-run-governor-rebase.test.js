import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const { resolveCommitCount } = require("../quality-run-governor.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Build a repo whose campaign baseline is orphaned by a rebase, which is the
// topology a quality campaign reaches when it advances through a proven
// exact replay: the reviewed work survives on a new commit, and the original
// start SHA is no longer an ancestor of HEAD.
function rebasedRepo() {
  const root = makeTempDir("governor-rebase-");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Governor Test"]);
  git(root, ["config", "user.email", "governor@example.com"]);
  writeFileSync(path.join(root, "base.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);

  git(root, ["switch", "-q", "-c", "feature"]);
  writeFileSync(path.join(root, "work.txt"), "work\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "campaign start"]);
  const startSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(root, "work.txt"), "work more\n");
  git(root, ["commit", "-qam", "fix commit"]);

  // main advances, then the feature branch is replayed onto it. startSha is
  // now orphaned even though its content survives at a new SHA.
  git(root, ["switch", "-q", "main"]);
  writeFileSync(path.join(root, "other.txt"), "other\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "main advances"]);
  git(root, ["switch", "-q", "feature"]);
  git(root, ["rebase", "-q", "main"]);

  const carriedStart = git(root, ["rev-parse", "HEAD~1"]);
  return { root, startSha, carriedStart };
}

describe("governor commit resolution across a rebase", () => {
  it("resolves the baseline through a proven carry chain", () => {
    const { root, startSha, carriedStart } = rebasedRepo();

    // Without the chain the orphaned baseline is unresolvable, which the
    // governor reports as a malformed sentinel rather than as the expected
    // rebase topology it actually is (BUI-902).
    expect(resolveCommitCount(root, { start_commit_sha: startSha })).toBeNull();

    const resolved = resolveCommitCount(root, {
      start_commit_sha: startSha,
      review_rebase_carries: [
        { reviewedHead: startSha, head: carriedStart, expectedTree: "t" },
      ],
    });
    // One fix commit sits between the carried baseline and HEAD.
    expect(resolved).toBe(1);
  });

  it("does not follow a carry whose reviewedHead only shares a short prefix", () => {
    // The first implementation matched with
    // `entry.reviewedHead.startsWith(current.slice(0, 7))`, and Array.find
    // returns the FIRST match. A second carry sharing only the 7-character
    // prefix of the real baseline would therefore be selected instead of it,
    // silently resolving the baseline to an unrelated commit and skewing the
    // fix-commit count that bounds an autonomous campaign.
    //
    // Every other test in this file builds carries whose reviewedHead is an
    // exact full-length match, so none of them could ever exercise this.
    const { root, startSha, carriedStart } = rebasedRepo();
    const collidingHead = `${startSha.slice(0, 7)}${"9".repeat(33)}`;
    expect(collidingHead).not.toBe(startSha);
    expect(collidingHead.slice(0, 7)).toBe(startSha.slice(0, 7));

    const resolved = resolveCommitCount(root, {
      start_commit_sha: startSha,
      review_rebase_carries: [
        // Ordered so a prefix match finds the decoy first.
        { reviewedHead: collidingHead, head: "f".repeat(40) },
        { reviewedHead: startSha, head: carriedStart },
      ],
    });

    // The genuine carry must still win: one fix commit above the carried base.
    expect(resolved).toBe(1);
  });

  it("fails closed on a carry chain that does not reach live history", () => {
    const { root, startSha } = rebasedRepo();
    const stranded = "0".repeat(40);

    expect(
      resolveCommitCount(root, {
        start_commit_sha: startSha,
        review_rebase_carries: [{ reviewedHead: startSha, head: stranded }],
      }),
    ).toBeNull();
  });

  it("fails closed on a cyclic carry chain", () => {
    // A cycle must not become a way to relocate the baseline indefinitely.
    const { root, startSha, carriedStart } = rebasedRepo();

    expect(
      resolveCommitCount(root, {
        start_commit_sha: startSha,
        review_rebase_carries: [
          { reviewedHead: startSha, head: carriedStart },
          { reviewedHead: carriedStart, head: startSha },
        ],
      }),
    ).toBeNull();
  });

  it("ignores a malformed carry list rather than trusting it", () => {
    const { root, startSha } = rebasedRepo();

    for (const carries of [null, "nope", [{}], [{ reviewedHead: startSha }]]) {
      expect(
        resolveCommitCount(root, {
          start_commit_sha: startSha,
          review_rebase_carries: carries,
        }),
      ).toBeNull();
    }
  });

  it("still uses the direct baseline when it remains an ancestor", () => {
    // The carry path must not change behaviour for an ordinary campaign.
    const root = makeTempDir("governor-linear-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Governor Test"]);
    git(root, ["config", "user.email", "governor@example.com"]);
    writeFileSync(path.join(root, "a.txt"), "a\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "start"]);
    const startSha = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "b.txt"), "b\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "one fix"]);

    expect(resolveCommitCount(root, { start_commit_sha: startSha })).toBe(1);
  });
});
