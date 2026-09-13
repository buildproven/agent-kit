const {
  changedPaths,
  execute,
  loadPolicy,
  plan,
  workingTreePaths,
} = require("../test-impact");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..", "..");

describe("cross-language test impact", () => {
  it.each(["deleted.js", "tests/test_deleted.py"])(
    "requires explicit coverage for missing %s when repository context is supplied",
    (file) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "missing-impact-"));
      expect(plan([file], { version: 1 }, { root })).toMatchObject({
        mode: "unmapped",
        uncovered: [file],
        commands: [],
      });
    },
  );

  it.each(["mappings", "audits"])(
    "preserves explicit %s for deleted source",
    (kind) => {
      const root = mkdtempSync(
        path.join(os.tmpdir(), "missing-mapped-impact-"),
      );
      const command = { executable: "node", args: ["surviving.test.js"] };
      const policy = {
        version: 1,
        [kind]: [
          {
            paths: ["deleted.js"],
            commands: [command],
            ...(kind === "audits" ? { reason: "source removal audit" } : {}),
          },
        ],
      };
      expect(plan(["deleted.js"], policy, { root })).toMatchObject({
        mode: kind === "audits" ? "audit" : "focused",
        commands: [command],
      });
    },
  );

  it("collects unstaged, staged, untracked, and both sides of a rename", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "working-impact-"));
    const git = (...args) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(path.join(root, "renamed.js"), "export const value = 1;\n");
    writeFileSync(path.join(root, "staged.js"), "export const staged = 1;\n");
    writeFileSync(
      path.join(root, "unstaged.js"),
      "export const unstaged = 1;\n",
    );
    git("add", ".");
    git("commit", "-qm", "fixture");
    git("mv", "renamed.js", "renamed-next.js");
    writeFileSync(path.join(root, "staged.js"), "export const staged = 2;\n");
    git("add", "staged.js");
    writeFileSync(
      path.join(root, "unstaged.js"),
      "export const unstaged = 2;\n",
    );
    writeFileSync(
      path.join(root, "untracked.js"),
      "export const untracked = 1;\n",
    );
    expect(workingTreePaths(root)).toEqual([
      "renamed-next.js",
      "renamed.js",
      "staged.js",
      "unstaged.js",
      "untracked.js",
    ]);
  });

  it("uses Vitest dependency-aware related tests for JS and TS", () => {
    expect(plan(["src/a.ts", "lib/b.js"])).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "npx",
          args: ["vitest", "related", "--run", "lib/b.js", "src/a.ts"],
        },
      ],
    });
  });

  it("runs only explicitly changed Python tests", () => {
    expect(plan(["tests/test_api.py"])).toMatchObject({
      mode: "focused",
      commands: [{ executable: "pytest", args: ["tests/test_api.py"] }],
    });
  });

  it("does not execute Node test helpers as standalone tests", () => {
    expect(
      plan(["tests/helpers/fixture.js"], { version: 1, jsRunner: "node" }),
    ).toMatchObject({
      mode: "unmapped",
      uncovered: ["tests/helpers/fixture.js"],
    });
    expect(
      plan(["tests/behavior.test.js"], { version: 1, jsRunner: "node" }),
    ).toMatchObject({
      mode: "focused",
      commands: [{ executable: "node", args: ["tests/behavior.test.js"] }],
    });
  });

  it.each([
    "src/api.py",
    "package-lock.json",
    ".github/workflows/quality.yml",
    "scripts/verify.sh",
    "config/runtime.json",
    "src/styles.css",
    "unknown.bin",
  ])(
    "reports unmapped impact instead of launching the full suite for %s",
    (file) => {
      expect(plan([file])).toMatchObject({
        mode: "unmapped",
        uncovered: [file],
      });
    },
  );

  it("skips tests for docs-only changes", () => {
    expect(plan(["README.md"])).toMatchObject({ mode: "none", commands: [] });
  });

  it("maps executable documentation to its smallest contract test", () => {
    const policy = {
      version: 1,
      mappings: [
        {
          paths: ["STRATEGY.md"],
          commands: [
            {
              executable: "pytest",
              args: ["tests/test_direction_consistency.py"],
            },
          ],
        },
      ],
    };
    expect(plan(["STRATEGY.md"], policy)).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "pytest",
          args: ["tests/test_direction_consistency.py"],
        },
      ],
    });
  });

  it("does not rerun a changed test already named by an explicit mapping", () => {
    const policy = {
      version: 1,
      mappings: [
        {
          paths: ["scripts/tool.js"],
          commands: [
            {
              executable: "npx",
              args: ["vitest", "run", "scripts/__tests__/tool.test.js"],
            },
          ],
        },
      ],
    };
    expect(
      plan(
        ["scripts/tool.js", "scripts/__tests__/tool.test.js", "src/other.js"],
        policy,
      ),
    ).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "npx",
          args: ["vitest", "run", "scripts/__tests__/tool.test.js"],
        },
        {
          executable: "npx",
          args: ["vitest", "related", "--run", "src/other.js"],
        },
      ],
    });
  });

  it("coalesces overlapping exact Vitest mappings into one unique run", () => {
    const policy = {
      version: 1,
      mappings: [
        {
          paths: ["scripts/a.js"],
          commands: [
            {
              executable: "npx",
              args: [
                "vitest",
                "run",
                "scripts/__tests__/a.test.js",
                "scripts/__tests__/shared.test.js",
              ],
            },
          ],
        },
        {
          paths: ["scripts/b.js"],
          commands: [
            {
              executable: "npx",
              args: [
                "vitest",
                "run",
                "scripts/__tests__/shared.test.js",
                "scripts/__tests__/b.test.js",
              ],
            },
          ],
        },
      ],
    };

    expect(plan(["scripts/a.js", "scripts/b.js"], policy)).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "npx",
          args: [
            "vitest",
            "run",
            "scripts/__tests__/a.test.js",
            "scripts/__tests__/shared.test.js",
            "scripts/__tests__/b.test.js",
          ],
        },
      ],
    });
  });

  it("does not coalesce Vitest commands with runner options", () => {
    const test = "scripts/__tests__/a.test.js";
    const result = plan(["scripts/a.js"], {
      version: 1,
      mappings: [
        {
          paths: ["scripts/a.js"],
          commands: [
            { executable: "npx", args: ["vitest", "run", "--config", test] },
          ],
        },
      ],
    });
    expect(result.commands).toEqual([
      { executable: "npx", args: ["vitest", "run", "--config", test] },
    ]);
  });

  it("does not treat an option value as an executed test target", () => {
    const test = "scripts/__tests__/tool.test.js";
    const result = plan(["scripts/tool.js", test], {
      version: 1,
      mappings: [
        {
          paths: ["scripts/tool.js"],
          commands: [
            {
              executable: "npx",
              args: ["vitest", "run", "--config", test],
            },
          ],
        },
      ],
    });
    expect(result.commands).toContainEqual({
      executable: "npx",
      args: ["vitest", "related", "--run", test],
    });
  });

  it("keeps related coverage when a positional Jest target has runner options", () => {
    const test = "tests/tool.test.js";
    const result = plan(["src/tool.js", test], {
      version: 1,
      jsRunner: "jest",
      mappings: [
        {
          paths: ["src/tool.js"],
          commands: [
            { executable: "npx", args: ["jest", test, "--runInBand"] },
          ],
        },
      ],
    });
    expect(result.commands).toEqual([
      { executable: "npx", args: ["jest", test, "--runInBand"] },
      { executable: "npx", args: ["jest", "--findRelatedTests", test] },
    ]);
  });

  it("keeps related coverage when a trailing option can exclude the target", () => {
    const test = "scripts/__tests__/tool.test.js";
    const result = plan(["scripts/tool.js", test], {
      version: 1,
      mappings: [
        {
          paths: ["scripts/tool.js"],
          commands: [
            {
              executable: "npx",
              args: ["vitest", "run", test, "--exclude", test],
            },
          ],
        },
      ],
    });
    expect(result.commands).toContainEqual({
      executable: "npx",
      args: ["vitest", "related", "--run", test],
    });
  });

  it("keeps a mixed diff blocked when one executable path is unmapped", () => {
    expect(plan(["README.md", "src/api.py", "src/view.ts"])).toMatchObject({
      mode: "unmapped",
      uncovered: ["src/api.py"],
      commands: [
        {
          executable: "npx",
          args: ["vitest", "related", "--run", "src/view.ts"],
        },
      ],
    });
  });

  it("uses an explicit complete fallback only for uncovered paths", () => {
    expect(
      plan(["README.md", "src/api.py", "src/view.ts"], {
        version: 1,
        fallback: [{ executable: "npm", args: ["test"] }],
      }),
    ).toEqual({
      mode: "audit",
      reason: "unmapped-fallback",
      files: ["README.md", "src/api.py", "src/view.ts"],
      fallbackFiles: ["src/api.py"],
      commands: [{ executable: "npm", args: ["test"] }],
    });
  });

  it("does not use the fallback for mapped, related, or documentation paths", () => {
    const policy = {
      version: 1,
      fallback: [{ executable: "npm", args: ["test"] }],
    };
    expect(plan(["src/view.ts"], policy)).toMatchObject({ mode: "focused" });
    expect(plan(["README.md"], policy)).toMatchObject({ mode: "none" });
  });

  it("supports Jest related-test selection", () => {
    expect(
      plan(["src/view.ts"], { version: 1, jsRunner: "jest" }),
    ).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "npx",
          args: ["jest", "--findRelatedTests", "src/view.ts"],
        },
      ],
    });
  });

  it("runs changed plain Node test files directly", () => {
    expect(
      plan(["tests/a.test.js", "scripts/__tests__/b.test.js"], {
        version: 1,
        jsRunner: "node",
      }),
    ).toMatchObject({
      mode: "focused",
      commands: [
        { executable: "node", args: ["scripts/__tests__/b.test.js"] },
        { executable: "node", args: ["tests/a.test.js"] },
      ],
    });
  });

  it("keeps Node source changes unmapped without a repository mapping", () => {
    expect(
      plan(["lib/a.js", "tests/a.test.js"], {
        version: 1,
        jsRunner: "node",
      }),
    ).toMatchObject({
      mode: "unmapped",
      uncovered: ["lib/a.js"],
      commands: [{ executable: "node", args: ["tests/a.test.js"] }],
    });
  });

  it("does not direct-run TypeScript tests with plain Node", () => {
    expect(
      plan(["tests/a.test.ts", "tests/b.test.tsx"], {
        version: 1,
        jsRunner: "node",
      }),
    ).toMatchObject({
      mode: "unmapped",
      uncovered: ["tests/a.test.ts", "tests/b.test.tsx"],
      commands: [],
    });
  });

  it("runs a complete regression only for an explicit audit rule", () => {
    const result = plan(["package-lock.json"], {
      version: 1,
      audits: [
        {
          paths: ["package-lock.json"],
          reason: "dependency graph changed",
          commands: [{ executable: "npm", args: ["test"] }],
        },
      ],
    });
    expect(result).toEqual({
      mode: "audit",
      reason: "dependency graph changed",
      files: ["package-lock.json"],
      commands: [{ executable: "npm", args: ["test"] }],
    });
  });

  it("uses an explicit mapping for mutation proof without weakening the audit", () => {
    const policy = {
      version: 1,
      mappings: [
        {
          paths: [".github/workflows/quality.yml"],
          commands: [
            { executable: "node", args: ["tests/quality-workflow.test.js"] },
          ],
        },
      ],
      audits: [
        {
          paths: [".github/workflows/**"],
          reason: "workflow changed",
          commands: [{ executable: "npm", args: ["test"] }],
        },
      ],
    };

    expect(plan([".github/workflows/quality.yml"], policy)).toMatchObject({
      mode: "audit",
      commands: [{ executable: "npm", args: ["test"] }],
    });
    expect(
      plan([".github/workflows/quality.yml"], policy, {
        preferExplicitMappings: true,
      }),
    ).toMatchObject({
      mode: "focused",
      reason: "explicit-mutation-mapping",
      commands: [
        { executable: "node", args: ["tests/quality-workflow.test.js"] },
      ],
    });
  });

  it("uses the workflow bootstrap contract for a quality-workflow mutation", () => {
    expect(
      plan([".github/workflows/quality.yml"], loadPolicy(ROOT), {
        preferExplicitMappings: true,
      }),
    ).toMatchObject({
      mode: "focused",
      reason: "explicit-mutation-mapping",
      commands: [
        {
          executable: "npx",
          args: [
            "vitest",
            "run",
            "scripts/__tests__/quality-workflow-bootstrap.test.js",
          ],
        },
      ],
    });
  });

  it("maps the protected-push guard to its behavioral contract", () => {
    expect(
      plan(["scripts/block-push-main.sh"], loadPolicy(ROOT)),
    ).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "npx",
          args: [
            "vitest",
            "run",
            "scripts/__tests__/branch-guard-hooks.test.js",
          ],
        },
      ],
    });
  });

  it("maps the Codex skill-profile setup script to its behavioral contract", () => {
    expect(
      plan(["scripts/setup-codex-skill-profile.sh"], loadPolicy(ROOT)),
    ).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "npx",
          args: [
            "vitest",
            "run",
            "scripts/__tests__/setup-codex-skill-profile.test.js",
          ],
        },
      ],
    });
  });

  it("treats a trailing-slash path as an explicit directory prefix", () => {
    expect(
      plan([".github/workflows/quality.yml"], {
        version: 1,
        mappings: [
          {
            paths: [".github/workflows/"],
            commands: [
              {
                executable: "node",
                args: ["tests/workflow-contract.test.js"],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      mode: "focused",
      commands: [
        {
          executable: "node",
          args: ["tests/workflow-contract.test.js"],
        },
      ],
    });
  });

  it("does not authorize an unknown change set", () => {
    expect(plan([])).toMatchObject({
      mode: "unmapped",
      reason: "unknown-change-set",
    });
  });

  it("executes argv commands without a shell", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-impact-"));
    const target = path.join(root, "evidence.txt");
    expect(
      execute(
        {
          mode: "focused",
          commands: [
            {
              executable: process.execPath,
              args: [
                "-e",
                `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'ok')`,
              ],
            },
          ],
        },
        root,
      ),
    ).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("ok");
  });

  it("runs npx selectors from prepared dependencies without installing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-impact-npx-"));
    const bin = path.join(root, "bin");
    const target = path.join(root, "argv.txt");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "npx"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${target}"\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      expect(
        execute(
          {
            mode: "focused",
            commands: [
              { executable: "npx", args: ["vitest", "run", "one.test.js"] },
            ],
          },
          root,
        ),
      ).toBe(0);
    } finally {
      process.env.PATH = previousPath;
    }
    expect(readFileSync(target, "utf8").split("\n")).toEqual([
      "--no-install",
      "vitest",
      "run",
      "one.test.js",
      "",
    ]);
  });

  it("does not mistake a package argument for the npx no-install option", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-impact-npx-order-"));
    const bin = path.join(root, "bin");
    const target = path.join(root, "argv.txt");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "npx"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${target}"\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      expect(
        execute(
          {
            mode: "focused",
            commands: [{ executable: "npx", args: ["vitest", "--no-install"] }],
          },
          root,
        ),
      ).toBe(0);
    } finally {
      process.env.PATH = previousPath;
    }
    expect(readFileSync(target, "utf8").split("\n")).toEqual([
      "--no-install",
      "vitest",
      "--no-install",
      "",
    ]);
  });

  it("fails visibly instead of executing partial commands when impact is unmapped", () => {
    expect(
      execute({
        mode: "unmapped",
        remediation: "map src/api.py",
        commands: [
          { executable: process.execPath, args: ["-e", "process.exit(0)"] },
        ],
      }),
    ).toBe(2);
  });

  it("rejects a policy whose content no longer matches the persisted gate", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-impact-policy-"));
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(
      path.join(root, ".buildproven", "test-impact.json"),
      JSON.stringify({ version: 1 }),
    );
    const child = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", "test-impact.js"),
        "--execute",
        "--policy-sha256",
        "0".repeat(64),
        "--",
        "README.md",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(child.status).toBe(2);
    expect(child.stderr).toContain(
      "does not match the persisted exact-head policy",
    );
  });

  it("uses a trusted policy root while it plans candidate files", () => {
    const candidate = mkdtempSync(
      path.join(os.tmpdir(), "test-impact-candidate-"),
    );
    const trusted = mkdtempSync(path.join(os.tmpdir(), "test-impact-trusted-"));
    mkdirSync(path.join(candidate, ".buildproven"));
    mkdirSync(path.join(trusted, ".buildproven"));
    writeFileSync(
      path.join(candidate, ".buildproven", "test-impact.json"),
      JSON.stringify({ version: 1, audits: [] }),
    );
    writeFileSync(
      path.join(trusted, ".buildproven", "test-impact.json"),
      JSON.stringify({
        version: 1,
        audits: [
          {
            paths: [".buildproven/test-impact.json"],
            reason: "trusted policy changed",
            commands: [{ executable: "node", args: ["tests/a.test.js"] }],
          },
        ],
      }),
    );
    const child = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", "test-impact.js"),
        "--policy-root",
        trusted,
        "--",
        ".buildproven/test-impact.json",
      ],
      { cwd: candidate, encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      mode: "audit",
      reason: "trusted policy changed",
    });
  });

  it("rejects unsupported options", () => {
    const child = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", "test-impact.js"),
        "--typo",
        "--",
        "README.md",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(child.status).toBe(2);
    expect(child.stderr).toContain("unsupported option --typo");
  });

  it("resolves an exact Git range inside the trusted selector", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-impact-range-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    writeFileSync(path.join(root, "README.md"), "one\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(path.join(root, "README.md"), "two\n");
    execFileSync("git", ["commit", "--quiet", "-am", "head"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(changedPaths(base, head, root)).toEqual(["README.md"]);
    const child = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", "test-impact.js"),
        "--git-range",
        base,
        head,
        "--",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ mode: "none" });
  });

  it("rejects invalid Git ranges and mixed explicit paths", () => {
    const script = path.resolve(__dirname, "..", "test-impact.js");
    const invalid = spawnSync(
      process.execPath,
      [script, "--git-range", "main", "HEAD", "--"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("two exact 40-character SHAs");
    const sha = "a".repeat(40);
    const mixed = spawnSync(
      process.execPath,
      [script, "--git-range", sha, sha, "--", "README.md"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toContain("does not accept explicit paths");
  });

  it("rejects misspelled policy fields instead of silently weakening selection", () => {
    expect(() => plan(["src/a.ts"], { version: 1, mapping: [] })).toThrow(
      /unsupported fields: mapping/,
    );
  });

  it("reports malformed policy JSON as an actionable configuration error", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-impact-json-"));
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(path.join(root, ".buildproven", "test-impact.json"), "{");
    expect(() => loadPolicy(root)).toThrow(
      /.buildproven\/test-impact.json is not valid JSON/,
    );
  });
});
