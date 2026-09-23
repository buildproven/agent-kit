import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MANAGER = path.join(ROOT, "scripts", "worktree-manager.js");
const COMMIT_GUARD = path.join(ROOT, "scripts", "block-commit-main.sh");
const temporaryRoots = [];

function trackTemporaryRoot(root) {
  const resolved = path.resolve(root);
  const allowedPrefixes = [path.join(os.tmpdir(), "wt-manager-")];
  if (!allowedPrefixes.some((prefix) => resolved.startsWith(prefix))) {
    throw new Error(`refusing to clean unsafe test path: ${resolved}`);
  }
  temporaryRoots.push(resolved);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
  });
  if (options.ok !== false && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function git(repo, ...args) {
  return run("git", ["-C", repo, ...args]).stdout.trim();
}

function fixture(name = "repo") {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wt-manager-"));
  trackTemporaryRoot(parent);
  const repo = path.join(parent, name);
  const remote = path.join(parent, "remote.git");
  mkdirSync(repo);
  run("git", ["init", "--initial-branch=main", repo]);
  git(repo, "config", "user.email", "tests@example.com");
  git(repo, "config", "user.name", "Worktree Tests");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  run("git", ["init", "--bare", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  run("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, "fetch", "origin");
  git(repo, "remote", "set-head", "origin", "-a");
  return { parent, remote, repo };
}

function persistentFixture() {
  // Keep fixtures outside the repository. Other tests copy the checkout to
  // exercise installer upgrades, so transient in-tree directories make the
  // full suite race when Vitest runs files concurrently.
  const repo = mkdtempSync(path.join(os.tmpdir(), "wt-manager-"));
  trackTemporaryRoot(repo);
  run("git", ["init", "--initial-branch=main", repo]);
  git(repo, "config", "user.email", "tests@example.com");
  git(repo, "config", "user.name", "Worktree Tests");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return repo;
}

function commitGuard(command) {
  return spawnSync("bash", [COMMIT_GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });
}

function manager(args, options = {}) {
  const result = run("node", [MANAGER, ...args], {
    ...options,
    ok: options.ok,
  });
  const text = result.status === 0 ? result.stdout : result.stderr;
  return { result, json: JSON.parse(text) };
}

function create(repo, branch, extra = []) {
  return manager([
    "create",
    "--repo",
    repo,
    "--branch",
    branch,
    "--creator",
    "test",
    ...extra,
  ]).json;
}

function fakeGh(parent) {
  const bin = path.join(parent, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gh version test"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case "\${GH_PR_STATE:-NONE}" in
    OPEN) echo '[{"number":17,"state":"OPEN","mergedAt":null,"closedAt":null,"headRefName":"feature/test"}]' ;;
    MERGED) printf '[{"number":17,"state":"MERGED","mergedAt":"2020-01-01T00:00:00Z","closedAt":"2020-01-01T00:00:00Z","headRefName":"feature/test","headRefOid":"%s"}]\n' "\${GH_PR_HEAD:-}" ;;
    CLOSED) echo '[{"number":17,"state":"CLOSED","mergedAt":null,"closedAt":"2020-01-01T00:00:00Z","headRefName":"feature/test"}]' ;;
    *) echo '[]' ;;
  esac
  exit 0
fi
exit 1
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

function ghEnv(bin, state, headRefOid = "") {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_PR_STATE: state,
    GH_PR_HEAD: headRefOid,
  };
}

function qualityStateRoot(repo, temporaryRoot, invocation) {
  mkdirSync(temporaryRoot, { recursive: true });
  const common = realpathSync(
    git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const key = createHash("sha256").update(common).digest("hex").slice(0, 16);
  return path.join(
    realpathSync(temporaryRoot),
    "bs-quality",
    key,
    "pr-none",
    "base",
    invocation,
  );
}

function writeQualityManifest(repo, temporaryRoot, invocation, patch = {}) {
  const stateRoot = qualityStateRoot(repo, temporaryRoot, invocation);
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(
    path.join(stateRoot, "invocation.json"),
    `${JSON.stringify(
      {
        invocationId: invocation,
        stateRoot,
        repo: {
          gitCommonDir: realpathSync(
            git(
              repo,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ),
          ),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        gates: [],
        ...patch,
      },
      null,
      2,
    )}\n`,
  );
  return stateRoot;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    run("find", [root, "-depth", "-delete"], { ok: false });
  }
});

describe("worktree-manager public CLI", () => {
  it("resolves the canonical sibling path from the primary checkout", () => {
    const { parent, repo } = fixture("life scape");
    const output = manager([
      "resolve",
      "--repo",
      repo,
      "--branch",
      "feature/demo-benefit-clarity",
    ]).json;
    expect(output.repoRoot).toBe(realpathSync(repo));
    expect(output.worktreeRoot).toBe(
      path.join(realpathSync(parent), ".worktrees", "life scape"),
    );
    expect(output.worktreePath).toBe(
      path.join(
        realpathSync(parent),
        ".worktrees",
        "life scape",
        "feature-demo-benefit-clarity",
      ),
    );
  });

  it("resolves from a linked worktree without nesting under the caller", () => {
    const { repo } = fixture();
    const first = create(repo, "feature/first");
    const output = manager([
      "resolve",
      "--repo",
      first.worktreePath,
      "--branch",
      "feature/second",
    ]).json;
    expect(output.repoRoot).toBe(realpathSync(repo));
    expect(path.dirname(output.worktreeRoot)).not.toContain(first.worktreePath);
  });

  it("normalizes separators and adds a stable suffix only for collisions", () => {
    const { repo } = fixture();
    const first = create(repo, "feature/a_b");
    const output = manager([
      "resolve",
      "--repo",
      repo,
      "--branch",
      "test/a.b",
    ]).json;
    expect(first.slug).toBe("feature-a-b");
    expect(output.slug).toMatch(/^test-a-b$/);

    const collision = manager([
      "resolve",
      "--repo",
      repo,
      "--branch",
      "feature/a.b",
    ]).json;
    expect(collision.slug).toMatch(/^feature-a-b-[a-f0-9]{8}$/);
  });

  it.each(["../escape", "/absolute", "feature/%2f/escape"])(
    "rejects unsafe branch input %s",
    (branch) => {
      const { repo } = fixture();
      const { result, json } = manager(
        ["resolve", "--repo", repo, "--branch", branch],
        { ok: false },
      );
      expect(result.status).not.toBe(0);
      expect(["INVALID_BRANCH", "INVALID_SLUG"]).toContain(json.code);
    },
  );

  it("bases a new worktree on origin's tip even when local default-branch is stale", () => {
    const { repo, remote } = fixture();
    // Advance the remote past local main without updating local main or its
    // remote-tracking ref, reproducing "nobody's run git pull recently".
    const clone = mkdtempSync(path.join(os.tmpdir(), "wt-manager-clone-"));
    trackTemporaryRoot(clone);
    run("git", ["clone", "--quiet", remote, clone]);
    git(clone, "config", "user.email", "tests@example.com");
    git(clone, "config", "user.name", "Worktree Tests");
    writeFileSync(path.join(clone, "OVERRIDES.md"), "new file\n");
    git(clone, "add", "OVERRIDES.md");
    git(clone, "commit", "-m", "add file only present upstream");
    git(clone, "push", "origin", "main");
    const staleTip = git(repo, "rev-parse", "origin/main");
    const freshTip = git(clone, "rev-parse", "main");
    expect(staleTip).not.toBe(freshTip);

    const created = create(repo, "feature/from-fresh-origin");

    expect(git(created.worktreePath, "rev-parse", "HEAD")).toBe(freshTip);
    expect(existsSync(path.join(created.worktreePath, "OVERRIDES.md"))).toBe(
      true,
    );
  });

  it("does not silently fall back when a configured origin cannot refresh", () => {
    const { parent, repo } = fixture();
    git(repo, "remote", "set-url", "origin", path.join(parent, "missing.git"));

    expect(() => create(repo, "feature/failed-refresh")).toThrow(
      /git -C .* fetch origin --quiet failed/,
    );
  });

  it("creates once and reuses the registered branch worktree", () => {
    const { repo } = fixture();
    const first = create(repo, "feature/reuse");
    const second = create(repo, "feature/reuse");
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.worktreePath).toBe(first.worktreePath);
  });

  it("always produces a genuine linked worktree, never a relabeled primary checkout", () => {
    const { repo } = fixture();
    const primaryGitDir = git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    );
    const commonDirBefore = git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    expect(primaryGitDir).toBe(commonDirBefore);

    const created = create(repo, "feature/real-worktree");

    const worktreeGitDir = git(
      created.worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    );
    const worktreeCommonDir = git(
      created.worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    expect(worktreeGitDir).not.toBe(worktreeCommonDir);
    expect(created.worktreePath).not.toBe(realpathSync(repo));
    // The primary checkout itself must remain untouched: still on main, still
    // its own common dir (not relabeled as the new branch's worktree).
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(
      git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ).toBe(commonDirBefore);
  });

  it("refuses to reuse a worktree owned by another invocation", () => {
    const { repo } = fixture();
    create(repo, "feature/owned-reuse", ["--lock-reason", "owner-19"]);
    const { json } = manager(
      ["create", "--repo", repo, "--branch", "feature/owned-reuse"],
      { ok: false },
    );
    expect(json.code).toBe("LOCKED");
  });

  it("refuses an occupied unregistered canonical path", () => {
    const { repo } = fixture();
    const plan = manager([
      "resolve",
      "--repo",
      repo,
      "--branch",
      "feature/occupied",
    ]).json;
    mkdirSync(plan.worktreePath, { recursive: true });
    const { result, json } = manager(
      ["create", "--repo", repo, "--branch", "feature/occupied"],
      { ok: false },
    );
    expect(result.status).not.toBe(0);
    expect(json.code).toBe("PATH_OCCUPIED");
  });

  it("removes a clean merged local-only worktree without force", () => {
    const { repo } = fixture();
    const worktree = create(repo, "feature/clean-remove");
    const output = manager([
      "remove",
      "--repo",
      repo,
      "--branch",
      "feature/clean-remove",
      "--delete-branch",
    ]).json;
    expect(output.removedPath).toBe(worktree.worktreePath);
    expect(output.branchDeleted).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("removes a merged PR worktree after GitHub deletes its squash-merged remote branch", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    writeFileSync(path.join(worktree.worktreePath, "change.txt"), "change\n");
    git(worktree.worktreePath, "add", "change.txt");
    git(worktree.worktreePath, "commit", "-m", "feature change");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");

    git(repo, "merge", "--squash", "feature/test");
    git(repo, "commit", "-m", "squash feature");
    git(repo, "push", "origin", "main");
    writeFileSync(path.join(repo, "later.txt"), "later main change\n");
    git(repo, "add", "later.txt");
    git(repo, "commit", "-m", "later main change");
    git(repo, "push", "origin", "main");
    git(repo, "push", "origin", "--delete", "feature/test");
    git(repo, "fetch", "--prune", "origin");
    git(repo, "branch", "--unset-upstream", "feature/test");
    const mergedPrHead = git(repo, "rev-parse", "feature/test");

    const state = manager(
      ["status", "--repo", repo, "--grace-hours", "0", "--recent-minutes", "0"],
      { env: ghEnv(bin, "MERGED", mergedPrHead) },
    ).json.worktrees[0];
    // A squash merge changes commit ancestry but preserves the source tree.
    // Tree equality proves this clean materialization has no unpushed content.
    expect(state.unpushed).toBe(false);
    expect(state.classification).toBe("clean with merged PR");
    expect(state.removable).toBe(true);

    const output = manager(
      ["remove", "--repo", repo, "--branch", "feature/test"],
      { env: ghEnv(bin, "MERGED", mergedPrHead) },
    ).json;
    expect(output.removedPath).toBe(worktree.worktreePath);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(
      git(repo, "show-ref", "--verify", "refs/heads/feature/test"),
    ).toContain("refs/heads/feature/test");
  });

  it("retains local commits added after the recorded PR head was merged", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    writeFileSync(path.join(worktree.worktreePath, "merged.txt"), "merged\n");
    git(worktree.worktreePath, "add", "merged.txt");
    git(worktree.worktreePath, "commit", "-m", "merged feature change");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    const mergedPrHead = git(repo, "rev-parse", "feature/test");

    git(repo, "merge", "--squash", "feature/test");
    git(repo, "commit", "-m", "squash feature");
    git(repo, "push", "origin", "main");
    git(repo, "push", "origin", "--delete", "feature/test");
    git(repo, "fetch", "--prune", "origin");
    git(repo, "branch", "--unset-upstream", "feature/test");

    writeFileSync(path.join(worktree.worktreePath, "later.txt"), "later\n");
    git(worktree.worktreePath, "add", "later.txt");
    git(worktree.worktreePath, "commit", "-m", "local follow-up");

    const state = manager(["status", "--repo", repo, "--recent-minutes", "0"], {
      env: ghEnv(bin, "MERGED", mergedPrHead),
    }).json.worktrees[0];
    expect(state.classification).toBe("clean with unpushed commits");
    expect(state.removable).toBe(false);

    const { json } = manager(
      ["remove", "--repo", repo, "--branch", "feature/test"],
      { ok: false, env: ghEnv(bin, "MERGED", mergedPrHead) },
    );
    expect(json.code).toBe("UNPUSHED");
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  it("removes an eligible merged worktree with initialized submodules", () => {
    const { parent, repo } = fixture();
    const submoduleSource = path.join(parent, "submodule-source");
    const submoduleRemote = path.join(parent, "submodule.git");
    mkdirSync(submoduleSource);
    run("git", ["init", "--initial-branch=main", submoduleSource]);
    git(submoduleSource, "config", "user.email", "tests@example.com");
    git(submoduleSource, "config", "user.name", "Worktree Tests");
    writeFileSync(path.join(submoduleSource, "README.md"), "submodule\n");
    git(submoduleSource, "add", "README.md");
    git(submoduleSource, "commit", "-m", "initial submodule");
    run("git", ["init", "--bare", submoduleRemote]);
    run("git", [
      "--git-dir",
      submoduleRemote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    git(submoduleSource, "remote", "add", "origin", submoduleRemote);
    git(submoduleSource, "push", "-u", "origin", "main");

    run("git", [
      "-C",
      repo,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleRemote,
      "vendor/submodule",
    ]);
    git(repo, "commit", "-am", "add submodule");
    git(repo, "push", "origin", "main");

    const worktree = create(repo, "feature/submodule-cleanup");
    run("git", [
      "-C",
      worktree.worktreePath,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    const output = manager([
      "remove",
      "--repo",
      repo,
      "--branch",
      "feature/submodule-cleanup",
      "--delete-branch",
    ]).json;

    expect(output.removedPath).toBe(worktree.worktreePath);
    expect(output.forcedForSubmodules).toBe(true);
    expect(output.branchDeleted).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("refuses ignored submodule dirt before force removal", () => {
    const { parent, repo } = fixture();
    const submoduleSource = path.join(parent, "ignored-submodule-source");
    const submoduleRemote = path.join(parent, "ignored-submodule.git");
    mkdirSync(submoduleSource);
    run("git", ["init", "--initial-branch=main", submoduleSource]);
    git(submoduleSource, "config", "user.email", "tests@example.com");
    git(submoduleSource, "config", "user.name", "Worktree Tests");
    writeFileSync(path.join(submoduleSource, "README.md"), "submodule\n");
    git(submoduleSource, "add", "README.md");
    git(submoduleSource, "commit", "-m", "initial submodule");
    run("git", ["init", "--bare", submoduleRemote]);
    run("git", [
      "--git-dir",
      submoduleRemote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    git(submoduleSource, "remote", "add", "origin", submoduleRemote);
    git(submoduleSource, "push", "-u", "origin", "main");

    run("git", [
      "-C",
      repo,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleRemote,
      "vendor/submodule",
    ]);
    git(repo, "commit", "-am", "add submodule");
    git(repo, "push", "origin", "main");

    const worktree = create(repo, "feature/ignored-submodule-dirt");
    run("git", [
      "-C",
      worktree.worktreePath,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    git(
      worktree.worktreePath,
      "config",
      "submodule.vendor/submodule.ignore",
      "all",
    );
    writeFileSync(
      path.join(worktree.worktreePath, "vendor", "submodule", "dirty.txt"),
      "dirty\n",
    );

    const { json } = manager(
      [
        "remove",
        "--repo",
        repo,
        "--branch",
        "feature/ignored-submodule-dirt",
        "--delete-branch",
      ],
      { ok: false },
    );
    expect(json.code).toBe("DIRTY");
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  it("refuses dirty worktrees", () => {
    const { repo } = fixture();
    const worktree = create(repo, "feature/dirty");
    writeFileSync(path.join(worktree.worktreePath, "dirty.txt"), "dirty\n");
    const { json } = manager(
      ["remove", "--repo", repo, "--branch", "feature/dirty"],
      { ok: false },
    );
    expect(json.code).toBe("DIRTY");
  });

  it("fails closed when worktree cleanliness cannot be inspected", () => {
    const { parent, repo } = fixture();
    const worktree = create(repo, "feature/status-failure");
    const bin = path.join(parent, "git-bin");
    mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
case "$*" in
  *"status --porcelain"*) echo "simulated status failure" >&2; exit 2 ;;
  *) exec "${realGit}" "$@" ;;
esac
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const { json } = manager(
      ["remove", "--repo", repo, "--branch", "feature/status-failure"],
      {
        ok: false,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(json.code).toBe("STATUS_UNKNOWN");
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  it("classifies an unreadable worktree as unknown without hiding its peers", () => {
    const { parent, repo } = fixture();
    create(repo, "feature/status-unknown");
    create(repo, "feature/status-readable");
    const bin = path.join(parent, "status-bin");
    mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
case "$*" in
  *"feature-status-unknown status --porcelain"*) echo "simulated status failure" >&2; exit 2 ;;
  *) exec "${realGit}" "$@" ;;
esac
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const { json } = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const unknown = json.worktrees.find(
      (worktree) => worktree.branch === "feature/status-unknown",
    );
    const readable = json.worktrees.find(
      (worktree) => worktree.branch === "feature/status-readable",
    );
    expect(unknown.classification).toBe("unknown/inconclusive");
    expect(unknown.removable).toBe(false);
    expect(readable.classification).not.toBe("unknown/inconclusive");
  });

  it("requires exact ownership and recovery to remove a locked worktree", () => {
    const { repo } = fixture();
    create(repo, "feature/locked", ["--lock-reason", "owner-17"]);
    expect(
      manager(["remove", "--repo", repo, "--branch", "feature/locked"], {
        ok: false,
      }).json.code,
    ).toBe("LOCKED");
    expect(
      manager(
        [
          "remove",
          "--repo",
          repo,
          "--branch",
          "feature/locked",
          "--recover",
          "--owner",
          "wrong",
        ],
        { ok: false },
      ).json.code,
    ).toBe("LOCKED");
  });

  it("retains the lock when recovered removal later fails a safety check", () => {
    const { repo } = fixture();
    const worktree = create(repo, "feature/locked-dirty", [
      "--lock-reason",
      "owner-18",
    ]);
    writeFileSync(path.join(worktree.worktreePath, "dirty.txt"), "dirty\n");
    const { json } = manager(
      [
        "remove",
        "--repo",
        repo,
        "--branch",
        "feature/locked-dirty",
        "--recover",
        "--owner",
        "owner-18",
      ],
      { ok: false },
    );
    expect(json.code).toBe("DIRTY");
    const state = manager(["status", "--repo", repo, "--skip-pr-check"]).json
      .worktrees[0];
    expect(state.locked).toBe(true);
    expect(state.lockReason).toBe("owner-18");
  });

  it("restores ownership when Git cannot remove a recovered worktree", () => {
    const { parent, repo } = fixture();
    const worktree = create(repo, "feature/remove-rollback", [
      "--lock-reason",
      "owner-20",
    ]);
    const bin = path.join(parent, "remove-bin");
    mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
case "$*" in
  *"worktree remove"*) echo "simulated removal failure" >&2; exit 2 ;;
  *) exec "${realGit}" "$@" ;;
esac
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const { json } = manager(
      [
        "remove",
        "--repo",
        repo,
        "--branch",
        "feature/remove-rollback",
        "--recover",
        "--owner",
        "owner-20",
        "--skip-pr-check",
      ],
      {
        ok: false,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(json.code).toBe("COMMAND_FAILED");
    expect(existsSync(worktree.worktreePath)).toBe(true);
    const state = manager([
      "status",
      "--repo",
      repo,
      "--skip-pr-check",
    ]).json.worktrees.find(
      (candidate) => candidate.branch === "feature/remove-rollback",
    );
    expect(state.locked).toBe(true);
    expect(state.lockReason).toBe("owner-20");
  });

  it("restores ownership when a forced submodule retry fails", () => {
    const { parent, repo } = fixture();
    const worktree = create(repo, "feature/forced-remove-rollback", [
      "--lock-reason",
      "owner-22",
    ]);
    const bin = path.join(parent, "force-remove-bin");
    mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
case "$*" in
  *"worktree remove --force"*) echo "simulated forced removal failure" >&2; exit 2 ;;
  *"worktree remove"*) echo "working trees containing submodules cannot be moved or removed" >&2; exit 2 ;;
  *) exec "${realGit}" "$@" ;;
esac
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const { json } = manager(
      [
        "remove",
        "--repo",
        repo,
        "--branch",
        "feature/forced-remove-rollback",
        "--recover",
        "--owner",
        "owner-22",
        "--skip-pr-check",
      ],
      {
        ok: false,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(json.code).toBe("COMMAND_FAILED");
    expect(existsSync(worktree.worktreePath)).toBe(true);
    const state = manager([
      "status",
      "--repo",
      repo,
      "--skip-pr-check",
    ]).json.worktrees.find(
      (candidate) => candidate.branch === "feature/forced-remove-rollback",
    );
    expect(state.locked).toBe(true);
    expect(state.lockReason).toBe("owner-22");
  });

  it("records explicit recovery evidence when removal and relocking both fail", () => {
    const { parent, repo } = fixture();
    const worktree = create(repo, "feature/double-failure", [
      "--lock-reason",
      "owner-21",
    ]);
    const bin = path.join(parent, "double-failure-bin");
    mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
case "$*" in
  *"worktree remove"*|*"worktree lock"*) echo "simulated lifecycle failure" >&2; exit 2 ;;
  *) exec "${realGit}" "$@" ;;
esac
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const { json } = manager(
      [
        "remove",
        "--repo",
        repo,
        "--branch",
        "feature/double-failure",
        "--recover",
        "--owner",
        "owner-21",
        "--skip-pr-check",
      ],
      {
        ok: false,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(json.code).toBe("LOCK_RECOVERY_FAILED");
    expect(json.error).toContain("ownership could not be restored");
    expect(existsSync(worktree.worktreePath)).toBe(true);
    const state = manager([
      "status",
      "--repo",
      repo,
      "--skip-pr-check",
    ]).json.worktrees.find(
      (candidate) => candidate.branch === "feature/double-failure",
    );
    expect(state.metadata.state).toBe("recovery-required");
    expect(state.metadata.lockReason).toBe("owner-21");
    expect(state.classification).toBe("unknown/inconclusive");
    expect(
      manager(
        [
          "remove",
          "--repo",
          repo,
          "--branch",
          "feature/double-failure",
          "--skip-pr-check",
        ],
        { ok: false },
      ).json.code,
    ).toBe("RECOVERY_REQUIRED");
    const repairReport = manager(["repair", "--repo", repo]).json;
    expect(repairReport.worktrees[0].reason).toContain("--owner 'owner-21'");
    manager(["repair", "--repo", repo, "--apply", "--owner", "owner-21"]);
    const recovered = manager(["status", "--repo", repo, "--skip-pr-check"])
      .json.worktrees[0];
    expect(recovered.locked).toBe(true);
    expect(recovered.lockReason).toBe("owner-21");
    expect(recovered.metadata.state).toBe("active");
  });

  it("transfers a lock only when the prior ownership identity is exact", () => {
    const { repo } = fixture();
    create(repo, "feature/handoff", ["--lock-reason", "bs:dev/run-1"]);
    expect(
      manager(
        [
          "lock",
          "--repo",
          repo,
          "--branch",
          "feature/handoff",
          "--reason",
          "bs:quality/run-2",
          "--recover",
          "--takeover-owner",
          "wrong",
        ],
        { ok: false },
      ).json.code,
    ).toBe("LOCKED");
    const transferred = manager([
      "lock",
      "--repo",
      repo,
      "--branch",
      "feature/handoff",
      "--reason",
      "bs:quality/run-2",
      "--recover",
      "--takeover-owner",
      "bs:dev/run-1",
    ]).json;
    expect(transferred.lockReason).toBe("bs:quality/run-2");
  });

  it("requires exact ownership to unlock and records terminal release", () => {
    const { repo } = fixture();
    create(repo, "feature/unlock", ["--lock-reason", "owner-17"]);
    expect(
      manager(
        [
          "unlock",
          "--repo",
          repo,
          "--branch",
          "feature/unlock",
          "--owner",
          "wrong",
        ],
        { ok: false },
      ).json.code,
    ).toBe("OWNER_MISMATCH");
    const unlocked = manager([
      "unlock",
      "--repo",
      repo,
      "--branch",
      "feature/unlock",
      "--owner",
      "owner-17",
      "--terminal",
    ]).json;
    expect(unlocked.unlocked).toBe(true);
  });

  it("releases a quality lock only when its exact manifest records a terminal gate", () => {
    const { parent, repo } = fixture();
    const temporaryRoot = path.join(parent, "quality-state");
    const invocation = "11111111-1111-5111-8111-111111111111";
    const worktree = create(repo, "feature/terminal-quality-lock", [
      "--lock-reason",
      `bs:quality/${invocation}`,
      "--invocation",
      invocation,
    ]);
    const stateRoot = writeQualityManifest(repo, temporaryRoot, invocation, {
      gates: [{ name: "test", status: "timeout" }],
    });
    const written = JSON.parse(
      readFileSync(path.join(stateRoot, "invocation.json"), "utf8"),
    );
    expect(written.stateRoot).toBe(stateRoot);
    expect(written.repo.gitCommonDir).toBe(
      realpathSync(
        git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      ),
    );
    const env = { ...process.env, TMPDIR: temporaryRoot };

    const before = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env,
    }).json.worktrees.find(
      (candidate) => candidate.branch === "feature/terminal-quality-lock",
    );
    expect(before, before?.reason).toMatchObject({
      classification: "stale quality lock",
      releasable: true,
    });

    const reconciled = manager(
      ["reconcile", "--repo", repo, "--apply", "--skip-pr-check"],
      { env },
    ).json;
    expect(reconciled.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "released stale quality lock" }),
      ]),
    );
    expect(existsSync(worktree.worktreePath)).toBe(true);
    const after = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env,
    }).json.worktrees.find(
      (candidate) => candidate.branch === "feature/terminal-quality-lock",
    );
    expect(after.locked).toBe(false);
  });

  it("retains a quality lock when a later result replaces a failed gate", () => {
    const { parent, repo } = fixture();
    const temporaryRoot = path.join(parent, "quality-state");
    const invocation = "12121212-1212-5121-8121-121212121212";
    create(repo, "feature/retried-quality-lock", [
      "--lock-reason",
      `bs:quality/${invocation}`,
      "--invocation",
      invocation,
    ]);
    writeQualityManifest(repo, temporaryRoot, invocation, {
      gates: [
        { name: "test", status: "timeout" },
        { name: "test", status: "success" },
      ],
    });
    const state = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env: { ...process.env, TMPDIR: temporaryRoot },
    }).json.worktrees.find(
      (candidate) => candidate.branch === "feature/retried-quality-lock",
    );
    expect(state).toMatchObject({ classification: "active and locked" });
  });

  it("uses an invalid manifest timestamp's file mtime for stale-lock release", () => {
    const { parent, repo } = fixture();
    const temporaryRoot = path.join(parent, "quality-state");
    const invocation = "13131313-1313-5131-8131-131313131313";
    create(repo, "feature/invalid-quality-time", [
      "--lock-reason",
      `bs:quality/${invocation}`,
      "--invocation",
      invocation,
    ]);
    const stateRoot = writeQualityManifest(repo, temporaryRoot, invocation, {
      updatedAt: "not-a-timestamp",
      createdAt: "also-not-a-timestamp",
    });
    const manifestPath = path.join(stateRoot, "invocation.json");
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(manifestPath, staleAt, staleAt);
    const state = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env: { ...process.env, TMPDIR: temporaryRoot },
    }).json.worktrees.find(
      (candidate) => candidate.branch === "feature/invalid-quality-time",
    );
    expect(state).toMatchObject({
      classification: "stale quality lock",
      releasable: true,
    });
    expect(state.reason).toContain("quality manifest file is older than 24h");
  });

  it("retains a recent quality lock when its manifest is missing", () => {
    const { parent, repo } = fixture();
    const temporaryRoot = path.join(parent, "quality-state");
    const invocation = "22222222-2222-5222-8222-222222222222";
    create(repo, "feature/recent-missing-quality-lock", [
      "--lock-reason",
      `bs:quality/${invocation}`,
      "--invocation",
      invocation,
    ]);
    const state = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env: { ...process.env, TMPDIR: temporaryRoot },
    }).json.worktrees.find(
      (candidate) => candidate.branch === "feature/recent-missing-quality-lock",
    );
    expect(state).toMatchObject({ classification: "active and locked" });
    expect(state.reason).toContain(
      "manifest is missing but lock metadata is recent",
    );
  });

  it("releases a quality lock with a missing manifest only after its metadata is stale", () => {
    const { repo } = fixture();
    const invocation = "33333333-3333-5333-8333-333333333333";
    create(repo, "feature/stale-missing-quality-lock", [
      "--lock-reason",
      `bs:quality/${invocation}`,
      "--invocation",
      invocation,
    ]);
    const common = realpathSync(
      git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const metadataPath = path.join(
      common,
      "worktree-manager",
      `${createHash("sha256")
        .update("feature/stale-missing-quality-lock")
        .digest("hex")
        .slice(0, 8)}.json`,
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    writeFileSync(
      metadataPath,
      `${JSON.stringify(
        {
          ...metadata,
          updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const before = manager([
      "status",
      "--repo",
      repo,
      "--skip-pr-check",
    ]).json.worktrees.find(
      (candidate) => candidate.branch === "feature/stale-missing-quality-lock",
    );
    expect(before, before?.reason).toMatchObject({
      classification: "stale quality lock",
      releasable: true,
    });
    expect(before.reason).toContain(
      "manifest is missing and lock metadata is older than 24h",
    );

    manager(["reconcile", "--repo", repo, "--apply", "--skip-pr-check"]);
    const after = manager([
      "status",
      "--repo",
      repo,
      "--skip-pr-check",
    ]).json.worktrees.find(
      (candidate) => candidate.branch === "feature/stale-missing-quality-lock",
    );
    expect(after.locked).toBe(false);
  });

  it("retains a quality lock when its manifest identity is malformed", () => {
    const { parent, repo } = fixture();
    const temporaryRoot = path.join(parent, "quality-state");
    const invocation = "44444444-4444-5444-8444-444444444444";
    create(repo, "feature/malformed-quality-lock", [
      "--lock-reason",
      `bs:quality/${invocation}`,
      "--invocation",
      invocation,
    ]);
    const stateRoot = writeQualityManifest(repo, temporaryRoot, invocation, {
      invocationId: "55555555-5555-5555-8555-555555555555",
      gates: [{ name: "test", status: "failed" }],
    });

    const state = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env: { ...process.env, TMPDIR: temporaryRoot },
    }).json.worktrees.find(
      (candidate) => candidate.branch === "feature/malformed-quality-lock",
    );
    expect(state).toMatchObject({ classification: "active and locked" });
    expect(state.reason).toContain(
      "manifest invocation does not match the lock",
    );
    expect(existsSync(path.join(stateRoot, "invocation.json"))).toBe(true);
  });

  it("repairs divergent lifecycle ownership only for the Git lock owner", () => {
    const { repo } = fixture();
    create(repo, "feature/ownership-repair", ["--lock-reason", "native-owner"]);
    const metadataName = `${createHash("sha256")
      .update("feature/ownership-repair")
      .digest("hex")
      .slice(0, 8)}.json`;
    const common = git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const metadataPath = path.join(common, "worktree-manager", metadataName);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    writeFileSync(
      metadataPath,
      `${JSON.stringify({ ...metadata, lockReason: "stale-owner" }, null, 2)}\n`,
    );

    expect(
      manager(
        [
          "unlock",
          "--repo",
          repo,
          "--branch",
          "feature/ownership-repair",
          "--owner",
          "native-owner",
        ],
        { ok: false },
      ).json.code,
    ).toBe("LOCK_METADATA_DIVERGED");
    const report = manager(["repair", "--repo", repo]).json;
    expect(report.worktrees[0].reason).toContain("--owner 'native-owner'");
    manager(["repair", "--repo", repo, "--apply", "--owner", "native-owner"]);
    const unlocked = manager([
      "unlock",
      "--repo",
      repo,
      "--branch",
      "feature/ownership-repair",
      "--owner",
      "native-owner",
      "--terminal",
    ]).json;
    expect(unlocked.unlocked).toBe(true);
  });

  it("honors a requested lock when reusing a registered worktree", () => {
    const { repo } = fixture();
    create(repo, "feature/reuse-lock");
    const reused = create(repo, "feature/reuse-lock", [
      "--lock-reason",
      "steward/run-2",
    ]);
    expect(reused.reused).toBe(true);
    const state = manager(["status", "--repo", repo, "--skip-pr-check"]).json
      .worktrees[0];
    expect(state.locked).toBe(true);
    expect(state.lockReason).toBe("steward/run-2");
  });

  it("does not mutate audit metadata before refusing a lock takeover", () => {
    const { repo } = fixture();
    create(repo, "feature/refused-takeover", [
      "--lock-reason",
      "owner-original",
      "--invocation",
      "invocation-original",
    ]);
    const { json } = manager(
      [
        "create",
        "--repo",
        repo,
        "--branch",
        "feature/refused-takeover",
        "--creator",
        "attacker",
        "--invocation",
        "invocation-attacker",
        "--lock-reason",
        "owner-attacker",
      ],
      { ok: false },
    );
    expect(json.code).toBe("LOCKED");
    const state = manager(["status", "--repo", repo, "--skip-pr-check"]).json
      .worktrees[0];
    expect(state.metadata.creator).toBe("test");
    expect(state.metadata.invocation).toBe("invocation-original");
    expect(state.metadata.lockReason).toBe("owner-original");
  });

  it("creates an existing local branch without resolving an unused base", () => {
    const { repo } = fixture();
    git(repo, "branch", "feature/existing", "main");
    const output = manager([
      "create",
      "--repo",
      repo,
      "--branch",
      "feature/existing",
      "--base",
      "refs/heads/does-not-exist",
    ]).json;
    expect(output.reused).toBe(false);
    expect(output.baseRef).toBeNull();
    expect(git(output.worktreePath, "branch", "--show-current")).toBe(
      "feature/existing",
    );
  });

  it("serializes concurrent lock attempts without changing owners silently", async () => {
    const { repo } = fixture();
    create(repo, "feature/concurrent-lock");
    const command = (reason) =>
      runAsync("node", [
        MANAGER,
        "lock",
        "--repo",
        repo,
        "--branch",
        "feature/concurrent-lock",
        "--reason",
        reason,
      ]);
    const results = await Promise.all([command("owner-a"), command("owner-b")]);
    expect(results.filter(({ status }) => status === 0)).toHaveLength(1);
    expect(
      results
        .filter(({ status }) => status !== 0)
        .every(
          ({ stderr }) =>
            stderr.includes("Another process is changing") ||
            stderr.includes("already locked"),
        ),
    ).toBe(true);
    const state = manager(["status", "--repo", repo, "--skip-pr-check"]).json
      .worktrees[0];
    expect(["owner-a", "owner-b"]).toContain(state.lockReason);
  });

  it("refuses a clean branch with unpushed commits", () => {
    const { repo } = fixture();
    const worktree = create(repo, "feature/unpushed");
    writeFileSync(path.join(worktree.worktreePath, "change.txt"), "change\n");
    git(worktree.worktreePath, "add", "change.txt");
    git(worktree.worktreePath, "commit", "-m", "change");
    const { json } = manager(
      ["remove", "--repo", repo, "--branch", "feature/unpushed"],
      { ok: false },
    );
    expect(json.code).toBe("UNPUSHED");
  });

  it("retains worktrees with open PRs", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    const { json } = manager(
      ["remove", "--repo", repo, "--branch", "feature/test"],
      { ok: false, env: ghEnv(bin, "OPEN") },
    );
    expect(json.code).toBe("OPEN_PR");
  });

  it("honors --skip-pr-check during status classification", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    const checked = manager(["status", "--repo", repo], {
      env: ghEnv(bin, "OPEN"),
    }).json.worktrees[0];
    const skipped = manager(["status", "--repo", repo, "--skip-pr-check"], {
      env: ghEnv(bin, "OPEN"),
    }).json.worktrees[0];
    expect(checked.classification).toBe("clean with open PR");
    expect(skipped.classification).not.toBe("clean with open PR");
  });

  it("refuses worktrees whose PR was closed without merge", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    const { json } = manager(
      ["remove", "--repo", repo, "--branch", "feature/test"],
      { ok: false, env: ghEnv(bin, "CLOSED") },
    );
    expect(json.code).toBe("CLOSED_PR");
  });

  it("reports a safe branch deletion refusal after removing the worktree", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    writeFileSync(path.join(worktree.worktreePath, "change.txt"), "change\n");
    git(worktree.worktreePath, "add", "change.txt");
    git(worktree.worktreePath, "commit", "-m", "change");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    git(repo, "branch", "--unset-upstream", "feature/test");
    const output = manager(
      ["remove", "--repo", repo, "--branch", "feature/test", "--delete-branch"],
      { env: ghEnv(bin, "MERGED") },
    ).json;
    expect(output.branchDeleted).toBe(false);
    expect(output.branchDeletionError).toMatch(
      /not fully merged|not deleting/i,
    );
    expect(
      git(repo, "show-ref", "--verify", "refs/heads/feature/test"),
    ).toContain("refs/heads/feature/test");
  });

  it("reconciles a clean merged PR, including a manual/admin merge", () => {
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    writeFileSync(path.join(worktree.worktreePath, "merged.txt"), "merged\n");
    git(worktree.worktreePath, "add", "merged.txt");
    git(worktree.worktreePath, "commit", "-m", "merged change");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    git(repo, "merge", "--ff-only", "feature/test");
    git(repo, "push", "origin", "main");

    const output = manager(
      [
        "reconcile",
        "--repo",
        repo,
        "--apply",
        "--grace-hours",
        "0",
        "--recent-minutes",
        "0",
      ],
      { env: ghEnv(bin, "MERGED") },
    ).json;
    expect(output.worktrees[0].classification).toBe("clean with merged PR");
    expect(output.worktrees[0].action).toBe("removed");
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("BUI-603 #4 follow-up: --allow-recent-activity actually reaches a fresh, otherwise-removable worktree through reconcile", () => {
    // classify() withholds a fresh worktree via "recently active but
    // otherwise removable" (removable: false), so reconcile's apply branch
    // must reclassify with only the recency check disabled (still enforcing
    // grace period / PR state / unpushed checks) and use THAT result to
    // decide removability — and remove()'s own recency re-check must also
    // honor the override once options.allowRecentActivity is forwarded to
    // it. Without all three wired, the override documented on the CLI is
    // unreachable dead code (or worse, bypasses more than just recency).
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    writeFileSync(path.join(worktree.worktreePath, "merged.txt"), "merged\n");
    git(worktree.worktreePath, "add", "merged.txt");
    git(worktree.worktreePath, "commit", "-m", "merged change");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    git(repo, "merge", "--ff-only", "feature/test");
    git(repo, "push", "origin", "main");

    const output = manager(
      [
        "reconcile",
        "--repo",
        repo,
        "--apply",
        "--grace-hours",
        "0",
        "--allow-recent-activity",
      ],
      { env: ghEnv(bin, "MERGED") },
    ).json;
    // The reported classification reflects the reclassification (recency
    // check disabled), which correctly reaches the merged-PR outcome rather
    // than staying stuck on the recency-only classification.
    expect(output.worktrees[0].classification).toBe("clean with merged PR");
    expect(output.worktrees[0].action).toBe("removed");
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("BUI-603 #4 follow-up: --allow-recent-activity does not bypass the merge grace period", () => {
    // Codex review finding: classify() short-circuits on recency BEFORE
    // reaching the grace-period check, so disabling only recency must still
    // leave grace-period protection intact — a merged PR still within its
    // grace window must stay refused even with the override.
    const { parent, repo } = fixture();
    const bin = fakeGh(parent);
    const worktree = create(repo, "feature/test");
    writeFileSync(path.join(worktree.worktreePath, "merged.txt"), "merged\n");
    git(worktree.worktreePath, "add", "merged.txt");
    git(worktree.worktreePath, "commit", "-m", "merged change");
    git(worktree.worktreePath, "push", "-u", "origin", "feature/test");
    git(repo, "merge", "--ff-only", "feature/test");
    git(repo, "push", "origin", "main");

    // fakeGh's MERGED fixture hardcodes mergedAt to 2020-01-01, so the grace
    // window must exceed the real elapsed time since then to exercise the
    // "still within grace" branch at all.
    const output = manager(
      [
        "reconcile",
        "--repo",
        repo,
        "--apply",
        "--grace-hours",
        "999999999",
        "--allow-recent-activity",
      ],
      { env: ghEnv(bin, "MERGED") },
    ).json;
    expect(output.worktrees[0].classification).toBe("clean with merged PR");
    expect(output.worktrees[0].removable).toBe(false);
    expect(output.worktrees[0].action).toBe("report");
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  it("prunes stale registrations only on explicit repair", () => {
    const { repo } = fixture();
    const worktree = create(repo, "feature/stale");
    renameSync(worktree.worktreePath, `${worktree.worktreePath}-missing`);
    const output = manager([
      "reconcile",
      "--repo",
      repo,
      "--repair-stale",
    ]).json;
    expect(output.worktrees[0].classification).toBe("stale/missing path");
    expect(output.worktrees[0].action).toBe("pruned stale metadata");
  });

  it("resolves a moved primary checkout from its new filesystem location", () => {
    const { parent, repo } = fixture("before-move");
    const moved = path.join(parent, "after move");
    renameSync(repo, moved);
    const output = manager([
      "resolve",
      "--repo",
      moved,
      "--branch",
      "feature/moved-primary",
    ]).json;
    expect(output.repoRoot).toBe(realpathSync(moved));
    expect(output.worktreeRoot).toBe(
      path.join(realpathSync(parent), ".worktrees", "after move"),
    );
  });

  it("repairs a renamed repository container without losing dirty work", () => {
    const { parent, repo } = fixture("old-name");
    const worktree = create(repo, "feature/rename-repair");
    writeFileSync(
      path.join(worktree.worktreePath, "preserved.txt"),
      "keep me\n",
    );
    const renamed = path.join(parent, "new-name");
    renameSync(repo, renamed);

    const preview = manager([
      "repair",
      "--repo",
      renamed,
      "--old-repo-name",
      "old-name",
    ]).json;
    expect(preview.worktrees[0].action).toBe("would move");

    const repaired = manager([
      "repair",
      "--repo",
      renamed,
      "--old-repo-name",
      "old-name",
      "--apply",
    ]).json;
    expect(repaired.worktrees[0].action).toBe("moved and repaired");
    expect(repaired.worktrees[0].destination).toContain(
      `${path.sep}.worktrees${path.sep}new-name${path.sep}`,
    );
    expect(
      readFileSync(
        path.join(repaired.worktrees[0].destination, "preserved.txt"),
        "utf8",
      ),
    ).toBe("keep me\n");
    expect(
      git(repaired.worktrees[0].destination, "branch", "--show-current"),
    ).toBe("feature/rename-repair");
  });

  it("repairs a renamed repository using the configured container name", () => {
    const { parent, repo } = fixture("old-custom");
    mkdirSync(path.join(repo, ".claude"));
    writeFileSync(
      path.join(repo, ".claude", "config.json"),
      JSON.stringify({
        worktrees: {
          rootStrategy: "sibling-container",
          containerName: ".custom-worktrees",
        },
      }),
    );
    git(repo, "add", ".claude/config.json");
    git(repo, "commit", "-m", "configure worktrees");
    const worktree = create(repo, "feature/custom-repair");
    expect(worktree.worktreePath).toContain(
      `${path.sep}.custom-worktrees${path.sep}`,
    );
    const renamed = path.join(parent, "new-custom");
    renameSync(repo, renamed);
    const repaired = manager([
      "repair",
      "--repo",
      renamed,
      "--old-repo-name",
      "old-custom",
      "--apply",
    ]).json;
    expect(repaired.worktrees[0].action).toBe("moved and repaired");
    expect(repaired.worktrees[0].destination).toContain(
      `${path.sep}.custom-worktrees${path.sep}new-custom${path.sep}`,
    );
  });

  it("serializes concurrent creation attempts without duplicate worktrees", async () => {
    const { repo } = fixture();
    const args = [
      MANAGER,
      "create",
      "--repo",
      repo,
      "--branch",
      "feature/concurrent",
    ];
    const results = await Promise.all([
      runAsync("node", args),
      runAsync("node", args),
    ]);
    expect(results.some(({ status }) => status === 0)).toBe(true);
    expect(
      results.every(
        ({ status, stderr }) =>
          status === 0 ||
          (status === 1 &&
            stderr.includes("Another process is changing") &&
            stderr.includes("Retry after it finishes")),
      ),
    ).toBe(true);
    const count = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line === "branch refs/heads/feature/concurrent").length;
    expect(count).toBe(1);
  });

  it("serializes concurrent slug collisions and preserves both branches", async () => {
    const { repo } = fixture();
    const createBranch = (branch) =>
      runAsync("node", [MANAGER, "create", "--repo", repo, "--branch", branch]);
    const branches = ["feature/collision_a", "feature/collision-a"];
    const concurrent = await Promise.all(branches.map(createBranch));
    for (let index = 0; index < concurrent.length; index += 1) {
      if (concurrent[index].status !== 0) {
        const retry = await createBranch(branches[index]);
        expect(retry.status, retry.stderr).toBe(0);
      }
    }
    const records = git(repo, "worktree", "list", "--porcelain");
    expect(records).toContain("branch refs/heads/feature/collision_a");
    expect(records).toContain("branch refs/heads/feature/collision-a");
    const paths = records
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((candidate) => candidate.includes("collision-a"));
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
  });

  it("recovers a dead lifecycle mutex while preserving stale evidence", () => {
    const { repo } = fixture();
    const plan = manager([
      "resolve",
      "--repo",
      repo,
      "--branch",
      "feature/stale-mutex",
    ]).json;
    const common = git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const lockRoot = path.join(common, "worktree-manager", "locks");
    const lockName = createHash("sha256")
      .update(plan.worktreePath)
      .digest("hex")
      .slice(0, 8);
    const lock = path.join(lockRoot, `${lockName}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      path.join(lock, "owner.json"),
      `${JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        operation: "create",
        key: plan.worktreePath,
      })}\n`,
    );
    const output = create(repo, "feature/stale-mutex");
    expect(existsSync(output.worktreePath)).toBe(true);
    expect(
      readdirSync(lockRoot).some((entry) =>
        entry.startsWith(`${lockName}.lock.stale-`),
      ),
    ).toBe(true);
  });

  it("dry-runs legacy migration and applies only clean unlocked worktrees", () => {
    const { parent, repo } = fixture();
    const legacy = path.join(parent, "repo-wt-legacy");
    git(repo, "worktree", "add", "-b", "feature/legacy", legacy, "main");
    const dry = manager(["migrate", "--repo", repo, "--dry-run"]).json;
    expect(dry.applied).toBe(false);
    expect(dry.worktrees[0]).toMatchObject({
      currentPath: realpathSync(legacy),
      branch: "feature/legacy",
      safe: true,
      action: "report",
    });
    const applied = manager(["migrate", "--repo", repo, "--apply"]).json;
    expect(applied.worktrees[0].action).toBe("moved");
    expect(applied.worktrees[0].proposedPath).toContain(
      `${path.sep}.worktrees${path.sep}repo${path.sep}`,
    );
  });
});

describe("canonical-source contract", () => {
  it("blocks primary checkouts even when they live under the temporary directory", () => {
    const { repo } = fixture();
    const result = commitGuard(
      `git -C ${JSON.stringify(repo)} commit -m "change"`,
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Blocked");
  });

  it("recognizes only an actual guard-bypass assignment", () => {
    const repo = persistentFixture();
    const quoted = JSON.stringify(repo);
    const messageOnly = commitGuard(
      `git -C ${quoted} commit -m "note: BYPASS_BRANCH_GUARD=1"`,
    );
    const explicit = commitGuard(
      `BYPASS_BRANCH_GUARD=1 git -C ${quoted} commit -m "exception"`,
    );
    expect(messageOnly.status).toBe(2);
    expect(messageOnly.stdout).toContain("Blocked");
    expect(explicit.status).toBe(0);
  });

  it("keeps path construction and destructive worktree operations in the manager", () => {
    const trackedFiles = run("git", ["ls-files"], { cwd: ROOT })
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    const disallowed = /git worktree (?:add|remove)|-[Ww][Tt]-|-worktrees\//;
    const files = trackedFiles.filter((file) => {
      if (file === "CHANGELOG.md" || file.startsWith("scripts/__tests__/")) {
        return false;
      }
      try {
        return disallowed.test(readFileSync(path.join(ROOT, file), "utf8"));
      } catch {
        return false;
      }
    });
    expect(files).toEqual([]);
  });

  it("limits force removal to the initialized-submodule recovery path", () => {
    const source = readFileSync(MANAGER, "utf8");
    expect(source).toMatch(
      /submodules cannot be moved or removed[\s\S]*worktree", "remove", "--force", record\.path/,
    );
    expect(
      source.match(/worktree", "remove", "--force", record\.path/g),
    ).toHaveLength(1);
    expect(source).not.toContain("rm -rf");
    expect(source).not.toMatch(/branch["',\s]+-D/);
  });

  it("does not exempt primary submodule checkouts from the commit guard", () => {
    const source = readFileSync(
      path.join(ROOT, "scripts", "block-commit-main.sh"),
      "utf8",
    );
    expect(source).not.toContain("IS_SUBMODULE");
    expect(source).toContain('CURRENT_GIT_DIR" = "$COMMON_GIT_DIR');
    expect(source).toContain('punctuation_chars=";&|"');
    expect(source).toContain("targets[-1]");
  });

  it("materializes PR heads through the base repository pull ref", () => {
    const source = readFileSync(
      path.join(ROOT, "scripts", "quality-bootstrap.sh"),
      "utf8",
    );
    expect(source).toContain("+refs/pull/$RES_PR/head:$WT_BASE_REF");
    expect(source).toContain(
      'WT_BRANCH="quality/pr-${RES_PR}-${WT_HEAD:0:12}"',
    );
    expect(source).toContain('--branch "$WT_BRANCH"');
    expect(source).toContain(
      "existing PR worktree is stale; materializing fetched exact head.",
    );
    expect(source).toContain('"$SCRIPT_DIR/quality-target-resolver.js"');
  });

  // The lifecycle lock is the ONLY serialization for worktree removal, so a
  // stale-lock steal that is not atomic lets two processes both believe they
  // hold it and interleave classify → unlock → remove → branch delete.
  describe("lifecycle lock recovery", () => {
    function lockRootOf(repo) {
      const common = realpathSync(
        git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      );
      return path.join(common, "worktree-manager", "locks");
    }

    /** Plant a lock owned by a PID that cannot be alive. */
    function plantDeadLock(repo, worktreePath) {
      const lockRoot = lockRootOf(repo);
      mkdirSync(lockRoot, { recursive: true });
      const hash = createHash("sha256")
        .update(worktreePath)
        .digest("hex")
        .slice(0, 8);
      const lock = path.join(lockRoot, `${hash}.lock`);
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        path.join(lock, "owner.json"),
        `${JSON.stringify({
          // PID 2^22 is above the Linux/macOS maximum, so it can never exist.
          pid: 4194304,
          hostname: os.hostname(),
          operation: "remove",
          key: worktreePath,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      return { lock, lockRoot };
    }

    it("recovers a dead owner's lock and leaves exactly one live lock", () => {
      const { repo } = fixture();
      const wt = create(repo, "feature/lock-recovery");
      const { lock, lockRoot } = plantDeadLock(repo, wt.worktreePath);
      expect(existsSync(lock)).toBe(true);

      // Any lifecycle operation on this key must recover, not refuse.
      manager(["status", "--repo", repo]);
      const removal = manager(
        [
          "remove",
          "--repo",
          repo,
          "--branch",
          "feature/lock-recovery",
          "--skip-pr-check",
          "--allow-unknown",
        ],
        { ok: false },
      );
      expect(removal.result.status).toBe(0);

      // Exactly one stale-evidence directory, and no leftover live lock.
      const evidence = readdirSync(lockRoot).filter((name) =>
        name.includes(".lock.stale-"),
      );
      expect(evidence).toHaveLength(1);
      expect(existsSync(lock)).toBe(false);
    });

    it("names stale evidence with the recovering pid so two stealers cannot collide", () => {
      // Date.now() alone collides when two processes recover in the same
      // millisecond; both would rename onto the same destination.
      const source = readFileSync(MANAGER, "utf8");
      expect(source).toContain("stale-${process.pid}-${Date.now()}");
    });

    it("treats a lost steal race as BUSY rather than proceeding unlocked", () => {
      // The recreate after a successful rename must not silently continue when
      // another stealer already claimed the lock.
      const source = readFileSync(MANAGER, "utf8");
      const start = source.indexOf("const evidence = ");
      expect(start).toBeGreaterThan(-1);
      const recovery = source.slice(start, start + 1600);
      expect(recovery).toContain('renameError.code === "ENOENT"');
      expect(recovery).toContain('recreateError.code === "EEXIST"');
    });

    it("does not let lock release mask the operation's real error", () => {
      // A throw from `finally` replaces the original error, turning an
      // actionable UNPUSHED refusal into a confusing ENOENT.
      const source = readFileSync(MANAGER, "utf8");
      const release = source.slice(
        source.indexOf("    return callback();"),
        source.indexOf("function create(options)"),
      );
      expect(release).toMatch(/try\s*\{\s*fs\.unlinkSync\(ownerFile\);/);
      expect(release).toMatch(/try\s*\{\s*fs\.rmdirSync\(lock\);/);
    });

    it("prunes stale evidence older than the retention window", () => {
      const { repo } = fixture();
      create(repo, "feature/prune-evidence");
      const lockRoot = lockRootOf(repo);
      mkdirSync(lockRoot, { recursive: true });

      const old = path.join(lockRoot, "deadbeef.lock.stale-111-1");
      const recent = path.join(lockRoot, "deadbeef.lock.stale-222-2");
      mkdirSync(old, { recursive: true });
      mkdirSync(recent, { recursive: true });
      const ancient = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(old, ancient, ancient);

      // Pruning runs when a lifecycle lock is taken; `status` does not take one.
      create(repo, "feature/prune-trigger");

      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
    });
  });

  // `Number("abc")` is NaN, and every comparison against NaN is false — so
  // `ageMinutes < recentMinutes` stopped protecting anything and the
  // "recently active" guard silently became a no-op that removes live
  // worktrees. Reject a non-numeric threshold instead of proceeding with an
  // unguarded deletion.
  describe("numeric threshold validation", () => {
    const { parseCli } = require(MANAGER);

    const rejected = [
      ["a non-numeric word", "abc"],
      ["a unit suffix", "30m"],
      ["a negative value", "-5"],
      ["whitespace only", "   "],
      ["a bare sign", "-"],
    ];

    it.each(rejected)("rejects --recent-minutes with %s", (_label, value) => {
      expect(() =>
        parseCli(["status", "--repo", "/tmp/x", "--recent-minutes", value]),
      ).toThrow(/--recent-minutes must be a non-negative number/);
    });

    it.each(rejected)("rejects --grace-hours with %s", (_label, value) => {
      expect(() =>
        parseCli(["status", "--repo", "/tmp/x", "--grace-hours", value]),
      ).toThrow(/--grace-hours must be a non-negative number/);
    });

    it("raises a USAGE error, not a generic failure", () => {
      try {
        parseCli(["status", "--repo", "/tmp/x", "--recent-minutes", "abc"]);
        throw new Error("expected parseCli to throw");
      } catch (error) {
        expect(error.code).toBe("USAGE");
      }
    });

    // An explicit 0 means "no recency window" and must survive: `0 || default`
    // previously discarded it and silently restored the 30-minute default.
    it("preserves an explicit zero rather than falling back to the default", () => {
      const { options } = parseCli([
        "status",
        "--repo",
        "/tmp/x",
        "--recent-minutes",
        "0",
        "--grace-hours",
        "0",
      ]);
      expect(options.recentMinutes).toBe(0);
      expect(options.graceHours).toBe(0);
    });

    it("accepts ordinary numeric thresholds", () => {
      const { options } = parseCli([
        "status",
        "--repo",
        "/tmp/x",
        "--recent-minutes",
        "45",
        "--grace-hours",
        "12.5",
      ]);
      expect(options.recentMinutes).toBe(45);
      expect(options.graceHours).toBe(12.5);
    });

    it("leaves unset thresholds absent so callers apply their defaults", () => {
      const { options } = parseCli(["status", "--repo", "/tmp/x"]);
      expect(options.recentMinutes).toBeUndefined();
      expect(options.graceHours).toBeUndefined();
    });
  });
});
