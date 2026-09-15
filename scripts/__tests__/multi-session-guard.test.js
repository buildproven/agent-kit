import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD = path.resolve(import.meta.dirname, "..", "multi-session-guard.sh");

let repo;
let lockDir;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "session-guard-"));
  execFileSync("git", ["init", "-q", "."], { cwd: repo });
  lockDir = path.join(repo, ".git", "claude-sessions");
  mkdirSync(lockDir, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeLock(name, owner, ageSeconds = 0) {
  const stamp = Math.floor(Date.now() / 1000) - ageSeconds;
  writeFileSync(path.join(lockDir, name), `${stamp} ${repo} ${owner}\n`);
}

function runGuard(sessionId) {
  return spawnSync("bash", [GUARD], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_SESSION_ID: sessionId },
  });
}

function locks() {
  return readdirSync(lockDir).filter((n) => n.endsWith(".lock"));
}

describe("multi-session-guard.sh ownership", () => {
  // BUI-917: the record used to store $$ -- the hook shell, which exits the
  // moment the hook returns. The liveness check below then reaped any record
  // whose pid was gone, so a live session's lock was discarded on the very
  // next hook run and the guard silently stopped guarding. It failed OPEN:
  // two sessions could both believe they held the lock.

  it("keeps a live session's lock when another session runs the hook", () => {
    writeLock("live.lock", "session:live-abc");
    runGuard("second-session");
    expect(locks()).toContain("live.lock");
  });

  it("keeps a legacy bare-pid record instead of reaping on a dead pid", () => {
    // Pre-fix records store a hook pid that is dead by definition. Reaping on
    // that pid is what destroyed live sessions, so these age out via the TTL.
    writeLock("legacy.lock", "999999");
    runGuard("second-session");
    expect(locks()).toContain("legacy.lock");
  });

  it("still reaps a proc: owner whose process is genuinely gone", () => {
    // The one shape where pid liveness is meaningful must keep working, or
    // the fix would trade a reap-too-eagerly bug for a never-reap leak.
    writeLock("dead.lock", "proc:999999");
    runGuard("second-session");
    expect(locks()).not.toContain("dead.lock");
  });

  it("still reaps any record past the 12 hour TTL", () => {
    writeLock("ancient.lock", "session:long-gone", 43_201);
    runGuard("second-session");
    expect(locks()).not.toContain("ancient.lock");
  });

  it("records a session owner, not the hook shell pid", () => {
    const result = runGuard("my-session");
    expect(result.status).toBe(0);
    const own = locks().filter((n) => n !== "live.lock");
    expect(own.length).toBeGreaterThan(0);
    const body = readdirSync(lockDir)
      .filter((n) => n.endsWith(".lock"))
      .map((n) =>
        require("node:fs").readFileSync(path.join(lockDir, n), "utf8"),
      )
      .join("");
    expect(body).toMatch(/session:my-session/);
  });
});
