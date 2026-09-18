import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const identity = require("../quality-git-identity.js");

function fixture() {
  const root = makeTempDir("selection-lineage-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (file, contents) => {
    writeFileSync(path.join(root, file), contents);
    git("add", ".");
    git("commit", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const base = commit("base.txt", "base\n");
  git("switch", "-q", "-c", "topic");
  const selection = commit("work.txt", "selected\n");
  const repair = commit("work.txt", "repaired\n");
  git("switch", "-q", "main");
  const nextBase = commit("upstream.txt", "upstream\n");
  git("switch", "-q", "topic");
  git("rebase", "-q", "main");
  const head = git("rev-parse", "HEAD");
  const carry = {
    priorBaseSha: base,
    reviewedHead: repair,
    baseSha: nextBase,
    head,
  };
  return { root, git, commit, base, selection, repair, head, carry };
}

describe("selection lineage identity contract", () => {
  it("requires the published release to bind an explicit commit SHA", () => {
    const taggedCommit = "a".repeat(40);
    expect(
      identity.publishedReleaseCommit("v4.11.2", () => ({
        draft: false,
        published_at: "2026-09-18T00:00:00Z",
        target_commitish: taggedCommit,
      })),
    ).toBe(taggedCommit);
    expect(
      identity.publishedReleaseCommit("v4.11.2", () => ({
        draft: false,
        published_at: "2026-09-18T00:00:00Z",
        target_commitish: "main",
      })),
    ).toBeNull();
  });

  it("rejects draft releases before admitting their target", () => {
    expect(
      identity.publishedReleaseCommit("v4.11.2", () => ({ draft: true })),
    ).toBeNull();
  });

  it("rejects a replay that excludes the selected commit from its source range", () => {
    const f = fixture();
    f.git("switch", "-q", "-c", "forged-source", f.base);
    const selected = f.commit("selected.txt", "selected change\n");
    const repair = f.commit("repair.txt", "repair only\n");
    f.git("switch", "-q", "-c", "unrelated", f.base);
    const unrelated = f.commit("other.txt", "unrelated base\n");
    f.git("cherry-pick", repair);
    const head = f.git("rev-parse", "HEAD");
    expect(identity.replayedTree(f.root, selected, repair, unrelated)).toBe(
      f.git("rev-parse", `${head}^{tree}`),
    );
    expect(
      identity.selectionLineageValid(f.root, selected, head, [
        {
          priorBaseSha: selected,
          reviewedHead: repair,
          baseSha: unrelated,
          head,
        },
      ]),
    ).toBe(false);
  });

  it("rejects an identical replay tree whose target has no base ancestry", () => {
    const f = fixture();
    const head = f.git(
      "commit-tree",
      f.git("rev-parse", `${f.head}^{tree}`),
      "-p",
      f.base,
      "-m",
      "wrong ancestry",
    );
    expect(identity.isAncestorOf(f.root, f.carry.baseSha, head)).toBe(false);
    expect(
      identity.selectionLineageValid(f.root, f.selection, head, [
        { ...f.carry, head },
      ]),
    ).toBe(false);
  });

  it("proves a repair and exact rebase without changing the selected commit", () => {
    const f = fixture();
    expect(identity).toHaveProperty(
      "selectionLineageValid",
      expect.any(Function),
    );
    expect(
      identity.selectionLineageValid(f.root, f.selection, f.head, [f.carry]),
    ).toBe(true);
    expect(
      identity.repairLineage(f.root, f.selection, f.head, [f.carry]).count,
    ).toBe(1);
    expect(identity.isAncestorOf(f.root, f.selection, f.head)).toBe(false);
  });

  it("rejects a reachable but altered replay tree", () => {
    const f = fixture();
    const altered = f.commit("work.txt", "unreviewed change\n");
    expect(
      identity.selectionLineageValid(f.root, f.selection, altered, [
        { ...f.carry, head: altered },
      ]),
    ).toBe(false);
  });

  it("rejects missing, ambiguous and invalid-base carries", () => {
    const f = fixture();
    for (const carries of [
      [],
      [f.carry, { ...f.carry }],
      [{ ...f.carry, baseSha: "0".repeat(40) }],
    ]) {
      expect(
        identity.selectionLineageValid(f.root, f.selection, f.head, carries),
      ).toBe(false);
    }
  });

  it("keeps a historical endpoint valid after a later exact rebase", () => {
    const f = fixture();
    f.git("switch", "-q", "main");
    const laterBase = f.commit("later.txt", "later\n");
    f.git("switch", "-q", "topic");
    f.git("rebase", "-q", "main");
    const later = {
      priorBaseSha: f.carry.baseSha,
      reviewedHead: f.head,
      baseSha: laterBase,
      head: f.git("rev-parse", "HEAD"),
    };
    expect(
      identity.selectionLineageValid(f.root, f.selection, f.head, [
        f.carry,
        later,
      ]),
    ).toBe(true);
    expect(
      identity.selectionLineageValid(f.root, f.selection, later.head, [
        f.carry,
        later,
      ]),
    ).toBe(true);
  });
});
