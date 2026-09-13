import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readlinkSync,
  realpathSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const SCRIPT = path.resolve(import.meta.dirname, "..", "setup-claude-sync.sh");
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const LINK_MANIFEST = path.join(
  REPO_ROOT,
  "scripts",
  "claude-link-manifest.sh",
);

/** Run the sync script against a throwaway config dir. Never touches a real $HOME. */
function run(args, configDir, scriptPath = SCRIPT, setCodexTarget = true) {
  const env = {
    ...process.env,
    HOME: path.dirname(configDir),
    CLAUDE_CONFIG_DIR: configDir,
  };
  if (setCodexTarget) {
    env.CODEX_AGENT_SKILLS_DIR = path.join(
      path.dirname(configDir),
      ".agents",
      "skills",
    );
  } else {
    delete env.CODEX_AGENT_SKILLS_DIR;
  }
  try {
    const stdout = execFileSync("bash", [scriptPath, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const sandbox = () => path.join(makeTempDir("kit-sync-"), ".claude");

describe("setup-claude-sync.sh", () => {
  it("uses the same declared installation surface as install.sh", () => {
    const manifest = readFileSync(LINK_MANIFEST, "utf8");
    const install = readFileSync(path.join(REPO_ROOT, "install.sh"), "utf8");
    const sync = readFileSync(SCRIPT, "utf8");
    expect(manifest).toContain(
      "CLAUDE_LINK_DIRS=(commands skills agents scripts)",
    );
    expect(install).toContain(
      'source "$PROJECT_DIR/scripts/claude-link-manifest.sh"',
    );
    expect(sync).toContain(
      'source "$REPO_ROOT/scripts/claude-link-manifest.sh"',
    );
  });

  it("--repair links all four dirs and every hook resolves", () => {
    const cfg = sandbox();
    const { code, stdout } = run(["--repair"], cfg);

    expect(code).toBe(0);
    for (const d of ["commands", "skills", "agents", "scripts"]) {
      expect(readlinkSync(path.join(cfg, d))).toBe(path.join(REPO_ROOT, d));
    }
    // scripts/ is the load-bearing one: settings.json wires 14 hooks through it.
    expect(existsSync(path.join(cfg, "scripts", "block-push-main.sh"))).toBe(
      true,
    );
    expect(stdout).toMatch(/hook scripts resolve/);
  });

  it("makes each native Claude effort profile available in an isolated install", () => {
    const cfg = sandbox();
    expect(run(["--repair"], cfg).code).toBe(0);

    for (const [name, effort] of [
      ["native-task-low", "low"],
      ["native-task-medium", "medium"],
      ["native-task-high", "high"],
    ]) {
      const profile = readFileSync(
        path.join(cfg, "agents", `${name}.md`),
        "utf8",
      );
      expect(profile).toContain(`name: ${name}`);
      expect(profile).toContain("model: inherit");
      expect(profile).toContain(`effort: ${effort}`);
      // Neutral profiles inherit the parent's available tools. A fixed allowlist
      // removes WebSearch and MCP tools needed by research tasks.
      expect(profile).not.toMatch(/^(tools|disallowedTools|permissionMode):/m);
    }
  });

  it("resolves native request documentation and advice from an unrelated installed cwd", () => {
    const cfg = sandbox();
    expect(run(["--repair"], cfg).code).toBe(0);
    const governor = path.join(cfg, "scripts", "compute-governor.js");
    const reference = path.resolve(
      path.dirname(realpathSync(governor)),
      "../docs/compute-governor.md",
    );
    const doc = readFileSync(reference, "utf8");
    const request = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
    const result = JSON.parse(
      execFileSync(process.execPath, [governor, "resolve", "-"], {
        cwd: makeTempDir("native-consumer-"),
        input: JSON.stringify(request),
        encoding: "utf8",
      }),
    );
    expect(result).toMatchObject({
      status: "ready",
      modelArguments: { model: "gpt-5.6-luna", reasoning_effort: "medium" },
      observed: null,
      usage: null,
    });
  });

  // The regression that shipped to main: invoked via the installed symlink,
  // REPO_ROOT collapsed to the config dir, so --repair unlinked the working
  // link and recreated it pointing at itself. ELOOP, all 14 hooks dead, and the
  // next --check reported OK because readlink === src.
  it("does not self-link when invoked through the installed symlink", () => {
    const cfg = sandbox();
    expect(run(["--repair"], cfg).code).toBe(0);

    const viaSymlink = path.join(cfg, "scripts", "setup-claude-sync.sh");
    const { code } = run(["--repair"], cfg, viaSymlink);

    expect(code).toBe(0);
    const link = readlinkSync(path.join(cfg, "scripts"));
    expect(link).not.toBe(path.join(cfg, "scripts")); // would be ELOOP
    expect(link).toBe(path.join(REPO_ROOT, "scripts"));
    expect(existsSync(path.join(cfg, "scripts", "block-push-main.sh"))).toBe(
      true,
    );
  });

  it("--check exits non-zero when scripts/ is not linked", () => {
    const cfg = sandbox();
    mkdirSync(cfg, { recursive: true });
    const { code, stdout } = run(["--check"], cfg);

    expect(code).toBe(1); // must NOT silently pass — this is the original bug
    expect(stdout).toMatch(/scripts/);
  });

  it("--check exits 0 once everything is linked", () => {
    const cfg = sandbox();
    run(["--repair"], cfg);
    expect(run(["--check"], cfg).code).toBe(0);
  });

  it("--repair prunes stale managed Codex skills", () => {
    const cfg = sandbox();
    expect(run(["--repair"], cfg).code).toBe(0);
    const codexSkills = path.join(path.dirname(cfg), ".agents", "skills");
    const staleTarget = path.join(REPO_ROOT, "skills", "seo");
    symlinkSync(staleTarget, path.join(codexSkills, "stale-skill"));
    appendFileSync(
      path.join(codexSkills, ".buildproven-managed"),
      `stale-skill|${staleTarget}\n`,
    );

    expect(run(["--repair"], cfg).code).toBe(0);
    expect(() => readlinkSync(path.join(codexSkills, "stale-skill"))).toThrow();
  });

  it("does not mutate global Codex state for an alternate Claude target", () => {
    const root = makeTempDir("kit-sync-alt-");
    const cfg = path.join(root, "alternate-claude");

    expect(run(["--repair"], cfg, SCRIPT, false).code).toBe(0);
    expect(existsSync(path.join(root, ".agents"))).toBe(false);
  });

  it("never clobbers a real directory the user owns", () => {
    const cfg = sandbox();
    const mine = path.join(cfg, "commands");
    mkdirSync(mine, { recursive: true });
    writeFileSync(path.join(mine, "mine.md"), "my own command");

    const { code } = run(["--repair"], cfg);

    expect(code).toBe(1); // refuses, rather than deleting
    expect(existsSync(path.join(mine, "mine.md"))).toBe(true);
  });

  it("repairs a dangling symlink", () => {
    const cfg = sandbox();
    mkdirSync(cfg, { recursive: true });
    symlinkSync("/nonexistent/gone", path.join(cfg, "scripts"));

    expect(run(["--repair"], cfg).code).toBe(0);
    expect(readlinkSync(path.join(cfg, "scripts"))).toBe(
      path.join(REPO_ROOT, "scripts"),
    );
  });

  it("--all errors rather than silently meaning --repair", () => {
    const cfg = sandbox();
    const { code, stdout } = run(["--all"], cfg);

    expect(code).toBe(2);
    expect(stdout).toMatch(/--repair/);
  });
});
