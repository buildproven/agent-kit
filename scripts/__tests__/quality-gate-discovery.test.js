import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);
const { discoverRequiredGates } = require(
  path.join(ROOT, "scripts", "quality-gate-discovery.js"),
);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("quality gate discovery", () => {
  it("discovers the package gates through its public interface", () => {
    const root = makeTempDir("quality-gate-discovery-");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Quality Test"]);
    git(root, ["config", "user.email", "quality@example.test"]);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: {
          lint: "eslint .",
          test: "vitest run",
          "security:audit": "npm audit --audit-level high",
          build: "node build.js",
        },
      }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-qm", "test: add package gates"]);

    expect(discoverRequiredGates(root, {})).toMatchObject([
      { name: "lint", source: "package-script:lint", executable: "npm" },
      { name: "test", source: "package-script:test", executable: "npm" },
      {
        name: "security",
        source: "package-script:security:audit",
        executable: "npm",
      },
      { name: "build", source: "package-script:build", executable: "npm" },
    ]);
  });
});
