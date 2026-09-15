const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

  it("reports each available layer separately and does not emit a composite", async () => {
    fixture = makeLayeredFixture();
    const output = await scoreRepository({
      root: fixture,
      detectInstalled: false,
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
          detectInstalled: false,
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
  it("lowers the overlay score when its executable governor stops failing closed", async () => {
    fixture = makeLayeredFixture();
    const options = {
      root: fixture,
      detectInstalled: false,
      schema: SETTINGS_SCHEMA,
    };
    const healthy = await scoreRepository(options);
    write(
      fixture,
      "core/scripts/quality-run-governor.js",
      "#!/usr/bin/env node\nprocess.exit(0);\n",
    );
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
      root: fixture,
      detectInstalled: false,
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

  it("compares semantic version components numerically", () => {
    expect(compareVersions("2.1.210", "2.1.207")).toBe(1);
    expect(compareVersions("2.1.210", "2.1.210")).toBe(0);
    expect(compareVersions("2.1.99", "2.1.210")).toBe(-1);
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
