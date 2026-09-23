import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WRAPPER = path.join(ROOT, "scripts", "provider-worker-sandbox.sh");
const REAL_RUNTIME = path.join(ROOT, "node_modules", ".bin", "srt");

function executable(file, body) {
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o755);
}

function fixture({ permissiveCanary = false } = {}) {
  const root = makeTempDir("provider-worker-sandbox-");
  const repo = path.join(root, "repo");
  const target = path.join(root, "target");
  const output = path.join(root, "output");
  const bin = path.join(root, "bin");
  const runtime = path.join(bin, "srt");
  const worker = path.join(bin, "worker");
  spawnSync("mkdir", ["-p", repo, output, bin], { encoding: "utf8" });
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
  expect(
    spawnSync("git", ["-C", repo, "config", "user.email", "tests@example.test"])
      .status,
  ).toBe(0);
  expect(
    spawnSync("git", ["-C", repo, "config", "user.name", "Tests"]).status,
  ).toBe(0);
  expect(
    spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "fixture"])
      .status,
  ).toBe(0);
  expect(
    spawnSync("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "--detach",
      "-q",
      target,
      "HEAD",
    ]).status,
  ).toBe(0);
  expect(
    spawnSync("git", ["-C", target, "config", "core.hooksPath", ".husky/_"])
      .status,
  ).toBe(0);
  executable(
    runtime,
    `settings=""\nif [ "\${1:-}" = "--settings" ]; then settings="$2"; shift 2; fi\n[ -s "$settings" ] || exit 70\nif [ "\${1:-}" = "/bin/cat" ]; then ${permissiveCanary ? 'exec "$@"' : "exit 1"}; fi\ncp "$settings" "$PWD/captured-policy.json"\n[ "\${1:-}" != "--" ] || shift\nexec "$@"`,
  );
  executable(
    worker,
    'env | cut -d= -f1 | sort > "$1/env-names"\nprintf "%s\\n" "$HOME" > "$1/home"\ntouch "$1/worker-ran"',
  );
  return { root, target, output, runtime, worker };
}

function launch(fx, extra = {}) {
  return spawnSync(
    "bash",
    [
      WRAPPER,
      "--target-dir",
      fx.target,
      "--output-dir",
      fx.output,
      "--provider",
      "codex",
      "--",
      fx.worker,
      fx.output,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fx.root,
        BS_PROVIDER_SANDBOX_BIN: fx.runtime,
        BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        GH_TOKEN: "must-not-reach-worker",
        GITHUB_TOKEN: "must-not-reach-worker",
        GH_ENTERPRISE_TOKEN: "must-not-reach-worker",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        ...extra,
      },
    },
  );
}

describe("provider worker sandbox", () => {
  it("fails closed before launch when Sandbox Runtime is unavailable", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        WRAPPER,
        "--target-dir",
        fx.target,
        "--output-dir",
        fx.output,
        "--provider",
        "claude",
        "--",
        "/bin/true",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fx.root,
          BS_PROVIDER_SANDBOX_BIN: "/missing/srt",
          BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        },
      },
    );
    expect(result.status).toBe(74);
    expect(result.stderr).toContain("Sandbox Runtime is unavailable");
  });

  it("runs only after the deny-read canary and strips ambient credentials", () => {
    const fx = fixture();
    const result = launch(fx);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(true);
    const names = readFileSync(path.join(fx.output, "env-names"), "utf8");
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "SSH_AUTH_SOCK",
    ]) {
      expect(names).not.toContain(name);
    }
    expect(readFileSync(path.join(fx.output, "home"), "utf8").trim()).toBe(
      process.env.HOME,
    );
  });

  it("does not launch a worker when the runtime permits its denied-read canary", () => {
    const fx = fixture({ permissiveCanary: true });
    const result = launch(fx);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "denied-read canary unexpectedly succeeded",
    );
    expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(false);
  });

  it("refuses a direct invocation before it starts a worker", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        WRAPPER,
        "--target-dir",
        fx.target,
        "--output-dir",
        fx.output,
        "--provider",
        "codex",
        "--",
        "/bin/true",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, BS_PROVIDER_SANDBOX_BIN: fx.runtime },
      },
    );
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "governed detached-worktree invocation is required",
    );
  });

  it("passes runtime-looking wrapped arguments to the child unchanged", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        WRAPPER,
        "--target-dir",
        fx.target,
        "--output-dir",
        fx.output,
        "--provider",
        "codex",
        "--",
        "/bin/sh",
        "-c",
        'test "$1" = "--settings" && test "$2" = "-c"',
        "_",
        "--settings",
        "-c",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BS_PROVIDER_SANDBOX_BIN: fx.runtime,
          BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("writes policy that denies credential paths and the per-launch sentinel", () => {
    const fx = fixture();
    const result = launch(fx);
    expect(result.status).toBe(0);
    const policy = JSON.parse(
      readFileSync(path.join(fx.target, "captured-policy.json"), "utf8"),
    );
    expect(policy.filesystem.denyRead).toContain(`${process.env.HOME}/.ssh`);
    expect(policy.filesystem.denyRead).toContain(
      `${process.env.HOME}/.config/gh`,
    );
    expect(policy.filesystem.denyRead).toContain(
      `${process.env.HOME}/.git-credentials`,
    );
    expect(policy.filesystem.allowRead).toContain(
      path.join(ROOT, "node_modules"),
    );
    expect(policy.filesystem.allowRead).toContain(
      `${process.env.HOME}/.local/bin`,
    );
    expect(policy.filesystem.allowRead).not.toContain(
      `${process.env.HOME}/.local`,
    );
    expect(policy.filesystem.denyRead).toContain("/");
    expect(policy.filesystem.allowRead).toContain(`${process.env.HOME}/.codex`);
    expect(policy.filesystem.allowRead).not.toContain(
      `${process.env.HOME}/.claude`,
    );
    expect(policy.filesystem.denyWrite).toContain("/tmp/claude");
    expect(policy.filesystem.denyWrite).toContain(
      path.join(realpathSync(fx.target), ".git"),
    );
    expect(policy.filesystem.denyWrite).toContain(
      path.join(realpathSync(fx.target), ".husky", "_"),
    );
    expect(
      policy.filesystem.denyRead.some((value) => value.endsWith("/sentinel")),
    ).toBe(true);
  });

  it("does not derive denied credential paths from a spoofed HOME", () => {
    const fx = fixture();
    const spoofedHome = path.join(fx.root, "spoofed-home");
    const result = launch(fx, { HOME: spoofedHome });
    expect(result.status).toBe(0);
    const policy = JSON.parse(
      readFileSync(path.join(fx.target, "captured-policy.json"), "utf8"),
    );
    const actualHome = process.env.HOME;
    expect(policy.filesystem.denyRead).toContain(actualHome);
    expect(policy.filesystem.denyRead).not.toContain(spoofedHome);
  });

  it("rejects a target that would grant access to the account home", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        WRAPPER,
        "--target-dir",
        process.env.HOME,
        "--output-dir",
        fx.output,
        "--provider",
        "codex",
        "--",
        "/bin/true",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BS_PROVIDER_SANDBOX_BIN: fx.runtime,
          BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not contain the account home");
  });

  it.skipIf(process.platform !== "darwin" || !existsSync(REAL_RUNTIME))(
    "requires the installed runtime to enforce the canary before a real worker runs",
    () => {
      const fx = fixture();
      const worker = path.join(fx.target, "real-worker");
      executable(worker, 'touch "$1/worker-ran"');
      const result = spawnSync(
        "bash",
        [
          WRAPPER,
          "--target-dir",
          fx.target,
          "--output-dir",
          fx.output,
          "--provider",
          "codex",
          "--",
          "/bin/sh",
          realpathSync(worker),
          realpathSync(fx.output),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: fx.root,
            BS_PROVIDER_SANDBOX_BIN: REAL_RUNTIME,
            BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(true);
    },
  );
});
