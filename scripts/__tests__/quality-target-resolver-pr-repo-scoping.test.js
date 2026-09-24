import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  parseArgs,
  resolveTarget,
  parseOwnerRepo,
  expandHome,
} = require("../quality-target-resolver.js");

// BUI-391: resolving `--pr <n>` without `--repo` scoping can silently pick
// the wrong repo when a PR number collides across repos (e.g. PR #141 exists
// in both buildproven/agent-kit and buildproven/agent-setup). These tests
// simulate two different --target-dir checkouts, each with its own origin
// remote, both being asked to resolve "the same" PR number, and assert each
// resolves against ITS OWN repo — never cross-contaminating.

describe("expandHome", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("expands a leading ~ to HOME", () => {
    process.env.HOME = "/Users/example";
    expect(expandHome("~/repos/agent-kit")).toBe(
      "/Users/example/repos/agent-kit",
    );
    expect(expandHome("~")).toBe("/Users/example");
  });

  it("leaves a bare tilde path unchanged when HOME is unset", () => {
    // Regression: substituting the literal string "~" back in for a missing
    // HOME is a silent no-op that looks like it worked but leaves the path
    // unresolved, causing downstream lookups to fail against a nonexistent
    // literal `~`-prefixed directory.
    delete process.env.HOME;
    expect(expandHome("~/repos/agent-kit")).toBe("~/repos/agent-kit");
  });

  it("does not touch a path without a leading ~", () => {
    process.env.HOME = "/Users/example";
    expect(expandHome("/repos/agent-kit")).toBe("/repos/agent-kit");
  });

  it("does not expand a ~ that isn't at the start of the path", () => {
    process.env.HOME = "/Users/example";
    expect(expandHome("/repos/~agent-kit")).toBe("/repos/~agent-kit");
  });
});

describe("parseOwnerRepo", () => {
  it("parses an https remote URL", () => {
    expect(parseOwnerRepo("https://github.com/buildproven/agent-kit.git")).toBe(
      "buildproven/agent-kit",
    );
  });

  it("parses an https remote URL without a trailing .git", () => {
    expect(parseOwnerRepo("https://github.com/buildproven/agent-setup")).toBe(
      "buildproven/agent-setup",
    );
  });

  it("parses an ssh scp-like remote URL", () => {
    expect(parseOwnerRepo("git@github.com:buildproven/agent-kit.git")).toBe(
      "buildproven/agent-kit",
    );
  });

  it("parses an ssh:// scheme remote URL", () => {
    expect(
      parseOwnerRepo("ssh://git@github.com/buildproven/agent-setup.git"),
    ).toBe("buildproven/agent-setup");
  });

  it("returns null for a malformed or non-URL value", () => {
    expect(parseOwnerRepo("not a url")).toBeNull();
    expect(parseOwnerRepo("")).toBeNull();
    expect(parseOwnerRepo(null)).toBeNull();
    expect(parseOwnerRepo(undefined)).toBeNull();
  });

  it("parses a credential-embedded https github.com URL", () => {
    expect(
      parseOwnerRepo(
        "https://x-access-token:tok@github.com/buildproven/agent-kit.git",
      ),
    ).toBe("buildproven/agent-kit");
  });

  // Regression: the shape `host.tld/owner/repo` matches GitLab, Bitbucket,
  // and self-hosted git servers just as readily as github.com. Accepting any
  // host here would let getRepoForDir resolve a non-GitHub checkout to an
  // `owner/repo` string that then gets fed into `gh pr view --repo`, which
  // always queries GitHub — silently auditing an unrelated same-named repo
  // instead of failing closed as BUI-391 requires.
  it("returns null for a same-shaped URL on a non-github.com host (https)", () => {
    expect(
      parseOwnerRepo("https://gitlab.com/buildproven/agent-kit.git"),
    ).toBeNull();
    expect(
      parseOwnerRepo("https://github.com.attacker.io/buildproven/agent-kit"),
    ).toBeNull();
  });

  it("returns null for a same-shaped URL on a non-github.com host (ssh)", () => {
    expect(
      parseOwnerRepo("git@gitlab.com:buildproven/agent-kit.git"),
    ).toBeNull();
    expect(
      parseOwnerRepo("ssh://git@bitbucket.org/buildproven/agent-kit.git"),
    ).toBeNull();
  });
});

// Simulates two mock repo checkouts with different origin remotes, and a
// `gh pr view` stand-in that returns a DIFFERENT PR for the "same" number
// depending on which --repo it was scoped to — mirroring real collision
// behavior where PR #141 means something different in each repo.
function makeMockRepos() {
  const repos = {
    "/repos/agent-kit": "https://github.com/buildproven/agent-kit.git",
    "/repos/agent-setup": "git@github.com:buildproven/agent-setup.git",
  };

  const prsByRepo = {
    "buildproven/agent-kit": {
      141: {
        headRefName: "fix/kit-thing",
        url: "https://github.com/buildproven/agent-kit/pull/141",
        repo: "buildproven/agent-kit",
      },
    },
    "buildproven/agent-setup": {
      141: {
        headRefName: "fix/setup-thing",
        url: "https://github.com/buildproven/agent-setup/pull/141",
        repo: "buildproven/agent-setup",
      },
    },
  };

  const getRepoForDir = (dir) => {
    const remote = repos[dir];
    return remote ? parseOwnerRepo(remote) : null;
  };

  // Mimics the real CLI lookupPr: when a repo is supplied, scope to it
  // (as `gh pr view --repo <repo>` would); when not supplied, fall back to
  // "ambient" resolution — here modeled as always landing on agent-kit's
  // PR, simulating a `gh` whose ambient cwd/config points at agent-kit
  // regardless of which --target-dir the caller meant.
  const lookupPr = (n, repo) => {
    if (repo) {
      const found = prsByRepo[repo] && prsByRepo[repo][n];
      return found || null;
    }
    return prsByRepo["buildproven/agent-kit"][n] || null;
  };

  return { getRepoForDir, lookupPr, dirExists: () => false };
}

describe("resolveTarget / resolveByPr — cross-repo PR-number collision (BUI-391)", () => {
  it("resolves PR #141 against agent-kit when --target-dir points at agent-kit", () => {
    const { getRepoForDir, lookupPr, dirExists } = makeMockRepos();
    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-kit",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr,
      getRepoForDir,
    });

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe("fix/kit-thing");
  });

  it("resolves PR #141 against agent-setup when --target-dir points at agent-setup, not agent-kit", () => {
    const { getRepoForDir, lookupPr, dirExists } = makeMockRepos();
    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-setup",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr,
      getRepoForDir,
    });

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe("fix/setup-thing");
    expect(result.targetBranch).not.toBe("fix/kit-thing");
  });

  it("fails closed when the resolved PR's repo does not match --target-dir's repo", () => {
    // Simulate a lookupPr that ignores the repo hint entirely (e.g. --repo
    // scoping somehow didn't take effect) and always resolves to agent-kit,
    // even when --target-dir named agent-setup. The cross-check must catch
    // this and hard-error rather than silently returning agent-kit's PR.
    const { getRepoForDir, dirExists } = makeMockRepos();
    const brokenLookupPr = () => ({
      headRefName: "fix/kit-thing",
      url: "https://github.com/buildproven/agent-kit/pull/141",
      repo: "buildproven/agent-kit",
    });

    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-setup",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr: brokenLookupPr,
      getRepoForDir,
    });

    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("pr");
    expect(result.reason).toMatch(/does not match/i);
    expect(result.reason).toContain("buildproven/agent-kit");
    expect(result.reason).toContain("buildproven/agent-setup");
  });

  it("fails closed when findWorktreeForBranch returns a worktree from a different repo (branch-name collision)", () => {
    // Real bug found live: findWorktreeForBranch runs `git worktree list` in
    // the CALLER's ambient cwd (it has no repo to scope to until a match is
    // found) and matches purely by branch NAME, with no repo-identity check
    // at all. If two different repos both happen to have a worktree checked
    // out on a same-named branch -- entirely plausible, since this
    // project's convention names worktrees after their branch -- the wrong
    // repo's worktree is silently returned with no warning at all, even
    // though --target-dir and the PR lookup both correctly identified the
    // intended repo moments earlier.
    const { getRepoForDir, lookupPr } = makeMockRepos();
    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-kit",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      // Simulates the caller's shell being cwd'd inside agent-setup (or
      // any repo) at the moment this ran, so `git worktree list` (no -C
      // flag) enumerated THAT repo's worktrees and found one on a
      // same-named branch by coincidence.
      findWorktreeForBranch: (branch) =>
        branch === "fix/kit-thing"
          ? "/worktrees/agent-setup/fix-kit-thing"
          : null,
      dirExists: () => true,
      lookupPr,
      getRepoForDir: (dir) => {
        if (dir === "/worktrees/agent-setup/fix-kit-thing") {
          return "buildproven/agent-setup";
        }
        return getRepoForDir(dir);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("pr");
    expect(result.reason).toMatch(/different repository/i);
    expect(result.reason).toContain("buildproven/agent-kit");
    expect(result.reason).toContain("buildproven/agent-setup");
    expect(result.targetPath).not.toBe("/worktrees/agent-setup/fix-kit-thing");
  });

  it("still resolves normally when the found worktree's repo matches the PR's repo", () => {
    const { getRepoForDir, lookupPr } = makeMockRepos();
    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-kit",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: (branch) =>
        branch === "fix/kit-thing" ? "/repos/agent-kit" : null,
      dirExists: () => true,
      lookupPr,
      getRepoForDir,
    });

    expect(result.ok).toBe(true);
    expect(result.targetPath).toBe("/repos/agent-kit");
    expect(result.targetBranch).toBe("fix/kit-thing");
  });

  it("scopes the lookupPr call itself with the derived repo (--repo semantics)", () => {
    const { getRepoForDir, dirExists } = makeMockRepos();
    const seenRepos = [];
    const scopedLookupPr = (n, repo) => {
      seenRepos.push(repo);
      if (repo === "buildproven/agent-setup") {
        return {
          headRefName: "fix/setup-thing",
          url: "https://github.com/buildproven/agent-setup/pull/141",
          repo: "buildproven/agent-setup",
        };
      }
      return null;
    };

    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-setup",
    ]);
    resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr: scopedLookupPr,
      getRepoForDir,
    });

    expect(seenRepos).toEqual(["buildproven/agent-setup"]);
  });

  it("falls back to ambient (unscoped) lookupPr when --target-dir is not supplied", () => {
    // No --target-dir means there's nothing to cross-check against — current
    // ambient-cwd behavior remains unavoidable and should be unchanged.
    const { lookupPr, dirExists } = makeMockRepos();
    const parsed = parseArgs(["--pr", "141"]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr,
      getRepoForDir: () => null,
    });

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe("fix/kit-thing");
  });

  it("does not call getRepoForDir when --pr is supplied without --target-dir", () => {
    const { lookupPr, dirExists } = makeMockRepos();
    let called = false;
    const parsed = parseArgs(["--pr", "141"]);
    resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr,
      getRepoForDir: () => {
        called = true;
        return null;
      },
    });

    expect(called).toBe(false);
  });

  it("fails closed when --target-dir is supplied but its repo cannot be determined", () => {
    // getRepoForDir returns null for /repos/no-origin (e.g. a checkout with
    // no origin remote, or a non-GitHub remote URL). The old behavior was to
    // silently fall through to unscoped ambient resolution here — exactly
    // the collision bug BUI-391 exists to prevent. It must now refuse.
    const { lookupPr, dirExists } = makeMockRepos();
    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/no-origin",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr,
      getRepoForDir: () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("pr");
    expect(result.reason).toMatch(/could not determine.*repository/i);
    expect(result.reason).toContain("/repos/no-origin");
  });

  it("fails closed when --target-dir is supplied but ctx.getRepoForDir is omitted entirely", () => {
    // Regression: `if (parsed.path && getRepoForDir)` used to gate the whole
    // cross-check on getRepoForDir being truthy. A caller (this resolver
    // module is exported and documented to accept an optional
    // ctx.getRepoForDir) that supplies --pr + --target-dir but doesn't wire
    // up getRepoForDir at all — as opposed to wiring it up and having it
    // return null — silently skipped the check and fell through to unscoped
    // resolution, reopening the exact BUI-391 collision. Omitting the
    // function must fail closed identically to it returning null.
    const { lookupPr, dirExists } = makeMockRepos();
    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-setup",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr,
      // getRepoForDir intentionally omitted from ctx.
    });

    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("pr");
    expect(result.reason).toMatch(/could not determine.*repository/i);
  });

  it("fails closed when lookupPr cannot independently confirm the resolved repo", () => {
    // Simulates gh returning a PR URL in an unrecognized format (e.g. GitHub
    // Enterprise), so lookupPr reports repo: null instead of echoing back
    // the --repo hint it was scoped with. The cross-check must treat "unknown"
    // as untrustworthy, not as "confirmed same repo".
    const { getRepoForDir, dirExists } = makeMockRepos();
    const unverifiableLookupPr = () => ({
      headRefName: "fix/enterprise-thing",
      url: "https://github.mycompany.com/buildproven/agent-setup/pull/141",
      repo: null,
    });

    const parsed = parseArgs([
      "--pr",
      "141",
      "--target-dir",
      "/repos/agent-setup",
    ]);
    const result = resolveTarget(parsed, {
      cwd: "/somewhere",
      primaryCheckout: null,
      findWorktreeForBranch: () => null,
      dirExists,
      lookupPr: unverifiableLookupPr,
      getRepoForDir,
    });

    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("pr");
    expect(result.reason).toMatch(/not return a verifiable repository/i);
  });
});
