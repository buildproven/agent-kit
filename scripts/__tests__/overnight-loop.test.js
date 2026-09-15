import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const repo = resolve(import.meta.dirname, "../..");
const loop = join(repo, "scripts/overnight-loop.sh");
const deadline = join(repo, "scripts/run-with-deadline.py");

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = makeTempDir("overnight-loop-test-");
  const setup = join(root, "setup");
  const target = join(root, "target");
  const bin = join(root, "bin");
  mkdirSync(join(setup, "scripts"), { recursive: true });
  mkdirSync(target);
  mkdirSync(bin);
  copyFileSync(deadline, join(setup, "scripts/run-with-deadline.py"));
  for (const name of [
    "provider-run.sh",
    "provider-policy.sh",
    "autonomous-loop-runtime.js",
  ]) {
    copyFileSync(join(repo, "scripts", name), join(setup, "scripts", name));
    chmodSync(join(setup, "scripts", name), 0o755);
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: target });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: target,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: target });
  writeFileSync(join(target, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: target });
  execFileSync("git", ["commit", "-m", "chore: initial"], { cwd: target });
  executable(join(bin, "claude"), "echo claude-must-not-run >&2; exit 91");
  const usage = join(bin, "claude-usage");
  executable(
    usage,
    "printf '%s' '{\"fiveHourPercent\":10,\"sevenDayPercent\":20}'",
  );
  return { root, setup, target, bin, usage };
}

describe("overnight loop", () => {
  it.each(["codex", "claude"])(
    "admits a %s loop with the shipped reader and no custom usage command",
    (provider) => {
      const fx = fixture();
      const requestLog = join(fx.root, "usage-provider.txt");
      executable(
        join(fx.bin, "codexbar"),
        `printf '%s' "$3" > '${requestLog}'\nprintf '%s' '[{"provider":"${provider}","usage":{"updatedAt":"${new Date().toISOString()}","primary":{"usedPercent":10}}}]'`,
      );
      executable(
        join(fx.bin, "curl"),
        `printf '%s' '{"data":{"issues":{"nodes":[]}}}'`,
      );
      const result = spawnSync(
        "/bin/bash",
        [
          loop,
          "--linear-project",
          "test",
          "--target-dir",
          fx.target,
          "--provider",
          provider,
          "--fallback",
          "none",
          "--dry-run",
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            PATH: `${fx.bin}:${process.env.PATH}`,
            BS_PROVIDER_PRIMARY: provider,
            BS_PROVIDER_FALLBACK: "none",
            CLAUDE_USAGE_COMMAND: "",
            CURL_BIN: join(fx.bin, "curl"),
            LINEAR_API_KEY: "test-token",
            XDG_STATE_HOME: join(fx.root, "state"),
            TMPDIR: fx.root,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("reason=backlog-drained");
      expect(readFileSync(requestLog, "utf8")).toBe(provider);
    },
  );

  it.each([
    { providerExit: 76, expired: false, reason: "agent-deadline", attempts: 1 },
    {
      providerExit: 124,
      expired: false,
      reason: "agent-deadline",
      attempts: 1,
    },
    {
      providerExit: 75,
      expired: false,
      reason: "limit-reset-past-deadline",
      attempts: 1,
    },
    { providerExit: 91, expired: true, reason: "max-hours", attempts: 0 },
  ])(
    "fails unfinished work with $reason (provider $providerExit)",
    ({ providerExit, expired, reason, attempts }) => {
      const fx = fixture();
      const stateDir = join(fx.root, "state");
      const copiedLoop = join(fx.setup, "scripts/overnight-loop.sh");
      copyFileSync(loop, copiedLoop);
      executable(
        join(fx.setup, "scripts/provider-run.sh"),
        `exit ${providerExit}`,
      );
      executable(join(fx.bin, "ccusage"), "exit 1");
      if (expired) {
        executable(
          join(fx.bin, "date"),
          `
        if [ "$1" != +%s ]; then exec /bin/date "$@"; fi
        count=0
        [ ! -f '${fx.root}/clock-count' ] || read -r count < '${fx.root}/clock-count'
        count=$((count + 1))
        printf '%s' "$count" > '${fx.root}/clock-count'
        if [ "$count" -le 2 ]; then echo 1000; else echo 5000; fi
      `,
        );
      }
      executable(
        join(fx.bin, "curl"),
        `
      case "$*" in
        *'query($identifier:'*) printf '%s' '{"data":{"issue":{"identifier":"BUI-42","state":{"name":"Backlog"},"project":{"name":"claude-kit"}}}}' ;;
        *) printf '%s' '{"data":{"issues":{"nodes":[{"identifier":"BUI-42","priority":1,"project":{"name":"claude-kit"}}],"pageInfo":{"hasNextPage":false}}}}' ;;
      esac
    `,
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
      test_loop="$2"
      set -- --linear-project claude-kit --target-dir "$1" --max-hours 1
      OVERNIGHT_LOOP_LIB_ONLY=1 source "$test_loop"
      main
    `,
          "terminal-test",
          fx.target,
          copiedLoop,
        ],
        {
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            PATH: `${fx.bin}:${process.env.PATH}`,
            CURL_BIN: join(fx.bin, "curl"),
            CCUSAGE_BIN: join(fx.bin, "ccusage"),
            LINEAR_API_KEY: "fixture-token",
            CLAUDE_USAGE_COMMAND: fx.usage,
            FALLBACK_SLEEP_SECONDS: "7200",
            OVERNIGHT_LOOP_STATE_DIR: stateDir,
            XDG_STATE_HOME: join(fx.root, "admission"),
            TMPDIR: fx.root,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(
        JSON.parse(
          readFileSync(join(stateDir, "overnight-loop-status.json"), "utf8"),
        ),
      ).toMatchObject({
        currentIssue: "BUI-42",
        terminalReason: reason,
        exitStatus: 1,
        itemsMerged: 0,
        attempts,
      });
    },
  );

  it("requires an explicit Linear project", () => {
    const result = spawnSync("bash", [loop, "--dry-run"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--linear-project is required");
  });

  it("hands every fresh Ralph child explicit compute facts", () => {
    const source = readFileSync(loop, "utf8");
    expect(source).toContain('--phase-request "$execution_facts_file"');
    expect(source).toContain("--caller overnight-ralph");
    expect(source).toContain('if [ "$PROVIDER" = codex ]');
    expect(source).toContain('[ -z "$PROVIDER" ] || provider_args+=');
    expect(source).toContain('[ -z "$PROVIDER_FALLBACK" ] || provider_args+=');
    expect(source).toContain('--output-dir "$provider_output_dir"');
    expect(source).toContain('"phase":"implement"');
    expect(source).toContain('"targetedProof":false');
    expect(source).toContain('"caller":"overnight-ralph"');
  });

  it("keeps default governed evidence outside the target worktree", () => {
    const fx = fixture();
    const stateHome = join(fx.root, "state");
    const command = `set -- --linear-project claude-setup --target-dir '${fx.target}'; OVERNIGHT_LOOP_LIB_ONLY=1 source '${loop}'; printf '%s\n' "$LOG_DIR"`;
    const logDir = execFileSync("bash", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_REPO: fx.setup,
        XDG_STATE_HOME: stateHome,
      },
    }).trim();
    expect(logDir).toMatch(
      new RegExp(`^${stateHome}/buildproven/overnight-loop/[0-9a-f]{16}$`),
    );
    expect(logDir.startsWith(`${fx.target}/`)).toBe(false);
  });

  it("hard-stops a whole command at its deadline", () => {
    const start = Date.now();
    const result = spawnSync(
      "python3",
      [deadline, "--timeout-seconds", "1", "--", "sleep", "30"],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(124);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.stderr).toContain("deadline exceeded");
  });

  it("dry-runs only the requested project's exact next item", () => {
    const fx = fixture();
    const requestLog = join(fx.root, "curl-request.txt");
    executable(
      join(fx.bin, "curl"),
      `printf '%s\\n' "$*" > '${requestLog}'\nprintf '%s' '{"data":{"issues":{"nodes":[{"identifier":"BUI-42","priority":1,"createdAt":"2026-01-01","project":{"name":"claude-setup"}},{"identifier":"OTHER-1","priority":1,"createdAt":"2025-01-01","project":{"name":"other"}}]}}}'`,
    );
    const result = spawnSync(
      "bash",
      [
        loop,
        "--linear-project",
        "claude-setup",
        "--target-dir",
        fx.target,
        "--dry-run",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SETUP_REPO: fx.setup,
          CURL_BIN: join(fx.bin, "curl"),
          LINEAR_API_KEY: "test-token",
          CLAUDE_USAGE_COMMAND: fx.usage,
          TMPDIR: fx.root,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("next issue=BUI-42");
    expect(result.stdout).toContain("reason=dry-run");
    expect(result.stderr).not.toContain("claude-must-not-run");
    expect(
      execFileSync(
        "grep",
        ["-o", '\\"project\\": \\"claude-setup\\"', requestLog],
        { encoding: "utf8" },
      ),
    ).toContain("claude-setup");
  });

  it("attributes completion to exactly one reviewed commit for the selected issue", () => {
    const fx = fixture();
    const before = execFileSync("git", ["rev-parse", "main"], {
      cwd: fx.target,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(fx.target, "result.txt"), "done\n");
    execFileSync("git", ["add", "result.txt"], { cwd: fx.target });
    execFileSync(
      "git",
      [
        "commit",
        "-m",
        "fix: complete BUI-42",
        "-m",
        "Reviewed-By: codex (status=approve)",
      ],
      { cwd: fx.target },
    );
    const receipt = execFileSync("git", ["rev-parse", "main"], {
      cwd: fx.target,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(fx.target, "unrelated.txt"), "other\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: fx.target });
    execFileSync("git", ["commit", "-m", "chore: unrelated concurrent merge"], {
      cwd: fx.target,
    });
    const after = execFileSync("git", ["rev-parse", "main"], {
      cwd: fx.target,
      encoding: "utf8",
    }).trim();
    const sourceAndCall = `issue_arg="$1"; set -- --linear-project claude-setup --target-dir '${fx.target}'; OVERNIGHT_LOOP_LIB_ONLY=1 source '${loop}'; issue_receipt '${before}' '${after}' "$issue_arg"`;

    expect(
      execFileSync("bash", ["-c", sourceAndCall, "receipt-test", "BUI-42"], {
        encoding: "utf8",
        env: { ...process.env, SETUP_REPO: fx.setup },
      }).trim(),
    ).toBe(receipt);
    const mismatch = spawnSync(
      "bash",
      ["-c", sourceAndCall, "receipt-test", "BUI-4"],
      {
        encoding: "utf8",
        env: { ...process.env, SETUP_REPO: fx.setup },
      },
    );
    expect(mismatch.status).not.toBe(0);
  }, 15000);
});
