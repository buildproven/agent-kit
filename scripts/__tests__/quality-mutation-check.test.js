import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const INVOCATION = path.join(ROOT, "scripts", "quality-invocation.js");
const MUTATION = path.join(ROOT, "scripts", "quality-mutation-check.sh");
// These fixtures prove argument routing, not timeout behavior. Three seconds
// flakes under full-suite CPU contention before the tiny stub runner starts.
const FAIL_FAST_CHECK_SECONDS = 15;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixtureTestScript(options) {
  if (options.testScript) return options.testScript;
  if (options.vitestRunner) return "vitest run";
  if (options.npmPytestScript) return options.npmPytestScript;
  return "node logic.test.js";
}

function fixturePackage(options) {
  const dependencies = {
    ...(options.localDependency ? { zod: "file:vendor/zod" } : {}),
    ...(options.pnpmWorkspace && !options.pnpmWorkspaceRootNoDependencies
      ? { zod: "workspace:*" }
      : {}),
    ...(options.vitestRunner ? { vitest: "file:vendor/vitest" } : {}),
  };
  return {
    ...(options.packageManager || options.pnpmWorkspace
      ? { packageManager: options.packageManager || "pnpm@10.33.0" }
      : {}),
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    scripts: {
      lint: "true",
      test: fixtureTestScript(options),
      "security:audit": "true",
    },
  };
}

function installLocalNodeDependency(root, options) {
  if (options.localDependency) {
    const dependency = path.join(root, "vendor", "zod");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "zod", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(
      path.join(dependency, "index.js"),
      "exports.location = __dirname;\n",
    );
  }
  if (options.vitestRunner) {
    const dependency = path.join(root, "vendor", "vitest");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "vitest",
        version: "1.0.0",
        bin: { vitest: "vitest.sh" },
      }),
    );
    writeFileSync(
      path.join(dependency, "vitest.sh"),
      `#!/usr/bin/env bash
printf "%s\\n" "$*"
${options.requireMutationExclude ? 'case " $* " in *" --exclude scripts/__tests__/quality-mutation-check.test.js "*) ;; *) echo "recursive mutation contract was not excluded" >&2; exit 42 ;; esac\n' : ""}
${options.rejectForwardedNpmSilent ? 'case " $* " in *" --silent "*) echo "npm-owned --silent reached Vitest" >&2; exit 43 ;; esac\n' : ""}
${options.relatedNoTests ? 'case " $* " in *" related "*) echo "No test files found"; exit 0 ;; esac\n' : ""}
${options.siblingExitTwo ? `case " $* " in *" ${options.testPath || "logic.test.js"} "*) exit 2 ;; esac\n` : ""}node ${options.testPath || "logic.test.js"}
`,
      { mode: 0o755 },
    );
  }
  if (!options.localDependency && !options.vitestRunner) return;
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit"], {
    cwd: root,
    stdio: "ignore",
  });
}

function installPytestRunner(root, options) {
  if (!options.pytestRunner && !options.npmPytestScript) {
    return;
  }
  const bin = path.join(root, "test-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "pytest"),
    options.npmUnsafePytestRunner
      ? `#!/usr/bin/env bash
printf "%s\\n" "$*"
case " $* " in
  *" -- -x "*) exit 2 ;;
esac
node logic.test.js
`
      : `#!/usr/bin/env bash
printf "%s\\n" "$*"
node logic.test.js
status=$?
${
  options.pytestXdistSlowShutdown
    ? `case " $* " in
  *" -n 0 "*) exit "$status" ;;
esac
`
    : `case " $* " in
  *" -x "*) exit "$status" ;;
esac
`
}
sleep 10
exit "$status"
`,
    { mode: 0o755 },
  );
  if (options.npmUnsafePytestRunner) {
    writeFileSync(
      path.join(bin, "eslint"),
      `#!/usr/bin/env bash
printf "%s\\n" "$*"
case " $* " in
  *" -x "*) exit 2 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
  }
}

function installPnpmWorkspace(root, options) {
  if (!options.pnpmWorkspace) return;
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  const dependency = path.join(root, "packages", "zod");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "zod", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(
    path.join(dependency, "index.js"),
    "exports.location = __dirname;\n",
  );
  if (options.pnpmWorkspaceRootNoDependencies) {
    const app = path.join(root, "packages", "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { zod: "workspace:*" },
      }),
    );
    writeFileSync(
      path.join(app, "index.js"),
      "exports.location = require('zod').location;\n",
    );
  }
  try {
    execFileSync(
      "pnpm",
      [
        "--config.manage-package-manager-versions=false",
        "--config.pm-on-fail=ignore",
        "install",
        "--offline",
        "--frozen-lockfile=false",
        "--ignore-scripts",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(error.stderr?.toString() || error.message, {
      cause: error,
    });
  }
}

function installPackageManagerShim(root, options) {
  if (!options.packageManager?.startsWith("pnpm@")) return;
  const bin = path.join(root, "test-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "pnpm"),
    '#!/usr/bin/env bash\nif [ "$1" = "test" ]; then shift; elif [ "$1" = "run" ] && [ "$2" = "test" ]; then shift 2; else exit 1; fi\nnode logic.test.js\n',
    { mode: 0o755 },
  );
}

function installAuditPolicy(root, options) {
  if (!options.auditMapping) return;
  const auditCommand =
    typeof options.auditCommand === "function"
      ? options.auditCommand(root)
      : options.auditCommand;
  mkdirSync(path.join(root, ".buildproven"), { recursive: true });
  writeFileSync(
    path.join(root, ".buildproven", "test-impact.json"),
    JSON.stringify({
      version: 1,
      jsRunner: "none",
      mappings: [],
      audits: [
        {
          paths: ["aaa-uncovered.js"],
          reason: "fixture complete audit",
          commands: [
            auditCommand ?? {
              executable: "npm",
              args: options.auditArgs ?? ["test"],
            },
          ],
        },
      ],
    }),
  );
}

function installSlowSelector(root, options) {
  if (!options.slowSelector) return;
  mkdirSync(path.join(root, "selector"), { recursive: true });
  writeFileSync(
    path.join(root, "selector", "test-impact.js"),
    "setTimeout(() => {}, 10_000);\n",
  );
}

function installFocusedPolicy(root, options) {
  if (!options.focusedMapping) return;
  mkdirSync(path.join(root, ".buildproven"), { recursive: true });
  writeFileSync(
    path.join(root, ".buildproven", "test-impact.json"),
    JSON.stringify({
      version: 1,
      jsRunner: "none",
      mappings: options.costRanking
        ? [
            {
              paths: ["aaa-expensive.js"],
              commands: [
                { executable: "node", args: ["aaa-expensive.test.js"] },
              ],
            },
            {
              paths: ["zzz-cheap.js"],
              commands: [{ executable: "node", args: ["zzz-cheap.test.js"] }],
            },
          ]
        : [
            {
              paths: ["logic.js"],
              commands: [{ executable: "node", args: ["logic.test.js"] }],
            },
          ],
      audits: [],
    }),
  );
}

function installMutationContractFixture(root, options) {
  if (!options.requireMutationExclude) return;
  mkdirSync(path.join(root, "scripts", "__tests__"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts", "__tests__", "quality-mutation-check.test.js"),
    "throw new Error('mutation contract must not run recursively');\n",
  );
}

function fixture(label, testBody, options = {}) {
  const root = makeTempDir(`quality-mutation-${label}-`);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Quality Test"]);
  git(root, ["config", "user.email", "quality@example.com"]);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(fixturePackage(options)),
  );
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\ntest-bin/\n");
  installPnpmWorkspace(root, options);
  installLocalNodeDependency(root, options);
  installPackageManagerShim(root, options);
  installSlowSelector(root, options);
  if (options.pnpmWorkspace) {
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          test: { executable: "node", args: ["logic.test.js"] },
        },
      }),
    );
  }
  installFocusedPolicy(root, options);
  installAuditPolicy(root, options);
  installMutationContractFixture(root, options);
  if (options.pytestRunner) {
    writeFileSync(
      path.join(root, ".quality-gates.json"),
      JSON.stringify({
        version: 1,
        gates: {
          test: {
            executable: "pytest",
            args: options.pytestArgs ?? [
              "-q",
              "-n",
              "3",
              "--dist",
              "worksteal",
            ],
          },
        },
      }),
    );
  }
  const source =
    options.sourcePath ||
    (options.shellSource
      ? "policy.sh"
      : options.addedSource
        ? "policy.js"
        : "logic.js");
  mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
  if (!options.addedSource) {
    writeFileSync(
      path.join(root, source),
      options.shellSource
        ? "is_allowed() { return 1; }\n"
        : "exports.isAllowed = () => false;\n",
    );
  }
  if (options.costRanking) {
    writeFileSync(
      path.join(root, "zzz-cheap.js"),
      "exports.allowed = false;\n",
    );
    writeFileSync(
      path.join(root, "zzz-cheap.test.js"),
      "if (!require('./zzz-cheap').allowed) process.exit(1);\n",
    );
  }
  if (options.submodule) {
    const submodule = makeTempDir(`quality-mutation-${label}-submodule-`);
    git(submodule, ["init", "-q", "-b", "main"]);
    git(submodule, ["config", "user.name", "Quality Test"]);
    git(submodule, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(submodule, "helper.js"),
      "exports.value = 'ready';\n",
    );
    git(submodule, ["add", "helper.js"]);
    git(submodule, ["commit", "-q", "-m", "helper"]);
    execFileSync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        submodule,
        "core",
      ],
      { cwd: root, env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } },
    );
  }
  const testPath = options.testPath || "logic.test.js";
  mkdirSync(path.dirname(path.join(root, testPath)), { recursive: true });
  writeFileSync(path.join(root, testPath), testBody);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", root]);
  git(root, ["fetch", "-q", "origin", "main"]);
  git(root, ["switch", "-q", "-c", "feature"]);
  if (options.uncoveredSource) {
    writeFileSync(
      path.join(root, "aaa-uncovered.js"),
      "exports.uncovered = true;\n",
    );
    git(root, ["add", "aaa-uncovered.js"]);
  }
  writeFileSync(
    path.join(root, source),
    options.shellSource
      ? "is_allowed() { return 0; }\n"
      : "exports.isAllowed = (role) => role === 'admin';\n",
  );
  if (options.costRanking) {
    writeFileSync(path.join(root, "zzz-cheap.js"), "exports.allowed = true;\n");
    git(root, ["add", "zzz-cheap.js"]);
  }
  git(root, ["add", source]);
  git(root, ["commit", "-qm", "feat: authorize admin"]);
  installPytestRunner(root, options);
  const manifest = execFileSync(
    "node",
    [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  execFileSync(
    "node",
    [
      INVOCATION,
      "risk",
      manifest,
      "--tier",
      "high",
      "--task-type",
      "feature",
      "--score",
      "50",
      "--agents",
      "2",
      "--codex-depth",
      "high",
      "--codex-rounds",
      "1",
    ],
    { cwd: root },
  );
  if (options.checkSeconds) {
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    state.risk.runtime.checkSeconds = options.checkSeconds;
    state.risk.runtime.checkReserveSeconds = 0;
    writeFileSync(manifest, `${JSON.stringify(state, null, 2)}\n`);
  }
  return { root, manifest };
}

function runMutation(root, manifest) {
  try {
    return execFileSync("bash", [MUTATION, "--manifest", manifest], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_ALLOW_PROTOCOL: "file",
        PATH: `${path.join(root, "test-bin")}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(error.stderr.toString(), { cause: error });
  }
}

function runMutationProcess(root, manifest) {
  return spawnSync("bash", [MUTATION, "--manifest", manifest], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "file",
      PATH: `${path.join(root, "test-bin")}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("config-promotion filter", () => {
  // Exercises the awk filter from quality-mutation-check.sh directly: cheap
  // coverage of every lockfile spelling, which full fixtures cannot afford.
  // A wrong pattern here silently promotes a lockfile, and reverting one
  // mid-run changes the test command the sandbox is about to execute.
  function promote(paths) {
    const script = readFileSync(MUTATION, "utf8");
    const block =
      /\/\(\^\|\\\/\)\(test\|tests\|spec\|__tests__\)[\s\S]*?\{ print \}/.exec(
        script.slice(script.indexOf("CONFIG_CANDIDATE")),
      );
    if (!block) throw new Error("config-promotion awk block not found");
    return execFileSync("awk", [block[0]], {
      input: `${paths.join("\n")}\n`,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  }

  it("excludes every dependency manifest and lockfile spelling", () => {
    expect(
      promote([
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "poetry.lock",
        "uv.lock",
        "Cargo.toml",
        "Cargo.lock",
        "composer.json",
        "go.sum",
      ]),
    ).toEqual([]);
  });

  it("still promotes genuine config files", () => {
    expect(
      promote([
        "policy.yml",
        "tsconfig.json",
        ".github/workflows/ci.yml",
        "ruff.toml",
      ]),
    ).toEqual([
      "policy.yml",
      "tsconfig.json",
      ".github/workflows/ci.yml",
      "ruff.toml",
    ]);
  });

  it("never promotes a test path", () => {
    expect(promote(["__tests__/fixture.json", "spec/config.yml"])).toEqual([]);
  });
});

describe("quality-mutation-check", () => {
  it("prepares non-pnpm dependencies inside the detached mutation worktree", () => {
    const { root, manifest } = fixture(
      "npm-isolated-dependency",
      "const path = require('node:path');\nconst { isAllowed } = require('./logic');\nconst { location } = require('zod');\nif (!path.resolve(location).startsWith(process.cwd() + path.sep) || !isAllowed('admin')) process.exit(1);\n",
      { localDependency: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("does not require a lockfile for dependency-free declared package managers", () => {
    const { root, manifest } = fixture(
      "pnpm-no-dependencies",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      { packageManager: "pnpm@10.33.0" },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("resolves a pnpm workspace dependency inside the detached mutation worktree", () => {
    const { root, manifest } = fixture(
      "pnpm-workspace",
      "const path = require('node:path');\nconst { isAllowed } = require('./logic');\nconst { location } = require('zod');\nif (!path.resolve(location).startsWith(process.cwd() + path.sep) || !isAllowed('admin')) process.exit(1);\n",
      { pnpmWorkspace: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("installs workspace dependencies when the root has none", () => {
    const { root, manifest } = fixture(
      "pnpm-workspace-root-no-dependencies",
      "const path = require('node:path');\nconst { isAllowed } = require('./logic');\nconst { location } = require('./packages/app');\nif (!path.resolve(location).startsWith(process.cwd() + path.sep) || !isAllowed('admin')) process.exit(1);\n",
      { pnpmWorkspace: true, pnpmWorkspaceRootNoDependencies: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("fails when a vacuous test stays green after the changed behavior is reverted", () => {
    const { root, manifest } = fixture(
      "vacuous",
      "const { isAllowed } = require('./logic');\nif (typeof isAllowed !== 'function') process.exit(1);\n",
    );
    expect(() => runMutation(root, manifest)).toThrow(
      /no red-capable evidence/,
    );
  });

  it("records evidence when a behavioral test turns red after the controlled revert", () => {
    const { root, manifest } = fixture(
      "meaningful",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      {
        encoding: "utf8",
      },
    ).trim();
    const artifact = JSON.parse(
      readFileSync(path.join(stateRoot, "mutation", `${head}.json`), "utf8"),
    );
    expect(artifact).toMatchObject({
      method: "revert-diff",
      mutatedPaths: ["logic.js"],
      testFailureObserved: true,
    });
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.governor.activeExecution).toBeNull();
    expect(state.governor.gateSecondsUsed).toBeGreaterThanOrEqual(1);
  });

  it("uses the shared planner with a committed focused mapping instead of the complete suite", () => {
    const { root, manifest } = fixture(
      "focused",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      {
        focusedMapping: true,
        testScript: "node complete-suite-must-not-run.js",
      },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("uses a conventional sibling test before a CommonJS related selector can return zero tests", () => {
    const { root, manifest } = fixture(
      "commonjs-sibling",
      "const { isAllowed } = require('../logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      {
        sourcePath: "scripts/logic.js",
        testPath: "scripts/__tests__/logic.test.js",
        vitestRunner: true,
        relatedNoTests: true,
      },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("propagates status 2 from a selected sibling instead of treating it as absent", () => {
    const { root, manifest } = fixture(
      "sibling-status-two",
      "const { isAllowed } = require('../logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      {
        sourcePath: "scripts/logic.js",
        testPath: "scripts/__tests__/logic.test.js",
        vitestRunner: true,
        siblingExitTwo: true,
      },
    );
    expect(() => runMutation(root, manifest)).toThrow(
      /serialized baseline test failed/,
    );
  });

  it("initializes committed submodules before running the mutation baseline", () => {
    const { root, manifest } = fixture(
      "submodule-baseline",
      "const { isAllowed } = require('./logic');\nconst { value } = require('./core/helper');\nif (!isAllowed('admin') || value !== 'ready') process.exit(1);\n",
      { submodule: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const artifact = JSON.parse(
      readFileSync(path.join(stateRoot, "mutation", `${head}.json`), "utf8"),
    );
    expect(artifact.mutatedPaths).toEqual(["logic.js"]);
  });

  it("uses the native Vitest bail option after the first mutation failure", () => {
    const { root, manifest } = fixture(
      "vitest-bail",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      { vitestRunner: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const log = readFileSync(
      path.join(stateRoot, "mutation", `${head}.logic.js.log`),
      "utf8",
    );
    expect(log).toContain("run --bail=1");
  });

  it("adapts Vitest hidden behind an audit selector without recursive mutation work", () => {
    const { root, manifest } = fixture(
      "audit-selector-recursion",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        vitestRunner: true,
        requireMutationExclude: true,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const log = readFileSync(
      path.join(stateRoot, "mutation", `${head}.aaa-uncovered.js.log`),
      "utf8",
    );
    expect(log).toContain(
      "--exclude scripts/__tests__/quality-mutation-check.test.js",
    );
    expect(log).not.toContain("recursive mutation contract was not excluded");
  });

  it("inserts npm's pass-through separator before existing Vitest flags", () => {
    const { root, manifest } = fixture(
      "audit-selector-existing-bail",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditArgs: ["run", "test", "--bail=1"],
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        vitestRunner: true,
        requireMutationExclude: true,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("preserves npm-owned flags before the pass-through separator", () => {
    const { root, manifest } = fixture(
      "audit-selector-npm-silent",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditArgs: ["test", "--silent"],
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        vitestRunner: true,
        requireMutationExclude: true,
        rejectForwardedNpmSilent: true,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("recognizes npm test after a leading npm-owned option", () => {
    const { root, manifest } = fixture(
      "audit-selector-leading-npm-silent",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditArgs: ["--silent", "test"],
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        vitestRunner: true,
        requireMutationExclude: true,
        rejectForwardedNpmSilent: true,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("does not confuse a positional mutation-test path with an exclusion", () => {
    const { root, manifest } = fixture(
      "audit-selector-positional-mutation-test",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditArgs: [
          "test",
          "--",
          "scripts/__tests__/quality-mutation-check.test.js",
        ],
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        vitestRunner: true,
        requireMutationExclude: true,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
  });

  it("fails closed on a recursive test-impact policy command", () => {
    const { root, manifest } = fixture(
      "audit-selector-cycle",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditCommand: {
          executable: process.execPath,
          args: [
            path.join(ROOT, "scripts", "test-impact.js"),
            "--execute",
            "--",
            "aaa-uncovered.js",
          ],
        },
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /selector expansion exceeded depth 3/,
    );
  });

  it("finds a recursive test-impact selector after a leading Node option", () => {
    const { root, manifest } = fixture(
      "audit-selector-leading-node-option",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditCommand: {
          executable: process.execPath,
          args: [
            "--conditions=node",
            path.join(ROOT, "scripts", "test-impact.js"),
            "--execute",
            "--",
            "aaa-uncovered.js",
          ],
        },
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /selector expansion exceeded depth 3/,
    );
  });

  it("preserves a valid expanded selector with no selected tests", () => {
    const { root, manifest } = fixture(
      "audit-selector-none",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditCommand: {
          executable: process.execPath,
          args: [
            path.join(ROOT, "scripts", "test-impact.js"),
            "--execute",
            "--",
            "README.md",
          ],
        },
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /persisted tests remained green/,
    );
  });

  it("does not record reserved orchestration status as red-capable evidence", () => {
    const { root, manifest } = fixture(
      "audit-selector-orchestration-status",
      "const fs=require('node:fs');\nif(!fs.existsSync('aaa-uncovered.js')) process.exit(125);\n",
      {
        auditMapping: true,
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        vitestRunner: true,
        requireMutationExclude: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /controlled revert selector orchestration failed; this is not red-capable evidence/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).toBeNull();
  });

  it("bounds selector planning with the mutation timeout", () => {
    const { root, manifest } = fixture(
      "audit-selector-timeout",
      "require('./aaa-uncovered.js');\n",
      {
        auditMapping: true,
        auditCommand: (fixtureRoot) => ({
          executable: process.execPath,
          args: [
            path.join(fixtureRoot, "selector", "test-impact.js"),
            "--execute",
          ],
        }),
        slowSelector: true,
        sourcePath: "zzz-uncovered-guard.js",
        uncoveredSource: true,
        checkSeconds: 2,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /serialized baseline test timed out; no red-capable evidence/,
    );
  });

  it("uses pytest fail-fast after the first controlled-revert failure", () => {
    const { root, manifest } = fixture(
      "pytest-fail-fast",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      { pytestRunner: true, checkSeconds: FAIL_FAST_CHECK_SECONDS },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const log = readFileSync(
      path.join(stateRoot, "mutation", `${head}.logic.js.log`),
      "utf8",
    );
    expect(log).toContain("-q -n 3 --dist worksteal -n 0 -x");
  });

  it("disables xdist for a fail-fast controlled-revert run", () => {
    const { root, manifest } = fixture(
      "pytest-xdist-shutdown",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      {
        pytestRunner: true,
        pytestXdistSlowShutdown: true,
        checkSeconds: FAIL_FAST_CHECK_SECONDS,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const log = readFileSync(
      path.join(stateRoot, "mutation", `${head}.logic.js.log`),
      "utf8",
    );
    expect(log).toContain("-q -n 3 --dist worksteal -n 0 -x");
  });

  it("stops xdist detection and places pytest fail-fast before the option terminator", () => {
    const { root, manifest } = fixture(
      "pytest-option-terminator",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      {
        pytestRunner: true,
        pytestArgs: ["-q", "--", "-n"],
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const log = readFileSync(
      path.join(stateRoot, "mutation", `${head}.logic.js.log`),
      "utf8",
    );
    expect(log).toContain("-q -x -- -n");
    expect(log).not.toContain("-n 0");
  });

  it("uses pytest fail-fast for an npm test script backed by pytest", () => {
    const { root, manifest } = fixture(
      "npm-pytest-fail-fast",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      {
        npmPytestScript: "pytest -n auto",
        checkSeconds: FAIL_FAST_CHECK_SECONDS,
      },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const log = readFileSync(
      path.join(stateRoot, "mutation", `${head}.logic.js.log`),
      "utf8",
    );
    expect(log).toContain("-n auto -x");
  });

  it("does not manufacture evidence from a compound npm pytest script", () => {
    const { root, manifest } = fixture(
      "npm-compound-pytest",
      "const { isAllowed } = require('./logic');\nif (typeof isAllowed !== 'function') process.exit(1);\n",
      {
        npmPytestScript: "pytest && eslint .",
        npmUnsafePytestRunner: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /no red-capable evidence/,
    );
  });

  it("does not append fail-fast after an npm pytest option terminator", () => {
    const { root, manifest } = fixture(
      "npm-pytest-terminator",
      "const { isAllowed } = require('./logic');\nif (typeof isAllowed !== 'function') process.exit(1);\n",
      {
        npmPytestScript: "pytest -q --",
        npmUnsafePytestRunner: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /no red-capable evidence/,
    );
  });

  it("does not manufacture evidence from newline-separated npm commands", () => {
    const { root, manifest } = fixture(
      "npm-newline-pytest",
      "const { isAllowed } = require('./logic');\nif (typeof isAllowed !== 'function') process.exit(1);\n",
      {
        npmPytestScript: "pytest -q\neslint .",
        npmUnsafePytestRunner: true,
      },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /no red-capable evidence/,
    );
  });

  it("removes an added source file to produce revision-bound evidence", () => {
    const { root, manifest } = fixture(
      "added-source",
      "const { isAllowed } = require('./policy');\nif (!isAllowed('admin')) process.exit(1);\n",
      { addedSource: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const artifact = JSON.parse(
      readFileSync(path.join(stateRoot, "mutation", `${head}.json`), "utf8"),
    );
    expect(artifact.mutatedPaths).toEqual(["policy.js"]);
  });

  it("records evidence for a behavioral test of changed shell source", () => {
    const { root, manifest } = fixture(
      "shell-meaningful",
      "const { spawnSync } = require('node:child_process');\nconst result = spawnSync('bash', ['-c', 'source ./policy.sh; is_allowed']);\nif (result.status !== 0) process.exit(1);\n",
      { shellSource: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const artifact = JSON.parse(
      readFileSync(path.join(stateRoot, "mutation", `${head}.json`), "utf8"),
    );
    expect(artifact.mutatedPaths).toEqual(["policy.sh"]);
  });

  it("rejects a vacuous shell test that stays green after the revert", () => {
    const { root, manifest } = fixture(
      "shell-vacuous",
      "const { existsSync } = require('node:fs');\nif (!existsSync('policy.sh')) process.exit(1);\n",
      { shellSource: true },
    );
    expect(() => runMutation(root, manifest)).toThrow(
      /no red-capable evidence/,
    );
  });

  it("records only the candidate whose revert made the tests turn red", () => {
    const { root, manifest } = fixture(
      "proven-path",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
      { uncoveredSource: true },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const stateRoot = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "stateRoot"],
      { encoding: "utf8" },
    ).trim();
    const head = execFileSync(
      "node",
      [INVOCATION, "field", manifest, "revisions.currentHead"],
      { encoding: "utf8" },
    ).trim();
    const artifact = JSON.parse(
      readFileSync(path.join(stateRoot, "mutation", `${head}.json`), "utf8"),
    );
    expect(artifact.mutatedPaths).toEqual(["logic.js"]);
  });

  it("orders a controlled self-mutation candidate without shell lookup errors", () => {
    const { root, manifest } = fixture(
      "self-mutation-ordering",
      `const fs = require("node:fs");
const source = fs.readFileSync("scripts/quality-mutation-check.sh", "utf8");
if (!source.includes("role === 'admin'")) process.exit(1);
`,
      {
        sourcePath: "scripts/quality-mutation-check.sh",
        testPath: "scripts/__tests__/quality-mutation-check.test.js",
        testScript: "node scripts/__tests__/quality-mutation-check.test.js",
        uncoveredSource: true,
      },
    );

    const result = runMutationProcess(root, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("is_recursive_mutation_target");
    expect(result.stdout).toMatch(/mutation evidence: revert-diff/);
  });

  it("tries the smallest mapped behavioral proof before path order", () => {
    const { root, manifest } = fixture(
      "cost-ranking",
      `${"// expensive fixture padding\n".repeat(500)}if (!require('./aaa-expensive').isAllowed('admin')) process.exit(1);\n`,
      {
        sourcePath: "aaa-expensive.js",
        testPath: "aaa-expensive.test.js",
        testScript: "node aaa-expensive.test.js && node zzz-cheap.test.js",
        focusedMapping: true,
        costRanking: true,
      },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact.mutatedPaths).toEqual(["zzz-cheap.js"]);
  });

  it("proves only a descendant remediation delta and retains prior red evidence", () => {
    const { root, manifest } = fixture(
      "descendant-delta",
      `${"// expensive fixture padding\n".repeat(500)}if (!require('./aaa-expensive').isAllowed('admin')) process.exit(1);\n`,
      {
        sourcePath: "aaa-expensive.js",
        testPath: "aaa-expensive.test.js",
        testScript: "node aaa-expensive.test.js && node zzz-cheap.test.js",
        focusedMapping: true,
        costRanking: true,
      },
    );
    runMutation(root, manifest);
    const priorState = JSON.parse(readFileSync(manifest, "utf8"));
    const priorHead = priorState.revisions.currentHead;
    const priorArtifactSha = priorState.mutation.artifactSha256;

    writeFileSync(
      path.join(root, "aaa-expensive.js"),
      "exports.isAllowed = (role) => role === 'admin' || role === 'auditor';\n",
    );
    writeFileSync(
      path.join(root, "aaa-expensive.test.js"),
      "if (!require('./aaa-expensive').isAllowed('auditor')) process.exit(1);\n",
    );
    git(root, ["add", "aaa-expensive.js", "aaa-expensive.test.js"]);
    git(root, ["commit", "-qm", "fix: authorize auditor"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      candidateBase: priorHead,
      reusedArtifactSha256: priorArtifactSha,
      mutatedPaths: ["aaa-expensive.js"],
    });
    expect(state.mutationCarry.priorHead).toBe(priorHead);
  });

  it("excludes protected-base paths from an exact rebase-carry mutation", () => {
    const { root, manifest } = fixture(
      "rebase-live-patch",
      "const { isAllowed } = require('./logic');\nif (!isAllowed('admin')) process.exit(1);\n",
    );
    runMutation(root, manifest);
    const priorState = JSON.parse(readFileSync(manifest, "utf8"));
    const priorHead = priorState.revisions.currentHead;

    git(root, ["switch", "-q", "main"]);
    writeFileSync(
      path.join(root, "upstream-only.js"),
      "exports.protectedBase = true;\n",
    );
    git(root, ["add", "upstream-only.js"]);
    git(root, ["commit", "-qm", "fix: protected base change"]);
    const freshBase = git(root, ["rev-parse", "HEAD"]);
    git(root, ["update-ref", "refs/remotes/origin/main", freshBase]);
    git(root, ["switch", "-q", "feature"]);
    git(root, ["rebase", "origin/main"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });

    const advanced = JSON.parse(readFileSync(manifest, "utf8"));
    expect(advanced.revisions.baseRebaseCarry).toMatchObject({
      priorHead,
      baseSha: freshBase,
      head: advanced.revisions.currentHead,
    });
    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff caught by logic\.js/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      candidateBase: freshBase,
      reusedArtifactSha256: null,
      avoidedSeconds: 0,
      mutatedPaths: ["logic.js"],
      testFailureObserved: true,
    });
  });

  it("proves a submodule pointer change when a changed behavioral test observes it", () => {
    const submodule = makeTempDir(
      "quality-mutation-observed-gitlink-submodule-",
    );
    git(submodule, ["init", "-q", "-b", "main"]);
    git(submodule, ["config", "user.name", "Quality Test"]);
    git(submodule, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(submodule, "file.txt"), "v1\n");
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-q", "-m", "v1"]);
    const firstRevision = git(submodule, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(submodule, "file.txt"), "v2\n");
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-q", "-m", "v2"]);

    const root = makeTempDir("quality-mutation-observed-gitlink-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "node scripts/__tests__/submodule-routing.test.js",
          "security:audit": "true",
        },
      }),
    );
    mkdirSync(path.join(root, "scripts", "__tests__"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "__tests__", "submodule-routing.test.js"),
      "const fs = require('node:fs');\nif (fs.readFileSync('sub/file.txt', 'utf8') !== 'v1\\n') process.exit(1);\n",
    );
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submodule,
      "sub",
    ]);
    git(root, ["-C", "sub", "checkout", "-q", firstRevision]);
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "-C",
      "sub",
      "pull",
      "-q",
      "origin",
      "main",
    ]);
    writeFileSync(
      path.join(root, "scripts", "__tests__", "submodule-routing.test.js"),
      "const fs = require('node:fs');\nif (fs.readFileSync('sub/file.txt', 'utf8') !== 'v2\\n') process.exit(1);\n",
    );
    git(root, ["add", "sub", "scripts/__tests__/submodule-routing.test.js"]);
    git(root, ["commit", "-qm", "feat: route through updated submodule"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff caught by sub/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      method: "revert-diff",
      mutatedPaths: ["sub"],
      testFailureObserved: true,
    });
  });

  it("skips the gate when the diff touches only a submodule pointer bump", () => {
    const submodule = makeTempDir("quality-mutation-gitlink-submodule-");
    git(submodule, ["init", "-q", "-b", "main"]);
    git(submodule, ["config", "user.name", "Quality Test"]);
    git(submodule, ["config", "user.email", "quality@example.com"]);
    writeFileSync(path.join(submodule, "file.txt"), "v1\n");
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-q", "-m", "v1"]);
    writeFileSync(path.join(submodule, "file.txt"), "v2\n");
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-q", "-m", "v2"]);

    const root = makeTempDir("quality-mutation-gitlink-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submodule,
      "sub",
    ]);
    git(root, [
      "-C",
      "sub",
      "checkout",
      "-q",
      execFileSync(
        "git",
        ["-C", submodule, "rev-list", "--max-parents=0", "HEAD"],
        {
          encoding: "utf8",
        },
      ).trim(),
    ]);
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "-C",
      "sub",
      "pull",
      "-q",
      "origin",
      "main",
    ]);
    git(root, ["add", "sub"]);
    git(root, ["commit", "-qm", "chore: bump sub submodule"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation gate omitted: diff touches only submodule pointers/,
    );

    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).not.toBeNull();
    expect(state.mutation.head).toBe(state.revisions.currentHead);
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      method: "gitlink-skip",
      mutatedPaths: [],
      testFailureObserved: false,
    });
  });

  it("skips the gate when the diff changes only dependency manifests", () => {
    const root = makeTempDir("quality-mutation-manifest-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
        devDependencies: { "left-pad": "^1.0.0" },
      }),
    );
    writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {} }),
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);

    // A security bump: dependency manifests only, no executable source.
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
        devDependencies: { "left-pad": "^1.3.0" },
      }),
    );
    writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "fix(security): bump left-pad"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "critical",
        "--task-type",
        "bugfix",
        "--score",
        "100",
        "--agents",
        "2",
        "--codex-depth",
        "xhigh",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation gate omitted: diff contains no source file to mutate/,
    );

    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).not.toBeNull();
    expect(state.mutation.head).toBe(state.revisions.currentHead);
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      method: "no-mutable-source",
      mutatedPaths: [],
      testFailureObserved: false,
    });
  });

  it("does not carry a no-mutable-source skip into a later revision", () => {
    const root = makeTempDir("quality-mutation-skip-carry-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    writeFileSync(path.join(root, "README.md"), "first revision\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-qm", "docs: add readme"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "critical",
        "--task-type",
        "bugfix",
        "--score",
        "100",
        "--agents",
        "2",
        "--codex-depth",
        "xhigh",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );
    expect(runMutation(root, manifest)).toMatch(
      /mutation gate omitted: diff contains no source file to mutate/,
    );

    writeFileSync(path.join(root, "README.md"), "second revision\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-qm", "docs: revise readme"]);
    execFileSync("node", [INVOCATION, "advance", manifest], { cwd: root });

    expect(runMutation(root, manifest)).toMatch(
      /mutation gate omitted: diff contains no source file to mutate/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      method: "no-mutable-source",
      candidateBase: state.revisions.baseSha,
      reusedArtifactSha256: null,
      testFailureObserved: false,
    });
  });

  it("proves evidence by reverting a config file its test guards", () => {
    // A workflow/policy file plus the test that guards it has no executable
    // source to revert, but a behavioral check exists: revert the config and
    // the test must go red. The config is promoted to a candidate so the
    // normal revert-diff loop proves it (BUI-511).
    const root = makeTempDir("quality-mutation-config-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "node run-policy-test.js",
          "security:audit": "true",
        },
      }),
    );
    // Test lives under __tests__/ so it is excluded from CANDIDATES; the
    // runner shim at the root keeps the package.json test command simple.
    execFileSync("mkdir", ["-p", path.join(root, "__tests__")]);
    writeFileSync(
      path.join(root, "run-policy-test.js"),
      "require('./__tests__/policy.test.js');\n",
    );
    const guardTest =
      "const fs=require('node:fs');\nconst s=fs.readFileSync(__dirname+'/../policy.yml','utf8');\nif(!s.includes('beta')) process.exit(1);\n";
    writeFileSync(path.join(root, "policy.yml"), "allow:\n  - alpha\n");
    writeFileSync(path.join(root, "__tests__", "policy.test.js"), guardTest);
    git(root, ["add", "."]);
    // Base must be green: add beta later, so seed the test as a no-op first.
    writeFileSync(
      path.join(root, "__tests__", "policy.test.js"),
      "process.exit(0);\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);

    // Config gains 'beta'; its guarding test is tightened alongside.
    writeFileSync(
      path.join(root, "policy.yml"),
      "allow:\n  - alpha\n  - beta\n",
    );
    writeFileSync(path.join(root, "__tests__", "policy.test.js"), guardTest);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "feat: allow beta"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(runMutation(root, manifest)).toMatch(
      /mutation evidence: revert-diff/,
    );

    const state = JSON.parse(readFileSync(manifest, "utf8"));
    const artifact = JSON.parse(
      readFileSync(state.mutation.artifactPath, "utf8"),
    );
    expect(artifact).toMatchObject({
      method: "revert-diff",
      mutatedPaths: ["policy.yml"],
      testFailureObserved: true,
    });
  });

  it("still fails closed when a config change has no covering test", () => {
    // The promoted-config path must still demand real evidence: if reverting
    // the config leaves the suite green, the test never covered it.
    const root = makeTempDir("quality-mutation-cfgvac-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "node run-policy-test.js",
          "security:audit": "true",
        },
      }),
    );
    execFileSync("mkdir", ["-p", path.join(root, "__tests__")]);
    writeFileSync(
      path.join(root, "run-policy-test.js"),
      "require('./__tests__/policy.test.js');\n",
    );
    writeFileSync(path.join(root, "policy.yml"), "allow:\n  - alpha\n");
    writeFileSync(
      path.join(root, "__tests__", "policy.test.js"),
      "process.exit(0);\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);

    writeFileSync(
      path.join(root, "policy.yml"),
      "allow:\n  - alpha\n  - beta\n",
    );
    // The test file DOES change (so the config gets promoted), but the new
    // assertion is vacuous: it passes regardless of policy.yml content.
    writeFileSync(
      path.join(root, "__tests__", "policy.test.js"),
      "const fs=require('node:fs');\nfs.readFileSync(__dirname+'/../policy.yml','utf8');\nprocess.exit(0);\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "feat: allow beta"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    // Assert the REASON, not merely that it threw — otherwise an unrelated
    // crash would satisfy this test.
    expect(() => runMutation(root, manifest)).toThrow(
      /no red-capable evidence/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).toBeNull();
  });

  it("does not promote dependency manifests as config candidates", () => {
    // A routine dependency bump that also touches a test file must NOT be
    // read as a guarded-config change: reverting package.json mid-run would
    // change the very test command the sandbox is about to execute. Such
    // diffs belong to the no-mutable-source path instead.
    const root = makeTempDir("quality-mutation-deps-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    const pkg = (dep) =>
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "node __tests__/policy.test.js",
          "security:audit": "true",
        },
        devDependencies: { "left-pad": dep },
      });
    writeFileSync(path.join(root, "package.json"), pkg("^1.0.0"));
    writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {} }),
    );
    execFileSync("mkdir", ["-p", path.join(root, "__tests__")]);
    writeFileSync(
      path.join(root, "__tests__", "policy.test.js"),
      "process.exit(0);\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);

    writeFileSync(path.join(root, "package.json"), pkg("^1.3.0"));
    writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
    );
    writeFileSync(
      path.join(root, "__tests__", "policy.test.js"),
      "// touched alongside the bump\nprocess.exit(0);\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "chore: bump left-pad"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    // package.json must NOT be promoted — reverting it would change the very
    // test command the sandbox runs. With the manifest excluded and a changed
    // test present, nothing is promoted and nothing is skipped: the gate fails
    // closed, which is the correct conservative outcome for an ambiguous diff
    // (consistent with the BUI-483 finding that changed tests must not be
    // waved through). The assertion pins the reason, not merely the throw.
    expect(() => runMutation(root, manifest)).toThrow(
      /no changed executable source file can be reverted/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).toBeNull();
  });

  it("still runs the gate when the diff changes only test files", () => {
    // The candidate filter drops test paths, so a test-only diff also yields
    // zero candidates. It must NOT be waved through as "no mutable source" —
    // otherwise weakening a test would bypass mutation verification.
    const root = makeTempDir("quality-mutation-testonly-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "true",
          test: "node __tests__/logic.test.js",
          "security:audit": "true",
        },
      }),
    );
    writeFileSync(
      path.join(root, "logic.js"),
      "exports.isAllowed = () => 1;\n",
    );
    execFileSync("mkdir", ["-p", path.join(root, "__tests__")]);
    writeFileSync(
      path.join(root, "__tests__", "logic.test.js"),
      "require('../logic');\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);

    writeFileSync(
      path.join(root, "__tests__", "logic.test.js"),
      "const { isAllowed } = require('../logic');\nif (!isAllowed()) process.exit(1);\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "test: tighten logic coverage"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(() => runMutation(root, manifest)).toThrow();

    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).toBeNull();
  });

  it("still runs the gate when a manifest change also touches source", () => {
    const root = makeTempDir("quality-mutation-mixed-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    writeFileSync(path.join(root, "index.js"), "exports.add = (a, b) => a;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);

    // Manifest churn alongside a real source change must NOT be waved through
    // as "no mutable source" — the vacuous test here has to fail the gate.
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
        devDependencies: { "left-pad": "^1.3.0" },
      }),
    );
    writeFileSync(
      path.join(root, "index.js"),
      "exports.add = (a, b) => a + b;\n",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "fix: correct add and bump deps"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "critical",
        "--task-type",
        "bugfix",
        "--score",
        "100",
        "--agents",
        "2",
        "--codex-depth",
        "xhigh",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(() => runMutation(root, manifest)).toThrow();

    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).toBeNull();
  });

  it("does not abort on a diff with zero added/modified entries", () => {
    const root = makeTempDir("quality-mutation-delonly-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.com"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", test: "true", "security:audit": "true" },
      }),
    );
    writeFileSync(path.join(root, "obsolete.js"), "exports.x = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", root]);
    git(root, ["fetch", "-q", "origin", "main"]);
    git(root, ["switch", "-q", "-c", "feature"]);
    git(root, ["rm", "-q", "obsolete.js"]);
    git(root, ["commit", "-qm", "chore: remove obsolete.js"]);

    const manifest = execFileSync(
      "node",
      [INVOCATION, "create", "--repo", root, "--base-ref", "origin/main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "node",
      [
        INVOCATION,
        "risk",
        manifest,
        "--tier",
        "high",
        "--task-type",
        "feature",
        "--score",
        "50",
        "--agents",
        "2",
        "--codex-depth",
        "high",
        "--codex-rounds",
        "1",
      ],
      { cwd: root },
    );

    expect(() => runMutation(root, manifest)).toThrow(
      /no changed executable source file can be reverted/,
    );
  });

  it("rejects a timed-out test instead of recording a hang as red evidence", () => {
    const { root, manifest } = fixture(
      "hang",
      "setInterval(() => {}, 1000);\n",
      // Allow setup of the detached mutation worktree to complete before the
      // test-run cap starts deciding the outcome. A one-second total budget
      // races that setup and can exhaust before the hanging test is launched.
      { checkSeconds: 5 },
    );
    expect(() => runMutation(root, manifest)).toThrow(
      /serialized baseline test timed out; no red-capable evidence/,
    );
    const state = JSON.parse(readFileSync(manifest, "utf8"));
    expect(state.mutation).toBeNull();
    expect(state.governor.activeExecution).toBeNull();
    expect(state.governor.gateSecondsUsed).toBe(5);
  });
});
