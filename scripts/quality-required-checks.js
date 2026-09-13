#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertDispatchNonceAvailable,
  signDispatchAuthorization,
  signingKeyFromEnvironment,
} = require("./quality-review-evidence.js");

const ACCEPTED_CONCLUSIONS = new Set(["success"]);
const MAX_HISTORICAL_CHECK_COMMITS = 3;
const PROTECTED_CHECKS = Object.freeze({
  "secret-history-scan": Object.freeze({
    runPrefix: "secret-history-scan:",
    workflowPath: ".github/workflows/secret-history-scan.yml",
    eventType: "secret-history-scan",
  }),
  "harness-summary": Object.freeze({
    runPrefix: "harness-summary:",
    workflowPath: ".github/workflows/harness-gate.yml",
    eventType: "harness-summary",
  }),
});
const REMOTE_DISPATCH_CLAIM_PREFIX = "buildproven-dispatch-claim-v3";
const REMOTE_DISPATCH_CLAIM_METADATA_PREFIX =
  "buildproven-dispatch-claim-v3-meta";

function protectedCheckConfig(requirement) {
  return PROTECTED_CHECKS[requirement.context] || null;
}

class GhCommandError extends Error {
  constructor(message, result) {
    super(message);
    this.exitStatus = result.status;
    this.stdout = result.stdout || "";
    this.stderr = result.stderr || "";
  }
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith("--"))
      throw new Error(`unexpected argument '${name}'`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("repository must be owner/name");
  }
  return value;
}

function validateSha(value, name) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a SHA`);
  return value;
}

function validateRef(value, name) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.endsWith("/")
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

class GhReadTransportError extends GhCommandError {}
class GhWriteTransportError extends GhCommandError {}

function isApiMethod(args, method) {
  return args.some(
    (argument, index) =>
      (argument === "-X" || argument === "--method") &&
      args[index + 1] === method,
  );
}

function isTransportFailure(result) {
  if (result.status !== 1) return false;
  const stderr = result.stderr || "";
  const httpStatus = stderr.match(/HTTP\s+(\d{3})/i);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    return status === 408 || status >= 500;
  }
  if (/bad credentials|authentication|rate limit/i.test(stderr)) return false;
  return /error connecting to api\.github\.com|connection reset by peer|(?:Get|GET|Post|POST) "https:\/\/[^"\n]+": unexpected EOF|dial tcp[^\n]*(?:i\/o timeout|no such host|network is unreachable)|TLS handshake timeout/i.test(
    stderr,
  );
}

function isReadTransportFailure(args, result, input) {
  if (args[0] !== "api" || input !== undefined || !isApiMethod(args, "GET"))
    return false;
  return isTransportFailure(result);
}

function isWriteTransportFailure(args, result) {
  if (args[0] !== "api" || !isApiMethod(args, "POST") || result.status === 0)
    return false;
  const stderr = result.stderr || "";
  const httpStatus = stderr.match(/HTTP\s+(\d{3})/i);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    if (status >= 400 && status < 500 && status !== 408) return false;
  }
  if (/bad credentials|authentication|rate limit/i.test(stderr)) return false;
  // A POST may have reached GitHub before an unfamiliar client, proxy, or
  // transport failure was reported. Treat that outcome as uncertain unless
  // the response proves a definite rejection, so the persisted intent is
  // reconciled instead of being replaced with a new dispatch nonce.
  return true;
}

function runGh(args, input = undefined, retryAvailable = true) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const readTransportFailure = isReadTransportFailure(args, result, input);
    const writeTransportFailure = isWriteTransportFailure(args, result);
    if (readTransportFailure && retryAvailable)
      return runGh(args, input, false);
    const ErrorType = readTransportFailure
      ? GhReadTransportError
      : writeTransportFailure
        ? GhWriteTransportError
        : GhCommandError;
    throw new ErrorType(
      `gh ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`,
      result,
    );
  }
  return result.stdout;
}

function runGit(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout;
}

function dispatchClaimDirectory() {
  const configured = process.env.QUALITY_REVIEW_DISPATCH_CLAIM_DIR;
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const directory =
    configured || path.join(stateHome, "claude-kit", "dispatch-claims");
  if (!path.isAbsolute(directory))
    throw new Error("dispatch claim directory must be an absolute path");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("dispatch claim directory must be a real directory");
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
    throw new Error("dispatch claim directory has the wrong owner");
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function claimDispatchNonce({ repository, eventType, head, base, nonce }) {
  const fields = {
    schemaVersion: 1,
    repository,
    eventType,
    head,
    base,
    nonce,
    issuedAt: new Date(0).toISOString(),
    expiresAt: new Date(15 * 60 * 1000).toISOString(),
  };
  const externalId = assertDispatchNonceAvailable(fields, []);
  const claimName = crypto
    .createHash("sha256")
    .update(`${repository}\u0000${externalId}`)
    .digest("hex");
  const directory = dispatchClaimDirectory();
  const claimPath = path.join(directory, `${claimName}.json`);
  let descriptor;
  try {
    descriptor = fs.openSync(claimPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `dispatch authorization nonce has already been claimed: ${externalId}`,
        { cause: error },
      );
    throw error;
  }
  try {
    const record = {
      schemaVersion: 1,
      repository,
      eventType,
      head: head.toLowerCase(),
      base: base.toLowerCase(),
      nonce,
      externalId,
      claimedAt: new Date().toISOString(),
    };
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(directory);
  return { externalId, claimPath };
}

function claimRemoteDispatchNonce(
  repository,
  eventType,
  head,
  externalId,
  issuedAt = new Date().toISOString(),
) {
  // GitHub's Git-ref creation is the durable conditional-create primitive:
  // the first caller creates this immutable claim, and a concurrent or later
  // caller receives HTTP 422 because the ref already exists. The separate
  // lightweight metadata ref is created first, so a losing caller cannot
  // orphan a Git object.
  const claimHash = crypto
    .createHash("sha256")
    .update(`${eventType}\u0000${externalId}`)
    .digest("hex");
  const claimRef = `refs/tags/${REMOTE_DISPATCH_CLAIM_PREFIX}/${claimHash}`;
  if (!Number.isFinite(Date.parse(issuedAt))) {
    throw new Error("dispatch claim issuedAt must be an ISO date");
  }
  const issuedAtSeconds = Math.floor(Date.parse(issuedAt) / 1000);
  const metadataRef = `refs/tags/${REMOTE_DISPATCH_CLAIM_METADATA_PREFIX}/${claimHash}/${issuedAtSeconds}`;
  try {
    runGh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=${metadataRef}`,
      "-f",
      `sha=${head}`,
    ]);
  } catch (error) {
    if (
      !/HTTP 422|already exists|Reference already exists/i.test(
        `${error.message}\n${error.stderr || ""}`,
      )
    ) {
      throw new Error(
        `could not create dispatch claim metadata ref ${metadataRef}`,
        {
          cause: error,
        },
      );
    }
  }
  try {
    runGh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=${claimRef}`,
      "-f",
      `sha=${head}`,
    ]);
  } catch (error) {
    if (
      /HTTP 422|already exists|Reference already exists/i.test(
        `${error.message}\n${error.stderr || ""}`,
      )
    )
      throw new Error(
        `dispatch authorization nonce has already been claimed remotely: ${externalId}`,
        { cause: error },
      );
    throw new Error(
      `could not create durable dispatch nonce claim ref ${claimRef}`,
      { cause: error },
    );
  }
  return claimRef;
}

function remoteDispatchClaimMetadataRefs(repository) {
  const prefix = `refs/tags/${REMOTE_DISPATCH_CLAIM_METADATA_PREFIX}/`;
  try {
    const pages = JSON.parse(
      runGh([
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/git/matching-refs/tags/${REMOTE_DISPATCH_CLAIM_METADATA_PREFIX}/`,
      ]),
    );
    if (!Array.isArray(pages)) {
      throw new Error("GitHub returned an invalid dispatch claim ref list");
    }
    const entries = pages.flatMap((page) =>
      Array.isArray(page) ? page : [page],
    );
    const claims = entries
      .map((entry) => parseRemoteDispatchMetadataEntry(entry, prefix))
      .filter(Boolean);
    return { claims, skipped: entries.length - claims.length };
  } catch (error) {
    throw new Error(
      `could not list remote dispatch nonce claims for ${repository}`,
      { cause: error },
    );
  }
}

function parseRemoteDispatchMetadataEntry(entry, prefix) {
  const ref = entry?.ref;
  const suffix =
    typeof ref === "string" && ref.startsWith(prefix)
      ? ref.slice(prefix.length)
      : null;
  const [claimHash, issuedAtSeconds] = (suffix || "").split("/");
  const valid = [
    /^[0-9a-f]{64}$/.test(claimHash || ""),
    /^[0-9]{1,12}$/.test(issuedAtSeconds || ""),
    entry?.object?.type === "commit",
    /^[0-9a-f]{40}$/.test(entry?.object?.sha || ""),
  ].every(Boolean);
  if (!valid) {
    return null;
  }
  return {
    ref: `${REMOTE_DISPATCH_CLAIM_METADATA_PREFIX}/${suffix}`,
    claimHash,
    issuedAt: Number(issuedAtSeconds) * 1000,
  };
}

function deleteRemoteDispatchRef(repository, ref) {
  try {
    runGh([
      "api",
      "--method",
      "DELETE",
      `repos/${repository}/git/refs/tags/${ref}`,
    ]);
    return true;
  } catch (error) {
    if (/HTTP 404|Not Found/i.test(`${error.message}\n${error.stderr || ""}`)) {
      return false;
    }
    throw new Error(`could not delete expired remote dispatch ref ${ref}`, {
      cause: error,
    });
  }
}

function cleanupRemoteDispatchClaimGroup(
  repository,
  claimHash,
  group,
  now,
  retentionMs,
) {
  const fresh = group.filter((claim) => now - claim.issuedAt <= retentionMs);
  const expired = group.filter((claim) => now - claim.issuedAt > retentionMs);
  const result = { deleted: 0, metadataDeleted: 0, retained: 0 };
  if (fresh.length > 0) {
    result.retained = 1;
    for (const claim of expired) {
      if (deleteRemoteDispatchRef(repository, claim.ref))
        result.metadataDeleted += 1;
    }
    return result;
  }
  if (
    deleteRemoteDispatchRef(
      repository,
      `${REMOTE_DISPATCH_CLAIM_PREFIX}/${claimHash}`,
    )
  ) {
    result.deleted = 1;
  }
  for (const claim of expired) {
    if (deleteRemoteDispatchRef(repository, claim.ref))
      result.metadataDeleted += 1;
  }
  return result;
}

function cleanupRemoteDispatchClaims(
  repository,
  { retentionMs = 24 * 60 * 60 * 1000, now = Date.now() } = {},
) {
  if (!Number.isInteger(retentionMs) || retentionMs <= 0) {
    throw new Error("dispatch claim retention must be a positive integer");
  }
  if (!Number.isFinite(now)) {
    throw new Error("dispatch claim cleanup time must be finite");
  }
  const { claims, skipped } = remoteDispatchClaimMetadataRefs(repository);
  const result = { deleted: 0, metadataDeleted: 0, retained: 0, skipped };
  const groups = new Map();
  for (const claim of claims) {
    const group = groups.get(claim.claimHash) || [];
    group.push(claim);
    groups.set(claim.claimHash, group);
  }
  for (const [claimHash, group] of groups) {
    const groupResult = cleanupRemoteDispatchClaimGroup(
      repository,
      claimHash,
      group,
      now,
      retentionMs,
    );
    result.deleted += groupResult.deleted;
    result.metadataDeleted += groupResult.metadataDeleted;
    result.retained += groupResult.retained;
  }
  return result;
}

function cleanupClaimsCommand(options) {
  const repository = validateRepository(requiredOption(options, "repo"));
  const retentionMs = Number.parseInt(
    options["retention-ms"] || String(24 * 60 * 60 * 1000),
    10,
  );
  if (!Number.isInteger(retentionMs) || retentionMs <= 0) {
    throw new Error("--retention-ms must be a positive integer");
  }
  return cleanupRemoteDispatchClaims(repository, { retentionMs });
}

function apiJson(path) {
  const output = runGh(["api", "-X", "GET", path]);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub API returned invalid JSON for ${path}`, {
      cause: error,
    });
  }
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function optionalApiJson(path) {
  try {
    return apiJson(path);
  } catch (error) {
    if (error instanceof GhCommandError) {
      const body = parseJsonOrNull(error.stdout);
      if (
        error.stderr.includes("(HTTP 404)") &&
        body?.message === "Branch not protected"
      ) {
        return null;
      }
    }
    throw error;
  }
}

function addRequirement(requirements, context, appId) {
  if (typeof context !== "string" || context.length === 0) return;
  const parsedAppId = Number(appId);
  const normalizedAppId =
    Number.isInteger(parsedAppId) && parsedAppId > 0 ? parsedAppId : null;
  if (
    !requirements.some(
      (requirement) =>
        requirement.context === context &&
        requirement.appId === normalizedAppId,
    )
  ) {
    requirements.push({ context, appId: normalizedAppId });
  }
}

function classicRequirements(protection) {
  const requirements = [];
  if (protection === null) return requirements;
  if (typeof protection !== "object" || Array.isArray(protection)) {
    throw new Error("GitHub branch-protection response is invalid");
  }
  const checks = Array.isArray(protection.checks) ? protection.checks : [];
  const contexts = Array.isArray(protection.contexts)
    ? protection.contexts
    : [];
  for (const check of checks) {
    addRequirement(requirements, check.context, check.app_id);
  }
  for (const context of contexts) {
    if (!requirements.some((requirement) => requirement.context === context)) {
      addRequirement(requirements, context, null);
    }
  }
  return requirements;
}

function rulesetRequirements(effectiveRules) {
  const requirements = [];
  if (effectiveRules !== null && !Array.isArray(effectiveRules)) {
    throw new Error("GitHub effective-rules response is invalid");
  }
  for (const rule of effectiveRules || []) {
    if (rule?.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      addRequirement(requirements, check.context, check.integration_id);
    }
  }
  return requirements;
}

function graphqlRequirements(repository, base) {
  const separator = repository.indexOf("/");
  const owner = repository.slice(0, separator);
  const name = repository.slice(separator + 1);
  const query =
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){" +
    "branchProtectionRules(first:100){pageInfo{hasNextPage}nodes{" +
    "requiredStatusChecks{context app{databaseId}} matchingRefs(first:100){pageInfo{hasNextPage}" +
    "nodes{name}}}}}}";
  let response;
  try {
    response = JSON.parse(
      runGh([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
      ]),
    );
  } catch (error) {
    throw new Error("GitHub GraphQL required-check discovery failed", {
      cause: error,
    });
  }
  const protection = response?.data?.repository?.branchProtectionRules;
  if (!protection || protection.pageInfo?.hasNextPage !== false) {
    throw new Error(
      "GitHub GraphQL required-check discovery was incomplete or unavailable",
    );
  }
  const matching = (protection.nodes || []).filter(
    (rule) =>
      rule?.matchingRefs?.pageInfo?.hasNextPage === false &&
      Array.isArray(rule.matchingRefs.nodes) &&
      rule.matchingRefs.nodes.some((ref) => ref?.name === base),
  );
  if (matching.length > 1) {
    throw new Error(
      "GitHub GraphQL required-check discovery found multiple matching branch rules",
    );
  }
  if (matching.length === 0) return [];
  const checks = matching[0].requiredStatusChecks;
  if (!Array.isArray(checks)) {
    throw new Error(
      "GitHub GraphQL required-check discovery returned invalid check contexts",
    );
  }
  const requirements = [];
  for (const check of checks) {
    if (typeof check?.context !== "string" || !check.context) {
      throw new Error(
        "GitHub GraphQL required-check discovery returned an invalid check",
      );
    }
    addRequirement(requirements, check.context, check.app?.databaseId ?? null);
  }
  return requirements;
}

function paginatedArray(path, label) {
  const values = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 100; page += 1) {
    const response = apiJson(`${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(response)) {
      throw new Error(`GitHub ${label} response is invalid`);
    }
    values.push(...response);
    if (response.length < 100) return values;
  }
  throw new Error(`GitHub ${label} pagination exceeded 100 pages`);
}

function requiredChecks(repository, base) {
  const encodedBase = encodeURIComponent(base);
  let protection = null;
  let protectionError = null;
  try {
    protection = optionalApiJson(
      `repos/${repository}/branches/${encodedBase}/protection/required_status_checks`,
    );
  } catch (error) {
    protectionError = error;
  }
  let effectiveRules = null;
  let effectiveRulesError = null;
  try {
    effectiveRules = paginatedArray(
      `repos/${repository}/rules/branches/${encodedBase}`,
      "effective-rules",
    );
  } catch (error) {
    effectiveRulesError = error;
  }
  const requirements = classicRequirements(protection);
  for (const requirement of rulesetRequirements(effectiveRules)) {
    addRequirement(requirements, requirement.context, requirement.appId);
  }
  if (effectiveRulesError) {
    throw effectiveRulesError;
  }
  if (protectionError || (requirements.length === 0 && protection === null)) {
    let graphql;
    try {
      graphql = graphqlRequirements(repository, base);
    } catch (error) {
      // Preserve the first authoritative REST failure when the independent
      // fallback is also unavailable. Callers need the original status (for
      // example, rate limiting or a provider outage) to choose a safe retry.
      throw protectionError || effectiveRulesError || error;
    }
    for (const requirement of graphql) {
      addRequirement(requirements, requirement.context, requirement.appId);
    }
    if (graphql.length === 0 && protectionError && requirements.length === 0) {
      throw protectionError || effectiveRulesError;
    }
  }
  if (requirements.length === 0) {
    throw new Error(
      "protected base has no required status checks or its protection could not be read",
    );
  }
  return requirements;
}

function checkRuns(repository, head) {
  const runs = [];
  let totalCount = null;
  for (let page = 1; page <= 100; page += 1) {
    const response = apiJson(
      `repos/${repository}/commits/${head}/check-runs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.check_runs)) {
      throw new Error("GitHub check-runs response is invalid");
    }
    if (page === 1) {
      if (response.total_count === undefined) return response.check_runs;
      if (!Number.isInteger(response.total_count) || response.total_count < 0) {
        throw new Error("GitHub check-runs total_count is invalid");
      }
      totalCount = response.total_count;
    }
    runs.push(...response.check_runs);
    if (runs.length >= totalCount) return runs;
    if (response.check_runs.length === 0) {
      throw new Error("GitHub check-runs pagination ended before total_count");
    }
  }
  throw new Error("GitHub check-runs pagination exceeded 100 pages");
}

function matchingRuns(runs, requirement) {
  return runs
    .filter(
      (run) =>
        run.name === requirement.context &&
        (requirement.appId === null || run.app?.id === requirement.appId) &&
        (!requirement.externalId || run.external_id === requirement.externalId),
    )
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0));
}

function checkState(runs, requirement) {
  const latest = matchingRuns(runs, requirement)[0];
  if (!latest) return { state: "missing", run: null };
  return checkRunState(latest);
}

function checkRunState(latest) {
  if (latest.status !== "completed") return { state: "pending", run: latest };
  return {
    state: ACCEPTED_CONCLUSIONS.has(latest.conclusion) ? "success" : "failed",
    run: latest,
  };
}

function trustedSecretCheckState({
  repository,
  runs,
  requirement,
  workflowId,
  base,
  targetHead,
  baseHead,
}) {
  const protectedConfig = protectedCheckConfig(requirement);
  if (!protectedConfig) return { state: "missing", run: null };
  const latest = matchingRuns(runs, requirement)[0];
  if (!latest || typeof latest.details_url !== "string") {
    return { state: "missing", run: null };
  }
  const noncePrefix = `${protectedConfig.runPrefix}${targetHead}:${baseHead}:`;
  const externalId = String(requirement.externalId || latest.external_id || "");
  if (!externalId.startsWith(noncePrefix)) {
    return { state: "missing", run: null };
  }
  const nonce = externalId.slice(noncePrefix.length);
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { state: "missing", run: null };
  }
  const expectedRunName = `${noncePrefix}${nonce}`;
  let workflowRun;
  try {
    workflowRun = workflowRunForCheck(repository, latest, {
      workflowId,
      base,
      baseHead,
      expectedRunName,
    });
  } catch {
    return { state: "missing", run: null };
  }
  if (
    (workflowId !== null && workflowRun.workflow_id !== workflowId) ||
    workflowRun.event !== "repository_dispatch" ||
    workflowRun.head_branch !== base ||
    workflowRun.head_sha !== baseHead ||
    workflowRun.path !== protectedConfig.workflowPath ||
    workflowRun.display_title !== expectedRunName ||
    !["queued", "in_progress", "completed"].includes(workflowRun.status)
  )
    return { state: "missing", run: null };
  if (workflowRun.status !== "completed")
    return { state: "pending", run: latest };
  if (workflowRun.conclusion !== "success")
    return { state: "failed", run: latest };
  return checkRunState(latest);
}

function branchHeadSha(repository, base) {
  const response = apiJson(
    `repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`,
  );
  const sha = response.object?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`GitHub base ref '${base}' did not return a commit SHA`);
  }
  return sha;
}

function workflowIdForRun(repository, run) {
  return workflowRunForCheck(repository, run).workflow_id;
}

function workflowIdForProtectedController(repository, protectedConfig) {
  const workflow = apiJson(
    `repos/${repository}/actions/workflows/${encodeURIComponent(protectedConfig.workflowPath)}`,
  );
  if (
    !Number.isInteger(workflow.id) ||
    workflow.path !== protectedConfig.workflowPath ||
    workflow.state !== "active"
  ) {
    throw new Error(
      `trusted protected workflow '${protectedConfig.workflowPath}' is missing, inactive, or has invalid identity`,
    );
  }
  return workflow.id;
}

function workflowRunForCheck(
  repository,
  run,
  {
    workflowId = null,
    base = null,
    baseHead = null,
    expectedRunName = null,
  } = {},
) {
  const match = String(run.details_url || "").match(/\/actions\/runs\/(\d+)/);
  if (match) {
    const workflowRun = apiJson(`repos/${repository}/actions/runs/${match[1]}`);
    if (!Number.isInteger(workflowRun.workflow_id)) {
      throw new Error(`required check '${run.name}' has no workflow identity`);
    }
    return workflowRun;
  }

  if (
    !Number.isInteger(workflowId) ||
    typeof base !== "string" ||
    typeof baseHead !== "string" ||
    typeof expectedRunName !== "string"
  ) {
    throw new Error(`required check '${run.name}' has no Actions run identity`);
  }

  const workflowRuns = [];
  let totalCount = null;
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      event: "repository_dispatch",
      branch: base,
      head_sha: baseHead,
      per_page: "100",
      page: String(page),
    });
    const response = apiJson(
      `repos/${repository}/actions/workflows/${workflowId}/runs?${query}`,
    );
    if (!Array.isArray(response.workflow_runs)) {
      throw new Error("GitHub workflow-runs response is invalid");
    }
    if (page === 1) {
      if (!Number.isInteger(response.total_count) || response.total_count < 0) {
        throw new Error("GitHub workflow-runs total_count is invalid");
      }
      totalCount = response.total_count;
    }
    workflowRuns.push(...response.workflow_runs);
    if (workflowRuns.length >= totalCount) break;
    if (response.workflow_runs.length === 0) {
      throw new Error(
        "GitHub workflow-runs pagination ended before total_count",
      );
    }
    if (page === 10) {
      throw new Error("GitHub workflow-runs pagination exceeded 10 pages");
    }
  }

  const exact = workflowRuns.filter(
    (workflowRun) =>
      workflowRun.workflow_id === workflowId &&
      workflowRun.event === "repository_dispatch" &&
      workflowRun.head_branch === base &&
      workflowRun.head_sha === baseHead &&
      workflowRun.display_title === expectedRunName,
  );
  if (exact.length !== 1) {
    throw new Error(
      `required check '${run.name}' has ${exact.length} matching Actions run identities`,
    );
  }
  return exact[0];
}

function sourceRunForRequirement(
  repository,
  sourceHead,
  sourceRuns,
  requirement,
  historicalRuns,
) {
  const exact = matchingRuns(sourceRuns, requirement)[0];
  if (exact) return exact;
  const ancestors = runGit([
    "rev-list",
    "--first-parent",
    `--max-count=${MAX_HISTORICAL_CHECK_COMMITS + 1}`,
    sourceHead,
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(1, MAX_HISTORICAL_CHECK_COMMITS + 1);
  for (const ancestor of ancestors) {
    if (!historicalRuns.has(ancestor)) {
      historicalRuns.set(ancestor, checkRuns(repository, ancestor));
    }
    const historical = matchingRuns(
      historicalRuns.get(ancestor),
      requirement,
    )[0];
    if (historical) return historical;
  }
  return null;
}

function workflowIdForRequirement({
  repository,
  sourceHead,
  sourceRuns,
  requirement,
  protectedConfig,
  historicalRuns,
}) {
  if (protectedConfig) {
    return workflowIdForProtectedController(repository, protectedConfig);
  }
  const exactSource = matchingRuns(sourceRuns, requirement)[0];
  if (exactSource) return workflowIdForRun(repository, exactSource);
  const source = sourceRunForRequirement(
    repository,
    sourceHead,
    sourceRuns,
    requirement,
    historicalRuns,
  );
  if (!source) {
    throw new Error(
      `cannot map required check '${requirement.context}' to a workflow from the reviewed head or its bounded first-parent history`,
    );
  }
  return workflowIdForRun(repository, source);
}

function dispatchWorkflow(repository, workflowId, ref) {
  // A failed response does not prove the dispatch was rejected. Never repeat
  // this mutation without reconciling its exact remote execution first.
  runGh([
    "api",
    "--method",
    "POST",
    `repos/${repository}/actions/workflows/${workflowId}/dispatches`,
    "-f",
    `ref=${ref}`,
  ]);
}

function dispatchRepositoryEvent(repository, eventType, payload, deadline) {
  const issuedAt = new Date(Date.now());
  const authorization = signDispatchAuthorization(
    {
      schemaVersion: 1,
      repository,
      eventType,
      head: payload.head_sha,
      base: payload.base_sha,
      nonce: payload.nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        deadline ?? issuedAt.getTime() + 10 * 60 * 1000,
      ).toISOString(),
    },
    signingKeyFromEnvironment(),
  );
  const authorizedPayload = { ...payload, authorization };
  const claim = claimDispatchNonce({
    repository,
    eventType,
    head: payload.head_sha,
    base: payload.base_sha,
    nonce: payload.nonce,
  });
  if (
    claim.externalId !==
    `${eventType}:${payload.head_sha}:${payload.base_sha}:${payload.nonce}`
  )
    throw new Error("dispatch claim identity mismatch");
  if (process.env.QUALITY_REVIEW_DISPATCH_REMOTE_CLAIM !== "false") {
    claimRemoteDispatchNonce(
      repository,
      eventType,
      payload.head_sha,
      claim.externalId,
      issuedAt.toISOString(),
    );
  }
  try {
    runGh(
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/dispatches`,
        "--input",
        "-",
      ],
      JSON.stringify({
        event_type: eventType,
        client_payload: authorizedPayload,
      }),
    );
  } catch (error) {
    // The local and GitHub-backed claims are one-use. Retrying the same
    // signed request after an ambiguous API failure could create a duplicate.
    throw new Error(
      `repository dispatch failed after nonce claim: ${error.message}`,
      { cause: error },
    );
  }
}

function dispatchedRunsForHead(repository, headRef, targetHead, workflowIds) {
  const matching = new Map();
  for (let page = 1; page <= 100; page += 1) {
    const response = apiJson(
      `repos/${repository}/actions/runs?branch=${encodeURIComponent(headRef)}&event=workflow_dispatch&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.workflow_runs)) {
      throw new Error("GitHub workflow-runs response is invalid");
    }
    for (const run of response.workflow_runs) {
      if (
        run.head_sha === targetHead &&
        run.head_branch === headRef &&
        run.event === "workflow_dispatch" &&
        workflowIds.has(run.workflow_id) &&
        !matching.has(run.workflow_id)
      ) {
        matching.set(run.workflow_id, run);
      }
    }
    if (matching.size === workflowIds.size) return matching;
    if (response.workflow_runs.length < 100) return matching;
  }
  throw new Error("GitHub workflow-runs pagination exceeded 100 pages");
}

function waitForRegistration({
  repository,
  targetHead,
  requirements,
  targetRuns,
  timeoutSeconds,
  intervalSeconds,
  deadline: fixedDeadline,
  stateFor = checkState,
}) {
  const deadline = fixedDeadline ?? Date.now() + timeoutSeconds * 1000;
  let runs = targetRuns;
  while (
    requirements.some(
      (requirement) => stateFor(runs, requirement).state === "missing",
    ) &&
    Date.now() < deadline
  ) {
    sleep(Math.min(intervalSeconds * 1000, Math.max(0, deadline - Date.now())));
    runs = checkRuns(repository, targetHead);
  }
  return runs;
}

function assertMonitorIdentity(manifest, context) {
  const quality = require("./quality-invocation.js");
  quality.validateIdentity(manifest, manifest.repo.realpath);
  if (
    manifest.repo.githubRepository !== context.repository ||
    manifest.revisions.currentHead !== context.sourceHead ||
    ![manifest.revisions.currentHead, manifest.merge?.stampHead].includes(
      context.targetHead,
    ) ||
    manifest.repo.headRefName !== context.headRef ||
    manifest.revisions.baseRef.replace(/^(?:refs\/heads\/|origin\/)/, "") !==
      context.base
  ) {
    throw new Error("required-check monitor campaign identity mismatch");
  }
}

function monitorForAssertion(manifest, context) {
  const monitor = manifest.merge?.requiredChecksMonitor || null;
  if (!monitor) return null;
  assertMonitorIdentity(manifest, {
    ...context,
    sourceHead: manifest.revisions.currentHead,
    targetHead: context.head,
    headRef: manifest.repo.headRefName,
  });
  if (monitor.targetHead !== context.head) {
    throw new Error("required-check assertion monitor head mismatch");
  }
  assertBeforeDeadline(monitor.deadline);
  return monitor;
}

function protectedMonitorLifetimeValid(monitor, requirements) {
  return (
    !requirements.some(protectedCheckConfig) ||
    monitor.deadline - monitor.startedAt <= 900 * 1000
  );
}

function newRequiredChecksMonitor(
  context,
  requirements,
  baseHead,
  timeoutSeconds,
) {
  const startedAt = Date.now();
  return {
    schemaVersion: 1,
    ...context,
    baseHead,
    requirements,
    startedAt,
    deadline: startedAt + timeoutSeconds * 1000,
    dispatches: [],
  };
}

function monitorFor(
  manifestPath,
  context,
  requirements,
  baseHead,
  timeoutSeconds,
) {
  if (!manifestPath) return null;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    (requirements.some(protectedCheckConfig) && timeoutSeconds > 900)
  ) {
    throw new Error(
      "required-check monitor timeout must be positive and protected dispatch is limited to 900 seconds",
    );
  }
  const quality = require("./quality-invocation.js");
  const updated = quality.withManifestLock(manifestPath, (manifest) => {
    assertMonitorIdentity(manifest, context);
    const previous = manifest.merge.requiredChecksMonitor;
    if (previous && previous.targetHead !== context.targetHead) {
      manifest.merge.requiredChecksHistory ??= [];
      manifest.merge.requiredChecksHistory.push(previous);
      delete manifest.merge.requiredChecksMonitor;
    }
    if (!manifest.merge.requiredChecksMonitor) {
      manifest.merge.requiredChecksMonitor = newRequiredChecksMonitor(
        context,
        requirements,
        baseHead,
        timeoutSeconds,
      );
    }
    const monitor = manifest.merge.requiredChecksMonitor;
    if (
      monitor.schemaVersion !== 1 ||
      Object.entries(context).some(([key, value]) => monitor[key] !== value) ||
      monitor.baseHead !== baseHead ||
      JSON.stringify(monitor.requirements) !== JSON.stringify(requirements) ||
      !Array.isArray(monitor.dispatches) ||
      !Number.isFinite(monitor.startedAt) ||
      !Number.isFinite(monitor.deadline) ||
      monitor.deadline <= monitor.startedAt ||
      !protectedMonitorLifetimeValid(monitor, requirements)
    ) {
      throw new Error(
        "required-check monitor bindings changed or are malformed",
      );
    }
  });
  return updated.merge.requiredChecksMonitor;
}

function dispatchKey(workflowId, transport) {
  return `${workflowId}:${transport}`;
}

function rememberPersistedDispatch(dispatchedWorkflowIds, persisted) {
  if (
    !Number.isInteger(persisted.workflowId) ||
    !["repository_dispatch", "workflow_dispatch"].includes(persisted.transport)
  ) {
    throw new Error("persisted required-check dispatch is malformed");
  }
  dispatchedWorkflowIds.add(
    dispatchKey(persisted.workflowId, persisted.transport),
  );
}

function adoptPersistedDispatch(existing, entry) {
  if (
    existing.workflowId !== entry.workflowId ||
    existing.transport !== entry.transport ||
    existing.requirement.context !== entry.requirement.context ||
    existing.requirement.appId !== entry.requirement.appId
  ) {
    throw new Error("required-check persisted dispatch identity mismatch");
  }
  return existing;
}

function assertBeforeDeadline(deadline) {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error(
      "timed out waiting for exact-head required checks: persisted head deadline expired",
    );
  }
}

function persistDispatch(manifestPath, monitor, entry, accepted = false) {
  const quality = require("./quality-invocation.js");
  let created = false;
  let persistedEntry;
  const updated = quality.withManifestLock(manifestPath, (manifest) => {
    assertMonitorIdentity(manifest, monitor);
    const current = manifest.merge.requiredChecksMonitor;
    if (
      !current ||
      current.targetHead !== monitor.targetHead ||
      current.deadline !== monitor.deadline ||
      current.baseHead !== monitor.baseHead
    )
      throw new Error("required-check monitor changed during dispatch");
    const existing = current.dispatches.find(
      (item) => item.requirement.context === entry.requirement.context,
    );
    if (accepted) {
      if (
        !existing ||
        JSON.stringify(existing.requirement) !==
          JSON.stringify(entry.requirement) ||
        existing.workflowId !== entry.workflowId ||
        existing.nonce !== entry.nonce
      ) {
        throw new Error("required-check dispatch acceptance identity mismatch");
      }
      existing.status = "accepted";
      existing.acceptedAt = Date.now();
      persistedEntry = existing;
    } else if (!existing) {
      assertBeforeDeadline(current.deadline);
      current.dispatches.push(entry);
      created = true;
      persistedEntry = entry;
    } else {
      persistedEntry = adoptPersistedDispatch(existing, entry);
    }
  });
  return {
    created,
    entry: persistedEntry,
    monitor: updated.merge.requiredChecksMonitor,
  };
}

function removeRejectedDispatch(monitor, entry) {
  const index = monitor.dispatches.findIndex(
    (item) =>
      item.status === "intended" &&
      item.workflowId === entry.workflowId &&
      item.transport === entry.transport &&
      item.nonce === entry.nonce &&
      item.issuedAt === entry.issuedAt &&
      item.expiresAt === entry.expiresAt &&
      JSON.stringify(item.requirement) === JSON.stringify(entry.requirement),
  );
  if (index === -1) {
    throw new Error("required-check rejected dispatch intent changed");
  }
  monitor.dispatches.splice(index, 1);
}

function discardRejectedDispatch(manifestPath, monitor, entry) {
  const quality = require("./quality-invocation.js");
  const updated = quality.withManifestLock(manifestPath, (manifest) => {
    assertMonitorIdentity(manifest, monitor);
    const current = manifest.merge.requiredChecksMonitor;
    if (
      !current ||
      current.targetHead !== monitor.targetHead ||
      current.deadline !== monitor.deadline ||
      current.baseHead !== monitor.baseHead
    )
      throw new Error(
        "required-check monitor changed during dispatch rejection",
      );
    removeRejectedDispatch(current, entry);
  });
  return updated.merge.requiredChecksMonitor;
}

function dispatchCommandError(error) {
  let current = error;
  while (current instanceof Error) {
    if (current instanceof GhCommandError) return current;
    current = current.cause;
  }
  return null;
}

function prepareChecks({ repository, base, sourceHead, targetHead }) {
  const requirements = requiredChecks(repository, base);
  const sourceRuns = checkRuns(repository, sourceHead);
  const targetRuns = checkRuns(repository, targetHead);
  const protectedCheckRequired = requirements.some(protectedCheckConfig);
  const baseHead = protectedCheckRequired
    ? branchHeadSha(repository, base)
    : null;
  const dispatches = [];
  const historicalRuns = new Map();
  for (const requirement of requirements) {
    const protectedConfig = protectedCheckConfig(requirement);
    if (!protectedConfig) {
      const target = checkState(targetRuns, requirement);
      if (["pending", "success"].includes(target.state)) continue;
    }
    const workflowId = workflowIdForRequirement({
      repository,
      sourceHead,
      sourceRuns,
      requirement,
      protectedConfig,
      historicalRuns,
    });
    if (protectedConfig) {
      const target = trustedSecretCheckState({
        repository,
        runs: targetRuns,
        requirement,
        workflowId,
        base,
        targetHead,
        baseHead,
      });
      if (["pending", "success"].includes(target.state)) continue;
      // Validate signer availability without creating a nonce claim, remote
      // ref, repository dispatch, or workflow run.
      signingKeyFromEnvironment();
    }
    dispatches.push({
      context: requirement.context,
      workflowId,
      transport: protectedConfig ? "repository_dispatch" : "workflow_dispatch",
    });
  }
  return { requirements, dispatches };
}

function ensureChecks({
  repository,
  base,
  sourceHead,
  targetHead,
  headRef,
  registrationSeconds = 30,
  registrationIntervalSeconds = 2,
  baseRevisionRetry = false,
  manifestPath,
  timeoutSeconds,
}) {
  const requirements = requiredChecks(repository, base);
  const sourceRuns = checkRuns(repository, sourceHead);
  let targetRuns = checkRuns(repository, targetHead);
  const protectedCheckRequired = requirements.some(protectedCheckConfig);
  const baseHead = protectedCheckRequired
    ? branchHeadSha(repository, base)
    : null;
  let monitor = monitorFor(
    manifestPath,
    { repository, base, sourceHead, targetHead, headRef },
    requirements,
    baseHead,
    timeoutSeconds ?? 900,
  );
  const deadline =
    monitor?.deadline ??
    (timeoutSeconds === undefined
      ? undefined
      : Date.now() + timeoutSeconds * 1000);
  assertBeforeDeadline(deadline);
  targetRuns = waitForRegistration({
    repository,
    targetHead,
    requirements,
    targetRuns,
    timeoutSeconds: registrationSeconds,
    intervalSeconds: registrationIntervalSeconds,
    deadline:
      deadline === undefined
        ? undefined
        : Math.min(deadline, Date.now() + registrationSeconds * 1000),
  });
  const dispatched = [];
  const dispatchedRequirements = [];
  const dispatchedWorkflowIds = new Set();
  const historicalRuns = new Map();
  for (const requirement of requirements) {
    assertBeforeDeadline(deadline);
    const protectedConfig = protectedCheckConfig(requirement);
    const persisted = monitor?.dispatches.find(
      (entry) => entry.requirement.context === requirement.context,
    );
    if (persisted) {
      rememberPersistedDispatch(dispatchedWorkflowIds, persisted);
      dispatched.push({
        context: requirement.context,
        workflowId: persisted.workflowId,
      });
      dispatchedRequirements.push(persisted);
      continue;
    }
    if (!protectedConfig) {
      const target = checkState(targetRuns, requirement);
      if (["pending", "success"].includes(target.state)) continue;
    }
    const workflowId = workflowIdForRequirement({
      repository,
      sourceHead,
      sourceRuns,
      requirement,
      protectedConfig,
      historicalRuns,
    });
    if (protectedConfig) {
      const target = trustedSecretCheckState({
        repository,
        runs: targetRuns,
        requirement,
        workflowId,
        base,
        targetHead,
        baseHead,
      });
      if (["pending", "success"].includes(target.state)) continue;
    }
    const currentDispatchKey = dispatchKey(
      workflowId,
      protectedConfig ? "repository_dispatch" : "workflow_dispatch",
    );
    let dispatchedRequirement = requirement;
    if (!dispatchedWorkflowIds.has(currentDispatchKey)) {
      const nonce = protectedConfig
        ? crypto.randomBytes(16).toString("hex")
        : null;
      if (protectedConfig)
        dispatchedRequirement = {
          ...requirement,
          externalId: `${protectedConfig.runPrefix}${targetHead}:${baseHead}:${nonce}`,
        };
      let entry = {
        requirement: dispatchedRequirement,
        workflowId,
        transport: protectedConfig
          ? "repository_dispatch"
          : "workflow_dispatch",
        nonce,
        status: "intended",
        issuedAt: Date.now(),
        expiresAt: deadline ?? null,
      };
      let shouldDispatch = true;
      if (monitor) {
        const persistedIntent = persistDispatch(manifestPath, monitor, entry);
        monitor = persistedIntent.monitor;
        entry = persistedIntent.entry;
        dispatchedRequirement = entry.requirement;
        shouldDispatch = persistedIntent.created;
      }
      try {
        if (shouldDispatch && protectedConfig) {
          dispatchRepositoryEvent(
            repository,
            protectedConfig.eventType,
            {
              head_sha: targetHead,
              base_sha: baseHead,
              nonce: entry.nonce,
            },
            deadline,
          );
        } else if (shouldDispatch) {
          dispatchWorkflow(repository, workflowId, headRef);
        }
        if (monitor && shouldDispatch)
          monitor = persistDispatch(manifestPath, monitor, entry, true).monitor;
      } catch (error) {
        const commandError = dispatchCommandError(error);
        if (monitor && commandError instanceof GhWriteTransportError) {
          process.stderr.write(
            `[quality] dispatch outcome uncertain; reconciling persisted intent for ${requirement.context}\n`,
          );
          dispatchedWorkflowIds.add(currentDispatchKey);
          dispatched.push({ context: requirement.context, workflowId });
          dispatchedRequirements.push(entry);
          continue;
        }
        if (monitor && shouldDispatch && commandError) {
          monitor = discardRejectedDispatch(manifestPath, monitor, entry);
        }
        targetRuns = checkRuns(repository, targetHead);
        const refreshed = protectedConfig
          ? { state: "missing" }
          : checkState(targetRuns, requirement);
        if (!["pending", "success"].includes(refreshed.state)) throw error;
      }
      dispatchedWorkflowIds.add(currentDispatchKey);
    }
    dispatched.push({ context: requirement.context, workflowId });
    dispatchedRequirements.push({
      requirement: dispatchedRequirement,
      workflowId,
    });
  }
  const deferred = [];
  if (dispatched.length > 0) {
    targetRuns = checkRuns(repository, targetHead);
    targetRuns = waitForRegistration({
      repository,
      targetHead,
      requirements: dispatchedRequirements.map((entry) => entry.requirement),
      targetRuns,
      timeoutSeconds: registrationSeconds,
      intervalSeconds: registrationIntervalSeconds,
      deadline,
      stateFor: (runs, requirement) =>
        protectedCheckConfig(requirement)
          ? trustedSecretCheckState({
              repository,
              runs,
              requirement,
              workflowId: dispatchedRequirements.find(
                (entry) => entry.requirement.context === requirement.context,
              ).workflowId,
              base,
              targetHead,
              baseHead,
            })
          : checkState(runs, requirement),
    });
    assertBeforeDeadline(deadline);
    const missing = dispatchedRequirements.filter((entry) => {
      const state = protectedCheckConfig(entry.requirement)
        ? trustedSecretCheckState({
            repository,
            runs: targetRuns,
            requirement: entry.requirement,
            workflowId: entry.workflowId,
            base,
            targetHead,
            baseHead,
          })
        : checkState(targetRuns, entry.requirement);
      return state.state === "missing";
    });
    const normalWorkflowIds = new Set(
      missing
        .filter((entry) => !protectedCheckConfig(entry.requirement))
        .map((entry) => entry.workflowId),
    );
    const workflowRuns = normalWorkflowIds.size
      ? dispatchedRunsForHead(
          repository,
          headRef,
          targetHead,
          normalWorkflowIds,
        )
      : new Map();
    const unregistered = missing.filter((entry) => {
      if (protectedCheckConfig(entry.requirement)) {
        // Repository-dispatch runs use the default branch metadata. The
        // target check is the only safe correlation signal; do not accept an
        // unrelated or merely active dispatch run as registration evidence.
        return true;
      }
      return !workflowRuns.has(entry.workflowId);
    });
    if (unregistered.length > 0) {
      throw new Error(
        `required checks or their exact-head workflows did not register on stamp ${targetHead} after workflow dispatch: ${unregistered
          .map(
            (entry) =>
              `${entry.requirement.context} (workflow ${entry.workflowId})`,
          )
          .join(", ")}`,
      );
    }
    const completedWithoutContext = missing.filter(
      (entry) => workflowRuns.get(entry.workflowId)?.status === "completed",
    );
    if (completedWithoutContext.length > 0) {
      throw new Error(
        `dispatched workflows completed without required checks on stamp ${targetHead}: ${completedWithoutContext
          .map(
            (entry) =>
              `${entry.requirement.context} (workflow ${entry.workflowId})`,
          )
          .join(", ")}`,
      );
    }
    for (const entry of missing) {
      const run = workflowRuns.get(entry.workflowId);
      deferred.push({
        context: entry.requirement.context,
        workflowId: entry.workflowId,
        runId: run.id,
        status: run.status,
      });
    }
  }
  if (protectedCheckRequired) {
    const currentBaseHead = branchHeadSha(repository, base);
    if (currentBaseHead !== baseHead) {
      if (monitor)
        throw new Error(
          "protected base changed during required-check monitoring; persisted deadline is not renewed",
        );
      if (baseRevisionRetry) {
        throw new Error(
          `protected scan base branch '${base}' changed during preparation from ${baseHead} to ${currentBaseHead}; retry after the base settles`,
        );
      }
      return ensureChecks({
        repository,
        base,
        sourceHead,
        targetHead,
        headRef,
        registrationSeconds,
        registrationIntervalSeconds,
        baseRevisionRetry: true,
        manifestPath,
        timeoutSeconds,
      });
    }
  }
  return { requirements, dispatched, deferred };
}

function inspectChecks(repository, base, head, monitor = null) {
  const requirements = requiredChecks(repository, base);
  const runs = checkRuns(repository, head);
  const baseHead = requirements.some(protectedCheckConfig)
    ? branchHeadSha(repository, base)
    : null;
  if (
    monitor &&
    (monitor.targetHead !== head ||
      monitor.base !== base ||
      monitor.baseHead !== baseHead ||
      JSON.stringify(monitor.requirements) !== JSON.stringify(requirements) ||
      !protectedMonitorLifetimeValid(monitor, requirements))
  ) {
    throw new Error(
      "required-check completion monitor bindings changed or are stale",
    );
  }
  return requirements.map((requirement) => {
    const persisted = monitor?.dispatches.find(
      (entry) => entry.requirement.context === requirement.context,
    );
    const boundRequirement = persisted?.requirement || requirement;
    return {
      ...requirement,
      ...(protectedCheckConfig(requirement)
        ? trustedSecretCheckState({
            repository,
            runs,
            requirement: boundRequirement,
            workflowId: persisted?.workflowId ?? null,
            base,
            targetHead: head,
            baseHead,
          })
        : checkState(runs, requirement)),
    };
  });
}

function assertChecks(repository, base, head, monitor = null) {
  const states = inspectChecks(repository, base, head, monitor);
  const incomplete = states.filter((entry) => entry.state !== "success");
  if (incomplete.length > 0) {
    throw new Error(
      `required exact-head checks are not successful: ${incomplete
        .map((entry) => `${entry.context}=${entry.state}`)
        .join(", ")}`,
    );
  }
  return states;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForChecks({
  repository,
  base,
  head,
  timeoutSeconds,
  intervalSeconds,
  failureGraceSeconds = 90,
  deadline: fixedDeadline,
  monitor = null,
}) {
  const startedAt = Date.now();
  const deadline = fixedDeadline ?? Date.now() + timeoutSeconds * 1000;
  let states = [];
  while (Date.now() < deadline) {
    states = inspectChecks(repository, base, head, monitor);
    if (states.every((entry) => entry.state === "success")) return states;
    const failed = states.filter((entry) => entry.state === "failed");
    if (
      failed.length > 0 &&
      Date.now() - startedAt >= failureGraceSeconds * 1000
    ) {
      throw new Error(
        `required exact-head checks failed: ${failed
          .map((entry) => entry.context)
          .join(", ")}`,
      );
    }
    process.stderr.write(
      `[quality] exact-head checks pending: ${states
        .filter((entry) => entry.state !== "success")
        .map((entry) => `${entry.context}=${entry.state}`)
        .join(", ")}\n`,
    );
    sleep(Math.min(intervalSeconds * 1000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `timed out waiting for exact-head required checks: ${states
      .filter((entry) => entry.state !== "success")
      .map((entry) => `${entry.context}=${entry.state}`)
      .join(", ")}`,
  );
}

function commandContext(options) {
  return {
    repository: validateRepository(requiredOption(options, "repo")),
    base: validateRef(requiredOption(options, "base"), "base"),
    head: validateSha(requiredOption(options, "head"), "head"),
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === "prepare" || command === "ensure") {
    const context = commandContext(options);
    const sourceHead = validateSha(
      requiredOption(options, "source-head"),
      "source-head",
    );
    if (command === "prepare") {
      process.stdout.write(
        `${JSON.stringify(
          prepareChecks({
            ...context,
            sourceHead,
            targetHead: context.head,
          }),
        )}\n`,
      );
      return;
    }
    const registrationSeconds = Number.parseInt(
      options["registration-timeout"] || "30",
      10,
    );
    if (!Number.isInteger(registrationSeconds) || registrationSeconds < 0) {
      throw new Error("--registration-timeout must be non-negative seconds");
    }
    const timeoutSeconds =
      options.timeout === undefined
        ? undefined
        : Number.parseInt(options.timeout, 10);
    if (
      timeoutSeconds !== undefined &&
      (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)
    ) {
      throw new Error("--timeout must be positive seconds");
    }
    const result = ensureChecks({
      ...context,
      sourceHead,
      targetHead: context.head,
      headRef: validateRef(requiredOption(options, "head-ref"), "head-ref"),
      registrationSeconds,
      manifestPath: options.manifest,
      timeoutSeconds,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "assert") {
    const context = commandContext(options);
    let monitor = null;
    if (options.manifest) {
      const quality = require("./quality-invocation.js");
      const manifest = quality.loadManifest(options.manifest).manifest;
      monitor = monitorForAssertion(manifest, context);
    }
    process.stdout.write(
      `${JSON.stringify(
        assertChecks(context.repository, context.base, context.head, monitor),
      )}\n`,
    );
    return;
  }
  if (command === "wait") {
    const context = commandContext(options);
    const timeout = Number.parseInt(requiredOption(options, "timeout"), 10);
    const interval = Number.parseInt(options.interval || "10", 10);
    const failureGrace = Number.parseInt(options["failure-grace"] || "90", 10);
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new Error("--timeout must be positive seconds");
    }
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error("--interval must be positive seconds");
    }
    if (!Number.isInteger(failureGrace) || failureGrace < 0) {
      throw new Error("--failure-grace must be non-negative seconds");
    }
    let deadline;
    let monitor = null;
    if (options.manifest) {
      const quality = require("./quality-invocation.js");
      const manifest = quality.loadManifest(options.manifest).manifest;
      monitor = manifest.merge?.requiredChecksMonitor || null;
      if (monitor) {
        assertMonitorIdentity(manifest, {
          repository: context.repository,
          base: context.base,
          sourceHead: manifest.revisions.currentHead,
          targetHead: context.head,
          headRef: manifest.repo.headRefName,
        });
        if (monitor.targetHead !== context.head) {
          throw new Error("required-check wait monitor head mismatch");
        }
        deadline = monitor.deadline;
        assertBeforeDeadline(deadline);
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        waitForChecks({
          repository: context.repository,
          base: context.base,
          head: context.head,
          timeoutSeconds: timeout,
          intervalSeconds: interval,
          failureGraceSeconds: failureGrace,
          deadline,
          monitor,
        }),
      )}\n`,
    );
    return;
  }
  if (command === "cleanup-claims") {
    process.stdout.write(`${JSON.stringify(cleanupClaimsCommand(options))}\n`);
    return;
  }
  throw new Error(
    "usage: quality-required-checks.js <prepare|ensure|wait|assert|cleanup-claims> ...",
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality required checks: ${error.message}\n`);
    process.exitCode = error instanceof GhReadTransportError ? 75 : 1;
  }
}

module.exports = {
  adoptPersistedDispatch,
  assertChecks,
  checkRuns,
  checkState,
  claimDispatchNonce,
  claimRemoteDispatchNonce,
  cleanupRemoteDispatchClaims,
  dispatchedRunsForHead,
  ensureChecks,
  matchingRuns,
  monitorForAssertion,
  newRequiredChecksMonitor,
  inspectChecks,
  isWriteTransportFailure,
  prepareChecks,
  protectedMonitorLifetimeValid,
  removeRejectedDispatch,
  rememberPersistedDispatch,
  requiredChecks,
  graphqlRequirements,
  trustedSecretCheckState,
  waitForChecks,
};
