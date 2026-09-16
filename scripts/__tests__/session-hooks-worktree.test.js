// Session-lifecycle hooks must work inside a linked git worktree.
//
// In a linked worktree `.git` is a FILE containing a `gitdir:` pointer, not a
// directory. Every one of these hooks built its state path as
// "$(git rev-parse --show-toplevel)/.git/…", so in a worktree:
//
//   - multi-session-guard.sh   `mkdir -p` failed "Not a directory" and, under
//                              `set -euo pipefail`, killed the hook — so
//                              multi-session detection was dead in every
//                              worktree, the exact multi-checkout scenario it
//                              exists to protect.
//   - auto-init-check.sh       `touch` failed, so the warn-once marker never
//                              persisted and it re-warned on every prompt.
//   - multi-session-cleanup.sh locks created in a worktree were never removed.
//
// Worktrees are this repo's documented development workflow, so these must be
// exercised from inside one. `git rev-parse --absolute-git-dir` resolves to the
// correct per-worktree directory in both layouts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPTS = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(SCRIPTS, "multi-session-guard.sh");
const CLEANUP = path.join(SCRIPTS, "multi-session-cleanup.sh");
const INIT_CHECK = path.join(SCRIPTS, "auto-init-check.sh");

describe("distributed hook time limits", () => {
  it("uses seconds for every Claude hook, not child-process milliseconds", () => {
    const settings = JSON.parse(
      readFileSync(path.join(SCRIPTS, "../config/settings.json"), "utf8"),
    );
    const limits = Object.fromEntries(
      Object.entries(settings.hooks).map(([event, matchers]) => [
        event,
        matchers.flatMap((matcher) =>
          matcher.hooks.map((hook) => hook.timeout),
        ),
      ]),
    );
    expect(limits).toEqual({
      UserPromptSubmit: [3],
      PostToolUse: [10],
      PreToolUse: [5, 5],
      TeammateIdle: [30],
      TaskCompleted: [60],
      Stop: [10, 2],
      Notification: [3, 3, 3],
      SessionStart: [3],
    });
  });
});

let repo;
let worktree;

const git = (args, cwd = repo) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function runHook(hook, cwd, env = {}) {
  try {
    const stdout = execFileSync("bash", [hook], {
      cwd,
      encoding: "utf8",
      input: JSON.stringify({ prompt: "hi" }),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return {
      code: error.status,
      output: (error.stdout ?? "") + (error.stderr ?? ""),
    };
  }
}

/** The per-worktree git dir — where session state legitimately belongs. */
const gitDirOf = (cwd) => git(["rev-parse", "--absolute-git-dir"], cwd);

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "session-hooks-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "seed\n");
  git(["add", "."]);
  git(["commit", "-m", "seed"]);

  worktree = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
  git(["worktree", "add", "-q", "-b", "wt/probe", worktree]);
});

afterAll(() => {
  if (worktree) {
    try {
      git(["worktree", "remove", "--force", worktree]);
    } catch {
      // already gone
    }
    rmSync(worktree, { recursive: true, force: true });
  }
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("multi-session-guard.sh", () => {
  it("registers a session lock in the primary checkout", () => {
    const { code } = runHook(GUARD, repo, { SESSION_ID: "primary-1" });
    expect(code).toBe(0);
    expect(
      existsSync(
        path.join(gitDirOf(repo), "claude-sessions", "primary-1.lock"),
      ),
    ).toBe(true);
  });

  it("registers a session lock from inside a linked worktree", () => {
    const { code, output } = runHook(GUARD, worktree, { SESSION_ID: "wt-1" });
    expect(code).toBe(0);
    expect(output).not.toMatch(/not a directory/i);
    expect(
      existsSync(path.join(gitDirOf(worktree), "claude-sessions", "wt-1.lock")),
    ).toBe(true);
  });

  it("does not write session state into the worktree's .git file path", () => {
    runHook(GUARD, worktree, { SESSION_ID: "wt-2" });
    // `<worktree>/.git` is a file; a directory there means the old broken
    // path construction came back.
    expect(existsSync(path.join(worktree, ".git", "claude-sessions"))).toBe(
      false,
    );
  });
});

describe("multi-session-cleanup.sh", () => {
  it("removes the lock it paired with, from inside a worktree", () => {
    runHook(GUARD, worktree, { SESSION_ID: "wt-cleanup" });
    const lock = path.join(
      gitDirOf(worktree),
      "claude-sessions",
      "wt-cleanup.lock",
    );
    expect(existsSync(lock)).toBe(true);

    const { code } = runHook(CLEANUP, worktree, { SESSION_ID: "wt-cleanup" });
    expect(code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("auto-init-check.sh", () => {
  it("persists its warn-once marker inside a worktree", () => {
    const marker = path.join(gitDirOf(worktree), "claude-init-checked");
    rmSync(marker, { force: true });

    const first = runHook(INIT_CHECK, worktree);
    expect(first.code).toBe(0);
    expect(existsSync(marker)).toBe(true);

    // Second run must be silent — the marker is what makes it warn ONCE.
    const second = runHook(INIT_CHECK, worktree);
    expect(second.code).toBe(0);
    expect(second.output.trim()).toBe("");
  });
});
