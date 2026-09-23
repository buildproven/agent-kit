const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { makeTempDir } = require("./helpers/tmp.js");

const CERTIFY = path.resolve(__dirname, "../harness-certify.js");

describe("retired harness certification", () => {
  it.each([false, true])(
    "refuses execution without creating or replacing evidence (existing=%s)",
    (existing) => {
      const root = makeTempDir("retired-certify-");
      const out = path.join(root, "receipt.json");
      const previous = '{"state":"passed","historical":true}\n';
      if (existing) fs.writeFileSync(out, previous);
      const result = spawnSync(
        process.execPath,
        [
          CERTIFY,
          "--baseline-sha",
          "a".repeat(40),
          "--candidate-dir",
          root,
          "--candidate-head",
          "b".repeat(40),
          "--base-sha",
          "a".repeat(40),
          "--profile",
          "agent-kit",
          "--claim",
          "engineering",
          "--github-repo",
          "buildproven/agent-kit",
          "--pr",
          "644",
          "--out",
          out,
        ],
        { cwd: root, encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status, result.stderr).toBe(78);
      expect(result.stderr).toContain("retired");
      expect(result.stderr).toContain("independent review");
      expect(result.stdout).toBe("");
      expect(fs.existsSync(out)).toBe(existing);
      if (existing) expect(fs.readFileSync(out, "utf8")).toBe(previous);
    },
  );
});
