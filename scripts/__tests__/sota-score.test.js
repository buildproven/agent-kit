const { readFileSync } = require("node:fs");
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

describe("SOTA rubric 3.0 scorer", () => {
  it("scores exactly the 15 documented rubric categories", async () => {
    const output = await scoreRepository({ schema: SETTINGS_SCHEMA });

    expect(output.rubricVersion).toBe("3.0");
    expect(Object.keys(output.categories)).toEqual([
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
    expect(Object.keys(output.scores)).toHaveLength(15);
    expect(output.categories.skill_design.inert).toEqual([]);
    expect(output.categories.skill_design.score).toBe(10);
    expect(output.categories.agent_orchestration.score).toBe(10);
  });

  it.each([
    [0, 10, null],
    [30, 10, null],
    [31, 6, "SOTA rubric is older than 30 days"],
  ])(
    "scores currency at day %i from the documented review date",
    async (days, expectedScore, expectedGap) => {
      const rubric = readFileSync(
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
        const output = await scoreRepository({ schema: SETTINGS_SCHEMA });

        expect(CURRENT_BASELINE).toBe("2.1.233");
        expect(output.categories.currency.details).toBeUndefined();
        expect(output.categories.currency.pinned).toBe("2.1.233");

        expect(output.categories.currency.score).toBe(expectedScore);
        expect(output.categories.currency.gap).toBe(expectedGap);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
