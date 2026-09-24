const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { classify, collect, evaluate } = require("../ci-budget-admission");

const policy = {
  accountType: "organization",
  account: "example",
  includedMinutes: 100,
  softLimitPercent: 75,
  hardLimitPercent: 90,
  cacheHours: 6,
  staleHours: 24,
};

describe("CI budget admission", () => {
  it("uses two calls and excludes public and archived repositories", () => {
    let calls = 0;
    const execute = (_command, args) => {
      calls += 1;
      if (args[0] === "repo")
        return JSON.stringify([
          { name: "private", isPrivate: true, isArchived: false },
          { name: "public", isPrivate: false, isArchived: false },
        ]);
      return JSON.stringify({
        usageItems: [
          {
            product: "actions",
            unitType: "Minutes",
            repositoryName: "private",
            quantity: 8,
          },
          {
            product: "actions",
            unitType: "Minutes",
            repositoryName: "public",
            quantity: 70,
          },
        ],
      });
    };
    expect(
      collect(policy, execute, new Date("2026-08-12T12:00:00Z")),
    ).toMatchObject({ usedMinutes: 8, apiCallCount: 2 });
    expect(calls).toBe(2);
  });

  it("fails closed on stale snapshots and the hard limit", () => {
    const now = new Date("2026-08-12T12:00:00Z");
    expect(
      classify(
        { fetchedAt: "2026-08-11T11:00:00Z", usedMinutes: 1 },
        policy,
        now,
      ).state,
    ).toBe("stale");
    expect(
      classify({ fetchedAt: now.toISOString(), usedMinutes: 90 }, policy, now),
    ).toMatchObject({ state: "hard", allowed: false });
  });

  it("refuses to undercount fleets larger than the bounded repository page", () => {
    const execute = vi.fn(() =>
      JSON.stringify(
        Array.from({ length: 101 }, (_, index) => ({
          name: `repo-${index}`,
          isPrivate: true,
          isArchived: false,
        })),
      ),
    );
    expect(() => collect(policy, execute)).toThrow(/more than 100/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("places git-hook budget admission before its terminal exit", () => {
    const hook = fs.readFileSync(
      path.join(__dirname, "..", "branch-protection-hook.sh"),
      "utf8",
    );
    expect(hook.indexOf("ci-budget-admission.js")).toBeGreaterThan(-1);
    expect(hook.indexOf("ci-budget-admission.js")).toBeLessThan(
      hook.lastIndexOf("exit 0"),
    );
  });

  it("is a no-op when an operator has not installed a fleet policy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-budget-disabled-"));
    try {
      expect(
        evaluate({ env: { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root } }),
      ).toEqual({ state: "disabled", allowed: true, breakGlass: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reserves exit 2 for a valid billing-policy denial", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-budget-denial-"));
    const policyPath = path.join(root, "agent-kit", "ci-budget-policy.json");
    const snapshotPath = path.join(
      root,
      "agent-kit",
      "ci-budget",
      "snapshot.json",
    );
    try {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      fs.writeFileSync(policyPath, JSON.stringify(policy));
      fs.writeFileSync(
        snapshotPath,
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          usedMinutes: 95,
        }),
      );
      const result = spawnSync(
        "node",
        [path.join(__dirname, "..", "ci-budget-admission.js")],
        {
          env: { ...process.env, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        state: "hard",
        allowed: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exit 1 for malformed policy instead of a recoverable denial", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-budget-error-"));
    const policyPath = path.join(root, "agent-kit", "ci-budget-policy.json");
    try {
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.writeFileSync(policyPath, "not-json");
      const result = spawnSync(
        "node",
        [path.join(__dirname, "..", "ci-budget-admission.js")],
        {
          env: { ...process.env, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        state: "unavailable",
        allowed: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
