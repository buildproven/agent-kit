import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const CLI = path.resolve(import.meta.dirname, "../autonomous-loop-runtime.js");
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}
function repository(root) {
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Wake test"]);
  git(root, ["config", "user.email", "wake@example.invalid"]);
  git(root, ["remote", "add", "origin", "https://example.invalid/wake.git"]);
  writeFileSync(path.join(root, "README.md"), "wake fixture\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
}
function fixture() {
  const root = realpathSync(makeTempDir("quality-wake-"));
  const target = path.join(root, "target");
  const controller = path.join(root, "controller");
  repository(target);
  repository(controller);
  mkdirSync(path.join(controller, "scripts"));
  writeFileSync(
    path.join(controller, "scripts/quality-run.js"),
    "// registration-only controller fixture\n",
  );
  writeFileSync(path.join(controller, "package-lock.json"), "{}\n");
  git(controller, ["add", "."]);
  git(controller, ["commit", "-qm", "controller"]);
  const head = git(target, ["rev-parse", "HEAD"]);
  const commonDir = realpathSync(path.join(target, ".git"));
  const key = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
  const invocationId = "wake-fixture";
  const stateRoot = path.join(
    root,
    "bs-quality",
    key,
    "pr-none",
    head,
    invocationId,
  );
  mkdirSync(stateRoot, { recursive: true });
  const manifestPath = path.join(stateRoot, "invocation.json");
  const createdAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    invocationId,
    stateRoot,
    createdAt,
    repo: {
      realpath: target,
      key,
      pr: null,
      gitCommonDir: commonDir,
      origin: "https://example.invalid/wake.git",
    },
    revisions: { baseRef: "main", baseSha: head, currentHead: head },
    options: { merge: false },
    governor: {
      startedAtEpoch: Math.floor(Date.now() / 1000),
      lifecycleTTLSeconds: 3600,
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    root,
    target,
    controller,
    manifestPath,
    manifest,
    stopAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
function register(fx, extra = []) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      "register-quality",
      "--manifest",
      fx.manifestPath,
      "--stop-at",
      fx.stopAt,
      "--controller",
      fx.controller,
      "--state-dir",
      path.join(fx.root, "wakes"),
      ...extra,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: fx.root },
      timeout: 10_000,
    },
  );
}

describe("quality wake registration", () => {
  it("binds a real campaign and clean controller without changing the campaign", () => {
    const fx = fixture();
    const before = readFileSync(fx.manifestPath, "utf8");
    const result = register(fx);
    expect(result.status, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.status).toBe("registered");
    const record = JSON.parse(readFileSync(response.registrationPath, "utf8"));
    expect(record).toMatchObject({
      schemaVersion: 1,
      manifestPath: fx.manifestPath,
      invocationId: fx.manifest.invocationId,
      repoKey: fx.manifest.repo.key,
      target: fx.target,
      createdAt: fx.manifest.createdAt,
      stopAt: fx.stopAt,
      controller: {
        root: fx.controller,
        head: git(fx.controller, ["rev-parse", "HEAD"]),
      },
    });
    expect(statSync(response.registrationPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(fx.manifestPath, "utf8")).toBe(before);
    const stat = statSync(response.registrationPath);
    const again = register(fx);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).status).toBe("already-registered");
    expect(statSync(response.registrationPath).mtimeMs).toBe(stat.mtimeMs);
  });

  it("refuses a later deadline for an existing registration", () => {
    const fx = fixture();
    expect(register(fx).status).toBe(0);
    const result = register(fx, [
      "--stop-at",
      new Date(Date.parse(fx.stopAt) + 1000).toISOString(),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "registration already binds different inputs",
    );
  });

  it("refuses a deadline beyond the original lifecycle allowance", () => {
    const fx = fixture();
    const result = register(fx, [
      "--stop-at",
      new Date(Date.now() + 7_200_000).toISOString(),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("original lifecycle");
  });

  it("refuses dirty controller code", () => {
    const fx = fixture();
    writeFileSync(
      path.join(fx.controller, "scripts/quality-run.js"),
      "changed\n",
    );
    const result = register(fx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("controller must be clean");
  });

  it("refuses a shared registration directory", () => {
    const fx = fixture();
    mkdirSync(path.join(fx.root, "wakes"));
    chmodSync(path.join(fx.root, "wakes"), 0o777);
    const result = register(fx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private owner directory");
  });

  it("refuses symlinked state instead of writing through it", () => {
    const fx = fixture();
    const other = path.join(fx.root, "other-state");
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(other, path.join(fx.root, "wakes"));
    const result = register(fx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private owner directory");
  });

  it("refuses target-contained registration state", () => {
    const fx = fixture();
    const result = register(fx, ["--state-dir", path.join(fx.target, "wakes")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside target and controller");
  });

  it("rejects changed creation identity without overwriting the registration", () => {
    const fx = fixture();
    const first = register(fx);
    expect(first.status, first.stderr).toBe(0);
    const { registrationPath } = JSON.parse(first.stdout);
    const before = readFileSync(registrationPath, "utf8");
    fx.manifest.createdAt = new Date(
      Date.parse(fx.manifest.createdAt) - 1000,
    ).toISOString();
    writeFileSync(fx.manifestPath, JSON.stringify(fx.manifest));
    const result = register(fx);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "registration already binds different inputs",
    );
    expect(readFileSync(registrationPath, "utf8")).toBe(before);
  });
});
