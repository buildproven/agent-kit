import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROVIDER_RUN = path.join(ROOT, "scripts", "provider-run.sh");
const COMPUTE_GOVERNOR = path.join(ROOT, "scripts", "compute-governor.js");
const SKILL_SYNC = path.join(ROOT, "scripts", "setup-codex-skills.sh");
const MCP_SYNC = path.join(ROOT, "scripts", "mcp-sync.py");
const MCP_PARITY = path.join(ROOT, "scripts", "setup-mcp-parity.sh");
const MCP_CACHE = path.join(ROOT, "scripts", "mcp-parity-cache.py");
const AUDIT_REPO = path.join(ROOT, "scripts", "steward", "audit-repo.sh");
const STEWARD_ORCHESTRATE = path.join(
  ROOT,
  "scripts",
  "steward",
  "orchestrate.sh",
);
const DISCOVER = path.join(
  ROOT,
  "scripts",
  "steward",
  "discover-active-repos.py",
);
const SURFACE = path.join(ROOT, "scripts", "surface-audit.js");

function executable(file, body) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function governedPlan(facts, prompt, target) {
  return execFileSync(
    "node",
    [COMPUTE_GOVERNOR, "resolve-execution", "-", prompt, target],
    {
      input: JSON.stringify(facts),
      encoding: "utf8",
    },
  );
}

function initializeGovernedTarget(dir) {
  writeFileSync(
    path.join(dir, ".gitignore"),
    "bin/\noutput/\nplan.json\nfacts.json\ncodex.calls\nclaude.calls\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "tests@buildproven.local"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "BuildProven Tests"], {
    cwd: dir,
  });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
}

describe("provider-native platform", () => {
  it("keeps legacy codex execution on its existing sandbox contract", () => {
    const source = readFileSync(PROVIDER_RUN, "utf8");
    const invocation = source
      .split("\n")
      .find((line) => line.includes('CODEX_COMMAND[@]}" exec --ephemeral'));
    expect(invocation).toBeTruthy();
    // `codex exec` dropped -a/--ask-for-approval; approvals are governed by -s
    // <sandbox>. Passing -a makes codex exit rc=2 ("unexpected argument"),
    // which is not in provider-run's 74/75/76 fallback set, so the whole run
    // hard-fails instead of degrading to the fallback provider.
    expect(invocation).not.toMatch(/\s-a\s/);
    expect(invocation).not.toMatch(/--ask-for-approval/);
    expect(invocation).toMatch(/-s "\$SANDBOX"/);
  });

  it("starts Claude provider work without resuming a parent transcript", () => {
    const source = readFileSync(PROVIDER_RUN, "utf8");
    const invocation = source
      .split("\n")
      .find((line) => line.includes('claude -p "$(cat "$PROMPT_FILE")"'));
    expect(invocation).toContain("--no-session-persistence");
    expect(invocation).not.toContain("--resume");
    expect(invocation).not.toContain("--continue");
    expect(invocation).not.toContain("--fork-session");
  });

  it("routes cross-review through provider-run without a same-model fallback", () => {
    const skill = readFileSync(
      path.join(ROOT, "skills", "cross-review", "SKILL.md"),
      "utf8",
    );
    // The point of a cross-review is that the reviewer is a DIFFERENT model
    // than the author. `--fallback none` is load-bearing: with a fallback, an
    // exhausted counterpart silently degrades to the authoring provider and
    // returns same-model agreement that reads as independent corroboration
    // (BUI-468, from the Codex side).
    expect(skill).toContain("--fallback none");
    expect(skill).toContain("--sandbox read-only");
    expect(skill).toContain('--phase-request "$EXECUTION_FACTS"');
    expect(skill).toContain("--caller cross-review");
    expect(skill).toContain('--execution-facts "$EXECUTION_FACTS"');
    expect(skill).toContain("provider-run.sh");
    // Must not bypass the runner: a direct CLI shell-out loses the deadline,
    // the structured error classification, and the 74/75/76 exit contract.
    expect(skill).not.toMatch(/^\s*claude -p /m);
    expect(skill).not.toMatch(/^\s*codex exec /m);
    // A failed cross-review must say no second opinion happened, never
    // silently substitute a self-review.
    expect(skill).toMatch(/no cross-review happened/i);
  });

  it("never selects the reviewing provider with --provider auto", () => {
    const skill = readFileSync(
      path.join(ROOT, "skills", "cross-review", "SKILL.md"),
      "utf8",
    );
    // `bs_provider_invoker` reports WHICH PROVIDER IS RUNNING, not the
    // counterpart. `--provider auto` from a Codex session therefore picks
    // codex to review codex's own output — verified end-to-end: with
    // CODEX_THREAD_ID set, auto resolved to codex and never invoked the stub
    // claude on PATH. The run SUCCEEDS, so the same-model review is silent.
    // Assert on the INVOCATION line, not the prose — the skill deliberately
    // mentions `--provider auto` when explaining why it must not be used, so a
    // whole-file match would flag the warning that prevents the bug.
    // Match only shell continuation lines (trailing `\`), which excludes both
    // the prose warning and the `--provider claude|codex|auto` usage string.
    const invocation = skill
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("--provider") && line.endsWith("\\"));
    expect(invocation).toEqual(["--provider codex \\", "--provider claude \\"]);
    // The inversion must be present and explicit.
    expect(skill).toMatch(/codex\)\s+REVIEWER=claude/);
    expect(skill).toMatch(/claude\)\s+REVIEWER=codex/);
  });

  it("reports Codex->Claude delegation health, not just the outbound direction", () => {
    const check = readFileSync(
      path.join(ROOT, "scripts", "codex-check.sh"),
      "utf8",
    );
    // Without this the health check reports a green surface while Codex has no
    // path to Claude at all.
    expect(check).toMatch(/command -v claude/);
    // Manifest lines are `name|target`; anchoring the pipe stops `cross-review`
    // from matching a longer skill name that merely starts with it.
    expect(check).toContain("'^cross-review|'");
  });

  it("exposes cross-review to Codex, where the reverse path is actually needed", () => {
    const allowlist = JSON.parse(
      readFileSync(path.join(ROOT, "config", "codex-skills.json"), "utf8"),
    );
    expect(allowlist.skills).toContain("cross-review");
  });

  it("keeps cc:update-claudemd bounded and avoids no-op commits", () => {
    const command = readFileSync(
      path.join(ROOT, "commands", "cc", "update-claudemd.md"),
      "utf8",
    );
    expect(command).toContain("wc -l CLAUDE.md");
    expect(command).toMatch(/\*\*at most \+10 lines\*\*/);
    expect(command).toMatch(
      /make no\s+edit and do not create an empty documentation commit/i,
    );
    expect(command).toMatch(/replace, consolidate, or remove/i);
    expect(command).toContain("if git diff --quiet -- CLAUDE.md; then");
    expect(command).toMatch(
      /No stable CLAUDE\.md update; nothing to commit\.[\s\S]*else[\s\S]*git add CLAUDE\.md[\s\S]*git commit/,
    );
  });

  it("classifies every Claude skill and keeps Ralph discoverable", () => {
    const settings = JSON.parse(
      readFileSync(path.join(ROOT, "config", "settings.json"), "utf8"),
    );
    const names = readdirSync(path.join(ROOT, "skills"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(settings.skillOverrides).sort()).toEqual(names);
    expect(settings.skillOverrides.ralph).toBe("on");
    for (const skill of ["ralph", "quality"]) {
      expect(
        readFileSync(path.join(ROOT, "skills", skill, "SKILL.md"), "utf8"),
      ).not.toMatch(/^context: fork$/m);
    }
    expect(settings.hooks.PreCompact).toBeUndefined();
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it("falls back immediately on a structured quota error event (BUI-325)", () => {
    const dir = makeTempDir("provider-native-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    mkdirSync(bin);
    writeFileSync(prompt, "review this\n");
    // Real codex --json emits a typed error EVENT on stdout, not free text;
    // classification must key off that structured envelope, not a grep of
    // the transcript.
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "final answer text" > "$last_message"',
        'echo \'{"type":"error","message":"You\\u0027ve hit your usage limit. Purchase more credits or try again at Jul 25th, 2026 10:57 AM."}\'',
        "exit 1",
      ].join("\n"),
    );
    executable(
      path.join(bin, "claude"),
      'echo \'{"is_error":false,"result":"claude fallback completed"}\'',
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--specialized-exemption",
        "strategy-ensemble",
        "--target-dir",
        dir,
        "--provider",
        "codex",
        "--fallback",
        "claude",
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("codex exhausted");
    expect(result.stderr).toContain("trying claude");
    expect(result.stdout).toContain("claude fallback completed");
    expect(readFileSync(path.join(output, "provider"), "utf8").trim()).toBe(
      "claude",
    );
  });

  it("does not classify incidental exhaustion-marker text in the transcript as exhaustion (BUI-325)", () => {
    const dir = makeTempDir("provider-native-fp-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    mkdirSync(bin);
    writeFileSync(prompt, "review this\n");
    // A successful codex run whose transcript (tool output / agent message)
    // happens to mention "429" and "weekly usage limits" — e.g. because the
    // agent read this repo's own quality docs — must NOT be classified as
    // exhausted. Only a typed error event on a failed run may do that.
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "Docs mention HTTP 429 and weekly usage limits; nothing wrong here." > "$last_message"',
        'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"HTTP 429 weekly usage limits quota exhausted rate limit"}}\'',
        "exit 0",
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--specialized-exemption",
        "strategy-ensemble",
        "--target-dir",
        dir,
        "--provider",
        "codex",
        "--fallback",
        "none",
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("exhausted");
    expect(result.stdout).toContain(
      "Docs mention HTTP 429 and weekly usage limits",
    );
    expect(readFileSync(path.join(output, "provider"), "utf8").trim()).toBe(
      "codex",
    );
  });

  it("classifies claude exhaustion from a status-0 error envelope (BUI-325)", () => {
    const dir = makeTempDir("provider-native-claude-exh-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    mkdirSync(bin);
    writeFileSync(prompt, "review this\n");
    // Some provider CLIs report is_error inside a status-0 JSON envelope
    // rather than a nonzero exit code. The claude branch must classify from
    // that structured envelope even when rc=0, not just from rc alone.
    executable(
      path.join(bin, "claude"),
      [
        'echo \'{"is_error":true,"result":"You have hit your usage limit. Try again at Jul 25th, 2026 10:57 AM."}\'',
        "exit 0",
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--specialized-exemption",
        "strategy-ensemble",
        "--target-dir",
        dir,
        "--provider",
        "claude",
        "--fallback",
        "none",
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("claude exhausted");
  });

  it("runs Claude without model overrides on Bash 3.2 (BUI-777)", () => {
    const dir = makeTempDir("provider-native-claude-ok-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    mkdirSync(bin);
    writeFileSync(prompt, "review this\n");
    executable(
      path.join(bin, "claude"),
      'echo \'{"is_error":false,"result":"claude completed cleanly"}\'',
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--specialized-exemption",
        "strategy-ensemble",
        "--target-dir",
        dir,
        "--provider",
        "claude",
        "--fallback",
        "none",
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.stderr).not.toContain("exhausted");
    expect(result.stdout).toContain("claude completed cleanly");
    expect(readFileSync(path.join(output, "provider"), "utf8").trim()).toBe(
      "claude",
    );
  });

  it("installs only allowlisted native Codex skills and detects drift", () => {
    const dir = makeTempDir("codex-skills-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    mkdirSync(path.join(source, "skip"), { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# Keep\n");
    writeFileSync(path.join(source, "skip", "SKILL.md"), "# Skip\n");
    const allowlist = path.join(dir, "allowlist.json");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');

    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      source,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);
    expect(readlinkSync(path.join(target, "keep"))).toBe(
      path.join(source, "keep"),
    );
    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
        "--check",
      ]).status,
    ).toBe(0);

    unlinkSync(path.join(target, "keep"));
    symlinkSync(path.join(source, "skip"), path.join(target, "keep"));
    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
        "--check",
      ]).status,
    ).toBe(1);
  });

  it("keeps Codex skill check mode read-only", () => {
    const dir = makeTempDir("codex-skills-check-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "missing-target");
    const allowlist = path.join(dir, "allowlist.json");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# Keep\n");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
        "--check",
      ]).status,
    ).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it("removes only stale skills owned by the previous managed manifest", () => {
    const dir = makeTempDir("codex-skill-prune-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    mkdirSync(path.join(source, "drop"), { recursive: true });
    mkdirSync(path.join(source, "unmanaged"), { recursive: true });
    for (const name of ["keep", "drop", "unmanaged"]) {
      writeFileSync(path.join(source, name, "SKILL.md"), `# ${name}\n`);
    }
    const allowlist = path.join(dir, "allowlist.json");
    writeFileSync(allowlist, '{"skills":["keep","drop"]}\n');

    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      source,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);
    symlinkSync(path.join(source, "unmanaged"), path.join(target, "unmanaged"));
    writeFileSync(allowlist, '{"skills":["keep"]}\n');

    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      source,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);

    expect(readlinkSync(path.join(target, "keep"))).toBe(
      path.join(source, "keep"),
    );
    expect(() => readlinkSync(path.join(target, "drop"))).toThrow();
    expect(readlinkSync(path.join(target, "unmanaged"))).toBe(
      path.join(source, "unmanaged"),
    );
  });

  it("rejects invalid allowlists without pruning managed skills", () => {
    const dir = makeTempDir("codex-skill-invalid-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# keep\n");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');

    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      source,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);
    writeFileSync(allowlist, "not json\n");

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
      ]).status,
    ).toBe(1);
    expect(readlinkSync(path.join(target, "keep"))).toBe(
      path.join(source, "keep"),
    );
  });

  it("preflights conflicts before removing stale managed skills", () => {
    const dir = makeTempDir("codex-skill-conflict-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    for (const name of ["drop", "blocked"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `# ${name}\n`);
    }
    writeFileSync(allowlist, '{"skills":["drop"]}\n');
    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      source,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);
    writeFileSync(path.join(target, "blocked"), "unmanaged\n");
    writeFileSync(allowlist, '{"skills":["blocked"]}\n');

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
      ]).status,
    ).toBe(1);
    expect(readlinkSync(path.join(target, "drop"))).toBe(
      path.join(source, "drop"),
    );
  });

  it("rejects unknown allowlisted names before pruning managed skills", () => {
    const dir = makeTempDir("codex-skill-unknown-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# keep\n");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');
    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      source,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);
    writeFileSync(allowlist, '{"skills":["kepe"]}\n');

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
      ]).status,
    ).toBe(1);
    expect(readlinkSync(path.join(target, "keep"))).toBe(
      path.join(source, "keep"),
    );
  });

  it("uses the last source for duplicate skill names without partial sync", () => {
    const dir = makeTempDir("codex-skill-overlay-");
    const base = path.join(dir, "base");
    const overlay = path.join(dir, "overlay");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    for (const source of [base, overlay]) {
      mkdirSync(path.join(source, "shared"), { recursive: true });
      writeFileSync(path.join(source, "shared", "SKILL.md"), "# shared\n");
    }
    writeFileSync(allowlist, '{"skills":["shared"]}\n');

    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      base,
      "--source",
      overlay,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);

    expect(readlinkSync(path.join(target, "shared"))).toBe(
      path.join(overlay, "shared"),
    );
  });

  it("retargets a previously managed skill and rolls back a failed transition", () => {
    const dir = makeTempDir("codex-skill-retarget-");
    const base = path.join(dir, "base");
    const overlay = path.join(dir, "overlay");
    const target = path.join(dir, "target");
    const bin = path.join(dir, "bin");
    const allowlist = path.join(dir, "allowlist.json");
    for (const source of [base, overlay]) {
      mkdirSync(path.join(source, "shared"), { recursive: true });
      writeFileSync(path.join(source, "shared", "SKILL.md"), "# shared\n");
    }
    writeFileSync(allowlist, '{"skills":["shared"]}\n');
    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      base,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);

    mkdirSync(bin);
    executable(path.join(bin, "ln"), "exit 1");
    expect(
      spawnSync(
        "bash",
        [
          SKILL_SYNC,
          "--source",
          base,
          "--source",
          overlay,
          "--allowlist",
          allowlist,
          "--target",
          target,
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
      ).status,
    ).toBe(1);
    expect(readlinkSync(path.join(target, "shared"))).toBe(
      path.join(base, "shared"),
    );

    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      base,
      "--source",
      overlay,
      "--allowlist",
      allowlist,
      "--target",
      target,
    ]);
    expect(readlinkSync(path.join(target, "shared"))).toBe(
      path.join(overlay, "shared"),
    );
  });

  it("rejects overlapping syncs without changing managed state", () => {
    const dir = makeTempDir("codex-skill-lock-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    mkdirSync(path.join(target, ".buildproven-sync.lock"), { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# keep\n");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
      ]).status,
    ).toBe(1);
    expect(() => readlinkSync(path.join(target, "keep"))).toThrow();
  });

  it("recovers a stale owned sync lock", () => {
    const dir = makeTempDir("codex-skill-stale-lock-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    const lock = path.join(target, ".buildproven-sync.lock");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# keep\n");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');
    writeFileSync(path.join(lock, "owner"), "99999999|stale\n");

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
      ]).status,
    ).toBe(0);
    expect(readlinkSync(path.join(target, "keep"))).toBe(
      path.join(source, "keep"),
    );
  });

  it("rejects path traversal in the managed manifest", () => {
    const dir = makeTempDir("codex-skill-manifest-");
    const target = path.join(dir, "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, ".buildproven-managed"),
      "../victim|/tmp/victim\n",
    );

    expect(
      spawnSync("bash", [SKILL_SYNC, "--clean", "--target", target]).status,
    ).toBe(1);
  });

  it("rejects a manifest directory without creating unowned links", () => {
    const dir = makeTempDir("codex-manifest-dir-");
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const allowlist = path.join(dir, "allowlist.json");
    mkdirSync(path.join(source, "keep"), { recursive: true });
    mkdirSync(path.join(target, ".buildproven-managed"), { recursive: true });
    writeFileSync(path.join(source, "keep", "SKILL.md"), "# keep\n");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');

    expect(
      spawnSync("bash", [
        SKILL_SYNC,
        "--source",
        source,
        "--allowlist",
        allowlist,
        "--target",
        target,
      ]).status,
    ).toBe(1);
    expect(() => readlinkSync(path.join(target, "keep"))).toThrow();
  });

  it("measures instruction and allowlisted skill discovery budgets", () => {
    const dir = makeTempDir("surface-budget-");
    const skills = path.join(dir, "skills");
    const config = path.join(dir, "config");
    mkdirSync(path.join(skills, "keep"), { recursive: true });
    mkdirSync(path.join(skills, "skip"), { recursive: true });
    mkdirSync(config);
    writeFileSync(
      path.join(skills, "keep", "SKILL.md"),
      "---\nname: keep\ndescription: Useful workflow\n---\n",
    );
    writeFileSync(
      path.join(skills, "skip", "SKILL.md"),
      "---\nname: skip\ndescription: Hidden workflow\n---\n",
    );
    const allowlist = path.join(config, "skills.json");
    const instructions = path.join(config, "CLAUDE.md");
    writeFileSync(allowlist, '{"skills":["keep"]}\n');
    writeFileSync(instructions, "short\n");

    const payload = JSON.parse(
      execFileSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${skills}`,
        `--skill-allowlist=${allowlist}`,
        `--instruction-file=${instructions}`,
        "--description-budget=100",
        "--instruction-budget=100",
        "--json",
      ]),
    );

    expect(payload.discoverySkillCount).toBe(1);
    expect(payload.descriptionChars).toBe("keep: Useful workflow".length);
    expect(payload.instructionBytes).toBe(6);
    expect(payload.descriptionsOverBudget).toBe(false);
    expect(payload.instructionsOverBudget).toBe(false);
  });

  it("audits the default Codex profile through installed skill symlinks", () => {
    const dir = makeTempDir("surface-symlinks-");
    const skills = path.join(dir, "skills");
    const installed = path.join(dir, "installed");
    const config = path.join(dir, "config");
    mkdirSync(path.join(skills, "keep"), { recursive: true });
    mkdirSync(path.join(skills, "skip"), { recursive: true });
    mkdirSync(config);
    writeFileSync(
      path.join(skills, "keep", "SKILL.md"),
      "---\nname: keep\ndescription: Useful workflow\n---\n",
    );
    writeFileSync(
      path.join(skills, "skip", "SKILL.md"),
      "---\nname: skip\ndescription: Hidden workflow\n---\n",
    );
    writeFileSync(
      path.join(config, "codex-skills.json"),
      '{"skills":["keep"]}\n',
    );
    execFileSync("bash", [
      SKILL_SYNC,
      "--source",
      skills,
      "--allowlist",
      path.join(config, "codex-skills.json"),
      "--target",
      installed,
    ]);

    const installedPayload = JSON.parse(
      execFileSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${installed}`,
        `--skill-allowlist=${path.join(config, "codex-skills.json")}`,
        "--json",
      ]),
    );
    const defaultPayload = JSON.parse(
      execFileSync("node", [SURFACE, `--root=${dir}`, "--json"]),
    );

    expect(installedPayload.discoverySkillCount).toBe(1);
    expect(defaultPayload.discoverySkillCount).toBe(1);
    expect(defaultPayload.descriptionChars).toBe(
      "keep: Useful workflow".length,
    );
  });

  it("counts YAML block-scalar and escaped descriptions", () => {
    const dir = makeTempDir("surface-yaml-");
    const skills = path.join(dir, "skills");
    const allowlist = path.join(dir, "skills.json");
    for (const name of ["folded", "literal", "quoted"]) {
      mkdirSync(path.join(skills, name), { recursive: true });
    }
    writeFileSync(
      path.join(skills, "folded", "SKILL.md"),
      "---\nname: folded\ndescription: >-\n  Folded\n  workflow\n---\n",
    );
    writeFileSync(
      path.join(skills, "literal", "SKILL.md"),
      "---\nname: literal\ndescription: |+\n  Literal\n  workflow\n---\n",
    );
    writeFileSync(
      path.join(skills, "quoted", "SKILL.md"),
      '---\nname: quoted\ndescription: "Escaped\\nworkflow"\n---\n',
    );
    writeFileSync(allowlist, '{"skills":["folded","literal","quoted"]}\n');

    const payload = JSON.parse(
      execFileSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${skills}`,
        `--skill-allowlist=${allowlist}`,
        "--json",
      ]),
    );
    expect(payload.descriptionChars).toBe(
      [
        "folded: Folded workflow",
        "literal: Literal workflow",
        "quoted: Escaped\nworkflow",
      ].reduce((total, description) => total + description.length, 0),
    );
  });

  it("fails when explicit surface-audit inputs are missing or malformed", () => {
    const dir = makeTempDir("surface-invalid-");
    const skills = path.join(dir, "skills");
    const allowlist = path.join(dir, "skills.json");
    mkdirSync(skills);
    writeFileSync(allowlist, '{"skillz":[]}\n');

    expect(
      spawnSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${skills}`,
        `--skill-allowlist=${allowlist}`,
        "--json",
      ]).status,
    ).toBe(1);
    expect(
      spawnSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${path.join(dir, "missing")}`,
        `--instruction-file=${path.join(dir, "missing.md")}`,
        "--json",
      ]).status,
    ).toBe(1);
    mkdirSync(path.join(skills, "keep"));
    writeFileSync(path.join(skills, "keep", "SKILL.md"), "# keep\n");
    writeFileSync(allowlist, '{"skills":[" missing "]}\n');
    expect(
      spawnSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${skills}`,
        `--skill-allowlist=${allowlist}`,
        "--json",
      ]).status,
    ).toBe(1);
    writeFileSync(allowlist, '{"skills":["unknown"]}\n');
    expect(
      spawnSync("node", [
        SURFACE,
        `--root=${dir}`,
        `--skill-source=${skills}`,
        `--skill-allowlist=${allowlist}`,
        "--json",
      ]).status,
    ).toBe(1);
  });

  it("treats absent implicit skill surfaces as empty", () => {
    const dir = makeTempDir("surface-generic-");
    const payload = JSON.parse(
      execFileSync("node", [SURFACE, `--root=${dir}`, "--json"]),
    );
    expect(payload.discoverySkillCount).toBe(0);
    expect(payload.descriptionChars).toBe(0);
  });

  it("fails closed when a surface budget is not a valid integer", () => {
    expect(
      spawnSync("node", [
        SURFACE,
        `--root=${ROOT}`,
        "--description-budget=wat",
        "--json",
      ]).status,
    ).toBe(1);
    expect(
      spawnSync("node", [
        SURFACE,
        `--root=${ROOT}`,
        "--instruction-budget=-1",
        "--json",
      ]).status,
    ).toBe(1);
  });

  it("discovers active non-bot repos and open-PR repos from fixtures", () => {
    const dir = makeTempDir("fleet-discovery-");
    const config = path.join(dir, "fleet.json");
    const fixture = path.join(dir, "repos.json");
    writeFileSync(
      config,
      JSON.stringify({
        owners: ["buildproven"],
        windowDays: 14,
        minimumCommits: 2,
        localRoots: [],
        include: [],
        exclude: [],
      }),
    );
    writeFileSync(
      fixture,
      JSON.stringify([
        {
          nameWithOwner: "buildproven/active",
          commits: [
            { author: { login: "brett" } },
            { author: { login: "dependabot[bot]", type: "Bot" } },
          ],
          pullRequests: [],
        },
        {
          nameWithOwner: "buildproven/pr-only",
          commits: [],
          pullRequests: [{ isDraft: false }],
        },
        {
          nameWithOwner: "buildproven/bots-only",
          commits: [
            { author: { login: "dependabot[bot]", type: "Bot" } },
            { author: { login: "renovate[bot]", type: "Bot" } },
          ],
          pullRequests: [],
        },
      ]),
    );

    const payload = JSON.parse(
      execFileSync("python3", [
        DISCOVER,
        "--config",
        config,
        "--fixture",
        fixture,
      ]),
    );
    expect(payload.repositories.map((repo) => repo.nameWithOwner)).toEqual([
      "buildproven/active",
      "buildproven/pr-only",
    ]);
  });

  it("maps GitHub repos to primary checkouts, never linked worktrees", () => {
    const dir = makeTempDir("fleet-local-map-");
    const root = path.join(dir, "repos");
    const primary = path.join(root, "primary");
    const worktree = path.join(root, "primary-worktree");
    mkdirSync(root);
    execFileSync("git", ["init", "-q", "-b", "main", primary]);
    execFileSync("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", ["-C", primary, "config", "user.name", "Test"]);
    writeFileSync(path.join(primary, "README.md"), "test\n");
    execFileSync("git", ["-C", primary, "add", "README.md"]);
    execFileSync("git", ["-C", primary, "commit", "-q", "-m", "init"]);
    execFileSync("git", [
      "-C",
      primary,
      "remote",
      "add",
      "origin",
      "https://github.com/buildproven/active.git",
    ]);
    execFileSync("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "-q",
      "-b",
      "feature",
      worktree,
    ]);
    const config = path.join(dir, "fleet.json");
    const fixture = path.join(dir, "repos.json");
    writeFileSync(
      config,
      JSON.stringify({
        owners: ["buildproven"],
        windowDays: 14,
        minimumCommits: 1,
        localRoots: [root],
      }),
    );
    writeFileSync(
      fixture,
      JSON.stringify([
        {
          nameWithOwner: "buildproven/active",
          commits: [{ author: { login: "brett" } }],
          pullRequests: [],
        },
      ]),
    );

    const payload = JSON.parse(
      execFileSync("python3", [
        DISCOVER,
        "--config",
        config,
        "--fixture",
        fixture,
      ]),
    );
    expect(payload.repositories[0].localPath).toBe(
      execFileSync(
        "python3",
        ["-c", "import os,sys; print(os.path.realpath(sys.argv[1]))", primary],
        {
          encoding: "utf8",
        },
      ).trim(),
    );
  });

  it("syncs the same declarative MCP server into both clients", () => {
    const dir = makeTempDir("mcp-sync-");
    const bin = path.join(dir, "bin");
    const codexHome = path.join(dir, "codex");
    const calls = path.join(dir, "calls");
    mkdirSync(bin);
    mkdirSync(codexHome);
    const body = `printf '%s %s\\n' "$(basename "$0")" "$*" >> '${calls}'\nif [ "$1 $2" = "mcp list" ]; then exit 0; fi`;
    executable(path.join(bin, "claude"), body);
    executable(path.join(bin, "codex"), body);
    const manifest = path.join(dir, "mcp.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        servers: [
          {
            name: "shared",
            transport: "http",
            url: "https://example.test/mcp",
            clients: ["claude", "codex"],
          },
        ],
      }),
    );

    const result = spawnSync("python3", [MCP_SYNC, "--manifest", manifest], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    expect(result.status).toBe(0);
    const logged = readFileSync(calls, "utf8");
    expect(logged).toContain(
      "claude mcp add --scope user --transport http shared https://example.test/mcp",
    );
    expect(logged).not.toContain("codex mcp add shared");
    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
      '[mcp_servers."shared"]\nurl = "https://example.test/mcp"',
    );
  });

  it("reuses verified MCP parity until source or client state changes", () => {
    const dir = makeTempDir("mcp-parity-cache-");
    const setup = path.join(dir, "setup");
    const config = path.join(setup, "config");
    const bin = path.join(dir, "bin");
    const state = path.join(dir, "state");
    const cacheDir = path.join(state, "claude-kit");
    const defaultProfileKey = createHash("sha256")
      .update("default")
      .digest("hex");
    const staleLock = path.join(
      cacheDir,
      `mcp-parity-${defaultProfileKey}.json.lock`,
    );
    const codexHome = path.join(dir, "codex");
    const calls = path.join(dir, "calls");
    const parityLink = path.join(dir, "setup-mcp-parity");
    mkdirSync(config, { recursive: true });
    mkdirSync(bin);
    mkdirSync(codexHome);
    mkdirSync(staleLock, { recursive: true });
    writeFileSync(
      path.join(staleLock, "owner"),
      `${process.pid}\nreused-pid\n`,
    );
    writeFileSync(
      path.join(config, "mcp.json"),
      JSON.stringify({
        defaultProfile: "default",
        profiles: { default: [], "x/../../escaped": [] },
        servers: [],
      }),
    );
    const client = `printf '%s %s\n' "$(basename "$0")" "$*" >> '${calls}'\ncase "$1 $2" in "mcp list") exit 0 ;; "mcp get") exit 1 ;; esac`;
    executable(path.join(bin, "claude"), client);
    executable(path.join(bin, "codex"), client);
    symlinkSync(MCP_PARITY, parityLink);
    const env = {
      ...process.env,
      HOME: dir,
      CODEX_HOME: codexHome,
      SETUP_REPO: setup,
      XDG_STATE_HOME: state,
      PATH: `${bin}:${process.env.PATH}`,
    };

    const first = spawnSync("bash", [parityLink, "--profile", "default"], {
      encoding: "utf8",
      env,
    });
    expect(first.status, first.stderr).toBe(0);
    const firstCalls = readFileSync(calls, "utf8");
    expect(firstCalls).toContain("claude mcp list");
    expect(firstCalls).toContain("codex mcp list");

    const second = spawnSync("bash", [parityLink, "--profile", "default"], {
      encoding: "utf8",
      env,
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("verified cached parity");
    expect(readFileSync(calls, "utf8")).toBe(firstCalls);

    writeFileSync(path.join(dir, ".claude.json"), '{"mcpServers":{}}\n');
    const drift = spawnSync("bash", [MCP_PARITY, "--profile", "default"], {
      encoding: "utf8",
      env,
    });
    expect(drift.status, drift.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).not.toBe(firstCalls);

    const unsafeProfile = spawnSync(
      "bash",
      [MCP_PARITY, "--profile", "x/../../escaped"],
      { encoding: "utf8", env },
    );
    expect(unsafeProfile.status, unsafeProfile.stderr).toBe(0);
    expect(existsSync(path.join(state, "escaped.json"))).toBe(false);
    expect(
      readdirSync(cacheDir).every((name) =>
        /^mcp-parity-[a-f0-9]{64}\.json$/.test(name),
      ),
    ).toBe(true);
  });

  it("serializes concurrent MCP parity sync and reuses the completed result", async () => {
    const dir = makeTempDir("mcp-parity-concurrent-");
    const setup = path.join(dir, "setup");
    const config = path.join(setup, "config");
    const bin = path.join(dir, "bin");
    const state = path.join(dir, "state");
    const codexHome = path.join(dir, "codex");
    const calls = path.join(dir, "calls");
    mkdirSync(config, { recursive: true });
    mkdirSync(bin);
    mkdirSync(codexHome);
    writeFileSync(
      path.join(config, "mcp.json"),
      JSON.stringify({
        defaultProfile: "default",
        profiles: { default: [] },
        servers: [],
      }),
    );
    const client = `printf '%s %s\n' "$(basename "$0")" "$*" >> '${calls}'\ncase "$1 $2" in "mcp list") sleep 1; exit 0 ;; "mcp get") exit 1 ;; esac`;
    executable(path.join(bin, "claude"), client);
    executable(path.join(bin, "codex"), client);
    const env = {
      ...process.env,
      HOME: dir,
      CODEX_HOME: codexHome,
      SETUP_REPO: setup,
      XDG_STATE_HOME: state,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const run = () =>
      new Promise((resolve) => {
        const child = spawn("bash", [MCP_PARITY, "--profile", "default"], {
          env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });

    const results = await Promise.all([run(), run()]);
    for (const result of results) {
      expect(result.status, result.stderr).toBe(0);
    }
    expect(
      results.filter((result) =>
        result.stdout.includes("verified cached parity"),
      ),
    ).toHaveLength(1);
    const logged = readFileSync(calls, "utf8").trim().split("\n");
    expect(logged.filter((call) => call === "claude mcp list")).toHaveLength(1);
    expect(logged.filter((call) => call === "codex mcp list")).toHaveLength(1);
  });

  it("fails closed on corrupt MCP cache state and records only after success", () => {
    const dir = makeTempDir("mcp-parity-cache-failure-");
    const setup = path.join(dir, "setup");
    const config = path.join(setup, "config");
    const bin = path.join(dir, "bin");
    const state = path.join(dir, "state");
    const cacheDir = path.join(state, "claude-kit");
    const cache = path.join(cacheDir, "mcp-parity-default.json");
    mkdirSync(config, { recursive: true });
    mkdirSync(bin);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(config, "mcp.json"),
      JSON.stringify({
        defaultProfile: "default",
        profiles: { default: ["shared"] },
        servers: [
          {
            name: "shared",
            transport: "http",
            url: "https://example.test/mcp",
          },
        ],
      }),
    );
    writeFileSync(cache, "not-json\n");
    executable(
      path.join(bin, "claude"),
      'case "$1 $2" in "mcp list") exit 0 ;; "mcp add") exit 9 ;; esac',
    );
    executable(
      path.join(bin, "codex"),
      'case "$1 $2" in "mcp list") exit 0 ;; esac',
    );
    const result = spawnSync("bash", [MCP_PARITY, "--profile", "default"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: dir,
        CODEX_HOME: path.join(dir, "codex"),
        SETUP_REPO: setup,
        XDG_STATE_HOME: state,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(cache, "utf8")).toBe("not-json\n");
  });

  it("binds MCP cache hits to every declared source and client identity", () => {
    const dir = makeTempDir("mcp-cache-helper-");
    const cache = path.join(dir, "cache.json");
    const source = path.join(dir, "source");
    const clientConfig = path.join(dir, "client.json");
    const executablePath = path.join(dir, "client");
    writeFileSync(source, "source-a\n");
    writeFileSync(clientConfig, "client-a\n");
    executable(executablePath, "exit 0");
    const args = [
      "--cache",
      cache,
      "--profile",
      "default",
      "--source",
      source,
      "--client-config",
      clientConfig,
      "--client-executable",
      executablePath,
    ];
    execFileSync("python3", [MCP_CACHE, "record", ...args]);
    expect(spawnSync("python3", [MCP_CACHE, "hit", ...args]).status).toBe(0);
    const executableMetadata = statSync(executablePath, { bigint: true });
    executable(executablePath, "exit 1");
    execFileSync("python3", [
      "-c",
      "import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))",
      executablePath,
      String(executableMetadata.atimeNs),
      String(executableMetadata.mtimeNs),
    ]);
    expect(spawnSync("python3", [MCP_CACHE, "hit", ...args]).status).toBe(1);
    execFileSync("python3", [MCP_CACHE, "record", ...args]);
    writeFileSync(source, "source-b\n");
    expect(spawnSync("python3", [MCP_CACHE, "hit", ...args]).status).toBe(1);
  });

  it("audits convergence residue without running repository test suites", () => {
    const dir = makeTempDir("steward-node-version-");
    const repo = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    const remote = path.join(dir, "origin.git");
    const extra = path.join(dir, "extra");
    mkdirSync(bin);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "AGENTS.md"), "# Instructions\n");
    symlinkSync("AGENTS.md", path.join(repo, "CLAUDE.md"));
    execFileSync("git", ["-C", repo, "add", "AGENTS.md", "CLAUDE.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
    execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"]);
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "-b",
      "feature",
      extra,
    ]);
    writeFileSync(path.join(extra, "feature.txt"), "feature\n");
    execFileSync("git", ["-C", extra, "add", "feature.txt"]);
    execFileSync("git", ["-C", extra, "commit", "-m", "feature"]);
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "lock",
      extra,
      "--reason",
      "owner",
    ]);
    writeFileSync(path.join(repo, "AGENTS.md"), "# Changed\n");
    execFileSync("git", ["-C", repo, "stash", "push"]);
    executable(
      path.join(bin, "gh"),
      `case "$*" in
        *"repo view"*) echo main ;;
        *"pr list"*) echo 1 ;;
      esac`,
    );
    executable(path.join(bin, "npm"), "exit 99");

    const result = spawnSync("bash", [AUDIT_REPO, repo], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      converged: false,
      extraWorktrees: 1,
      lockedWorktrees: 1,
      openPullRequests: 1,
      stashes: 1,
      unmergedLocalBranches: 1,
    });
  });

  it("fails closed when a lifecycle probe cannot be read", () => {
    const dir = makeTempDir("steward-probe-failure-");
    const repo = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    executable(
      path.join(bin, "git"),
      `case "$*" in
        *"branch --show-current"*) echo main ;;
        *"rev-parse --verify main"*) exit 0 ;;
        *"status --porcelain"*) exit 0 ;;
        *"fetch --prune"*) exit 0 ;;
        *"rev-list --left-right --count"*) echo "0 0" ;;
        *"remote get-url"*) echo https://github.com/buildproven/example.git ;;
        *"worktree list --porcelain"*) exit 1 ;;
      esac`,
    );
    executable(
      path.join(bin, "gh"),
      `case "$*" in
        *"repo view"*) echo main ;;
        *"pr list"*) echo 0 ;;
      esac`,
    );

    const result = spawnSync("bash", [AUDIT_REPO, repo], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("limits steward repair to proven residue and instruction drift", () => {
    const script = readFileSync(STEWARD_ORCHESTRATE, "utf8");
    const lifecycleGuard = script.indexOf("reconcilable=$(python3");
    const reconcile = script.indexOf('worktree-manager.js" reconcile');
    const reaudit = script.indexOf('audit-repo.sh" "$repo"', reconcile);
    const repairGuard = script.indexOf("repairable=$(python3", reaudit);
    const provider = script.indexOf('provider-run.sh"', repairGuard);

    expect(lifecycleGuard).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(lifecycleGuard);
    expect(reconcile).toBeGreaterThan(-1);
    expect(reaudit).toBeGreaterThan(reconcile);
    expect(repairGuard).toBeGreaterThan(reaudit);
    expect(provider).toBeGreaterThan(repairGuard);
    expect(script).toContain('not d["instructionSync"]');
    expect(script).toContain('d["openPullRequests"]');
    expect(script).toContain('d["stashes"]');
    expect(script).toContain('d["lockedWorktrees"]');
    expect(script).toContain('if [ "$PROVIDER" = codex ]');
    expect(script).toContain('[ -z "$PROVIDER" ] || args+=');
    expect(script).toContain('[ -z "$FALLBACK" ] || args+=');
  });

  it("launches a governed Codex child with the plan's explicit model and effort", () => {
    const dir = makeTempDir("provider-native-governed-codex-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const plan = path.join(dir, "plan.json");
    const calls = path.join(dir, "codex.calls");
    mkdirSync(bin);
    writeFileSync(prompt, "implement this narrow behavior\n");
    initializeGovernedTarget(dir);
    writeFileSync(
      plan,
      governedPlan(
        {
          provider: "codex",
          phase: "implement",
          localized: true,
          reversible: true,
          targetedProof: true,
          changedFiles: 1,
          protectedSurfaces: [],
          sameFailureStreak: 0,
        },
        prompt,
        dir,
      ),
    );
    executable(
      path.join(bin, "codex"),
      [
        `printf '%s\\n' "$*" > '${calls}'`,
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "governed codex completed" > "$last_message"',
        `echo '${JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 120,
            cached_input_tokens: 80,
            output_tokens: 30,
            reasoning_output_tokens: 10,
          },
        })}'`,
        "exit 0",
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--target-dir",
        dir,
        "--execution-plan",
        plan,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("--model gpt-5.6-terra");
    expect(readFileSync(calls, "utf8")).toContain(
      'model_reasoning_effort="medium"',
    );
    const record = JSON.parse(
      readFileSync(path.join(output, "run-record.json"), "utf8"),
    );
    expect(record).toMatchObject({
      effective: {
        provider: "codex",
        model: "gpt-5.6-terra",
        effort: "medium",
      },
      outcome: { status: "passed" },
      attempts: 1,
      usage: {
        schemaVersion: 1,
        source: "codex-cli",
        inputTokens: 120,
        cachedInputTokens: 80,
        outputTokens: 30,
        reasoningOutputTokens: 10,
        totalTokens: 150,
      },
    });
  });

  it("rejects governed evidence stored inside the target worktree", () => {
    const dir = makeTempDir("provider-native-target-evidence-");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    writeFileSync(prompt, "perform governed work\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "implement",
        localized: true,
        reversible: true,
        targetedProof: true,
        changedFiles: 1,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--target-dir",
        dir,
        "--output-dir",
        path.join(dir, ".claude", "run-evidence"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "governed output directory must be outside the target worktree",
    );
  });

  it("fails visibly when a governed provider creates an ignored file", () => {
    const dir = makeTempDir("provider-native-ignored-delivery-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    mkdirSync(bin);
    writeFileSync(prompt, "create generated output\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "implement",
        localized: true,
        reversible: true,
        targetedProof: true,
        changedFiles: 1,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-C" ]; then target_next=1; continue; fi',
        '  if [ "${target_next:-0}" = 1 ]; then provider_target="$arg"; target_next=0; fi',
        '  if [ "$arg" = "-o" ]; then message_next=1; continue; fi',
        '  if [ "${message_next:-0}" = 1 ]; then last_message="$arg"; message_next=0; fi',
        "done",
        'echo "provider completed" > "$last_message"',
        'mkdir -p "$provider_target/bin"',
        'echo "ignored output" > "$provider_target/bin/generated.txt"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain(
      "created ignored files that cannot be delivered safely",
    );
    expect(
      readFileSync(
        path.join(output, "undeliverable-ignored-files.txt"),
        "utf8",
      ),
    ).toContain("bin/generated.txt");
    expect(existsSync(path.join(dir, "bin", "generated.txt"))).toBe(false);
  });

  it("discards ignored read-only cache files without treating them as a handoff", () => {
    const dir = makeTempDir("provider-native-readonly-cache-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    mkdirSync(bin);
    writeFileSync(prompt, "review and run local checks\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "scan",
        readOnly: true,
        localized: true,
        targetedProof: true,
        changedFiles: 1,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-C" ]; then target_next=1; continue; fi',
        '  if [ "${target_next:-0}" = 1 ]; then provider_target="$arg"; target_next=0; fi',
        '  if [ "$arg" = "-o" ]; then message_next=1; continue; fi',
        '  if [ "${message_next:-0}" = 1 ]; then last_message="$arg"; message_next=0; fi',
        "done",
        'echo "provider completed" > "$last_message"',
        'mkdir -p "$provider_target/bin"',
        'echo "cache" > "$provider_target/bin/review-cache.txt"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--sandbox",
        "read-only",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(dir, "bin", "review-cache.txt"))).toBe(false);
    expect(
      existsSync(path.join(output, "undeliverable-ignored-files.txt")),
    ).toBe(false);
  });

  it("rejects tracked changes from every governed read-only provider", () => {
    const dir = makeTempDir("provider-native-readonly-change-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    mkdirSync(bin);
    writeFileSync(prompt, "review only\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "scan",
        readOnly: true,
        localized: true,
        targetedProof: true,
        changedFiles: 1,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-C" ]; then target_next=1; continue; fi',
        '  if [ "${target_next:-0}" = 1 ]; then provider_target="$arg"; target_next=0; fi',
        '  if [ "$arg" = "-o" ]; then message_next=1; continue; fi',
        '  if [ "${message_next:-0}" = 1 ]; then last_message="$arg"; message_next=0; fi',
        "done",
        'echo "provider completed" > "$last_message"',
        'echo "mutated" >> "$provider_target/.gitignore"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--sandbox",
        "read-only",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain(
      "read-only governed provider created tracked changes",
    );
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).not.toContain(
      "mutated",
    );
  });

  it("raises a falsely empty protected-surface list from task evidence", () => {
    const dir = makeTempDir("provider-native-protected-binding-");
    const prompt = path.join(dir, "prompt");
    writeFileSync(prompt, "change the OAuth login session behavior\n");
    initializeGovernedTarget(dir);
    const plan = JSON.parse(
      governedPlan(
        {
          provider: "codex",
          phase: "implement",
          localized: true,
          reversible: true,
          targetedProof: true,
          changedFiles: 1,
          protectedSurfaces: [],
          sameFailureStreak: 0,
        },
        prompt,
        dir,
      ),
    );
    expect(plan).toMatchObject({
      route: "critical",
      model: "gpt-5.6-sol",
      safetyFloor: "critical",
      facts: { protectedSurfaces: ["auth"] },
      executionBinding: { classifiedProtectedSurfaces: ["auth"] },
    });
  });

  it("rejects a persisted plan reused for a different protected prompt", () => {
    const dir = makeTempDir("provider-native-stale-binding-");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const plan = path.join(output, "execution-plan.json");
    mkdirSync(output);
    writeFileSync(prompt, "update a local label\n");
    initializeGovernedTarget(dir);
    writeFileSync(
      plan,
      governedPlan(
        {
          provider: "codex",
          phase: "implement",
          localized: true,
          reversible: true,
          targetedProof: true,
          changedFiles: 1,
          protectedSurfaces: [],
          sameFailureStreak: 0,
        },
        prompt,
        dir,
      ),
    );
    writeFileSync(prompt, "change Stripe payment authorization\n");

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-plan",
        plan,
        "--provider",
        "not-a-provider",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("provider-run: invalid execution plan");
  });

  it("resolves execution facts before launching and persists the exact plan", () => {
    const dir = makeTempDir("provider-native-governed-facts-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(output, "execution-facts.json");
    mkdirSync(bin);
    mkdirSync(output);
    writeFileSync(prompt, "perform a bounded scan\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "scan",
        readOnly: true,
        localized: true,
        targetedProof: true,
        changedFiles: 0,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "scan complete" > "$last_message"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(path.join(output, "execution-plan.json"), "utf8"),
      ),
    ).toMatchObject({
      route: "standard",
      provider: "codex",
      model: "gpt-5.6-terra",
      contextClass: "fresh-bounded",
      promotion: "calibration-required-standard-fallback",
    });
  });

  it("accepts an approved plan already persisted in its evidence directory", () => {
    const dir = makeTempDir("provider-native-persisted-plan-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const plan = path.join(output, "execution-plan.json");
    mkdirSync(bin);
    mkdirSync(output);
    writeFileSync(prompt, "perform the approved work\n");
    initializeGovernedTarget(dir);
    writeFileSync(
      plan,
      governedPlan(
        {
          provider: "codex",
          phase: "implement",
          localized: false,
          reversible: false,
          targetedProof: false,
          ambiguous: true,
          changedFiles: 0,
          protectedSurfaces: [],
          sameFailureStreak: 0,
        },
        prompt,
        dir,
      ),
    );
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "approved run complete" > "$last_message"',
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-plan",
        plan,
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(plan, "utf8"))).toMatchObject({
      route: "standard",
      model: "gpt-5.6-terra",
    });
    expect(
      JSON.parse(readFileSync(path.join(output, "run-record.json"), "utf8")),
    ).toMatchObject({ outcome: { status: "passed" } });
  });

  it("does not publish a provider receipt when terminal evidence cannot be persisted", () => {
    const dir = makeTempDir("provider-native-record-failure-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    mkdirSync(bin);
    writeFileSync(prompt, "perform governed work\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "scan",
        readOnly: true,
        localized: true,
        targetedProof: true,
        changedFiles: 0,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "provider completed" > "$last_message"',
        `chmod 0555 '${output}'`,
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    chmodSync(output, 0o755);

    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain(
      "provider succeeded but pending delivery evidence could not be persisted",
    );
    expect(existsSync(path.join(output, "provider"))).toBe(false);
    expect(existsSync(path.join(output, "run-record.json"))).toBe(false);
  });

  it("retains delivered changes and an exclusion lock when receipt promotion fails", () => {
    const dir = makeTempDir("provider-native-rollback-failure-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    const delivered = path.join(dir, "delivered.txt");
    mkdirSync(bin);
    writeFileSync(prompt, "implement governed work\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "implement",
        localized: true,
        reversible: true,
        targetedProof: true,
        changedFiles: 1,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-C" ]; then target_next=1; continue; fi',
        '  if [ "${target_next:-0}" = 1 ]; then provider_target="$arg"; target_next=0; fi',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "provider completed" > "$last_message"',
        'echo "delivered" > "$provider_target/delivered.txt"',
      ].join("\n"),
    );
    executable(
      path.join(bin, "mv"),
      [
        `counter='${path.join(output, ".record-moves")}'`,
        `if [ "\${!#}" = '${path.join(output, "run-record.json")}' ]; then`,
        '  count=$(($(cat "$counter" 2>/dev/null || echo 0) + 1))',
        '  printf "%s\\n" "$count" > "$counter"',
        '  if [ "$count" -eq 2 ]; then',
        "    exit 1",
        "  fi",
        "fi",
        'exec /bin/mv "$@"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    const recoveryLock = path.join(
      dir,
      ".git",
      "buildproven-governed-handoff.lock",
    );
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain(
      "changes and reconciliation lock were retained",
    );
    expect(readFileSync(delivered, "utf8")).toBe("delivered\n");
    expect(existsSync(recoveryLock)).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(output, "run-record.json"), "utf8")),
    ).toMatchObject({
      outcome: {
        status: "failed",
        providerFailureCategory: "delivery-pending",
      },
    });
  });

  it("rolls back an applied handoff when post-apply verification infrastructure fails", () => {
    const dir = makeTempDir("provider-native-post-apply-failure-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    mkdirSync(bin);
    writeFileSync(prompt, "implement governed work\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "implement",
        localized: true,
        reversible: true,
        targetedProof: true,
        changedFiles: 1,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-C" ]; then target_next=1; continue; fi',
        '  if [ "${target_next:-0}" = 1 ]; then provider_target="$arg"; target_next=0; fi',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'echo "provider completed" > "$last_message"',
        'echo "delivered" > "$provider_target/delivered.txt"',
      ].join("\n"),
    );
    executable(
      path.join(bin, "mktemp"),
      [
        'case "$*" in',
        "  *provider-live.*) exit 1 ;;",
        "esac",
        'exec /usr/bin/mktemp "$@"',
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "codex",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain("cannot allocate handoff verification");
    expect(existsSync(path.join(dir, "delivered.txt"))).toBe(false);
    expect(
      existsSync(path.join(dir, ".git", "buildproven-governed-handoff.lock")),
    ).toBe(false);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: dir,
        encoding: "utf8",
      }),
    ).toBe("");
  });

  it("launches a governed Claude child with explicit model and effort", () => {
    const dir = makeTempDir("provider-native-governed-claude-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const facts = path.join(dir, "facts.json");
    const calls = path.join(dir, "claude.calls");
    mkdirSync(bin);
    writeFileSync(prompt, "diagnose this behavior\n");
    writeFileSync(
      facts,
      JSON.stringify({
        phase: "diagnose",
        localized: false,
        targetedProof: false,
        ambiguous: true,
        changedFiles: 0,
        protectedSurfaces: [],
        sameFailureStreak: 0,
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "claude"),
      `printf '%s\\n' "$*" > '${calls}'\nprintf '%s\\n' '{"is_error":false,"result":"done"}'`,
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--execution-facts",
        facts,
        "--provider",
        "claude",
        "--fallback",
        "none",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("--model claude-sonnet-5");
    expect(readFileSync(calls, "utf8")).toContain("--effort medium");
  });

  it("launches a schema-v2 read-only phase with isolated Codex authority", () => {
    const dir = makeTempDir("provider-phase-readonly-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const request = path.join(dir, "request.json");
    const calls = path.join(dir, "codex.calls");
    mkdirSync(bin);
    writeFileSync(prompt, "review the supplied local change\n");
    writeFileSync(
      request,
      JSON.stringify({
        schemaVersion: 2,
        caller: "cross-review",
        provider: "codex",
        phase: "review",
        evidence: {
          localized: true,
          reversible: false,
          targetedProof: true,
          ambiguous: false,
          changedFiles: 1,
          protectedSurfaces: [],
          publicContract: false,
          crossRepository: false,
          plannedPaths: ["src/"],
        },
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        `printf '%s\\n' "$*" > '${calls}'`,
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        "done",
        'printf "%s\\n" "CLEAN" > "$last_message"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--phase-request",
        request,
        "--caller",
        "cross-review",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("-s read-only");
    expect(readFileSync(calls, "utf8")).toContain("mcp_servers={}");
    expect(readFileSync(calls, "utf8")).toContain("-a never");
    expect(
      JSON.parse(readFileSync(path.join(output, "run-record.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      plan: { phase: "review", accessProfile: "read-only", route: "standard" },
      outcome: { status: "completed", exitCode: 0 },
    });
  });

  it("rejects a missing or mismatched phase caller before provider launch", () => {
    const dir = makeTempDir("provider-phase-caller-binding-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const request = path.join(dir, "request.json");
    const marker = path.join(dir, "codex-started");
    mkdirSync(bin);
    writeFileSync(prompt, "review the local change\n");
    writeFileSync(
      request,
      JSON.stringify({
        schemaVersion: 2,
        caller: "cross-review",
        provider: "codex",
        phase: "review",
        evidence: {
          localized: true,
          reversible: false,
          targetedProof: true,
          ambiguous: false,
          changedFiles: 1,
          protectedSurfaces: [],
          publicContract: false,
          crossRepository: false,
          plannedPaths: ["src/"],
        },
      }),
    );
    initializeGovernedTarget(dir);
    executable(path.join(bin, "codex"), `touch '${marker}'`);
    const baseArgs = [
      PROVIDER_RUN,
      "--prompt-file",
      prompt,
      "--phase-request",
      request,
      "--target-dir",
      dir,
      "--output-dir",
      output,
    ];
    const missing = spawnSync("bash", baseArgs, {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("phase caller is missing or mismatched");
    expect(existsSync(marker)).toBe(false);

    const mismatched = spawnSync(
      "bash",
      [
        ...baseArgs.slice(0, -2),
        "--caller",
        "interactive-ralph",
        ...baseArgs.slice(-2),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(mismatched.status).toBe(2);
    expect(mismatched.stderr).toContain(
      "phase caller is missing or mismatched",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("fails verification closed with a typed receipt before Codex launch", () => {
    const dir = makeTempDir("provider-phase-verify-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const request = path.join(dir, "request.json");
    const marker = path.join(dir, "codex-started");
    mkdirSync(bin);
    writeFileSync(prompt, "verify the local checks\n");
    writeFileSync(
      request,
      JSON.stringify({
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "verify",
        evidence: {
          localized: true,
          reversible: false,
          targetedProof: true,
          ambiguous: false,
          changedFiles: 1,
          protectedSurfaces: [],
          publicContract: false,
          crossRepository: false,
          plannedPaths: ["src/"],
        },
      }),
    );
    initializeGovernedTarget(dir);
    executable(path.join(bin, "codex"), `touch '${marker}'`);
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--phase-request",
        request,
        "--caller",
        "interactive-ralph",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(78);
    expect(existsSync(marker)).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(output, "run-record.json"), "utf8"))
        .outcome,
    ).toMatchObject({
      status: "capability-disabled",
      category: "verification-disabled",
    });
  });

  it("delivers an approved schema-v2 regular-file addition", () => {
    const dir = makeTempDir("provider-phase-write-");
    const bin = path.join(dir, "bin");
    const output = path.join(makeTempDir("provider-output-"), "output");
    const prompt = path.join(dir, "prompt");
    const request = path.join(dir, "request.json");
    mkdirSync(bin);
    writeFileSync(prompt, "add the planned local feature\n");
    writeFileSync(
      request,
      JSON.stringify({
        schemaVersion: 2,
        caller: "interactive-ralph",
        provider: "codex",
        phase: "implement",
        evidence: {
          localized: true,
          reversible: true,
          targetedProof: true,
          ambiguous: false,
          changedFiles: 1,
          protectedSurfaces: [],
          publicContract: false,
          crossRepository: false,
          plannedPaths: ["src/"],
        },
      }),
    );
    initializeGovernedTarget(dir);
    executable(
      path.join(bin, "codex"),
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "-o" ]; then shift_next=1; continue; fi',
        '  if [ "${shift_next:-0}" = 1 ]; then last_message="$arg"; shift_next=0; fi',
        '  if [ "$arg" = "-C" ]; then cd_next=1; continue; fi',
        '  if [ "${cd_next:-0}" = 1 ]; then target="$arg"; cd_next=0; fi',
        "done",
        'cd "$target"',
        "mkdir -p src",
        'printf "%s\\n" "export default 1;" > src/feature.js',
        'printf "%s\\n" "done" > "$last_message"',
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        PROVIDER_RUN,
        "--prompt-file",
        prompt,
        "--phase-request",
        request,
        "--caller",
        "interactive-ralph",
        "--target-dir",
        dir,
        "--output-dir",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(dir, "src", "feature.js"), "utf8")).toContain(
      "export default 1",
    );
    expect(
      JSON.parse(readFileSync(path.join(output, "run-record.json"), "utf8"))
        .outcome.status,
    ).toBe("completed");
  });

  it("keeps the public command surface within its budget", () => {
    const report = JSON.parse(
      execFileSync("node", [SURFACE, "--json"], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    );
    expect(report.overBudget).toBe(false);
    expect(report.commandCount).toBeLessThanOrEqual(24);
  });
});
