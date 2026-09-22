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
  it("makes a dead owner recoverable instead of reporting it as active", () => {
    const result = status({
      ...receipt,
      state: "RUNNING",
      owner: { pid: 999999 },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "RECOVERABLE" });
  });

  it("makes a failed fixed gate actionable", () => {
    const result = status({
      ...receipt,
      state: "failed",
      owner: { pid: process.pid },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "NEEDS_FIX" });
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
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "RECOVERABLE" });
  });

  it("does not trust a reused gate process group without its original identity", () => {
    const result = status({
      ...receipt,
      state: "RUNNING",
      owner: { pid: 999999 },
      gates: [{ processGroup: process.pid }],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "RECOVERABLE" });
  });

  it("keeps a recorded live gate leader running when its stable identity matches", () => {
    const observed = spawnSync(
      "/bin/ps",
      ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
      { encoding: "utf8" },
    )
      .stdout.trim()
      .match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    const result = status({
      ...receipt,
      state: "RUNNING",
      owner: { pid: 999999 },
      gates: [
        {
          processGroup: process.pid,
          process: {
            pid: process.pid,
            started: observed[1],
            command: "pre-exec wrapper",
          },
        },
      ],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "RUNNING" });
  });
});
