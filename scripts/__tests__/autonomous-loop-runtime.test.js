import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RUNTIME = join(ROOT, "scripts", "autonomous-loop-runtime.js");
const temporaryRoots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "autonomous-loop-runtime-"));
  temporaryRoots.push(root);
  return {
    root,
    state: join(root, "operator-state"),
    repo: join(root, "repo"),
  };
}

function executable(file, body) {
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function usageAdapter(root, payload) {
  return executable(
    join(root, `usage-${temporaryRoots.length}.sh`),
    `printf '%s' '${JSON.stringify(payload)}'`,
  );
}

function runtime(args, options = {}) {
  return spawnSync("node", [RUNTIME, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function response(result) {
  return JSON.parse(result.status === 0 ? result.stdout : result.stderr);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("autonomous-loop runtime", () => {
  it("installs and resolves the adapter on a clean computer configuration", () => {
    const fx = fixture();
    const config = join(fx.root, "fresh-config");
    const install = spawnSync(
      "bash",
      [join(ROOT, "scripts/setup-claude-sync.sh"), "--repair"],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: config } },
    );
    expect(install.status, install.stdout + install.stderr).toBe(0);
    const invoke = spawnSync(
      "node",
      [join(config, "scripts/provider-usage-adapter.js")],
      { encoding: "utf8" },
    );
    expect(invoke.status).toBe(1);
    expect(invoke.stderr).toContain("--provider codex|claude");
  });

  it.each(["codex", "claude"])(
    "admits and releases %s through the installed reader contract",
    (provider) => {
      const fx = fixture();
      executable(
        join(fx.root, "codexbar"),
        `printf '%s' '${JSON.stringify([{ provider, usage: { updatedAt: new Date().toISOString(), primary: { usedPercent: 12 } } }])}'`,
      );
      const common = [
        "--id",
        `portable-${provider}`,
        "--state-dir",
        fx.state,
        "--owner-pid",
        String(process.pid),
      ];
      const result = runtime(
        ["admit", "--kind", "ralph", "--provider", provider, ...common],
        { env: { PATH: `${fx.root}:${process.env.PATH}` } },
      );
      expect(result.status).toBe(0);
      expect(response(result).usage).toEqual({
        provider,
        windows: { primary: 12 },
      });
      expect(response(runtime(["release", ...common])).released).toBe(true);
    },
  );

  it("rejects numeric-looking missing legacy evidence", () => {
    const fx = fixture();
    const result = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "invalid-legacy",
      "--state-dir",
      fx.state,
      "--owner-pid",
      String(process.pid),
      "--usage-command",
      usageAdapter(fx.root, { fiveHourPercent: null, sevenDayPercent: false }),
    ]);
    expect(response(result).code).toBe("USAGE_UNAVAILABLE");
  });

  it("shares the two-loop cap across otherwise independent repositories", () => {
    const fx = fixture();
    const adapter = usageAdapter(fx.root, {
      fiveHourPercent: 12,
      sevenDayPercent: 18,
    });
    const common = [
      "--state-dir",
      fx.state,
      "--usage-command",
      adapter,
      "--owner-pid",
      String(process.pid),
      "--max-loops",
      "2",
    ];

    const first = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "repo-one/run",
      ...common,
    ]);
    const second = runtime([
      "admit",
      "--kind",
      "quality",
      "--id",
      "repo-two/run",
      ...common,
    ]);
    const third = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "repo-three/run",
      ...common,
    ]);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(response(third)).toMatchObject({
      ok: false,
      code: "CONCURRENCY_CAP",
    });
    expect(response(first).usage).toEqual({
      fiveHourPercent: 12,
      sevenDayPercent: 18,
    });
  });

  it("fails closed when account-usage evidence is absent or at the configured cap", () => {
    const fx = fixture();
    const unavailable = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "unavailable",
      "--state-dir",
      fx.state,
      "--usage-command",
      join(fx.root, "not-installed"),
      "--owner-pid",
      String(process.pid),
    ]);
    expect(response(unavailable)).toMatchObject({
      ok: false,
      code: "USAGE_UNAVAILABLE",
    });

    const capped = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "capped",
      "--state-dir",
      fx.state,
      "--usage-command",
      usageAdapter(fx.root, { fiveHourPercent: 70, sevenDayPercent: 9 }),
      "--owner-pid",
      String(process.pid),
      "--max-utilization-percent",
      "70",
    ]);
    expect(response(capped)).toMatchObject({ ok: false, code: "USAGE_CAP" });

    const telemetry = readFileSync(join(fx.state, "telemetry.jsonl"), "utf8");
    expect(telemetry).toContain('"result":"usage-unavailable"');
    expect(telemetry).toContain('"result":"usage-cap"');
    expect(telemetry).not.toContain("not-installed");
  });

  it("requires the long-lived loop owner rather than guessing from a shell parent", () => {
    const fx = fixture();
    const result = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "owner-required",
      "--state-dir",
      fx.state,
      "--usage-command",
      usageAdapter(fx.root, { fiveHourPercent: 12, sevenDayPercent: 18 }),
    ]);

    expect(response(result)).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
      error: "--owner-pid is required",
    });
  });

  it("rejects a dead owner and prevents a different process from releasing a slot", () => {
    const fx = fixture();
    const adapter = usageAdapter(fx.root, {
      fiveHourPercent: 12,
      sevenDayPercent: 18,
    });
    const deadOwner = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "dead-owner",
      "--state-dir",
      fx.state,
      "--usage-command",
      adapter,
      "--owner-pid",
      String(process.pid + 1_000_000),
    ]);
    expect(response(deadOwner)).toMatchObject({
      ok: false,
      code: "OWNER_NOT_LIVE",
    });

    const admitted = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "owned-slot",
      "--state-dir",
      fx.state,
      "--usage-command",
      adapter,
      "--owner-pid",
      String(process.pid),
    ]);
    expect(admitted.status).toBe(0);

    const wrongOwner = runtime([
      "release",
      "--id",
      "owned-slot",
      "--state-dir",
      fx.state,
      "--owner-pid",
      "1",
    ]);
    expect(response(wrongOwner)).toMatchObject({
      ok: false,
      code: "OWNER_MISMATCH",
    });

    const released = runtime([
      "release",
      "--id",
      "owned-slot",
      "--state-dir",
      fx.state,
      "--owner-pid",
      String(process.pid),
    ]);
    expect(response(released)).toMatchObject({ ok: true, released: true });
  });

  it("repairs only an explicitly confirmed corrupt admission record", () => {
    const fx = fixture();
    const admitted = runtime([
      "admit",
      "--kind",
      "ralph",
      "--id",
      "corrupt-slot",
      "--state-dir",
      fx.state,
      "--usage-command",
      usageAdapter(fx.root, { fiveHourPercent: 12, sevenDayPercent: 18 }),
      "--owner-pid",
      String(process.pid),
    ]);
    const recordFile = response(admitted).recordFile;
    const recordHash = recordFile
      .split("/")
      .at(-1)
      .replace(/\.json$/, "");
    writeFileSync(recordFile, "{not valid JSON");

    const unconfirmed = runtime([
      "repair",
      "--record-hash",
      recordHash,
      "--state-dir",
      fx.state,
      "--confirm",
      "no",
    ]);
    expect(response(unconfirmed)).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });

    const repaired = runtime([
      "repair",
      "--id",
      "corrupt-slot",
      "--state-dir",
      fx.state,
      "--confirm",
      "remove-corrupt-record",
    ]);
    expect(response(repaired)).toMatchObject({ ok: true, repaired: true });
  });

  it("persists a context-cap handoff without changing completed backlog state", () => {
    const fx = fixture();
    const state = join(fx.root, "ralph-state.json");
    writeFileSync(
      state,
      JSON.stringify({
        queue: ["BUI-414", "BUI-415"],
        completed: ["BUI-414"],
        current: "BUI-415",
      }),
    );

    const result = runtime([
      "context-break",
      "--state",
      state,
      "--observed-tokens",
      "80000",
      "--cap-tokens",
      "80000",
    ]);
    const persisted = JSON.parse(readFileSync(state, "utf8"));

    expect(response(result)).toMatchObject({ ok: true, breakRequired: true });
    expect(persisted).toMatchObject({
      queue: ["BUI-414", "BUI-415"],
      completed: ["BUI-414"],
      current: "BUI-415",
      continuation: {
        reason: "context-cap",
        observedTokens: 80000,
        capTokens: 80000,
      },
    });
  });

  it("accepts a zero-token context observation without requesting a handoff", () => {
    const fx = fixture();
    const state = join(fx.root, "ralph-state.json");
    writeFileSync(state, JSON.stringify({ current: "BUI-414" }));

    const result = runtime([
      "context-break",
      "--state",
      state,
      "--observed-tokens",
      "0",
    ]);

    expect(response(result)).toMatchObject({
      ok: true,
      breakRequired: false,
      observedTokens: 0,
    });
  });

  it("launches a fresh campaign without passing a parent session or resume flag", () => {
    const fx = fixture();
    const handoff = join(fx.root, "handoff.json");
    const capture = join(fx.root, "claude-call.json");
    writeFileSync(
      handoff,
      JSON.stringify({ continuation: { reason: "context-cap" } }),
    );
    const fakeClaude = executable(
      join(fx.root, "claude"),
      `node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), session: process.env.CLAUDE_CODE_SESSION_ID || null }))' '${capture}' "$@"; printf '%s' '{"is_error":false,"result":"started"}'`,
    );

    const result = runtime(
      [
        "fresh-launch",
        "--handoff",
        handoff,
        "--target-dir",
        fx.root,
        "--workflow",
        "ralph",
        "--claude-bin",
        fakeClaude,
      ],
      { env: { CLAUDE_CODE_SESSION_ID: "parent-session" } },
    );
    const launched = JSON.parse(readFileSync(capture, "utf8"));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      launched: true,
    });
    expect(launched.session).toBeNull();
    expect(launched.argv).toContain("--no-session-persistence");
    expect(launched.argv).not.toContain("--resume");
    expect(launched.argv).not.toContain("--continue");
    expect(launched.argv).not.toContain("--fork-session");
    expect(launched.argv.at(-1)).toContain(handoff);
    expect(JSON.parse(readFileSync(handoff, "utf8"))).not.toHaveProperty(
      "continuation",
    );
  });

  it("keeps the handoff when a fresh provider exits cleanly without a success result", () => {
    const fx = fixture();
    const handoff = join(fx.root, "handoff.json");
    writeFileSync(
      handoff,
      JSON.stringify({ continuation: { reason: "context-cap" } }),
    );
    const invalidClaude = executable(
      join(fx.root, "invalid-claude"),
      "printf '%s' '{\"is_error\":false,\"result\":null}'",
    );

    const result = runtime([
      "fresh-launch",
      "--handoff",
      handoff,
      "--target-dir",
      fx.root,
      "--workflow",
      "ralph",
      "--claude-bin",
      invalidClaude,
    ]);

    expect(response(result)).toMatchObject({
      ok: false,
      code: "LAUNCH_FAILED",
    });
    expect(JSON.parse(readFileSync(handoff, "utf8"))).toHaveProperty(
      "continuation",
    );
  });
});
