const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  CURRENT_BASELINE,
  compareVersions,
  overallScore,
  scoreRepository,
  scoreSettingsValidity,
} = require("../sota-score");

const SETTINGS_SCHEMA = {
  type: "object",
  required: ["requiredMinimumVersion", "permissions", "hooks"],
  properties: {
    requiredMinimumVersion: { type: "string" },
    permissions: { type: "object" },
    hooks: { type: "object" },
  },
};

const write = (root, relativePath, content) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const makeLayeredFixture = () => {
  const overlay = fs.mkdtempSync(path.join(os.tmpdir(), "sota-layered-"));
  const settings = JSON.stringify({
    requiredMinimumVersion: "2.1.233",
    permissions: {
      defaultMode: "auto",
      allow: [],
      deny: ["rm -rf"],
      ask: ["git push --force"],
    },
    hooks: { PreToolUse: [], PostToolUse: [], Notification: [] },
  });
  for (const prefix of ["", "core/"]) {
    write(overlay, `${prefix}config/settings.json`, settings);
    write(
      overlay,
      `${prefix}config/CLAUDE.md`,
      "# Working rules\nAct by default. Run test and lint checks. Report results. Use a feature branch and commit with git.\n",
    );
    write(
      overlay,
      `${prefix}scripts/ralph-next-run.sh`,
      '#!/usr/bin/env bash\nMAX_TRANSITIONS=8\n[ "$1" = "--help" ] && exit 0\n',
    );
    write(
      overlay,
      `${prefix}scripts/quality-run-governor.js`,
      "#!/usr/bin/env node\nif (process.argv[2] === 'check') { process.stderr.write('failing CLOSED\\n'); process.exit(1); }\nprocess.exit(2);\n",
    );
  }
  write(overlay, "core/.claude-plugin/plugin.json", '{"name":"bs"}');
  write(overlay, "core/.claude-plugin/marketplace.json", '{"plugins":[]}');
  return overlay;
};

describe("SOTA rubric 3.0 scorer", () => {
  let fixture;

  afterEach(() => {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  it("keeps the single-root output as the patch-release default", async () => {
    fixture = makeLayeredFixture();
    const output = await scoreRepository({
      root: path.join(fixture, "core"),
      schema: SETTINGS_SCHEMA,
    });
    expect(output.overall).toEqual(expect.any(Number));
    expect(output.layers).toBeUndefined();
  });

  it("opts into a versioned assessment without executing assessed scripts", async () => {
    fixture = makeLayeredFixture();
    const marker = path.join(fixture, "assessment-executed");
    write(
      fixture,
      "core/scripts/quality-run-governor.js",
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stderr.write("failing CLOSED"); process.exit(1);`,
    );
    const output = await scoreRepository({
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      overlayRoot: fixture,
      schema: SETTINGS_SCHEMA,
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(output.schemaVersion).toBe(2);
    expect(output.overall).toBeUndefined();
    expect(output.layers.public_kit.rootSelection).toBe("argument");
    expect(output.layerStates.installed_composition.state).toBe("not_assessed");
  });

  it("reports each available layer separately and does not emit a composite", async () => {
    fixture = makeLayeredFixture();
    const output = await scoreRepository({
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      overlayRoot: fixture,
      schema: SETTINGS_SCHEMA,
    });

    expect(output.rubricVersion).toBe("3.0");
    expect(output.composite).toBeNull();
    expect(output.missingLayers).toEqual(["installed_composition"]);
    expect(output.layers.public_kit.label).toBe("Public kit");
    expect(output.layers.private_overlay.label).toBe("Private overlay");
    expect(Object.keys(output.layers.public_kit.categories)).toEqual([
      "settings_validity",
      "permission_posture",
      "native_first",
      "distribution",
      "agent_orchestration",
      "claude_md",
      "bounded_autonomy",
      "hooks",
      "skill_design",
      "model_config",
      "quality_gates",
      "security",
      "git_workflow",
      "observability",
      "currency",
    ]);
    expect(Object.keys(output.layers.public_kit.scores)).toHaveLength(15);
    expect(
      output.layers.private_overlay.categories.distribution.score,
    ).toBeNull();
    expect(
      output.layers.private_overlay.categories.distribution.notApplicable,
    ).toBe("not a public distribution");
    expect(
      output.layers.private_overlay.categories.bounded_autonomy.score,
    ).toBeGreaterThan(0);
  });

  it.each([
    [0, 10, null],
    [30, 10, null],
    [31, 6, "SOTA rubric is older than 30 days"],
  ])(
    "scores currency at day %i from the documented review date",
    async (days, expectedScore, expectedGap) => {
      const rubric = fs.readFileSync(
        path.resolve(__dirname, "../../skills/sota/SKILL.md"),
        "utf8",
      );
      const reviewed = rubric.match(/Last reviewed:\s*(\d{4}-\d{2}-\d{2})/);
      expect(reviewed).not.toBeNull();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(
        new Date(Date.parse(`${reviewed[1]}T00:00:00Z`) + days * 86_400_000),
      );
      try {
        const output = await scoreRepository({
          schema: SETTINGS_SCHEMA,
          format: "layered-v2",
          publicRoot: path.resolve(__dirname, "../.."),
        });
        const currency = output.layers.public_kit.categories.currency;

        expect(CURRENT_BASELINE).toBe("2.1.233");
        expect(currency.details).toBeUndefined();
        expect(currency.pinned).toBe("2.1.233");

        expect(currency.score).toBe(expectedScore);
        expect(currency.gap).toBe(expectedGap);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("reports a missing shared governor as a structural gap", async () => {
    fixture = makeLayeredFixture();
    fs.unlinkSync(path.join(fixture, "scripts/quality-run-governor.js"));
    const options = {
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      overlayRoot: fixture,
      schema: SETTINGS_SCHEMA,
    };
    const healthy = await scoreRepository(options);
    fs.unlinkSync(path.join(fixture, "core/scripts/quality-run-governor.js"));
    const broken = await scoreRepository(options);

    expect(
      broken.layers.private_overlay.categories.bounded_autonomy.score,
    ).toBeLessThan(
      healthy.layers.private_overlay.categories.bounded_autonomy.score,
    );
    expect(
      broken.layers.private_overlay.categories.quality_gates.score,
    ).toBeLessThan(
      healthy.layers.private_overlay.categories.quality_gates.score,
    );
  });

  it("keeps the CLAUDE.md score when headings change but instructions do not", async () => {
    fixture = makeLayeredFixture();
    const options = {
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      overlayRoot: fixture,
      schema: SETTINGS_SCHEMA,
    };
    const before = await scoreRepository(options);
    write(
      fixture,
      "config/CLAUDE.md",
      "# Different labels\nAct by default. Run test and lint checks. Report results. Use a feature branch and commit with git.\n",
    );
    const after = await scoreRepository(options);

    expect(after.layers.private_overlay.categories.claude_md.score).toBe(
      before.layers.private_overlay.categories.claude_md.score,
    );
  });

  it("fails settings validity closed when the live schema is unavailable", () => {
    const scored = scoreSettingsValidity(null, "network unavailable");

    expect(scored.score).toBe(0);
    expect(scored.gap).toContain("network unavailable");
  });

  it("requires explicit roots and distinguishes missing from unassessed", async () => {
    fixture = makeLayeredFixture();
    const output = await scoreRepository({
      format: "layered-v2",
      publicRoot: path.join(fixture, "absent"),
      schema: SETTINGS_SCHEMA,
    });
    expect(output.layerStates.public_kit.state).toBe("missing");
    expect(output.layerStates.private_overlay.state).toBe("not_assessed");
    expect(output.layerStates.installed_composition.state).toBe("not_assessed");
    expect(output.layers).toEqual({});
  });

  it("rejects canonical duplicate roots and an installed source checkout", async () => {
    fixture = makeLayeredFixture();
    const output = await scoreRepository({
      format: "layered-v2",
      publicRoot: fixture,
      overlayRoot: path.join(fixture, "."),
      installedRoot: path.join(fixture, "core"),
      schema: SETTINGS_SCHEMA,
    });
    expect(output.layerStates.public_kit.state).toBe("invalid");
    expect(output.layerStates.private_overlay.state).toBe("invalid");
    expect(output.layerStates.installed_composition.state).toBe("invalid");
    expect(output.layers).toEqual({});
  });

  it("reads installed linked controls without counting source-only gates", async () => {
    fixture = makeLayeredFixture();
    const installed = path.join(fixture, "installed");
    write(
      fixture,
      "installed/settings.json",
      fs.readFileSync(path.join(fixture, "core/config/settings.json"), "utf8"),
    );
    write(
      fixture,
      "core/skills/test/SKILL.md",
      "---\ncontext: fork\n---\nUse deliberate effort high for review.\n",
    );
    for (const surface of ["scripts", "skills", "agents", "commands"]) {
      const target = path.join(fixture, "core", surface);
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(target, path.join(installed, surface));
    }
    const output = await scoreRepository({
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      installedRoot: installed,
      schema: SETTINGS_SCHEMA,
    });
    expect(output.layerStates.installed_composition.state).toBe("present");
    const layer = output.layers.installed_composition;
    expect(layer.categories.settings_validity.score).toBe(10);
    expect(layer.categories.skill_design.forked).toBe(1);
    expect(layer.categories.distribution.score).toBeNull();
    expect(layer.categories.git_workflow.score).toBeNull();
    expect(layer.source.revision).toBeNull();
    fs.symlinkSync(
      path.join(fixture, "core/skills"),
      path.join(fixture, "core/skills/cycle"),
    );
    const cyclic = await scoreRepository({
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      installedRoot: installed,
      schema: SETTINGS_SCHEMA,
    });
    expect(cyclic.layerStates.installed_composition.state).toBe("invalid");
    expect(cyclic.layers.installed_composition.readErrors.join(" ")).toContain(
      "cyclic",
    );
  });

  it.each(["surface", "control-file"])(
    "does not read outside selected sources through a %s link",
    async (kind) => {
      fixture = makeLayeredFixture();
      const installed = path.join(fixture, "installed");
      const outside = path.join(fixture, "unselected");
      write(
        fixture,
        "unselected/private/SKILL.md",
        "private content must not be read",
      );
      write(
        fixture,
        "unselected/governor.js",
        "private content must not be read",
      );
      write(
        fixture,
        "installed/settings.json",
        fs.readFileSync(
          path.join(fixture, "core/config/settings.json"),
          "utf8",
        ),
      );
      for (const surface of ["scripts", "skills", "agents", "commands"]) {
        const source = path.join(fixture, "core", surface);
        fs.mkdirSync(source, { recursive: true });
        fs.symlinkSync(
          kind === "surface" && surface === "skills" ? outside : source,
          path.join(installed, surface),
        );
      }
      if (kind === "control-file") {
        const control = path.join(
          fixture,
          "core/scripts/quality-run-governor.js",
        );
        fs.unlinkSync(control);
        fs.symlinkSync(path.join(outside, "governor.js"), control);
      }
      const outsideCanonical = fs.realpathSync(outside);
      const accesses = [];
      const spies = ["readFileSync", "readdirSync"].map((method) => {
        const original = fs[method];
        return vi.spyOn(fs, method).mockImplementation((file, ...args) => {
          if (typeof file === "string" && fs.existsSync(file)) {
            const real = fs.realpathSync(file);
            if (
              real === outsideCanonical ||
              real.startsWith(`${outsideCanonical}${path.sep}`)
            )
              accesses.push(real);
          }
          return original(file, ...args);
        });
      });
      try {
        const output = await scoreRepository({
          format: "layered-v2",
          publicRoot: path.join(fixture, "core"),
          installedRoot: installed,
          schema: SETTINGS_SCHEMA,
        });
        expect(accesses).toEqual([]);
        expect(output.layerStates.installed_composition.state).toBe("invalid");
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  );

  it("records a clean tracked nested source root with its checkout provenance", async () => {
    fixture = makeLayeredFixture();
    const git = (args) =>
      execFileSync("git", ["-C", fixture, ...args], {
        encoding: "utf8",
      }).trim();
    git(["init", "-q"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["add", "."]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const output = await scoreRepository({
      format: "layered-v2",
      publicRoot: path.join(fixture, "core"),
      overlayRoot: fixture,
      schema: SETTINGS_SCHEMA,
    });
    expect(output.layers.public_kit.source.revision).toBe(
      git(["rev-parse", "HEAD"]),
    );
    expect(output.layers.public_kit.source.checkoutRoot).toBe(
      fs.realpathSync(fixture),
    );
    expect(output.layers.public_kit.source.relativeRoot).toBe("core");
  });

  it("uses argument roots ahead of environment roots without reading the host installation", async () => {
    fixture = makeLayeredFixture();
    vi.stubEnv("SOTA_PUBLIC_ROOT", path.join(fixture, "absent"));
    try {
      const output = await scoreRepository({
        format: "layered-v2",
        publicRoot: path.join(fixture, "core"),
        schema: SETTINGS_SCHEMA,
      });
      expect(output.layerStates.public_kit.state).toBe("present");
      expect(output.layers.public_kit.rootSelection).toBe("argument");
      expect(output.layerStates.installed_composition.state).toBe(
        "not_assessed",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("emits a diagnostic envelope and fails the CLI for a missing requested root", () => {
    fixture = makeLayeredFixture();
    const preload = path.join(fixture, "schema.cjs");
    write(
      fixture,
      "schema.cjs",
      `global.fetch = async () => ({ok: true, json: async () => (${JSON.stringify(SETTINGS_SCHEMA)})});`,
    );
    const run = spawnSync(
      process.execPath,
      [
        "--require",
        preload,
        path.resolve(__dirname, "../sota-score.js"),
        "--format",
        "layered-v2",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          SOTA_PUBLIC_ROOT: path.join(fixture, "missing"),
          SOTA_OVERLAY_ROOT: "",
          SOTA_INSTALLED_ROOT: "",
        },
      },
    );
    expect(run.status).toBe(1);
    const output = JSON.parse(run.stdout);
    expect(output.schemaVersion).toBe(2);
    expect(output.layerStates.public_kit.state).toBe("missing");
  });

  it("binds clean source revisions without claiming the same identity for dirty files", async () => {
    fixture = makeLayeredFixture();
    const root = path.join(fixture, "core");
    const git = (args) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git(["init", "-q"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["add", "."]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const options = {
      format: "layered-v2",
      publicRoot: root,
      schema: SETTINGS_SCHEMA,
    };
    const clean = await scoreRepository(options);
    expect(clean.layers.public_kit.source.revision).toBe(
      git(["rev-parse", "HEAD"]),
    );
    write(root, "untracked.txt", "dirty");
    const dirty = await scoreRepository(options);
    expect(dirty.layers.public_kit.source.revision).toBeNull();
    expect(dirty.layers.public_kit.source.reason).toContain("dirty");
  });

  it("compares semantic version components numerically", () => {
    expect(compareVersions("2.1.210", "2.1.207")).toBe(1);
    expect(compareVersions("2.1.210", "2.1.210")).toBe(0);
    expect(compareVersions("2.1.99", "2.1.210")).toBe(-1);
  });

  it("does not execute a source-configured Git filesystem monitor", async () => {
    fixture = makeLayeredFixture();
    const root = path.join(fixture, "core");
    const marker = path.join(fixture, "monitor-executed");
    const monitor = path.join(fixture, "monitor.sh");
    fs.writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, {
      mode: 0o700,
    });
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "core.fsmonitor", monitor]);
    await scoreRepository({
      format: "layered-v2",
      publicRoot: root,
      schema: SETTINGS_SCHEMA,
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  describe("overallScore", () => {
    it("excludes N/A categories from the mean instead of scoring them zero", () => {
      // The real 2026-07-18 amendment: distribution is N/A for a private
      // overlay that is never published. Averaging across all 15 keys read
      // 8.2; the true mean of the 14 applicable categories is 8.8.
      const scores = {
        settings_validity: 9,
        permission_posture: 9,
        native_first: 9,
        distribution: null,
        agent_orchestration: 8,
        claude_md: 10,
        bounded_autonomy: 9,
        hooks: 9,
        skill_design: 8,
        model_config: 8,
        quality_gates: 9,
        security: 9,
        git_workflow: 10,
        observability: 7,
        currency: 9,
      };

      expect(overallScore(scores)).toBe(8.8);
    });

    it("does not let a null category deflate the average", () => {
      expect(overallScore({ a: 10, b: 10, c: null })).toBe(10);
    });

    it("returns null rather than NaN when nothing is applicable", () => {
      expect(overallScore({ a: null, b: undefined })).toBeNull();
      expect(overallScore({})).toBeNull();
    });

    it("ignores non-finite values that would poison the mean", () => {
      expect(overallScore({ a: 8, b: NaN, c: Infinity })).toBe(8);
    });
  });
});
