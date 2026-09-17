#!/usr/bin/env node

/**
 * Quality Target Resolver
 *
 * Parses the args passed to `/bs:quality` (especially with `--merge`) and
 * resolves which checkout / branch / PR should be audited.
 *
 * Bug being fixed:
 *   When `/bs:quality --merge` was invoked with PR context in the natural-
 *   language args (PR number, branch name, or worktree path), the skill
 *   ignored that context and audited the primary checkout's uncommitted
 *   changes — producing irrelevant reports.
 *
 * Resolution priority (highest first):
 *   1. Explicit PR number  — `#NNN`, `PR NNN`, `pr#NNN`, `pull/NNN`
 *   2. Explicit branch name — `--branch <name>` flag OR a token that looks
 *      like a remote branch ref (contains `/`, e.g. `codex/foo`, `feat/bar`).
 *   3. Worktree path — `--target-dir <path>` (existing convention) OR any
 *      absolute path arg that is an existing directory.
 *   4. cwd is a non-primary worktree — audit cwd's diff vs base.
 *   5. Fallback: primary checkout (loud warning).
 *
 * `--merge` mode REFUSES to fall through to (5). If --merge is set and no
 * target can be resolved, the resolver returns a `merge_refuse` outcome and
 * the skill must hard-error.
 *
 * Pure functions exported for unit testing — see
 *   scripts/__tests__/quality-target-resolution.test.js
 */

"use strict";

const PR_PATTERNS = [
  /(?:^|\s)#(\d+)(?:\s|$)/i, // " #410 "
  /(?:^|\s)pr\s*#?\s*(\d+)(?:\s|$)/i, // "PR 410", "pr#410", "pr 410"
  /(?:^|\s)pull[/#-](\d+)(?:\s|$)/i, // "pull/410", "pull-410"
];

// A token "looks like" a branch when it has a slash that isn't a filesystem
// path. We accept the common prefixes (codex/, feat/, fix/, chore/, docs/,
// refactor/, test/, perf/, build/, ci/, hotfix/, release/, dependabot/) and
// any prefix matching identifier-like chars before the first slash.
const BRANCH_REGEX = /^(?!\/|~|\.\/|\.\.\/)([A-Za-z][\w.-]*\/[\w./-]+)$/;

const EXPLICIT_PR_FLAG = new Set(["--pr", "--pull", "--pull-request"]);
const EXPLICIT_BRANCH_FLAG = new Set(["--branch", "--head", "--head-ref"]);
const EXPLICIT_PATH_FLAG = new Set(["--target-dir", "--target", "--worktree"]);

/**
 * Parse args (string or array) into a structured object.
 *
 * @param {string|string[]} rawArgs
 * @returns {{
 *   merge: boolean,
 *   pr: number | null,
 *   branch: string | null,
 *   path: string | null,
 *   source: 'pr-flag' | 'pr-pattern' | 'pr-bare' | 'branch-flag' | 'branch-pattern' | 'path-flag' | 'path-pattern' | 'none',
 *   tokens: string[],
 * }}
 */
// --- parser helpers (extracted to keep cyclomatic complexity per function low) ---

function extractFlagValue(tokens, i, flagSet) {
  const tok = tokens[i];
  const next = tokens[i + 1];
  if (flagSet.has(tok) && next && !next.startsWith("-")) {
    return next;
  }
  for (const f of flagSet) {
    if (tok.startsWith(`${f}=`)) {
      const val = tok.split("=")[1];
      if (val) return val;
    }
  }
  return null;
}

function setIfUnset(result, field, value, source) {
  if (result[field] === null) {
    result[field] = value;
    if (result.source === "none") result.source = source;
  }
}

function applyExplicitFlags(tokens, result) {
  for (let i = 0; i < tokens.length; i += 1) {
    const prVal = extractFlagValue(tokens, i, EXPLICIT_PR_FLAG);
    if (prVal !== null && /^\d+$/.test(prVal)) {
      result.pr = Number(prVal);
      result.source = "pr-flag";
    }

    const branchVal = extractFlagValue(tokens, i, EXPLICIT_BRANCH_FLAG);
    if (branchVal !== null)
      setIfUnset(result, "branch", branchVal, "branch-flag");

    const pathVal = extractFlagValue(tokens, i, EXPLICIT_PATH_FLAG);
    if (pathVal !== null) setIfUnset(result, "path", pathVal, "path-flag");
  }
}

function applyPrPattern(text, result) {
  if (result.pr !== null) return;
  for (const re of PR_PATTERNS) {
    const m = text.match(re);
    if (m) {
      result.pr = Number(m[1]);
      if (result.source === "none") result.source = "pr-pattern";
      return;
    }
  }
}

const PATH_PREFIXES = ["/", "~", "./", "../"];
const FILE_EXT_RE = /\.(js|ts|tsx|jsx|md|json|sh|py|yml|yaml|toml)$/i;

function looksLikePath(tok) {
  return PATH_PREFIXES.some((p) => tok.startsWith(p));
}

function applyBranchPattern(tokens, result) {
  if (result.branch !== null) return;
  for (const tok of tokens) {
    if (tok.startsWith("-")) continue;
    if (looksLikePath(tok)) continue;
    if (tok === result.path) continue;
    if (FILE_EXT_RE.test(tok)) continue;
    const m = tok.match(BRANCH_REGEX);
    if (m) {
      result.branch = m[1];
      if (result.source === "none") result.source = "branch-pattern";
      return;
    }
  }
}

function applyPathPattern(tokens, result) {
  if (result.path !== null) return;
  for (const tok of tokens) {
    if (tok.startsWith("-")) continue;
    if (tok.startsWith("/") || tok.startsWith("~")) {
      result.path = tok;
      if (result.source === "none") result.source = "path-pattern";
      return;
    }
  }
}

function detectMerge(tokens) {
  return tokens.some((t) => t === "--merge" || t.startsWith("--merge="));
}

/**
 * Parse `owner/repo` out of a GitHub remote URL, handling both HTTPS
 * (`https://github.com/owner/repo.git`) and SSH
 * (`git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git`)
 * forms, with or without a trailing `.git`. Returns null for anything else.
 *
 * @param {string|null|undefined} remoteUrl
 * @returns {string|null}
 */
// Constrained to github.com specifically. A remote URL shaped like
// `host.tld/owner/repo` but pointing at GitLab, Bitbucket, or a self-hosted
// git server must NOT be accepted as a GitHub owner/repo — feeding a
// same-shaped-but-unrelated host's path segments into `gh pr view --repo`
// would query an unrelated GitHub repo of the same name, defeating the
// fail-closed intent this resolver exists for (BUI-391).
function parseOwnerRepo(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return null;
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  // Strip an optional `user:pass@` / `token@` credential prefix before
  // matching the host, rather than folding it into the match regex itself
  // (an optional credential group ahead of a literal host trips
  // eslint-plugin-security's unsafe-regex heuristic).
  const withoutCreds = trimmed.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
  const httpsMatch = withoutCreds.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
  );
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  const sshSchemeMatch = trimmed.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
  );
  if (sshSchemeMatch) return `${sshSchemeMatch[1]}/${sshSchemeMatch[2]}`;
  return null;
}

function parseArgs(rawArgs) {
  const tokens = normalizeTokens(rawArgs);
  const text = tokens.join(" ");

  const result = {
    merge: detectMerge(tokens),
    pr: null,
    branch: null,
    path: null,
    source: "none",
    tokens,
  };

  applyExplicitFlags(tokens, result);
  applyPrPattern(text, result);
  applyBranchPattern(tokens, result);
  applyPathPattern(tokens, result);
  return result;
}

function normalizeTokens(rawArgs) {
  if (Array.isArray(rawArgs)) {
    return rawArgs.filter((t) => typeof t === "string" && t.length > 0);
  }
  if (typeof rawArgs !== "string") return [];
  // Simple whitespace split is fine — these args come from a slash command,
  // not a shell. We don't need to honor quoted strings.
  return rawArgs.trim().split(/\s+/).filter(Boolean);
}

/**
 * Resolve a target into an actionable plan. Pure-ish: takes injectable
 * helpers so it can be unit-tested without touching git / gh / fs.
 *
 * @param {ReturnType<typeof parseArgs>} parsed
 * @param {object} ctx
 * @param {string} ctx.cwd               - process.cwd()
 * @param {string|null} ctx.primaryCheckout
 * @param {(branch: string, cwd?: string|null) => string|null} ctx.findWorktreeForBranch
 * @param {(p: string) => boolean} ctx.dirExists
 * @param {(pr: number, repo?: string|null, cwd?: string|null) => { headRefName: string, headRepositoryOwnerLogin?: string, headRepositoryName?: string } | null} ctx.lookupPr
 * @param {(dir: string) => string|null} [ctx.getRepoForDir] - resolves
 *   `owner/repo` for a worktree/checkout path (e.g. via `git -C <dir> remote
 *   get-url origin`). Used to scope `--pr` lookups to the repo named by
 *   `--target-dir` and to fail closed on cross-repo PR-number collisions.
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   targetPath?: string,
 *   targetBranch?: string,
 *   targetHead?: string,
 *   targetPr?: number,
 *   resolution: 'pr' | 'branch' | 'path' | 'cwd-worktree' | 'primary-fallback' | 'merge-refuse',
 *   warnings: string[],
 * }}
 */
// --- resolver helpers (extracted to keep complexity per function low) ---

// Expands a leading `~` (home directory shorthand) in a path. If HOME is
// unset, leaves the path unchanged rather than substituting the literal
// string "~" back in — a no-op substitution would silently leave the tilde
// unresolved and cause downstream lookups (dirExists, getRepoForDir) to
// fail against a nonexistent literal `~`-prefixed path.
function expandHome(inputPath) {
  if (!process.env.HOME) return inputPath;
  return inputPath.replace(/^~(?=$|\/)/, process.env.HOME);
}

function resolveByPr(parsed, ctx) {
  const { findWorktreeForBranch, dirExists, lookupPr, getRepoForDir } = ctx;

  // When --target-dir is also supplied, derive the expected owner/repo from
  // it and scope the `gh pr view` lookup to that repo explicitly. This is
  // the fix for the PR-number-collision bug: without --repo scoping, `gh`
  // resolves against whatever repo its ambient cwd/config points at, which
  // can silently disagree with the repo the caller named via --target-dir.
  let expectedRepo = null;
  let repoUnresolved = false;
  if (parsed.path) {
    // getRepoForDir must actually be supplied whenever --target-dir is. A
    // caller (this CLI today, but the module is exported and documented to
    // accept an optional ctx.getRepoForDir) that omits it must not silently
    // fall through to unscoped ambient resolution — that's the exact
    // collision bug BUI-391 fixes, just reached via a missing ctx field
    // instead of an unresolvable repo.
    expectedRepo = getRepoForDir
      ? getRepoForDir(expandHome(parsed.path))
      : null;
    // --target-dir was supplied but its repo could not be determined (no
    // origin remote, non-GitHub remote URL, or the dir isn't a git checkout)
    // — or getRepoForDir itself wasn't provided. Fail closed either way.
    repoUnresolved = expectedRepo === null;
  }

  if (repoUnresolved) {
    return {
      ok: false,
      reason:
        `Could not determine the GitHub repository for --target-dir ` +
        `'${parsed.path}' (no origin remote, non-GitHub remote URL, or not ` +
        `a git checkout). Refusing to resolve --pr ${parsed.pr} unscoped — ` +
        `that is the wrong-repo collision this check exists to prevent.`,
      resolution: "pr",
      warnings: [],
      targetPr: parsed.pr,
    };
  }

  // Resolve gh's own working directory explicitly: --target-dir when given,
  // otherwise the resolver's own cwd. Without this, gh inherits whatever
  // directory the resolver process itself launched from, which can differ
  // from the target checkout and break PR lookup even with --repo set
  // (BUI-390).
  const lookupCwd = parsed.path ? expandHome(parsed.path) : ctx.cwd;
  const pr = lookupPr ? lookupPr(parsed.pr, expectedRepo, lookupCwd) : null;
  if (!pr || !pr.headRefName) {
    return {
      ok: false,
      reason: expectedRepo
        ? `Could not resolve PR #${parsed.pr} in ${expectedRepo} (gh pr view --repo ${expectedRepo} failed or returned no headRefName).`
        : `Could not resolve PR #${parsed.pr} (gh pr view failed or returned no headRefName).`,
      resolution: "pr",
      warnings: [],
      targetPr: parsed.pr,
    };
  }

  // Fail-closed cross-check: if the caller supplied both --pr and
  // --target-dir, the resolved PR's repository MUST match the target-dir's
  // repository. This catches any path where --repo scoping above didn't
  // fully prevent a wrong-repo resolution (e.g. a lookupPr implementation
  // that ignores the repo hint, or a future code path that bypasses it).
  // Silent wrong-repo resolution is the dangerous failure mode — hard-error
  // instead of proceeding. A null pr.repo (lookupPr could not independently
  // confirm which repo `gh` actually resolved against) is treated the same
  // as a mismatch: "unknown" must never be accepted as "confirmed same repo".
  if (expectedRepo && pr.repo !== expectedRepo) {
    return {
      ok: false,
      reason: pr.repo
        ? `PR #${parsed.pr} resolved to repository '${pr.repo}', which does ` +
          `not match --target-dir's repository '${expectedRepo}'. Refusing ` +
          `to audit the wrong repo — pass a --pr that belongs to ` +
          `'${expectedRepo}', or point --target-dir at '${pr.repo}'.`
        : `PR #${parsed.pr} lookup did not return a verifiable repository ` +
          `(gh returned an unrecognized URL format). Refusing to trust an ` +
          `unscoped resolution against --target-dir's repository ` +
          `'${expectedRepo}'.`,
      resolution: "pr",
      warnings: [],
      targetPr: parsed.pr,
    };
  }

  const wtPath = findWorktreeForBranch
    ? findWorktreeForBranch(pr.headRefName, lookupCwd)
    : null;
  if (wtPath && dirExists(wtPath)) {
    // findWorktreeForBranch runs `git worktree list` in the CALLER's
    // ambient cwd (it has no repo to scope to until we find a match), then
    // matches purely by branch NAME with no repo-identity check at all. If
    // the caller's shell cwd happens to sit inside a DIFFERENT repo that
    // also has a worktree checked out on a same-named branch (a realistic
    // collision: this project's own convention names feature worktrees
    // after the branch, e.g. "fix/some-name", and that pattern repeats
    // across every repo using it), this returns that unrelated worktree
    // with zero warning -- silently auditing and potentially merging the
    // wrong repository entirely. Verify the found worktree's own origin
    // remote actually matches the PR's confirmed repo before trusting it.
    const wtRepo = getRepoForDir ? getRepoForDir(wtPath) : null;
    if (!expectedRepo && !pr.repo) {
      // Neither the --target-dir cross-check nor the PR URL could confirm
      // an expected repo — nothing to verify against, fall through to the
      // pre-existing behavior rather than block on an unrelated gap.
    } else if (wtRepo !== (expectedRepo || pr.repo)) {
      return {
        ok: false,
        reason:
          `Found a local worktree for branch '${pr.headRefName}' at ` +
          `'${wtPath}', but it belongs to repository ` +
          `'${wtRepo || "unknown"}', not '${expectedRepo || pr.repo}' ` +
          `(PR #${parsed.pr}'s actual repo). Refusing to audit a worktree ` +
          `from a different repository just because its branch name ` +
          `happens to match — point --target-dir at the correct checkout.`,
        resolution: "pr",
        warnings: [],
        targetPr: parsed.pr,
      };
    }
    return {
      ok: true,
      targetPath: wtPath,
      targetBranch: pr.headRefName,
      targetHead: pr.headRefOid || undefined,
      targetPr: parsed.pr,
      resolution: "pr",
      warnings: [],
    };
  }
  return {
    ok: true,
    targetBranch: pr.headRefName,
    targetHead: pr.headRefOid || undefined,
    targetPr: parsed.pr,
    resolution: "pr",
    warnings: [
      `No local worktree found for branch '${pr.headRefName}'. Skill must materialize one before auditing.`,
    ],
  };
}

function resolveByBranch(parsed, ctx) {
  const { findWorktreeForBranch, dirExists } = ctx;
  const wtPath = findWorktreeForBranch
    ? findWorktreeForBranch(parsed.branch, ctx.cwd)
    : null;
  if (wtPath && dirExists(wtPath)) {
    return {
      ok: true,
      targetPath: wtPath,
      targetBranch: parsed.branch,
      resolution: "branch",
      warnings: [],
    };
  }
  return {
    ok: true,
    targetBranch: parsed.branch,
    resolution: "branch",
    warnings: [
      `No local worktree found for branch '${parsed.branch}'. Skill must materialize one before auditing.`,
    ],
  };
}

function resolveByPath(parsed, ctx) {
  const expanded = expandHome(parsed.path);
  if (ctx.dirExists(expanded)) {
    return { ok: true, targetPath: expanded, resolution: "path", warnings: [] };
  }
  return {
    ok: false,
    reason: `Path arg does not exist: ${expanded}`,
    resolution: "path",
    warnings: [],
  };
}

function resolveTarget(parsed, ctx) {
  if (parsed.pr !== null) return resolveByPr(parsed, ctx);
  if (parsed.branch) return resolveByBranch(parsed, ctx);
  if (parsed.path) return resolveByPath(parsed, ctx);

  // 4. cwd is a non-primary worktree → audit it.
  if (ctx.primaryCheckout && ctx.cwd && ctx.cwd !== ctx.primaryCheckout) {
    return {
      ok: true,
      targetPath: ctx.cwd,
      resolution: "cwd-worktree",
      warnings: [],
    };
  }

  // 5. Primary checkout fallback. NEVER allowed under --merge.
  if (parsed.merge) {
    return {
      ok: false,
      reason:
        "--merge requires an explicit PR#, branch name, or worktree path. " +
        "Refusing to silently audit the primary checkout in merge mode.",
      resolution: "merge-refuse",
      warnings: [],
    };
  }

  return {
    ok: true,
    targetPath: ctx.primaryCheckout || ctx.cwd,
    resolution: "primary-fallback",
    warnings: [
      "No target specified — auditing primary checkout. " +
        "Pass --target-dir, a branch name, or #<PR> to be explicit.",
    ],
  };
}

module.exports = {
  parseArgs,
  resolveTarget,
  parseOwnerRepo,
  expandHome,
  // exposed for completeness / tests
  PR_PATTERNS,
  BRANCH_REGEX,
};

/* istanbul ignore next */
if (require.main === module) {
  // CLI mode for the SKILL.md shell preamble. Invocation:
  //   QUALITY_CWD=<cwd> QUALITY_PRIMARY_CHECKOUT=<primary> \
  //     node quality-target-resolver.js --cli [original args...]
  //
  // Emits a JSON object matching resolveTarget()'s return shape.
  const argvIdx = process.argv.indexOf("--cli");
  const passthrough =
    argvIdx >= 0 ? process.argv.slice(argvIdx + 1) : process.argv.slice(2);

  // Use execFileSync (not exec) — no shell, no injection.
  const { execFileSync } = require("child_process");
  const fs = require("fs");

  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };

  const dirExists = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  const findWorktreeForBranch = (branch, cwd) => {
    // Explicit -C: without it, `git worktree list` runs against whatever
    // repo this process's own cwd happens to be in, which can silently
    // return a same-named branch's worktree from an unrelated repo when
    // invoked from outside the target checkout (BUI-390).
    const out = cwd
      ? runGit(["-C", cwd, "worktree", "list", "--porcelain"])
      : runGit(["worktree", "list", "--porcelain"]);
    if (!out) return null;
    const lines = out.split("\n");
    let currentPath = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
      } else if (line === `branch refs/heads/${branch}`) {
        return currentPath;
      } else if (line === "") {
        currentPath = null;
      }
    }
    return null;
  };

  // Resolve `owner/repo` for a worktree/checkout path via
  // `git -C <dir> remote get-url origin`. Returns null if the dir isn't a
  // git checkout, has no origin remote, or the remote URL isn't recognized
  // as a GitHub URL.
  const getRepoForDir = (dir) => {
    if (!dir) return null;
    const out = runGit(["-C", dir, "remote", "get-url", "origin"]);
    if (!out) return null;
    return parseOwnerRepo(out);
  };

  const lookupPr = (n, repo, cwd) => {
    if (!Number.isInteger(n) || n <= 0) return null;
    try {
      const args = ["pr", "view", String(n)];
      if (repo) args.push("--repo", repo);
      args.push("--json", "headRefName,headRefOid,baseRefName,url");
      // Explicit cwd: without it, execFileSync inherits this Node process's
      // own launch directory rather than the target checkout. When invoked
      // from outside the target repo, gh can't determine which repo to
      // query even with a correct --repo, because gh itself may need a git
      // checkout context for auth/config resolution (BUI-390).
      const out = execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        cwd: cwd || process.cwd(),
      });
      const parsed = JSON.parse(out);
      if (!parsed || !parsed.headRefName) return null;
      // Derive owner/repo from the PR's own URL so resolveByPr's cross-check
      // is comparing against what `gh` actually resolved, not just echoing
      // back the --repo we passed in. If the URL doesn't match the expected
      // GitHub.com form (e.g. GitHub Enterprise, or a future `gh` response
      // shape), report the repo as unknown (null) rather than falling back
      // to the --repo hint — echoing it back would make resolveByPr's
      // cross-check a tautology (pr.repo === expectedRepo is always true)
      // and silently defeat the exact collision check this exists for.
      const urlMatch =
        typeof parsed.url === "string" &&
        parsed.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//i);
      parsed.repo = urlMatch ? `${urlMatch[1]}/${urlMatch[2]}` : null;
      return parsed;
    } catch {
      return null;
    }
  };

  const parsed = parseArgs(passthrough);
  const result = resolveTarget(parsed, {
    cwd: process.env.QUALITY_CWD || process.cwd(),
    primaryCheckout: process.env.QUALITY_PRIMARY_CHECKOUT || null,
    findWorktreeForBranch,
    dirExists,
    lookupPr,
    getRepoForDir,
  });

  process.stdout.write(JSON.stringify(result) + "\n");
  // Always exit 0 — caller inspects .ok in the JSON payload.
  process.exit(0);
}
