// Tests for scripts/quality-bootstrap.sh recursion / fail-open guards added in
// the Wave 1 "close the fail-open channels" pass. These exercise the guard
// paths that exit BEFORE any target resolution or GitHub call, so they are
// fast, deterministic, and need no `claude`/`gh`/network. The happy path
// (actual resolution → manifest) is covered by quality-invocation tests and
// live runs.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.resolve(__dirname, "..", "quality-bootstrap.sh");

function run(args, { env, cwd, script = SCRIPT } = {}) {
  const errFile = path.join(
    os.tmpdir(),
    `qbg-err-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const stdout = execFileSync("bash", [script, ...args], {
      env: { ...process.env, ...env },
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", fs.openSync(errFile, "w")],
    });
    const stderr = fs.existsSync(errFile)
      ? fs.readFileSync(errFile, "utf8")
      : "";
    return { code: 0, stdout, stderr };
  } catch (e) {
    const stderr = fs.existsSync(errFile)
      ? fs.readFileSync(errFile, "utf8")
      : (e.stderr?.toString() ?? "");
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr };
  } finally {
    try {
      fs.unlinkSync(errFile);
    } catch {
      /* ignore */
    }
  }
}

describe("quality-bootstrap headless review-child guard", () => {
  it("refuses when BS_QUALITY_HEADLESS=1 (a review child must not re-enter)", () => {
    const r = run([], { env: { BS_QUALITY_HEADLESS: "1" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/headless review child/i);
  });
});

describe("quality-bootstrap active-campaign re-entrancy guard (1.3b)", () => {
  it("refuses a FRESH invocation (no --manifest) when a campaign is already active", () => {
    // A fix-round or spawned agent that inherited the env tries to start a
    // second campaign. Must be refused in bash, not left to model judgment.
    const r = run([], { env: { BS_QUALITY_ACTIVE: "1" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/campaign is already active/i);
  });

  it("does NOT refuse a --manifest resume of the active campaign", () => {
    // A legitimate resume carries --manifest; the guard must let it through
    // (it will fail later for a bogus manifest path, but NOT on the re-entrancy
    // guard — so the failure text must not be the active-campaign message).
    const r = run(["--manifest", "/nonexistent/manifest.json"], {
      env: { BS_QUALITY_ACTIVE: "1" },
    });
    expect(r.stderr).not.toMatch(/campaign is already active/i);
  });
});

describe("quality-bootstrap explicit-target crash guard (BUI-401)", () => {
  let resolverRoot;

  beforeEach(() => {
    resolverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qbg-resolver-"));
    fs.mkdirSync(path.join(resolverRoot, "scripts"));
    fs.writeFileSync(
      path.join(resolverRoot, "scripts", "quality-target-resolver.js"),
      "process.stderr.write('resolver fixture crashed\\n'); process.exit(70);\\n",
    );
    // Bootstrap must resolve helpers from its own checkout before any
    // installed configuration. Run a copy beside the crashing resolver so
    // this test exercises that checkout-local failure path.
    fs.copyFileSync(
      SCRIPT,
      path.join(resolverRoot, "scripts", "quality-bootstrap.sh"),
    );
  });

  afterEach(() => {
    fs.rmSync(resolverRoot, { recursive: true, force: true });
  });

  it.each([
    ["--target-dir", "/tmp/other-repo"],
    ["--target", "/tmp/other-repo"],
    ["--worktree", "/tmp/other-repo"],
    ["--pr", "42"],
    ["--pull", "42"],
    ["--pull-request", "42"],
    ["--branch", "feature/other"],
    ["--head", "feature/other"],
    ["--head-ref", "feature/other"],
    ["#42"],
    ["codex/other-branch"],
    ["./other-repo"],
  ])("refuses cwd fallback after a resolver crash for %s", (...args) => {
    const r = run(args, {
      env: { CLAUDE_SETUP_ROOT: resolverRoot },
      script: path.join(resolverRoot, "scripts", "quality-bootstrap.sh"),
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(/target resolver crashed/i);
    expect(r.stdout).toMatch(/refusing to fall back/i);
    expect(r.stdout).not.toMatch(/continuing with cwd/i);
  });

  it("preserves spaces in the primary checkout path", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain("p=substr($0, 10)");
  });
});

describe("BUI-306: --verify-app argument wiring", () => {
  it("accepts --verify-app as a recognized bare boolean flag (not rejected by the argument grammar)", () => {
    // Runs from a directory with no git repo: the flag must pass the
    // argument-grammar allowlist (Step -1, before any git/GitHub call) and
    // fail later on git-root resolution — never on "unexpected quality
    // argument". This is the same shape as --skip-tests, which has no direct
    // test either; the happy-path discovery is covered by
    // quality-invocation.test.js's "BUI-306" cases.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qbg-verify-app-"));
    try {
      const r = run(["--verify-app"], { cwd });
      expect(r.stderr).not.toMatch(/unexpected quality argument/i);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/could not resolve a git root/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("forwards --verify-app to the create invocation only when passed", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain(
      '[ "$VERIFY_APP" = true ] && CREATE_ARGS+=(--verify-app)',
    );
    expect(source).toContain("--verify-app) VERIFY_APP=true ;;");
  });
});

describe("delivery-claim argument wiring", () => {
  it.each([
    ["--delivery-claim", "local-product"],
    ["--product-prd", "docs/prd/towns.md"],
    ["--product-tasks", "docs/prd/towns-tasks.md"],
    ["--delivery-evidence", "evidence.json"],
  ])("accepts %s before target resolution", (flag, value) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qbg-delivery-"));
    try {
      const r = run([flag, value], { cwd });
      expect(r.stderr).not.toMatch(/unexpected quality argument/i);
      expect(r.stdout + r.stderr).toMatch(/could not resolve a git root/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("forwards every product-completion input to the immutable manifest", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    for (const flag of [
      "--delivery-claim",
      "--product-prd",
      "--product-tasks",
      "--delivery-evidence",
    ]) {
      expect(source).toContain(`CREATE_ARGS+=(${flag}`);
    }
  });

  it("binds product evidence to the numeric REST repository ID", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain(
      'if [ -n "$DELIVERY_EVIDENCE_ARG" ] || [ -n "${RES_PR:-}" ]; then',
    );
    expect(source).toContain('if [ -n "$DELIVERY_EVIDENCE_ARG" ]; then');
    expect(source).toContain('gh api "repos/$GITHUB_REPOSITORY"');
    expect(source).toContain("--jq '.id | tostring'");
    expect(source).not.toContain("--json databaseId");
  });
});
