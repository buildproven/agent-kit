const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ZipFS } = require("@yarnpkg/libzip");
const { makeTempDir } = require("./helpers/tmp.js");

const PREFLIGHT = path.resolve(
  __dirname,
  "..",
  "quality-dependency-preflight.js",
);
const BUNDLED_PREFLIGHT = path.resolve(
  __dirname,
  "..",
  "generated",
  "quality-dependency-preflight",
  "index.js",
);
const BOOTSTRAP = path.resolve(__dirname, "..", "quality-bootstrap.sh");
const PATTERN_CONFIG = path.resolve(
  __dirname,
  "..",
  "..",
  ".defensive-patterns.json",
);

function fixture() {
  const root = makeTempDir("quality-dependency-preflight-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Quality Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "quality@example.com"], {
    cwd: root,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        lint: "eslint .",
        test: "node test.js",
        "security:audit": "true",
      },
      devDependencies: { eslint: "1.2.3" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { eslint: "1.2.3" } },
        "node_modules/eslint": { version: "1.2.3" },
      },
    }),
  );
  fs.writeFileSync(path.join(root, "test.js"), "process.exit(0);\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function selectFixtureManager(root, manager, version) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  pkg.packageManager = `${manager}@${version}`;
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
}

function installFixturePackage(root) {
  const packageRoot = path.join(root, "node_modules", "eslint");
  const binRoot = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "eslint",
      version: "1.2.3",
      bin: { eslint: "bin.js" },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "bin.js"), "", { mode: 0o755 });
  fs.symlinkSync(
    path.join("..", "eslint", "bin.js"),
    path.join(binRoot, "eslint"),
  );
}

function installPnpmFixturePackage(root) {
  const packageRoot = path.join(
    root,
    "node_modules",
    ".pnpm",
    "eslint@1.2.3",
    "node_modules",
    "eslint",
  );
  const binRoot = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "eslint",
      version: "1.2.3",
      bin: { eslint: "bin.js" },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "bin.js"), "", { mode: 0o755 });
  fs.symlinkSync(
    path.join(".pnpm", "eslint@1.2.3", "node_modules", "eslint"),
    path.join(root, "node_modules", "eslint"),
  );
  fs.symlinkSync(
    path.join("..", "eslint", "bin.js"),
    path.join(binRoot, "eslint"),
  );
}

function installYarnPnpFixture(
  root,
  packageManifest = { name: "eslint", version: "1.2.3", bin: "bin.js" },
  extraFiles = [],
) {
  selectFixtureManager(root, "yarn", "4.18.0");
  const zip = new ZipFS(null);
  zip.mkdirpSync("/node_modules/eslint");
  zip.writeFileSync(
    "/node_modules/eslint/package.json",
    typeof packageManifest === "string"
      ? packageManifest
      : JSON.stringify(packageManifest),
  );
  zip.writeFileSync("/node_modules/eslint/bin.js", "#!/usr/bin/env node\n");
  for (const [file, content] of extraFiles) zip.writeFileSync(file, content);
  zip.writeFileSync("/node_modules/eslint/a.txt", "a");
  zip.writeFileSync("/node_modules/eslint/b.txt", "b");
  const bytes = zip.getBufferAndClose();
  const archive = path.join(root, ".yarn", "cache", "eslint.zip");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, bytes);
  const checksum = crypto.createHash("sha512").update(bytes).digest("hex");
  fs.writeFileSync(
    path.join(root, "yarn.lock"),
    `__metadata:\n  version: 10\n"eslint@npm:1.2.3":\n  version: 1.2.3\n  resolution: "eslint@npm:1.2.3"\n  checksum: test/${checksum}\n  linkType: hard\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "npm:1.2.3"\n`,
  );
  fs.writeFileSync(
    path.join(root, ".yarnrc.yml"),
    "pnpEnableInlining: false\n",
  );
  fs.writeFileSync(
    path.join(root, ".pnp.data.json"),
    JSON.stringify({
      dependencyTreeRoots: [{ name: "fixture", reference: "workspace:." }],
      packageRegistryData: [
        [
          "fixture",
          [
            [
              "workspace:.",
              {
                packageLocation: "./",
                packageDependencies: [
                  ["eslint", "npm:1.2.3"],
                  ["fixture", "workspace:."],
                ],
                linkType: "SOFT",
              },
            ],
          ],
        ],
        [
          "eslint",
          [
            [
              "npm:1.2.3",
              {
                packageLocation:
                  "./.yarn/cache/eslint.zip/node_modules/eslint/",
                packageDependencies: [["eslint", "npm:1.2.3"]],
                linkType: "HARD",
              },
            ],
          ],
        ],
      ],
    }),
  );
  return { archive };
}

function installYarnDirectoryPnpFixture(root) {
  selectFixtureManager(root, "yarn", "4.18.0");
  const packageRoot = path.join(
    root,
    ".yarn",
    "unplugged",
    "eslint",
    "node_modules",
    "eslint",
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "eslint", version: "1.2.3", bin: "missing.js" }),
  );
  fs.writeFileSync(
    path.join(root, "yarn.lock"),
    '__metadata:\n  version: 10\n"eslint@npm:1.2.3":\n  version: 1.2.3\n  resolution: "eslint@npm:1.2.3"\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "npm:1.2.3"\n',
  );
  fs.writeFileSync(
    path.join(root, ".yarnrc.yml"),
    "pnpEnableInlining: false\n",
  );
  fs.writeFileSync(
    path.join(root, ".pnp.data.json"),
    JSON.stringify({
      dependencyTreeRoots: [{ name: "fixture", reference: "workspace:." }],
      packageRegistryData: [
        [
          "fixture",
          [
            [
              "workspace:.",
              {
                packageLocation: "./",
                packageDependencies: [["eslint", "npm:1.2.3"]],
                linkType: "SOFT",
              },
            ],
          ],
        ],
        [
          "eslint",
          [
            [
              "npm:1.2.3",
              {
                packageLocation:
                  "./.yarn/unplugged/eslint/node_modules/eslint/",
                packageDependencies: [["eslint", "npm:1.2.3"]],
                linkType: "SOFT",
              },
            ],
          ],
        ],
      ],
    }),
  );
}

describe("quality dependency preflight", () => {
  it.each(["relative", "absolute"])(
    "checks executable hooks in a %s custom hooks directory without requiring Husky",
    (kind) => {
      const root = fixture();
      installFixturePackage(root);
      const directory = path.join(root, "custom-hooks");
      fs.mkdirSync(directory);
      const hook = path.join(directory, "pre-push");
      fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o644 });
      execFileSync(
        "git",
        [
          "config",
          "core.hooksPath",
          kind === "absolute" ? directory : "custom-hooks",
        ],
        { cwd: root },
      );
      const run = () =>
        spawnSync("node", [PREFLIGHT, "--repo", root], { encoding: "utf8" });
      const missingMode = run();
      expect(missingMode.status, missingMode.stderr).toBe(78);
      expect(missingMode.stderr).toContain("pre-push");
      fs.chmodSync(hook, 0o755);
      const ready = run();
      expect(ready.status, ready.stderr).toBe(0);
      fs.unlinkSync(hook);
      fs.symlinkSync("missing-hook", hook);
      expect(run().status).toBe(78);
    },
  );

  it("rejects tracked Husky hooks when hooksPath was never configured", () => {
    const root = fixture();
    installFixturePackage(root);
    fs.mkdirSync(path.join(root, ".husky"));
    fs.writeFileSync(path.join(root, ".husky/pre-commit"), "exit 1\n");
    execFileSync("git", ["add", ".husky"], { cwd: root });
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain("pre-commit");
  });

  it("blocks missing generated hooks in a linked worktree without running prepare", () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, ".husky"));
    fs.writeFileSync(path.join(root, ".husky/pre-commit"), "exit 1\n");
    execFileSync("git", ["add", ".husky"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "declare hooks"], { cwd: root });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], {
      cwd: root,
    });
    const linked = path.join(makeTempDir("hook-worktree-"), "linked");
    execFileSync("git", ["worktree", "add", "-qb", "delivery", linked], {
      cwd: root,
    });
    installFixturePackage(linked);
    const pkgFile = path.join(linked, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.scripts.prepare =
      'node -e \'require("fs").writeFileSync("unsafe-prepare","ran")\'';
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const result = spawnSync("node", [PREFLIGHT, "--repo", linked], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain("pre-commit");
    expect(result.stderr).toContain("prepare");
    expect(fs.existsSync(path.join(linked, "unsafe-prepare"))).toBe(false);
    fs.mkdirSync(path.join(linked, ".husky/_"));
    fs.writeFileSync(
      path.join(linked, ".husky/_/pre-commit"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const missingDispatcher = spawnSync("node", [PREFLIGHT, "--repo", linked], {
      encoding: "utf8",
    });
    expect(missingDispatcher.status, missingDispatcher.stderr).toBe(78);
    expect(missingDispatcher.stderr).toContain("/h");
    fs.writeFileSync(path.join(linked, ".husky/_/h"), "exit 0\n");
    const repaired = spawnSync("node", [PREFLIGHT, "--repo", linked], {
      encoding: "utf8",
    });
    expect(repaired.status, repaired.stderr).toBe(0);
  });

  it.each([
    ["v1.2.3", "1.2.3", 0],
    ["v1.2.3-rc.1+build.7", "1.2.3-rc.1+build.7", 0],
    ["v1.2.3-rc.1", "1.2.3", 78],
    ["v1.2.3+build.7", "1.2.3+build.8", 78],
    ["vv1.2.3", "1.2.3", 78],
    ["v01.2.3", "1.2.3", 78],
    ["v1.2", "1.2.3", 78],
    ["v1.2.3 ", "1.2.3", 78],
  ])(
    "binds installed version %s to exact lock identity %s",
    (installedVersion, lockedVersion, status) => {
      const root = fixture();
      installFixturePackage(root);
      const manifestFile = path.join(root, "node_modules/eslint/package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      manifest.version = installedVersion;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      const pkgFile = path.join(root, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      pkg.devDependencies.eslint = lockedVersion;
      fs.writeFileSync(pkgFile, JSON.stringify(pkg));
      const lockFile = path.join(root, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      lock.packages[""].devDependencies.eslint = lockedVersion;
      lock.packages["node_modules/eslint"].version = lockedVersion;
      fs.writeFileSync(lockFile, JSON.stringify(lock));
      const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(status);
      if (status !== 0) expect(result.stderr).toContain("lockfile requires");
    },
  );

  it.each([
    ["npm", "6.14.0"],
    ["pnpm", "8.15.0"],
    ["yarn", "1.22.22"],
    ["bun", "1.1.0"],
  ])(
    "rejects %s versions that cannot consume the selected lock schema",
    (manager, version) => {
      const root = fixture();
      selectFixtureManager(root, manager, version);
      if (manager !== "npm") {
        const lockName = {
          pnpm: "pnpm-lock.yaml",
          yarn: "yarn.lock",
          bun: "bun.lock",
        }[manager];
        fs.renameSync(
          path.join(root, "package-lock.json"),
          path.join(root, lockName),
        );
        fs.writeFileSync(
          path.join(root, lockName),
          manager === "pnpm"
            ? "lockfileVersion: '9.0'\n"
            : manager === "yarn"
              ? "__metadata:\n  version: 10\n"
              : '{"lockfileVersion":1,"workspaces":{},"packages":{}}',
        );
      }
      const result = spawnSync(process.execPath, [PREFLIGHT, "--repo", root], {
        encoding: "utf8",
      });
      expect(result.status).toBe(78);
      expect(result.stderr).toMatch(/incompatible with .* lock schema/);
    },
  );

  it("rejects stale PnP data when Yarn uses the inline loader", () => {
    const root = fixture();
    installYarnPnpFixture(root);
    fs.writeFileSync(
      path.join(root, ".yarnrc.yml"),
      "pnpEnableInlining: true\n",
    );
    const result = spawnSync(process.execPath, [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/pnpEnableInlining: false/);
  });

  it("rejects Yarn archive bin targets outside the package root", () => {
    const root = fixture();
    installYarnPnpFixture(
      root,
      { name: "eslint", version: "1.2.3", bin: "../../payload.js" },
      [["/payload.js", "#!/usr/bin/env node\n"]],
    );
    const result = spawnSync(process.execPath, [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/archive declared bin escapes package root/);
  });

  it("applies JSON safety checks to Yarn archive package manifests", () => {
    const root = fixture();
    installYarnPnpFixture(
      root,
      '{"name":"eslint","version":"1.2.3","bin":"bin.js","__proto__":{}}',
    );
    const result = spawnSync(process.execPath, [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/forbidden property/);
  });

  it("records structured telemetry for thrown inspection failures", () => {
    const root = fixture();
    const telemetry = path.join(root, "state", "preflight.jsonl");
    fs.writeFileSync(path.join(root, "package.json"), "{");
    const result = spawnSync(process.execPath, [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
      env: { ...process.env, BS_QUALITY_PREFLIGHT_TELEMETRY_FILE: telemetry },
    });
    expect(result.status).toBe(78);
    const record = JSON.parse(fs.readFileSync(telemetry, "utf8"));
    expect(record.manager).toBeNull();
    expect(record.failures).toEqual([
      expect.stringMatching(/package inspection failed:/),
    ]);
  });

  it("preserves the selected manager in telemetry for adapter exceptions", () => {
    const root = fixture();
    const telemetry = path.join(root, "state", "preflight.jsonl");
    installYarnPnpFixture(root);
    fs.writeFileSync(path.join(root, ".pnp.data.json"), "{");
    const result = spawnSync(process.execPath, [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
      env: { ...process.env, BS_QUALITY_PREFLIGHT_TELEMETRY_FILE: telemetry },
    });
    expect(result.status).toBe(78);
    const record = JSON.parse(fs.readFileSync(telemetry, "utf8"));
    expect(record.manager).toBe("yarn");
    expect(record.failures).toEqual([
      expect.stringMatching(/yarn inspection failed:/),
    ]);
  });

  it("rejects Windows cross-volume candidates with the shared subpath predicate", () => {
    const { isSubpath } = require(PREFLIGHT);
    expect(isSubpath("C:\\repo", "D:\\outside\\tool", path.win32)).toBe(false);
    expect(isSubpath("C:\\repo", "C:\\repo\\tool", path.win32)).toBe(true);
  });

  it("accepts a package repository with no direct dependencies", () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.js" } }),
    );
    fs.rmSync(path.join(root, "package-lock.json"));
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects missing package-local dependencies before campaign creation and records telemetry", () => {
    const root = fixture();
    const telemetry = path.join(root, "preflight.jsonl");
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
      env: { ...process.env, BS_QUALITY_PREFLIGHT_TELEMETRY_FILE: telemetry },
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/eslint: package is not installed/);
    expect(result.stderr).toMatch(/Run npm ci in this exact worktree/);
    expect(JSON.parse(fs.readFileSync(telemetry, "utf8"))).toMatchObject({
      recordClass: "preflight",
      failureCount: 1,
      manager: "npm",
    });
  });

  it("accepts the exact lockfile package and package-local executable", () => {
    const root = fixture();
    installFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts exact pnpm schema 9 state", () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint:\n        specifier: 1.2.3\n        version: 1.2.3\npackages:\n  eslint@1.2.3:\n    resolution: {integrity: sha512-YQ==}\nsnapshots:\n  eslint@1.2.3: {}\n",
    );
    installPnpmFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("parses scoped pnpm package versions before peer suffixes", () => {
    const { pnpmDepPathIdentity, pnpmPackageIdentity } = require(PREFLIGHT);
    const depPath = "@axe-core/playwright@4.13.0(playwright-core@1.63.0)";
    expect(pnpmDepPathIdentity(depPath)).toEqual({
      name: "@axe-core/playwright",
      version: "4.13.0",
    });
    expect(pnpmPackageIdentity("axe", "npm:" + depPath)).toEqual({
      name: "@axe-core/playwright",
      depPath,
    });
  });

  it("accepts pnpm command shims whose marker uses the project symlink", async () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint:\n        specifier: 1.2.3\n        version: 1.2.3\npackages:\n  eslint@1.2.3:\n    resolution: {integrity: sha512-YQ==}\nsnapshots:\n  eslint@1.2.3: {}\n",
    );
    installPnpmFixturePackage(root);
    const command = path.join(root, "node_modules", ".bin", "eslint");
    fs.unlinkSync(command);
    for (const suffix of [".cmd", ".ps1"]) {
      fs.rmSync(`${command}${suffix}`, { force: true });
    }
    const { cmdShim } = await import("@zkochan/cmd-shim");
    await cmdShim(path.join(root, "node_modules", "eslint", "bin.js"), command);
    for (const suffix of [".cmd", ".ps1"]) {
      fs.rmSync(`${command}${suffix}`, { force: true });
    }
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a pnpm selection outside the manifest constraint", () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint:\n        specifier: 1.2.3\n        version: 9.9.9\npackages:\n  eslint@9.9.9:\n    resolution: {integrity: sha512-YQ==}\nsnapshots:\n  eslint@9.9.9: {}\n",
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(
      /pnpm selection eslint@9\.9\.9 does not satisfy 1\.2\.3/,
    );
  });

  it.each([
    {
      manager: "npm",
      version: "11.6.2",
      lock: "package-lock.json",
      source: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { devDependencies: { eslint: "1.2.3" } },
          "node_modules/eslint": { version: "9.9.9" },
        },
      }),
    },
    {
      manager: "yarn",
      version: "4.18.0",
      lock: "yarn.lock",
      source:
        '__metadata:\n  version: 10\n"eslint@npm:1.2.3":\n  version: 9.9.9\n  resolution: "eslint@npm:9.9.9"\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "npm:1.2.3"\n',
    },
    {
      manager: "bun",
      version: "1.4.0",
      lock: "bun.lock",
      source:
        '{"lockfileVersion":1,"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@9.9.9","",{}]}}',
    },
  ])(
    "rejects a $manager registry selection outside its manifest constraint",
    ({ manager, version, lock, source }) => {
      const root = fixture();
      selectFixtureManager(root, manager, version);
      if (lock !== "package-lock.json")
        fs.rmSync(path.join(root, "package-lock.json"));
      fs.writeFileSync(path.join(root, lock), source);
      if (manager === "yarn") {
        fs.writeFileSync(
          path.join(root, ".yarnrc.yml"),
          "nodeLinker: node-modules\n",
        );
        fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "node_modules", ".yarn-state.yml"),
          '__metadata:\n  version: 1\n"eslint@npm:9.9.9":\n  locations:\n    - "node_modules/eslint"\n',
        );
      }
      const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
        encoding: "utf8",
      });
      expect(result.status).toBe(78);
      expect(result.stderr).toMatch(/selection .*does not satisfy 1\.2\.3/);
    },
  );

  it("accepts exact Yarn node-modules state without loading .pnp.cjs", () => {
    const root = fixture();
    selectFixtureManager(root, "yarn", "4.18.0");
    fs.writeFileSync(
      path.join(root, "yarn.lock"),
      '__metadata:\n  version: 10\n"eslint@npm:1.2.3":\n  version: 1.2.3\n  resolution: "eslint@npm:1.2.3"\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "npm:1.2.3"\n',
    );
    fs.writeFileSync(
      path.join(root, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", ".yarn-state.yml"),
      '__metadata:\n  version: 1\n"eslint@npm:1.2.3":\n  locations:\n    - "node_modules/eslint"\n',
    );
    installFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts exact Bun text lock state", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      '{\n  "lockfileVersion": 1,\n  "workspaces": {"": {"devDependencies": {"eslint": "1.2.3"}}},\n  "packages": {"eslint": ["eslint@1.2.3", "", {}]},\n}\n',
    );
    installFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a pnpm importer selection missing from package and snapshot graphs", () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint:\n        specifier: 1.2.3\n        version: 1.2.3\npackages: {}\nsnapshots: {}\n",
    );
    installPnpmFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/pnpm package graph does not bind/);
  });

  it.each([
    {
      manager: "pnpm",
      lock: "pnpm-lock.yaml",
      source:
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint:\n        specifier: 1.2.3\n        version: link:packages/eslint\npackages: {}\nsnapshots: {}\n",
    },
    {
      manager: "bun",
      lock: "bun.lock",
      source:
        '{"lockfileVersion":1,"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@file:packages/eslint","",{}]}}',
    },
  ])(
    "rejects an uninstalled $manager local dependency",
    ({ manager, lock, source }) => {
      const root = fixture();
      selectFixtureManager(
        root,
        manager,
        manager === "pnpm" ? "11.25.0" : "1.4.0",
      );
      const local = path.join(root, "packages", "eslint");
      fs.mkdirSync(local, { recursive: true });
      fs.writeFileSync(
        path.join(local, "package.json"),
        JSON.stringify({ name: "eslint", version: "1.2.3" }),
      );
      fs.writeFileSync(path.join(root, lock), source);
      const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
        encoding: "utf8",
      });
      expect(result.status).toBe(78);
      expect(result.stderr).toMatch(/installed package.*ENOENT|not installed/u);
    },
  );

  it("reports the repair command for the declared package manager", () => {
    const root = fixture();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    pkg.packageManager = "pnpm@10.0.0";
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
      env: {
        ...process.env,
        BS_QUALITY_PREFLIGHT_TELEMETRY_FILE: path.join(root, "preflight.jsonl"),
      },
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/pnpm install --frozen-lockfile/);
  });

  it("rejects ambiguous lockfiles when packageManager is absent", () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/ambiguous \(npm, pnpm\)/);
  });

  it("does not execute an inline Yarn PnP loader", () => {
    const root = fixture();
    const marker = path.join(root, "executed");
    selectFixtureManager(root, "yarn", "4.18.0");
    fs.writeFileSync(
      path.join(root, "yarn.lock"),
      '__metadata:\n  version: 10\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "npm:1.2.3"\n"eslint@npm:1.2.3":\n  version: 1.2.3\n  resolution: "eslint@npm:1.2.3"\n',
    );
    fs.writeFileSync(
      path.join(root, ".pnp.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");\n`,
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/pnpEnableInlining: false/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("accepts data-only Yarn PnP with a checksum-bound hard-cache ZIP", () => {
    const root = fixture();
    installYarnPnpFixture(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("selects the repository PnP root instead of the first workspace root", () => {
    const root = fixture();
    installYarnPnpFixture(root);
    const file = path.join(root, ".pnp.data.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.dependencyTreeRoots.unshift({
      name: "other",
      reference: "workspace:other",
    });
    data.packageRegistryData.unshift([
      "other",
      [
        [
          "workspace:other",
          {
            packageLocation: "./packages/other/",
            packageDependencies: [["eslint", "npm:1.2.3"]],
            linkType: "SOFT",
          },
        ],
      ],
    ]);
    data.packageRegistryData.find(
      ([name]) => name === "fixture",
    )[1][0][1].packageDependencies = [];
    fs.writeFileSync(file, JSON.stringify(data));
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/PnP reference does not bind yarn\.lock/);
  });

  it("rejects a directory-backed Yarn PnP package with a missing declared bin", () => {
    const root = fixture();
    installYarnDirectoryPnpFixture(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/missing\.js|bin eslint/u);
  });

  it("rejects a directory-backed Yarn PnP local package at an alternate path", () => {
    const root = fixture();
    selectFixtureManager(root, "yarn", "4.18.0");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    pkg.devDependencies.eslint = "workspace:packages/eslint";
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "yarn.lock"),
      '__metadata:\n  version: 10\n"eslint@workspace:packages/eslint":\n  version: 1.2.3\n  resolution: "eslint@workspace:packages/eslint"\n  linkType: soft\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "workspace:packages/eslint"\n',
    );
    fs.writeFileSync(
      path.join(root, ".yarnrc.yml"),
      "pnpEnableInlining: false\n",
    );
    const locked = path.join(root, "packages", "eslint");
    const alternate = path.join(root, "packages", "alternate");
    for (const directory of [locked, alternate]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "eslint", version: "1.2.3" }),
      );
    }
    fs.writeFileSync(
      path.join(root, ".pnp.data.json"),
      JSON.stringify({
        dependencyTreeRoots: [{ name: "fixture", reference: "workspace:." }],
        packageRegistryData: [
          [
            "fixture",
            [
              [
                "workspace:.",
                {
                  packageLocation: "./",
                  packageDependencies: [
                    ["eslint", "workspace:packages/eslint"],
                  ],
                  linkType: "SOFT",
                },
              ],
            ],
          ],
          [
            "eslint",
            [
              [
                "workspace:packages/eslint",
                {
                  packageLocation: "./packages/alternate/",
                  packageDependencies: [],
                  linkType: "SOFT",
                },
              ],
            ],
          ],
        ],
      }),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/locked Yarn local target/);
  });

  it("rejects duplicate raw ZIP entries before Yarn path normalization", () => {
    const root = fixture();
    const { archive } = installYarnPnpFixture(root);
    const bytes = fs.readFileSync(archive);
    const from = Buffer.from("node_modules/eslint/b.txt");
    const to = Buffer.from("node_modules/eslint/a.txt");
    const centralName = bytes.lastIndexOf(from);
    expect(centralName).toBeGreaterThan(-1);
    to.copy(bytes, centralName);
    fs.writeFileSync(archive, bytes);
    const lockFile = path.join(root, "yarn.lock");
    const lock = fs
      .readFileSync(lockFile, "utf8")
      .replace(
        /checksum: test\/[a-f0-9]+/u,
        `checksum: test/${crypto.createHash("sha512").update(bytes).digest("hex")}`,
      );
    fs.writeFileSync(lockFile, lock);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/duplicate or unsafe entry/);
  });

  it("rejects a ZIP whose expanded bytes differ from forged size metadata", () => {
    const root = fixture();
    const { archive } = installYarnPnpFixture(root);
    const bytes = fs.readFileSync(archive);
    const entry = Buffer.from("node_modules/eslint/package.json");
    const centralName = bytes.lastIndexOf(entry);
    const centralOffset = centralName - 46;
    const localOffset = bytes.readUInt32LE(centralOffset + 42);
    bytes.writeUInt32LE(1, centralOffset + 24);
    bytes.writeUInt32LE(1, localOffset + 22);
    fs.writeFileSync(archive, bytes);
    const lockFile = path.join(root, "yarn.lock");
    const lock = fs
      .readFileSync(lockFile, "utf8")
      .replace(
        /checksum: test\/[a-f0-9]+/u,
        `checksum: test/${crypto.createHash("sha512").update(bytes).digest("hex")}`,
      );
    fs.writeFileSync(lockFile, lock);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/expanded size differs from metadata/);
  });

  it("rejects aggregate ZIP expansion metadata before inflating the entry", () => {
    const root = fixture();
    const { archive } = installYarnPnpFixture(root);
    const bytes = fs.readFileSync(archive);
    const entry = Buffer.from("node_modules/eslint/package.json");
    const centralName = bytes.lastIndexOf(entry);
    const centralOffset = centralName - 46;
    const localOffset = bytes.readUInt32LE(centralOffset + 42);
    const excessive = bytes.length * 100 + 1;
    bytes.writeUInt32LE(excessive, centralOffset + 24);
    bytes.writeUInt32LE(excessive, localOffset + 22);
    fs.writeFileSync(archive, bytes);
    const lockFile = path.join(root, "yarn.lock");
    const lock = fs
      .readFileSync(lockFile, "utf8")
      .replace(
        /checksum: test\/[a-f0-9]+/u,
        `checksum: test/${crypto.createHash("sha512").update(bytes).digest("hex")}`,
      );
    fs.writeFileSync(lockFile, lock);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/archive expansion limit exceeded/);
  });

  it("rejects a regular command shim with injected shell code", () => {
    const root = fixture();
    installPnpmFixturePackage(root);
    const target = fs.realpathSync(
      path.join(root, "node_modules", "eslint", "bin.js"),
    );
    const command = path.join(root, "node_modules", ".bin", "eslint");
    fs.unlinkSync(command);
    fs.writeFileSync(
      command,
      `#!/bin/sh\ntouch /tmp/preflight-pwned\n# cmd-shim-target=${target}\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/differs from the supported template/);
  });

  it.each(["injected-command", "comment-decoy"])(
    "rejects a shim with %s even when it names the correct target",
    async (variant) => {
      const root = fixture();
      installPnpmFixturePackage(root);
      const target = path.join(root, "node_modules", "eslint", "bin.js");
      const command = path.join(root, "node_modules", ".bin", "eslint");
      fs.unlinkSync(command);
      const { cmdShim } = await import("@zkochan/cmd-shim");
      await cmdShim(target, command);
      const template = fs.readFileSync(command, "utf8");
      const content =
        variant === "injected-command"
          ? template.replace("#!/bin/sh\n", "#!/bin/sh\nprintf injected >&2\n")
          : `#!/bin/sh\nprintf injected >&2\n# exec "$basedir/../eslint/bin.js"\n# cmd-shim-target=${target}\n`;
      fs.writeFileSync(command, content);
      const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
        encoding: "utf8",
      });
      expect(result.status).toBe(78);
      expect(result.stderr).toMatch(/differs from the supported template/);
    },
  );

  it("rejects an exact regular shim that targets a different command owner", async () => {
    const root = fixture();
    installFixturePackage(root);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    pkg.bin = { eslint: "tools/pwn.js" };
    fs.mkdirSync(path.join(root, "tools"));
    fs.writeFileSync(path.join(root, "tools", "pwn.js"), "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    const command = path.join(root, "node_modules", ".bin", "eslint");
    fs.unlinkSync(command);
    const { cmdShim } = await import("@zkochan/cmd-shim");
    await cmdShim(path.join(root, "tools", "pwn.js"), command);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/eslint targets the wrong file/);
  });

  it("rejects a command shim owned by a package absent from the lockfile", () => {
    const root = fixture();
    installFixturePackage(root);
    const rogue = path.join(root, "node_modules", "rogue");
    fs.mkdirSync(rogue);
    fs.writeFileSync(
      path.join(rogue, "package.json"),
      JSON.stringify({ name: "rogue", version: "9.9.9", bin: "bin.js" }),
    );
    fs.writeFileSync(path.join(rogue, "bin.js"), "", { mode: 0o755 });
    fs.symlinkSync(
      path.join("..", "rogue", "bin.js"),
      path.join(root, "node_modules", ".bin", "rogue"),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/owner is not bound by the lockfile/);
  });

  it.each([
    ["2.0.0", 0],
    ["v2.0.0", 0],
    ["v2.0.0+different", 78],
    ["vv2.0.0", 78],
  ])(
    "binds transitive command owner version %s to its exact lock-backed path",
    (version, status) => {
      const root = fixture();
      installFixturePackage(root);
      const helper = path.join(root, "node_modules", "helper");
      fs.mkdirSync(helper);
      fs.writeFileSync(
        path.join(helper, "package.json"),
        JSON.stringify({ name: "helper", version, bin: "bin.js" }),
      );
      fs.writeFileSync(path.join(helper, "bin.js"), "", { mode: 0o755 });
      fs.symlinkSync(
        path.join("..", "helper", "bin.js"),
        path.join(root, "node_modules", ".bin", "helper"),
      );
      const lockFile = path.join(root, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      lock.packages["node_modules/helper"] = { version: "2.0.0" };
      fs.writeFileSync(lockFile, JSON.stringify(lock));
      const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(status);
      if (status !== 0)
        expect(result.stderr).toContain("owner is not bound by the lockfile");
    },
  );

  it("rejects a command NODE_PATH with a nonexistent leaf under a symlink", async () => {
    const root = fixture();
    installFixturePackage(root);
    const external = makeTempDir("quality-node-path-external-");
    fs.symlinkSync(external, path.join(root, "escape"));
    const target = fs.realpathSync(
      path.join(root, "node_modules", "eslint", "bin.js"),
    );
    const command = path.join(root, "node_modules", ".bin", "eslint");
    fs.unlinkSync(command);
    const { cmdShim } = await import("@zkochan/cmd-shim");
    await cmdShim(target, command, {
      nodePath: [path.join(root, "escape", "pending")],
    });
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/NODE_PATH escapes the repository/);
  });

  it("accepts exact POSIX, CMD, and PowerShell wrappers from the supported generator", async () => {
    const root = fixture();
    installPnpmFixturePackage(root);
    const target = fs.realpathSync(
      path.join(root, "node_modules", "eslint", "bin.js"),
    );
    const command = path.join(root, "node_modules", ".bin", "eslint");
    fs.unlinkSync(command);
    const { cmdShim } = await import("@zkochan/cmd-shim");
    await cmdShim(target, command, {
      createCmdFile: true,
      createPwshFile: true,
      nodePath: [path.join(root, "node_modules")],
    });
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an orphan executable omitted from its target package manifest", () => {
    const root = fixture();
    installFixturePackage(root);
    const manifest = path.join(root, "node_modules", "eslint", "package.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ name: "eslint", version: "1.2.3" }),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(
      /executable is not declared by its target package/,
    );
  });

  it("rejects an installed package symlink that escapes the repository", () => {
    const root = fixture();
    const external = makeTempDir("quality-dependency-external-");
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(external, "package.json"),
      JSON.stringify({ name: "eslint", version: "1.2.3" }),
    );
    fs.symlinkSync(external, path.join(root, "node_modules", "eslint"));
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/escapes the repository/);
  });

  it("rejects reversed pnpm environment and project documents", () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies: {}\npackages: {}\nsnapshots: {}\n---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\npackages: {}\nsnapshots: {}\n",
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(
      /first document is not an environment lockfile/,
    );
  });

  it("rejects a pnpm patched locator backed by the unpatched package path", () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint:\n        specifier: 1.2.3\n        version: 1.2.3(patch_hash=deadbeef)\npackages:\n  eslint@1.2.3:\n    resolution: {integrity: sha512-YQ==}\nsnapshots:\n  eslint@1.2.3(patch_hash=deadbeef): {}\n",
    );
    installPnpmFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/eslint@1\.2\.3_patch_hash=deadbeef/);
  });

  it("reports the exact Bun binary-lock migration command", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    fs.writeFileSync(path.join(root, "bun.lockb"), "binary");
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(
      /bun install --save-text-lockfile --frozen-lockfile --lockfile-only/,
    );
  });

  it("rejects a Bun schema 3 override that differs from package.json", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    pkg.overrides = { eslint: "1.2.3" };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      '{"lockfileVersion":3,"overrides":{"eslint":"9.9.9"},"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@1.2.3","",{}]}}',
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/schema 3 overrides do not match/);
  });

  it("rejects a Bun schema 3 package record that ignores the effective override", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    pkg.overrides = { eslint: "2.0.0" };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      '{"lockfileVersion":3,"overrides":{"eslint":"2.0.0"},"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@1.2.3","",{}]}}',
    );
    installFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/override requires 2\.0\.0/);
  });

  it("rejects a Bun schema 2 external tarball without integrity", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      '{"lockfileVersion":2,"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@1.2.3","https://outside.example/eslint.tgz",{},""]}}',
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/remote package has no integrity/);
  });

  it("rejects Bun external global-store mode", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    fs.writeFileSync(
      path.join(root, "bunfig.toml"),
      "[install]\nglobalStore = true\n",
    );
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      '{"lockfileVersion":1,"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@1.2.3","",{}]}}',
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/install.globalStore is unsupported/);
  });

  it("rejects prototype-mutating Bun lock properties", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      '{"__proto__":{"lockfileVersion":1,"workspaces":{"":{"devDependencies":{"eslint":"1.2.3"}}},"packages":{"eslint":["eslint@1.2.3","",{}]}}}',
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/forbidden property '__proto__'/);
  });

  it("accepts a scoped Bun workspace locator bound to its installed path", () => {
    const root = fixture();
    selectFixtureManager(root, "bun", "1.4.0");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    pkg.devDependencies = { "@scope/tool": "workspace:packages/tool" };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          "": {
            devDependencies: {
              "@scope/tool": "workspace:packages/tool",
            },
          },
        },
        packages: {
          "@scope/tool": ["@scope/tool@workspace:packages/tool", "", {}],
        },
      }),
    );
    const local = path.join(root, "packages", "tool");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(
      path.join(local, "package.json"),
      JSON.stringify({ name: "@scope/tool", version: "1.2.3" }),
    );
    fs.mkdirSync(path.join(root, "node_modules", "@scope"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join("..", "..", "packages", "tool"),
      path.join(root, "node_modules", "@scope", "tool"),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("counts scalar JSON values before allocating parsed objects", () => {
    const { validateJsonText } = require(PREFLIGHT);
    const source = `[${"0,".repeat(1_000_000)}0]`;
    expect(() => validateJsonText(source, "scalar lock")).toThrow(
      /exceeds 1000000 nodes/,
    );
  });

  it("counts scalar YAML values before allocating parsed objects", () => {
    const { validateYamlText } = require(PREFLIGHT);
    const source = `[${"0,".repeat(1_000_000)}0]`;
    expect(() => validateYamlText(source, "scalar lock")).toThrow(
      /exceeds 1000000 pre-parse tokens/,
    );
  });

  it("rejects YAML depth before document composition", () => {
    const { validateYamlText } = require(PREFLIGHT);
    let source = "value: 1\n";
    for (let depth = 0; depth < 130; depth += 1) {
      source = `level:\n${source
        .split("\n")
        .filter(Boolean)
        .map((line) => `  ${line}`)
        .join("\n")}\n`;
    }
    expect(() => validateYamlText(source, "deep YAML")).toThrow(
      /exceeds 128 pre-parse levels/,
    );
  });

  it("rejects YAML flow-depth underflow before composition", () => {
    const { validateYamlText } = require(PREFLIGHT);
    expect(() => validateYamlText("]\nvalue: 1\n", "malformed YAML")).toThrow(
      /flow-depth underflow/,
    );
  });

  it("reads pnpm modules state once for all direct dependencies", async () => {
    const root = fixture();
    selectFixtureManager(root, "pnpm", "11.25.0");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    pkg.devDependencies.prettier = "2.3.4";
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      eslint: {specifier: 1.2.3, version: 1.2.3}\n      prettier: {specifier: 2.3.4, version: 2.3.4}\npackages: {}\nsnapshots: {}\n",
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const modulesFile = path.join(root, "node_modules", ".modules.yaml");
    fs.writeFileSync(modulesFile, "virtualStoreDirMaxLength: 120\n");
    const originalOpenSync = fs.openSync;
    let reads = 0;
    fs.openSync = function countedOpen(file, ...args) {
      if (file === modulesFile) reads += 1;
      return originalOpenSync.call(this, file, ...args);
    };
    try {
      await require(PREFLIGHT).inspectDependencies(root);
    } finally {
      fs.openSync = originalOpenSync;
    }
    expect(reads).toBe(1);
  });

  it("validates Windows wrappers beside a correct command symlink", () => {
    const root = fixture();
    installFixturePackage(root);
    fs.writeFileSync(
      path.join(root, "node_modules", ".bin", "eslint.cmd"),
      "@echo malicious\r\n",
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/\.cmd differs from the supported template/);
  });

  it("rejects unbound executables in a dependency-free project", () => {
    const root = fixture();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    pkg.devDependencies = {};
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
    );
    const binRoot = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, "stale"), "#!/bin/sh\nexit 0\n");
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/unbound node_modules\/\.bin entries/);
  });

  it("rejects npm lockfile schema 4 until its graph metadata is supported", () => {
    const root = fixture();
    installFixturePackage(root);
    const lockFile = path.join(root, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile));
    lock.lockfileVersion = 4;
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/unsupported package-lock schema 4/);
  });

  it("rejects a malformed exact package-manager SemVer", () => {
    const root = fixture();
    selectFixtureManager(root, "npm", "9.0.0-not a valid version");
    installFixturePackage(root);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/packageManager must be/);
  });

  it("rejects JSON input deeper than the parser contract", () => {
    const root = fixture();
    let nested = {};
    for (let depth = 0; depth < 130; depth += 1) nested = { child: nested };
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    );
    lock.nested = nested;
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify(lock),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/exceeds 128 levels/);
  });

  it("rejects a lockfile symlink instead of following it", () => {
    const root = fixture();
    const external = makeTempDir("quality-lock-external-");
    const lockFile = path.join(root, "package-lock.json");
    const externalLock = path.join(external, "package-lock.json");
    fs.writeFileSync(externalLock, fs.readFileSync(lockFile));
    fs.unlinkSync(lockFile);
    fs.symlinkSync(externalLock, lockFile);
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/ELOOP|symbolic links encountered/);
  });

  it("rejects a file identity that changes during a stable read", async () => {
    const root = fixture();
    const original = fs.fstatSync;
    let firstDescriptor;
    let observations = 0;
    const spy = vi.spyOn(fs, "fstatSync").mockImplementation((descriptor) => {
      const stat = original(descriptor);
      if (firstDescriptor === undefined) firstDescriptor = descriptor;
      if (descriptor !== firstDescriptor) return stat;
      observations += 1;
      if (observations !== 2) return stat;
      return new Proxy(stat, {
        get(target, property) {
          return property === "mtimeMs" ? target.mtimeMs + 1 : target[property];
        },
      });
    });
    try {
      const { inspectDependencies } = require(PREFLIGHT);
      await expect(inspectDependencies(root)).rejects.toThrow(
        /changed while being read/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("binds the opened installed manifest to its contained path identity", async () => {
    const root = fixture();
    installFixturePackage(root);
    const original = fs.statSync;
    const spy = vi.spyOn(fs, "statSync").mockImplementation((file) => {
      const stat = original(file);
      if (
        !String(file).endsWith(
          path.join("node_modules", "eslint", "package.json"),
        )
      ) {
        return stat;
      }
      return new Proxy(stat, {
        get(target, property) {
          return property === "ino" ? target.ino + 1 : target[property];
        },
      });
    });
    try {
      const { inspectDependencies } = require(PREFLIGHT);
      const result = await inspectDependencies(root);
      expect(result.failures.join("\n")).toMatch(
        /opened object does not match the contained path/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("declares stable-read host support explicitly", () => {
    const { stableReadsSupported } = require(PREFLIGHT);
    expect(stableReadsSupported({ O_NOFOLLOW: 1 })).toBe(true);
    expect(stableReadsSupported({})).toBe(false);
  });

  it.each([
    {
      name: "npm workspace link records",
      lock: {
        lockfileVersion: 3,
        packages: {
          "": { devDependencies: { eslint: "1.2.3" } },
          "node_modules/eslint": { link: true, resolved: "packages/eslint" },
          "packages/eslint": { version: "1.2.3" },
        },
      },
    },
  ])("accepts $name when the installed package matches", ({ lock }) => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify(lock),
    );
    const packageRoot = path.join(root, "packages", "eslint");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "eslint", version: "1.2.3" }),
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.relative(path.join(root, "node_modules"), packageRoot),
      path.join(root, "node_modules", "eslint"),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an npm workspace link that resolves to a same-version alternate target", () => {
    const root = fixture();
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { eslint: "1.2.3" } },
        "node_modules/eslint": { link: true, resolved: "packages/eslint" },
        "packages/eslint": { version: "1.2.3" },
      },
    };
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify(lock),
    );
    const locked = path.join(root, "packages", "eslint");
    const alternate = path.join(root, "packages", "alternate");
    for (const directory of [locked, alternate]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "eslint", version: "1.2.3" }),
      );
    }
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.relative(path.join(root, "node_modules"), alternate),
      path.join(root, "node_modules", "eslint"),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/does not match package-lock target/);
  });

  it("rejects a Yarn workspace link to a same-version alternate target", () => {
    const root = fixture();
    selectFixtureManager(root, "yarn", "4.18.0");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    pkg.devDependencies.eslint = "workspace:packages/eslint";
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(root, "yarn.lock"),
      '__metadata:\n  version: 10\n"eslint@workspace:packages/eslint":\n  version: 1.2.3\n  resolution: "eslint@workspace:packages/eslint"\n  linkType: soft\n"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    eslint: "workspace:packages/eslint"\n',
    );
    fs.writeFileSync(
      path.join(root, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", ".yarn-state.yml"),
      '__metadata:\n  version: 1\n"eslint@workspace:packages/eslint":\n  locations:\n    - "node_modules/eslint"\n',
    );
    const locked = path.join(root, "packages", "eslint");
    const alternate = path.join(root, "packages", "alternate");
    for (const directory of [locked, alternate]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "eslint", version: "1.2.3" }),
      );
    }
    fs.symlinkSync(
      path.relative(path.join(root, "node_modules"), alternate),
      path.join(root, "node_modules", "eslint"),
    );
    const result = spawnSync("node", [PREFLIGHT, "--repo", root], {
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/locked Yarn local target/);
  });

  it("wires the preflight before immutable manifest creation", () => {
    const source = fs.readFileSync(BOOTSTRAP, "utf8");
    expect(source).toContain(
      'generated/quality-dependency-preflight/index.js" --repo "$GIT_ROOT"',
    );
    expect(
      source.indexOf("generated/quality-dependency-preflight"),
    ).toBeLessThan(
      source.indexOf('quality-invocation.js" "${CREATE_ARGS[@]}"'),
    );
  });

  it("keeps generated bundles out of source-pattern analysis", () => {
    const config = JSON.parse(fs.readFileSync(PATTERN_CONFIG, "utf8"));
    expect(config.excludePaths).toContain("scripts/generated/**");
    expect(config.excludePaths).not.toContain("scripts/**");
  });

  it("runs the source-owned bundle without loading parser packages from the candidate", () => {
    const root = fixture();
    installFixturePackage(root);
    const result = spawnSync("node", [BUNDLED_PREFLIGHT, "--repo", root], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: path.join(root, "missing-node-path") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("package dependency preflight passed");
  });
});
