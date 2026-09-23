import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
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

function fixture({ permissiveCanary = false, runtimeAvailable = true } = {}) {
  const root = makeTempDir("provider-worker-sandbox-");
  const repo = path.join(root, "repo");
  const target = path.join(root, "target");
  const output = path.join(root, "output");
  const install = path.join(root, "install");
  const scripts = path.join(install, "scripts");
  const bin = path.join(install, "node_modules", ".bin");
  const wrapper = path.join(scripts, "provider-worker-sandbox.sh");
  const runtime = path.join(bin, "srt");
  const worker = path.join(root, "worker");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  spawnSync("mkdir", ["-p", repo, output], { encoding: "utf8" });
  copyFileSync(WRAPPER, wrapper);
  chmodSync(wrapper, 0o755);
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
  const head = spawnSync("git", ["-C", target, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const gitDir = spawnSync(
    "git",
    ["-C", target, "rev-parse", "--path-format=absolute", "--git-dir"],
    { encoding: "utf8" },
  ).stdout.trim();
  const receipt = path.join(gitDir, "buildproven-provider-sandbox.json");
  writeFileSync(
    receipt,
    JSON.stringify({
      schemaVersion: 1,
      targetHead: head,
      outputDir: realpathSync(output),
      nodeBin: realpathSync(process.execPath),
    }),
  );
  if (runtimeAvailable) {
    writeFileSync(
      runtime,
      `#!/usr/bin/env node
const { copyFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
let args = process.argv.slice(2);
let settings = "";
if (args[0] === "--settings") { settings = args[1]; args = args.slice(2); }
if (!settings) process.exit(70);
if (args[0] === "--") args = args.slice(1);
if (args[0] === "/bin/cat") {
  if (${permissiveCanary ? "true" : '!args[1].endsWith("sentinel")'}) process.stdout.write(readFileSync(args[1]));
  else process.stderr.write("Operation not permitted\\n");
  process.exit(${permissiveCanary ? "0" : 'args[1].endsWith("sentinel") ? 1 : 0'});
}
copyFileSync(settings, process.cwd() + "/captured-policy.json");
const child = spawnSync(args[0], args.slice(1), { stdio: "inherit", env: process.env });
process.exit(child.status ?? 1);
`,
    );
    chmodSync(runtime, 0o755);
  }
  executable(
    worker,
    'env | cut -d= -f1 | sort > "$1/env-names"\nprintf "%s\\n" "$HOME" > "$1/home"\ntouch "$1/worker-ran"',
  );
  return { root, target, output, runtime, worker, wrapper, receipt };
}

function launch(fx, extra = {}) {
  return spawnSync(
    "bash",
    [
      fx.wrapper,
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
    const fx = fixture({ runtimeAvailable: false });
    const result = spawnSync(
      "bash",
      [
        fx.wrapper,
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
          BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        },
      },
    );
    expect(result.status).toBe(74);
    expect(result.stderr).toContain("Sandbox Runtime is unavailable");
  });

  it("does not accept a caller-supplied runtime path", () => {
    const fx = fixture({ runtimeAvailable: false });
    const replacement = path.join(fx.root, "replacement-runtime");
    executable(replacement, "exit 0");
    const result = launch(fx, { BS_PROVIDER_SANDBOX_BIN: replacement });
    expect(result.status).toBe(74);
    expect(result.stderr).toContain("Sandbox Runtime is unavailable");
  });

  it("uses the receipt-bound Node instead of a PATH-prepended replacement", () => {
    const fx = fixture();
    const replacement = path.join(fx.root, "node");
    executable(replacement, "exit 99");
    const result = launch(fx, { PATH: `${fx.root}:${process.env.PATH}` });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(true);
  });

  it("uses the fixed receipt parser instead of a PATH-prepended replacement", () => {
    const fx = fixture();
    const replacement = path.join(fx.root, "jq");
    executable(replacement, "exit 99");
    const result = launch(fx, { PATH: `${fx.root}:${process.env.PATH}` });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(true);
  });

  it("requires a clean controller receipt bound to the snapshot head", () => {
    const fx = fixture();
    unlinkSync(fx.receipt);
    let result = launch(fx);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "snapshot receipt is missing or mismatched",
    );

    writeFileSync(path.join(fx.target, "untracked.txt"), "dirty\n");
    writeFileSync(
      fx.receipt,
      JSON.stringify({
        schemaVersion: 1,
        targetHead: spawnSync("git", ["-C", fx.target, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim(),
        outputDir: realpathSync(fx.output),
        nodeBin: realpathSync(process.execPath),
      }),
    );
    result = launch(fx);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("governed target must be clean");
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
    expect(result.stderr).toContain("denied-read canary was not enforced");
    expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(false);
  });

  it("refuses a direct invocation before it starts a worker", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        fx.wrapper,
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
        env: { ...process.env },
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
        fx.wrapper,
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
      realpathSync(path.join(fx.root, "install", "node_modules")),
    );
    expect(policy.filesystem.allowRead).toContain(
      `${process.env.HOME}/.local/bin`,
    );
    expect(policy.filesystem.allowRead).not.toContain(
      `${process.env.HOME}/.local`,
    );
    expect(policy.filesystem.denyRead).toContain("/");
    expect(policy.filesystem.denyRead).toContain(`${process.env.HOME}/.codex`);
    expect(policy.filesystem.denyRead).toContain(`${process.env.HOME}/.claude`);
    expect(policy.filesystem.allowRead).not.toContain(
      `${process.env.HOME}/.codex`,
    );
    expect(policy.filesystem.denyWrite).toContain("/tmp/claude");
    expect(policy.filesystem.denyWrite).toContain(
      path.join(realpathSync(fx.target), ".git"),
    );
    expect(policy.filesystem.denyWrite).toContain(
      path.join(realpathSync(fx.target), ".husky", "_"),
    );
    expect(policy.filesystem.denyWrite).toContain(
      path.join(realpathSync(fx.target), ".husky"),
    );
    expect(policy.filesystem.denyWrite).toContain(
      path.join(realpathSync(fx.target), "node_modules", ".bin"),
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
        fx.wrapper,
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
          BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not contain the account home");
  });

  it("rejects an output directory inside a credential root", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        fx.wrapper,
        "--target-dir",
        fx.target,
        "--output-dir",
        path.join(process.env.HOME, ".codex"),
        "--provider",
        "codex",
        "--",
        "/bin/true",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, BS_GOVERNED_PROVIDER_SNAPSHOT: "1" },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("credential path");
  });

  it("rejects a normal checkout even when the invocation marker is present", () => {
    const fx = fixture();
    const result = spawnSync(
      "bash",
      [
        fx.wrapper,
        "--target-dir",
        path.join(fx.root, "repo"),
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
          BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
        },
      },
    );
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("must have detached HEAD");
  });

  it.skipIf(process.platform !== "darwin" || !existsSync(REAL_RUNTIME))(
    "requires the installed runtime to enforce the canary before a real worker runs",
    () => {
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
          'touch "$1/worker-ran"',
          "_",
          realpathSync(fx.output),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: fx.root,
            BS_GOVERNED_PROVIDER_SNAPSHOT: "1",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(fx.output, "worker-ran"))).toBe(true);
    },
  );
});
