#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  authorizationReviews,
  completedReviews,
  coveredReviews,
  exhaustedIncompleteReviews,
  incompleteRetryStatus,
} = require("./quality-review-history");
const { execFileSync, spawnSync } = require("child_process");
const riskScore = require("./risk-score.js");
const agentSelection = require("./quality-agent-selection.js");
const conditionTaxonomy = require("./quality-condition-taxonomy.js");
const { evidenceDigestValid } = require("./quality-ci-billing-waiver.js");
const testImpact = require("./test-impact.js");

const SCHEMA_VERSION = 1;
const REVIEW_CONTRACT_VERSION = 2;
const EXECUTION_BUDGET_VERSION = 1;
const RUNTIME_PLAN_VERSION = 2;
const REQUIRED_GATES_POLICY_VERSION = 3;
const MAX_AGENT_TARGET = 9;
const DELIVERY_CLAIMS = new Set([
  "contract",
  "engineering",
  "local-product",
  "hosted",
  "validated",
]);
const NEEDS_EXECUTION_BUDGET_MIGRATION = Symbol(
  "needs-execution-budget-migration",
);
const NEEDS_REQUIRED_GATES_MIGRATION = Symbol("needs-required-gates-migration");

class GateExecutionError extends Error {
  constructor(status, message, failureCode = null) {
    super(message);
    this.name = "GateExecutionError";
    this.failureCode = failureCode;
    this.status = status;
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function buildReviewPolicy(manifest) {
  const config = riskScore.loadConfig(manifest.repo.realpath);
  return {
    reviewContractVersion: REVIEW_CONTRACT_VERSION,
    selectorVersion: 1,
    proofSchemaVersion: 1,
    curve: config.curve,
  };
}

function reviewPolicyDigest(policy) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(policy)))
    .digest("hex");
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// The review runner expands an initialized `core` gitlink into the exact
// recursive submodule diff so a provider cannot approve an opaque control-
// plane pointer. Canonical verification must hash the same byte stream or a
// valid review is rejected after the provider has already spent its budget.
function reviewDiffBuffer(root, from, to) {
  const diff = execFileSync("git", ["diff", `${from}..${to}`], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
  const treeEntry = (commit) => {
    const row = git(root, ["ls-tree", commit, "--", "core"]);
    const fields = row.split(/\s+/);
    return fields[0] === "160000" && fields[1] === "commit" ? fields[2] : "";
  };
  const baseCore = treeEntry(from);
  const headCore = treeEntry(to);
  const coreCheckout = fs.existsSync(path.join(root, "core", ".git"));
  if (!baseCore && !headCore) return diff;
  if (!baseCore || !headCore) {
    throw new Error("core gitlink exists on only one side of the diff");
  }
  if (baseCore === headCore) return diff;
  if (!coreCheckout) {
    throw new Error(
      "changed core gitlink requires an initialized checkout for recursive review",
    );
  }
  for (const commit of [baseCore, headCore]) {
    execFileSync(
      "git",
      ["-C", "core", "cat-file", "-e", `${commit}^{commit}`],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }
  const recursive = execFileSync(
    "git",
    ["-C", "core", "diff", "--submodule=diff", baseCore, headCore],
    {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 64,
    },
  );
  return Buffer.concat([
    diff,
    Buffer.from(
      `\n===== recursive submodule diff: core ${baseCore}..${headCore} =====\n`,
    ),
    recursive,
    Buffer.from("===== end recursive submodule diff: core =====\n"),
  ]);
}

function canonicalRoot(input) {
  const resolved = fs.realpathSync(input);
  return fs.realpathSync(git(resolved, ["rev-parse", "--show-toplevel"]));
}

// Prove that applying the exact binary diff reviewed at oldHead onto newBase
// produces nextHead's tree. This is stronger than git patch-id: patch-id
// deliberately ignores whitespace and cannot safely authorize a carry.
function replayedTree(root, oldBase, oldHead, newBase) {
  try {
    const diff = execFileSync(
      "git",
      ["diff", "--binary", "--full-index", oldBase, oldHead],
      {
        cwd: root,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 64,
      },
    );
    const indexFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "quality-rebase-index-")),
      "index",
    );
    try {
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      execFileSync("git", ["read-tree", newBase], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync("git", ["apply", "--cached", "--whitespace=nowarn", "-"], {
        cwd: root,
        env,
        input: diff,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 64,
      });
      return execFileSync("git", ["write-tree"], {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } finally {
      fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

function isAncestorOf(root, ancestor, descendant) {
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function gitCommonDir(root) {
  const value = git(root, ["rev-parse", "--git-common-dir"]);
  return fs.realpathSync(path.resolve(root, value));
}

function originIdentity(root) {
  const value = git(root, ["remote", "get-url", "origin"]);
  if (!value) throw new Error("quality requires an origin remote identity");
  return value;
}

function repoKey(root) {
  return crypto
    .createHash("sha256")
    .update(gitCommonDir(root))
    .digest("hex")
    .slice(0, 16);
}

function deterministicInvocationId(identity) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(identity)))
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "5";
  digest[16] = (8 + (parseInt(digest[16], 16) % 4)).toString(16);
  const value = digest.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function qualityTmpRoot() {
  return fs.realpathSync(process.env.TMPDIR || os.tmpdir());
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function atomicCreate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.create`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.linkSync(temporary, file);
    fs.chmodSync(file, 0o600);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.unlinkSync(temporary);
  }
}

function normalizeExecutionGovernor(manifest) {
  if (manifest.governor.executionBudgetVersion === undefined) {
    Object.defineProperty(manifest, NEEDS_EXECUTION_BUDGET_MIGRATION, {
      value: true,
      writable: true,
    });
  } else if (
    manifest.governor.executionBudgetVersion !== EXECUTION_BUDGET_VERSION
  ) {
    throw new Error(
      `unsupported execution budget version ${manifest.governor.executionBudgetVersion}`,
    );
  }
  manifest.governor.lifecycleTTLSeconds ??= 24 * 60 * 60;
  manifest.governor.lastActivityAt ??= new Date(
    (manifest.governor.startedAtEpoch || Math.floor(Date.now() / 1000)) * 1000,
  ).toISOString();
  manifest.governor.gateSecondsLimit ??= 10 * 60;
  manifest.governor.gateSecondsUsed ??= 0;
  manifest.governor.providerSecondsLimit ??= 15 * 60;
  manifest.governor.providerSecondsUsed ??= 0;
  manifest.governor.activeExecution ??= null;
}

function normalizeGovernor(manifest) {
  manifest.governor ??= {};
  normalizeExecutionGovernor(manifest);
  manifest.governor.authorizedAttempts ??= [];
  manifest.governor.maxProviderAttempts ??= 6;
  manifest.governor.providerWindowSeconds ??= 3600;
  manifest.governor.providerAttempts ??= [];
  manifest.governor.campaignSeconds ??=
    manifest.governor.providerWindowSeconds +
    manifest.governor.remediationSeconds +
    manifest.governor.reReviewReserveSeconds;
  manifest.governor.activeSecondsLimit ??= manifest.governor.campaignSeconds;
  manifest.governor.activeSecondsUsed ??=
    manifest.governor.gateSecondsUsed + manifest.governor.providerSecondsUsed;
}

function normalizeManifestCollections(manifest) {
  manifest.reviews ??= [];
  manifest.gates ??= [];
  manifest.mutation ??= null;
  manifest.merge ??= {};
  manifest.merge.invalidatedStamps ??= [];
  // Every campaign ends in exactly ONE recorded terminal state. Without this a
  // campaign killed mid-flight (timeout, ^C, crashed provider) leaves a
  // manifest byte-identical to one that is still running: activeExecution is
  // null either way, so the only signal is a stale lastActivityAt. Nine PR-267
  // manifests were in precisely that condition — interrupted before review,
  // with no way to tell "paused" from "in progress" from disk.
  //
  // null = still open. Anything else is final and must never be overwritten
  // (see recordTerminalState), so the first terminal cause wins and a late
  // cleanup path cannot relabel a failure as success.
  manifest.terminalState ??= null;
  normalizeGovernor(manifest);
  if (
    manifest.requiredGatesPolicyVersion === undefined ||
    manifest.requiredGatesPolicyVersion === 1 ||
    manifest.requiredGatesPolicyVersion === 2
  ) {
    // v1->v2 and v2->v3 both migrate via full recompute (replace, not
    // union) — v3 (BUI-467) changed inference semantics for the `type`
    // gate specifically (mypy is no longer promoted merely because
    // pyproject.toml declares [tool.mypy]; the diff must touch .py/.pyi
    // too), so a v2 manifest that already inferred python:mypy must be
    // recomputed under the new policy rather than keeping the stale entry
    // via union.
    Object.defineProperty(manifest, NEEDS_REQUIRED_GATES_MIGRATION, {
      value: true,
      writable: true,
    });
  } else if (
    manifest.requiredGatesPolicyVersion !== REQUIRED_GATES_POLICY_VERSION
  ) {
    throw new Error(
      `unsupported required-gates policy version ${manifest.requiredGatesPolicyVersion}`,
    );
  }
  manifest.requiredGates ??= [];
}

function loadManifest(file) {
  const requested = path.resolve(file);
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink()) {
    throw new Error("quality manifest must not be a symlink");
  }
  const manifestPath = fs.realpathSync(requested);
  const manifest = parseJson(
    fs.readFileSync(manifestPath, "utf8"),
    "quality manifest",
  );
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported quality manifest schema ${manifest.schemaVersion}`,
    );
  }
  normalizeManifestCollections(manifest);
  if (
    !manifest.invocationId ||
    !manifest.repo?.realpath ||
    !manifest.revisions?.baseSha ||
    !manifest.revisions?.currentHead
  ) {
    throw new Error("quality manifest is missing required identity fields");
  }
  const expectedPath = path.join(manifest.stateRoot, "invocation.json");
  if (path.resolve(expectedPath) !== manifestPath) {
    throw new Error("quality manifest path does not match its stateRoot");
  }
  const expectedStateRoot = path.join(
    qualityTmpRoot(),
    "bs-quality",
    manifest.repo.key,
    `pr-${manifest.repo.pr ?? "none"}`,
    manifest.revisions.baseSha,
    manifest.invocationId,
  );
  if (path.resolve(expectedStateRoot) !== path.resolve(manifest.stateRoot)) {
    throw new Error("quality manifest stateRoot identity is invalid");
  }
  return { manifest, manifestPath };
}

function saveManifest(file, manifest) {
  manifest.updatedAt = new Date().toISOString();
  manifest.manifestRevision = (manifest.manifestRevision || 0) + 1;
  atomicWrite(file, manifest);
}

// A mid-mutation persist for progress that must survive even if the rest of
// the current mutation() callback later throws (withManifestLock() only
// calls saveManifest() on a callback that returns normally). Unlike
// saveManifest(), this does NOT bump manifestRevision: withManifestLock()
// compares manifestRevision before/after the SAME mutation() call to detect
// a genuinely concurrent writer, and bumping it here would make that check
// misfire against our own in-progress transaction, not an actual concurrent
// writer. updatedAt IS refreshed, though — worktree-manager.js's
// qualityManifestReleaseState() reads it to judge whether a locked
// campaign is abandoned, and an execution reconciled moments ago is
// definitionally not abandoned (Codex review finding, 2026-08-01, medium).
function saveManifestMidTransaction(file, manifest) {
  manifest.updatedAt = new Date().toISOString();
  atomicWrite(file, manifest);
}

// manifest.revisions.baseSha is an immutable creation-time snapshot (it also
// namespaces stateRoot and anchors review-trailer provenance, so it is never
// reassigned). A base that has legitimately moved since then (main advanced
// and the PR branch was rebased onto it) always fails an exact-match against
// actualBase — that used to be unreachable because advanceHead() refused any
// HEAD that wasn't a strict descendant of the reviewed head. BUI-380 lets a
// proven rebase-only replay (patch-id identical) through advanceHead(),
// which records that proof in manifest.revisions.baseRebaseCarry: { head,
// baseSha } naming the head and live base reconciled at the moment of the
// rebase. baseSha permanently mismatches actualBase after that (merge-base
// is now computed against a different, later base forever), so trust is
// anchored on baseRebaseCarry.baseSha instead, once a carry exists.
// currentHead is accepted either as the exact carried head (the rebase
// replay itself) or as a normal git-ancestry descendant of it (ordinary new
// commits stacked afterward, same as pre-BUI-380 behavior relative to the
// original base) — descendants are NOT required to patch-id match anything;
// that requirement only ever applied to the rebase replay commit itself.
function baseIdentityMatches(manifest, actualRoot, currentHead, actualBase) {
  if (actualBase === manifest.revisions.baseSha) return true;
  const carry = manifest.revisions.baseRebaseCarry;
  return Boolean(
    carry &&
    typeof carry.baseSha === "string" &&
    carry.baseSha === actualBase &&
    (carry.head === currentHead ||
      isAncestorOf(actualRoot, carry.head, currentHead)),
  );
}

// The base to diff against for anything that needs "what changed relative
// to the PR's true base" (e.g. diffTouchesPython) — the carried live base
// after a proven rebase-only replay, or the immutable creation-time
// baseSha otherwise. Using the stale baseSha post-rebase would include
// upstream commits (that landed on main between PR creation and the
// rebase) in the diff, which can falsely widen gate inference (BUI-467).
function effectiveBaseSha(manifest) {
  return (
    manifest.revisions.baseRebaseCarry?.baseSha ?? manifest.revisions.baseSha
  );
}

function validateIdentity(manifest, cwd, { requireHead = true } = {}) {
  const actualRoot = canonicalRoot(cwd);
  if (actualRoot !== manifest.repo.realpath) {
    throw new Error(
      `quality repository identity mismatch: expected ${manifest.repo.realpath}, got ${actualRoot}`,
    );
  }
  if (gitCommonDir(actualRoot) !== manifest.repo.gitCommonDir) {
    throw new Error("quality git common-dir identity mismatch");
  }
  if (originIdentity(actualRoot) !== manifest.repo.origin) {
    throw new Error("quality origin remote identity mismatch");
  }
  const currentHead = git(actualRoot, ["rev-parse", "HEAD"]);
  if (requireHead && currentHead !== manifest.revisions.currentHead) {
    if (!isEmptyStampCommit(actualRoot, manifest.revisions.currentHead)) {
      throw new Error(
        `quality revision identity mismatch: expected ${manifest.revisions.currentHead}, got ${currentHead}`,
      );
    }
  }
  // requireHead:false marks the pre-advance identity check in runAdvance()
  // (see below): HEAD may already be a rebased commit whose base-relative
  // identity is not yet proven (that's exactly what advanceHead() is about
  // to establish, recording proof in baseRebaseCarry for the post-advance
  // re-check with requireHead left at its default). Skip the base check
  // here rather than duplicating advanceHead()'s rebase-equivalence logic
  // ahead of time.
  if (!requireHead) return { actualRoot, currentHead };
  const actualBase = git(actualRoot, [
    "merge-base",
    currentHead,
    manifest.revisions.baseRef,
  ]);
  if (!baseIdentityMatches(manifest, actualRoot, currentHead, actualBase)) {
    throw new Error(
      `quality base identity mismatch: expected ${manifest.revisions.baseSha}, got ${actualBase}`,
    );
  }
  return { actualRoot, currentHead };
}

function isEmptyStampCommit(root, reviewedHead, stampHead = "HEAD") {
  try {
    const parent = git(root, ["rev-parse", `${stampHead}~1`]);
    execFileSync("git", ["diff", "--quiet", `${stampHead}~1`, stampHead], {
      cwd: root,
      stdio: "ignore",
    });
    return parent === reviewedHead;
  } catch {
    return false;
  }
}

function parseInteger(value, name, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== "");
}

function committedFile(root, head, file) {
  try {
    return git(root, ["show", `${head}:${file}`]);
  } catch {
    return null;
  }
}

function committedFileBuffer(root, head, file) {
  try {
    return execFileSync("git", ["show", `${head}:${file}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function packageManagerAt(root, head, packageJson) {
  const declared = String(packageJson.packageManager || "").split("@")[0];
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared;
  if (committedFile(root, head, "pnpm-lock.yaml") !== null) return "pnpm";
  if (committedFile(root, head, "yarn.lock") !== null) return "yarn";
  if (
    committedFile(root, head, "bun.lock") !== null ||
    committedFile(root, head, "bun.lockb") !== null
  ) {
    return "bun";
  }
  return "npm";
}

function scriptGate(name, script, manager, allowSkip = false) {
  return {
    name,
    source: `package-script:${script}`,
    command: `${manager} run ${script}`,
    executable: manager,
    args: ["run", script],
    allowSkip,
  };
}

function baselineGate(name, scripts, candidates, manager, allowSkip = false) {
  const script = candidates.find((candidate) =>
    Object.hasOwn(scripts, candidate),
  );
  if (script) return scriptGate(name, script, manager, allowSkip);
  return allowSkip
    ? {
        name,
        source: "baseline-policy",
        command: `external:${name}`,
        executable: null,
        args: [],
        allowSkip,
      }
    : null;
}

function directGate(name, source, executable, args, allowSkip = false) {
  return {
    name,
    source,
    command: [executable, ...args]
      .map((part) => JSON.stringify(part))
      .join(" "),
    executable,
    args,
    allowSkip,
  };
}

function hasPythonTool(pyproject, tool) {
  return new RegExp(`^\\s*\\[tool\\.${tool}(?:[.\\]]|$)`, "m").test(pyproject);
}

function committedFiles(root, head) {
  try {
    return git(root, ["ls-tree", "-r", "--name-only", head])
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

// Files changed between baseSha and head (diff scope), as opposed to
// committedFiles' full repo-tree-at-head scope. Used to avoid promoting a
// repo-wide-but-narrow tool (e.g. mypy for a handful of scripts/ files) into
// a required, blocking gate for a PR that never touches that surface.
function changedFiles(root, baseSha, head) {
  if (!baseSha) return null;
  try {
    // -z: NUL-delimited, unquoted paths. Without it, git quotes filenames
    // containing non-ASCII bytes (core.quotePath's default), which would
    // otherwise break a suffix check like .endsWith(".py") on a path such
    // as "café.py".
    return git(root, [
      "diff",
      "-z",
      "--name-only",
      "--no-renames",
      `${baseSha}..${head}`,
    ])
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

// Unlike lint/test/security, a repo-wide mypy requirement is a real
// environment dependency (mypy must be installed) for what may be a handful
// of scripts/ files never touched by most PRs. Only promote it to a
// required gate when the diff actually changes a .py file — a repo-wide
// requirement can still be declared explicitly via .quality-gates.json
// (handled upstream via nativeGates), which always takes precedence over
// this inference. When baseSha/diff info is unavailable (changedFiles
// returns null), fail open to the prior repo-wide behavior rather than
// silently dropping required coverage.
function diffTouchesPython(root, baseSha, head) {
  const changed = changedFiles(root, baseSha, head);
  return (
    changed === null ||
    changed.some((file) => file.endsWith(".py") || file.endsWith(".pyi"))
  );
}

function isPythonRepository(root, head, pyproject) {
  if (pyproject !== "") return true;
  return committedFiles(root, head).some(
    (file) =>
      /^requirements[^/]*\.(?:txt|in)$/.test(file) ||
      [
        "setup.py",
        "setup.cfg",
        "Pipfile",
        "Pipfile.lock",
        "poetry.lock",
        "uv.lock",
        "pytest.ini",
        "tox.ini",
      ].includes(file),
  );
}

function pythonEnvironment(root, head, pyproject) {
  if (committedFile(root, head, "uv.lock") !== null) return "uv";
  if (
    committedFile(root, head, "poetry.lock") !== null ||
    hasPythonTool(pyproject, "poetry")
  ) {
    return "poetry";
  }
  if (
    committedFile(root, head, "Pipfile") !== null ||
    committedFile(root, head, "Pipfile.lock") !== null
  ) {
    return "pipenv";
  }
  return null;
}

function pythonDirectGate({
  root,
  head,
  pyproject,
  name,
  tool,
  args,
  allowSkip,
}) {
  const environment = pythonEnvironment(root, head, pyproject);
  return environment
    ? directGate(
        name,
        `python:${tool}`,
        environment,
        ["run", tool, ...args],
        allowSkip,
      )
    : directGate(name, `python:${tool}`, tool, args, allowSkip);
}

function pythonAuditArgs(root, head, pyproject) {
  if (pyproject !== "") return ["."];
  const requirements = committedFiles(root, head).filter((file) =>
    /^requirements[^/]*\.(?:txt|in)$/.test(file),
  );
  if (requirements.length > 0) {
    return requirements.flatMap((file) => ["-r", file]);
  }
  if (
    committedFile(root, head, "Pipfile") !== null ||
    committedFile(root, head, "Pipfile.lock") !== null
  ) {
    return [];
  }
  return null;
}

function hasCommittedPythonTests(root, head) {
  return committedFiles(root, head).some((file) =>
    /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(file),
  );
}

function pythonGate({
  root,
  head,
  baseSha,
  name,
  pyproject,
  pythonRepository,
  allowSkip = false,
}) {
  if (!pythonRepository) return null;
  if (name === "lint" && hasPythonTool(pyproject, "ruff")) {
    return pythonDirectGate({
      root,
      head,
      pyproject,
      name,
      tool: "ruff",
      args: ["check", "."],
      allowSkip,
    });
  }
  if (
    name === "test" &&
    (hasPythonTool(pyproject, "pytest") ||
      committedFile(root, head, "pytest.ini") !== null ||
      committedFile(root, head, "tox.ini") !== null ||
      hasCommittedPythonTests(root, head))
  ) {
    return pythonDirectGate({
      root,
      head,
      pyproject,
      name,
      tool: "pytest",
      args: [],
      allowSkip,
    });
  }
  if (name === "security") {
    const args = pythonAuditArgs(root, head, pyproject);
    return args === null
      ? null
      : pythonDirectGate({
          root,
          head,
          pyproject,
          name,
          tool: "pip-audit",
          args,
          allowSkip,
        });
  }
  if (
    name === "type" &&
    hasPythonTool(pyproject, "mypy") &&
    diffTouchesPython(root, baseSha, head)
  ) {
    return pythonDirectGate({
      root,
      head,
      pyproject,
      name,
      tool: "mypy",
      args: ["."],
      allowSkip,
    });
  }
  return null;
}

function preferredRequiredGate({
  root,
  head,
  nativeGates,
  scripts,
  manager,
  pyproject,
  pythonRepository,
  name,
  candidates,
  allowSkip = false,
}) {
  if (nativeGates.has(name)) {
    return nativeGate(name, nativeGates.get(name), allowSkip);
  }
  return (
    baselineGate(name, scripts, candidates, manager, allowSkip) ||
    pythonGate({
      root,
      head,
      name,
      pyproject,
      pythonRepository,
      allowSkip,
    })
  );
}

function optionalBuildGate({ nativeGates, scripts, manager }) {
  if (nativeGates.has("build")) {
    return nativeGate("build", nativeGates.get("build"));
  }
  if (typeof scripts.build === "string") {
    return scriptGate("build", "build", manager);
  }
  return null;
}

function optionalTypeGate({
  root,
  head,
  baseSha,
  nativeGates,
  scripts,
  manager,
  pyproject,
  pythonRepository,
}) {
  if (nativeGates.has("type")) {
    return nativeGate("type", nativeGates.get("type"));
  }
  const typeScript = ["type-check:all", "type-check", "typecheck"].find(
    (name) => typeof scripts[name] === "string",
  );
  return typeScript
    ? scriptGate("type", typeScript, manager)
    : pythonGate({
        root,
        head,
        baseSha,
        name: "type",
        pyproject,
        pythonRepository,
      });
}

const NATIVE_GATES_FILE = ".quality-gates.json";
const HARNESS_CONFIG_FILE = "harness-config.json";
const MAX_DECLARED_GATE_TIMEOUT_SECONDS = 30 * 60;
const NATIVE_GATE_NAMES = new Set([
  "lint",
  "test",
  "security",
  "build",
  "type",
  "consumer",
  "verify-app",
]);

function nativeGate(name, definition, allowSkip = false) {
  const argv = [definition.executable, ...definition.args];
  return {
    name,
    source: `quality-gates:${NATIVE_GATES_FILE}#${name}`,
    command: argv.map((part) => JSON.stringify(part)).join(" "),
    executable: definition.executable,
    args: definition.args,
    allowSkip,
  };
}

function validateNativeGateDefinition(name, definition) {
  const invalid =
    !definition ||
    Array.isArray(definition) ||
    typeof definition !== "object" ||
    typeof definition.executable !== "string" ||
    definition.executable.trim() === "" ||
    definition.executable.includes("\0") ||
    !Array.isArray(definition.args) ||
    definition.args.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    );
  if (invalid) {
    throw new Error(
      `${NATIVE_GATES_FILE} gate '${name}' requires a non-empty executable and string args array`,
    );
  }
  const unsupported = Object.keys(definition).filter(
    (key) => !["executable", "args"].includes(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${NATIVE_GATES_FILE} gate '${name}' has unsupported fields: ${unsupported.join(", ")}`,
    );
  }
  return definition;
}

function discoverNativeGates(root, head) {
  const content = committedFile(root, head, NATIVE_GATES_FILE);
  if (content === null) return new Map();
  const policy = parseJson(content, `${NATIVE_GATES_FILE} at ${head}`);
  if (
    !policy ||
    Array.isArray(policy) ||
    policy.version !== 1 ||
    !policy.gates ||
    Array.isArray(policy.gates) ||
    typeof policy.gates !== "object"
  ) {
    throw new Error(
      `${NATIVE_GATES_FILE} must contain version 1 and a gates object`,
    );
  }

  const gates = new Map();
  for (const [name, definition] of Object.entries(policy.gates)) {
    if (!NATIVE_GATE_NAMES.has(name)) {
      throw new Error(
        `${NATIVE_GATES_FILE} declares unsupported gate '${name}'`,
      );
    }
    gates.set(name, validateNativeGateDefinition(name, definition));
  }
  return gates;
}

function declaredGateTimeouts(root, head) {
  const content = committedFile(root, head, HARNESS_CONFIG_FILE);
  if (content === null) return new Map();
  const config = parseJson(content, `${HARNESS_CONFIG_FILE} at ${head}`);
  const definitions = config?.checkDefinitions;
  if (
    !definitions ||
    Array.isArray(definitions) ||
    typeof definitions !== "object"
  ) {
    return new Map();
  }
  const timeouts = new Map();
  for (const [definitionName, definition] of Object.entries(definitions)) {
    const seconds = harnessCheckTimeoutSeconds(definitionName, definition);
    if (seconds === null) continue;
    const gateName = harnessCheckGateName(definitionName);
    if (!gateName) continue;
    timeouts.set(gateName, Math.max(timeouts.get(gateName) || 0, seconds));
  }
  return timeouts;
}

function harnessCheckGateName(name) {
  const normalized = String(name).toLowerCase();
  if (/^verify-app(?:$|[:-])/.test(normalized)) return "verify-app";
  const prefix = normalized.split(/[:-]/, 1)[0];
  return {
    lint: "lint",
    format: "lint",
    test: "test",
    security: "security",
    audit: "security",
    semgrep: "security",
    gitleaks: "security",
    build: "build",
    type: "type",
    typecheck: "type",
    consumer: "consumer",
    e2e: "verify-app",
  }[prefix];
}

function harnessCheckTimeoutSeconds(name, definition) {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    return null;
  }
  if (!Object.hasOwn(definition, "timeoutMinutes")) return null;
  const minutes = definition.timeoutMinutes;
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes * 60 > MAX_DECLARED_GATE_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `${HARNESS_CONFIG_FILE} checkDefinitions.${name}.timeoutMinutes must be an integer from 1 to 30`,
    );
  }
  return minutes * 60;
}

function discoverRequiredGates(
  root,
  options,
  head = git(root, ["rev-parse", "HEAD"]),
  baseSha = null,
) {
  const packageContent = committedFile(root, head, "package.json");
  let scripts = {};
  let packageJson = {};
  if (packageContent !== null) {
    packageJson = parseJson(packageContent, `package.json at ${head}`);
    scripts = packageJson.scripts || {};
  }
  const manager = packageManagerAt(root, head, packageJson);
  const pyproject = committedFile(root, head, "pyproject.toml") || "";
  const pythonRepository = isPythonRepository(root, head, pyproject);
  const nativeGates = discoverNativeGates(root, head);
  const gateTimeouts = declaredGateTimeouts(root, head);
  const requiredGate = (name, candidates, allowSkip = false) =>
    preferredRequiredGate({
      root,
      head,
      nativeGates,
      scripts,
      manager,
      pyproject,
      pythonRepository,
      name,
      candidates,
      allowSkip,
    });
  const required = [
    requiredGate("lint", ["lint", "lint:check"]),
    requiredGate(
      "test",
      ["test", "test:unit", "test:ci"],
      options["skip-tests"] === true,
    ),
    requiredGate("security", ["security:audit", "security:check", "security"]),
  ].filter(Boolean);
  const missing = ["lint", "security"].filter(
    (name) => !required.some((gate) => gate.name === name),
  );
  if (
    options["skip-tests"] !== true &&
    !required.some((gate) => gate.name === "test")
  ) {
    missing.push("test");
  }
  if (missing.length > 0) {
    throw new Error(
      `quality requires executable npm or Python repository gates for: ${missing.join(", ")}`,
    );
  }
  const impactGate = discoverImpactTestGate(root, options, head, baseSha);
  if (impactGate) {
    const testIndex = required.findIndex((gate) => gate.name === "test");
    required[testIndex] = impactGate;
  }
  const buildGate = optionalBuildGate({ nativeGates, scripts, manager });
  if (buildGate) required.push(buildGate);
  const typeGate = optionalTypeGate({
    root,
    head,
    baseSha,
    nativeGates,
    scripts,
    manager,
    pyproject,
    pythonRepository,
  });
  if (typeGate) required.push(typeGate);
  const consumerScript = Object.keys(scripts).find((name) =>
    /^test:consumer(?:$|[-:])/.test(name),
  );
  const consumerFixture =
    committedFile(root, head, "tests/consumer-workflow-integration.test.js") !==
    null;
  if (nativeGates.has("consumer")) {
    required.push(nativeGate("consumer", nativeGates.get("consumer")));
  } else if (consumerScript || consumerFixture) {
    required.push(
      consumerScript
        ? scriptGate("consumer", consumerScript, manager)
        : {
            name: "consumer",
            source: "fixture:tests/consumer-workflow-integration.test.js",
            command: "node tests/consumer-workflow-integration.test.js",
            executable: process.execPath,
            args: ["tests/consumer-workflow-integration.test.js"],
            allowSkip: false,
          },
    );
  }
  const verifyAppGate = discoverVerifyAppGate(options, nativeGates);
  if (verifyAppGate) required.push(verifyAppGate);
  return required.map((gate) => {
    if (
      gate.source.startsWith("test-impact:") &&
      gate.testImpactMode !== "audit"
    )
      return gate;
    const timeoutSeconds = gateTimeouts.get(gate.name);
    return timeoutSeconds ? { ...gate, timeoutSeconds } : gate;
  });
}

function discoverImpactTestGate(root, options, head, baseSha) {
  if (options["skip-tests"] === true) return null;
  const impactPolicy = committedFileBuffer(
    root,
    head,
    ".buildproven/test-impact.json",
  );
  if (impactPolicy === null) return null;
  const impactFiles = changedFiles(root, baseSha, head);
  if (impactFiles?.includes(".buildproven/test-impact.json")) return null;
  const selection = testImpact.plan(
    impactFiles || [],
    parseJson(impactPolicy.toString("utf8"), ".buildproven/test-impact.json"),
  );
  return {
    ...directGate(
      "test",
      "test-impact:.buildproven/test-impact.json",
      process.execPath,
      [
        path.join(__dirname, "test-impact.js"),
        "--execute",
        "--policy-sha256",
        crypto.createHash("sha256").update(impactPolicy).digest("hex"),
        "--",
        ...(impactFiles || []),
      ],
    ),
    testImpactMode: selection.mode,
  };
}

// Opt-in only: verify-app boots the app (dev server / binary) and drives a
// real page load, which is slow and can be flaky on a cold cache. Never
// discovered unless the caller passed --verify-app (BUI-306). A repo can
// still override the command via .quality-gates.json#verify-app. Kept as its
// own function (rather than inline in discoverRequiredGates) to stay under
// that function's complexity budget.
function discoverVerifyAppGate(options, nativeGates) {
  if (options["verify-app"] !== true) return null;
  if (nativeGates.has("verify-app")) {
    return nativeGate("verify-app", nativeGates.get("verify-app"));
  }
  const verifyAppScript = path.join(__dirname, "quality-verify-app.sh");
  return {
    name: "verify-app",
    source: `script:${verifyAppScript}`,
    command: `bash ${verifyAppScript}`,
    executable: "bash",
    args: [verifyAppScript],
    allowSkip: false,
  };
}

function unionRequiredGates(existing, discovered, replaceNames = new Set()) {
  const required = [...existing];
  for (const gate of discovered) {
    const currentIndex = required.findIndex(
      (current) => current.name === gate.name,
    );
    if (currentIndex === -1) {
      required.push(gate);
    } else if (replaceNames.has(gate.name)) {
      required[currentIndex] = gate;
    }
  }
  return required;
}

function buildProvider(options) {
  const primaryOverride = firstValue(
    options.primary,
    process.env.BS_QUALITY_PRIMARY,
    "",
  );
  const fallbackOverride = firstValue(
    options.fallback,
    process.env.BS_QUALITY_FALLBACK,
    "",
  );
  const allowedPrimary = new Set([
    undefined,
    "auto",
    "claude",
    "codex",
    "gemini",
  ]);
  const allowedFallback = new Set([
    undefined,
    "none",
    "claude",
    "codex",
    "gemini",
  ]);
  if (
    !allowedPrimary.has(primaryOverride) ||
    !allowedFallback.has(fallbackOverride) ||
    (primaryOverride !== undefined &&
      primaryOverride !== "auto" &&
      primaryOverride === fallbackOverride)
  ) {
    throw new Error(
      `invalid provider policy: primary=${primaryOverride || "<config>"} fallback=${fallbackOverride || "<config>"}`,
    );
  }
  return {
    primaryOverride,
    fallbackOverride,
    config: firstValue(
      options["provider-config"],
      process.env.BS_QUALITY_PROVIDER_CONFIG,
      "",
    ),
  };
}

function reviewArm(options, provider) {
  const explicit = firstValue(
    options["review-arm"],
    process.env.BS_QUALITY_REVIEW_ARM,
    "",
  );
  const primary = provider.primaryOverride;
  if (!explicit) return null;
  const arm = explicit;
  if (!["bespoke", "native"].includes(arm)) {
    throw new Error("review arm must be bespoke or native");
  }
  if (explicit && !primary) {
    throw new Error("an explicit review arm requires a primary provider");
  }
  if (
    (arm === "bespoke" && primary && primary !== "claude") ||
    (arm === "native" && primary === "claude")
  ) {
    throw new Error(
      `review arm '${arm}' conflicts with primary provider '${primary}'`,
    );
  }
  return arm;
}

function governorInteger(name, fallback, label, minimum = 0) {
  return parseInteger(firstValue(process.env[name], fallback), label, {
    minimum,
  });
}

function buildGovernor(head) {
  const startedAtEpoch = Math.floor(Date.now() / 1000);
  const providerDeadlineSeconds = governorInteger(
    "BS_QUALITY_MAX_PROVIDER_SECONDS",
    "3600",
    "provider deadline seconds",
    1,
  );
  const providerSecondsLimit = governorInteger(
    "BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS",
    String(15 * 60),
    "total provider seconds",
    1,
  );
  return {
    startedAtEpoch,
    executionBudgetVersion: EXECUTION_BUDGET_VERSION,
    lifecycleTTLSeconds: governorInteger(
      "BS_QUALITY_LIFECYCLE_TTL_SECONDS",
      String(24 * 60 * 60),
      "lifecycle TTL seconds",
      1,
    ),
    lastActivityAt: new Date().toISOString(),
    gateSecondsLimit: governorInteger(
      "BS_QUALITY_MAX_GATE_SECONDS",
      String(10 * 60),
      "total gate seconds",
      1,
    ),
    gateSecondsUsed: 0,
    providerSecondsLimit,
    providerSecondsLimitExplicit:
      process.env.BS_QUALITY_MAX_TOTAL_PROVIDER_SECONDS !== undefined,
    providerSecondsUsed: 0,
    activeSecondsLimit: providerDeadlineSeconds,
    activeSecondsUsed: 0,
    activeExecution: null,
    maxFixCommits: Math.min(
      1,
      governorInteger("BS_QUALITY_MAX_FIX_COMMITS", "1", "max fix commits"),
    ),
    maxReviewRounds: Math.min(
      2,
      governorInteger(
        "BS_QUALITY_MAX_REVIEW_ROUNDS",
        "2",
        "max review rounds",
        1,
      ),
    ),
    maxReviewRoundsExplicit:
      process.env.BS_QUALITY_MAX_REVIEW_ROUNDS !== undefined,
    remediationSeconds: governorInteger(
      "BS_QUALITY_MAX_REMEDIATION_SECONDS",
      "900",
      "remediation seconds",
      1,
    ),
    reReviewReserveSeconds: governorInteger(
      "BS_QUALITY_REREVIEW_RESERVE_SECONDS",
      "900",
      "re-review reserve seconds",
      1,
    ),
    roundsUsed: 0,
    authorizedAttempts: [],
    maxProviderAttempts: Math.min(
      2,
      governorInteger(
        "BS_QUALITY_MAX_PROVIDER_ATTEMPTS",
        "2",
        "max provider attempts",
        1,
      ),
    ),
    providerWindowSeconds: providerDeadlineSeconds,
    providerAttempts: [],
    campaignSeconds: providerDeadlineSeconds,
    remediationStartedAtEpoch: null,
    findingsSeen: [],
    startCommitSha: head,
  };
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new Error(
        `unexpected positional argument '${token}'; use --pr <number> explicitly`,
      );
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);
    if (
      [
        "--merge",
        "--skip-tests",
        "--skip",
        "--advisory",
        "--exempt",
        "--incomplete",
        "--verify-app",
        "--read",
        "--allow-exhausted-review",
      ].includes(name)
    ) {
      if (inlineValue !== null && !["true", "false"].includes(inlineValue)) {
        throw new Error(`${name} accepts only true or false`);
      }
      if (name === "--merge" && inlineValue === "false") {
        throw new Error("--merge=false is invalid; omit --merge instead");
      }
      options[name.slice(2)] = inlineValue === null || inlineValue === "true";
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    options[name.slice(2)] = value;
  }
  return options;
}

function deliveryClaim(options) {
  const claim = firstValue(options["delivery-claim"], "contract");
  if (!DELIVERY_CLAIMS.has(claim)) {
    throw new Error(`invalid delivery claim '${claim}'`);
  }
  return claim;
}

function deliveryEvidenceDigest(root, value) {
  if (!value) return null;
  const file = path.resolve(root, value);
  let body;
  try {
    body = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`delivery evidence cannot be read: ${error.message}`, {
      cause: error,
    });
  }
  return crypto.createHash("sha256").update(body).digest("hex");
}

function initialDeliveryEvidenceBinding(root, head, value) {
  return value
    ? { head, sha256: deliveryEvidenceDigest(root, value), history: [] }
    : null;
}

function executableScope(options) {
  const scope = firstValue(options.scope, "branch");
  if (scope !== "branch") {
    throw new Error(
      `quality scope '${scope}' is not executable; only revision-bound branch scope is supported`,
    );
  }
  return scope;
}

function resolvePrIdentity(options) {
  const pr =
    options.pr === undefined
      ? null
      : parseInteger(options.pr, "pr", { minimum: 1 });
  const githubRepository = firstValue(options["github-repo"], null);
  const githubRepositoryId = firstValue(options["github-repository-id"], null);
  const headRefName = firstValue(options["head-ref"], null);
  const headRepository = firstValue(options["head-repository"], null);
  const crossRepositoryValue = options["cross-repository"];
  const isCrossRepository =
    crossRepositoryValue === "true"
      ? true
      : crossRepositoryValue === "false"
        ? false
        : null;
  if (
    pr !== null &&
    (!githubRepository ||
      !headRefName ||
      !headRepository ||
      isCrossRepository === null)
  ) {
    throw new Error(
      "PR manifests require base/head repository, head ref, and cross-repository identity",
    );
  }
  if (
    pr !== null &&
    isCrossRepository !== (githubRepository !== headRepository)
  ) {
    throw new Error("PR cross-repository identity is inconsistent");
  }
  if (isCrossRepository === true) {
    throw new Error(
      "cross-repository quality requires trusted CI evidence ingestion and is not yet supported",
    );
  }
  return {
    pr,
    githubRepository,
    githubRepositoryId,
    headRefName,
    headRepository,
    isCrossRepository,
  };
}

function identityWithoutProvider(identity) {
  const result = { ...identity };
  delete result.provider;
  return result;
}

function manifestIdentity(manifest) {
  return {
    executionBudgetVersion: manifest.governor?.executionBudgetVersion ?? 0,
    runtimePlanVersion: manifest.runtimePlanVersion ?? 1,
    root: manifest.repo.realpath,
    gitCommonDir: manifest.repo.gitCommonDir,
    origin: manifest.repo.origin,
    pr: manifest.repo.pr,
    githubRepository: manifest.repo.githubRepository,
    githubRepositoryId: manifest.repo.githubRepositoryId,
    headRefName: manifest.repo.headRefName,
    headRepository: manifest.repo.headRepository,
    isCrossRepository: manifest.repo.isCrossRepository,
    baseRef: manifest.revisions.baseRef,
    baseSha: manifest.revisions.baseSha,
    baseHeadSha: manifest.revisions.baseHeadSha,
    head: manifest.revisions.currentHead,
    options: manifest.options,
    provider: {
      primaryOverride: manifest.provider?.primaryOverride,
      fallbackOverride: manifest.provider?.fallbackOverride,
      config: manifest.provider?.config,
    },
  };
}

function gateRequirementsDigest(requiredGates) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(requiredGates)))
    .digest("hex");
}

function gateEvidenceDigest(gates) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(gates)))
    .digest("hex");
}

function carryableGate(manifest, gate) {
  const required = manifest.requiredGates.find(
    (candidate) => candidate.name === gate.name,
  );
  if (!required || gate.policyDigest !== gateRequirementsDigest([required])) {
    return false;
  }
  if (gate.name === "test") return validTestGate(manifest, gate);
  return (
    gate.status === "success" &&
    gateMatchesRequirement(gate, required) &&
    validGateArtifact(gate)
  );
}

function gateEvidenceCarryEligible(manifest) {
  const current = manifest.gates.filter(
    (gate) => gate.head === manifest.revisions.currentHead,
  );
  return manifest.requiredGates.every((required) => {
    const gate = current.find((candidate) => candidate.name === required.name);
    return gate ? carryableGate(manifest, gate) : false;
  });
}

function canFailOverProvider(existing, existingIdentity, campaignIdentity) {
  const sameWork =
    JSON.stringify(canonicalJson(identityWithoutProvider(existingIdentity))) ===
    JSON.stringify(canonicalJson(identityWithoutProvider(campaignIdentity)));
  const attemptedProvider = Array.isArray(existing.governor?.providerAttempts)
    ? existing.governor.providerAttempts.length > 0
    : false;
  return (
    sameWork &&
    existing.options?.reviewArm === null &&
    campaignIdentity.options?.reviewArm === null &&
    Array.isArray(existing.reviews) &&
    existing.reviews.length === 0 &&
    existing.governor?.activeExecution === null &&
    attemptedProvider
  );
}

function sameWorkIgnoringReviewArm(existingIdentity, campaignIdentity) {
  const left = {
    ...identityWithoutProvider(existingIdentity),
    options: { ...existingIdentity.options },
  };
  const right = {
    ...identityWithoutProvider(campaignIdentity),
    options: { ...campaignIdentity.options },
  };
  delete left.options.reviewArm;
  delete right.options.reviewArm;
  return (
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
  );
}

function supersedingManifest(
  existingPath,
  existing,
  campaignIdentity,
  reason,
  transition,
) {
  const upgradeKey = {
    campaign: campaignIdentity,
    [transition]: existing.invocationId,
  };
  const invocationId = deterministicInvocationId(upgradeKey);
  const stateRoot = path.join(
    qualityTmpRoot(),
    "bs-quality",
    repoKey(campaignIdentity.root),
    `pr-${campaignIdentity.pr ?? "none"}`,
    campaignIdentity.baseSha,
    invocationId,
  );
  const manifestPath = path.join(stateRoot, "invocation.json");
  if (fs.existsSync(manifestPath)) return manifestPath;
  const now = new Date().toISOString();
  const carriesGateEvidence =
    transition === "providerRecoveryOf" && gateEvidenceCarryEligible(existing);
  const carriedGates = carriesGateEvidence
    ? existing.gates.filter(
        (gate) =>
          gate.head === existing.revisions.currentHead &&
          carryableGate(existing, gate),
      )
    : [];
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    reviewContractVersion: REVIEW_CONTRACT_VERSION,
    runtimePlanVersion: RUNTIME_PLAN_VERSION,
    manifestRevision: 0,
    invocationId,
    createdAt: now,
    updatedAt: now,
    stateRoot,
    options: campaignIdentity.options,
    deliveryEvidenceBinding: initialDeliveryEvidenceBinding(
      campaignIdentity.root,
      campaignIdentity.head,
      campaignIdentity.options.deliveryEvidence,
    ),
    repo: {
      realpath: campaignIdentity.root,
      key: repoKey(campaignIdentity.root),
      pr: campaignIdentity.pr,
      githubRepository: campaignIdentity.githubRepository,
      githubRepositoryId: campaignIdentity.githubRepositoryId,
      headRefName: campaignIdentity.headRefName,
      headRepository: campaignIdentity.headRepository,
      isCrossRepository: campaignIdentity.isCrossRepository,
      gitCommonDir: campaignIdentity.gitCommonDir,
      origin: campaignIdentity.origin,
    },
    revisions: {
      baseRef: campaignIdentity.baseRef,
      baseSha: campaignIdentity.baseSha,
      baseHeadSha: campaignIdentity.baseHeadSha,
      initialHead: campaignIdentity.head,
      currentHead: campaignIdentity.head,
    },
    approval: { approved: false },
    approvalTrust: null,
    approvalChallengeSha256: null,
    risk: { requestedLevel: campaignIdentity.options.level, resolved: false },
    agents: [],
    provider: campaignIdentity.provider,
    reviews: [],
    governor: buildGovernor(campaignIdentity.head),
    requiredGates: carriesGateEvidence
      ? existing.requiredGates
      : discoverRequiredGates(
          campaignIdentity.root,
          campaignIdentity.options,
          campaignIdentity.head,
          campaignIdentity.baseSha,
        ),
    requiredGatesPolicyVersion: REQUIRED_GATES_POLICY_VERSION,
    gates: carriedGates,
    ...(carriesGateEvidence
      ? {
          gateEvidenceCarry: {
            sourceInvocationId: existing.invocationId,
            sourceManifestPath: existingPath,
            head: existing.revisions.currentHead,
            requiredGatesDigest: gateRequirementsDigest(existing.requiredGates),
            gatesDigest: gateEvidenceDigest(carriedGates),
          },
        }
      : {}),
    supersedes: {
      invocationId: existing.invocationId,
      manifestPath: existingPath,
      reason,
      at: now,
    },
    ...(transition === "environmentRecoveryOf"
      ? {
          environmentRecovery: {
            reason,
            rootInvocationId:
              existing.environmentRecovery?.rootInvocationId ??
              existing.invocationId,
            generation: (existing.environmentRecovery?.generation ?? 0) + 1,
          },
        }
      : {}),
  };
  if (!atomicCreate(manifestPath, manifest)) return manifestPath;
  const lease = require("./quality-repo-lease");
  const credential =
    existing.options?.merge === true
      ? lease.acquire(existingPath, { waitMs: 0 })
      : null;
  const previousToken = process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
  if (credential)
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = credential.token;
  try {
    withManifestLock(existingPath, (locked) => {
      if (locked.supersededBy) return;
      locked.supersededBy = { invocationId, manifestPath, reason, at: now };
      if (
        transition === "environmentRecoveryOf" &&
        reason === "bootstrap environment lacked the required gate executable"
      ) {
        // Mark the predecessor as recovered too. The successor carries its
        // own evidence, while this write-once marker prevents a repeated
        // create of the original deterministic identity from minting another
        // environment replacement when the dependency is still absent.
        locked.environmentRecovery ??= {
          reason,
          supersededBy: invocationId,
        };
      }
    });
  } finally {
    if (credential) lease.release(existingPath, credential.token, "superseded");
    if (previousToken === undefined)
      delete process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN;
    else process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN = previousToken;
  }
  return manifestPath;
}

// This is deliberately restricted to failures before any quality evidence was
// produced. A missing executable (normally an uninstalled lockfile dependency)
// or a gate started before the risk contract existed is an orchestration
// prerequisite, not a code verdict; once repaired, the exact same revision
// needs a new immutable packet. It must not reopen a real gate failure, a
// correctly budgeted timeout, a provider run, or a campaign with findings.
function environmentRecoveryEligibility(
  existing,
  existingIdentity,
  campaignIdentity,
) {
  if (
    JSON.stringify(canonicalJson(existingIdentity)) !==
    JSON.stringify(canonicalJson(campaignIdentity))
  )
    return null;
  if (existing.terminalState?.state !== "blocked") return null;
  if (existing.environmentRecovery) return null;
  // One predecessor may receive one immutable replacement. Once the
  // predecessor is linked to that replacement, refuse to mint another
  // environment campaign for the same deterministic identity. A permanently
  // missing executable must remain a visible blocked condition, not become an
  // unbounded chain that discards the failure evidence on every retry.
  if (existing.supersededBy?.invocationId) return null;
  if (!/^gate:[A-Za-z0-9_-]+$/.test(existing.terminalState?.detail || ""))
    return null;
  if ((existing.reviews || []).length !== 0) return null;
  if ((existing.governor?.providerAttempts || []).length !== 0) return null;
  // Recovery is valid only before any other gate evidence exists. This keeps
  // a later missing executable from discarding an earlier passing gate if gate
  // execution ever becomes parallel or reordered.
  if ((existing.gates || []).length !== 1) return null;
  if (existing.gates[0].head !== existing.revisions?.currentHead) return null;
  const failed = (existing.gates || []).filter(
    (gate) => gate.status === "failed",
  );
  if (failed.length === 1 && failed[0].failureCode === "missing-executable") {
    return "bootstrap environment lacked the required gate executable";
  }
  const timedOut = (existing.gates || []).filter(
    (gate) => gate.status === "timeout",
  );
  if (
    existing.risk?.resolved !== true &&
    timedOut.length === 1 &&
    timedOut[0].failureCode === "unresolved-risk-timeout"
  ) {
    return "gate execution began before its risk contract was resolved";
  }
  return null;
}

function providerRecoveryProviders(manifest) {
  const inherited = manifest.providerRecovery?.attemptedProviders || [];
  const started = manifest.governor?.providerAttempts || [];
  const failed = manifest.reviews || [];
  return new Set(
    [
      ...inherited,
      ...started.map((attempt) => attempt.provider),
      ...failed.map((review) => review.failedProvider),
    ].filter(Boolean),
  );
}

// A provider outage is not a code verdict.  After the ordinary primary plus
// fallback and their one bounded retry have all produced only unavailable,
// quota, or billing evidence, permit one *different* installed provider to
// review the same exact head.  This is not a general rerun: every old provider
// is carried forward as spent, all deterministic gates run again, and a
// successor cannot introduce a fourth provider chain.
function providerRecoveryEligibility(
  existing,
  existingIdentity,
  campaignIdentity,
) {
  if (!sameWorkIgnoringReviewArm(existingIdentity, campaignIdentity))
    return null;
  if (existing.terminalState?.state !== "provider-incomplete") return null;
  if (existing.terminalState?.detail !== "retry-exhausted:provider-exhaustion")
    return null;
  if (!Array.isArray(existing.reviews) || existing.reviews.length === 0)
    return null;
  if (
    existing.reviews.some(
      (review) =>
        review.status !== "incomplete" ||
        review.failureCategory !== "provider-exhaustion" ||
        (review.leadCount || 0) !== 0,
    )
  )
    return null;
  try {
    verifyGateEvidence(existing);
  } catch {
    return null;
  }
  const attempted = providerRecoveryProviders(existing);
  const candidates = [
    campaignIdentity.provider.primaryOverride,
    campaignIdentity.provider.fallbackOverride,
  ].filter((provider) => provider && provider !== "none");
  if (
    candidates.length === 0 ||
    candidates.every((provider) => attempted.has(provider))
  )
    return null;
  if (existing.providerRecovery) return null;
  return {
    reason: "exact-head discovery exhausted its configured provider set",
    attemptedProviders: [...attempted].sort(),
  };
}

// A deliberate pre-review supersession is an orchestration interruption, not
// a quality verdict. It needs a new immutable packet: the
// old packet is terminal and cannot be resumed, while the deterministic
// identity otherwise resolves every fresh bootstrap back to that terminal
// packet. This is intentionally narrower than a generic rerun. Once a review,
// provider attempt, or failed gate exists, replacing the packet would let an
// operator discard adverse evidence by labelling the campaign "superseded".
function supersededCampaignRecoveryEligibility(
  existing,
  existingIdentity,
  campaignIdentity,
) {
  if (
    JSON.stringify(canonicalJson(existingIdentity)) !==
    JSON.stringify(canonicalJson(campaignIdentity))
  )
    return null;
  if (existing.terminalState?.state !== "superseded") return null;
  if (existing.supersededBy?.invocationId) return null;
  if ((existing.reviews || []).length !== 0) return null;
  if ((existing.governor?.providerAttempts || []).length !== 0) return null;
  if ((existing.gates || []).some((gate) => gate.status !== "success"))
    return null;
  return "explicit resume after superseded campaign";
}

// A host signal is neither a passing result nor a code verdict. The bounded
// runner reports its conventional 128+signal status, which the gate executor
// records distinctly from ordinary gate failure. A replacement packet is safe
// only before a provider or reviewer has produced evidence, and only when
// every other recorded gate passed at the same head.
function interruptedGateRecoveryEligibility(
  existing,
  existingIdentity,
  campaignIdentity,
) {
  if (
    JSON.stringify(canonicalJson(existingIdentity)) !==
    JSON.stringify(canonicalJson(campaignIdentity))
  )
    return null;
  if (existing.terminalState?.state !== "interrupted") return null;
  if (existing.supersededBy?.invocationId) return null;
  if ((existing.reviews || []).length !== 0) return null;
  if ((existing.governor?.providerAttempts || []).length !== 0) return null;
  const gates = existing.gates || [];
  const interrupted = gates.filter(
    (gate) =>
      gate.status === "failed" && gate.failureCode === "signal-interrupted",
  );
  if (interrupted.length !== 1) return null;
  if (
    gates.some((gate) => gate.status !== "success" && gate !== interrupted[0])
  )
    return null;
  return "gate execution was interrupted by a host signal";
}

function providerRecoveryManifest(
  existingPath,
  existing,
  campaignIdentity,
  recovery,
) {
  const manifestPath = supersedingManifest(
    existingPath,
    existing,
    campaignIdentity,
    recovery.reason,
    "providerRecoveryOf",
  );
  withManifestLock(manifestPath, (locked) => {
    locked.providerRecovery ??= {
      attemptedProviders: recovery.attemptedProviders,
    };
  });
  return manifestPath;
}

function supersededCampaignSuccessor(
  manifestPath,
  existing,
  supersessionChain,
) {
  if (
    existing.terminalState?.state !== "superseded" ||
    !existing.supersededBy?.manifestPath
  )
    return null;
  const successorPath = existing.supersededBy.manifestPath;
  if (supersessionChain.has(successorPath)) {
    throw new Error("deterministic quality campaign identity collision");
  }
  const successor = loadManifest(successorPath);
  if (
    successor.manifest.supersedes?.invocationId !== existing.invocationId ||
    successor.manifest.supersedes?.manifestPath !== manifestPath
  ) {
    throw new Error("deterministic quality campaign identity collision");
  }
  const nextChain = new Set(supersessionChain);
  nextChain.add(manifestPath);
  return { manifestPath: successor.manifestPath, supersessionChain: nextChain };
}

function existingCampaign(
  manifestPath,
  campaignIdentity,
  supersessionChain = new Set(),
) {
  const existing = loadManifest(manifestPath).manifest;
  const existingIdentity = manifestIdentity(existing);
  // Fresh bootstraps always resolve the original deterministic path. When an
  // eligible pre-review campaign has already been superseded, follow its
  // immutable successor link instead of returning the terminal predecessor.
  // Validate the reciprocal link and reject a cycle so a local manifest edit
  // cannot turn a resume into an unbounded traversal or an unrelated packet.
  const successor = supersededCampaignSuccessor(
    manifestPath,
    existing,
    supersessionChain,
  );
  if (successor) {
    return existingCampaign(
      successor.manifestPath,
      campaignIdentity,
      successor.supersessionChain,
    );
  }
  const environmentReason = environmentRecoveryEligibility(
    existing,
    existingIdentity,
    campaignIdentity,
  );
  if (environmentReason) {
    const recovered = supersedingManifest(
      manifestPath,
      existing,
      campaignIdentity,
      environmentReason,
      "environmentRecoveryOf",
    );
    withManifestLock(recovered, (locked) => {
      locked.environmentRecovery ??= { reason: environmentReason };
    });
    return recovered;
  }
  const providerRecovery = providerRecoveryEligibility(
    existing,
    existingIdentity,
    campaignIdentity,
  );
  if (providerRecovery) {
    return providerRecoveryManifest(
      manifestPath,
      existing,
      campaignIdentity,
      providerRecovery,
    );
  }
  const interruptedGateRecovery = interruptedGateRecoveryEligibility(
    existing,
    existingIdentity,
    campaignIdentity,
  );
  if (interruptedGateRecovery) {
    return supersedingManifest(
      manifestPath,
      existing,
      campaignIdentity,
      interruptedGateRecovery,
      "interruptedGateRecoveryOf",
    );
  }
  const supersededRecovery = supersededCampaignRecoveryEligibility(
    existing,
    existingIdentity,
    campaignIdentity,
  );
  if (supersededRecovery) {
    return supersedingManifest(
      manifestPath,
      existing,
      campaignIdentity,
      supersededRecovery,
      "supersededCampaign",
    );
  }
  if (existing.environmentRecovery?.supersededBy) {
    throw new Error("deterministic quality campaign identity collision");
  }
  if (
    JSON.stringify(canonicalJson(existingIdentity)) !==
    JSON.stringify(canonicalJson(campaignIdentity))
  ) {
    if (!canFailOverProvider(existing, existingIdentity, campaignIdentity)) {
      throw new Error("deterministic quality campaign identity collision");
    }
    withManifestLock(manifestPath, (locked) => {
      if (
        !canFailOverProvider(locked, manifestIdentity(locked), campaignIdentity)
      ) {
        throw new Error("deterministic quality campaign identity collision");
      }
      const previous = {
        primaryOverride: locked.provider?.primaryOverride || "",
        fallbackOverride: locked.provider?.fallbackOverride || "",
        config: locked.provider?.config || "",
      };
      locked.provider = {
        ...campaignIdentity.provider,
        transitions: [
          ...(locked.provider?.transitions || []),
          {
            from: previous,
            to: campaignIdentity.provider,
            at: new Date().toISOString(),
          },
        ],
      };
    });
  }
  return manifestPath;
}

function createManifest(options) {
  const root = canonicalRoot(firstValue(options.repo, process.cwd()));
  const baseRef = firstValue(options["base-ref"], "origin/main");
  const head = git(root, ["rev-parse", "HEAD"]);
  const baseSha = git(root, ["merge-base", head, baseRef]);
  const {
    pr,
    githubRepository,
    githubRepositoryId,
    headRefName,
    headRepository,
    isCrossRepository,
  } = resolvePrIdentity(options);
  const scope = executableScope(options);
  if (options.manifest !== undefined) {
    throw new Error("create does not accept a custom manifest path");
  }
  const baseHeadSha = firstValue(options["base-head-sha"], baseSha);
  const provider = buildProvider(options);
  const deliveryEvidence = options["delivery-evidence"] || null;
  const deliveryEvidenceBinding = initialDeliveryEvidenceBinding(
    root,
    head,
    deliveryEvidence,
  );
  const manifestOptions = {
    merge: options.merge === true,
    level: firstValue(options.level, "auto"),
    scope,
    skipTests: options["skip-tests"] === true,
    verifyApp: options["verify-app"] === true,
    reviewArm: reviewArm(options, provider),
    deliveryClaim: deliveryClaim(options),
    productPrd: options["product-prd"] || null,
    productTasks: options["product-tasks"] || null,
    deliveryEvidence,
  };
  const campaignIdentity = {
    executionBudgetVersion: EXECUTION_BUDGET_VERSION,
    runtimePlanVersion: RUNTIME_PLAN_VERSION,
    root,
    gitCommonDir: gitCommonDir(root),
    origin: originIdentity(root),
    pr,
    githubRepository,
    githubRepositoryId,
    headRefName,
    headRepository,
    isCrossRepository,
    baseRef,
    baseSha,
    baseHeadSha,
    head,
    options: manifestOptions,
    provider,
  };
  // Provider policy is part of the immutable campaign identity, but not its
  // deterministic key. A caller cannot create a fresh budget merely by
  // swapping primary/fallback order for the same exact work: it resolves to
  // the existing campaign path and fails the identity comparison below.
  const campaignKeyIdentity = { ...campaignIdentity };
  delete campaignKeyIdentity.provider;
  delete campaignKeyIdentity.root;
  delete campaignKeyIdentity.gitCommonDir;
  campaignKeyIdentity.options = { ...campaignKeyIdentity.options };
  delete campaignKeyIdentity.options.reviewArm;
  const invocationId = deterministicInvocationId(campaignKeyIdentity);
  if (
    options["invocation-id"] !== undefined &&
    options["invocation-id"] !== invocationId
  ) {
    throw new Error(
      "invocation-id is deterministic for this campaign and cannot be overridden",
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      invocationId,
    )
  ) {
    throw new Error("invocation-id must be a UUID");
  }
  const stateRoot = path.join(
    qualityTmpRoot(),
    "bs-quality",
    repoKey(root),
    `pr-${pr ?? "none"}`,
    baseSha,
    invocationId,
  );
  const manifestPath = path.join(stateRoot, "invocation.json");
  if (fs.existsSync(manifestPath)) {
    return existingCampaign(manifestPath, campaignIdentity);
  }
  const now = new Date().toISOString();
  const key = repoKey(root);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    reviewContractVersion: REVIEW_CONTRACT_VERSION,
    runtimePlanVersion: RUNTIME_PLAN_VERSION,
    manifestRevision: 0,
    invocationId,
    createdAt: now,
    updatedAt: now,
    stateRoot,
    options: manifestOptions,
    deliveryEvidenceBinding,
    repo: {
      realpath: root,
      key,
      pr,
      githubRepository,
      githubRepositoryId,
      headRefName,
      headRepository,
      isCrossRepository,
      gitCommonDir: gitCommonDir(root),
      origin: originIdentity(root),
    },
    revisions: {
      baseRef,
      baseSha,
      baseHeadSha,
      initialHead: head,
      currentHead: head,
    },
    approval: { approved: false },
    approvalTrust: null,
    approvalChallengeSha256: null,
    risk: {
      requestedLevel: firstValue(options.level, "auto"),
      resolved: false,
    },
    agents: [],
    provider,
    reviews: [],
    governor: buildGovernor(head),
    requiredGates: discoverRequiredGates(root, options, head, baseSha),
    requiredGatesPolicyVersion: REQUIRED_GATES_POLICY_VERSION,
    gates: [],
  };
  return atomicCreate(manifestPath, manifest)
    ? manifestPath
    : existingCampaign(manifestPath, campaignIdentity);
}

function strongerReviewForCurrentHead(manifest, root) {
  if (manifest.risk?.resolved !== true) return null;
  const config = riskScore.loadConfig(root);
  const rescored = riskScore.score({
    base: manifest.revisions.baseRef,
    repoRoot: root,
    gitRunner: (args) => git(root, args),
    config,
    taskType: manifest.risk.taskType || "unknown",
  });
  const minimumScore = {
    medium: 20,
    high: 50,
    critical: riskScore.CRITICAL_RISK_SCORE,
    95: 50,
    98: riskScore.CRITICAL_RISK_SCORE,
  }[manifest.risk.requestedLevel];
  const rescoredRisk = Number.isFinite(rescored.riskScore)
    ? rescored.riskScore
    : 100;
  const effectiveScore = Math.max(rescoredRisk, minimumScore || 0);
  const requiredKnobs = riskScore.scoreToKnobs(effectiveScore, config);
  const tierForScore = (score) => {
    if (score >= riskScore.CRITICAL_RISK_SCORE) return "critical";
    if (score >= 50) return "high";
    if (score >= 20) return "medium";
    return "low";
  };
  const tierRank = { low: 0, medium: 1, high: 2, critical: 3 };
  const codexRank = { skip: 0, low: 0, medium: 1, high: 2, xhigh: 3 };
  const nextTier = tierForScore(effectiveScore);
  const stronger =
    tierRank[nextTier] > tierRank[manifest.risk.tier] ||
    requiredKnobs.agents > manifest.risk.agentTarget ||
    (codexRank[requiredKnobs.codex] ?? -1) >
      (codexRank[manifest.risk.codexDepth] ?? -1) ||
    requiredKnobs.codexRounds > manifest.risk.codexRounds;
  return stronger ? { ...requiredKnobs, tier: nextTier } : null;
}

function assertCurrentReviewStrength(manifest, root) {
  if (
    (manifest.reviewContractVersion || 1) >= 2 &&
    manifest.risk.reviewPolicy &&
    manifest.risk.reviewPolicyDigest !==
      reviewPolicyDigest(buildReviewPolicy(manifest))
  ) {
    throw new Error(
      "review policy changed after risk resolution; start a fresh invocation",
    );
  }
  const stronger = strongerReviewForCurrentHead(manifest, root);
  if (!stronger) return;
  throw new Error(
    `quality resume requires stronger review at HEAD ${manifest.revisions.currentHead} ` +
      `(was ${manifest.risk.tier}/${manifest.risk.agentTarget}/${manifest.risk.codexDepth}, ` +
      `now ${stronger.tier}/${stronger.agents}/${stronger.codex}); start a fresh invocation`,
  );
}

// A real rebase rewrites commits, so nextHead is typically NOT a descendant
// of priorHead even when the reviewed diff is unchanged (only the base
// moved). The exact binary patch reviewed at priorHead must replay onto the
// new base to the rebased head's exact tree; anything weaker is not a carry.
function isRebaseOnlyReplay(manifest, root, priorHead) {
  const baseRef = manifest.revisions.baseRef;
  let priorBase, freshBaseSha;
  try {
    const carried = manifest.revisions.baseRebaseCarry;
    // A remediation/fix commit may be a normal descendant of a previously
    // carried rebase. Its next rebase must still use that carried base, not
    // the immutable campaign-creation base.
    priorBase =
      carried && isAncestorOf(root, carried.head, priorHead)
        ? carried.baseSha
        : manifest.revisions.baseSha;
    freshBaseSha = baseRef && git(root, ["merge-base", "HEAD", baseRef]);
  } catch {
    return null;
  }
  const expectedTree =
    priorBase &&
    freshBaseSha &&
    replayedTree(root, priorBase, priorHead, freshBaseSha);
  const actualTree = git(root, ["rev-parse", "HEAD^{tree}"]);
  if (!expectedTree || expectedTree !== actualTree) return null;
  return { priorBase, freshBaseSha, expectedTree, actualTree };
}

// Persist proof that baseSha (immutable — it namespaces stateRoot and
// anchors review-trailer provenance, so it is never reassigned) no longer
// reflects the live base, but nextHead's diff against the fresh live base
// is provably identical to what was already reviewed. baseSha permanently
// mismatches actualBase from this point on (rebase moves the merge-base
// forever), so validateIdentity() anchors trust on this record's own
// baseSha/head instead. A later normal descendant of nextHead (the
// isAncestor branch on the next advance call) must NOT clear this record —
// it still correctly names the reconciled live base for the whole
// descendant chain.
function recordBaseRebaseCarry(manifest, priorHead, nextHead, replay) {
  const { priorBase, freshBaseSha, expectedTree, actualTree } = replay;
  manifest.revisions.baseRebaseCarry = {
    head: nextHead,
    baseSha: freshBaseSha,
    priorHead,
    priorBaseSha: priorBase,
    expectedTree,
    actualTree,
    recordedAt: new Date().toISOString(),
  };
  const reviewCarry = {
    reviewedHead: priorHead,
    head: nextHead,
    baseSha: freshBaseSha,
    priorBaseSha: priorBase,
    expectedTree,
    actualTree,
    recordedAt: new Date().toISOString(),
  };
  // A train member can be rebased repeatedly as earlier members land. Keep
  // every exact replay proof so review coverage can traverse from the
  // original provider-reviewed HEAD to the current head.
  const priorCarries = Array.isArray(manifest.revisions.reviewRebaseCarries)
    ? manifest.revisions.reviewRebaseCarries
    : manifest.revisions.reviewRebaseCarry
      ? [manifest.revisions.reviewRebaseCarry]
      : [];
  manifest.revisions.reviewRebaseCarries = [...priorCarries, reviewCarry];
  // Compatibility pointer for consumers that only need the latest carry.
  manifest.revisions.reviewRebaseCarry = reviewCarry;
  // baseHeadSha (unlike baseSha) does not namespace stateRoot or anchor
  // trailer provenance — it exists solely so quality-authorize-merge.sh can
  // do a final live-freshness check at merge time. Advance it with the
  // rebase so that check compares against the base this rebase actually
  // reconciled onto, not a base from before the rebase, which would
  // otherwise permanently mismatch and wrongly block an up-to-date merge.
  if (freshBaseSha) manifest.revisions.baseHeadSha = freshBaseSha;
}

function invalidateApproval(manifest, nextHead) {
  if (
    manifest.approval?.approved !== true ||
    manifest.approval.head === nextHead
  ) {
    return;
  }
  manifest.approval = {
    approved: false,
    invalidatedAt: new Date().toISOString(),
    reason: `HEAD advanced from ${manifest.approval.head} to ${nextHead}`,
  };
}

function supersedePriorHeadTerminal(
  manifest,
  root,
  nextHead,
  allowReplay = false,
) {
  const terminal = manifest.terminalState;
  if (
    !["blocked", "interrupted"].includes(terminal?.state) ||
    terminal.head === nextHead ||
    !/^[0-9a-f]{40}$/.test(terminal.head || "") ||
    (!allowReplay && !isAncestorOf(root, terminal.head, nextHead))
  ) {
    return false;
  }
  if (
    manifest.terminalHistory !== undefined &&
    !Array.isArray(manifest.terminalHistory)
  ) {
    throw new Error("terminal history is malformed");
  }
  const supersededAt = new Date().toISOString();
  const nextEpoch = terminalEpoch(manifest) + 1;
  manifest.terminalHistory ??= [];
  manifest.terminalHistory.push({
    ...terminal,
    disposition: "superseded-by-descendant",
    supersededAt,
    supersededByHead: nextHead,
  });
  manifest.terminalHistory.push({
    event: "reopened-by-descendant",
    head: nextHead,
    priorHead: terminal.head,
    terminalEpoch: nextEpoch,
    recordedAt: supersededAt,
  });
  manifest.terminalEpoch = nextEpoch;
  delete manifest.terminalState;
  if (manifest.merge?.admissionBlock?.head === terminal.head) {
    delete manifest.merge.admissionBlock;
  }
  return true;
}

function rearmExecutionForHead(manifest, priorHead, nextHead) {
  const governor = manifest.governor;
  if (governor.activeExecution) {
    throw new Error("cannot advance HEAD while an execution is active");
  }
  if (
    governor.headExecutionHistory !== undefined &&
    !Array.isArray(governor.headExecutionHistory)
  ) {
    throw new Error("head execution history is malformed");
  }
  governor.headExecutionHistory ??= [];
  governor.headExecutionHistory.push({
    head: priorHead,
    supersededByHead: nextHead,
    activeSecondsUsed: governor.activeSecondsUsed,
    gateSecondsUsed: governor.gateSecondsUsed,
    providerSecondsUsedAtClose: governor.providerSecondsUsed,
    closedAt: new Date().toISOString(),
  });
  // The fixed deadline is exact-HEAD scoped. A proven descendant must rerun
  // deterministic evidence with a complete active-time allowance. Provider
  // usage and attempts remain cumulative across the campaign lineage.
  governor.activeSecondsUsed = 0;
  governor.gateSecondsUsed = 0;
}

function advanceHead(manifest, root, { acceptedConditions = [] } = {}) {
  const nextHead = git(root, ["rev-parse", "HEAD"]);
  const priorHead = manifest.revisions.currentHead;
  // Revalidate even when HEAD has not moved. A manifest created by an older
  // runtime can persist a review contract that the current policy considers
  // underpowered (for example, the former 75–84 critical boundary gap).
  // Returning before this assertion would grandfather that stale contract.
  assertCurrentReviewStrength(manifest, root);
  if (nextHead === priorHead) {
    const blockedHead = manifest.terminalState?.head;
    const superseded = supersedePriorHeadTerminal(manifest, root, nextHead);
    if (superseded) {
      rearmExecutionForHead(manifest, blockedHead, nextHead);
    }
    return superseded;
  }
  const retry = incompleteRetryStatus(manifest);
  if (
    acceptedConditions.includes("review:provider-exhaustion") &&
    retry.state !== "exhausted"
  ) {
    throw new Error(
      "quality resume refused: review:provider-exhaustion is not diagnosed for the current exact head",
    );
  }
  if (retry.state !== "none") {
    const acceptedExhaustion = acceptedConditions.includes(
      "review:provider-exhaustion",
    );
    if (retry.state !== "exhausted" || !acceptedExhaustion) {
      throw new Error(
        `quality resume refused: incomplete review retry for ${retry.from}..${retry.to} is ${retry.state}`,
      );
    }
    const persistedLeadCount = manifest.reviews.reduce((sum, review) => {
      if (!Number.isInteger(review.leadCount) || review.leadCount < 0) {
        throw new Error(
          "quality resume refused: persisted review lead count is invalid",
        );
      }
      return sum + review.leadCount;
    }, 0);
    const derivedLeadCount = providerFindings(manifest).length;
    if (persistedLeadCount !== derivedLeadCount) {
      throw new Error(
        "quality resume refused: persisted review lead count does not match provider evidence",
      );
    }
    if (derivedLeadCount !== 0) {
      throw new Error(
        "quality resume refused: exhausted provider review still has unresolved code findings",
      );
    }
    manifest.revisions.exhaustedReviewAdvance = {
      acceptedCondition: "review:provider-exhaustion",
      priorFrom: retry.from,
      priorTo: retry.to,
      head: nextHead,
      recordedAt: new Date().toISOString(),
    };
  }
  const stampHead = manifest.merge?.stampHead;
  if (stampHead) {
    if (!isEmptyStampCommit(root, priorHead, stampHead)) {
      throw new Error(
        `quality persisted stamp ${stampHead} is not an empty child of reviewed HEAD ${priorHead}`,
      );
    }
    if (nextHead === stampHead) return false;
  }
  const isAncestor = isAncestorOf(root, priorHead, nextHead);
  let replay = null;
  if (!isAncestor) {
    replay = isRebaseOnlyReplay(manifest, root, priorHead);
    if (!replay) {
      throw new Error(
        `quality resume refused: ${priorHead} is not an ancestor of ${nextHead} ` +
          `and the diff is not a provable rebase-only replay`,
      );
    }
  }
  if (replay) recordBaseRebaseCarry(manifest, priorHead, nextHead, replay);
  if (manifest.gateEvidenceCarry) {
    manifest.gateEvidenceCarryHistory ??= [];
    manifest.gateEvidenceCarryHistory.push({
      ...manifest.gateEvidenceCarry,
      retiredAt: new Date().toISOString(),
      retiredHead: nextHead,
    });
    delete manifest.gateEvidenceCarry;
  }
  rearmExecutionForHead(manifest, priorHead, nextHead);
  supersedePriorHeadTerminal(manifest, root, nextHead, Boolean(replay));
  invalidateApproval(manifest, nextHead);
  const completed = completedReviews(manifest);
  const previousReview = completed.at(-1);
  const nextReviewRound = completed.length + 1;
  if (previousReview) {
    for (const authorization of manifest.governor.authorizedAttempts) {
      const reservedFor =
        authorization.reservedForReviewHead || authorization.head;
      if (
        authorization.number === nextReviewRound &&
        authorization.consumedAt === null &&
        !authorization.invalidatedAt &&
        reservedFor === previousReview.to
      ) {
        authorization.reservedForReviewHead = previousReview.to;
        authorization.advances ??= [];
        authorization.advances.push({
          from: authorization.head,
          to: nextHead,
          at: new Date().toISOString(),
        });
        authorization.head = nextHead;
      }
    }
  }
  if (stampHead) {
    manifest.merge.invalidatedStamps.push({
      head: stampHead,
      invalidatedAt: new Date().toISOString(),
      reason: `HEAD advanced beyond reviewed stamp to ${nextHead}`,
    });
    delete manifest.merge.stampHead;
    delete manifest.merge.stampedAt;
    delete manifest.merge.stampPublication;
  }
  if (manifest.options?.deliveryEvidence) {
    const priorBinding = manifest.deliveryEvidenceBinding;
    if (
      !priorBinding ||
      priorBinding.head !== priorHead ||
      !/^[0-9a-f]{64}$/.test(priorBinding.sha256 || "")
    ) {
      throw new Error(
        "delivery evidence binding is invalid for the prior HEAD",
      );
    }
    priorBinding.history ??= [];
    priorBinding.history.push({ head: priorHead, sha256: priorBinding.sha256 });
    priorBinding.head = nextHead;
    priorBinding.sha256 = deliveryEvidenceDigest(
      root,
      manifest.options.deliveryEvidence,
    );
  }
  manifest.revisions.currentHead = nextHead;
  return true;
}

function recordStamp(manifest, root, options) {
  const stampHead = options.head;
  if (!stampHead) throw new Error("record-stamp requires --head");
  const actualHead = git(root, ["rev-parse", "HEAD"]);
  if (actualHead !== stampHead) {
    throw new Error(
      `quality stamp identity mismatch: expected local HEAD ${stampHead}, got ${actualHead}`,
    );
  }
  if (!isEmptyStampCommit(root, manifest.revisions.currentHead)) {
    throw new Error("quality stamp must be an empty child of reviewed HEAD");
  }
  if (manifest.merge.stampHead && manifest.merge.stampHead !== stampHead) {
    throw new Error(
      `quality stamp is immutable: expected ${manifest.merge.stampHead}, got ${stampHead}`,
    );
  }
  manifest.merge.stampHead = stampHead;
  manifest.merge.stampedAt ??= new Date().toISOString();
  const remote = options.remote;
  const expectedOldHead = options["expected-old-head"];
  if (!remote || !expectedOldHead) {
    throw new Error("record-stamp requires remote publication identity");
  }
  manifest.merge.stampPublication ??= {
    status: "local",
    remote,
    expectedOldHead,
    recordedAt: new Date().toISOString(),
  };
  if (
    manifest.merge.stampPublication.remote !== remote ||
    manifest.merge.stampPublication.expectedOldHead !== expectedOldHead
  ) {
    throw new Error("quality stamp publication identity is immutable");
  }
}

function recordStampPublished(manifest, options) {
  const stampHead = options.head;
  const remote = options.remote;
  const previousHead = options["previous-head"];
  if (
    !stampHead ||
    manifest.merge.stampHead !== stampHead ||
    manifest.merge.stampPublication?.remote !== remote
  ) {
    throw new Error("published stamp identity does not match persisted state");
  }
  if (
    previousHead !== stampHead &&
    previousHead !== manifest.merge.stampPublication.expectedOldHead
  ) {
    throw new Error("published stamp previous-head identity mismatch");
  }
  manifest.merge.stampPublication.status = "published";
  manifest.merge.stampPublication.publishedHead = stampHead;
  manifest.merge.stampPublication.publishedAt ??= new Date().toISOString();
}

function requestedRiskMinimum(requestedLevel) {
  if (requestedLevel === "98") return "critical";
  if (requestedLevel === "95") return "high";
  return ["low", "medium", "high", "critical"].includes(requestedLevel)
    ? requestedLevel
    : "low";
}

function gateRuntimePlan(manifest, options, checkSeconds) {
  const gateCount = parseInteger(
    options["gate-count"] || String(manifest.requiredGates.length),
    "gate count",
  );
  const gateReserveSeconds = parseInteger(
    options["gate-reserve-seconds"] || String(gateCount * checkSeconds),
    "gate reserve seconds",
  );
  if (gateCount !== manifest.requiredGates.length) {
    throw new Error("runtime plan gate count does not match required gates");
  }
  const gateTimeoutSeconds = parseJson(
    options["gate-timeouts-json"] || "{}",
    "gate timeout seconds",
  );
  if (
    !gateTimeoutSeconds ||
    Array.isArray(gateTimeoutSeconds) ||
    typeof gateTimeoutSeconds !== "object" ||
    Object.entries(gateTimeoutSeconds).some(
      ([name, seconds]) =>
        !manifest.requiredGates.some((gate) => gate.name === name) ||
        !Number.isInteger(seconds) ||
        seconds < 1,
    )
  ) {
    throw new Error("runtime plan gate timeout seconds are invalid");
  }
  const declaredExtraSeconds = Object.values(gateTimeoutSeconds).reduce(
    (total, seconds) => total + Math.max(0, seconds - checkSeconds),
    0,
  );
  const expectedReserve = gateCount * checkSeconds + declaredExtraSeconds;
  if (gateReserveSeconds !== expectedReserve) {
    throw new Error("runtime plan gate reserve does not match gate count");
  }
  return { gateCount, gateReserveSeconds, gateTimeoutSeconds };
}

function buildRuntimePlan(manifest, options) {
  const checkSeconds = parseInteger(
    options["check-seconds"] || "300",
    "check seconds",
    { minimum: 1 },
  );
  const checkReserveSeconds = parseInteger(
    options["check-reserve-seconds"] || "300",
    "check reserve seconds",
    { minimum: 1 },
  );
  const gatePlan = gateRuntimePlan(manifest, options, checkSeconds);
  return {
    workload: options.workload || "unknown",
    workloadUnits: parseInteger(
      options["workload-units"] || "0",
      "workload units",
    ),
    diffFiles: parseInteger(options["diff-files"] || "0", "diff files"),
    diffLines: parseInteger(options["diff-lines"] || "0", "diff lines"),
    campaignSeconds: parseInteger(
      options["campaign-seconds"] ||
        String(manifest.governor.remediationSeconds),
      "campaign seconds",
      { minimum: 1 },
    ),
    reviewSeconds: parseInteger(
      options["review-seconds"] ||
        String(manifest.governor.providerWindowSeconds),
      "review seconds",
      { minimum: 1 },
    ),
    verificationSeconds: parseInteger(
      options["verification-seconds"] ||
        String(manifest.governor.reReviewReserveSeconds),
      "verification seconds",
      { minimum: 1 },
    ),
    checkSeconds,
    ...gatePlan,
    reviewReserveSeconds: parseInteger(
      options["review-reserve-seconds"] || "300",
      "review reserve seconds",
      { minimum: 1 },
    ),
    checkReserveSeconds,
    reviewPasses: parseInteger(
      options["codex-rounds"] || "1",
      "review passes",
      { minimum: 1 },
    ),
  };
}

function applyRuntimeGovernor(manifest, options, runtime) {
  const governor = manifest.governor;
  if (governor.maxReviewRoundsExplicit !== true) {
    governor.maxReviewRounds = parseInteger(
      options["max-review-rounds"] || "2",
      "max review rounds",
      { minimum: 1 },
    );
  }
  if (process.env.BS_QUALITY_MAX_FIX_COMMITS === undefined) {
    governor.maxFixCommits = parseInteger(
      options["max-fix-commits"] || "1",
      "max fix commits",
    );
  }
  if (process.env.BS_QUALITY_MAX_GATE_SECONDS === undefined) {
    // A campaign may validate the initial head and one permitted remediation
    // head. Each pass runs the complete required-gate suite and, at high or
    // critical risk, one mutation watchdog. Fund every pass up front so
    // advancing cannot mint time, while the per-gate watchdog and one-fix cap
    // keep execution bounded.
    const mutationSeconds = ["high", "critical"].includes(options.tier)
      ? runtime.checkSeconds + runtime.checkReserveSeconds
      : 0;
    governor.gateSecondsLimit =
      (governor.maxFixCommits + 1) *
      (runtime.gateReserveSeconds + mutationSeconds);
  }
  if (process.env.BS_QUALITY_MAX_REMEDIATION_SECONDS === undefined) {
    governor.remediationSeconds = Math.max(
      60,
      runtime.campaignSeconds -
        runtime.reviewSeconds -
        runtime.verificationSeconds,
    );
  }
  if (process.env.BS_QUALITY_REREVIEW_RESERVE_SECONDS === undefined) {
    governor.reReviewReserveSeconds = runtime.verificationSeconds;
  }
  if (process.env.BS_QUALITY_MAX_PROVIDER_SECONDS === undefined) {
    governor.providerWindowSeconds = runtime.reviewSeconds;
  }
  // Each round receives its own bounded provider-start allowance. Discovery
  // may use the selected primary and one fallback for every planned pass, plus
  // one same-range failure retry with the same primary/fallback allowance.
  // Verification independently gets the bounded primary/fallback path for its
  // single targeted pass and the same one-retry allowance. A global cap cannot
  // reserve either later phase.
  const startsPerPass = governor.maxProviderAttempts;
  const discoveryStarts = Math.max(1, runtime.reviewPasses) * startsPerPass;
  const verificationStarts = startsPerPass;
  const failureRetryStarts = discoveryStarts + verificationStarts;
  const failureRetrySeconds =
    startsPerPass *
    (runtime.reviewPasses * runtime.reviewSeconds +
      runtime.reviewReserveSeconds);
  governor.providerAttemptPlan = {
    schemaVersion: 3,
    rounds: {
      1: discoveryStarts * 2,
      2: verificationStarts * 2,
    },
    perReview: {
      1: discoveryStarts,
      2: verificationStarts,
    },
    failureRetryStarts,
    failureRetrySeconds,
  };
  governor.maxProviderAttempts = (discoveryStarts + verificationStarts) * 2;
  if (governor.providerSecondsLimitExplicit !== true) {
    // Provider execution is metered across the whole campaign. Fund the
    // primary/fallback discovery and verification paths plus one same-range
    // retry for either phase up front; otherwise attempt slots can exist while
    // the cumulative clock makes them impossible to use. Explicit operator
    // caps remain authoritative and are never expanded here.
    governor.providerSecondsLimit =
      startsPerPass *
      (runtime.reviewPasses * runtime.reviewSeconds * 2 +
        runtime.reviewReserveSeconds * 2);
  }
  governor.campaignSeconds = runtime.campaignSeconds;
  governor.activeSecondsLimit = runtime.campaignSeconds;
}

function parseMergeAuthority(value) {
  // Risk resolution always persists an explicit authority. A direct/legacy
  // caller that omits it must not mint autonomous merge authority.
  const mergeAuthority = value || "human-required";
  if (!["autonomous", "human-required"].includes(mergeAuthority)) {
    throw new Error(`invalid merge authority '${mergeAuthority}'`);
  }
  return mergeAuthority;
}

function parseProtectedNonstrictRefCas(value) {
  const policy = value || "signed-only";
  if (!["signed-only", "accept-non-atomic-pr-state"].includes(policy)) {
    throw new Error(`invalid protected non-strict ref-CAS policy '${policy}'`);
  }
  return policy;
}

function basePolicyBinding(
  manifest,
  options,
  mergeAuthority,
  protectedNonstrictRefCas,
) {
  const mergeAuthorityBaseSha = options["merge-authority-base-sha"] || null;
  const protectedNonstrictRefCasBaseSha =
    options["protected-nonstrict-ref-cas-base-sha"] || null;
  const exactBase = manifest.revisions.baseHeadSha;
  const autonomousBaseBound =
    mergeAuthority !== "autonomous" ||
    (mergeAuthorityBaseSha === exactBase &&
      /^[0-9a-f]{40}$/.test(mergeAuthorityBaseSha));
  if (!autonomousBaseBound) {
    throw new Error("merge authority must be bound to the exact base SHA");
  }
  if (
    protectedNonstrictRefCas === "accept-non-atomic-pr-state" &&
    (protectedNonstrictRefCasBaseSha !== exactBase ||
      !/^[0-9a-f]{40}$/.test(protectedNonstrictRefCasBaseSha))
  ) {
    throw new Error(
      "protected non-strict ref-CAS acceptance must be bound to the exact base SHA",
    );
  }
  return { mergeAuthorityBaseSha, protectedNonstrictRefCasBaseSha };
}

function setRisk(manifest, options) {
  const tier = options.tier;
  if (!["low", "medium", "high", "critical"].includes(tier)) {
    throw new Error(`invalid resolved tier '${tier}'`);
  }
  const tierRank = { low: 0, medium: 1, high: 2, critical: 3 };
  const requestedMinimum = requestedRiskMinimum(manifest.risk.requestedLevel);
  if (tierRank[tier] < tierRank[requestedMinimum]) {
    throw new Error(
      `resolved tier ${tier} is below requested minimum ${requestedMinimum}`,
    );
  }
  const taskType = options["task-type"] || "unknown";
  const mergeAuthority = parseMergeAuthority(options["merge-authority"]);
  const protectedNonstrictRefCas = parseProtectedNonstrictRefCas(
    options["protected-nonstrict-ref-cas"],
  );
  const { mergeAuthorityBaseSha, protectedNonstrictRefCasBaseSha } =
    basePolicyBinding(
      manifest,
      options,
      mergeAuthority,
      protectedNonstrictRefCas,
    );
  if (
    ![
      "unknown",
      "chore",
      "docs",
      "build",
      "ci",
      "feature",
      "bugfix",
      "performance",
    ].includes(taskType)
  ) {
    throw new Error(`invalid resolved task type '${taskType}'`);
  }
  const agentTarget = parseInteger(options.agents, "agent target", {
    minimum: 0,
  });
  if (agentTarget > MAX_AGENT_TARGET) {
    throw new Error(
      `agent target ${agentTarget} exceeds supported ${MAX_AGENT_TARGET}-agent panel`,
    );
  }
  const reviewPolicy = buildReviewPolicy(manifest);
  const resolved = {
    requestedLevel: manifest.risk.requestedLevel,
    resolved: true,
    tier,
    mergeAuthority,
    mergeAuthorityBaseSha,
    protectedNonstrictRefCas,
    protectedNonstrictRefCasBaseSha,
    taskType,
    score:
      options.score === undefined || options.score === ""
        ? null
        : parseInteger(options.score, "risk score"),
    agentTarget,
    codexDepth: options["codex-depth"] || "medium",
    codexRounds: parseInteger(options["codex-rounds"] || "1", "codex rounds"),
    level: options.level || manifest.options.level,
    runtime: buildRuntimePlan(manifest, options),
    reviewPolicy,
    reviewPolicyDigest: reviewPolicyDigest(reviewPolicy),
  };
  if (manifest.risk?.resolved) {
    if (JSON.stringify(manifest.risk) === JSON.stringify(resolved)) return;
    throw new Error("risk resolution is immutable once persisted");
  }
  if (manifest.reviews.length > 0) {
    throw new Error("risk resolution is immutable once persisted");
  }
  applyRuntimeGovernor(manifest, options, resolved.runtime);
  manifest.risk = resolved;
}

function panelSelectionError({ selectedAgents, target, incomplete }) {
  if (incomplete && selectedAgents >= target) {
    return "an incomplete panel must contain fewer agents than the resolved target";
  }
  if (!incomplete && selectedAgents !== target) {
    return `a complete panel must contain exactly ${target} agents; use --incomplete for a deliberate reduction`;
  }
  return null;
}

function setAgents(
  manifest,
  names,
  { incomplete = false, domain = "legacy", rule = "legacy-panel" } = {},
) {
  if (!manifest.risk?.resolved) {
    throw new Error("cannot select agents before risk resolution");
  }
  const target = manifest.risk.agentTarget;
  const selectionError = panelSelectionError({
    selectedAgents: names.length,
    target,
    incomplete,
  });
  if (selectionError) throw new Error(selectionError);
  if (
    manifest.agents.length > 0 &&
    JSON.stringify(manifest.agents) === JSON.stringify(names) &&
    Boolean(manifest.panel?.incomplete) === incomplete &&
    manifest.panel?.domain === domain &&
    manifest.panel?.rule === rule
  ) {
    return;
  }
  if (manifest.agents.length > 0 || manifest.reviews.length > 0) {
    throw new Error("quality agent selection is immutable once persisted");
  }
  manifest.agents = names;
  manifest.panel = {
    requiredAgents: target,
    selectedAgents: names.length,
    incomplete,
    domain,
    rule,
    ...((manifest.reviewContractVersion || 1) >= 2 &&
    domain !== "legacy" &&
    !rule.startsWith("legacy")
      ? { selectionHead: manifest.revisions.currentHead }
      : {}),
  };
}

function prIdentityOptions(manifest, options) {
  return {
    githubRepository: firstValue(
      options["github-repo"],
      manifest.repo.githubRepository,
      null,
    ),
    githubRepositoryId: firstValue(
      options["github-repository-id"],
      manifest.repo.githubRepositoryId,
      null,
    ),
    headRefName: firstValue(
      options["head-ref"],
      manifest.repo.headRefName,
      null,
    ),
    headRepository: firstValue(
      options["head-repository"],
      manifest.repo.headRepository,
      null,
    ),
    isCrossRepository:
      options["cross-repository"] === "true"
        ? true
        : options["cross-repository"] === "false"
          ? false
          : firstValue(manifest.repo.isCrossRepository, null),
  };
}

function prIdentityComplete(identity) {
  return Boolean(
    identity.githubRepository &&
    identity.headRefName &&
    identity.headRepository &&
    typeof identity.isCrossRepository === "boolean" &&
    identity.isCrossRepository ===
      (identity.githubRepository !== identity.headRepository),
  );
}

function bindPrRepositoryIdentity(manifest, options) {
  if (manifest.repo.pr === null) return;
  const identityOptionNames = [
    "github-repo",
    "github-repository-id",
    "head-ref",
    "head-repository",
    "cross-repository",
  ];
  const supplied = identityOptionNames.some(
    (name) => options[name] !== undefined,
  );
  if (!supplied) {
    if (prIdentityComplete(manifest.repo)) return;
    throw new Error("resumed PR repository identity is incomplete");
  }
  const identity = prIdentityOptions(manifest, options);
  if (!prIdentityComplete(identity)) {
    throw new Error("resumed PR repository identity is incomplete");
  }
  for (const [key, value] of Object.entries(identity)) {
    if (manifest.repo[key] !== null && manifest.repo[key] !== undefined) {
      if (manifest.repo[key] !== value) {
        throw new Error(`resumed PR ${key} identity mismatch`);
      }
    } else {
      manifest.repo[key] = value;
    }
  }
}

// baseSha binding: an operator-override capability is signed against the
// exact base it was diagnosed against (BUI-575 requirement 1/4). A normal
// approval's baseSha is not force-checked byte-for-byte across a legitimate
// base-rebase carry (recordBaseRebaseCarry already re-anchors trust for that
// case via headMatches/patch-id), but an override capability is stricter:
// any base drift at all — including a proven rebase-only replay — requires a
// fresh, explicit override decision rather than silently carrying forward.
function approvalBaseMatches(manifest, approval) {
  return (
    ![
      "operator-quality-override",
      "operator-ci-billing-override",
      "operator-nonstrict-refcas-override",
    ].includes(approval?.scope) ||
    approval?.baseSha === manifest.revisions.baseSha
  );
}

function approvalRecordIdentityMatches(manifest, approval) {
  const headMatches = approval?.head === manifest.revisions.currentHead;
  const expected = {
    repoKey: manifest.repo.key,
    pr: manifest.repo.pr,
    invocationId: manifest.invocationId,
  };
  return (
    headMatches &&
    approvalBaseMatches(manifest, approval) &&
    Object.entries(expected).every(([key, value]) => approval?.[key] === value)
  );
}

function approvalArtifactIntact(approval) {
  return Boolean(
    approval.artifactPath &&
    fs.existsSync(approval.artifactPath) &&
    sha256File(approval.artifactPath) === approval.artifactSha256,
  );
}

function approvalRecordValid(manifest, approval) {
  return Boolean(
    approval?.approved === true &&
    approvalRecordIdentityMatches(manifest, approval) &&
    typeof approval.approver === "string" &&
    approval.approver.trim() !== "" &&
    Date.parse(approval.expiresAt) > Date.now() &&
    approvalArtifactIntact(approval),
  );
}

function capabilitySignatureValid(manifest, artifact) {
  const pinnedKey = manifest.approvalTrust?.publicKey;
  if (typeof pinnedKey !== "string" || artifact.publicKey !== undefined) {
    return false;
  }
  return crypto.verify(
    null,
    Buffer.from(JSON.stringify(canonicalJson(artifact.payload))),
    crypto.createPublicKey({
      key: Buffer.from(pinnedKey, "base64"),
      type: "spki",
      format: "der",
    }),
    Buffer.from(artifact.signature || "", "base64"),
  );
}

// The signed payload always names the head that was actually reviewed and
// signed (approval.head), never currentHead directly — a rebase never
// re-signs. approvalRecordValid() is what proves approval.head is either
// literally currentHead, or a prior head whose patch-id equals currentHead's
// patch-id right now (rebase-only replay). An operator override's
// accepted-condition list is part of what was signed; the attached approval
// record must echo it exactly, so a capability minted for one diagnosed
// condition set can never be silently reused as authorization for a
// different one.
function approvalPayloadCoreIdentityMatches(manifest, approval, payload) {
  return (
    payload?.repoKey === manifest.repo.key &&
    payload?.pr === manifest.repo.pr &&
    payload?.head === approval.head &&
    payload?.invocationId === manifest.invocationId &&
    payload?.approver === approval.approver &&
    payload?.expiresAt === approval.expiresAt
  );
}

function approvalPayloadScopeAndConditionsMatch(approval, payload) {
  const scopeMatches =
    (payload?.scope || "standard") === (approval.scope || "standard");
  const conditionsMatch =
    JSON.stringify(payload?.acceptedConditions || []) ===
    JSON.stringify(approval.acceptedConditions || []);
  return scopeMatches && conditionsMatch;
}

function approvalPayloadIdentityMatches(manifest, approval, payload) {
  return (
    approvalPayloadCoreIdentityMatches(manifest, approval, payload) &&
    approvalPayloadScopeAndConditionsMatch(approval, payload) &&
    (approval.ciBillingEvidenceSha256 ?? null) ===
      (payload.ciBillingEvidenceSha256 || null) &&
    (approval.protectedNonstrictProtectionDigest ?? null) ===
      (payload.protectedNonstrictProtectionDigest || null) &&
    (approval.protectedNonstrictBaseSha ?? null) ===
      (payload.protectedNonstrictBaseSha || null) &&
    JSON.stringify(approval.protectedNonstrictRequiredChecks || null) ===
      JSON.stringify(payload.protectedNonstrictRequiredChecks || null)
  );
}

function approvalValid(manifest) {
  const approval = manifest.approval;
  if (!approvalRecordValid(manifest, approval)) return false;
  try {
    const artifact = parseJson(
      fs.readFileSync(approval.artifactPath, "utf8"),
      "approval capability",
    );
    const payload = artifact.payload;
    assertApprovalPayloadShape(manifest, payload);
    return (
      approvalPayloadIdentityMatches(manifest, approval, payload) &&
      capabilitySignatureValid(manifest, artifact)
    );
  } catch {
    return false;
  }
}

function ciBillingCapabilityValid(manifest) {
  if (!approvalValid(manifest)) return false;
  const scope = manifest.approval?.scope;
  const conditions = manifest.approval?.acceptedConditions;
  if (!Array.isArray(conditions)) return false;
  if (scope === "operator-ci-billing-override") {
    return conditions.length === 1 && conditions[0] === "ci:failed";
  }
  if (scope === "operator-nonstrict-refcas-override") {
    return conditions.includes("ci:failed");
  }
  return (
    scope === "operator-quality-override" && conditions.includes("ci:failed")
  );
}

function protectedNonstrictRefCasCapability(manifest) {
  if (
    !approvalValid(manifest) ||
    manifest.approval?.scope !== "operator-nonstrict-refcas-override"
  ) {
    return null;
  }
  const conditions = manifest.approval.acceptedConditions;
  const expectedLength =
    2 +
    Number(conditions.includes("ci:failed")) +
    Number(conditions.includes("review:provider-exhaustion"));
  if (
    !Array.isArray(conditions) ||
    conditions.length !== expectedLength ||
    !conditions.includes("base:protected-nonstrict") ||
    !conditions.includes("pr:non-atomic-state")
  ) {
    return null;
  }
  return {
    protectionDigest: manifest.approval.protectedNonstrictProtectionDigest,
    baseSha: manifest.approval.protectedNonstrictBaseSha,
    requiredChecks: manifest.approval.protectedNonstrictRequiredChecks,
    ciEvidenceSha256: manifest.approval.ciBillingEvidenceSha256,
  };
}

function validateApprovalPayload(payload) {
  const issuedAt = Date.parse(payload?.issuedAt);
  const expiresAt = Date.parse(payload?.expiresAt);
  const validApprover =
    typeof payload?.approver === "string" && payload.approver.trim() !== "";
  const validTimes =
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt <= Date.now() + 300_000 &&
    expiresAt > Date.now() &&
    expiresAt - issuedAt <= 86_400_000;
  if (!validApprover || !validTimes) {
    throw new Error("approval capability approver/expiry is invalid");
  }
}

// A descendant resume has to cross the terminal review-exhaustion boundary
// before the final override can be minted at the new HEAD.  The wrapper signs
// this short-lived, one-use authorization first; the advance command verifies
// it against the manifest's pinned key instead of trusting a caller-provided
// condition environment variable.  The artifact is deliberately distinct
// from the final approval capability and is invalidated by the fromHead check
// as soon as the manifest advances.
function validateDescendantAdvanceAuthorization(
  manifest,
  artifactPath,
  { head, acceptedConditions },
) {
  if (!artifactPath) {
    throw new Error(
      "exhausted review advance requires a signed operator pre-authorization",
    );
  }
  const resolvedPath = path.resolve(artifactPath);
  const expectedDirectory = path.resolve(
    path.join(manifest.stateRoot, "advance-authorizations"),
  );
  const relativePath = path.relative(expectedDirectory, resolvedPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      "exhausted review advance authorization must be inside its manifest state directory",
    );
  }
  const artifactName = path.basename(resolvedPath);
  const safeArtifactPath = path.join(expectedDirectory, artifactName);
  if (safeArtifactPath !== resolvedPath) {
    throw new Error("exhausted review advance authorization path is invalid");
  }
  let artifactRaw;
  let descriptor;
  try {
    descriptor = fs.openSync(
      safeArtifactPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(
        "exhausted review advance authorization must be a regular file",
      );
    }
    artifactRaw = fs.readFileSync(descriptor, "utf8");
  } catch {
    throw new Error("exhausted review advance authorization is missing");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const artifact = parseJson(
    artifactRaw,
    "exhausted review advance authorization",
  );
  const payload = artifact.payload;
  const expectedConditions = [...acceptedConditions];
  const payloadConditions = Array.isArray(payload?.acceptedConditions)
    ? payload.acceptedConditions
    : [];
  if (
    payload?.kind !== "quality-descendant-advance/v1" ||
    payload?.repoKey !== manifest.repo.key ||
    payload?.pr !== manifest.repo.pr ||
    payload?.invocationId !== manifest.invocationId ||
    payload?.baseSha !== manifest.revisions.baseSha ||
    payload?.fromHead !== manifest.revisions.currentHead ||
    payload?.head !== head ||
    ![
      "operator-quality-override",
      "operator-nonstrict-refcas-override",
    ].includes(payload?.scope) ||
    JSON.stringify(payloadConditions) !== JSON.stringify(expectedConditions)
  ) {
    throw new Error(
      "exhausted review advance authorization identity or conditions do not match",
    );
  }
  assertApprovalChallengeMatches(manifest, payload);
  validateApprovalPayload(payload);
  if (!capabilitySignatureValid(manifest, artifact)) {
    throw new Error(
      "exhausted review advance authorization signature is invalid",
    );
  }
  // Do not consume the artifact here.  withManifestLock() persists the
  // manifest only after this callback returns; consuming first would strand a
  // legitimate retry if a later validation fails.  The signed fromHead/head
  // identity is the replay barrier: after a successful advance the old
  // artifact can no longer match the manifest's current head, while a failed
  // mutation can safely retry the same authorization.
  return payload;
}

function assertApprovalChallengeMatches(manifest, payload) {
  const digestMatches =
    typeof payload?.challenge === "string" &&
    crypto.createHash("sha256").update(payload.challenge).digest("hex") ===
      manifest.approvalChallengeSha256;
  if (!manifest.approvalChallengeSha256 || !digestMatches) {
    throw new Error("approval capability outer-wrapper challenge mismatch");
  }
}

function assertApprovalRequiredIdentityMatches(payload, requiredIdentity) {
  for (const [key, value] of Object.entries(requiredIdentity)) {
    if (payload?.[key] !== value) {
      throw new Error(`approval capability ${key} identity mismatch`);
    }
  }
}

// An operator-override capability's signed payload must carry a non-empty
// reason and a non-empty list of accepted condition ids — this is what makes
// the attached approval an accountable, named decision rather than a blanket
// bypass (BUI-575). A standard (non-override) payload is unaffected.
function assertApprovalPayloadShape(manifest, payload) {
  if (
    payload?.scope !== "operator-quality-override" &&
    payload?.scope !== "operator-ci-billing-override" &&
    payload?.scope !== "operator-nonstrict-refcas-override"
  ) {
    return;
  }
  if (typeof payload.reason !== "string" || payload.reason.trim() === "") {
    throw new Error("operator override capability is missing --reason");
  }
  const validAcceptedConditions =
    Array.isArray(payload.acceptedConditions) &&
    payload.acceptedConditions.length > 0 &&
    payload.acceptedConditions.every((id) => typeof id === "string");
  if (!validAcceptedConditions) {
    throw new Error(
      "operator override capability is missing accepted condition ids",
    );
  }
  const hasCiBillingCondition =
    payload.acceptedConditions.includes("ci:failed");
  if (payload.scope === "operator-ci-billing-override") {
    if (
      payload.acceptedConditions.length !== 1 ||
      payload.acceptedConditions[0] !== "ci:failed"
    ) {
      throw new Error(
        "CI billing override capability must accept exactly ci:failed",
      );
    }
  } else if (payload.scope === "operator-nonstrict-refcas-override") {
    const conditions = new Set(payload.acceptedConditions);
    const expectedLength =
      2 +
      Number(conditions.has("ci:failed")) +
      Number(conditions.has("review:provider-exhaustion"));
    if (
      payload.acceptedConditions.length !== expectedLength ||
      !conditions.has("base:protected-nonstrict") ||
      !conditions.has("pr:non-atomic-state")
    ) {
      throw new Error(
        "protected non-strict ref-CAS capability must accept base:protected-nonstrict and pr:non-atomic-state, with only optional ci:failed and review:provider-exhaustion authority",
      );
    }
    if (
      !/^[a-f0-9]{64}$/.test(payload.protectedNonstrictProtectionDigest || "")
    ) {
      throw new Error(
        "protected non-strict ref-CAS capability is missing protection binding",
      );
    }
    const actionsAppId =
      require("./quality-protected-nonstrict.js").GITHUB_ACTIONS_APP_ID;
    if (
      !Array.isArray(payload.protectedNonstrictRequiredChecks) ||
      payload.protectedNonstrictRequiredChecks.length === 0 ||
      payload.protectedNonstrictRequiredChecks.some(
        (check) =>
          !check ||
          typeof check.context !== "string" ||
          check.context.length === 0 ||
          check.appId !== actionsAppId,
      )
    ) {
      throw new Error(
        "protected non-strict ref-CAS capability is missing GitHub Actions check/App bindings",
      );
    }
    if (
      payload.protectedNonstrictBaseSha !== manifest.revisions.baseHeadSha ||
      !/^[a-f0-9]{40}$/.test(payload.protectedNonstrictBaseSha || "")
    ) {
      throw new Error(
        "protected non-strict ref-CAS capability does not bind the exact base",
      );
    }
  } else if (
    hasCiBillingCondition &&
    payload.scope !== "operator-quality-override"
  ) {
    throw new Error("CI billing condition requires an operator override scope");
  }
  if (hasCiBillingCondition) {
    if (!/^[a-f0-9]{64}$/.test(payload.ciBillingEvidenceSha256 || "")) {
      throw new Error(
        "CI billing override capability is missing evidence binding",
      );
    }
    if (
      !ciBillingEvidenceBindingValid(manifest, payload.ciBillingEvidenceSha256)
    ) {
      throw new Error("CI billing waiver evidence binding is invalid");
    }
  }
}

function ciBillingEvidenceBindingValid(manifest, expectedDigest) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || "")) return false;
  try {
    const evidence = parseJson(
      fs.readFileSync(
        path.join(manifest.stateRoot, "ci-billing-waiver.json"),
        "utf8",
      ),
      "CI billing waiver evidence",
    );
    return (
      evidence.repository === manifest.repo.githubRepository &&
      evidence.head === manifest.revisions.currentHead &&
      evidence.category === "github-actions-billing-preallocation" &&
      Array.isArray(evidence.failedJobs) &&
      evidence.failedJobs.length > 0 &&
      evidenceDigestValid(evidence) &&
      evidence.evidenceSha256 === expectedDigest
    );
  } catch {
    return false;
  }
}

function attachApproval(manifest, options) {
  if (!options.artifact) {
    throw new Error("approval attachment requires --artifact");
  }
  const artifactPath = path.resolve(options.artifact);
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("approval capability must be a regular file");
  }
  const artifact = parseJson(
    fs.readFileSync(artifactPath, "utf8"),
    "approval capability",
  );
  const payload = artifact.payload;
  const requiredIdentity = {
    repoKey: manifest.repo.key,
    pr: manifest.repo.pr,
    head: manifest.revisions.currentHead,
    baseSha: manifest.revisions.baseSha,
    invocationId: manifest.invocationId,
  };
  assertApprovalChallengeMatches(manifest, payload);
  assertApprovalRequiredIdentityMatches(payload, requiredIdentity);
  assertApprovalPayloadShape(manifest, payload);
  validateApprovalPayload(payload);
  if (!capabilitySignatureValid(manifest, artifact)) {
    throw new Error("approval capability signature is invalid");
  }
  manifest.approval = {
    approved: true,
    ...requiredIdentity,
    approver: payload.approver,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    source: "outer-wrapper-capability",
    scope: payload.scope || "standard",
    reason: payload.reason || null,
    acceptedConditions: Array.isArray(payload.acceptedConditions)
      ? payload.acceptedConditions
      : [],
    ciBillingEvidenceSha256: payload.ciBillingEvidenceSha256 || null,
    protectedNonstrictProtectionDigest:
      payload.protectedNonstrictProtectionDigest || null,
    protectedNonstrictBaseSha: payload.protectedNonstrictBaseSha || null,
    protectedNonstrictRequiredChecks:
      payload.protectedNonstrictRequiredChecks || null,
    artifactPath,
    artifactSha256: sha256File(artifactPath),
    // Patch-id of the reviewed diff at approval time, cached so a later
    // rebase-only HEAD change (advanceHead()) can prove the diff is still
    // identical without re-signing. Best-effort: null if unavailable (e.g.
    // empty diff against base), in which case rebase-carry never applies.
  };
  manifest.approvalChallengeSha256 = null;
}

function armApprovalChallenge(manifest, options) {
  const challenge = options.challenge;
  const publicKey = options.publicKey;
  const supersedingHead = options.supersedingHead || null;
  if (!/^[0-9a-f]{64}$/.test(challenge || "")) {
    throw new Error("approval challenge must be a SHA-256 digest");
  }
  try {
    crypto.createPublicKey({
      key: Buffer.from(publicKey || "", "base64"),
      type: "spki",
      format: "der",
    });
  } catch {
    throw new Error("approval trust key is invalid");
  }
  const isExactDescendantSupersession =
    /^[0-9a-f]{40}$/.test(supersedingHead || "") &&
    manifest.approval?.head !== supersedingHead;
  if (
    approvalValid(manifest, manifest.repo.realpath) &&
    !isExactDescendantSupersession
  ) {
    throw new Error("cannot replace a currently valid approval capability");
  }
  manifest.approvalChallengeSha256 = challenge;
  manifest.approvalTrust = {
    publicKey,
    pinnedAt: new Date().toISOString(),
  };
}

function sharedExecutionRemaining(manifest) {
  const governor = manifest.governor;
  const limit = governor.activeSecondsLimit;
  const used = governor.activeSecondsUsed;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(used)) {
    throw new Error("shared active execution budget is missing or invalid");
  }
  return Math.max(0, limit - used);
}

function providerReserveForGate(manifest) {
  const runtime = manifest.risk?.runtime;
  if (
    !runtime ||
    runtime.workload === "unknown" ||
    manifest.risk?.agentTarget === 0
  ) {
    return 0;
  }
  // reviewSeconds is the provider watchdog ceiling, not capacity that must
  // remain idle before gates run. Reserving that whole ceiling can make a
  // healthy fixed-cost suite impossible inside the shared campaign cap (for
  // example, 540s of critical review plus 120s of verification left only
  // 240s for this repository's 5-minute suite). Keep the explicit bounded
  // review reserve plus the complete verification allowance. Discovery may
  // use any additional shared capacity that the gates do not consume.
  const reviewReserveSeconds = Number.isFinite(runtime.reviewReserveSeconds)
    ? runtime.reviewReserveSeconds
    : 0;
  const verificationSeconds = Number.isFinite(runtime.verificationSeconds)
    ? runtime.verificationSeconds
    : 0;
  const completed = completedReviews(manifest);
  if (completed.length === 0) {
    return reviewReserveSeconds + verificationSeconds;
  }
  const reviewedHead = completed.at(-1)?.to;
  return reviewedHead && reviewedHead !== manifest.revisions.currentHead
    ? verificationSeconds
    : 0;
}

function executionRemaining(manifest, kind) {
  const governor = manifest.governor;
  const limit =
    kind === "gate" ? governor.gateSecondsLimit : governor.providerSecondsLimit;
  const used =
    kind === "gate" ? governor.gateSecondsUsed : governor.providerSecondsUsed;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(used)) {
    throw new Error(`${kind} execution budget is missing or invalid`);
  }
  const sharedRemaining = sharedExecutionRemaining(manifest);
  const reserve = kind === "gate" ? providerReserveForGate(manifest) : 0;
  return Math.max(0, Math.min(limit - used, sharedRemaining - reserve));
}

function completeActiveExecution(
  manifest,
  expectedKind,
  now = Date.now(),
  measuredSeconds = null,
) {
  const active = manifest.governor.activeExecution;
  if (!active) return 0;
  if (active.kind !== expectedKind) {
    throw new Error(
      `cannot complete ${expectedKind} execution while ${active.kind} is active`,
    );
  }
  const started = Date.parse(active.startedAt);
  const measured = Number.isFinite(measuredSeconds)
    ? Math.max(1, Math.ceil(measuredSeconds))
    : Number.isFinite(started)
      ? Math.max(1, Math.ceil((now - started) / 1000))
      : active.timeoutSeconds;
  const elapsed = Math.min(active.timeoutSeconds, measured);
  if (expectedKind === "gate") {
    manifest.governor.gateSecondsUsed += elapsed;
  } else {
    manifest.governor.providerSecondsUsed += elapsed;
  }
  manifest.governor.activeSecondsUsed += elapsed;
  manifest.governor.activeExecution = null;
  manifest.governor.lastActivityAt = new Date(now).toISOString();
  return elapsed;
}

// Pure predicate, no mutation: true only if manifest.governor.activeExecution
// exists AND its deadline has already passed. Callers that need to know
// "will reconcileAbandonedExecution() actually reconcile something" without
// triggering its mutation/throw side effects (e.g. to decide whether a
// manifestPath is required before calling it) should use this instead of
// duplicating the deadline arithmetic (Codex review finding, 2026-08-01,
// medium: an activeExecution merely EXISTING is not the same as it being
// abandoned -- a still-valid in-flight execution must surface
// reconcileAbandonedExecution's own "already active" conflict error, not an
// unrelated manifestPath requirement that only applies to actual
// reconciliation).
function hasAbandonedExecution(manifest, now = Date.now()) {
  const active = manifest.governor.activeExecution;
  if (!active) return false;
  const started = Date.parse(active.startedAt);
  const deadline = started + active.timeoutSeconds * 1000;
  return Number.isFinite(deadline) && now >= deadline;
}

function reconcileAbandonedExecution(manifest, now = Date.now()) {
  const active = manifest.governor.activeExecution;
  if (!active) return;
  const started = Date.parse(active.startedAt);
  const deadline = started + active.timeoutSeconds * 1000;
  if (!Number.isFinite(deadline) || now < deadline) {
    throw new Error(
      `${active.kind} execution '${active.name}' is already active`,
    );
  }
  completeActiveExecution(manifest, active.kind, now);
}

function providerPhaseSeconds(manifest) {
  return manifest.reviews.length === 0
    ? (manifest.risk?.runtime?.reviewSeconds ??
        manifest.governor.providerWindowSeconds)
    : (manifest.risk?.runtime?.reviewReserveSeconds ?? 300);
}

function authorizeProviderRound(manifest) {
  const governor = manifest.governor;
  const round = governor.roundsUsed || 1;
  const plan = governor.providerAttemptPlan;
  if (plan === undefined) return round;
  const phaseLimit = plan.rounds?.[round];
  if (phaseLimit === undefined) {
    throw new Error(
      `provider attempt phase plan has no allowance for round ${round}`,
    );
  }
  if (!Number.isInteger(phaseLimit) || phaseLimit < 1) {
    throw new Error("provider attempt phase plan is invalid");
  }
  const head = manifest.revisions.currentHead;
  const authorization = governor.authorizedAttempts.find(
    (attempt) =>
      attempt.number === round &&
      attempt.head === head &&
      attempt.consumedAt === null &&
      !attempt.invalidatedAt,
  );
  if (!authorization)
    throw new Error("provider start was not authorized by the governor");
  const reviewCount = manifest.reviews.length;
  const generationLimit = plan.perReview?.[round] ?? phaseLimit;
  if (!Number.isInteger(generationLimit) || generationLimit < 1) {
    throw new Error("provider per-review attempt plan is invalid");
  }
  const used = governor.providerAttempts.filter(
    (attempt) =>
      attempt.round === round &&
      (plan.schemaVersion < 3 || attempt.reviewCount === reviewCount),
  ).length;
  if (used >= generationLimit) {
    throw new Error(
      `provider attempt capacity exhausted for review round ${round}`,
    );
  }
  return round;
}

function assertProviderReviewContractReady(manifest) {
  if ((manifest.reviewContractVersion || 1) < 2) return;
  const panel = manifest.panel;
  const selectionHead = panel?.selectionHead;
  const hasBoundSelection =
    manifest.risk?.resolved === true &&
    Array.isArray(manifest.agents) &&
    panel &&
    typeof panel.domain === "string" &&
    panel.domain !== "legacy" &&
    typeof panel.rule === "string" &&
    !panel.rule.startsWith("legacy") &&
    /^[0-9a-f]{40}$/.test(selectionHead || "") &&
    panel.selectedAgents === manifest.agents.length &&
    panel.requiredAgents === manifest.risk.agentTarget;
  if (!hasBoundSelection) {
    throw new Error(
      "contract v2 review lacks bound domain selection; run quality-risk-resolve and quality-select-agents before review",
    );
  }
  if (
    !isAncestorOf(
      manifest.repo.realpath,
      selectionHead,
      manifest.revisions.currentHead,
    )
  ) {
    throw new Error(
      "contract v2 review selection is not bound to the current reviewed head",
    );
  }
}

function authorizeProviderAttempt(manifest, options, manifestPath) {
  const provider = options.provider;
  if (!["claude", "codex", "gemini"].includes(provider)) {
    throw new Error(`invalid review provider '${provider}'`);
  }
  const governor = manifest.governor;
  if (manifest.revisions?.exhaustedReviewAdvance) {
    throw new Error(
      "provider review capacity remains exhausted after remediation; use an exact-head operator override or start a fresh campaign",
    );
  }
  if (
    !Number.isInteger(governor.maxProviderAttempts) ||
    !Array.isArray(governor.providerAttempts)
  ) {
    throw new Error("provider attempt governor is missing or invalid");
  }
  // Contract validation must happen before abandoned-execution reconciliation
  // or any provider-attempt append. A malformed v2 campaign must not consume
  // capacity (or mutate execution budgets) before record-review rejects it.
  assertProviderReviewContractReady(manifest);
  const hadActiveExecution = governor.activeExecution != null;
  // A single captured timestamp shared by the preflight check and the
  // reconciliation call below -- NOT two independent Date.now() calls.
  // With two separate calls, an execution that expires in the (sub-
  // millisecond but real) window between them would pass
  // hasAbandonedExecution() as "not yet abandoned" (skipping the
  // manifestPath guard) but then be reconciled anyway by
  // reconcileAbandonedExecution()'s own later Date.now(), recreating the
  // exact mutation-before-persistence-check race this guard exists to
  // prevent (Codex review finding, 2026-08-01, medium).
  const reconciliationNow = Date.now();
  if (hasAbandonedExecution(manifest, reconciliationNow)) {
    // Validate BEFORE calling reconcileAbandonedExecution(), not after:
    // that call mutates governor.activeExecution (clearing it) and credits
    // gateSecondsUsed/providerSecondsUsed in memory as a side effect. If
    // this guard ran after reconciling and a caller then caught the thrown
    // error and retried the SAME manifest object with a manifestPath, the
    // retry's hadActiveExecution would already read false (this call
    // already cleared it), so the retry would never detect "a
    // reconciliation happened" and would skip the persist entirely --
    // silently losing the reconciliation forever. Refuse to mutate state
    // we might not be able to persist in the first place (Codex review
    // finding, 2026-08-01, medium).
    //
    // manifestPath is only required when an activeExecution is actually
    // ABANDONED (deadline passed) -- not merely present -- so a caller
    // whose activeExecution is still validly in-flight gets
    // reconcileAbandonedExecution's own actionable "already active"
    // conflict error below instead of an unrelated manifestPath
    // requirement that only applies to real reconciliation (Codex review
    // finding, 2026-08-01, medium: an entry merely EXISTING was too broad
    // a trigger for this guard, masking the more useful error).
    if (typeof manifestPath !== "string" || manifestPath === "") {
      throw new Error(
        "authorizeProviderAttempt requires manifestPath to persist a reconciled execution",
      );
    }
  }
  reconcileAbandonedExecution(manifest, reconciliationNow);
  if (hadActiveExecution && governor.activeExecution == null) {
    // Same bug as executeGate's gate-budget reconciliation: if the cap
    // check below throws, that plain Error propagates out of mutate()'s
    // operation() call before saveManifest() runs, silently discarding
    // this reconciliation and re-triggering the same false exhaustion on
    // every retry. Persist it now, unconditionally.
    saveManifestMidTransaction(manifestPath, manifest);
  }
  const currentHead = manifest.revisions.currentHead;
  const round = authorizeProviderRound(manifest);
  if (governor.providerAttempts.length >= governor.maxProviderAttempts) {
    throw new Error("absolute provider attempt cap exhausted");
  }
  const remaining = executionRemaining(manifest, "provider");
  const requestedTimeout = parseInteger(
    options["requested-timeout"] || String(providerPhaseSeconds(manifest)),
    "requested provider timeout",
    { minimum: 1 },
  );
  const timeoutSeconds = Math.min(requestedTimeout, remaining);
  if (timeoutSeconds < 1) {
    if (sharedExecutionRemaining(manifest) < 1) {
      throw new Error("shared active execution budget is exhausted");
    }
    if (governor.providerSecondsUsed >= governor.providerSecondsLimit) {
      throw new Error("total provider execution budget is exhausted");
    }
    throw new Error("total provider execution budget is exhausted");
  }
  const attempt = {
    number: governor.providerAttempts.length + 1,
    provider,
    round,
    head: currentHead,
    reviewCount: manifest.reviews.length,
    startedAt: new Date().toISOString(),
    timeoutSeconds,
  };
  governor.providerAttempts.push(attempt);
  governor.activeExecution = {
    kind: "provider",
    name: provider,
    attempt: attempt.number,
    startedAt: attempt.startedAt,
    timeoutSeconds,
  };
  governor.lastActivityAt = attempt.startedAt;
  return {
    ...attempt,
    remainingSeconds: timeoutSeconds,
    maxAttempts: governor.maxProviderAttempts,
  };
}

function completeProviderAttempt(manifest, options) {
  const provider = options.provider;
  if (!manifest.governor.activeExecution) return;
  if (manifest.governor.activeExecution.name !== provider)
    throw new Error(
      `active provider execution does not belong to '${provider}'`,
    );
  const measuredSeconds =
    options["elapsed-seconds"] === undefined
      ? null
      : parseInteger(options["elapsed-seconds"], "provider elapsed seconds");
  completeActiveExecution(manifest, "provider", Date.now(), measuredSeconds);
}

function authorizeMutationAttempt(manifest, options, manifestPath) {
  if (!["high", "critical"].includes(manifest.risk?.tier)) {
    // Throws before reconcileAbandonedExecution() runs, so a stale
    // activeExecution on a non-high/critical manifest is never reconciled
    // via THIS call path -- intentional, not a gap: executeGate() (the
    // only place gates actually run) unconditionally reconciles on every
    // invocation regardless of risk tier, so it still gets cleared the
    // next time any gate runs (Codex review finding, 2026-08-01, medium:
    // confirming this ordering is safe, not a leak).
    throw new Error(
      "mutation execution is only available for high or critical campaigns",
    );
  }
  const hadActiveExecution = manifest.governor.activeExecution != null;
  // One captured timestamp for both the preflight check and reconciliation
  // -- see authorizeProviderAttempt's identical fix for why two
  // independent Date.now() calls would reopen the exact race this guard
  // exists to close (Codex review finding, 2026-08-01, medium).
  const reconciliationNow = Date.now();
  if (hasAbandonedExecution(manifest, reconciliationNow)) {
    // Validate BEFORE reconcileAbandonedExecution() mutates state, and
    // only for an actually-ABANDONED execution (not merely a present
    // one) -- see authorizeProviderAttempt's identical guard for both
    // reasons: reconciling first and only then throwing would let a
    // caught-and-retried call silently lose the reconciliation, and
    // gating on mere presence would mask reconcileAbandonedExecution's
    // own "already active" conflict error for a still-valid execution
    // (Codex review finding, 2026-08-01, medium, both rounds).
    if (typeof manifestPath !== "string" || manifestPath === "") {
      throw new Error(
        "authorizeMutationAttempt requires manifestPath to persist a reconciled execution",
      );
    }
  }
  reconcileAbandonedExecution(manifest, reconciliationNow);
  if (hadActiveExecution && manifest.governor.activeExecution == null) {
    // Same bug as executeGate's gate-budget reconciliation: if the cap
    // check below throws, that plain Error propagates out of mutate()'s
    // operation() call before saveManifest() runs, silently discarding
    // this reconciliation and re-triggering the same false exhaustion on
    // every retry. Persist it now, unconditionally.
    saveManifestMidTransaction(manifestPath, manifest);
  }
  const remaining = executionRemaining(manifest, "gate");
  const runtime = manifest.risk?.runtime;
  const requestedTimeout = parseInteger(
    options["requested-timeout"] ||
      String(
        (runtime?.checkSeconds ?? 300) + (runtime?.checkReserveSeconds ?? 0),
      ),
    "requested mutation timeout",
    { minimum: 1 },
  );
  const timeoutSeconds = Math.min(requestedTimeout, remaining);
  if (timeoutSeconds < 1) {
    if (sharedExecutionRemaining(manifest) < 1) {
      throw new Error("shared active execution budget is exhausted");
    }
    if (
      manifest.governor.gateSecondsUsed >= manifest.governor.gateSecondsLimit
    ) {
      throw new Error("total gate execution budget is exhausted");
    }
    throw new Error(
      "gate execution cannot start without consuming the reserved provider capacity",
    );
  }
  const startedAt = new Date().toISOString();
  manifest.governor.activeExecution = {
    kind: "gate",
    name: "mutation",
    startedAt,
    timeoutSeconds,
  };
  manifest.governor.lastActivityAt = startedAt;
  return { startedAt, remainingSeconds: timeoutSeconds };
}

function completeMutationAttempt(manifest) {
  const active = manifest.governor.activeExecution;
  if (!active) return;
  if (active.kind !== "gate" || active.name !== "mutation") {
    throw new Error("active gate execution does not belong to 'mutation'");
  }
  completeActiveExecution(manifest, "gate");
}

function reserveIncompleteRetry(manifest) {
  const retry = incompleteRetryStatus(manifest);
  if (retry.state !== "pending") {
    throw new Error(
      "provider retry capacity requires one pending incomplete review",
    );
  }
  const plan = manifest.governor.providerAttemptPlan;
  if (plan?.schemaVersion === 3) return false;
  if (plan?.schemaVersion === 2) {
    for (const round of [1, 2]) {
      if (
        !Number.isInteger(plan.rounds?.[round]) ||
        plan.rounds[round] < 2 ||
        plan.rounds[round] % 2 !== 0
      ) {
        throw new Error(
          "provider retry plan cannot isolate review generations",
        );
      }
    }
    plan.schemaVersion = 3;
    plan.perReview = {
      1: plan.rounds[1] / 2,
      2: plan.rounds[2] / 2,
    };
    return true;
  }
  if (
    plan?.schemaVersion !== 1 ||
    !Number.isInteger(plan.rounds?.[1]) ||
    plan.rounds[1] < 1 ||
    !Number.isInteger(plan.rounds?.[2]) ||
    plan.rounds[2] < 1
  ) {
    throw new Error(
      "legacy provider attempt plan cannot reserve retry capacity",
    );
  }
  const failureRetryStarts = plan.rounds[1] + plan.rounds[2];
  const reviewSeconds = manifest.risk?.runtime?.reviewSeconds;
  const verificationSeconds = manifest.risk?.runtime?.reviewReserveSeconds;
  if (!Number.isInteger(reviewSeconds) || reviewSeconds < 1) {
    throw new Error(
      "legacy provider attempt plan lacks retry runtime evidence",
    );
  }
  if (!Number.isInteger(verificationSeconds) || verificationSeconds < 1) {
    throw new Error(
      "legacy provider attempt plan lacks verification retry runtime evidence",
    );
  }
  const failureRetrySeconds =
    plan.rounds[1] * reviewSeconds + plan.rounds[2] * verificationSeconds;
  manifest.governor.providerAttemptPlan = {
    schemaVersion: 3,
    rounds: {
      1: plan.rounds[1] * 2,
      2: plan.rounds[2] * 2,
    },
    perReview: {
      1: plan.rounds[1],
      2: plan.rounds[2],
    },
    failureRetryStarts,
    failureRetrySeconds,
  };
  manifest.governor.maxProviderAttempts += failureRetryStarts;
  // Only a persisted false proves that the runtime, rather than the operator,
  // owned this cap. Legacy manifests have no provenance bit; keep their limit
  // unchanged instead of guessing that an explicit historical cap was a
  // default and silently expanding it during resume.
  if (manifest.governor.providerSecondsLimitExplicit === false) {
    manifest.governor.providerSecondsLimit += failureRetrySeconds;
  }
  return true;
}

function reviewInfo(manifest) {
  if (exhaustedIncompleteReviews(manifest).length > 0) {
    throw new Error(
      "provider review remained incomplete after its authorized same-range retry",
    );
  }
  const completed = completedReviews(manifest);
  const previous = completed.at(-1);
  const activeAuthorizationIndex =
    manifest.governor.authorizedAttempts.findLastIndex(
      (attempt) =>
        attempt.head === manifest.revisions.currentHead &&
        attempt.consumedAt === null &&
        !attempt.invalidatedAt,
    );
  const artifactAttempt =
    activeAuthorizationIndex >= 0
      ? activeAuthorizationIndex + 1
      : manifest.reviews.length + 1;
  if (previous?.to === manifest.revisions.currentHead) {
    throw new Error(
      "review retry requires a descendant HEAD; the current HEAD is already reviewed",
    );
  }
  return {
    round: completed.length + 1,
    attempt: manifest.governor.roundsUsed,
    artifactAttempt,
    from: previous?.to || manifest.revisions.baseSha,
    to: manifest.revisions.currentHead,
    previousReviewedHead: previous?.to || null,
    artifactDir: path.join(
      manifest.stateRoot,
      "reviews",
      manifest.revisions.currentHead,
      `round-${completed.length + 1}-attempt-${artifactAttempt}`,
    ),
  };
}

function agentsSha256(manifest) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(manifest.agents))
    .digest("hex");
}

function reviewIdentity(manifest) {
  const info = reviewInfo(manifest);
  return {
    schemaVersion: SCHEMA_VERSION,
    reviewContractVersion: manifest.reviewContractVersion || 1,
    invocationId: manifest.invocationId,
    repositoryRealpath: manifest.repo.realpath,
    repositoryKey: manifest.repo.key,
    pr: manifest.repo.pr,
    baseSha: manifest.revisions.baseSha,
    diffBase: info.from,
    headSha: info.to,
    round: info.round,
    attempt: info.attempt,
    tier: manifest.risk.tier,
    agentsSha256: agentsSha256(manifest),
    reviewPolicyDigest: manifest.risk.reviewPolicyDigest || null,
    panelDomain: manifest.panel?.domain || "legacy",
    panelRule: manifest.panel?.rule || "legacy-panel",
    panelSelectionHead: manifest.panel?.selectionHead || null,
  };
}

function reviewedEvidence(manifest) {
  return coveredReviews(manifest)
    .map((review) => review.inventorySha256)
    .join(":");
}

function recordJudge(manifest, options) {
  const authorization = reviewCoverage(manifest);
  if (!options.artifact) {
    throw new Error("judge requires a structured --artifact");
  }
  const input = parseJson(
    fs.readFileSync(path.resolve(options.artifact), "utf8"),
    "judge artifact",
  );
  const context = judgeContext(manifest);
  for (const key of [
    "invocationId",
    "repositoryKey",
    "head",
    "reviewCount",
    "evidenceSha256",
  ]) {
    if (input[key] !== context[key]) {
      throw new Error(`judge artifact ${key} identity mismatch`);
    }
  }
  if (!Array.isArray(input.findings)) {
    throw new Error("judge artifact findings must be an array");
  }
  for (const finding of input.findings) {
    if (
      typeof finding.id !== "string" ||
      !["BLOCKING", "WARNING", "SUPPRESSED"].includes(finding.disposition)
    ) {
      throw new Error("judge findings require an id and valid disposition");
    }
    if (
      ["WARNING", "SUPPRESSED"].includes(finding.disposition) &&
      (typeof finding.reason !== "string" || finding.reason.trim() === "")
    ) {
      throw new Error("WARNING and SUPPRESSED judge findings require a reason");
    }
    const allowedResolutions = {
      BLOCKING: ["confirmed-unresolved"],
      WARNING: ["confirmed-nonblocking", "accepted-risk"],
      SUPPRESSED: ["fixed", "refuted", "duplicate", "non-actionable"],
    };
    if (
      finding.resolution !== undefined &&
      !allowedResolutions[finding.disposition].includes(finding.resolution)
    ) {
      throw new Error(
        `judge finding ${finding.id} resolution is incompatible with ${finding.disposition}`,
      );
    }
  }
  const expectedIds = context.findings.map((finding) => finding.id).sort();
  const actualIds = input.findings.map((finding) => finding.id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error("judge artifact does not classify every provider finding");
  }
  const immutableFinding = (finding) => {
    const immutable = { ...finding };
    delete immutable.disposition;
    delete immutable.reason;
    delete immutable.resolution;
    return immutable;
  };
  const expectedById = new Map(
    context.findings.map((finding) => [finding.id, immutableFinding(finding)]),
  );
  for (const finding of input.findings) {
    if (
      JSON.stringify(canonicalJson(immutableFinding(finding))) !==
      JSON.stringify(canonicalJson(expectedById.get(finding.id)))
    ) {
      throw new Error(
        `judge finding ${finding.id} changed immutable provider payload`,
      );
    }
  }
  const blockingCount = input.findings.filter(
    (finding) => finding.disposition === "BLOCKING",
  ).length;
  const evidenceSha256 = crypto
    .createHash("sha256")
    .update(reviewedEvidence(manifest))
    .digest("hex");
  const artifactPath = path.join(
    manifest.stateRoot,
    "judge",
    `${manifest.revisions.currentHead}.json`,
  );
  atomicWrite(artifactPath, {
    schemaVersion: 1,
    invocationId: context.invocationId,
    repositoryKey: context.repositoryKey,
    head: authorization.head,
    reviewCount: coveredReviews(manifest).length,
    evidenceSha256,
    findings: input.findings,
  });
  manifest.judge = {
    head: authorization.head,
    reviewCount: coveredReviews(manifest).length,
    blockingCount,
    evidenceSha256,
    artifactPath,
    artifactSha256: sha256File(artifactPath),
    recordedAt: new Date().toISOString(),
  };
}

function providerFindings(manifest) {
  const findings = [];
  // BUI-521: agents whose findings artifact was a bare delimiter with no body.
  // Collected across all covered reviews and raised as one malformed-output
  // failure below, rather than silently dropped or counted as findings.
  let inconclusiveAgents = [];
  // Counted PER REVIEW, not across the campaign. These were previously
  // function-scoped: `usableReviewerReports` accumulated with `+= 1` over every
  // covered review while `requiredUsableReports` was only ever Math.max'd to a
  // SINGLE panel's majority. A later clean round therefore satisfied an earlier
  // round's shortfall — round 1 producing zero usable reports passed as soon as
  // round 2 returned three. reviewCoverage() checks that the reviewed slices are
  // contiguous and artifact-intact, but never that each slice individually had a
  // usable panel, so the merge was authorized over a diff range that no full
  // selected panel ever reviewed. Every covered review must carry every
  // selected reviewer's usable evidence.
  let usableReviewerReports = 0;
  let requiredUsableReports = 0;
  // The panel this review's quorum is actually measured against. For a Claude
  // panel that is manifest.agents.length; for codex/gemini it is the number of
  // that provider's own result files. Reporting manifest.agents.length for all
  // of them produced impossible messages like "1/0 usable (need 3)" — a
  // denominator smaller than the numerator, matching neither number, on the one
  // line an operator reads while triaging a blocked critical campaign.
  let quorumPanelSize = 0;
  const failQuorum = () => {
    throw new Error(
      `inconclusive provider findings: ${inconclusiveAgents.join(", ")} ` +
        `left only ${usableReviewerReports}/${quorumPanelSize} usable ` +
        `reviewer reports (need ${requiredUsableReports || 1})`,
    );
  };
  for (const review of coveredReviews(manifest)) {
    if (review.status === "exempt") continue;
    const incompleteSpecial =
      review.status === "incomplete" && review.provider === "review-incomplete";
    const reviewFindingsStart = findings.length;
    usableReviewerReports = 0;
    requiredUsableReports = 0;
    quorumPanelSize = 0;
    let structuredProviderReports = 0;
    const structuredProviderNames = new Set();
    const claudeSlotRoles = new Set();
    const claudeSlotModels = new Map();
    // Reset too: a malformed agent in round 1 must not be reported against
    // round 2's panel now that the quorum is evaluated inside the loop.
    inconclusiveAgents = [];
    const inventory = parseJson(
      fs.readFileSync(path.join(review.artifactDir, "artifact-inventory.json")),
      "provider artifact inventory",
    );
    const resultFiles = inventory.files.filter((file) =>
      file.name.endsWith(".json"),
    );
    const reviewerResultFiles = resultFiles.filter((file) => {
      if (
        incompleteSpecial &&
        ["review-incomplete.result.json", "policy-exempt.result.json"].includes(
          file.name,
        )
      ) {
        return false;
      }
      const rawPass = file.name.match(/^(codex|gemini)-(\d+)\.json$/);
      if (rawPass) {
        const [, providerName, pass] = rawPass;
        return !resultFiles.some(
          (candidate) =>
            candidate.name === `${providerName}-${pass}.normalized.json` ||
            candidate.name === `primary-${providerName}-${pass}.result.json`,
        );
      }
      const rawClaude = file.name.match(/^(.+)\.result\.json$/);
      if (!rawClaude) return true;
      return !resultFiles.some(
        (candidate) => candidate.name === `${rawClaude[1]}.normalized.json`,
      );
    });
    const quorumResultFiles = reviewerResultFiles.filter(
      (file) => file.provider === inventory.provider,
    );
    // Every non-advisory provider panel needs every selected reviewer's usable
    // evidence at read time. Artifact inventory already applies the same floor when
    // it is written; keeping the denominator aligned prevents an unparseable
    // JSON result from disappearing after inventory succeeds.
    quorumPanelSize =
      inventory.provider === "claude"
        ? manifest.agents.length
        : quorumResultFiles.length;
    if (review.status !== "advisory" && !incompleteSpecial) {
      requiredUsableReports = quorumPanelSize;
    }
    for (const item of reviewerResultFiles) {
      let parsed;
      try {
        parsed = parseJson(
          fs.readFileSync(path.join(review.artifactDir, item.name), "utf8"),
          `provider result ${item.name}`,
        );
      } catch {
        // Unparseable evidence is NOT the absence of evidence. A bare
        // `continue` converted it to silence: no finding, no counter, no
        // diagnosis. Route it into the inconclusive path so it participates
        // in the fail-closed quorum instead of vanishing.
        inconclusiveAgents.push(item.name);
        continue;
      }
      const items = parsed.findings || parsed.result?.findings;
      if (!Array.isArray(items)) {
        // Same reasoning: a result whose findings are not an array is
        // malformed evidence, not a clean review.
        inconclusiveAgents.push(item.name);
        continue;
      }
      const resultProvider = item.provider || inventory.provider;
      structuredProviderNames.add(resultProvider);
      if (resultProvider === "claude" && parsed._qualitySlot) {
        const { model, role } = parsed._qualitySlot;
        claudeSlotRoles.add(role);
        if (typeof model === "string" && model.trim() !== "") {
          claudeSlotModels.set(role, model);
        }
      }
      // Preserved primary evidence stays authoritative for its findings, but
      // only the selected panel can contribute a verdict toward that panel's
      // quorum. This matters when Claude falls back after a partial Codex run.
      if (resultProvider === inventory.provider) {
        usableReviewerReports += 1;
        structuredProviderReports += 1;
      }
      items.forEach((finding, index) => {
        findings.push({
          ...finding,
          id: crypto
            .createHash("sha256")
            .update(
              `${review.inventorySha256}:${item.name}:${index}:${JSON.stringify(finding)}`,
            )
            .digest("hex"),
          severity: finding.severity || "unknown",
          title: finding.title || "provider finding",
          provider: resultProvider,
          source: `${resultProvider}:${item.name}#${index}`,
        });
      });
    }
    for (const item of inventory.files.filter((file) =>
      file.name.endsWith(".findings.txt"),
    )) {
      if (incompleteSpecial && item.name === "review-incomplete.findings.txt") {
        continue;
      }
      const isPanelReport = item.provider === inventory.provider;
      const aggregateProvider = item.name.match(
        /^(codex|gemini)\.findings\.txt$/,
      )?.[1];
      const claudeAgent = item.name.match(/^(.+)\.findings\.txt$/)?.[1];
      const pairedClaudeResult =
        inventory.provider === "claude" &&
        !!claudeAgent &&
        resultFiles.some(
          (candidate) => candidate.name === `${claudeAgent}.normalized.json`,
        );
      const aggregateHasStructuredResult =
        pairedClaudeResult ||
        (!!aggregateProvider && structuredProviderNames.has(aggregateProvider));
      const revokeAggregateVerdict = () => {
        if (
          isPanelReport &&
          aggregateHasStructuredResult &&
          structuredProviderReports > 0
        ) {
          usableReviewerReports -= 1;
          structuredProviderReports -= 1;
        }
      };
      // A structured result with actual findings is canonical for its paired
      // aggregate. An empty structured result cannot silence conflicting
      // aggregate text, which remains fail-closed evidence.
      if (pairedClaudeResult) {
        continue;
      }
      if (
        findings.length > reviewFindingsStart &&
        /^(?:codex|gemini)\.findings\.txt$/.test(item.name)
      ) {
        continue;
      }
      const text = fs
        .readFileSync(path.join(review.artifactDir, item.name), "utf8")
        .trim();
      // BUI-463: prose-based sentinel detection (matching "NO FINDINGS" text
      // anywhere in a reviewer's free-text response) is structurally
      // ambiguous — three review rounds on earlier attempts at this exact
      // fix confirmed real reviewers legitimately preface, discuss, or quote
      // that phrase without meaning it as their verdict. Reviewers are
      // instructed (claude-review-companion.sh) to emit a delimited marker
      // ONLY as their final, isolated line. The marker is authoritative ONLY
      // when it is that actual final line — checking for its presence
      // "anywhere in the text" (an earlier version of this fix's own bug,
      // caught by 4 independent review agents during this exact round) would
      // let permitted pre-delimiter commentary that quotes or discusses the
      // marker string silently override the real, later verdict.
      const nonBlankLines = text.split(/\r?\n/).filter((line) => line.trim());
      const lastLine = nonBlankLines[nonBlankLines.length - 1]?.trim();
      let isClean;
      if (lastLine === "<<<NO FINDINGS>>>") {
        isClean = true;
      } else if (lastLine === "<<<FINDINGS REPORTED>>>") {
        isClean = false;
      } else {
        // Legacy fallback for responses that predate the delimited-marker
        // instruction (older prompt version, or Codex/Gemini's own
        // JSON-derived summary text) — the bare-sentinel-with-no-preamble
        // form only, since that's the one shape that was never ambiguous.
        isClean = text
          .split(/\r?\n/)
          .every(
            (line) =>
              /^NO FINDINGS\.?$/i.test(line.trim()) ||
              /^NO FINDINGS\. Verdict: (?:approve|pass)\. [^\r\n]+$/i.test(
                line.trim(),
              ),
          );
      }
      // A zero-byte findings artifact is a truncated or failed reviewer
      // result, never a silent absence of evidence. This must match the
      // write-time inventory gate's treatment of empty reports.
      if (!text) {
        revokeAggregateVerdict();
        if (isPanelReport) inconclusiveAgents.push(item.name);
        continue;
      }
      if (isClean) {
        if (isPanelReport && !aggregateHasStructuredResult) {
          usableReviewerReports += 1;
        }
        continue;
      }
      // Strip the trailing <<<FINDINGS REPORTED>>> delimiter line (if that's
      // how this text was classified as non-clean) so it doesn't leak into
      // the finding body shown to a human or the judge. Slice the ORIGINAL
      // (blank-line-preserving) lines up to the delimiter, not
      // `nonBlankLines` — reusing the already-blank-filtered array would
      // silently collapse paragraph spacing between multiple findings (3
      // review agents caught this in one round).
      const allLines = text.split(/\r?\n/);
      const strippedBody =
        lastLine === "<<<FINDINGS REPORTED>>>"
          ? allLines
              .slice(0, allLines.length - 1)
              .join("\n")
              .replace(/\n+$/, "")
          : text;
      // BUI-521: a reviewer that emits ONLY the delimiter, with no finding
      // text above it, produced a malformed response — not a finding. An
      // earlier version fell back to the raw text "so the finding is never
      // silently empty", which manufactured a BLOCKING finding whose entire
      // body was the sentinel string. That is unfixable by construction: the
      // campaign reports "actionable code findings remain" with nothing to
      // act on, so it can never converge and can never merge. It also
      // corrupts precision telemetry, scoring a malformed response as a
      // caught defect.
      //
      // Malformed and inconclusive provider output is already a distinct,
      // fail-closed diagnosis with bounded per-provider fallback. Route this
      // there instead: still blocks the merge, but with the right reason and
      // a retry path. Do NOT treat it as clean — absent findings text is not
      // evidence of an absent finding.
      if (!strippedBody.trim()) {
        // The aggregate Codex/Gemini findings text belongs to the same
        // provider pass as its structured result. A delimiter-only aggregate
        // means that pass is malformed, so it must revoke one otherwise-valid
        // structured verdict rather than being masked by it. Peer reviewer
        // reports remain independently usable.
        revokeAggregateVerdict();
        inconclusiveAgents.push(item.name);
        continue;
      }
      if (isPanelReport && !aggregateHasStructuredResult) {
        usableReviewerReports += 1;
      }
      const body = strippedBody;
      findings.push({
        id: crypto
          .createHash("sha256")
          .update(`${review.inventorySha256}:${item.name}:${text}`)
          .digest("hex"),
        severity: "blocking",
        title: body.split("\n")[0],
        body,
        source: item.name,
      });
    }
    if (
      (manifest.reviewContractVersion || 1) >= 2 &&
      manifest.risk.tier === "critical" &&
      inventory.provider === "claude" &&
      manifest.agents.some(
        (agent) => !claudeSlotRoles.has(agent) || !claudeSlotModels.has(agent),
      )
    ) {
      throw new Error(
        "critical Claude discovery lacks role-bound model evidence",
      );
    }
    // Fail closed per review, and distinctly from "actionable code findings
    // remain" — the operator needs to know THIS panel produced no usable
    // verdict, not hunt for a defect that was never described. Evaluating here
    // rather than after the loop is what stops a later clean round from
    // covering for an earlier round that returned nothing.
    if (
      (requiredUsableReports > 0 &&
        usableReviewerReports < requiredUsableReports) ||
      (inconclusiveAgents.length && usableReviewerReports === 0)
    ) {
      failQuorum();
    }
  }
  return findings;
}

function priorFindings(manifest) {
  const findings = providerFindings(manifest);
  if (!manifest.judge) {
    return findings.map((finding) => ({
      ...finding,
      disposition: "BLOCKING",
      reason:
        "Unclassified prior finding is conservatively treated as blocking.",
    }));
  }
  if (
    !fs.existsSync(manifest.judge.artifactPath) ||
    sha256File(manifest.judge.artifactPath) !== manifest.judge.artifactSha256
  ) {
    throw new Error("persisted judge artifact identity is invalid");
  }
  const artifact = parseJson(
    fs.readFileSync(manifest.judge.artifactPath, "utf8"),
    "persisted judge artifact",
  );
  const judgedById = new Map(
    (artifact.findings || []).map((finding) => [finding.id, finding]),
  );
  return findings.map((finding) => {
    const judged = judgedById.get(finding.id);
    return {
      ...finding,
      disposition: judged?.disposition || "BLOCKING",
      reason:
        judged?.reason ||
        "Unclassified prior finding is conservatively treated as blocking.",
    };
  });
}

function judgeContext(manifest) {
  const authorization = reviewCoverage(manifest);
  return {
    schemaVersion: 1,
    invocationId: manifest.invocationId,
    repositoryKey: manifest.repo.key,
    head: authorization.head,
    reviewCount: coveredReviews(manifest).length,
    evidenceSha256: crypto
      .createHash("sha256")
      .update(reviewedEvidence(manifest))
      .digest("hex"),
    findings: providerFindings(manifest),
  };
}

function recordReview(manifest, options) {
  assertReviewHeadCurrent(manifest);
  if (manifest.governor.activeExecution?.kind === "provider") {
    completeActiveExecution(manifest, "provider");
  }
  const expected = reviewInfo(manifest);
  const authorizedAttempt = manifest.governor.authorizedAttempts.find(
    (attempt) =>
      attempt.number === expected.attempt &&
      attempt.head === manifest.revisions.currentHead &&
      attempt.consumedAt === null &&
      !attempt.invalidatedAt,
  );
  if (!authorizedAttempt) {
    throw new Error("review attempt was not authorized by the governor");
  }
  const boundExpected = {
    ...expected,
    tier: manifest.risk.tier,
    agentsSha256: agentsSha256(manifest),
  };
  if (
    options.from !== expected.from ||
    options.to !== expected.to ||
    path.resolve(options["artifact-dir"]) !== path.resolve(expected.artifactDir)
  ) {
    throw new Error("review artifact identity does not match manifest");
  }
  verifyReviewArtifact(manifest, {
    ...boundExpected,
    artifactDir: options["artifact-dir"],
    diffSha256: options["diff-sha"],
    provider: options.provider,
  });
  if (options.incomplete === true) {
    throw new Error(
      "completed provider review cannot be marked incomplete; use record-incomplete-review",
    );
  }
  manifest.reviews.push({
    round: expected.round,
    attempt: expected.attempt,
    artifactAttempt: expected.artifactAttempt,
    from: options.from,
    to: options.to,
    provider: options.provider,
    diffSha256: options["diff-sha"],
    inventorySha256: sha256File(
      path.join(
        path.resolve(options["artifact-dir"]),
        "artifact-inventory.json",
      ),
    ),
    artifactDir: path.resolve(options["artifact-dir"]),
    status: "success",
    tier: boundExpected.tier,
    agentsSha256: boundExpected.agentsSha256,
    incompletePanel: Boolean(manifest.panel?.incomplete),
    governorAttemptToken: authorizedAttempt.token,
    completedAt: new Date().toISOString(),
  });
  const priorLeadCount = manifest.reviews
    .slice(0, -1)
    .reduce((sum, review) => sum + (review.leadCount || 0), 0);
  manifest.reviews.at(-1).leadCount =
    providerFindings(manifest).length - priorLeadCount;
  manifest.provider = {
    ...manifest.provider,
    primary: options.primary,
    fallback: options.fallback,
    reviewer: options.provider,
    effort: options.effort || null,
  };
  authorizedAttempt.consumedAt = new Date().toISOString();
}

// Evidence is persisted under the manifest lock, but a provider can finish
// after another local process (or a remote PR update) has moved the candidate.
// Re-read the checkout HEAD inside the same mutation that appends the review;
// callers that have a PR always read the authoritative GitHub head here so a
// second clone cannot silently invalidate the local campaign. The persistence
// layer derives this from manifest identity rather than trusting an optional
// caller flag (BUI-645).
function assertReviewHeadCurrent(manifest) {
  const localHead = git(manifest.repo.realpath, ["rev-parse", "HEAD"]);
  if (localHead !== manifest.revisions.currentHead) {
    const error = new Error(
      `review evidence head moved before recording (expected ${manifest.revisions.currentHead}, found local ${localHead})`,
    );
    error.code = "QUALITY_REVIEW_HEAD_MOVED";
    throw error;
  }
  // A PR-backed campaign must always consult the authoritative GitHub head.
  // Test fixtures provide a fake `gh` executable in PATH; no repository-
  // writable marker may weaken this production invariant.
  if (manifest.repo.pr == null) return;
  const remote = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(manifest.repo.pr),
      "--repo",
      manifest.repo.githubRepository,
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ],
    { cwd: manifest.repo.realpath, encoding: "utf8", timeout: 15_000 },
  );
  const remoteHead = remote.stdout?.trim();
  if (remote.status !== 0 || !/^[0-9a-f]{40}$/i.test(remoteHead || "")) {
    const error = new Error(
      `unable to verify authoritative PR HEAD before recording review${remote.stderr ? `: ${remote.stderr.trim()}` : ""}`,
    );
    error.code = "QUALITY_REVIEW_HEAD_VALIDATION_UNAVAILABLE";
    throw error;
  }
  if (remoteHead !== manifest.revisions.currentHead) {
    const error = new Error(
      `review evidence head moved before recording (expected ${manifest.revisions.currentHead}, found remote ${remoteHead})`,
    );
    error.code = "QUALITY_REVIEW_HEAD_MOVED";
    throw error;
  }
}

const ADVISORY_FAILURE_CATEGORIES = new Set([
  "provider-unavailable",
  "provider-exhaustion",
  "provider-billing",
  "provider-timeout",
]);

function recordAdvisoryReview(manifest, options) {
  // Advisory evidence is still review evidence: bind it to the exact local
  // checkout and, for PR-backed campaigns, the authoritative remote head
  // before persisting the record. This path is retained for v1 campaigns and
  // must not be a stale-head escape hatch (BUI-645).
  assertReviewHeadCurrent(manifest);
  if ((manifest.reviewContractVersion || 1) >= 2) {
    throw new Error(
      "v2 campaigns use an explicit policy exemption, not provider-failure advisory coverage",
    );
  }
  if (manifest.risk.tier !== "low") {
    throw new Error("AI review may be advisory only at the low risk tier");
  }
  if (!ADVISORY_FAILURE_CATEGORIES.has(options["failure-category"])) {
    throw new Error(
      "advisory review requires a typed provider availability failure",
    );
  }
  if (
    !options.primary ||
    options.fallback === undefined ||
    ![options.primary, options.fallback].includes(options["failed-provider"])
  ) {
    throw new Error(
      "advisory review must name the configured provider that became unavailable",
    );
  }
  const expected = reviewInfo(manifest);
  if (
    options.from !== expected.from ||
    options.to !== expected.to ||
    path.resolve(options["artifact-dir"]) !== path.resolve(expected.artifactDir)
  ) {
    throw new Error("review artifact identity does not match manifest");
  }
  const boundExpected = {
    ...expected,
    tier: manifest.risk.tier,
    agentsSha256: agentsSha256(manifest),
    artifactDir: options["artifact-dir"],
    diffSha256: options["diff-sha"],
    provider: "ci-only",
    status: "advisory",
    failedProvider: options["failed-provider"],
  };
  verifyReviewArtifact(manifest, boundExpected);
  manifest.reviews.push({
    round: expected.round,
    attempt: expected.attempt,
    artifactAttempt: expected.artifactAttempt,
    from: options.from,
    to: options.to,
    provider: "ci-only",
    diffSha256: options["diff-sha"],
    inventorySha256: sha256File(
      path.join(
        path.resolve(options["artifact-dir"]),
        "artifact-inventory.json",
      ),
    ),
    artifactDir: path.resolve(options["artifact-dir"]),
    status: "advisory",
    failureCategory: options["failure-category"],
    failedProvider: options["failed-provider"],
    tier: boundExpected.tier,
    agentsSha256: boundExpected.agentsSha256,
    incompletePanel: false,
    completedAt: new Date().toISOString(),
  });
  manifest.provider = {
    ...manifest.provider,
    primary: options.primary,
    fallback: options.fallback,
    reviewer: "ci-only",
  };
}

function recordPolicyExemptReview(manifest, options) {
  assertReviewHeadCurrent(manifest, options);
  if ((manifest.reviewContractVersion || 1) < 2) {
    throw new Error("policy exemption requires review contract v2");
  }
  if (
    manifest.risk.tier !== "low" ||
    manifest.risk.agentTarget !== 0 ||
    manifest.agents.length !== 0 ||
    manifest.panel?.rule !== "low-no-ai"
  ) {
    throw new Error(
      "policy exemption requires the resolved low-risk zero-reviewer policy",
    );
  }
  const expected = reviewInfo(manifest);
  if (
    options.from !== expected.from ||
    options.to !== expected.to ||
    path.resolve(options["artifact-dir"]) !== path.resolve(expected.artifactDir)
  ) {
    throw new Error("review artifact identity does not match manifest");
  }
  const boundExpected = {
    ...expected,
    tier: manifest.risk.tier,
    agentsSha256: agentsSha256(manifest),
    artifactDir: options["artifact-dir"],
    diffSha256: options["diff-sha"],
    provider: "policy-exempt",
    status: "exempt",
    leadCount: 0,
  };
  verifyReviewArtifact(manifest, boundExpected);
  manifest.reviews.push({
    round: expected.round,
    attempt: expected.attempt,
    artifactAttempt: expected.artifactAttempt,
    from: options.from,
    to: options.to,
    provider: "policy-exempt",
    diffSha256: options["diff-sha"],
    inventorySha256: sha256File(
      path.join(
        path.resolve(options["artifact-dir"]),
        "artifact-inventory.json",
      ),
    ),
    artifactDir: path.resolve(options["artifact-dir"]),
    status: "exempt",
    tier: boundExpected.tier,
    agentsSha256: boundExpected.agentsSha256,
    incompletePanel: false,
    completedAt: new Date().toISOString(),
  });
  manifest.provider = {
    ...manifest.provider,
    primary: options.primary,
    fallback: options.fallback,
    reviewer: "policy-exempt",
  };
}

function recordIncompleteReview(manifest, options) {
  assertReviewHeadCurrent(manifest, options);
  if ((manifest.reviewContractVersion || 1) < 2) {
    throw new Error("incomplete discovery attestation requires contract v2");
  }
  if (manifest.risk.tier === "low") {
    throw new Error("low risk uses policy exemption, not incomplete discovery");
  }
  if (manifest.governor.activeExecution?.kind === "provider") {
    completeActiveExecution(manifest, "provider");
  }
  const expected = reviewInfo(manifest);
  const authorizedAttempt = manifest.governor.authorizedAttempts.find(
    (attempt) =>
      attempt.number === expected.attempt &&
      attempt.head === manifest.revisions.currentHead &&
      attempt.consumedAt === null &&
      !attempt.invalidatedAt,
  );
  if (!authorizedAttempt) {
    throw new Error("incomplete review lacks an authorized governor attempt");
  }
  if (
    options.from !== expected.from ||
    options.to !== expected.to ||
    path.resolve(options["artifact-dir"]) !== path.resolve(expected.artifactDir)
  ) {
    throw new Error("review artifact identity does not match manifest");
  }
  const boundExpected = {
    ...expected,
    tier: manifest.risk.tier,
    agentsSha256: agentsSha256(manifest),
    artifactDir: options["artifact-dir"],
    diffSha256: options["diff-sha"],
    provider: "review-incomplete",
    status: "incomplete",
    leadCount: 0,
  };
  verifyReviewArtifact(manifest, boundExpected);
  manifest.reviews.push({
    round: expected.round,
    attempt: expected.attempt,
    artifactAttempt: expected.artifactAttempt,
    from: options.from,
    to: options.to,
    provider: "review-incomplete",
    diffSha256: options["diff-sha"],
    inventorySha256: sha256File(
      path.join(
        path.resolve(options["artifact-dir"]),
        "artifact-inventory.json",
      ),
    ),
    artifactDir: path.resolve(options["artifact-dir"]),
    status: "incomplete",
    failureCategory: options["failure-category"] || "provider-error",
    failedProvider: options["failed-provider"] || "unknown",
    tier: boundExpected.tier,
    agentsSha256: boundExpected.agentsSha256,
    incompletePanel: false,
    governorAttemptToken: authorizedAttempt.token,
    completedAt: new Date().toISOString(),
  });
  const priorLeadCount = manifest.reviews
    .slice(0, -1)
    .reduce((sum, review) => sum + (review.leadCount || 0), 0);
  manifest.reviews.at(-1).leadCount =
    providerFindings(manifest).length - priorLeadCount;
  manifest.provider = {
    ...manifest.provider,
    primary: options.primary,
    fallback: options.fallback,
    reviewer: "review-incomplete",
  };
  authorizedAttempt.consumedAt = new Date().toISOString();
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function providerEvidenceName(name, provider) {
  if (provider === "policy-exempt") {
    return ["policy-exempt.findings.txt", "policy-exempt.result.json"].includes(
      name,
    );
  }
  if (provider === "review-incomplete") {
    return (
      [
        "review-incomplete.findings.txt",
        "review-incomplete.result.json",
      ].includes(name) ||
      /^primary-(?:codex|gemini|claude)-.+\.result\.json$/.test(name) ||
      /^(?:codex|gemini)-\d+\.normalized\.json$/.test(name) ||
      (!/^(?:codex|gemini|primary)-/.test(name) &&
        name.endsWith(".normalized.json"))
    );
  }
  if (/^primary-(?:codex|gemini|claude)-/.test(name)) return true;
  if (provider === "codex") {
    return (
      name === "codex.findings.txt" ||
      /^codex-\d+(?:\.normalized)?\.json$/.test(name)
    );
  }
  if (provider === "gemini") {
    return (
      name === "gemini.findings.txt" ||
      /^gemini-\d+(?:\.normalized)?\.json$/.test(name)
    );
  }
  if (provider === "claude") {
    return (
      (name.endsWith(".findings.txt") ||
        name.endsWith(".result.json") ||
        name.endsWith(".normalized.json")) &&
      !/^(?:codex|gemini)(?:-|\.)/.test(name)
    );
  }
  throw new Error(`unsupported review provider '${provider}'`);
}

function writeArtifactInventory(
  manifest,
  artifactDir,
  provider,
  { advisory = false, exempt = false, incomplete = false } = {},
) {
  const resolved = path.resolve(artifactDir);
  const info = reviewInfo(manifest);
  if (resolved !== path.resolve(info.artifactDir)) {
    throw new Error("artifact inventory directory identity mismatch");
  }
  const names = fs
    .readdirSync(resolved)
    .filter(
      (name) =>
        name.endsWith(".findings.txt") ||
        name.endsWith(".result.json") ||
        name.endsWith(".normalized.json") ||
        /^(?:codex|gemini)-\d+(?:\.normalized)?\.json$/.test(name),
    )
    .filter((name) => providerEvidenceName(name, provider))
    .sort();
  const findings = names.filter((name) => name.endsWith(".findings.txt"));
  if (findings.length === 0) throw new Error("provider findings are missing");
  if (
    provider === "claude" &&
    !advisory &&
    findings.length !== manifest.agents.length
  ) {
    throw new Error(
      "Claude findings inventory does not cover the mandatory panel",
    );
  }
  // An EMPTY report is inconclusive too. This filter previously only excluded
  // files carrying an explicit `INCONCLUSIVE:` line, so a 0-byte or
  // whitespace-only artifact — an agent killed mid-write, or a truncated
  // write — counted toward the usable quorum and got stamped into signed,
  // hash-bound inventory evidence as a completed report. providerFindings()
  // independently treats an empty body as inconclusive; these two must agree,
  // or this gate is not enforcing the invariant its own error message claims.
  const inconclusiveFindings = findings.filter((name) => {
    const text = fs.readFileSync(path.join(resolved, name), "utf8");
    if (!text.trim()) return true;
    return text.split(/\r?\n/).some((line) => line.startsWith("INCONCLUSIVE:"));
  });
  const panelSize =
    exempt || incomplete
      ? 0
      : provider === "claude" && !advisory
        ? manifest.agents.length
        : findings.length;
  const requiredUsableFindings = panelSize;
  const usableFindings = findings.length - inconclusiveFindings.length;
  if (usableFindings < requiredUsableFindings) {
    throw new Error(
      `inconclusive provider findings cannot be inventoried: ` +
        `only ${usableFindings}/${panelSize} usable reports ` +
        `(need ${requiredUsableFindings})`,
    );
  }
  const inventory = {
    schemaVersion: 1,
    invocationId: manifest.invocationId,
    headSha: manifest.revisions.currentHead,
    provider,
    status: exempt ? "exempt" : incomplete ? "incomplete" : "success",
    tier: manifest.risk.tier,
    focusSha256:
      (manifest.reviewContractVersion || 1) >= 2 &&
      manifest.panel?.rule &&
      !manifest.panel.rule.startsWith("legacy")
        ? sha256File(path.join(resolved, "review-focus.txt"))
        : null,
    panel: manifest.panel || {
      requiredAgents: manifest.agents.length,
      selectedAgents: manifest.agents.length,
      incomplete: false,
    },
    files: names.map((name) => {
      // Preserved artifacts encode their authoring provider in the filename
      // itself (e.g. primary-codex-1.result.json). manifest.provider.primary
      // is not yet populated on a campaign's first round — recordReview()
      // sets it after this inventory is written — so it cannot be trusted
      // here; the filename is always correct regardless of round ordering.
      const preservedMatch = name.match(/^primary-(codex|gemini|claude)-/);
      const nativeMatch = name.match(/^(codex|gemini)-\d+\.normalized\.json$/);
      const partialClaude =
        provider === "review-incomplete" &&
        !preservedMatch &&
        !nativeMatch &&
        name.endsWith(".normalized.json");
      return {
        name,
        provider: preservedMatch
          ? preservedMatch[1]
          : nativeMatch
            ? nativeMatch[1]
            : partialClaude
              ? "claude"
              : provider,
        sha256: sha256File(path.join(resolved, name)),
      };
    }),
  };
  atomicWrite(path.join(resolved, "artifact-inventory.json"), inventory);
}

function artifactPaths(manifest, review) {
  const artifactDir = path.resolve(review.artifactDir);
  const expectedDir = path.resolve(
    manifest.stateRoot,
    "reviews",
    review.to,
    `round-${review.round}-attempt-${review.artifactAttempt ?? review.attempt}`,
  );
  if (
    artifactDir !== expectedDir ||
    !artifactDir.startsWith(`${manifest.stateRoot}${path.sep}`)
  ) {
    throw new Error("review artifact directory identity mismatch");
  }
  if (fs.lstatSync(artifactDir).isSymbolicLink()) {
    throw new Error("review artifact directory must not be a symlink");
  }
  return {
    artifactDir,
    identityFile: path.join(artifactDir, "identity.json"),
    diffFile: path.join(artifactDir, "diff.txt"),
    inventoryFile: path.join(artifactDir, "artifact-inventory.json"),
  };
}

function verifyIdentityFile(manifest, review, identityFile) {
  const identity = parseJson(
    fs.readFileSync(identityFile, "utf8"),
    "review identity",
  );
  const expected = {
    invocationId: manifest.invocationId,
    repositoryRealpath: manifest.repo.realpath,
    repositoryKey: manifest.repo.key,
    pr: manifest.repo.pr,
    baseSha: manifest.revisions.baseSha,
    diffBase: review.from,
    headSha: review.to,
    round: review.round,
    attempt: review.attempt,
    tier: review.tier,
    agentsSha256: review.agentsSha256,
    reviewContractVersion: manifest.reviewContractVersion || 1,
    reviewPolicyDigest: manifest.risk.reviewPolicyDigest || null,
    panelDomain: manifest.panel?.domain || "legacy",
    panelRule: manifest.panel?.rule || "legacy-panel",
    panelSelectionHead: manifest.panel?.selectionHead || null,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (identity[key] !== value) {
      throw new Error(`review artifact ${key} identity mismatch`);
    }
  }
}

function verifyInventory(manifest, review, inventoryFile, artifactDir) {
  const inventory = parseJson(
    fs.readFileSync(inventoryFile, "utf8"),
    "provider artifact inventory",
  );
  if (
    review.inventorySha256 &&
    sha256File(inventoryFile) !== review.inventorySha256
  ) {
    throw new Error("provider artifact inventory hash mismatch");
  }
  const identityMatches =
    inventory.invocationId === manifest.invocationId &&
    inventory.headSha === review.to &&
    inventory.provider ===
      (review.status === "advisory"
        ? review.failedProvider
        : review.provider) &&
    ((manifest.reviewContractVersion || 1) < 2 ||
      JSON.stringify(canonicalJson(inventory.panel)) ===
        JSON.stringify(canonicalJson(manifest.panel)));
  const usable =
    ["success", "exempt", "incomplete"].includes(inventory.status) &&
    Array.isArray(inventory.files) &&
    inventory.files.length > 0;
  const focusFile = path.join(artifactDir, "review-focus.txt");
  const focusMatches =
    (manifest.reviewContractVersion || 1) < 2 ||
    !manifest.panel?.rule ||
    manifest.panel.rule.startsWith("legacy") ||
    (inventory.tier === manifest.risk.tier &&
      fs.existsSync(focusFile) &&
      !fs.lstatSync(focusFile).isSymbolicLink() &&
      inventory.focusSha256 === sha256File(focusFile));
  if (!identityMatches || !usable || !focusMatches) {
    throw new Error("provider artifact inventory identity/status mismatch");
  }
  for (const item of inventory.files) {
    const file = path.join(artifactDir, item.name);
    const invalid =
      path.dirname(file) !== artifactDir ||
      fs.lstatSync(file).isSymbolicLink() ||
      sha256File(file) !== item.sha256;
    if (invalid)
      throw new Error(`provider artifact hash mismatch: ${item.name}`);
  }
}

function verifyReviewArtifact(manifest, review) {
  const { artifactDir, identityFile, diffFile, inventoryFile } = artifactPaths(
    manifest,
    review,
  );
  for (const file of [identityFile, diffFile, inventoryFile]) {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error("review artifact files must not be symlinks");
    }
  }
  verifyIdentityFile(manifest, review, identityFile);
  if (sha256File(diffFile) !== review.diffSha256) {
    throw new Error("review diff hash mismatch");
  }
  const canonicalDiff = reviewDiffBuffer(
    manifest.repo.realpath,
    review.from,
    review.to,
  );
  const canonicalSha256 = crypto
    .createHash("sha256")
    .update(canonicalDiff)
    .digest("hex");
  if (canonicalSha256 !== review.diffSha256) {
    throw new Error("review diff does not match canonical Git diff");
  }
  if (
    review.tier !== manifest.risk.tier ||
    review.agentsSha256 !== agentsSha256(manifest)
  ) {
    throw new Error("review risk/agent identity mismatch");
  }
  if (
    (manifest.reviewContractVersion || 1) >= 2 &&
    (!manifest.panel?.domain ||
      !manifest.panel?.rule ||
      manifest.panel.rule.startsWith("legacy") ||
      !/^[0-9a-f]{40}$/.test(manifest.panel?.selectionHead || ""))
  ) {
    throw new Error("contract v2 review lacks bound domain selection");
  }
  if (
    (manifest.reviewContractVersion || 1) >= 2 &&
    manifest.risk.reviewPolicyDigest
  ) {
    const selectionIsAncestor =
      spawnSync(
        "git",
        [
          "merge-base",
          "--is-ancestor",
          manifest.panel.selectionHead,
          review.to,
        ],
        { cwd: manifest.repo.realpath, stdio: "ignore" },
      ).status === 0;
    const expectedSelection = agentSelection.selectReviewersForRange({
      tier: manifest.risk.tier,
      repo: manifest.repo.realpath,
      // The panel is campaign-bound from the complete base..HEAD change. A
      // remediation review may cover only priorHead..HEAD, but recomputing the
      // selector over that delta can switch domains and falsely invalidate the
      // immutable campaign identity.
      base: manifest.revisions.baseSha,
      head: manifest.panel.selectionHead,
    });
    if (
      !selectionIsAncestor ||
      manifest.risk.reviewPolicyDigest !==
        reviewPolicyDigest(buildReviewPolicy(manifest)) ||
      JSON.stringify(expectedSelection.agents) !==
        JSON.stringify(manifest.agents) ||
      expectedSelection.domain !== manifest.panel?.domain ||
      expectedSelection.rule !== manifest.panel?.rule
    ) {
      throw new Error("review policy or selected reviewer identity mismatch");
    }
  }
  verifyInventory(manifest, review, inventoryFile, artifactDir);
}

function verifyReviewAuthorization(manifest, review) {
  if (review.status === "exempt") {
    const exemption = parseJson(
      fs.readFileSync(
        path.join(review.artifactDir, "policy-exempt.result.json"),
        "utf8",
      ),
      "policy exemption artifact",
    );
    if (
      (manifest.reviewContractVersion || 1) < 2 ||
      manifest.risk.tier !== "low" ||
      manifest.risk.agentTarget !== 0 ||
      manifest.agents.length !== 0 ||
      manifest.panel?.rule !== "low-no-ai" ||
      review.provider !== "policy-exempt" ||
      exemption.aiReviewRequired !== false ||
      exemption.head !== review.to ||
      exemption.tier !== "low" ||
      exemption.reviewContractVersion !== REVIEW_CONTRACT_VERSION ||
      exemption.reviewPolicyDigest !== manifest.risk.reviewPolicyDigest ||
      exemption.agentsSha256 !== agentsSha256(manifest) ||
      exemption.domain !== manifest.panel?.domain ||
      exemption.selectionRule !== manifest.panel?.rule ||
      exemption.diffSha256 !== review.diffSha256
    ) {
      throw new Error("invalid low-risk policy exemption coverage");
    }
    return;
  }
  if (review.status === "advisory") {
    if (
      manifest.risk.tier !== "low" ||
      review.provider !== "ci-only" ||
      !ADVISORY_FAILURE_CATEGORIES.has(review.failureCategory)
    ) {
      throw new Error("invalid advisory review coverage");
    }
    return;
  }
  if (review.status === "incomplete") {
    const invalidSpecial =
      review.provider === "review-incomplete" &&
      (typeof review.failureCategory !== "string" || !review.failureCategory);
    if (
      (manifest.reviewContractVersion || 1) < 2 ||
      manifest.risk.tier === "low" ||
      invalidSpecial
    ) {
      throw new Error("invalid incomplete discovery coverage");
    }
  }
  const authorizedAttempt = manifest.governor.authorizedAttempts.find(
    (attempt) =>
      attempt.token === review.governorAttemptToken &&
      attempt.head === review.to &&
      attempt.consumedAt !== null &&
      !attempt.invalidatedAt,
  );
  if (!authorizedAttempt) {
    throw new Error("review lacks an authorized governor attempt");
  }
}

function reviewCoverage(manifest) {
  const covered = authorizationReviews(manifest);
  if (covered.length === 0) throw new Error("no review coverage");
  let expectedFrom = manifest.revisions.baseSha;
  for (const review of covered) {
    if (review.from !== expectedFrom) {
      throw new Error("review coverage is not contiguous");
    }
    verifyReviewArtifact(manifest, review);
    verifyReviewAuthorization(manifest, review);
    if (review.incompletePanel) {
      throw new Error(
        "an incomplete reduced panel cannot satisfy merge review coverage",
      );
    }
    expectedFrom = review.to;
  }
  const carries = Array.isArray(manifest.revisions.reviewRebaseCarries)
    ? manifest.revisions.reviewRebaseCarries
    : manifest.revisions.reviewRebaseCarry
      ? [manifest.revisions.reviewRebaseCarry]
      : [];
  const seenHeads = new Set();
  while (expectedFrom !== manifest.revisions.currentHead) {
    const carry = carries.find(
      (candidate) => candidate.reviewedHead === expectedFrom,
    );
    const replayed =
      carry &&
      replayedTree(
        manifest.repo.realpath,
        carry.priorBaseSha,
        carry.reviewedHead,
        carry.baseSha,
      );
    const actualTree =
      carry &&
      git(manifest.repo.realpath, ["rev-parse", `${carry.head}^{tree}`]);
    const carriedReview =
      carry &&
      replayed &&
      replayed === actualTree &&
      !seenHeads.has(carry.head);
    if (!carriedReview) break;
    seenHeads.add(carry.head);
    expectedFrom = carry.head;
  }
  if (expectedFrom !== manifest.revisions.currentHead) {
    throw new Error("final HEAD has not been covered by review evidence");
  }
  if (
    !manifest.provider?.reviewer ||
    !manifest.provider?.primary ||
    manifest.provider?.fallback === undefined
  ) {
    throw new Error("review provider evidence is incomplete");
  }
  verifyGateEvidence(manifest);
  const authorizationBase = effectiveBaseSha(manifest);
  const completeDiffSha256 = crypto
    .createHash("sha256")
    .update(
      reviewDiffBuffer(
        manifest.repo.realpath,
        authorizationBase,
        manifest.revisions.currentHead,
      ),
    )
    .digest("hex");
  return {
    // A carried review is proven against the rebased live base. The immutable
    // creation base still namespaces the campaign, but it is not the base the
    // stamped tree now merges from (and must not be signed into Quality-Base).
    base: authorizationBase,
    head: manifest.revisions.currentHead,
    provider: manifest.provider.reviewer,
    primary: manifest.provider.primary,
    fallback: manifest.provider.fallback,
    tier: manifest.risk.tier,
    contractVersion: manifest.reviewContractVersion || 1,
    policyDigest: manifest.risk.reviewPolicyDigest || null,
    agentsSha256: agentsSha256(manifest),
    domain: manifest.panel?.domain || "legacy",
    selectionRule: manifest.panel?.rule || "legacy-panel",
    // Contract-v2 evidence is verified outside the local manifest process,
    // including by standalone CI. Bind it to the stable GitHub identity when
    // one exists; the local repo key remains the identity for internal
    // manifest/artifact namespaces.
    repositoryKey: manifest.repo.githubRepository || manifest.repo.key,
    diffSha256: completeDiffSha256,
  };
}

function gateEvidenceIdentity(manifest, options) {
  const name = options.name;
  const command = options.command;
  const source = options.source;
  const log = options.log ? path.resolve(options.log) : null;
  if (!name || !source || !command || !fs.existsSync(log)) {
    throw new Error(
      "gate evidence requires --name, --source, --command, and --log",
    );
  }
  const required = manifest.requiredGates.find((gate) => gate.name === name);
  if (!required) throw new Error(`gate '${name}' is not required by policy`);
  if (source !== required.source || command !== required.command) {
    throw new Error(`gate '${name}' evidence does not match required source`);
  }
  return { name, command, source, log, required };
}

function gateEvidenceInput(manifest, options) {
  const identity = gateEvidenceIdentity(manifest, options);
  const status = options.status || "success";
  const reason = options.reason?.trim() || null;
  if (!["success", "skipped", "failed", "timeout"].includes(status)) {
    throw new Error(`invalid gate evidence status '${status}'`);
  }
  if (
    status === "skipped" &&
    (identity.name !== "test" ||
      identity.required.allowSkip !== true ||
      !reason)
  ) {
    throw new Error(
      "test gate skipping requires --skip-tests and an explicit skip reason",
    );
  }
  if (["failed", "timeout"].includes(status) && !reason) {
    throw new Error(`gate ${status} evidence requires an explicit reason`);
  }
  const failureCode = options.failureCode || null;
  if (failureCode !== null && !/^[a-z][a-z0-9-]*$/.test(failureCode)) {
    throw new Error("gate failure code must be a lowercase identifier");
  }
  return { ...identity, status, reason, failureCode };
}

function recordGate(manifest, options) {
  const { name, command, source, log, status, reason, failureCode } =
    gateEvidenceInput(manifest, options);
  manifest.gates = manifest.gates.filter(
    (gate) =>
      gate.head !== manifest.revisions.currentHead || gate.name !== name,
  );
  if (manifest.gateEvidenceCarry) {
    manifest.gateEvidenceCarryHistory ??= [];
    manifest.gateEvidenceCarryHistory.push({
      ...manifest.gateEvidenceCarry,
      retiredAt: new Date().toISOString(),
      retiredReason: `gate-replaced:${name}`,
    });
    delete manifest.gateEvidenceCarry;
  }
  manifest.gates.push({
    name,
    source,
    command,
    head: manifest.revisions.currentHead,
    status,
    reason,
    failureCode,
    policyDigest: gateRequirementsDigest(
      manifest.requiredGates.filter((gate) => gate.name === name),
    ),
    log,
    logSha256: sha256File(log),
    completedAt: new Date().toISOString(),
  });
}

function recordSkippedGate(manifest, required, name, log, options) {
  const reason = options.reason?.trim();
  fs.writeFileSync(log, `SKIPPED: ${reason || ""}\n`, { mode: 0o600 });
  recordGate(manifest, {
    name,
    source: required.source,
    command: required.command,
    log,
    status: "skipped",
    reason,
  });
}

function executableAvailable(executable, environment) {
  const result = spawnSync(
    "bash",
    ["-c", 'command -v -- "$1" >/dev/null', "bash", executable],
    { env: environment, stdio: "ignore" },
  );
  return result.status === 0;
}

function repositoryGateEnvironment(environment = process.env) {
  const isolated = { ...environment };
  for (const name of [
    "BS_QUALITY_TERMINAL_EPOCH",
    "BS_QUALITY_REPOSITORY_LEASE_TOKEN",
    "QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY",
    "QUALITY_REVIEW_EVIDENCE_PRIVATE_KEY_FILE",
    "QUALITY_APPROVAL_PRIVATE_KEY",
    "QUALITY_APPROVAL_PRIVATE_KEY_FILE",
  ]) {
    delete isolated[name];
  }
  return isolated;
}

function assertGateProcessResult(
  result,
  output,
  name,
  timeoutSeconds,
  riskResolved,
) {
  const interruptionStatus = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  }[result.signal];
  const interrupted = interruptionStatus || result.status;
  if ([129, 130, 143].includes(interrupted)) {
    throw new GateExecutionError(
      "failed",
      `gate '${name}' was interrupted by host signal ${interrupted - 128}`,
      "signal-interrupted",
    );
  }
  if (result.status === 124) {
    throw new GateExecutionError(
      "timeout",
      `gate '${name}' exceeded its proportional ${timeoutSeconds}s budget`,
      riskResolved ? "gate-timeout" : "unresolved-risk-timeout",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new GateExecutionError(
      "failed",
      `gate '${name}' failed with exit status ${result.status}`,
      "gate-failed",
    );
  }
}

function executeGate(manifest, required, name, log, manifestPath) {
  const runtime = manifest.risk?.runtime;
  const gateSeconds = runtime?.checkSeconds ?? 300;
  const gateReserveSeconds = runtime?.checkReserveSeconds ?? 0;
  const hadActiveExecution = manifest.governor.activeExecution != null;
  reconcileAbandonedExecution(manifest);
  if (hadActiveExecution && manifest.governor.activeExecution == null) {
    // reconcileAbandonedExecution just cleared a timed-out execution and
    // credited its elapsed time to gateSecondsUsed, in memory only. If the
    // exhaustion check below throws, that plain Error propagates out of
    // mutate()'s operation() call in withManifestLock() before
    // saveManifest() ever runs -- so this reconciliation was silently
    // discarded on every prior attempt, and a stale execution whose
    // deadline had already passed kept getting "recovered" and immediately
    // re-discarded, re-throwing the exhaustion error forever with no way to
    // recover the manifest. Persist the reconciliation now, unconditionally,
    // so it survives regardless of what happens next in this function.
    saveManifestMidTransaction(manifestPath, manifest);
  }
  const gateRemaining = executionRemaining(manifest, "gate");
  if (gateRemaining <= 0) {
    if (sharedExecutionRemaining(manifest) <= 0) {
      throw new Error(
        `shared active execution budget is exhausted before '${name}'`,
      );
    }
    if (
      manifest.governor.gateSecondsUsed >= manifest.governor.gateSecondsLimit
    ) {
      throw new Error(
        `total gate execution budget is exhausted before '${name}'`,
      );
    }
    throw new Error(
      `gate '${name}' cannot start without consuming the reserved provider capacity`,
    );
  }
  const timeoutSeconds = Math.min(
    Math.max(
      gateSeconds + gateReserveSeconds,
      declaredGateTimeout(runtime, name),
    ),
    gateRemaining,
  );
  const gateEnvironment = repositoryGateEnvironment();
  if (!executableAvailable(required.executable, gateEnvironment)) {
    fs.writeFileSync(
      log,
      `required gate executable '${required.executable}' is unavailable on PATH\n`,
      { mode: 0o600 },
    );
    throw new GateExecutionError(
      "failed",
      `gate '${name}' cannot start because '${required.executable}' is unavailable`,
      "missing-executable",
    );
  }
  manifest.governor.activeExecution = {
    kind: "gate",
    name,
    startedAt: new Date().toISOString(),
    timeoutSeconds,
  };
  manifest.governor.lastActivityAt =
    manifest.governor.activeExecution.startedAt;
  // Refreshing updatedAt here (rather than only on completion) is
  // intentional: a gate execution that just started is not abandoned, and
  // worktree-manager.js's qualityManifestReleaseState() reads updatedAt to
  // judge lock staleness. Nothing else touches updatedAt while the
  // subprocess below runs, but that's covered by activeExecution's own
  // startedAt+timeoutSeconds deadline (reconcileAbandonedExecution), which
  // is independent of the lock-staleness heuristic (Codex review finding,
  // 2026-08-01, medium: confirming this doesn't conflate in-flight vs
  // abandoned state).
  saveManifestMidTransaction(manifestPath, manifest);
  const boundedRunner = path.join(__dirname, "quality-run-bounded.sh");
  const monotonicStartedAt = process.hrtime.bigint();
  let result;
  try {
    result = spawnSync(
      "bash",
      [
        boundedRunner,
        "--timeout",
        String(timeoutSeconds),
        "--",
        required.executable,
        ...required.args,
      ],
      {
        cwd: manifest.repo.realpath,
        encoding: "utf8",
        env: gateEnvironment,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } finally {
    const elapsedNanoseconds = process.hrtime.bigint() - monotonicStartedAt;
    completeActiveExecution(
      manifest,
      "gate",
      Date.now(),
      Number(elapsedNanoseconds) / 1_000_000_000,
    );
    saveManifestMidTransaction(manifestPath, manifest);
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(log, output, { mode: 0o600 });
  assertGateProcessResult(
    result,
    output,
    name,
    timeoutSeconds,
    manifest.risk?.resolved === true,
  );
  return output;
}

function declaredGateTimeout(runtime, name) {
  const seconds =
    runtime && runtime.gateTimeoutSeconds
      ? runtime.gateTimeoutSeconds[name]
      : 0;
  return Number.isInteger(seconds) && seconds > 0 ? seconds : 0;
}

function runGate(manifest, options, manifestPath) {
  if (manifest.repo.isCrossRepository === true) {
    throw new Error(
      "cross-repository PR gates must run in isolated CI; host execution is forbidden",
    );
  }
  const name = options.name;
  const required = manifest.requiredGates.find((gate) => gate.name === name);
  if (!required) throw new Error(`gate '${name}' is not required by policy`);
  const log = path.join(
    manifest.stateRoot,
    "gates",
    manifest.revisions.currentHead,
    `${name}.log`,
  );
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  if (options.skip === true) {
    recordSkippedGate(manifest, required, name, log, options);
    return;
  }
  try {
    const output = executeGate(manifest, required, name, log, manifestPath);
    recordGate(manifest, {
      name,
      source: required.source,
      command: required.command,
      log,
      status: "success",
    });
    process.stdout.write(output);
  } catch (error) {
    if (!(error instanceof GateExecutionError)) {
      throw error;
    }
    recordGate(manifest, {
      name,
      source: required.source,
      command: required.command,
      log,
      status: error.status,
      reason: error.message,
      failureCode: error.failureCode,
    });
    process.stderr.write(`${error.message}\n`);
    throw error;
  }
}

function validGateArtifact(gate) {
  return Boolean(
    gate && fs.existsSync(gate.log) && sha256File(gate.log) === gate.logSha256,
  );
}

function gateMatchesRequirement(gate, required) {
  return Boolean(
    gate?.source === required.source && gate?.command === required.command,
  );
}

function testEvidenceChainValid(manifest, required, gateHead) {
  let predecessor = required?.predecessorEvidence || null;
  let descendantHead = gateHead;
  const seen = new Set();
  while (predecessor) {
    if (
      !predecessor.head ||
      seen.has(predecessor.head) ||
      predecessor.status !== "success" ||
      !predecessor.log ||
      !predecessor.logSha256 ||
      !predecessor.source ||
      !predecessor.command ||
      !predecessor.policyDigest ||
      !predecessor.requiredGatesDigest ||
      !isAncestorOf(manifest.repo.realpath, predecessor.head, descendantHead) ||
      !fs.existsSync(predecessor.log) ||
      sha256File(predecessor.log) !== predecessor.logSha256
    ) {
      return false;
    }
    seen.add(predecessor.head);
    descendantHead = predecessor.head;
    predecessor = predecessor.predecessor || null;
  }
  return true;
}

function validTestGate(manifest, gate) {
  if (!validGateArtifact(gate)) return false;
  const required = manifest.requiredGates.find(
    (candidate) => candidate.name === "test",
  );
  if (!gateMatchesRequirement(gate, required)) return false;
  if (
    gate.policyDigest &&
    gate.policyDigest !== gateRequirementsDigest([required])
  )
    return false;
  if (!testEvidenceChainValid(manifest, required, gate.head)) return false;
  if (gate.status === "success") return true;
  return Boolean(
    manifest.requiredGates.find((required) => required.name === "test")
      ?.allowSkip === true &&
    gate.status === "skipped" &&
    typeof gate.reason === "string" &&
    gate.reason.trim() !== "",
  );
}

function validReusableTestGate(manifest, gate, required) {
  const predecessor = required?.predecessorEvidence;
  if (
    gateMatchesRequirement(gate, required) &&
    gate.policyDigest === gateRequirementsDigest([required])
  ) {
    return validTestGate(manifest, gate);
  }
  if (!predecessor || !predecessor.policyDigest) return false;
  if (
    gate.status !== "success" ||
    !validGateArtifact(gate) ||
    predecessor.head !== gate.head ||
    predecessor.source !== gate.source ||
    predecessor.command !== gate.command ||
    predecessor.policyDigest !== gate.policyDigest ||
    predecessor.log !== gate.log ||
    predecessor.logSha256 !== gate.logSha256
  ) {
    return false;
  }
  return testEvidenceChainValid(manifest, required, gate.head);
}

function verifyGateEvidenceCarry(manifest) {
  const carry = manifest.gateEvidenceCarry;
  if (!carry) return;
  if (
    carry.sourceInvocationId === manifest.invocationId ||
    carry.head !== manifest.revisions.currentHead ||
    carry.requiredGatesDigest !== gateRequirementsDigest(manifest.requiredGates)
  ) {
    throw new Error("gate evidence carry identity is invalid");
  }
  const current = manifest.gates.filter(
    (gate) => gate.head === manifest.revisions.currentHead,
  );
  if (
    current.length !== manifest.requiredGates.length ||
    carry.gatesDigest !== gateEvidenceDigest(current)
  ) {
    throw new Error("gate evidence carry digest is invalid");
  }
  for (const required of manifest.requiredGates) {
    const gate = current.find((candidate) => candidate.name === required.name);
    if (!gate || !carryableGate(manifest, gate)) {
      throw new Error(`carried ${required.name} gate evidence is invalid`);
    }
  }
}

// acceptedConditions is only ever non-empty on the operator-override path
// (see reviewAuthorization); the normal path always calls this with no
// arguments, so a caller cannot widen the normal merge path by accident.
function verifyGateEvidence(manifest, acceptedConditions = []) {
  verifyGateEvidenceCarry(manifest);
  const current = manifest.gates.filter(
    (gate) => gate.head === manifest.revisions.currentHead,
  );
  for (const required of manifest.requiredGates) {
    const gate = current.find((item) => item.name === required.name);
    const valid =
      required.name === "test"
        ? validTestGate(manifest, gate)
        : gate?.status === "success" &&
          gateMatchesRequirement(gate, required) &&
          validGateArtifact(gate);
    if (!valid && !acceptedConditions.includes(`gate:${required.name}`)) {
      throw new Error(
        `required ${required.name} gate evidence is missing or stale`,
      );
    }
  }
}

function validMutationPaths(paths) {
  return Boolean(
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every(
      (candidate) =>
        typeof candidate === "string" &&
        candidate !== "" &&
        !path.isAbsolute(candidate) &&
        !candidate.split(/[\\/]+/).includes(".."),
    ),
  );
}

function validMutationArtifact(manifest, artifact) {
  const identityValid = [
    artifact.schemaVersion === 1,
    artifact.invocationId === manifest.invocationId,
    artifact.base === manifest.revisions.baseSha,
    artifact.head === manifest.revisions.currentHead,
    artifact.tier === manifest.risk.tier,
  ].every(Boolean);
  if (!identityValid) return false;
  const candidateBase = artifact.candidateBase || artifact.base;
  if (candidateBase !== artifact.base) {
    const carry = manifest.mutationCarry;
    const rebaseCarry = manifest.revisions.baseRebaseCarry;
    const freshRebaseProof = Boolean(
      rebaseCarry &&
      rebaseCarry.head === artifact.head &&
      rebaseCarry.baseSha === candidateBase &&
      carry?.priorHead === rebaseCarry.priorHead &&
      artifact.reusedArtifactSha256 === null &&
      artifact.avoidedSeconds === 0,
    );
    if (
      !freshRebaseProof &&
      (!carry ||
        carry.priorHead !== candidateBase ||
        carry.artifactSha256 !== artifact.reusedArtifactSha256 ||
        !fs.existsSync(carry.artifactPath) ||
        sha256File(carry.artifactPath) !== carry.artifactSha256)
    ) {
      return false;
    }
    if (!freshRebaseProof) {
      const prior = parseJson(
        fs.readFileSync(carry.artifactPath, "utf8"),
        "prior mutation evidence artifact",
      );
      if (
        prior.invocationId !== manifest.invocationId ||
        prior.base !== manifest.revisions.baseSha ||
        prior.head !== candidateBase ||
        prior.tier !== manifest.risk.tier ||
        !validMutationPaths(prior.mutatedPaths) ||
        prior.testFailureObserved !== true
      ) {
        return false;
      }
    }
  }
  if (["gitlink-skip", "no-mutable-source"].includes(artifact.method)) {
    // A diff with no executable source to mutate. This is a distinct,
    // legitimately evidenced outcome from a revert that failed to prove
    // anything — testFailureObserved is false because no revert was
    // attempted, and mutatedPaths is empty because nothing was reverted.
    //
    //   gitlink-skip       every entry is a submodule/gitlink pointer bump
    //   no-mutable-source  entries exist but none is executable source, e.g.
    //                      a dependency bump touching only package.json and
    //                      package-lock.json
    //
    // The emitting gate only reaches either branch when its executable-source
    // candidate set is empty, so neither can mask a real mutation failure.
    return (
      Array.isArray(artifact.mutatedPaths) &&
      artifact.mutatedPaths.length === 0 &&
      artifact.testFailureObserved === false
    );
  }
  return [
    ["revert-diff", "stryker"].includes(artifact.method),
    validMutationPaths(artifact.mutatedPaths),
    artifact.testFailureObserved === true,
  ].every(Boolean);
}

function mutationEvidenceValid(manifest, options = {}) {
  // An unresolved risk contract means mutation evidence cannot yet be
  // evaluated, so the honest answer is "not valid" — callers that need the
  // pre-resolution "no evidence to contradict" case must opt in explicitly
  // via unresolvedIsVacuous rather than receiving a default pass.
  if (manifest.risk?.resolved !== true) {
    return options.unresolvedIsVacuous === true;
  }
  const tier = manifest.risk?.tier;
  if (["low", "medium"].includes(tier)) return true;
  if (!["high", "critical"].includes(tier)) return false;
  const mutation = manifest.mutation;
  if (!mutation || mutation.head !== manifest.revisions.currentHead) {
    return false;
  }
  if (
    typeof mutation.artifactPath !== "string" ||
    mutation.artifactPath === "" ||
    typeof mutation.artifactSha256 !== "string"
  ) {
    return false;
  }
  if (!fs.existsSync(mutation.artifactPath)) return false;
  if (sha256File(mutation.artifactPath) !== mutation.artifactSha256) {
    return false;
  }
  try {
    const artifact = parseJson(
      fs.readFileSync(mutation.artifactPath, "utf8"),
      "mutation evidence artifact",
    );
    return validMutationArtifact(manifest, artifact);
  } catch {
    return false;
  }
}

function assertMutationEvidence(manifest, acceptedConditions = []) {
  if (mutationEvidenceValid(manifest)) return;
  if (acceptedConditions.includes("mutation:missing")) return;
  throw new Error(
    "required high/critical mutation evidence is missing, stale, or invalid",
  );
}

function recordMutation(manifest, options) {
  if (!["high", "critical"].includes(manifest.risk?.tier)) {
    throw new Error(
      "mutation evidence is only required for high or critical campaigns",
    );
  }
  if (!options.artifact) {
    throw new Error("mutation evidence requires a structured --artifact");
  }
  const artifactPath = path.resolve(options.artifact);
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("mutation evidence artifact must be a regular file");
  }
  const artifact = parseJson(
    fs.readFileSync(artifactPath, "utf8"),
    "mutation evidence artifact",
  );
  if (!validMutationArtifact(manifest, artifact)) {
    throw new Error("mutation evidence artifact identity or result is invalid");
  }
  manifest.mutation = {
    head: manifest.revisions.currentHead,
    artifactPath,
    artifactSha256: sha256File(artifactPath),
    recordedAt: new Date().toISOString(),
  };
}

// A trailer value can never contain a newline (git-interpret-trailers reads
// one logical value per line); reason text is operator-authored free text, so
// collapse any embedded newlines/CR before it ever reaches a commit message.
function singleLineTrailerValue(value) {
  return String(value).replace(/\r?\n/g, " ").trim();
}

function reviewTrailers(manifest) {
  const authorization = reviewAuthorization(manifest);
  return [
    "Reviewed-By: quality",
    `Reviewed-By: ${authorization.provider}`,
    `Quality-Tier: ${authorization.tier}`,
    `Quality-Reviewer: ${authorization.provider}`,
    `Quality-Primary: ${authorization.primary}`,
    `Quality-Fallback: ${authorization.fallback}`,
    `Quality-Findings: ${authorization.blockingCount}`,
    `Quality-Head: ${authorization.head}`,
    `Quality-Base: ${authorization.base}`,
    ...(authorization.contractVersion >= 2
      ? [
          `Quality-Contract: ${authorization.contractVersion}`,
          `Quality-Leads: ${authorization.leads}`,
          `Quality-Review-Status: ${authorization.reviewStatus}`,
          `Quality-Policy: ${authorization.policyDigest}`,
          `Quality-Agents: ${authorization.agentsSha256}`,
          `Quality-Domain: ${authorization.domain}`,
          `Quality-Selection: ${authorization.selectionRule}`,
          `Quality-Repository: ${authorization.repositoryKey}`,
          `Quality-Diff: ${authorization.diffSha256}`,
          `Quality-Review-Evidence: ${authorization.evidenceSha256}`,
        ]
      : []),
    // Operator-override merges must never look like a clean auto-merge:
    // these trailers are additive to (never a replacement for) the evidence
    // trailers above, so the original gate/review/CI status the operator
    // accepted stays visible and reconstructable from the persisted manifest
    // and its artifacts (BUI-575 requirement 6).
    ...(authorization.operatorOverride
      ? [
          `Quality-Override: ${authorization.override.scope}`,
          `Quality-Override-Reason: ${singleLineTrailerValue(authorization.overrideReason || "")}`,
          `Quality-Override-Accepted: ${(authorization.overrideAcceptedConditions || []).join(",")}`,
          `Quality-Override-Approver: ${singleLineTrailerValue(authorization.overrideApprover || "")}`,
        ]
      : []),
  ].join("\n");
}

// This is a deliberate, narrow operator decision bound to the exact
// condition ids the capability was signed against
// (manifest.approval.acceptedConditions). Deterministic gate and mutation
// evidence still gate the merge UNLESS the specific failing gate/mutation
// condition id was explicitly accepted — an override never silently widens
// beyond what the operator named. PR identity/freshness and CI still run in
// the merge scripts regardless of what was accepted here.
function operatorOverrideAuthorization(manifest) {
  const acceptedConditions = manifest.approval.acceptedConditions || [];
  verifyGateEvidence(manifest, acceptedConditions);
  if (["high", "critical"].includes(manifest.risk?.tier)) {
    assertMutationEvidence(manifest, acceptedConditions);
  }
  const base = manifest.revisions.baseSha;
  const diffSha256 = crypto
    .createHash("sha256")
    .update(
      reviewDiffBuffer(
        manifest.repo.realpath,
        base,
        manifest.revisions.currentHead,
      ),
    )
    .digest("hex");
  const evidenceSha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(manifest.approval)))
    .digest("hex");
  return {
    base,
    head: manifest.revisions.currentHead,
    provider: "operator-quality-override",
    primary: "unavailable",
    fallback: "unavailable",
    tier: manifest.risk.tier,
    blockingCount: 0,
    leads: 0,
    reviewStatus: "incomplete",
    contractVersion: manifest.reviewContractVersion || 1,
    policyDigest: manifest.risk.reviewPolicyDigest || null,
    agentsSha256: agentsSha256(manifest),
    domain: manifest.panel?.domain || "operator-override",
    selectionRule: manifest.panel?.rule || "operator-override",
    repositoryKey: manifest.repo.githubRepository || manifest.repo.key,
    diffSha256,
    evidenceSha256,
    operatorOverride: true,
    overrideReason: manifest.approval.reason,
    overrideAcceptedConditions: acceptedConditions,
    overrideApprover: manifest.approval.approver,
    override: {
      scope: manifest.approval.scope,
      reason: manifest.approval.reason,
      acceptedConditions,
      approver: manifest.approval.approver,
      issuedAt: manifest.approval.issuedAt,
      expiresAt: manifest.approval.expiresAt,
      artifactSha256: manifest.approval.artifactSha256,
    },
  };
}

function isOperatorOverrideActive(manifest) {
  const accepted = manifest.approval?.acceptedConditions || [];
  return (
    approvalValid(manifest, manifest.repo.realpath) &&
    (manifest.approval?.scope === "operator-quality-override" ||
      (manifest.approval?.scope === "operator-nonstrict-refcas-override" &&
        accepted.includes("review:provider-exhaustion")))
  );
}

function assertJudgeResultFresh(manifest, covered, evidenceSha256) {
  if (
    manifest.judge?.head !== manifest.revisions.currentHead ||
    manifest.judge?.reviewCount !== covered.length ||
    manifest.judge?.evidenceSha256 !== evidenceSha256
  ) {
    throw new Error(
      "judge result is missing, stale, or not bound to review evidence",
    );
  }
}

function assertPersistedJudgeArtifactIntact(
  manifest,
  judgeArtifact,
  covered,
  evidenceSha256,
  persistedBlockingCount,
) {
  const artifactMatches =
    sha256File(manifest.judge.artifactPath) === manifest.judge.artifactSha256 &&
    judgeArtifact.head === manifest.revisions.currentHead &&
    judgeArtifact.invocationId === manifest.invocationId &&
    judgeArtifact.repositoryKey === manifest.repo.key;
  const coverageMatches =
    judgeArtifact.reviewCount === covered.length &&
    judgeArtifact.evidenceSha256 === evidenceSha256 &&
    persistedBlockingCount === manifest.judge.blockingCount;
  if (!artifactMatches || !coverageMatches) {
    throw new Error("persisted judge artifact is stale or has been modified");
  }
}

function reviewAuthorization(manifest) {
  // This is the authoritative provider-neutral merge evidence boundary. Repeat
  // the strength assertion here so a caller cannot bypass resume/advance and
  // authorize review artifacts produced under a stale, weaker risk contract.
  assertCurrentReviewStrength(manifest, manifest.repo.realpath);
  if (isOperatorOverrideActive(manifest)) {
    return operatorOverrideAuthorization(manifest);
  }
  const retry = incompleteRetryStatus(manifest);
  if (retry.state === "pending") {
    throw new Error(
      "provider review requires its authorized same-range retry before merge authorization",
    );
  }
  // An exhausted retry is durable evidence that the configured provider set
  // was given its bounded chance. The review remains explicitly incomplete;
  // deterministic gates, CI, exact-head freshness, and branch protection are
  // still authoritative. Do not turn provider availability into a hidden
  // human-intervention gate.
  const authorization = reviewCoverage(manifest);
  const covered = authorizationReviews(manifest);
  const evidenceSha256 = crypto
    .createHash("sha256")
    .update(reviewedEvidence(manifest))
    .digest("hex");
  if ((manifest.reviewContractVersion || 1) >= 2) {
    const leads = providerFindings(manifest).length;
    const reviewStatus = covered.every((review) => review.status === "exempt")
      ? "policy-exempt"
      : covered.some((review) => review.status === "incomplete")
        ? "incomplete"
        : "complete";
    assertMutationEvidence(manifest);
    return {
      ...authorization,
      blockingCount: 0,
      leads,
      reviewStatus,
      evidenceSha256,
    };
  }
  assertJudgeResultFresh(manifest, covered, evidenceSha256);
  const judgeArtifact = parseJson(
    fs.readFileSync(manifest.judge.artifactPath, "utf8"),
    "persisted judge artifact",
  );
  const persistedBlockingCount = judgeArtifact.findings.filter(
    (finding) => finding.disposition === "BLOCKING",
  ).length;
  assertPersistedJudgeArtifactIntact(
    manifest,
    judgeArtifact,
    covered,
    evidenceSha256,
    persistedBlockingCount,
  );
  if (manifest.judge.blockingCount !== 0) {
    throw new Error(
      `${manifest.judge.blockingCount} unresolved BLOCKING finding(s)`,
    );
  }
  assertMutationEvidence(manifest);
  return {
    ...authorization,
    blockingCount: manifest.judge.blockingCount,
    evidenceSha256,
  };
}

function manifestLockSnapshot(lock) {
  const descriptor = fs.openSync(
    lock,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.geteuid?.()) return null;
    return { stat, body: fs.readFileSync(descriptor, "utf8") };
  } finally {
    fs.closeSync(descriptor);
  }
}

function deadLocalManifestOwner(body) {
  let owner;
  try {
    owner = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (
    owner?.hostname !== os.hostname() ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(owner.acquiredAt))
  )
    return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function recoverDeadManifestLock(lock, file) {
  const { manifest } = loadManifest(file);
  const lease = require("./quality-repo-lease");
  if (!lease.hasMetadataGuard(manifest)) return false;
  const observed = manifestLockSnapshot(lock);
  if (!observed || !deadLocalManifestOwner(observed.body)) return false;
  const current = manifestLockSnapshot(lock);
  if (
    !current ||
    !lease.hasMetadataGuard(manifest) ||
    current.stat.dev !== observed.stat.dev ||
    current.stat.ino !== observed.stat.ino ||
    current.body !== observed.body
  )
    return false;
  fs.unlinkSync(lock);
  return true;
}

function withManifestMetadataGuard(file, operation) {
  const { manifest } = loadManifest(file);
  if (manifest.options?.merge !== true || !manifest.repo?.githubRepository)
    return operation();
  const lease = require("./quality-repo-lease");
  if (lease.hasMetadataGuard(manifest)) return operation();
  return lease.withMetadataGuard(manifest, operation);
}

function openManifestLock(lock, file) {
  try {
    return fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      if (recoverDeadManifestLock(lock, file)) {
        return fs.openSync(lock, "wx", 0o600);
      }
      throw new Error(
        "quality manifest is locked; stale locks require explicit operator cleanup",
        { cause: error },
      );
    }
    throw error;
  }
}

function withManifestLockRawGuarded(file, mutation) {
  const lock = `${path.resolve(file)}.lock`;
  const descriptor = openManifestLock(lock, file);
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        processStartedAt: new Date(
          Date.now() - process.uptime() * 1000,
        ).toISOString(),
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    const loaded = loadManifest(file);
    const before = loaded.manifest.manifestRevision;
    mutation(loaded.manifest, loaded.manifestPath);
    const current = loadManifest(file).manifest.manifestRevision;
    if (current !== before) {
      throw new Error("quality manifest changed concurrently");
    }
    saveManifest(loaded.manifestPath, loaded.manifest);
    return loaded.manifest;
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

function withManifestLockRaw(file, mutation) {
  return withManifestMetadataGuard(file, () =>
    withManifestLockRawGuarded(file, mutation),
  );
}

function withManifestLock(file, mutation) {
  const loaded = loadManifest(file);
  if (
    loaded.manifest.options?.merge === true &&
    loaded.manifest.merge?.repositoryLease
  ) {
    return require("./quality-repo-lease").withManifestMutation(
      loaded.manifestPath,
      process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN,
      mutation,
    );
  }
  return withManifestLockRaw(loaded.manifestPath, mutation);
}

// The complete set of ways a campaign can end. Anything not in this set is a
// programming error, not a runtime condition — an unknown terminal cause must
// fail loudly rather than be persisted as an unrecognized string that later
// readers silently treat as "not terminal".
const TERMINAL_STATES = new Set([
  "recovering", // signed same-HEAD recovery is active and fenced
  "merged", // evidence complete, PR merged
  "verified-unmerged", // evidence complete, merge deliberately not attempted
  "blocked", // a gate/review/CI failure the operator must resolve
  "timeout", // exceeded a bounded budget (campaign, provider, or gate)
  "interrupted", // signal or host death before any other terminal state
  "superseded", // head moved; this campaign no longer describes the revision
  "policy-superseded", // review policy changed; evidence cannot be reused
  "provider-incomplete", // bounded retry ended without every required report
  "provider-contract-failed", // parsed provider output violated the contract
]);

const NON_REENTERABLE_REVIEW_STATES = new Set([
  "policy-superseded",
  "provider-incomplete",
  "provider-contract-failed",
]);

/**
 * Record the single terminal state of a campaign, write-once.
 *
 * Write-once is the point: interruption and cleanup race, and whichever path
 * runs second must not be able to relabel the outcome. A campaign killed for
 * timeout that then runs a cleanup handler stays "timeout"; it does not become
 * "interrupted" because a signal arrived during teardown. Re-recording the SAME
 * state is a no-op so idempotent cleanup paths are safe to call more than once.
 *
 * Returns the state actually in force (which may differ from `state` when the
 * campaign was already terminal).
 */
function terminalEpoch(manifest) {
  return Number.isSafeInteger(manifest.terminalEpoch) &&
    manifest.terminalEpoch >= 0
    ? manifest.terminalEpoch
    : 0;
}

function requestedTerminalEpoch(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("terminal epoch must be a non-negative integer");
  }
  return parsed;
}

function recordTerminalState(manifestPath, state, detail = null, options = {}) {
  if (!TERMINAL_STATES.has(state)) {
    throw new Error(`unknown terminal state '${state}'`);
  }
  const expectedEpoch = requestedTerminalEpoch(
    options.terminalEpoch ?? process.env.BS_QUALITY_TERMINAL_EPOCH,
  );
  const write = (manifest) => {
    const currentEpoch = terminalEpoch(manifest);
    if (expectedEpoch !== null && expectedEpoch !== currentEpoch) {
      throw new Error("terminal writer epoch is stale");
    }
    if (
      manifest.terminalState &&
      !(
        manifest.terminalState.state === "recovering" &&
        expectedEpoch === currentEpoch
      )
    ) {
      return manifest.terminalState.state;
    }
    manifest.terminalState = {
      state,
      detail: detail ? String(detail).slice(0, 500) : null,
      head: manifest.revisions?.currentHead ?? null,
      terminalEpoch: currentEpoch,
      recordedAt: new Date().toISOString(),
    };
    return state;
  };
  // Written under the manifest lock, but persisted WITHOUT bumping
  // manifestRevision. A terminal state is metadata about a campaign that has
  // already ended, not a state transition another writer contends for, and the
  // recorder runs as a separate process after the failing step has exited.
  // Bumping the revision would make an enclosing withManifestLock() in that
  // step's own transaction see a phantom "concurrent writer" —
  // quality-invocation.test.js pins exactly this for the abandoned-execution
  // reconciliation path. withManifestLock() cannot be used here because it
  // unconditionally calls saveManifest() (which does bump) on return.
  const initial = loadManifest(manifestPath);
  if (
    initial.manifest.options?.merge === true &&
    initial.manifest.merge?.repositoryLease
  ) {
    return require("./quality-repo-lease").withManifestMutation(
      initial.manifestPath,
      process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN,
      write,
    ).terminalState.state;
  }
  return withManifestMetadataGuard(manifestPath, () => {
    const lock = `${path.resolve(manifestPath)}.lock`;
    const descriptor = openManifestLock(lock, manifestPath);
    try {
      const loaded = loadManifest(manifestPath);
      const result = write(loaded.manifest);
      saveManifestMidTransaction(loaded.manifestPath, loaded.manifest);
      return result;
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  });
}

function recordMergeAdmissionBlockedTerminal(
  manifestPath,
  conditions,
  detail = "merge admission blocked",
) {
  if (
    !Array.isArray(conditions) ||
    conditions.length === 0 ||
    !conditions.every((condition) => typeof condition === "string")
  ) {
    throw new Error("merge admission block requires typed condition ids");
  }
  const expectedEpoch = requestedTerminalEpoch(
    process.env.BS_QUALITY_TERMINAL_EPOCH,
  );
  return withManifestLock(manifestPath, (manifest) => {
    const currentEpoch = terminalEpoch(manifest);
    if (expectedEpoch !== null && expectedEpoch !== currentEpoch) {
      throw new Error("terminal writer epoch is stale");
    }
    if (
      manifest.terminalState &&
      !(
        manifest.terminalState.state === "recovering" &&
        expectedEpoch === currentEpoch
      )
    ) {
      throw new Error(
        `cannot record merge admission after terminal state '${manifest.terminalState.state}'`,
      );
    }
    const mergeAttemptId = crypto.randomUUID();
    const recordedAt = new Date().toISOString();
    const typedConditions = [...new Set(conditions)].sort();
    manifest.merge ??= {};
    manifest.merge.admissionBlock = {
      conditions: typedConditions,
      head: manifest.revisions.currentHead,
      terminalEpoch: currentEpoch,
      mergeAttemptId,
      recordedAt,
    };
    manifest.terminalState = {
      state: "blocked",
      detail: String(detail).slice(0, 500),
      head: manifest.revisions.currentHead,
      terminalEpoch: currentEpoch,
      mergeAttemptId,
      mergeAdmissionConditions: typedConditions,
      recordedAt,
    };
    return manifest.terminalState;
  });
}

function clearMergeAdmissionBlock(manifestPath) {
  let cleared = false;
  withManifestLock(manifestPath, (manifest) => {
    if (!manifest.merge?.admissionBlock) return;
    delete manifest.merge.admissionBlock;
    cleared = true;
  });
  return cleared;
}

function matchingCiAdmissionBlock(manifest) {
  const terminal = manifest.terminalState;
  const admission = manifest.merge?.admissionBlock;
  return Boolean(
    terminal?.state === "blocked" &&
    terminal.head === manifest.revisions.currentHead &&
    admission?.head === terminal.head &&
    Number.isInteger(terminal.terminalEpoch) &&
    admission.terminalEpoch === terminal.terminalEpoch &&
    typeof terminal.mergeAttemptId === "string" &&
    terminal.mergeAttemptId.length > 0 &&
    admission.mergeAttemptId === terminal.mergeAttemptId &&
    JSON.stringify(terminal.mergeAdmissionConditions) ===
      JSON.stringify(["ci:failed"]) &&
    JSON.stringify(admission.conditions) === JSON.stringify(["ci:failed"]),
  );
}

function githubJson(root, args, label) {
  const result = spawnSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || "").trim()}`);
  }
  return parseJson(result.stdout, label);
}

function resolveGreenCiAdmissionBlock(manifestPath, adapters = {}) {
  const initial = loadManifest(manifestPath).manifest;
  if (!matchingCiAdmissionBlock(initial)) return false;
  const readPullRequest =
    adapters.readPullRequest ??
    ((manifest) =>
      githubJson(
        manifest.repo.realpath,
        [
          "pr",
          "view",
          String(manifest.repo.pr),
          "--repo",
          manifest.repo.githubRepository,
          "--json",
          "state,headRefOid",
        ],
        "current pull request",
      ));
  const readChecks =
    adapters.readChecks ??
    ((manifest) =>
      githubJson(
        manifest.repo.realpath,
        [
          "pr",
          "checks",
          String(manifest.repo.pr),
          "--repo",
          manifest.repo.githubRepository,
          "--json",
          "state",
        ],
        "current pull request checks",
      ));
  const pullRequest = readPullRequest(initial);
  if (
    pullRequest?.state !== "OPEN" ||
    pullRequest.headRefOid !== initial.revisions.currentHead
  ) {
    throw new Error("green CI resolution requires the open exact-head PR");
  }
  const checks = readChecks(initial);
  const greenStates = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    checks.some((check) => !greenStates.has(check?.state))
  ) {
    throw new Error("green CI resolution requires current registered checks");
  }
  const expectedAttemptId = initial.terminalState.mergeAttemptId;
  let resolved = false;
  withManifestLock(manifestPath, (manifest) => {
    if (
      !matchingCiAdmissionBlock(manifest) ||
      manifest.terminalState.mergeAttemptId !== expectedAttemptId
    ) {
      throw new Error("CI admission block changed during green CI resolution");
    }
    if (
      manifest.terminalHistory !== undefined &&
      !Array.isArray(manifest.terminalHistory)
    ) {
      throw new Error("terminal history is malformed");
    }
    const resolvedAt = new Date().toISOString();
    const nextEpoch = terminalEpoch(manifest) + 1;
    manifest.terminalHistory ??= [];
    manifest.terminalHistory.push({
      ...manifest.terminalState,
      disposition: "resolved-by-green-ci",
      resolvedAt,
    });
    manifest.terminalHistory.push({
      event: "reopened-by-green-ci",
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
      checkCount: checks.length,
      recordedAt: resolvedAt,
    });
    manifest.terminalEpoch = nextEpoch;
    delete manifest.terminalState;
    delete manifest.merge.admissionBlock;
    resolved = true;
  });
  return resolved;
}

function recoveryScope(manifest, terminal) {
  const conditions = terminal?.mergeAdmissionConditions;
  const admission = manifest.merge?.admissionBlock;
  const normalizedConditions = Array.isArray(conditions)
    ? [...new Set(conditions)].sort()
    : null;
  const normalizedAdmissionConditions = Array.isArray(admission?.conditions)
    ? [...new Set(admission.conditions)].sort()
    : null;
  if (
    !Array.isArray(conditions) ||
    conditions.length === 0 ||
    !conditions.every((condition) => typeof condition === "string") ||
    !admission ||
    admission.head !== manifest.revisions.currentHead ||
    admission.head !== terminal.head ||
    !Number.isInteger(terminal.terminalEpoch) ||
    admission.terminalEpoch !== terminal.terminalEpoch ||
    typeof terminal.mergeAttemptId !== "string" ||
    terminal.mergeAttemptId.length === 0 ||
    admission.mergeAttemptId !== terminal.mergeAttemptId ||
    JSON.stringify(normalizedAdmissionConditions) !==
      JSON.stringify(normalizedConditions) ||
    !approvalValid(manifest) ||
    !conditions.every((condition) =>
      manifest.approval.acceptedConditions.includes(condition),
    )
  ) {
    return null;
  }
  if (conditions.length === 1 && conditions[0] === "ci:failed") {
    return ciBillingCapabilityValid(manifest) ? manifest.approval.scope : null;
  }
  const refCas = protectedNonstrictRefCasCapability(manifest);
  if (
    !refCas ||
    !conditions.includes("base:protected-nonstrict") ||
    !conditions.includes("pr:non-atomic-state")
  ) {
    return null;
  }
  // A ref-CAS capability may also carry the independently valid CI or
  // review-exhaustion conditions. The capability validator owns the complete
  // accepted-condition shape; recovery only requires that its blocked
  // admission conditions remain covered by that signed capability.
  return manifest.approval.scope;
}

const PRE_REVIEW_SELECTION_FAILURE = "pre-review-selection-failed";
const SELECTION_RUNTIME_FILES = Object.freeze(["quality-select-agents.sh"]);
const NON_SELECTION_RUNTIME_FILES = Object.freeze([
  "quality-run.js",
  "quality-risk-resolve.sh",
  "quality-runtime-plan.js",
  "quality-run-gate.sh",
  "quality-run-review.sh",
  "quality-mutation-check.sh",
  "quality-authorize-review-round.sh",
  "quality-stamp-and-merge.sh",
]);

function recoveryDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

function sameRuntimeInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readCanonicalRuntimeFile(runtimeDir, relative, cohort) {
  const segments = relative.split("/");
  const directories = [runtimeDir];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(path.join(runtimeDir, ...segments.slice(0, index)));
  }
  const openedDirectories = [];
  let fileDescriptor = null;
  try {
    for (const directory of directories) {
      const descriptor = fs.openSync(
        directory,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(descriptor);
      if (!stat.isDirectory() || fs.realpathSync(directory) !== directory) {
        fs.closeSync(descriptor);
        throw new Error(`${cohort} runtime ancestry is not canonical`);
      }
      openedDirectories.push({ descriptor, directory, stat });
    }
    const candidate = path.join(runtimeDir, relative);
    if (fs.realpathSync(candidate) !== candidate) {
      throw new Error(`${cohort} runtime dependency is not canonical`);
    }
    fileDescriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const fileStat = fs.fstatSync(fileDescriptor);
    if (!fileStat.isFile()) {
      throw new Error(`${cohort} runtime dependency is not a regular file`);
    }
    for (const opened of openedDirectories) {
      const current = fs.lstatSync(opened.directory);
      if (!current.isDirectory() || !sameRuntimeInode(current, opened.stat)) {
        throw new Error(`${cohort} runtime ancestry changed during inspection`);
      }
    }
    const currentFile = fs.lstatSync(candidate);
    if (!currentFile.isFile() || !sameRuntimeInode(currentFile, fileStat)) {
      throw new Error(`${cohort} runtime dependency changed during inspection`);
    }
    return fs.readFileSync(fileDescriptor);
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    for (const opened of openedDirectories.reverse()) {
      fs.closeSync(opened.descriptor);
    }
  }
}

// The runner and its shell entrypoint can be upgraded while a terminal
// manifest exists. Hash each explicitly owned source file by its canonical
// relative name and bytes. The fixed cohorts are deliberate: an unlisted,
// missing, linked, or non-regular file fails closed rather than becoming an
// implicit recovery dependency.
function runtimeCohortDigest(
  files,
  cohort,
  discoverDependencies = false,
  runtimeDir = __dirname,
) {
  const pending = [...files];
  const seen = new Set();
  const entries = [];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (seen.has(relative)) continue;
    if (
      !relative
        .split("/")
        .every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
    ) {
      throw new Error(`${cohort} runtime dependency name is malformed`);
    }
    const bytes = readCanonicalRuntimeFile(runtimeDir, relative, cohort);
    const source = bytes.toString("utf8");
    seen.add(relative);
    entries.push([relative, bytes]);
    if (!discoverDependencies) continue;
    if (relative.endsWith(".js")) {
      const calls = source.matchAll(/\brequire\(\s*([^)]*?)\s*\)/g);
      for (const call of calls) {
        const argument = call[1];
        const match = argument.match(/^(["'])(\.\/[^"']+)\1$/);
        if (!match) {
          if (/^(["'])(?:node:)?[A-Za-z0-9:_-]+\1$/.test(argument)) {
            continue;
          }
          throw new Error(`${cohort} runtime has an unknown dependency`);
        }
        const basename = match[2].slice(2);
        const resolved = basename.endsWith(".js") ? basename : `${basename}.js`;
        pending.push(resolved);
      }
    } else if (relative.endsWith(".sh")) {
      const references = source.matchAll(
        /\$(?:SCRIPT_DIR|script_dir)\/([A-Za-z0-9._/-]+)/g,
      );
      for (const reference of references) {
        // Directory navigation computes KIT_ROOT; it does not read a source
        // dependency. File references, including nested schemas, are sealed.
        if (reference[1] === "..") continue;
        pending.push(reference[1]);
      }
    } else if (!relative.endsWith(".json")) {
      throw new Error(`${cohort} runtime dependency type is unsupported`);
    }
  }
  const hash = crypto.createHash("sha256");
  for (const [relative, bytes] of entries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(relative).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

function selectionRuntimeDigests(runtimeDir = __dirname) {
  return {
    selector: runtimeCohortDigest(
      SELECTION_RUNTIME_FILES,
      "selector",
      true,
      runtimeDir,
    ),
    remaining: runtimeCohortDigest(
      NON_SELECTION_RUNTIME_FILES,
      "non-selector",
      true,
      runtimeDir,
    ),
  };
}

function zeroSelectionExecution(manifest) {
  const governor = manifest.governor || {};
  return (
    manifest.panel == null &&
    Array.isArray(manifest.gates) &&
    manifest.gates.length === 0 &&
    Array.isArray(manifest.reviews) &&
    manifest.reviews.length === 0 &&
    !manifest.mutation &&
    !manifest.judge &&
    !governor.activeExecution &&
    governor.gateSecondsUsed === 0 &&
    governor.providerSecondsUsed === 0 &&
    governor.activeSecondsUsed === 0 &&
    governor.roundsUsed === 0 &&
    Array.isArray(governor.providerAttempts) &&
    governor.providerAttempts.length === 0 &&
    Array.isArray(governor.authorizedAttempts) &&
    governor.authorizedAttempts.length === 0
  );
}

function selectionRecoveryCheckpoint(manifest) {
  const lease = manifest.merge?.repositoryLease;
  if (
    manifest.options?.merge !== true ||
    !Number.isSafeInteger(lease?.generation) ||
    lease.generation < 1
  ) {
    throw new Error("selection recovery requires the exact repository lease");
  }
  if (!zeroSelectionExecution(manifest)) {
    throw new Error("selection recovery requires zero execution evidence");
  }
  const runtime = selectionRuntimeDigests();
  return {
    schemaVersion: 1,
    repository: {
      key: manifest.repo.key,
      githubRepository: manifest.repo.githubRepository,
      realpath: manifest.repo.realpath,
    },
    revisions: {
      baseSha: manifest.revisions.baseSha,
      head: manifest.revisions.currentHead,
    },
    terminalEpoch: terminalEpoch(manifest),
    leaseGeneration: lease.generation,
    riskDigest: recoveryDigest(manifest.risk),
    reviewPolicyDigest: manifest.risk?.reviewPolicyDigest || null,
    requiredGatesDigest: recoveryDigest(manifest.requiredGates),
    selectorRuntimeDigest: runtime.selector,
    remainingRuntimeDigest: runtime.remaining,
    execution: {
      gateCount: manifest.gates.length,
      reviewCount: manifest.reviews.length,
      gateSecondsUsed: manifest.governor.gateSecondsUsed,
      providerSecondsUsed: manifest.governor.providerSecondsUsed,
      activeSecondsUsed: manifest.governor.activeSecondsUsed,
      providerAttempts: manifest.governor.providerAttempts.length,
      authorizedAttempts: manifest.governor.authorizedAttempts.length,
      roundsUsed: manifest.governor.roundsUsed,
    },
  };
}

function sameSelectionRecoveryCheckpoint(manifest, checkpoint) {
  if (!checkpoint || checkpoint.schemaVersion !== 1) return false;
  const current = selectionRecoveryCheckpoint(manifest);
  return (
    checkpoint.repository?.key === current.repository.key &&
    checkpoint.repository?.githubRepository ===
      current.repository.githubRepository &&
    checkpoint.repository?.realpath === current.repository.realpath &&
    checkpoint.revisions?.baseSha === current.revisions.baseSha &&
    checkpoint.revisions?.head === current.revisions.head &&
    checkpoint.terminalEpoch === current.terminalEpoch &&
    checkpoint.leaseGeneration === current.leaseGeneration &&
    checkpoint.riskDigest === current.riskDigest &&
    checkpoint.reviewPolicyDigest === current.reviewPolicyDigest &&
    checkpoint.requiredGatesDigest === current.requiredGatesDigest &&
    checkpoint.remainingRuntimeDigest === current.remainingRuntimeDigest &&
    JSON.stringify(checkpoint.execution) === JSON.stringify(current.execution)
  );
}

function recordPreReviewSelectionFailure(manifestPath, detail, exitCode) {
  if (!Number.isInteger(exitCode) || exitCode === 0) {
    throw new Error(
      "selection failure requires an actual nonzero selector exit",
    );
  }
  let terminal;
  withManifestLock(manifestPath, (manifest) => {
    validateIdentity(manifest, manifest.repo.realpath);
    if (manifest.terminalState) {
      terminal = manifest.terminalState;
      return;
    }
    const checkpoint = selectionRecoveryCheckpoint(manifest);
    terminal = {
      state: "blocked",
      failureCode: PRE_REVIEW_SELECTION_FAILURE,
      phase: "panel",
      selectorExitCode: exitCode,
      detail: String(detail).slice(0, 500),
      head: manifest.revisions.currentHead,
      terminalEpoch: terminalEpoch(manifest),
      selectionRecovery: checkpoint,
      recordedAt: new Date().toISOString(),
    };
    manifest.terminalState = terminal;
  });
  return terminal;
}

function resumePreReviewSelectionFailure(manifestPath) {
  const initial = loadManifest(manifestPath).manifest;
  const terminal = initial.terminalState;
  if (
    terminal?.state !== "blocked" ||
    terminal.failureCode !== PRE_REVIEW_SELECTION_FAILURE ||
    terminal.phase !== "panel" ||
    terminal.head !== initial.revisions.currentHead ||
    terminal.terminalEpoch !== terminalEpoch(initial) ||
    initial.selectionRecovery
  ) {
    return null;
  }
  let resumed = null;
  withManifestLock(manifestPath, (manifest) => {
    const currentTerminal = manifest.terminalState;
    const checkpointMatches = (() => {
      try {
        return sameSelectionRecoveryCheckpoint(
          manifest,
          currentTerminal?.selectionRecovery,
        );
      } catch {
        // A malformed or changed runtime/execution cohort is ineligible. Keep
        // its typed terminal intact so the operator can inspect the failure.
        return false;
      }
    })();
    if (
      currentTerminal?.state !== "blocked" ||
      currentTerminal.failureCode !== PRE_REVIEW_SELECTION_FAILURE ||
      currentTerminal.phase !== "panel" ||
      currentTerminal.head !== manifest.revisions.currentHead ||
      currentTerminal.terminalEpoch !== terminalEpoch(manifest) ||
      manifest.selectionRecovery ||
      !checkpointMatches
    ) {
      return;
    }
    const currentRuntime = selectionRuntimeDigests();
    if (
      currentTerminal.selectionRecovery.selectorRuntimeDigest ===
      currentRuntime.selector
    ) {
      return;
    }
    if (
      manifest.terminalHistory !== undefined &&
      !Array.isArray(manifest.terminalHistory)
    ) {
      throw new Error("terminal history is malformed");
    }
    const recoveredAt = new Date().toISOString();
    const nextEpoch = terminalEpoch(manifest) + 1;
    manifest.terminalHistory ??= [];
    manifest.terminalHistory.push({
      ...currentTerminal,
      disposition: "superseded-by-selection-recovery",
      recoveredAt,
      newSelectorRuntimeDigest: currentRuntime.selector,
    });
    manifest.terminalHistory.push({
      event: "reopened-by-selection-recovery",
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
      oldSelectorRuntimeDigest:
        currentTerminal.selectionRecovery.selectorRuntimeDigest,
      newSelectorRuntimeDigest: currentRuntime.selector,
      recordedAt: recoveredAt,
    });
    manifest.selectionRecovery = {
      schemaVersion: 1,
      terminalEpoch: currentTerminal.terminalEpoch,
      oldSelectorRuntimeDigest:
        currentTerminal.selectionRecovery.selectorRuntimeDigest,
      newSelectorRuntimeDigest: currentRuntime.selector,
      recoveredAt,
    };
    manifest.terminalEpoch = nextEpoch;
    delete manifest.terminalState;
    delete manifest.panel;
    resumed = {
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
    };
  });
  return resumed;
}

function mergeReadRecoveryEligible(manifest) {
  const terminal = manifest.terminalState;
  const orchestration = manifest.orchestration;
  const failure = manifest.merge?.readFailure;
  const historical = terminal?.detail === "merge admission failed with exit 1";
  const typed =
    terminal?.detail === "ci-admission-read-failed" &&
    failure?.kind === "ci-admission-read-failed" &&
    failure.exitCode === 75 &&
    failure.head === manifest.revisions.currentHead;
  return Boolean(
    manifest.options?.merge === true &&
    manifest.merge?.repositoryLease &&
    terminal?.state === "blocked" &&
    terminal.head === manifest.revisions.currentHead &&
    (historical || typed) &&
    !manifest.merge.readRecovery &&
    !manifest.merge.admissionBlock &&
    !terminal.mergeAdmissionConditions &&
    !manifest.governor?.activeExecution &&
    orchestration?.head === terminal.head &&
    orchestration.phase === "merge" &&
    orchestration.steps?.merge?.status === "running" &&
    orchestration.steps.merge.attempts === 1,
  );
}

// Only the caller that commits this transition receives a continuation grant.
// A persisted recovering sentinel cannot reconstruct that grant after a crash.
function resumeMergeReadFailure(manifestPath, dependencies = {}) {
  const initial = loadManifest(manifestPath).manifest;
  if (!mergeReadRecoveryEligible(initial)) return null;
  const readPullRequest =
    dependencies.readPullRequest ||
    ((manifest) =>
      parseJson(
        execFileSync(
          "gh",
          [
            "pr",
            "view",
            String(manifest.repo.pr),
            "--repo",
            manifest.repo.githubRepository,
            "--json",
            "state,headRefOid",
          ],
          { cwd: manifest.repo.realpath, encoding: "utf8", timeout: 30000 },
        ),
        "current pull request",
      ));
  const readChecks =
    dependencies.readChecks ||
    ((manifest) =>
      parseJson(
        execFileSync(
          "gh",
          [
            "pr",
            "checks",
            String(manifest.repo.pr),
            "--repo",
            manifest.repo.githubRepository,
            "--json",
            "state",
          ],
          { cwd: manifest.repo.realpath, encoding: "utf8", timeout: 30000 },
        ),
        "current pull request checks",
      ));
  let grant = null;
  require("./quality-repo-lease").withManifestMutation(
    manifestPath,
    process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN,
    (manifest) => {
      if (!mergeReadRecoveryEligible(manifest)) return;
      validateIdentity(manifest, manifest.repo.realpath);
      verifyGateEvidence(manifest);
      reviewAuthorization(manifest);
      const pr = readPullRequest(manifest);
      if (
        pr?.state !== "OPEN" ||
        pr.headRefOid !== manifest.revisions.currentHead
      )
        throw new Error("merge-read recovery requires the open exact-head PR");
      const checks = readChecks(manifest);
      if (
        !Array.isArray(checks) ||
        checks.length === 0 ||
        checks.some(
          (check) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check?.state),
        )
      )
        throw new Error(
          "merge-read recovery requires current nonempty green checks",
        );
      if (
        manifest.terminalHistory !== undefined &&
        !Array.isArray(manifest.terminalHistory)
      )
        throw new Error("terminal history is malformed");
      const recordedAt = new Date().toISOString();
      const epoch = terminalEpoch(manifest) + 1;
      manifest.terminalHistory ??= [];
      manifest.terminalHistory.push({
        ...manifest.terminalState,
        disposition: "reentered-merge-read-failure",
        supersededAt: recordedAt,
      });
      manifest.terminalEpoch = epoch;
      manifest.merge.readRecovery = {
        head: manifest.revisions.currentHead,
        terminalEpoch: epoch,
        recordedAt,
      };
      manifest.terminalState = {
        state: "recovering",
        head: manifest.revisions.currentHead,
        terminalEpoch: epoch,
        recordedAt,
        recovery: { kind: "merge-read-failure" },
      };
      grant = { head: manifest.revisions.currentHead, terminalEpoch: epoch };
    },
    { requireIdle: true },
  );
  return grant;
}

function resumeInterruptedTerminal(manifestPath) {
  const initial = loadManifest(manifestPath);
  const initialTerminal = initial.manifest.terminalState;
  if (
    initialTerminal?.state !== "interrupted" ||
    initialTerminal.head !== initial.manifest.revisions.currentHead ||
    initial.manifest.governor?.activeExecution
  ) {
    return null;
  }
  let resumed = null;
  withManifestLock(manifestPath, (manifest) => {
    const terminal = manifest.terminalState;
    if (
      terminal?.state !== "interrupted" ||
      terminal.head !== manifest.revisions.currentHead ||
      manifest.governor?.activeExecution
    ) {
      return;
    }
    if (
      manifest.terminalHistory !== undefined &&
      !Array.isArray(manifest.terminalHistory)
    ) {
      throw new Error("terminal history is malformed");
    }
    const resumedAt = new Date().toISOString();
    const nextEpoch = terminalEpoch(manifest) + 1;
    manifest.terminalHistory ??= [];
    manifest.terminalHistory.push({
      ...terminal,
      disposition: "resumed-after-interruption",
      resumedAt,
    });
    manifest.terminalHistory.push({
      event: "reopened-after-interruption",
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
      recordedAt: resumedAt,
    });
    manifest.terminalEpoch = nextEpoch;
    delete manifest.terminalState;
    resumed = {
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
    };
  });
  return resumed;
}

function resumeRecoverableTerminal(manifestPath) {
  const initial = loadManifest(manifestPath);
  if (initial.manifest.options?.merge !== true) return null;
  const initialTerminal = initial.manifest.terminalState;
  if (
    !initialTerminal ||
    initialTerminal.head !== initial.manifest.revisions.currentHead ||
    !["blocked", "recovering"].includes(initialTerminal.state) ||
    !recoveryScope(
      initial.manifest,
      initialTerminal.state === "recovering"
        ? initialTerminal.recovery
        : initialTerminal,
    )
  ) {
    return null;
  }
  // withManifestLock deliberately returns the persisted manifest, not the
  // mutation's return value. Keep the recovery result outside that wrapper so
  // a lock-time refusal cannot be mistaken for a successful reopen.
  let recovered = null;
  withManifestLock(manifestPath, (manifest) => {
    const terminal = manifest.terminalState;
    if (!terminal || terminal.head !== manifest.revisions.currentHead)
      return null;
    if (!["blocked", "recovering"].includes(terminal.state)) return null;
    const recoveryEvidence =
      terminal.state === "recovering" ? terminal.recovery : terminal;
    const scope = recoveryScope(manifest, recoveryEvidence);
    if (!scope) return;
    reviewCoverage(manifest);
    if (
      manifest.terminalHistory !== undefined &&
      !Array.isArray(manifest.terminalHistory)
    ) {
      throw new Error("terminal history is malformed");
    }
    const nextEpoch = terminalEpoch(manifest) + 1;
    const recoveredAt = new Date().toISOString();
    manifest.terminalHistory ??= [];
    if (terminal.state === "blocked") {
      manifest.terminalHistory.push({
        ...terminal,
        disposition: "superseded-by-capability",
        supersededAt: recoveredAt,
        capabilityScope: scope,
      });
    }
    manifest.terminalHistory.push({
      event: "reopened-by-capability",
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
      capabilityScope: scope,
      recordedAt: recoveredAt,
    });
    manifest.terminalEpoch = nextEpoch;
    manifest.terminalState = {
      state: "recovering",
      head: manifest.revisions.currentHead,
      terminalEpoch: nextEpoch,
      recordedAt: recoveredAt,
      recovery: {
        mergeAdmissionConditions: recoveryEvidence.mergeAdmissionConditions,
        capabilityScope: scope,
      },
    };
    recovered = manifest.terminalState;
  });
  return recovered;
}

function isTerminal(manifest) {
  return Boolean(manifest?.terminalState);
}

function getPath(value, dottedPath) {
  return dottedPath
    .split(".")
    .reduce((current, part) => current?.[part], value);
}

function printValue(value) {
  if (value === undefined || value === null) return;
  process.stdout.write(
    typeof value === "object" ? JSON.stringify(value) : String(value),
  );
}

function mutate(manifestArg, operation) {
  return withManifestLock(manifestArg, (locked, manifestPath) => {
    validateIdentity(locked, locked.repo.realpath);
    try {
      operation(locked);
    } catch (error) {
      // A provider may have completed before an evidence write fails (for
      // example, because the authoritative PR-head API is unavailable). Do
      // not leave that execution marked active: it would strand the governor
      // and make every retry look like a concurrent provider.
      if (
        locked.governor.activeExecution?.kind === "provider" &&
        [
          "QUALITY_REVIEW_HEAD_MOVED",
          "QUALITY_REVIEW_HEAD_VALIDATION_UNAVAILABLE",
        ].includes(error?.code)
      ) {
        completeActiveExecution(locked, "provider");
        locked.governor.lastActivityAt = new Date().toISOString();
        saveManifestMidTransaction(manifestPath, locked);
      }
      if (error?.code === "QUALITY_REVIEW_HEAD_MOVED") {
        locked.terminalState ??= {
          state: "superseded",
          detail: "head-moved-before-review-record",
          head: locked.revisions.currentHead,
          recordedAt: new Date().toISOString(),
        };
        locked.governor.lastActivityAt = new Date().toISOString();
        saveManifestMidTransaction(manifestPath, locked);
      }
      throw error;
    }
    locked.governor.lastActivityAt = new Date().toISOString();
  });
}

function lifecycleStale(manifest, now = Date.now()) {
  const lastActivity = Date.parse(manifest.governor.lastActivityAt);
  const ttlMilliseconds = manifest.governor.lifecycleTTLSeconds * 1000;
  return (
    !Number.isFinite(lastActivity) ||
    !Number.isFinite(ttlMilliseconds) ||
    now - lastActivity >= ttlMilliseconds
  );
}

const STALE_READ_COMMANDS = new Set([
  "field",
  "get",
  "review-identity",
  "review-info",
  "validate",
]);

// Repo-relative files changed across the reviewed base..head, quoted-path safe.
function reviewedChangedFiles(manifest) {
  const root = manifest.repo.realpath;
  const range = `${manifest.revisions.baseSha}..${manifest.revisions.currentHead}`;
  // -z NUL-delimits and -c core.quotepath=false keeps non-ASCII paths literal,
  // so a file with an accented/space name cannot slip past the matcher.
  // --no-renames represents a rename as delete(old)+add(new) so BOTH paths are
  // surfaced; without it git collapses a rename to the destination only, letting
  // `auth/x.js -> src/x.js` hide the sensitive origin from the floor matcher
  // (Codex + security-auditor review: rename-hides-path exploit).
  const out = git(root, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    range,
  ]);
  return out.split("\0").filter(Boolean);
}

// True when the reviewed change touches the always-human security floor.
// An EMPTY changed-file set fails closed (returns true → human required): the
// relaxation must never proceed having verified nothing. base==head, a bad
// range, or a zero-file diff all mean "could not prove clear", which is NOT
// "clear". A git error inside reviewedChangedFiles throws → top-level exit 1,
// which the caller also treats as human-required.
function humanFloorCheck(manifest) {
  const cfg = riskScore.loadConfig(manifest.repo.realpath);
  const files = reviewedChangedFiles(manifest);
  if (files.length === 0) return true;
  return riskScore.touchesHumanFloor(files, cfg);
}

function gateSatisfied(manifest, name) {
  const required = manifest.requiredGates.find((gate) => gate.name === name);
  if (!required) throw new Error(`gate '${name}' is not required`);
  return manifest.gates.some(
    (gate) =>
      gate.name === name &&
      gate.head === manifest.revisions.currentHead &&
      ["success", "skipped"].includes(gate.status) &&
      gate.source === required.source &&
      gate.command === required.command &&
      validGateArtifact(gate),
  );
}

function qualityLockOwner(manifest) {
  const invocationId = String(manifest.invocationId || "").trim();
  if (!invocationId) {
    throw new Error("quality lock owner requires an invocation id");
  }
  return `bs:quality/${invocationId}`;
}

const COMMANDS = {
  validate: ({ manifest }) =>
    process.stdout.write(`${manifest.invocationId}\n`),
  risk: ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) => setRisk(locked, parseOptions(rawArgs))),
  agents: ({ manifestArg, manifest, rawArgs }) => {
    const incomplete = rawArgs.includes("--incomplete");
    const separator = rawArgs.indexOf("--");
    const optionArgs = separator === -1 ? [] : rawArgs.slice(0, separator);
    const names = separator === -1 ? rawArgs : rawArgs.slice(separator + 1);
    const options = parseOptions(
      optionArgs.filter((argument) => argument !== "--incomplete"),
    );
    if (
      (manifest.reviewContractVersion || 1) >= 2 &&
      (!options.domain || !options.rule)
    ) {
      throw new Error(
        "contract v2 agent selection requires --domain and --rule",
      );
    }
    mutate(manifestArg, (locked) =>
      setAgents(locked, names, {
        incomplete,
        domain: options.domain || "legacy",
        rule: options.rule || "legacy-panel",
      }),
    );
  },
  "approval-valid": ({ manifest }) => {
    process.exitCode = approvalValid(manifest, manifest.repo.realpath) ? 0 : 1;
  },
  "ci-billing-capability": ({ manifest }) => {
    process.exitCode = ciBillingCapabilityValid(manifest) ? 0 : 1;
  },
  // Scope is intentionally checked separately from validity: a capability
  // signed for one scope (e.g. operator-quality-override) must never satisfy
  // a check gated on a different scope (e.g. operator-ci-billing-override),
  // even though both are "valid" in the signature/expiry/identity sense.
  "approval-scope": ({ manifest, rawArgs }) => {
    const options = parseOptions(rawArgs);
    if (!options.scope) {
      throw new Error("approval-scope requires --scope <name>");
    }
    const valid = approvalValid(manifest, manifest.repo.realpath);
    process.exitCode =
      valid && manifest.approval?.scope === options.scope ? 0 : 1;
  },
  "human-floor-check": ({ manifest }) => {
    // Contract designed so the AUTONOMOUS path is reachable ONLY by an explicit
    // verified-clear result; every other outcome requires a human.
    //   0  = verified clear of the human floor (autonomous critical permitted)
    //   10 = touches the always-human floor (human capability required)
    //   1  = error (top-level catch) → human required (fail closed)
    process.exitCode = humanFloorCheck(manifest) ? 10 : 0;
  },
  "gate-satisfied": ({ manifest, rawArgs }) => {
    const options = parseOptions(rawArgs);
    process.exitCode = gateSatisfied(manifest, options.name) ? 0 : 1;
  },
  "provider-attempt": ({ manifestArg, rawArgs }) => {
    let result;
    mutate(manifestArg, (locked) => {
      result = authorizeProviderAttempt(
        locked,
        parseOptions(rawArgs),
        manifestArg,
      );
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  "provider-complete": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      completeProviderAttempt(locked, parseOptions(rawArgs)),
    ),
  "review-info": ({ manifest }) =>
    process.stdout.write(`${JSON.stringify(reviewInfo(manifest))}\n`),
  "review-retry-status": ({ manifest }) =>
    process.stdout.write(
      `${JSON.stringify(incompleteRetryStatus(manifest))}\n`,
    ),
  "reserve-incomplete-retry": ({ manifestArg }) =>
    mutate(manifestArg, reserveIncompleteRetry),
  "review-identity": ({ manifest }) =>
    process.stdout.write(`${JSON.stringify(reviewIdentity(manifest))}\n`),
  "record-review": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordReview(locked, parseOptions(rawArgs)),
    ),
  "record-advisory-review": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordAdvisoryReview(locked, parseOptions(rawArgs)),
    ),
  "record-policy-exempt-review": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordPolicyExemptReview(locked, parseOptions(rawArgs)),
    ),
  "record-incomplete-review": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordIncompleteReview(locked, parseOptions(rawArgs)),
    ),
  judge: ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) => recordJudge(locked, parseOptions(rawArgs))),
  "gate-run": ({ manifestArg, rawArgs }) => {
    let gateFailure = null;
    mutate(manifestArg, (locked) => {
      try {
        runGate(locked, parseOptions(rawArgs), manifestArg);
      } catch (error) {
        if (!(error instanceof GateExecutionError)) throw error;
        // Keep the expected gate failure inside mutate so its failed/timeout
        // evidence is durably saved, then propagate it after the transaction.
        gateFailure = error;
      }
    });
    if (gateFailure) throw gateFailure;
  },
  "mutation-record": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordMutation(locked, parseOptions(rawArgs)),
    ),
  "mutation-attempt": ({ manifestArg, rawArgs }) => {
    let result;
    mutate(manifestArg, (locked) => {
      result = authorizeMutationAttempt(
        locked,
        parseOptions(rawArgs),
        manifestArg,
      );
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  "mutation-complete": ({ manifestArg }) =>
    mutate(manifestArg, (locked) => completeMutationAttempt(locked)),
  "gate-plan": ({ manifest, rawArgs }) => {
    const options = parseOptions(rawArgs);
    const required = manifest.requiredGates.find(
      (gate) => gate.name === options.name,
    );
    if (!required) throw new Error(`gate '${options.name}' is not required`);
    process.stdout.write(`${JSON.stringify(required)}\n`);
  },
  "record-stamp": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordStamp(locked, locked.repo.realpath, parseOptions(rawArgs)),
    ),
  "record-stamp-published": ({ manifestArg, rawArgs }) =>
    mutate(manifestArg, (locked) =>
      recordStampPublished(locked, parseOptions(rawArgs)),
    ),
  inventory: ({ manifest, rawArgs }) => {
    const options = parseOptions(rawArgs);
    writeArtifactInventory(
      manifest,
      options["artifact-dir"],
      options.provider,
      {
        advisory: options.advisory === true,
        exempt: options.exempt === true,
        incomplete: options.incomplete === true,
      },
    );
  },
  get: ({ manifest, rawArgs }) => printValue(getPath(manifest, rawArgs[0])),
  field: ({ manifest, rawArgs }) => printValue(getPath(manifest, rawArgs[0])),
  "lock-owner": ({ manifest }) => printValue(qualityLockOwner(manifest)),
  "verify-artifacts": ({ manifest }) => {
    for (const review of coveredReviews(manifest)) {
      verifyReviewArtifact(manifest, review);
    }
  },
  "review-authorization": ({ manifest }) =>
    process.stdout.write(`${JSON.stringify(reviewAuthorization(manifest))}\n`),
  "judge-context": ({ manifest }) =>
    process.stdout.write(`${JSON.stringify(judgeContext(manifest))}\n`),
  "prior-findings": ({ manifest }) =>
    process.stdout.write(
      `${JSON.stringify({ findings: priorFindings(manifest) })}\n`,
    ),
  trailers: ({ manifest }) =>
    process.stdout.write(`${reviewTrailers(manifest)}\n`),
  // Read-only enumeration of every currently diagnosed terminal condition
  // for this exact manifest/HEAD, by stable id (BUI-575). This is what an
  // operator (or the wrapper, before minting an override capability) reads
  // to know exactly which --accept ids are required. It never mutates state.
  "diagnose-conditions": ({ manifest }) =>
    process.stdout.write(
      `${JSON.stringify(conditionTaxonomy.diagnoseConditions(manifest, {}))}\n`,
    ),
  "record-merge-admission-blocked-terminal": ({ manifestArg, rawArgs }) => {
    const options = parseOptions(rawArgs);
    const conditions = String(options.conditions || "")
      .split(",")
      .map((condition) => condition.trim())
      .filter(Boolean);
    recordMergeAdmissionBlockedTerminal(
      manifestArg,
      conditions,
      options.detail || "merge admission blocked",
    );
  },
  "resolve-green-ci-admission-block": ({ manifestArg }) =>
    process.stdout.write(
      `${resolveGreenCiAdmissionBlock(manifestArg) ? "resolved" : "unchanged"}\n`,
    ),
};

function advanceManifestTransaction(manifestArg, manifest, rawArgs) {
  const options = parseOptions(rawArgs);
  const acceptedConditions = options["allow-exhausted-review"]
    ? String(process.env.BS_QUALITY_ADVANCE_DECISION || "")
        .split(",")
        .map((condition) => condition.trim())
        .filter(Boolean)
    : [];
  if (
    options["allow-exhausted-review"] &&
    !acceptedConditions.includes("review:provider-exhaustion")
  ) {
    throw new Error(
      "allow-exhausted-review requires the explicit review:provider-exhaustion operator decision",
    );
  }
  const updated = withManifestLock(manifestArg, (locked) => {
    if (locked[NEEDS_EXECUTION_BUDGET_MIGRATION]) {
      throw new Error(
        "legacy manifest cannot reconstruct active execution usage; start a fresh quality campaign",
      );
    }
    reconcileAbandonedExecution(locked);
    validateIdentity(locked, manifest.repo.realpath, { requireHead: false });
    bindPrRepositoryIdentity(locked, options);
    const priorHead = locked.revisions.currentHead;
    const priorMutation =
      ["high", "critical"].includes(locked.risk?.tier) &&
      locked.mutation &&
      mutationEvidenceValid(locked)
        ? { ...locked.mutation }
        : null;
    const nextHead = git(locked.repo.realpath, ["rev-parse", "HEAD"]);
    if (options["allow-exhausted-review"]) {
      validateDescendantAdvanceAuthorization(
        locked,
        process.env.BS_QUALITY_ADVANCE_AUTHORIZATION_ARTIFACT,
        { head: nextHead, acceptedConditions },
      );
    }
    const priorTestRequirement = locked.requiredGates.find(
      (required) => required.name === "test",
    );
    advanceHead(locked, manifest.repo.realpath, { acceptedConditions });
    validateIdentity(locked, manifest.repo.realpath);
    const gateBase = isAncestorOf(locked.repo.realpath, priorHead, nextHead)
      ? priorHead
      : effectiveBaseSha(locked);
    const testRequirement = locked.requiredGates.find(
      (required) => required.name === "test",
    );
    const reusableTestGate = [...locked.gates].reverse().find(
      (gate) =>
        gate.name === "test" &&
        gate.status === "success" &&
        validReusableTestGate(
          locked,
          gate,
          locked.requiredGates.find((required) => required.name === "test"),
        ) &&
        isAncestorOf(locked.repo.realpath, gate.head, nextHead),
    );
    const reuseTestEvidence = Boolean(
      reusableTestGate &&
      nextHead !== reusableTestGate.head &&
      !changedFiles(
        locked.repo.realpath,
        reusableTestGate.head,
        nextHead,
      ).includes(".buildproven/test-impact.json"),
    );
    const recomputeTestEvidence = Boolean(
      testRequirement && nextHead !== priorHead && !reuseTestEvidence,
    );
    const discoveryBase = reuseTestEvidence
      ? reusableTestGate.head
      : recomputeTestEvidence
        ? effectiveBaseSha(locked)
        : gateBase;
    const discovered = discoverRequiredGates(
      locked.repo.realpath,
      {
        "skip-tests": locked.options?.skipTests === true,
        "verify-app": locked.options?.verifyApp === true,
      },
      locked.revisions.currentHead,
      discoveryBase,
    );
    const replaceNames = new Set();
    if (reuseTestEvidence || recomputeTestEvidence) replaceNames.add("test");
    locked.requiredGates = locked[NEEDS_REQUIRED_GATES_MIGRATION]
      ? discovered
      : unionRequiredGates(locked.requiredGates, discovered, replaceNames);
    if (reuseTestEvidence) {
      const test = locked.requiredGates.find(
        (required) => required.name === "test",
      );
      if (test) {
        const priorPredecessor = priorTestRequirement?.predecessorEvidence;
        test.predecessorEvidence = {
          head: reusableTestGate.head,
          status: reusableTestGate.status,
          source: reusableTestGate.source,
          command: reusableTestGate.command,
          policyDigest: reusableTestGate.policyDigest,
          requiredGatesDigest: gateRequirementsDigest([priorTestRequirement]),
          log: reusableTestGate.log,
          logSha256: reusableTestGate.logSha256,
          evidenceDigest: gateEvidenceDigest([reusableTestGate]),
          predecessor:
            priorPredecessor?.head === reusableTestGate.head
              ? priorPredecessor.predecessor || null
              : priorPredecessor || null,
        };
      }
    }
    locked.requiredGatesPolicyVersion = REQUIRED_GATES_POLICY_VERSION;
    locked[NEEDS_REQUIRED_GATES_MIGRATION] = false;
    if (priorMutation && nextHead !== priorHead) {
      const priorArtifact = parseJson(
        fs.readFileSync(priorMutation.artifactPath, "utf8"),
        "prior mutation evidence artifact",
      );
      locked.mutationCarry = {
        priorHead,
        artifactPath: priorMutation.artifactPath,
        artifactSha256: priorMutation.artifactSha256,
        avoidedSeconds: Number.isInteger(priorArtifact.executionSeconds)
          ? priorArtifact.executionSeconds
          : 0,
        recordedAt: new Date().toISOString(),
      };
    }
    locked.governor.lastActivityAt = new Date().toISOString();
  });
  return updated;
}

function advanceManifest(manifestArg, rawArgs = []) {
  const { manifest } = loadManifest(manifestArg);
  return advanceManifestTransaction(manifestArg, manifest, rawArgs);
}

function runAdvance(manifestArg, manifest, rawArgs) {
  const updated = advanceManifestTransaction(manifestArg, manifest, rawArgs);
  process.stdout.write(`${updated.revisions.currentHead}\n`);
}

function runCommand(command, rawArgs) {
  if (command === "create") {
    process.stdout.write(`${createManifest(parseOptions(rawArgs))}\n`);
    return;
  }
  const manifestArg = rawArgs.shift();
  if (!manifestArg)
    throw new Error(`${command || "command"} requires a manifest`);
  const { manifest } = loadManifest(manifestArg);
  if (command === "locate") {
    process.stdout.write(`${manifest.repo.realpath}\n`);
    return;
  }
  if (command === "terminal-state") {
    const options = parseOptions(rawArgs);
    if (options.read) {
      process.stdout.write(
        `${manifest.terminalState ? manifest.terminalState.state : "open"}\n`,
      );
      return;
    }
    const inForce = recordTerminalState(
      manifestArg,
      options.state,
      options.detail,
      { terminalEpoch: options["terminal-epoch"] },
    );
    const releaseStates = [
      "verified-unmerged",
      "superseded",
      "interrupted",
      "policy-superseded",
      "provider-incomplete",
      "provider-contract-failed",
    ];
    // terminalState is immutable diagnostic history, while the repository
    // lease follows the lifecycle outcome requested by this command. A late
    // provider failure must still release its lease even when an earlier
    // terminal cause remains the state in force.
    const releaseReason = releaseStates.includes(options.state)
      ? options.state
      : inForce;
    if (releaseStates.includes(releaseReason)) {
      const refreshed = loadManifest(manifestArg).manifest;
      if (
        refreshed.options?.merge === true &&
        refreshed.merge?.repositoryLease
      ) {
        require("./quality-repo-lease").release(
          manifestArg,
          process.env.BS_QUALITY_REPOSITORY_LEASE_TOKEN,
          releaseReason,
        );
      }
    }
    try {
      require("./quality-telemetry").recordCampaign(manifestArg, {
        quiet: true,
      });
    } catch (error) {
      process.stderr.write(
        `[quality] telemetry: terminal state recorded but telemetry failed — ${error.message}\n`,
      );
    }
    process.stdout.write(`${inForce}\n`);
    return;
  }
  if (
    NON_REENTERABLE_REVIEW_STATES.has(manifest.terminalState?.state) &&
    [
      "advance",
      "provider-attempt",
      "review-info",
      "record-review",
      "record-policy-exempt-review",
      "record-incomplete-review",
      "inventory",
    ].includes(command)
  ) {
    const advanceDecisionConditions = String(
      process.env.BS_QUALITY_ADVANCE_DECISION,
    )
      .split(",")
      .map((condition) => condition.trim());
    const exhaustedReviewAdvance =
      command === "advance" &&
      rawArgs.includes("--allow-exhausted-review") &&
      advanceDecisionConditions.includes("review:provider-exhaustion");
    if (!exhaustedReviewAdvance) {
      throw new Error(
        `quality campaign is terminal (${manifest.terminalState.state}); start a fresh invocation`,
      );
    }
  }
  if (
    (!STALE_READ_COMMANDS.has(command) || command === "review-info") &&
    (manifest.reviewContractVersion || 1) >= 2 &&
    manifest.risk?.reviewPolicyDigest &&
    manifest.risk.reviewPolicyDigest !==
      reviewPolicyDigest(buildReviewPolicy(manifest))
  ) {
    recordTerminalState(
      manifestArg,
      "policy-superseded",
      "review-policy-drift",
    );
    throw new Error(
      "review policy changed after risk resolution; start a fresh invocation",
    );
  }
  if (command === "advance") return runAdvance(manifestArg, manifest, rawArgs);
  if (
    manifest[NEEDS_EXECUTION_BUDGET_MIGRATION] &&
    !STALE_READ_COMMANDS.has(command)
  ) {
    throw new Error(
      "legacy manifest cannot reconstruct active execution usage; start a fresh quality campaign",
    );
  }
  if (lifecycleStale(manifest) && !STALE_READ_COMMANDS.has(command)) {
    throw new Error(
      "quality manifest is stale; resume through bootstrap to revalidate base and HEAD",
    );
  }
  if (manifest[NEEDS_REQUIRED_GATES_MIGRATION]) {
    throw new Error(
      "legacy manifest requires an explicit advance before gate evaluation",
    );
  }
  validateIdentity(manifest, manifest.repo.realpath);
  const handler = COMMANDS[command];
  if (!handler)
    throw new Error(`unknown quality invocation command '${command}'`);
  handler({ manifestArg, manifest, rawArgs });
}

function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  try {
    runCommand(command, rawArgs);
  } catch (error) {
    process.stderr.write(`quality manifest: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_VERSION,
  advanceHead,
  advanceManifest,
  approvalPayloadIdentityMatches,
  assertApprovalPayloadShape,
  approvalValid,
  ciBillingCapabilityValid,
  ciBillingEvidenceBindingValid,
  protectedNonstrictRefCasCapability,
  armApprovalChallenge,
  attachApproval,
  authorizeMutationAttempt,
  authorizeProviderAttempt,
  completeActiveExecution,
  completeMutationAttempt,
  completeProviderAttempt,
  atomicWrite,
  canonicalRoot,
  changedFiles,
  createManifest,
  loadManifest,
  lifecycleStale,
  parseOptions,
  parseJson,
  qualityLockOwner,
  recordReview,
  recordAdvisoryReview,
  recordPolicyExemptReview,
  assertReviewHeadCurrent,
  recordJudge,
  recordGate,
  recordMutation,
  recordTerminalState,
  recordMergeAdmissionBlockedTerminal,
  clearMergeAdmissionBlock,
  resolveGreenCiAdmissionBlock,
  recoveryScope,
  selectionRuntimeDigests,
  recordPreReviewSelectionFailure,
  resumePreReviewSelectionFailure,
  resumeInterruptedTerminal,
  resumeMergeReadFailure,
  resumeRecoverableTerminal,
  terminalEpoch,
  isTerminal,
  TERMINAL_STATES,
  hasAbandonedExecution,
  reconcileAbandonedExecution,
  executionRemaining,
  repositoryGateEnvironment,
  executableAvailable,
  runGate,
  recordStamp,
  judgeContext,
  repoKey,
  reviewDiffBuffer,
  reviewInfo,
  reviewCoverage,
  verifyGateEvidence,
  incompleteRetryStatus,
  reserveIncompleteRetry,
  reviewIdentity,
  reviewTrailers,
  saveManifest,
  setAgents,
  setRisk,
  reviewAuthorization,
  mutationEvidenceValid,
  verifyReviewArtifact,
  writeArtifactInventory,
  validateIdentity,
  validateDescendantAdvanceAuthorization,
  unionRequiredGates,
  withManifestLock,
  withManifestLockRaw,
};

if (require.main === module) main();
