const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { makeTempDir } = require("./helpers/tmp.js");

const RECOVER = path.resolve(__dirname, "../harness-certification-recover.js");

describe("retired certification recovery", () => {
  it.each(["RUNNING", "passed"])(
    "refuses restart and preserves a %s historical receipt",
    (state) => {
      const root = makeTempDir("retired-recovery-");
      const prior = path.join(root, "prior.json");
      const out = path.join(root, "next.json");
      const original = JSON.stringify({
        schemaVersion: 1,
        kind: "frozen-harness-certification",
        state,
        owner: { pid: 999999 },
      });
      fs.writeFileSync(prior, original);
      const result = spawnSync(
        process.execPath,
        [RECOVER, "--receipt", prior, "--out", out],
        { cwd: root, encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status, result.stderr).toBe(78);
      expect(result.stderr).toContain("retired");
      expect(result.stderr).toContain("harness-certification-status.js");
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(prior, "utf8")).toBe(original);
      expect(fs.existsSync(out)).toBe(false);
    },
  );
});
