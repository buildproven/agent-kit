const { parseArgs, resolveTarget } = require("../quality-target-resolver");

describe("parseArgs", () => {
  it("returns empty/none for no args", () => {
    const r = parseArgs("");
    expect(r.merge).toBe(false);
    expect(r.pr).toBeNull();
    expect(r.branch).toBeNull();
    expect(r.path).toBeNull();
    expect(r.source).toBe("none");
  });

  it("detects --merge flag (bare)", () => {
    const r = parseArgs("--merge");
    expect(r.merge).toBe(true);
  });

  it("detects --merge=true form", () => {
    const r = parseArgs("--merge=true");
    expect(r.merge).toBe(true);
  });

  describe("PR number extraction", () => {
    it('extracts "#410" pattern', () => {
      const r = parseArgs("--merge review #410 please");
      expect(r.pr).toBe(410);
      expect(r.source).toBe("pr-pattern");
    });

    it('extracts "PR 410" pattern', () => {
      const r = parseArgs("--merge PR 410");
      expect(r.pr).toBe(410);
      expect(r.source).toBe("pr-pattern");
    });

    it('extracts "pr#410" pattern', () => {
      const r = parseArgs("--merge pr#410");
      expect(r.pr).toBe(410);
    });

    it("extracts pull/410 pattern", () => {
      const r = parseArgs(
        "--merge https://github.com/example-org/example-repo pull/410",
      );
      expect(r.pr).toBe(410);
    });

    it("honors explicit --pr flag", () => {
      const r = parseArgs("--merge --pr 410");
      expect(r.pr).toBe(410);
      expect(r.source).toBe("pr-flag");
    });

    it("honors --pr=NNN form", () => {
      const r = parseArgs("--merge --pr=410");
      expect(r.pr).toBe(410);
      expect(r.source).toBe("pr-flag");
    });

    it("rejects ambiguous bare integers under --merge", () => {
      const r = parseArgs("--merge 558");
      expect(r.pr).toBeNull();
    });

    it("does NOT treat a bare integer as a PR without --merge", () => {
      const r = parseArgs("558");
      expect(r.pr).toBeNull();
      expect(r.source).toBe("none");
    });

    it("bare int does not shadow an explicit branch under --merge", () => {
      const r = parseArgs("--merge codex/foo 558");
      expect(r.branch).toBe("codex/foo");
      // a PR number is still captured, but the branch remains authoritative
      expect(r.source).toBe("branch-pattern");
    });

    it("does NOT read a flag's numeric operand as a PR (--level)", () => {
      const r = parseArgs("--merge --level 98");
      expect(r.pr).toBeNull();
    });

    it("does NOT read a flag's numeric operand as a PR (--tail)", () => {
      const r = parseArgs("--merge --tail 40");
      expect(r.pr).toBeNull();
    });

    it("requires --pr even when a flag-with-operand precedes a number", () => {
      const r = parseArgs("--merge --level 98 558");
      expect(r.pr).toBeNull();
    });
  });

  describe("branch extraction", () => {
    it("extracts codex/foo branch name", () => {
      const r = parseArgs("--merge codex/phase-1-make-types-2026-05-11");
      expect(r.branch).toBe("codex/phase-1-make-types-2026-05-11");
      expect(r.source).toBe("branch-pattern");
    });

    it("extracts feat/foo branch name", () => {
      const r = parseArgs("--merge feat/quality-target");
      expect(r.branch).toBe("feat/quality-target");
    });

    it("honors explicit --branch flag", () => {
      const r = parseArgs("--merge --branch codex/foo");
      expect(r.branch).toBe("codex/foo");
      expect(r.source).toBe("branch-flag");
    });

    it("skips file-extension tokens (not branches)", () => {
      const r = parseArgs("scripts/foo.js");
      expect(r.branch).toBeNull();
    });

    it("skips absolute paths (not branches)", () => {
      const r = parseArgs("/Users/foo/bar/baz");
      expect(r.branch).toBeNull();
    });

    it("skips flags", () => {
      const r = parseArgs("--some-flag --merge");
      expect(r.branch).toBeNull();
    });
  });

  describe("path extraction", () => {
    it("extracts --target-dir <path>", () => {
      const r = parseArgs("--merge --target-dir /Users/foo/wt");
      expect(r.path).toBe("/Users/foo/wt");
      expect(r.source).toBe("path-flag");
    });

    it("extracts --target-dir=<path>", () => {
      const r = parseArgs("--merge --target-dir=/Users/foo/wt");
      expect(r.path).toBe("/Users/foo/wt");
    });

    it("extracts bare absolute path", () => {
      const r = parseArgs("--merge /Users/foo/wt");
      expect(r.path).toBe("/Users/foo/wt");
      expect(r.source).toBe("path-pattern");
    });

    it("extracts bare ~/ path", () => {
      const r = parseArgs("--merge ~/Projects/something");
      expect(r.path).toBe("~/Projects/something");
    });
  });

  describe("priority", () => {
    it("PR flag wins over branch pattern", () => {
      const r = parseArgs("--merge --pr 410 codex/foo");
      expect(r.source).toBe("pr-flag");
      expect(r.pr).toBe(410);
    });

    it("PR pattern is found alongside branch (both captured)", () => {
      const r = parseArgs("--merge #410 codex/phase-1");
      expect(r.pr).toBe(410);
      expect(r.branch).toBe("codex/phase-1");
      // source records what triggered first — PR-pattern is higher priority.
      expect(r.source).toBe("pr-pattern");
    });
  });

  it("accepts array input", () => {
    const r = parseArgs(["--merge", "#410"]);
    expect(r.merge).toBe(true);
    expect(r.pr).toBe(410);
  });
});

describe("resolveTarget", () => {
  const baseCtx = {
    cwd: "/primary",
    primaryCheckout: "/primary",
    findWorktreeForBranch: () => null,
    dirExists: () => false,
    lookupPr: () => null,
  };

  it("resolves PR # to worktree path when worktree exists", () => {
    const parsed = parseArgs("--merge #410");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      lookupPr: (n) =>
        n === 410
          ? { headRefName: "codex/foo", headRefOid: "exact-head" }
          : null,
      findWorktreeForBranch: (b) =>
        b === "codex/foo" ? "/wt/codex-foo" : null,
      dirExists: (p) => p === "/wt/codex-foo",
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("pr");
    expect(out.targetPath).toBe("/wt/codex-foo");
    expect(out.targetBranch).toBe("codex/foo");
    expect(out.targetPr).toBe(410);
    expect(out.targetHead).toBe("exact-head");
  });

  it("returns ok=true with warning when PR has no local worktree", () => {
    const parsed = parseArgs("--merge #410");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      lookupPr: () => ({ headRefName: "codex/foo" }),
      findWorktreeForBranch: () => null,
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("pr");
    expect(out.targetPath).toBeUndefined();
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("fails when PR lookup returns null", () => {
    const parsed = parseArgs("--merge #999");
    const out = resolveTarget(parsed, { ...baseCtx, lookupPr: () => null });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/PR #999/);
  });

  it("passes --target-dir (not ctx.cwd) as lookupPr's cwd when --target-dir is given (BUI-390)", () => {
    const parsed = parseArgs("--merge --pr 410 --target-dir /checkout");
    let seenCwd = null;
    resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/somewhere/else",
      getRepoForDir: (dir) => (dir === "/checkout" ? "owner/repo" : null),
      lookupPr: (n, repo, cwd) => {
        seenCwd = cwd;
        return n === 410 && repo === "owner/repo"
          ? { headRefName: "codex/foo", repo: "owner/repo" }
          : null;
      },
    });
    // lookupPr's gh call must run scoped to the target checkout, not
    // whatever directory the resolver process itself happened to launch
    // from — otherwise gh can fail to resolve the repo even with --repo set.
    expect(seenCwd).toBe("/checkout");
  });

  it("passes ctx.cwd as lookupPr's cwd when no --target-dir is given (BUI-390)", () => {
    const parsed = parseArgs("--merge --pr 410");
    let seenCwd = null;
    resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/current/shell/cwd",
      lookupPr: (n, repo, cwd) => {
        seenCwd = cwd;
        return n === 410 ? { headRefName: "codex/foo" } : null;
      },
    });
    expect(seenCwd).toBe("/current/shell/cwd");
  });

  it("scopes findWorktreeForBranch's 'git worktree list' to --target-dir, not ambient cwd (BUI-390)", () => {
    // Without -C scoping, `git worktree list` runs against whatever repo
    // this process's own cwd happens to be in — it could silently match a
    // same-named branch's worktree from an unrelated repo, or miss the real
    // one, when invoked from outside the target checkout.
    const parsed = parseArgs("--merge --pr 410 --target-dir /checkout");
    let seenWtCwd = null;
    resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/somewhere/else",
      getRepoForDir: (dir) => (dir === "/checkout" ? "owner/repo" : null),
      lookupPr: (n) =>
        n === 410 ? { headRefName: "codex/foo", repo: "owner/repo" } : null,
      findWorktreeForBranch: (branch, cwd) => {
        seenWtCwd = cwd;
        return null;
      },
    });
    expect(seenWtCwd).toBe("/checkout");
  });

  it("resolves branch to worktree path", () => {
    const parsed = parseArgs("--merge codex/phase-1");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      findWorktreeForBranch: (b) =>
        b === "codex/phase-1" ? "/wt/phase-1" : null,
      dirExists: (p) => p === "/wt/phase-1",
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("branch");
    expect(out.targetPath).toBe("/wt/phase-1");
  });

  it("resolves explicit path when dir exists", () => {
    const parsed = parseArgs("--merge --target-dir /wt/explicit");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      dirExists: (p) => p === "/wt/explicit",
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("path");
    expect(out.targetPath).toBe("/wt/explicit");
  });

  it("rejects explicit path when dir missing", () => {
    const parsed = parseArgs("--merge --target-dir /nope");
    const out = resolveTarget(parsed, { ...baseCtx, dirExists: () => false });
    expect(out.ok).toBe(false);
  });

  it("uses cwd when cwd is a non-primary worktree (no --merge)", () => {
    const parsed = parseArgs("");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/wt/feature",
      primaryCheckout: "/primary",
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("cwd-worktree");
    expect(out.targetPath).toBe("/wt/feature");
  });

  it("uses cwd when cwd is a non-primary worktree even WITH --merge", () => {
    // case 4 in priority order — if you ran /bs:quality --merge from inside
    // a feature worktree, that's a valid target.
    const parsed = parseArgs("--merge");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/wt/feature",
      primaryCheckout: "/primary",
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("cwd-worktree");
  });

  it("falls back to primary checkout with warning when nothing specified", () => {
    const parsed = parseArgs("");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/primary",
      primaryCheckout: "/primary",
    });
    expect(out.ok).toBe(true);
    expect(out.resolution).toBe("primary-fallback");
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("REFUSES primary fallback under --merge", () => {
    const parsed = parseArgs("--merge");
    const out = resolveTarget(parsed, {
      ...baseCtx,
      cwd: "/primary",
      primaryCheckout: "/primary",
    });
    expect(out.ok).toBe(false);
    expect(out.resolution).toBe("merge-refuse");
    expect(out.reason).toMatch(/--merge/);
  });
});
