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
