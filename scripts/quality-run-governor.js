#!/usr/bin/env node

/**
 * Quality Run Governor
 *
 * /bs:quality has two nested autonomous loops: the BLOCKING-findings
 * auto-fix loop (Step 2.5, up to 3 attempts) and the Codex re-verification
 * loop (Step 2.6, CODEX_ROUNDS). CODEX_ROUNDS only bounds the inner Codex
 * loop — nothing bounded the OUTER cycle of fix -> re-review across a whole
 * invocation. Two PRs in one night ran 128min/6 commits and 167min/13
 * commits with no circuit breaker (2026-07-03 incident).
 *
 * This module is the run-wide governor every fix/round loop in SKILL.md
 * checks before doing another round of work. It tracks, against a
 * per-invocation JSON sentinel written by Step -1:
 *
 *   - review-round count (panels run since the run started)
 *   - fix-commit count (commits made since the run started)
 *   - active provider execution for manifests (legacy sentinels retain their
 *     original wall-clock contract)
 *   - repeated-finding-shape detection (same root-cause shape recurring
 *     across rounds, independent of which file it shows up in — see
 *     findingShapeKey), so a run doing N narrow variants of the same fix at
 *     different call sites can be told to batch-fix instead of treating
 *     each as a fresh round
 *
 * WHY THE ROUND COUNTER EXISTS (2026-07-10):
 * The original governor bounded commits and wall-clock but had NO round
 * dimension, and — more importantly — was never called on the review leg. Its
 * three call sites were all downstream of the panel (before a Codex round,
 * mid-Codex-poll, before a fix attempt). The "up to 3 attempts" cap on the
 * outer fix -> re-review cycle existed only as a sentence of English prose in
 * SKILL.md. Since the MODEL orchestrates that loop, an unenforced sentence is
 * not a cap. Consequences:
 *
 *   - 20min elapsed + 0 fix commits => `check` returned ok:true
 *   - a `check` passing at 29:59 could be followed by a 10min review panel and
 *     a 25min Codex poll => ~65min past a nominal "30min cap"
 *
 * `bump-round` is therefore called immediately BEFORE the review panel and
 * fails CLOSED at the cap. The model cannot argue with a non-zero exit code.
 *
 * Pure functions exported for unit testing — see
 *   scripts/__tests__/quality-run-governor.test.js
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { loadManifest, withManifestLock } = require("./quality-invocation");

/**
 * Derive a coarse "shape" key for a finding so near-duplicate findings
 * across rounds (same gap, different call site) collapse to one key.
 *
 * Deliberately FILE-INDEPENDENT: the key is the first significant
 * (digit/punctuation-normalized) words of the summary alone. This is what
 * makes the incident scenario detectable — "on-disk job differs from loaded
 * job" recurring at 4 different call sites (4 different files) must collapse
 * to one shape, or the batch-fix nudge never fires. `file` is used only as a
 * fallback key on the rare finding with an empty/missing summary, normalized
 * (trailing ":N"/":N-M" line-range suffix stripped) purely so that fallback
 * doesn't fragment on line-number churn between rounds.
 *
 * This is a heuristic, not semantic diffing — false merges just mean an
 * extra "is this really the same issue?" glance, not a correctness bug.
 */
function findingShapeKey(finding) {
  // Strip a trailing ":N" or ":N-M" line/range suffix. Split into two
  // anchored, non-nested-quantifier replaces rather than one regex with an
  // optional group after \d+ — equivalent result, but avoids the pattern
  // shape static analyzers flag as a potential ReDoS vector.
  const file = String(finding.file || "")
    .replace(/:\d+-\d+$/, "")
    .replace(/:\d+$/, "");
  const summary = String(finding.summary || finding.title || "")
    .toLowerCase()
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  return `${summary}`.trim() || file;
}

/**
 * Given the governor state's finding history, decide whether the current
 * round's findings are "narrow variants of the same gap" — i.e. most of
 * them share a shape key already seen in a prior round.
 *
 * @param {Array<{file:string, summary:string}>} priorFindings flat history
 * @param {Array<{file:string, summary:string}>} currentFindings this round
 * @param {number} threshold fraction (0-1) of current findings that must
 *   repeat a prior shape to count as a repeated-pattern round. Default 0.6.
 */
function detectRepeatedPattern(
  priorFindings,
  currentFindings,
  threshold = 0.6,
) {
  if (!currentFindings.length) {
    return { repeated: false, shape: null, matchCount: 0, total: 0 };
  }
  const priorShapes = new Map();
  for (const f of priorFindings) {
    const key = findingShapeKey(f);
    priorShapes.set(key, (priorShapes.get(key) || 0) + 1);
  }
  const shapeCounts = new Map();
  for (const f of currentFindings) {
    const key = findingShapeKey(f);
    shapeCounts.set(key, (shapeCounts.get(key) || 0) + 1);
  }
  // Find the dominant shape in the current round that also appeared before.
  let bestShape = null;
  let bestCount = 0;
  for (const [key, count] of shapeCounts) {
    if (priorShapes.has(key) && count > bestCount) {
      bestShape = key;
      bestCount = count;
    }
  }
  const matchCount = bestShape ? bestCount : 0;
  const repeated =
    matchCount / currentFindings.length >= threshold && matchCount >= 2;
  return {
    repeated,
    shape: bestShape,
    matchCount,
    total: currentFindings.length,
  };
}

/**
 * Return the current commit count on HEAD, or `null` on any git failure
 * (detached-HEAD race, transient lock, wrong cwd). MUST NOT return `0` on
 * failure: `0` is indistinguishable from a genuinely empty repo, and
 * `evaluateBudget` computes `commitsUsed = commitCount - start_commit_count`
 * — a failure-as-`0` on a repo already at commit 5 produces a large
 * *negative* `commitsUsed`, which can never trip the commit-cap circuit
 * breaker. That silently disables the commit dimension of a fail-closed
 * guardrail exactly when git is unreliable — the opposite of the intended
 * behavior. Returning `null` lets `evaluateBudget` fail CLOSED via the same
 * `Number.isFinite` check it already applies to the sentinel's own fields.
 */
function currentCommitCount(cwd) {
  try {
    const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = parseInt(out.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Count commits made ON TOP OF the baseline SHA — i.e. `<startSha>..HEAD`.
 *
 * This is the correct "fix-commits made during THIS run" measure. The legacy
 * approach (total `rev-list --count HEAD` minus a numeric baseline) is only
 * valid when HEAD's total ancestry stays fixed except for appended commits.
 * That assumption breaks in the `--merge <PR>` flow: Step -1 baselines inside
 * a PR-branch worktree, but a later governor check can run from a HEAD whose
 * total ancestry differs (rebase onto updated main, or a cross-checkout cwd),
 * producing a bogus cross-baseline delta — observed 2026-07-14 as
 * `commitsUsed: 21` with ZERO fix commits, falsely tripping the commit cap.
 *
 * `<startSha>..HEAD` is immune to all of that: it counts exactly the commits
 * reachable from HEAD but not from the baseline, which is the definition of
 * new work. Returns `null` on any git failure (same fail-closed contract as
 * `currentCommitCount`), so `evaluateBudget`'s `Number.isFinite` guard halts.
 */
function commitsSinceBaseline(cwd, startSha) {
  if (typeof startSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(startSha)) {
    return null;
  }
  try {
    // `<sha>..HEAD` only means "new commits since baseline" when the baseline
    // is actually an ANCESTOR of HEAD. If it isn't — a hard reset, a rebase
    // that orphaned it, or a check running from a divergent checkout — the
    // range counts unrelated history and can reproduce the very false-trip this
    // fix exists to kill. Fail CLOSED in that case (return null → evaluateBudget
    // halts via its Number.isFinite guard) rather than trusting a bogus count.
    execFileSync("git", ["merge-base", "--is-ancestor", startSha, "HEAD"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const out = execFileSync(
      "git",
      ["rev-list", "--count", `${startSha}..HEAD`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = parseInt(out.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Non-zero exit from --is-ancestor (baseline not an ancestor) OR any git
    // failure both land here → null → fail closed.
    return null;
  }
}

/**
 * Resolve the run-scoped fix-commit count for a given state + cwd.
 *
 * Preferred path: `start_commit_sha` present → count `<sha>..HEAD` directly
 * (rebase/checkout-immune). This returns commits-USED, not a total; callers
 * pass it as `commitCount` and `evaluateBudget` treats it accordingly.
 *
 * Legacy fallback: sentinels written before `start_commit_sha` existed only
 * have `start_commit_count`, so fall back to total-ancestry `HEAD` count and
 * let `evaluateBudget` do the subtraction (the old, rebase-fragile behavior —
 * but no worse than before, and only for in-flight pre-upgrade runs).
 */
// Follow a validated rebase-carry chain from the original baseline to the head
// that actually survives in current history. Each carry records
// `reviewedHead -> head` for one proven exact replay, so walking the links from
// the start SHA yields the carried equivalent of that commit.
//
// Fails closed on a discontinuous or cyclic chain: an unproven jump is exactly
// what the ancestry check exists to refuse, and a malformed chain must not
// become a way to relocate the baseline anywhere convenient.
function carriedBaseline(cwd, startSha, carries) {
  if (!Array.isArray(carries) || carries.length === 0) return null;
  let current = startSha;
  const seen = new Set([current]);
  for (let step = 0; step < carries.length; step += 1) {
    // Exact SHA equality, not a prefix test. A 7-character prefix match would
    // accept any carry whose reviewedHead merely shares its first 7 hex
    // characters with `current`, and Array.find returns the FIRST such entry —
    // so after a few rebase/retry cycles the wrong carry could be selected and
    // the baseline silently resolved to an unrelated commit, skewing the fix
    // commit count that bounds an autonomous campaign. A carry asserts one
    // proven exact replay; the lookup has to be exact too.
    const carry = carries.find(
      (entry) =>
        entry &&
        typeof entry.reviewedHead === "string" &&
        typeof entry.head === "string" &&
        entry.reviewedHead === current,
    );
    if (!carry) break;
    if (seen.has(carry.head)) return null;
    seen.add(carry.head);
    current = carry.head;
  }
  if (current === startSha) return null;
  return isAncestorOfHead(cwd, current) ? current : null;
}

function isAncestorOfHead(cwd, sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function resolveCommitCount(cwd, state) {
  if (state && typeof state.start_commit_sha === "string") {
    const direct = commitsSinceBaseline(cwd, state.start_commit_sha);
    if (direct !== null) return direct;
    // The original baseline is no longer in history. Before failing closed,
    // see whether a proven rebase carried it to a commit that still is.
    const carried = carriedBaseline(
      cwd,
      state.start_commit_sha,
      state.review_rebase_carries,
    );
    if (carried === null) return null;
    return commitsSinceBaseline(cwd, carried);
  }
  return currentCommitCount(cwd);
}

/**
 * Load the governor sentinel. Returns `null` on any read/parse failure
 * (missing file, truncated write, corrupt JSON) instead of throwing —
 * callers treat `null` as "state unreadable" and fail CLOSED (the sentinel
 * existing but being unreadable is itself a signal something is wrong with
 * the run, so the safe default is to halt, not to silently pass).
 */
function loadState(sentinelPath) {
  try {
    const raw = fs.readFileSync(sentinelPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion === 1 && parsed.governor) {
      const governor = parsed.governor;
      if (governor.executionBudgetVersion !== 1) return null;
      const activeSecondsLimit =
        governor.activeSecondsLimit ??
        governor.campaignSeconds ??
        governor.providerSecondsLimit;
      const activeSecondsUsed =
        governor.activeSecondsUsed ??
        (governor.gateSecondsUsed ?? 0) + governor.providerSecondsUsed;
      const providerRemaining = Math.max(
        0,
        governor.providerSecondsLimit - governor.providerSecondsUsed,
      );
      const activeRemaining = Math.max(
        0,
        activeSecondsLimit - activeSecondsUsed,
      );
      const executionSecondsUsed = Math.max(1, activeSecondsUsed);
      const executableSecondsLimit =
        executionSecondsUsed + Math.min(providerRemaining, activeRemaining);
      return {
        // Review governance sees the remaining shared active execution cap.
        // Idle lifecycle time is governed by manifest TTL and revalidation.
        start_epoch: 0,
        deadline_epoch: executableSecondsLimit,
        start_commit_sha: governor.startCommitSha,
        // A campaign that advanced through a proven rebase-only replay keeps a
        // valid carry chain, but its original start SHA is no longer an
        // ancestor of HEAD. Without the chain the governor cannot tell that
        // expected topology apart from a hard reset, and reports it as a
        // malformed sentinel (BUI-902).
        review_rebase_carries: Array.isArray(
          parsed.revisions?.reviewRebaseCarries,
        )
          ? parsed.revisions.reviewRebaseCarries
          : [],
        max_fix_commits: governor.maxFixCommits,
        max_wall_seconds: executableSecondsLimit,
        execution_seconds_used: executionSecondsUsed,
        max_rereview_reserve_seconds: governor.reReviewReserveSeconds,
        max_review_rounds: governor.maxReviewRounds,
        rounds_used: governor.roundsUsed,
        authorized_attempts: governor.authorizedAttempts || [],
        findings_seen: governor.findingsSeen,
        _manifest: true,
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveState(sentinelPath, state) {
  if (state._manifest) {
    withManifestLock(sentinelPath, (manifest) => {
      manifest.governor.roundsUsed = state.rounds_used;
      manifest.governor.authorizedAttempts = state.authorized_attempts || [];
      manifest.governor.findingsSeen = state.findings_seen;
    });
    return;
  }
  fs.writeFileSync(sentinelPath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Parse the `record-finding` CLI arg into an array of {file, summary}
 * findings, always returning an array — never throwing, never passing a
 * non-array through to callers that assume array shape (detectRepeatedPattern
 * and the findings_seen .concat()).
 *
 * JSON.parse happily accepts valid-but-non-array JSON ("42", "\"x\"", "{}"),
 * which would otherwise either throw when iterated as an array or silently
 * corrupt findings_seen by appending a scalar/object as a single "finding".
 * Both the malformed-JSON case and the valid-but-wrong-shape case log to
 * stderr and degrade to an empty array — same fail-safe behavior, one
 * function, so `main()`'s record-finding branch stays flat.
 */
function parseFindingsArg(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    process.stderr.write(
      `[quality] record-finding: malformed findings JSON argument — treating as empty this round.\n`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `[quality] record-finding: findings JSON argument was valid JSON but not an array — treating as empty this round.\n`,
    );
    return [];
  }
  return parsed;
}

/**
 * Extract a safe findings array from the LOADED sentinel state's
 * `findings_seen` field. `state.findings_seen || []` only substitutes on
 * falsy (undefined/null/""), so a truthy-but-non-array value surviving in the
 * sentinel (a partial/corrupt write, or manual tampering) would flow straight
 * into `.concat()`. `Array.prototype.concat` called on a non-array `this`
 * coerces through `String.prototype.concat` and silently corrupts
 * `findings_seen` into a string, which re-corrupts every subsequent round and
 * silently disables repeated-pattern detection for the rest of the run with
 * no warning — verified: `findings_seen: "corrupted"` + one finding becomes a
 * garbage string with exit code 0. Coerce to `[]` here exactly as
 * `parseFindingsArg` does for the CLI arg, so the sentinel's own history
 * can't carry this failure mode.
 */
function priorFindingsFrom(state) {
  return Array.isArray(state && state.findings_seen) ? state.findings_seen : [];
}

/**
 * Evaluate whether the run may continue. Returns a plain object (never
 * throws on a tripped budget — that's a normal, expected outcome, not an
 * error) so the caller can render it and decide whether to exit.
 *
 * Fail-closed on malformed state: a circuit breaker's entire job is to stop
 * a runaway loop, so a sentinel with a missing/non-numeric bound must trip
 * the budget rather than silently disable it (`x >= undefined` and
 * `x >= NaN` both evaluate to `false` in JS, which is the wrong default
 * here). `configInvalid` distinguishes this case from a genuine trip so
 * callers can surface a distinct diagnostic.
 *
 * Also fails closed when `commitCount` itself is non-finite (i.e. git
 * failed — see `currentCommitCount`'s `null` return). Treating a failed
 * commit-count read as "0 commits" would make `commitsUsed` go negative
 * and never trip; treating it as invalid config instead halts the run,
 * consistent with every other "the breaker's own inputs are untrustworthy"
 * case here.
 */
function initialReviewIsEligible({
  roundsUsed,
  commitTripped,
  wallTripped,
  roundTripped,
}) {
  return roundsUsed === 1 && commitTripped && !wallTripped && !roundTripped;
}

function evaluateBudget(state, { nowEpoch, commitCount }) {
  // `start_commit_count` is only required on legacy sentinels (no SHA baseline);
  // a SHA-baselined sentinel measures `<sha>..HEAD` directly and doesn't need it.
  const hasShaBaseline = !!(
    state && typeof state.start_commit_sha === "string"
  );
  const requiredFields = [
    "start_epoch",
    "max_fix_commits",
    "max_wall_seconds",
    "max_review_rounds",
    ...(hasShaBaseline ? [] : ["start_commit_count"]),
  ];
  const configInvalid =
    requiredFields.some((key) => !Number.isFinite(state && state[key])) ||
    !Number.isFinite(commitCount);
  if (configInvalid) {
    return {
      ok: false,
      configInvalid: true,
      elapsedSeconds: null,
      commitsUsed: null,
      roundsUsed: null,
      maxWallSeconds: state ? state.max_wall_seconds : undefined,
      maxFixCommits: state ? state.max_fix_commits : undefined,
      maxReviewRounds: state ? state.max_review_rounds : undefined,
      wallTripped: true,
      commitTripped: true,
      roundTripped: true,
    };
  }

  const elapsedSeconds = Number.isFinite(state.execution_seconds_used)
    ? state.execution_seconds_used
    : nowEpoch - state.start_epoch;
  // With a SHA baseline, `commitCount` is ALREADY the run-scoped `<sha>..HEAD`
  // count (commits made during the run), so use it directly. Without one (a
  // legacy sentinel), it's the total-ancestry HEAD count and we subtract the
  // numeric baseline — the old rebase-fragile path, kept only for in-flight
  // pre-upgrade runs. See resolveCommitCount / commitsSinceBaseline.
  const commitsUsed =
    state && typeof state.start_commit_sha === "string"
      ? commitCount
      : commitCount - state.start_commit_count;
  // rounds_used is absent on a sentinel written before this field existed;
  // treat as 0 rather than tripping configInvalid, so an in-flight run that
  // straddles an upgrade degrades to "no rounds consumed yet" instead of
  // halting. Every NEW sentinel writes it explicitly (see SKILL.md Step -1).
  const roundsUsed = Number.isFinite(state.rounds_used) ? state.rounds_used : 0;
  const wallTripped = elapsedSeconds >= state.max_wall_seconds;
  const commitTripped = commitsUsed >= state.max_fix_commits;
  // `rounds_used` is incremented BEFORE evaluation (bump-round), so it is the
  // 1-based index of the round about to run. A cap of 2 must therefore permit
  // rounds 1 and 2 and refuse round 3 — i.e. strictly-greater-than, not >=.
  // (`>=` here would allow only max-1 rounds: a cap of 2 blocked round 2.)
  const roundTripped = roundsUsed > state.max_review_rounds;
  // A campaign cannot safely skip its first provider review merely because a
  // prerequisite gate required a correction before any review had run. The
  // one-fix budget still prevents a later re-review loop: this exception is
  // limited to the 1-based initial review round and never overrides time or
  // round limits.
  const initialReviewEligible = initialReviewIsEligible({
    roundsUsed,
    commitTripped,
    wallTripped,
    roundTripped,
  });
  return {
    ok:
      !wallTripped &&
      !roundTripped &&
      (!commitTripped || initialReviewEligible),
    configInvalid: false,
    elapsedSeconds,
    commitsUsed,
    roundsUsed,
    maxWallSeconds: state.max_wall_seconds,
    maxFixCommits: state.max_fix_commits,
    maxReviewRounds: state.max_review_rounds,
    wallTripped,
    commitTripped,
    roundTripped,
    initialReviewEligible,
  };
}

function reviewHead(state, sentinelPath, cwd) {
  if (state._manifest) {
    return loadManifest(sentinelPath).manifest.revisions.currentHead;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function reusableAuthorization(state, round, head) {
  return [...state.authorized_attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.number === round &&
        attempt.head === head &&
        attempt.consumedAt === null &&
        !attempt.invalidatedAt,
    );
}

function replaceAuthorization(state, head, reusableAttempt) {
  const authorizedAt = new Date().toISOString();
  for (const attempt of state.authorized_attempts) {
    if (
      attempt.consumedAt === null &&
      !attempt.invalidatedAt &&
      (attempt.head !== head ||
        attempt.number !== state.rounds_used ||
        attempt === reusableAttempt)
    ) {
      attempt.invalidatedAt = authorizedAt;
      attempt.invalidationReason =
        attempt === reusableAttempt
          ? "replaced for provider retry"
          : "stale after review identity changed";
    }
  }
  state.authorized_attempts.push({
    number: state.rounds_used,
    token: crypto.randomUUID(),
    head,
    authorizedAt,
    consumedAt: null,
    ...(reusableAttempt ? { retryOf: reusableAttempt.token } : {}),
  });
}

function reconcileManifestRounds(sentinelPath) {
  withManifestLock(sentinelPath, (manifest) => {
    const covered = manifest.reviews.filter((review) =>
      ["success", "advisory"].includes(review.status),
    );
    const rounds = [...new Set(covered.map((review) => review.round))].sort(
      (left, right) => left - right,
    );
    rounds.forEach((round, index) => {
      if (round !== index + 1) {
        throw new Error("successful review rounds are not contiguous");
      }
    });
    for (const review of covered) {
      if (review.status === "advisory") {
        if (manifest.risk?.tier !== "low" || review.provider !== "ci-only") {
          throw new Error("invalid advisory review round");
        }
        continue;
      }
      const authorization = manifest.governor.authorizedAttempts.find(
        (attempt) =>
          attempt.token === review.governorAttemptToken &&
          attempt.head === review.to &&
          attempt.consumedAt !== null &&
          !attempt.invalidatedAt,
      );
      if (!authorization) {
        throw new Error(
          `review round ${review.round} lacks consumed governor authorization`,
        );
      }
    }
    manifest.governor.roundsUsed = rounds.length;
  });
}

function mandatoryValidationHasReservedBudget(
  state,
  priorRounds,
  result,
  sentinelPath,
) {
  if (
    !state._manifest ||
    priorRounds < 1 ||
    state.rounds_used !== priorRounds + 1 ||
    (!result.commitTripped && !result.wallTripped) ||
    result.roundTripped
  ) {
    return false;
  }
  try {
    const manifest = loadManifest(sentinelPath).manifest;
    const successful = manifest.reviews.filter(
      (review) => review.status === "success",
    );
    const reviewedHead = successful.at(-1)?.to;
    if (
      successful.length !== priorRounds ||
      successful.at(-1)?.round !== priorRounds ||
      !reviewedHead ||
      reviewedHead === manifest.revisions.currentHead
    ) {
      return false;
    }
    if (!providerBudgetIsActive(manifest)) {
      return false;
    }
    execFileSync(
      "git",
      [
        "merge-base",
        "--is-ancestor",
        reviewedHead,
        manifest.revisions.currentHead,
      ],
      { cwd: manifest.repo.realpath, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function providerBudgetIsActive(manifest) {
  const governor = manifest.governor;
  return (
    Number.isFinite(governor.providerSecondsUsed) &&
    Number.isFinite(governor.providerSecondsLimit) &&
    Number.isFinite(governor.activeSecondsUsed) &&
    Number.isFinite(governor.activeSecondsLimit) &&
    governor.providerSecondsUsed < governor.providerSecondsLimit &&
    governor.activeSecondsUsed < governor.activeSecondsLimit
  );
}

function loadReconciledState(sentinelPath) {
  let state = loadState(sentinelPath);
  if (!state) {
    return {
      error: `[quality] governor sentinel unreadable at ${sentinelPath} — failing CLOSED. The review loop cannot be bounded without it, and an unbounded loop is the exact failure this governor exists to prevent.\n`,
    };
  }
  if (!state._manifest) return { state };
  try {
    reconcileManifestRounds(sentinelPath);
    state = loadState(sentinelPath);
    return state
      ? { state }
      : {
          error: `[quality] governor sentinel unreadable after reconciliation at ${sentinelPath} — failing CLOSED.\n`,
        };
  } catch (error) {
    return {
      error: `[quality] governor review reconciliation failed CLOSED: ${error.message}\n`,
    };
  }
}

function prepareReviewAttempt(sentinelPath, requestedCwd) {
  const loaded = loadReconciledState(sentinelPath);
  if (loaded.error) return loaded;
  const { state } = loaded;
  const priorRounds = Number.isFinite(state.rounds_used)
    ? state.rounds_used
    : 0;
  const cwd = state._manifest
    ? loadManifest(sentinelPath).manifest.repo.realpath
    : requestedCwd;
  state.authorized_attempts = state.authorized_attempts || [];
  const authorizedHead = reviewHead(state, sentinelPath, cwd);
  const nextRound = priorRounds + 1;
  const reusableAttempt = reusableAuthorization(
    state,
    state._manifest ? nextRound : priorRounds,
    authorizedHead,
  );
  state.rounds_used = reusableAttempt ? reusableAttempt.number : nextRound;
  return {
    state,
    priorRounds,
    cwd,
    authorizedHead,
    reusableAttempt,
    retryingRound: Boolean(reusableAttempt),
  };
}

function reviewBudgetDecision(context, sentinelPath) {
  const { state, priorRounds, cwd } = context;
  const result = evaluateBudget(state, {
    nowEpoch: Math.floor(Date.now() / 1000),
    commitCount: resolveCommitCount(cwd, state),
  });
  if (result.configInvalid) {
    return {
      result,
      error: `[quality] governor sentinel missing required fields at ${sentinelPath} — failing CLOSED (halting), not silently passing.\n`,
    };
  }
  // A manifest campaign reserves one bounded verification pass after the
  // normal fix/re-review cap when remediation consumed the ordinary budget.
  // Evaluate that exception before the generic round-cap error; otherwise
  // `result.roundTripped` makes the reserved path unreachable by definition.
  const mandatoryOverride = mandatoryValidationHasReservedBudget(
    state,
    priorRounds,
    result,
    sentinelPath,
  );
  if (result.roundTripped && !mandatoryOverride) {
    return {
      result,
      error:
        `[quality] ROUND BUDGET EXHAUSTED: review round ${result.roundsUsed} would exceed the cap of ${result.maxReviewRounds}.\n` +
        `[quality] Stopping the fix -> re-review loop. Report the outstanding findings and STOP — do not run another panel.\n` +
        `[quality] Override deliberately with BS_QUALITY_MAX_REVIEW_ROUNDS if a repo genuinely needs more.\n`,
    };
  }
  if (result.ok || mandatoryOverride) {
    return { result, mandatoryOverride };
  }
  const elapsedLabel = state._manifest ? "provider execution" : "wall-clock";
  const wall = result.wallTripped
    ? `${elapsedLabel} ${result.elapsedSeconds}s >= ${result.maxWallSeconds}s `
    : "";
  const commits = result.commitTripped
    ? `fix-commits ${result.commitsUsed} >= ${result.maxFixCommits}`
    : "";
  return {
    result,
    error:
      `[quality] BUDGET EXHAUSTED before review round ${result.roundsUsed}: ${wall}${commits}\n` +
      `[quality] Stopping. Report outstanding findings and STOP.\n`,
  };
}

/**
 * `bump-round` — called IMMEDIATELY BEFORE the review panel runs (SKILL.md
 * Step 2.0). Increments rounds_used, persists, then evaluates every budget.
 * Returns the process exit code: 0 to proceed, 1 to halt.
 *
 * This is THE enforcement point for the outer fix -> re-review loop. Before it
 * existed, that loop's only bound was a sentence of prose in SKILL.md, and the
 * model — which orchestrates the loop — could and did run past it (128min and
 * 167min runs, 2026-07-03). Returning a non-zero exit code is the whole point:
 * a shell `|| exit 1` is not something the model can talk itself out of.
 *
 * Fails CLOSED on an unreadable or incomplete sentinel: a circuit breaker that
 * silently disables itself when its own state is untrustworthy is worse than
 * no breaker, because it reads as protection that isn't there.
 */
function bumpRound(sentinelPath, cwd) {
  const context = prepareReviewAttempt(sentinelPath, cwd);
  if (context.error) {
    process.stderr.write(context.error);
    return 1;
  }
  const decision = reviewBudgetDecision(context, sentinelPath);
  if (decision.error) {
    process.stderr.write(decision.error);
    return 1;
  }
  if (decision.mandatoryOverride) {
    process.stdout.write(
      `[quality] campaign cap reached; authorizing reserved incremental validation round ${decision.result.roundsUsed} without permitting further remediation.\n`,
    );
  }
  replaceAuthorization(
    context.state,
    context.authorizedHead,
    context.reusableAttempt,
  );
  saveState(sentinelPath, context.state);

  process.stdout.write(
    `[quality] ${context.retryingRound ? "retrying" : "review"} round ${decision.result.roundsUsed}/${decision.result.maxReviewRounds} ` +
      `(elapsed ${decision.result.elapsedSeconds}s/${decision.result.maxWallSeconds}s, ` +
      `fix-commits ${decision.result.commitsUsed}/${decision.result.maxFixCommits})\n`,
  );
  return 0;
}

function startRemediationClock(sentinelPath) {
  try {
    const loaded = loadManifest(sentinelPath);
    if (
      loaded.manifest.schemaVersion !== 1 ||
      !loaded.manifest.governor ||
      loaded.manifest.governor.remediationStartedAtEpoch !== null
    ) {
      return;
    }
    withManifestLock(sentinelPath, (manifest) => {
      if (manifest.governor.remediationStartedAtEpoch === null) {
        manifest.governor.remediationStartedAtEpoch = Math.floor(
          Date.now() / 1000,
        );
      }
    });
  } catch {
    // Legacy governor sentinels are not invocation manifests.
  }
}

function remainingBudgetConfigValid(
  state,
  { nowEpoch, reserveSeconds, capSeconds },
  metersExecution,
) {
  if (!state) return false;
  if (
    ![state.start_epoch, state.deadline_epoch, state.max_wall_seconds].every(
      Number.isFinite,
    )
  ) {
    return false;
  }
  if (
    !metersExecution &&
    state.deadline_epoch !== state.start_epoch + state.max_wall_seconds
  ) {
    return false;
  }
  if (![nowEpoch, reserveSeconds, capSeconds].every(Number.isFinite)) {
    return false;
  }
  return reserveSeconds >= 0 && capSeconds > 0;
}

function remainingBudget(
  state,
  { nowEpoch, reserveSeconds = 0, capSeconds = Number.MAX_SAFE_INTEGER },
) {
  const metersExecution = Number.isFinite(state?.execution_seconds_used);
  const valid = remainingBudgetConfigValid(
    state,
    { nowEpoch, reserveSeconds, capSeconds },
    metersExecution,
  );
  if (!valid) return { ok: false, seconds: 0, valid: false };
  const available = metersExecution
    ? state.max_wall_seconds - state.execution_seconds_used - reserveSeconds
    : state.deadline_epoch - nowEpoch - reserveSeconds;
  const seconds = Math.max(0, Math.min(capSeconds, available));
  return { ok: seconds > 0, seconds, valid: true };
}

function printRemaining(sentinelPath, rest) {
  const reserveIndex = rest.indexOf("--reserve");
  const capIndex = rest.indexOf("--cap");
  const result = remainingBudget(loadState(sentinelPath), {
    nowEpoch: Math.floor(Date.now() / 1000),
    reserveSeconds: reserveIndex >= 0 ? Number(rest[reserveIndex + 1]) : 0,
    capSeconds:
      capIndex >= 0 ? Number(rest[capIndex + 1]) : Number.MAX_SAFE_INTEGER,
  });
  process.stdout.write(`${result.seconds}\n`);
  return result.ok ? 0 : result.valid ? 1 : 2;
}

function main() {
  const [, , cmd, sentinelPath, ...rest] = process.argv;
  if (!cmd || !sentinelPath) {
    process.stderr.write(
      "usage: quality-run-governor.js <check|bump-round|remaining|record-finding|status> <sentinel-path> [args]\n",
    );
    process.exit(2);
  }

  const cwd = process.env.QUALITY_CWD || process.cwd();

  if (cmd === "check") {
    startRemediationClock(sentinelPath);
    const state = loadState(sentinelPath);
    const result = evaluateBudget(state, {
      nowEpoch: Math.floor(Date.now() / 1000),
      commitCount: resolveCommitCount(cwd, state),
    });
    if (result.configInvalid) {
      process.stderr.write(
        `[quality] governor sentinel unreadable or missing required fields at ${sentinelPath} — failing CLOSED (halting), not silently passing.\n`,
      );
    }
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "bump-round") {
    process.exit(bumpRound(sentinelPath, cwd));
  }

  if (cmd === "remaining") {
    process.exit(printRemaining(sentinelPath, rest));
  }

  if (cmd === "record-finding") {
    // rest = JSON array of {file, summary} for this round's findings, as a
    // single JSON string argument.
    const state = loadState(sentinelPath);
    if (!state) {
      process.stderr.write(
        `[quality] governor sentinel unreadable at ${sentinelPath} — cannot record findings this round (repeated-pattern detection disabled for this round).\n`,
      );
      process.stdout.write(
        JSON.stringify({
          repeated: false,
          shape: null,
          matchCount: 0,
          total: 0,
        }) + "\n",
      );
      process.exit(1);
    }
    const currentFindings = parseFindingsArg(rest[0]);
    const priorFindings = priorFindingsFrom(state);
    const pattern = detectRepeatedPattern(priorFindings, currentFindings);
    state.findings_seen = priorFindings.concat(currentFindings);
    state.last_findings = currentFindings;
    state.last_findings_round = state.rounds_used;
    saveState(sentinelPath, state);
    process.stdout.write(JSON.stringify(pattern) + "\n");
    process.exit(0);
  }

  if (cmd === "status") {
    const state = loadState(sentinelPath);
    const result = evaluateBudget(state, {
      nowEpoch: Math.floor(Date.now() / 1000),
      commitCount: resolveCommitCount(cwd, state),
    });
    if (result.configInvalid) {
      process.stderr.write(
        `[quality] governor sentinel unreadable or missing required fields at ${sentinelPath} — status unavailable.\n`,
      );
      process.exit(1);
    }
    const mins = Math.floor(result.elapsedSeconds / 60);
    const secs = result.elapsedSeconds % 60;
    process.stdout.write(
      `[quality] elapsed ${mins}m${secs}s/${Math.floor(result.maxWallSeconds / 60)}m, ` +
        `fix-commits ${result.commitsUsed}/${result.maxFixCommits}, ` +
        `review-rounds ${result.roundsUsed}/${result.maxReviewRounds}\n`,
    );
    process.exit(0);
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exit(2);
}

module.exports = {
  findingShapeKey,
  detectRepeatedPattern,
  evaluateBudget,
  remainingBudget,
  bumpRound,
  parseFindingsArg,
  priorFindingsFrom,
  resolveCommitCount,
};

if (require.main === module) {
  main();
}
