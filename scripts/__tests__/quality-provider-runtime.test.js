import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import reviewEvidence from "../quality-review-evidence.js";
import { makeTempDir } from "./helpers/tmp.js";

const { signEvidence } = reviewEvidence;

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PLAN = path.join(ROOT, "scripts", "quality-review-plan.sh");
const BOUNDED = path.join(ROOT, "scripts", "quality-run-bounded.sh");
const LOAD_ROOT = path.join(ROOT, "scripts", "quality-load-root.sh");
const VALIDATOR = path.join(
  ROOT,
  "scripts",
  "quality-validate-review-trailers.sh",
);
const RUN_REVIEW = path.join(ROOT, "scripts", "quality-run-review.sh");
const PRESERVE_PRIMARY = path.join(
  ROOT,
  "scripts",
  "quality-preserve-primary-evidence.sh",
);
const NORMALIZE_CODEX_REVIEW = path.join(
  ROOT,
  "scripts",
  "quality-normalize-codex-review.sh",
);
const NORMALIZE_GEMINI_REVIEW = path.join(
  ROOT,
  "scripts",
  "quality-normalize-gemini-review.js",
);

function processStart(pid) {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
}

async function expectProcessToStop(
  pid,
  timeoutMs = 2000,
  expectedStart = processStart(pid),
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const state = probe.stdout.trim();
    // An exited detached child can remain a zombie until the runner's init
    // process reaps it. It cannot execute or survive the bounded cleanup.
    if (
      !state ||
      state.startsWith("Z") ||
      processStart(pid) !== expectedStart
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`process ${pid} remained alive after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function runWithLivenessDeadline(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process can exit between the deadline and the signal.
      }
      reject(
        new Error(
          `${command} exceeded its ${timeoutMs}ms cancellation liveness deadline`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("provider review runtime", () => {
  it("documents the exact Quality-* schema emitted by the runtime", () => {
    const skill = readFileSync(
      path.join(ROOT, "skills", "quality", "SKILL.md"),
      "utf8",
    );
    const runtime = readFileSync(
      path.join(ROOT, "scripts", "quality-invocation.js"),
      "utf8",
    );
    const keys = [
      "Tier",
      "Reviewer",
      "Primary",
      "Fallback",
      "Findings",
      "Head",
      "Base",
    ];
    for (const key of keys) {
      expect(skill).toMatch(new RegExp(`^Quality-${key}:`, "m"));
      expect(runtime).toContain(`Quality-${key}:`);
    }
    expect(skill).toMatch(/parenthetical[\s\S]*legacy/i);
  });

  it.each([
    ["low", "120", "Focused"],
    ["medium", "480", "Broad"],
    ["high", "900", "Deep adversarial"],
    ["critical", "900", "release-veto"],
  ])("maps %s to a mechanical review plan", (tier, timeout, focus) => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `TIER="$1"; source "$2"; printf '%s|%s' "$QUALITY_REVIEW_TIMEOUT" "$QUALITY_REVIEW_FOCUS"`,
        "plan",
        tier,
        PLAN,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${timeout}|`);
    expect(result.stdout).toContain(focus);
  });

  it("kills a hanging provider and a session-escaped helper at the wall-clock cap", async () => {
    const directory = makeTempDir("bounded-tree-");
    const pidFile = path.join(directory, "native-helper.pid");
    const result = spawnSync(
      "/bin/bash",
      [
        BOUNDED,
        "--timeout",
        // One second made Python startup itself the assertion under parallel
        // full-suite load. Three seconds still exercises the hard wall clock
        // while giving the session-escaped helper time to publish its PID.
        "3",
        "--",
        "/bin/bash",
        "-c",
        'python3 -c \'import os,signal,sys,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(20)\' "$1" & wait',
        "provider",
        pidFile,
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    const helperPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isSafeInteger(helperPid)).toBe(true);
    await expectProcessToStop(helperPid);
  });

  it("reaps a detached helper when the provider leader exits early", async () => {
    const directory = makeTempDir("bounded-orphan-");
    const pidFile = path.join(directory, "detached-helper.pid");
    const unrelated = spawn("sleep", ["20"], { stdio: "ignore" });
    let helperPid = null;
    try {
      const result = spawnSync(
        BOUNDED,
        [
          "--timeout",
          "20",
          "--",
          "/bin/bash",
          "-c",
          '( sleep 0.05; python3 -c \'import os,signal,sys,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(20)\' "$1" </dev/null >/dev/null 2>&1 & ) & for _ in $(seq 1 100); do [ -s "$1" ] && exit 0; sleep 0.01; done; exit 1',
          "provider",
          pidFile,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("BS_QUALITY_PROCESS_OWNER");
      expect(result.stderr).not.toContain("BS_QUALITY_PROCESS_OWNER");
      helperPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isSafeInteger(helperPid)).toBe(true);
      await expectProcessToStop(helperPid);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      if (Number.isSafeInteger(helperPid)) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // The assertion above is the contract; cleanup is best effort.
        }
      }
      unrelated.kill("SIGKILL");
    }
  });

  it("reaps an immediate fork-and-setsid orphan after its provider parent exits", async () => {
    const directory = makeTempDir("bounded-immediate-orphan-");
    const pidFile = path.join(directory, "detached-helper.pid");
    const unrelated = spawn("sleep", ["20"], { stdio: "ignore" });
    let helperPid = null;
    try {
      const result = spawnSync(
        BOUNDED,
        [
          "--timeout",
          "20",
          "--",
          "python3",
          "-c",
          'import os,signal,sys,time; pid=os.fork(); sys.exit(0) if pid else None; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(20)',
          pidFile,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("BS_QUALITY_PROCESS_OWNER");
      expect(result.stderr).not.toContain("BS_QUALITY_PROCESS_OWNER");
      helperPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isSafeInteger(helperPid)).toBe(true);
      await expectProcessToStop(helperPid);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      if (Number.isSafeInteger(helperPid)) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // The assertion above is the contract; cleanup is best effort.
        }
      }
      unrelated.kill("SIGKILL");
    }
  });

  it("reaps the watchdog promptly after a successful command", () => {
    const started = Date.now();
    const result = spawnSync(
      "bash",
      [BOUNDED, "--timeout", "20", "--", "bash", "-c", "exit 0"],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("reports an external signal after bounded cleanup", async () => {
    const directory = makeTempDir("bounded-signal-");
    const readyFile = path.join(directory, "ready");
    const runner = spawn(
      "bash",
      [
        BOUNDED,
        "--timeout",
        "20",
        "--",
        "bash",
        "-c",
        'printf ready > "$1"; sleep 20',
        "provider",
        readyFile,
      ],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 20 && !existsSync(readyFile); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(readyFile)).toBe(true);
    runner.kill("SIGTERM");
    const result = await new Promise((resolve) => {
      runner.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Node reports a shell terminated by SIGTERM as either the conventional
    // 128+signal exit code or the raw signal, depending on the host runner.
    expect(result.signal === "SIGTERM" ? 143 : result.code).toBe(143);
  });

  it("uses the Darwin sleep assertion and preserves command failures", () => {
    const source = readFileSync(BOUNDED, "utf8");
    expect(source).toContain('if [ "$(uname -s)" = Darwin ]');
    expect(source).toContain('/usr/bin/caffeinate -i "$@"');
    expect(source).toContain(
      "quality-run-bounded: /usr/bin/caffeinate is required on Darwin",
    );
    const result = spawnSync(
      "bash",
      [BOUNDED, "--timeout", "20", "--", "bash", "-c", "exit 37"],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(37);
  });

  it("exercises caffeinate through the public command seam on Darwin", () => {
    const platform = spawnSync("uname", ["-s"], { encoding: "utf8" });
    if (platform.stdout.trim() !== "Darwin") return;
    const result = spawnSync(
      "bash",
      [BOUNDED, "--timeout", "20", "--", "bash", "-c", "exit 29"],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(29);
  });

  it("throttles detached-provider tree snapshots and avoids duplicate writes", () => {
    const source = readFileSync(BOUNDED, "utf8");
    expect(source).toContain('local last_snapshot="" snapshot');
    expect(source).toContain('if [ "$snapshot" != "$last_snapshot" ]');
    expect(source).toContain("sleep 0.25");
    expect(source).not.toContain("sleep 0.01");
  });

  it("honors scorer-selected independent Codex rounds", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `TIER=critical CODEX_DEPTH=xhigh CODEX_ROUNDS=2; source "$1"; printf '%s|%s' "$QUALITY_REVIEW_DEPTH" "$QUALITY_REVIEW_PASSES"`,
        "plan",
        PLAN,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("xhigh|2");
  });

  it("maps the critical risk tier to a supported Codex reasoning effort", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `TIER=critical; source "$1"; printf '%s' "$QUALITY_REVIEW_DEPTH"`,
        "plan",
        PLAN,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("high");
  });

  it("loads persisted risk state at the runner boundary", () => {
    const plan = readFileSync(PLAN, "utf8");
    const runner = readFileSync(RUN_REVIEW, "utf8");
    const riskLoad = 'TIER="$(field risk.tier)"';
    const planLoad = 'source "$SCRIPT_DIR/quality-review-plan.sh"';

    expect(plan).not.toContain("riskstate.env");
    expect(runner).not.toContain("riskstate.env");
    expect(runner).toContain(riskLoad);
    expect(runner.indexOf(riskLoad)).toBeLessThan(runner.indexOf(planLoad));
  });

  it("gives mandatory fix validation its persisted provider allowance", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    const invocation = readFileSync(
      path.join(ROOT, "scripts", "quality-invocation.js"),
      "utf8",
    );

    expect(runner).toContain(
      'QUALITY_REVIEW_TIMEOUT="$(field risk.runtime.reviewReserveSeconds)"',
    );
    expect(runner).toContain(
      '[ -n "$QUALITY_REVIEW_TIMEOUT" ] || QUALITY_REVIEW_TIMEOUT=300',
    );
    expect(invocation).toMatch(
      /manifest\.reviews\.length === 0[\s\S]*risk\?\.runtime\?\.reviewSeconds[\s\S]*risk\?\.runtime\?\.reviewReserveSeconds \?\? 300/,
    );
  });

  it("uses native structured Claude output without a malformed-output retry loop", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    const companion = readFileSync(
      path.resolve(ROOT, "scripts", "claude-review-companion.sh"),
      "utf8",
    );
    expect(runner).not.toContain("claude_marker_only_result()");
    expect(runner).not.toContain("marker-only finding; retrying once");
    expect(companion).toContain('--json-schema "$REVIEW_SCHEMA_JSON"');
    expect(companion).toContain(".structured_output");
    expect(companion).toContain('del(."$schema")');
    expect(companion).not.toContain('category: "marker-only-findings"');
  });

  it("routes Claude cancellation through the shared bounded supervisor", () => {
    const companion = readFileSync(
      path.resolve(ROOT, "scripts", "claude-review-companion.sh"),
      "utf8",
    );
    const bounded = readFileSync(BOUNDED, "utf8");
    expect(companion).toContain("quality-run-bounded.sh");
    expect(companion).toContain('--cancel-file "$CANCEL_FILE"');
    expect(bounded).toContain('--cancel-file) CANCEL_FILE="$2"');
    expect(bounded).toContain('"$CANCEL_FILE" ] && [ -f "$CANCEL_FILE"');
  });

  it("routes every caller-built provider prompt through the review-input artifact", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    const companion = readFileSync(
      path.resolve(ROOT, "scripts", "claude-review-companion.sh"),
      "utf8",
    );

    expect(runner).toContain('--prompt-file "$REVIEW_OUT/review-prompt.txt"');
    expect(
      runner.match(/cat "\$REVIEW_OUT\/review-prompt\.txt"/g),
    ).toHaveLength(2);
    expect(runner).toContain('cat "$schema"');
    expect(runner).toContain(
      "trusted JSON Schema definition for validation, not the response instance",
    );
    expect(companion).toContain(
      'CTX_FILE="${PROMPT_FILE:-$OUT_DIR/review-context.txt}"',
    );
    expect(companion).toContain('node "$SCRIPT_DIR/quality-review-input.js"');
    expect(companion).not.toContain('cat "$DIFF_FILE"');
  });

  it("includes recursive core changes in the immutable review envelope", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    expect(runner).toContain('git ls-tree "$REVIEW_DIFF_BASE" -- core');
    expect(runner).toContain('git ls-tree "$REVIEWED_HEAD" -- core');
    expect(runner).toContain('"160000" && $2 == "commit"');
    expect(runner).toContain("git -C core diff --submodule=diff");
    expect(runner).toContain(
      "quality-run-review: head core commit is unavailable for recursive review",
    );
  });

  it("fails over when Codex cannot refresh an MCP OAuth token", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    expect(runner).toContain("OAuth token refresh failed:.*invalid_grant");
    expect(runner).toContain("return 2");
  });

  it("rechecks cached provider failures and uses fallback only after primary failure", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    expect(runner).toContain("provider_live_probe()");
    expect(runner).toContain(
      "cached provider-health failure; probing live availability",
    );
    expect(runner).toContain("claude auth status --json");
    expect(runner).toContain("codex login status 2>&1");
    expect(runner).toContain("fallback is an availability path");
    expect(runner).not.toMatch(/REVIEW_PROVIDER[^\n]*!= claude/);
  });

  it("isolates Codex review cache state before probing provider health", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    expect(runner).toContain(
      'QUALITY_CODEX_SOURCE_HOME="${QUALITY_CODEX_SOURCE_HOME:-${CODEX_HOME:-$HOME/.codex}}"',
    );
    expect(runner).toContain(
      'CODEX_HOME="$(bash "$SCRIPT_DIR/quality-codex-home.sh")"',
    );
    expect(runner.indexOf("quality-codex-home.sh")).toBeLessThan(
      runner.indexOf("quality-codex-cache-guard.sh"),
    );
  });

  it("kills the provider tree when the wrapper itself is cancelled", async () => {
    const dir = makeTempDir("bounded-cancel-");
    const pidFile = path.join(dir, "child.pid");
    const startFile = path.join(dir, "child.start");
    const script = `
"$1" --timeout 20 -- bash -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' child "$2" &
wrapper=$!
while [ ! -s "$2" ]; do sleep 0.05; done
child=$(cat "$2")
ps -o lstart= -p "$child" | sed 's/[[:space:]]*$//' > "$3"
kill -TERM "$wrapper"
wait "$wrapper" 2>/dev/null || true
`;
    const result = await runWithLivenessDeadline(
      "bash",
      ["-c", script, "cancel", BOUNDED, pidFile, startFile],
      10000,
    );
    expect(result.code, result.stderr).toBe(0);
    // Cancellation must wait for the wrapper's TERM/KILL escalation and the
    // runner's process reaper. A child that survives is an infinite loop, so
    // this remains a hard liveness bound rather than a timing exemption.
    await expectProcessToStop(
      Number(readFileSync(pidFile, "utf8").trim()),
      10000,
      readFileSync(startFile, "utf8").trim(),
    );
  });

  it("does not name active state by Claude or Codex session IDs", () => {
    const source = spawnSync("cat", [LOAD_ROOT], { encoding: "utf8" }).stdout;
    expect(source).not.toMatch(/CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID/);
    expect(source).toMatch(/--manifest is required/);
  });

  it("requires the explicit manifest instead of ambient shell state", () => {
    const source = readFileSync(LOAD_ROOT, "utf8");
    expect(source).toMatch(/--manifest/);
    expect(source).toMatch(/quality-invocation\.js" locate/);
    expect(source).not.toMatch(/BS_QUALITY_ROOT_FILE|latest|find .*bs-quality/);
  });

  it("accepts exact evidence, then rejects later code and contradictions", () => {
    const repo = makeTempDir("review-evidence-");
    const setup = spawnSync(
      "bash",
      [
        "-c",
        `
git init -q -b main "$1"
cd "$1"
git config user.name test
git config user.email test@example.com
echo base > file; git add file; git commit -q -m base
base=$(git rev-parse HEAD)
git switch -q -c feature
echo change >> file; git commit -qam change
reviewed=$(git rev-parse HEAD)
git commit -q --allow-empty -m "chore: stamp

Reviewed-By: quality
Reviewed-By: codex
Quality-Tier: high
Quality-Reviewer: codex
Quality-Primary: codex
Quality-Fallback: claude
Quality-Findings: 0
Quality-Head: $reviewed
Quality-Base: $base"
`,
        "setup",
        repo,
      ],
      { encoding: "utf8" },
    );
    expect(setup.status).toBe(0);
    expect(spawnSync("bash", [VALIDATOR, "main"], { cwd: repo }).status).toBe(
      0,
    );

    spawnSync("bash", ["-c", "echo later >> file; git commit -qam later"], {
      cwd: repo,
    });
    expect(
      spawnSync("bash", [VALIDATOR, "main"], { cwd: repo }).status,
    ).not.toBe(0);

    spawnSync("git", ["reset", "--hard", "HEAD~2"], { cwd: repo });
    const reviewed = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const base = spawnSync("git", ["merge-base", "HEAD", "main"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const malicious = `code-bearing stamp

Reviewed-By: quality
Reviewed-By: codex
Quality-Tier: high
Quality-Reviewer: codex
Quality-Primary: codex
Quality-Fallback: claude
Quality-Findings: 0
Quality-Head: ${reviewed}
Quality-Base: ${base}`;
    spawnSync("bash", ["-c", "echo unreviewed >> file; git add file"], {
      cwd: repo,
    });
    spawnSync("git", ["commit", "-q", "-m", malicious], { cwd: repo });
    expect(
      spawnSync("bash", [VALIDATOR, "main"], { cwd: repo }).status,
    ).not.toBe(0);

    spawnSync("git", ["reset", "--hard", "HEAD~1"], { cwd: repo });
    const correct = malicious.replace("code-bearing stamp", "empty stamp");
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", correct], {
      cwd: repo,
    });
    const message = spawnSync("git", ["log", "-1", "--format=%B"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.concat("\nQuality-Findings: 9\n");
    spawnSync(
      "git",
      ["commit", "--amend", "--allow-empty", "-q", "-m", message],
      { cwd: repo },
    );
    expect(
      spawnSync("bash", [VALIDATOR, "main"], { cwd: repo }).status,
    ).not.toBe(0);
  }, 15000);

  it("accepts signed v2 fallback evidence at high tier", () => {
    const repo = makeTempDir("review-evidence-v2-fallback-");
    spawnSync(
      "bash",
      [
        "-c",
        `
git init -q -b main "$1"
cd "$1"
git config user.name test
git config user.email test@example.com
echo base > file; git add file; git commit -q -m base
git switch -q -c feature
echo change >> file; git commit -qam change
`,
        "setup",
        repo,
      ],
      { encoding: "utf8" },
    );
    const base = spawnSync("git", ["rev-parse", "main"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const reviewed = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const privateKey = keyPair.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64");
    const publicKey = keyPair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const fields = {
      head: reviewed,
      base,
      tier: "high",
      findings: 0,
      reviewer: "claude",
      primary: "codex",
      fallback: "claude",
      contractVersion: 2,
      leads: 0,
      reviewStatus: "complete",
      policyDigest: "1".repeat(64),
      agentsSha256: "2".repeat(64),
      domain: "reliability",
      selectionRule: "reliability-domain",
      repositoryKey: "test-repo",
      diffSha256: "3".repeat(64),
      evidenceSha256: "4".repeat(64),
    };
    const signature = signEvidence(fields, privateKey);
    const message = `chore: stamp

Reviewed-By: quality
Reviewed-By: claude
Quality-Tier: high
Quality-Reviewer: claude
Quality-Primary: codex
Quality-Fallback: claude
Quality-Findings: 0
Quality-Head: ${reviewed}
Quality-Base: ${base}
Quality-Contract: 2
Quality-Leads: 0
Quality-Review-Status: complete
Quality-Policy: ${fields.policyDigest}
Quality-Agents: ${fields.agentsSha256}
Quality-Domain: ${fields.domain}
Quality-Selection: ${fields.selectionRule}
Quality-Repository: ${fields.repositoryKey}
Quality-Diff: ${fields.diffSha256}
Quality-Review-Evidence: ${fields.evidenceSha256}
Quality-Evidence-Signature: ${signature}`;
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", message], {
      cwd: repo,
    });

    const result = spawnSync(
      "bash",
      [VALIDATOR, "--required-tier", "high", "--require-signature", "main"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY: publicKey,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("passes scorer effort and exact round count to Codex mechanically", () => {
    const source = spawnSync("cat", [RUN_REVIEW], { encoding: "utf8" }).stdout;
    const planSource = spawnSync("cat", [PLAN], { encoding: "utf8" }).stdout;
    const preservation = spawnSync("cat", [PRESERVE_PRIMARY], {
      encoding: "utf8",
    }).stdout;
    expect(source).toMatch(
      /while \[ "\$pass" -le "\$QUALITY_REVIEW_PASSES" \]/,
    );
    expect(source).toMatch(/model_reasoning_effort=.*QUALITY_REVIEW_DEPTH/);
    expect(source).toMatch(/--model "\$QUALITY_CODEX_MODEL"/);
    expect(planSource).toMatch(/QUALITY_CODEX_MODEL=gpt-5\.6-sol/);
    expect(source).toMatch(
      /codex exec --ephemeral --ignore-user-config --ignore-rules \\\n\s+--skip-git-repo-check -s read-only --json/,
    );
    const boundedCodexCalls = source.match(
      /bash "\$bounded" --timeout "\$pass_timeout" -- \\\n\s+codex exec/g,
    );
    expect(boundedCodexCalls).toHaveLength(1);
    expect(source).not.toMatch(
      /bash "\$bounded" --timeout "\$pass_timeout" -- \\\n\s*#/,
    );
    expect(source).toMatch(
      /optional[\s\S]*MCP configuration[\s\S]*unrelated, stale OAuth grants/i,
    );
    expect(source).toMatch(/-C "\$REVIEW_OUT"/);
    expect(source).not.toMatch(/review_selector=--base/);
    expect(source).not.toMatch(/review_selector=--commit/);
    expect(source).toMatch(/quality-review-input\.js/);
    expect(source).toMatch(
      /fixed envelope below is the sole repository-controlled review data/,
    );
    expect(source).toMatch(/Automated gates already passed/);
    expect(source).toMatch(/do not run commands or tests/);
    expect(source).toMatch(/cat "\$REVIEW_OUT\/review-prompt\.txt"/);
    expect(source).not.toMatch(/\$review_selector_value" -/);
    expect(source).toMatch(/Codex review passes must be 1 or 2/);
    expect(source).toMatch(/record_provider_exhaustion Codex/);
    expect(source).toMatch(/quality-provider-error\.js/);
    expect(source).not.toMatch(/provider_stderr_exhausted/);
    expect(source).not.toMatch(/provider_exhausted "\$raw_file"/);
    expect(source.indexOf('[ "$rc" -eq 124 ] && return 76')).toBeLessThan(
      source.indexOf('if node "$SCRIPT_DIR/quality-provider-error.js"'),
    );
    expect(preservation).toMatch(/"\$REVIEW_OUT"\/codex-\*\.json/);
    expect(preservation).toMatch(/"\$REVIEW_OUT"\/codex-\*\.progress/);
    expect(preservation).toMatch(/"\$REVIEW_OUT"\/codex-\*\.prompt/);
    expect(preservation).toMatch(/codex-\*\.normalized\.json/);
    expect(preservation).toMatch(/primary-\$preserve_pass\.result\.json/);
    // rc=76 (bounded-budget timeout without converging) is now CONFIGURABLE:
    // it fails over to the fallback when BS_QUALITY_FALLBACK_ON_TIMEOUT=1
    // (the default), gated so a degraded primary doesn't block a merge while a
    // healthy fallback sits idle (BUI-357). #104's strict single-clock bound is
    // preserved via BS_QUALITY_FALLBACK_ON_TIMEOUT=0. The fallback still runs at
    // most once — a fallback rc=76 hard-blocks below, so total review time is
    // bounded at two clocks, never unbounded.
    expect(source).toMatch(/BS_QUALITY_FALLBACK_ON_TIMEOUT/);
    expect(source).toMatch(
      /FALLBACK_ON_TIMEOUT="\$\{BS_QUALITY_FALLBACK_ON_TIMEOUT:-1\}"/,
    );
    expect(source).toMatch(
      /PROVIDER_RC" -eq 76 \] && \[ "\$FALLBACK_ON_TIMEOUT" = 1 \]/,
    );
    expect(source).toMatch(/PROVIDER_RC" -eq 78/);
    expect(source).toMatch(/provider-input-too-large/);
    expect(source).toMatch(
      /classify_structured_provider_failure codex "\$error_file"/,
    );
    expect(source).toMatch(
      /RETRY_STATE" = pending \].*INCOMPLETE_CATEGORY" != provider-input-too-large/s,
    );
  });

  it("runs Gemini through the same bounded, read-only provider contract", () => {
    const source = readFileSync(RUN_REVIEW, "utf8");
    expect(source).toMatch(/authorize_provider_attempt gemini/);
    expect(source).toMatch(/gemini --skip-trust --approval-mode plan/);
    expect(source).toMatch(/--output-format json/);
    expect(source).toMatch(/quality-normalize-gemini-review\.js/);
    expect(source).toMatch(/quality-run-bounded\.sh/);
    expect(source).toMatch(/classify_structured_provider_failure gemini/);
    expect(source).toMatch(/quality-provider-policy\.sh" \|\| exit 1/);
    expect(source).toMatch(/Never return JSON Schema definition keys/);
    expect(source).not.toMatch(/gemini[^\n]*(?:--yolo|approval-mode yolo)/);
    expect(readFileSync(NORMALIZE_GEMINI_REVIEW, "utf8")).toMatch(
      /normalizeStructuredReview/,
    );
  });

  it.each([
    ["root", (review) => review],
    ["legacy result envelope", (review) => ({ result: review })],
  ])("normalizes %s Codex structured output", (_label, wrap) => {
    const dir = makeTempDir("codex-review-output-");
    const input = path.join(dir, "input.json");
    const output = path.join(dir, "output.json");
    const review = {
      verdict: "approve",
      summary: "No actionable findings.",
      findings: [],
    };
    writeFileSync(input, JSON.stringify(wrap(review)));

    const result = spawnSync("bash", [NORMALIZE_CODEX_REVIEW, input, output], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(review);
  });

  it.each([
    ["missing fields", { verdict: "approve" }],
    ["unknown verdict", { verdict: "maybe", summary: "invalid", findings: [] }],
    [
      "needs-attention without an actionable finding",
      {
        verdict: "needs-attention",
        summary: "Manual review is required.",
        findings: [],
      },
    ],
    [
      "approve with an actionable finding",
      {
        verdict: "approve",
        summary: "Contradictory approval.",
        findings: [
          {
            severity: "high",
            title: "unexpected finding",
            body: "An approval cannot carry a release-blocking finding.",
            file: "file.js",
            line_start: 1,
            recommendation: "Use needs-attention.",
          },
        ],
      },
    ],
    [
      "invalid finding item",
      { verdict: "approve", summary: "invalid", findings: [false] },
    ],
    [
      "invalid finding line",
      {
        verdict: "needs-attention",
        summary: "invalid",
        findings: [
          {
            severity: "high",
            title: "bad line",
            body: "line_start must be positive",
            file: "file.js",
            line_start: 0,
            recommendation: "fix it",
          },
        ],
      },
    ],
  ])("rejects malformed Codex output: %s", (_label, review) => {
    const dir = makeTempDir("codex-review-invalid-");
    const input = path.join(dir, "input.json");
    const output = path.join(dir, "output.json");
    writeFileSync(input, JSON.stringify(review));

    expect(
      spawnSync("bash", [NORMALIZE_CODEX_REVIEW, input, output]).status,
    ).not.toBe(0);
  });

  it("pins the initial review diff to the branch merge-base", () => {
    const source = readFileSync(RUN_REVIEW, "utf8");
    expect(source).toMatch(/quality-invocation\.js" review-info/);
    expect(source).toMatch(
      /git diff "\$\{REVIEW_DIFF_BASE\}\.\.\$\{REVIEWED_HEAD\}"/,
    );
    expect(source).toMatch(/normalized Codex findings could not be rendered/);
  });

  it("revalidates the exact branch head after provider execution", () => {
    const source = readFileSync(RUN_REVIEW, "utf8");
    const record = source.indexOf('quality-invocation.js" record-review');
    expect(record).toBeGreaterThan(-1);
    expect(source).toContain("--validate-remote-head true");
    expect(
      readFileSync(path.join(ROOT, "scripts", "quality-invocation.js"), "utf8"),
    ).toMatch(/function assertReviewHeadCurrent[\s\S]*spawnSync\(\s*"gh"/);
    expect(
      readFileSync(path.join(ROOT, "scripts", "quality-invocation.js"), "utf8"),
    ).toMatch(
      /function recordAdvisoryReview\(manifest, options\) \{[\s\S]*?assertReviewHeadCurrent\(manifest\);/,
    );
    expect(
      readFileSync(path.join(ROOT, "scripts", "quality-invocation.js"), "utf8"),
    ).toMatch(/if \(manifest\.repo\.pr == null\) return;/);
  });

  it("runs Bash-only review entrypoints explicitly through Bash", () => {
    const runner = readFileSync(RUN_REVIEW, "utf8");
    const policy = readFileSync(
      path.join(ROOT, "scripts", "quality-provider-policy.sh"),
      "utf8",
    );
    expect(runner).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(runner).toMatch(/\$\{BASH_SOURCE\[0\]\}/);
    expect(policy).toMatch(/BASH_VERSION/);
    expect(policy).toMatch(/ZSH_VERSION/);
  });

  it.each(["parser-inconclusive", "evidence-absent"])(
    "preserves a completed earlier pass's normalized findings in --mode %s when a LATER pass fails",
    (mode) => {
      // Multi-pass Codex review: pass 1 completes with real findings, pass 2
      // fails for whatever reason (parser error -> parser-inconclusive;
      // exhaustion/timeout/unavailability -> evidence-absent). Either way,
      // pass 1's normalized result is authoritative and must not be
      // discarded as if the primary produced nothing.
      const dir = makeTempDir("preserve-primary-");
      writeFileSync(
        path.join(dir, "codex-1.normalized.json"),
        JSON.stringify({
          verdict: "needs-attention",
          summary: "pass 1 completed",
          findings: [{ severity: "high", title: "real finding" }],
        }),
      );
      writeFileSync(
        path.join(dir, "codex.findings.txt"),
        "INCONCLUSIVE: pass 2 failed\n",
      );

      const result = spawnSync("bash", [
        PRESERVE_PRIMARY,
        "--review-out",
        dir,
        "--mode",
        mode,
      ]);
      expect(result.status).toBe(0);

      const preserved = readFileSync(
        path.join(dir, "primary-codex-1.result.json"),
        "utf8",
      );
      expect(JSON.parse(preserved).findings).toHaveLength(1);
      expect(
        spawnSync("test", ["-e", path.join(dir, "codex-1.normalized.json")])
          .status,
      ).not.toBe(0);
    },
  );

  it.each(["parser-inconclusive", "evidence-absent"])(
    "preserves a completed Gemini pass's normalized findings in --mode %s (not just Codex)",
    (mode) => {
      // Same bug class as the Codex test above, but for Gemini: the
      // preservation loop only globbed codex-*.normalized.json, so a
      // completed Gemini pass got swept into failed-primary/ by the raw
      // artifact quarantine loop (gemini-*.json) instead of being preserved.
      const dir = makeTempDir("preserve-primary-gemini-");
      writeFileSync(
        path.join(dir, "gemini-1.normalized.json"),
        JSON.stringify({
          verdict: "needs-attention",
          summary: "gemini pass 1 completed",
          findings: [{ severity: "high", title: "real gemini finding" }],
        }),
      );
      writeFileSync(
        path.join(dir, "gemini.findings.txt"),
        "INCONCLUSIVE: pass 2 failed\n",
      );

      const result = spawnSync("bash", [
        PRESERVE_PRIMARY,
        "--review-out",
        dir,
        "--mode",
        mode,
      ]);
      expect(result.status).toBe(0);

      const preserved = readFileSync(
        path.join(dir, "primary-gemini-1.result.json"),
        "utf8",
      );
      expect(JSON.parse(preserved).findings).toHaveLength(1);
      expect(
        spawnSync("test", ["-e", path.join(dir, "gemini-1.normalized.json")])
          .status,
      ).not.toBe(0);
    },
  );
});
