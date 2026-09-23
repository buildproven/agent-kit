const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const STATUS = path.join(ROOT, "scripts", "harness-certification-status.js");

function status(receipt) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-status-"));
  const target = path.join(directory, "receipt.json");
  fs.writeFileSync(target, JSON.stringify(receipt));
  try {
    return spawnSync("node", [STATUS, "--receipt", target], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const receipt = {
  schemaVersion: 1,
  kind: "frozen-harness-certification",
  candidate: { sha: "a".repeat(40) },
  gates: [],
};

describe("harness-certification-status", () => {
  it("does not offer restart when a historical owner is dead", () => {
    const result = status({
      ...receipt,
      state: "RUNNING",
      owner: { pid: 999999 },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "RETIRED",
      recordedState: "RUNNING",
      authority: "historical-only",
    });
  });

  it("makes a failed fixed gate actionable", () => {
    const result = status({
      ...receipt,
      state: "failed",
      owner: { pid: process.pid },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "RETIRED",
      recordedState: "failed",
      authority: "historical-only",
    });
  });

  it("does not trust a reused PID with a different process identity", () => {
    const result = status({
      ...receipt,
      state: "RUNNING",
      owner: {
        pid: process.pid,
        started: "Thu Jan  1 00:00:00 1970",
        command: "other",
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "RETIRED" });
  });

  it("does not turn an old passing receipt into current merge authority", () => {
    const result = status({ ...receipt, state: "passed" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "RETIRED",
      recordedState: "passed",
      authority: "historical-only",
    });
    expect(JSON.parse(result.stdout).nextAction).toContain(
      "independent review",
    );
  });

  it("rejects malformed historical states", () => {
    const result = status({ ...receipt, state: "invented-success" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown receipt state");
  });
});
