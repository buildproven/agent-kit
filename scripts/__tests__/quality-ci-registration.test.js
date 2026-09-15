import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WAIT = path.join(ROOT, "scripts", "quality-wait-required-checks.sh");

function harness(body) {
  const root = makeTempDir("quality-ci-registration-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const gh = path.join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(gh, 0o755);
  return { root, bin };
}

describe("quality CI registration wait", () => {
  it("retries exact pending registration responses, then watches success", () => {
    const { root, bin } = harness(`
count=0
[ -f "$QUALITY_TEST_COUNT" ] && count=$(cat "$QUALITY_TEST_COUNT")
count=$((count + 1))
printf '%s' "$count" > "$QUALITY_TEST_COUNT"
printf '%s\n' "$*" >> "$QUALITY_TEST_CALLS"
case "$count" in
  1) echo 'no checks reported' >&2; exit 1 ;;
  2) echo 'no required checks reported' >&2; exit 1 ;;
  3) exit 0 ;;
  4) exit 0 ;;
  *) exit 99 ;;
esac
`);
    execFileSync("bash", [WAIT, "--pr", "17", "--interval", "0"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QUALITY_TEST_CALLS: path.join(root, "calls.log"),
        QUALITY_TEST_COUNT: path.join(root, "count"),
      },
    });
    expect(
      readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n"),
    ).toEqual([
      "pr checks 17 --required",
      "pr checks 17 --required",
      "pr checks 17",
      "pr checks 17 --watch --interval 10",
    ]);
  });

  it("waits on all registered CI when the base cannot require checks", () => {
    const { root, bin } = harness(`
printf '%s\n' "$*" >> "$QUALITY_TEST_CALLS"
case "$*" in
  "pr checks 17 --required") echo 'no required checks reported' >&2; exit 1 ;;
  "pr checks 17") echo 'test pass'; exit 0 ;;
  "pr checks 17 --watch --interval 10") exit 0 ;;
  *) exit 99 ;;
esac
`);
    execFileSync("bash", [WAIT, "--pr", "17", "--interval", "0"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QUALITY_TEST_CALLS: path.join(root, "calls.log"),
      },
    });
    expect(
      readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n"),
    ).toEqual([
      "pr checks 17 --required",
      "pr checks 17",
      "pr checks 17 --watch --interval 10",
    ]);
  });

  it("fails immediately for non-registration errors", () => {
    const { root, bin } = harness(`
echo "$*" >> "$QUALITY_TEST_CALLS"
echo 'authentication required' >&2
exit 1
`);
    const result = spawnSync("bash", [WAIT, "--pr", "17", "--interval", "0"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QUALITY_TEST_CALLS: path.join(root, "calls.log"),
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("authentication required");
    expect(readFileSync(path.join(root, "calls.log"), "utf8").trim()).toBe(
      "pr checks 17 --required",
    );
  });
  it("gives up when required checks never register before the deadline", () => {
    // A never-registering check used to spin forever: telemetry recorded a
    // 71h campaign whose provider work was 228s.
    const { root, bin } = harness(`
printf '%s\n' "$*" >> "$QUALITY_TEST_CALLS"
echo 'no checks reported' >&2
exit 1
`);
    const result = spawnSync(
      "bash",
      [WAIT, "--pr", "17", "--interval", "0", "--deadline", "1"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_CALLS: path.join(root, "calls.log"),
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("did not complete within");
    expect(result.stderr).toContain("treating this as a CI failure");
  });

  it("bounds a watch that never returns", async () => {
    // The `gh --watch` handoff was previously an exec with no deadline.
    const { root, bin } = harness(`
printf '%s\n' "$*" >> "$QUALITY_TEST_CALLS"
case "$*" in
  *--watch*) exec sleep 600 ;;
  *) exit 0 ;;
esac
`);
    const started = Date.now();
    // The killed watcher's own `sleep` can outlive it and hold an inherited
    // pipe open, so send stderr straight to a file descriptor and let stdio
    // close. Redirecting via `bash -c` would build a shell command out of a
    // path, which CodeQL flags (correctly) as command construction from
    // uncontrolled input.
    // Collect stderr through a pipe that is drained and then detached, rather
    // than a file: reopening a path we just wrote is a check-then-use shape,
    // and closing stdio here is what lets the surviving `sleep` go unnoticed.
    const child = spawn(
      "bash",
      [WAIT, "--pr", "17", "--interval", "0", "--deadline", "2"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_CALLS: path.join(root, "calls.log"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        // The killed watcher's own `sleep` can outlive it and hold the pipe
        // open, so resolve on exit rather than waiting for stream close.
        child.stderr.destroy();
        resolve(code);
      });
    });
    expect(status).toBe(75);
    expect(stderr).toContain("watch exceeded the deadline");
    expect(Date.now() - started).toBeLessThan(45000);
  });

  it("rejects a non-numeric deadline", () => {
    const { root, bin } = harness(`exit 0`);
    const result = spawnSync(
      "bash",
      [WAIT, "--pr", "17", "--deadline", "soon"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          QUALITY_TEST_CALLS: path.join(root, "calls.log"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--deadline must be seconds");
  });
});
