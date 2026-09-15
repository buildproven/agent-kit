import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const root = resolve(import.meta.dirname, "../..");
const scripts = join(root, "scripts");

describe.each(["quality-status.sh", "quality-load-root.sh"])(
  "%s arguments",
  (name) => {
    it.each([
      ["--manifest"],
      ["--manifest", ""],
      ["--manifest", "--unknown"],
      ["--manifest="],
      ["--manifest=--unknown"],
    ])(
      "BUI-844: rejects malformed manifest arguments %j without hanging",
      (...args) => {
        const result = spawnSync("bash", [join(scripts, name), ...args], {
          encoding: "utf8",
          timeout: 1000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("--manifest requires a non-empty path");
      },
    );
  },
);

it("BUI-844: valid status and load-root calls preserve exact manifest evidence", () => {
  const target = makeTempDir("quality-status-cli-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: target, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Status Test");
  git("config", "user.email", "status@example.com");
  writeFileSync(join(target, "README.md"), "Status fixture\n");
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({
      scripts: { lint: "true", test: "true", "security:audit": "true" },
    }),
  );
  git("add", ".");
  git("commit", "-qm", "docs: initial fixture");
  git("remote", "add", "origin", target);
  git("fetch", "-q", "origin", "main");
  git("switch", "-qc", "fix/status");
  writeFileSync(join(target, "README.md"), "Changed status fixture\n");
  git("commit", "-qam", "docs: update fixture");
  const bootstrap = spawnSync(
    "node",
    [
      join(scripts, "quality-wrapper.js"),
      join(scripts, "quality-bootstrap.sh"),
    ],
    {
      cwd: target,
      input: JSON.stringify({
        argv: ["--target-dir", target, "--delivery-claim", "contract"],
      }),
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(bootstrap.status, bootstrap.stderr).toBe(0);
  const manifest = bootstrap.stdout
    .split("\n")
    .find((line) => line.startsWith("BS_QUALITY_MANIFEST="))
    ?.slice("BS_QUALITY_MANIFEST=".length);
  expect(manifest).toBeTruthy();
  const before = readFileSync(manifest, "utf8");
  for (const name of ["quality-status.sh", "quality-load-root.sh"]) {
    for (const args of [["--manifest", manifest], [`--manifest=${manifest}`]]) {
      const result = spawnSync("bash", [join(scripts, name), ...args], {
        cwd: target,
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        name === "quality-status.sh" ? result.stderr : result.stdout,
      ).toContain(manifest);
      expect(readFileSync(manifest, "utf8")).toBe(before);
    }
  }
}, 30000);
