import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

describe("command index validation on the system Bash", () => {
  it.each([
    { missing: false, status: 0 },
    { missing: true, status: 1 },
  ])("reports missing=$missing with exit $status", ({ missing, status }) => {
    const root = makeTempDir("command-index-test-");
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "commands", "bs"), { recursive: true });
    const script = join(root, "scripts", "check-command-readme.sh");
    copyFileSync(
      resolve(import.meta.dirname, "../check-command-readme.sh"),
      script,
    );
    writeFileSync(
      join(root, "commands", "README.md"),
      `| Command | Purpose |\n| --- | --- |\n| \`/bs:dev\` | Existing |\n${missing ? "| `/bs:missing` | Missing |\n" : ""}`,
    );
    writeFileSync(join(root, "commands", "bs", "dev.md"), "# Dev\n");
    const result = spawnSync("/bin/bash", [script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(status);
    if (missing) expect(result.stdout + result.stderr).toContain("/bs:missing");
  });
});
