#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { validUsage } = require("./quality-provider-usage");

const ROUTES = [
  "economy-micro",
  "economy-builder",
  "standard",
  "expert",
  "critical",
];
const PHASES_V2 = [
  "scan",
  "plan",
  "implement",
  "verify",
  "remediate",
  "diagnose",
  "review",
];
const ACCESS_RANK = ["read-only", "verification-only", "workspace-write"];
const PHASE_ACCESS = Object.freeze({
  scan: "read-only",
  plan: "read-only",
  review: "read-only",
  verify: "verification-only",
  implement: "workspace-write",
  remediate: "workspace-write",
  diagnose: "workspace-write",
});
const V2_OUTCOMES = new Set([
  "completed",
  "provider-failed",
  "provider-timeout",
  "provider-unavailable",
  "provider-exhausted",
  "replan-required",
  "capability-disabled",
]);
const SENSITIVE_RECORD_KEYS = new Set([
  "prompt",
  "promptBody",
  "credentials",
  "secret",
  "token",
  "apiKey",
]);
const FACT_KEYS = new Set([
  "provider",
  "phase",
  "readOnly",
  "localized",
  "reversible",
  "targetedProof",
  "ambiguous",
  "changedFiles",
  "protectedSurfaces",
  "sameFailureStreak",
  "publicContract",
  "crossRepository",
  "operatorRoute",
]);
const NATIVE_FACT_KEYS = [
  "provider",
  "phase",
  "readOnly",
  "localized",
  "reversible",
  "targetedProof",
  "ambiguous",
  "changedFiles",
  "protectedSurfaces",
  "sameFailureStreak",
  "publicContract",
  "crossRepository",
  "operatorRoute",
];
const CLAUDE_TASK_MODEL_ALIASES = {
  "claude-haiku-4-5": "haiku",
  "claude-sonnet-5": "sonnet",
};
const CLAUDE_TASK_PROFILES = {
  low: "native-task-low",
  medium: "native-task-medium",
  high: "native-task-high",
};
const BOOLEAN_FACT_KEYS = new Set([
  "readOnly",
  "localized",
  "reversible",
  "targetedProof",
  "ambiguous",
  "publicContract",
  "crossRepository",
]);
const EXECUTION_BINDING_KEYS = [
  "schemaVersion",
  "policyVersion",
  "promptSha256",
  "targetIdentitySha256",
  "targetHead",
  "classifiedProtectedSurfaces",
];

function policyPath() {
  return path.join(
    __dirname,
    "..",
    "config",
    "compute-governor-policy-v1.json",
  );
}

function policyV2Path() {
  return path.join(
    __dirname,
    "..",
    "config",
    "compute-governor-policy-v2.json",
  );
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`compute-governor: invalid JSON in ${label}`, {
      cause: error,
    });
  }
}

function routePolicyValid(routePolicy) {
  const providerValid = (provider, mapping) => {
    if (
      !mapping ||
      typeof mapping.model !== "string" ||
      mapping.model.trim().length === 0 ||
      mapping.model !== mapping.model.trim()
    )
      return false;
    const efforts =
      provider === "codex"
        ? ["low", "medium", "high", "xhigh"]
        : [null, "low", "medium", "high"];
    return efforts.includes(mapping.effort);
  };
  return Boolean(
    providerValid("codex", routePolicy?.providers?.codex) &&
    providerValid("claude", routePolicy?.providers?.claude) &&
    Number.isInteger(routePolicy.caps?.maxWallSeconds) &&
    routePolicy.caps.maxWallSeconds > 0 &&
    routePolicy.caps.maxWorkers === 1,
  );
}

function loadPolicy(file = policyPath()) {
  const policy = parseJson(fs.readFileSync(file, "utf8"), "policy");
  requireCondition(
    policy.schemaVersion === 1 &&
      typeof policy.policyVersion === "string" &&
      policy.policyVersion.length > 0 &&
      policy.routes &&
      Array.isArray(policy.protectedSurfaces) &&
      policy.protectedPromptPatterns,
    "compute-governor: unsupported policy schema version",
  );
  for (const route of ROUTES) {
    requireCondition(
      routePolicyValid(policy.routes[route]),
      `compute-governor: policy missing route '${route}'`,
    );
  }
  const patternSurfaces = Object.keys(policy.protectedPromptPatterns).sort();
  const protectedSurfaces = [...policy.protectedSurfaces].sort();
  requireCondition(
    JSON.stringify(patternSurfaces) === JSON.stringify(protectedSurfaces) &&
      patternSurfaces.every((surface) => {
        const patterns = policy.protectedPromptPatterns[surface];
        return (
          Array.isArray(patterns) &&
          patterns.length > 0 &&
          patterns.every(
            (pattern) => typeof pattern === "string" && pattern.length > 0,
          )
        );
      }),
    "compute-governor: protected prompt policy must exactly cover protected surfaces",
  );
  return policy;
}

function loadPolicyV2(file = policyV2Path()) {
  const policy = parseJson(fs.readFileSync(file, "utf8"), "phase policy");
  requireCondition(
    policy.schemaVersion === 2 &&
      typeof policy.policyVersion === "string" &&
      policy.routes?.standard?.model &&
      policy.routes?.critical?.model &&
      policy.executionProfile?.version &&
      policy.callers &&
      Array.isArray(policy.protectedSurfaces) &&
      policy.protectedPromptPatterns &&
      policy.protectedPathRules &&
      Array.isArray(policy.specializedExemptions) &&
      policy.specializedExemptions.length > 0 &&
      policy.specializedExemptions.every(
        (exemption) =>
          typeof exemption === "string" && /^[a-z0-9-]+$/.test(exemption),
      ) &&
      new Set(policy.specializedExemptions).size ===
        policy.specializedExemptions.length,
    "compute-governor: unsupported phase policy schema",
  );
  requireCondition(
    Object.keys(policy.protectedPromptPatterns).sort().join("\0") ===
      [...policy.protectedSurfaces].sort().join("\0") &&
      Object.keys(policy.protectedPathRules).sort().join("\0") ===
        [...policy.protectedSurfaces].sort().join("\0"),
    "compute-governor: phase protected policy must cover every surface",
  );
  return policy;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function targetHead(targetDir) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unversioned";
  }
}

function requireCleanVersionedTarget(targetDir) {
  const head = targetHead(targetDir);
  requireCondition(
    head !== "unversioned",
    "compute-governor: governed target must be a versioned git worktree",
  );
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  requireCondition(
    status.length === 0,
    "compute-governor: governed target worktree must be clean",
  );
  return head;
}

function classifiedProtectedSurfaces(prompt, policy) {
  return Object.entries(policy.protectedPromptPatterns)
    .filter(([surface, patterns]) => {
      requireCondition(
        policy.protectedSurfaces.includes(surface) &&
          Array.isArray(patterns) &&
          patterns.length > 0 &&
          patterns.every((pattern) => typeof pattern === "string"),
        `compute-governor: invalid protected prompt policy for '${surface}'`,
      );
      return patterns.some((pattern) => new RegExp(pattern, "iu").test(prompt));
    })
    .map(([surface]) => surface)
    .sort();
}

function classifiedProtectedPaths(plannedPaths, policy = loadPolicyV2()) {
  return Object.entries(policy.protectedPathRules)
    .filter(([, prefixes]) =>
      plannedPaths.some((plannedPath) =>
        prefixes.some((prefix) =>
          pathMatchesProtectedPrefix(plannedPath, prefix),
        ),
      ),
    )
    .map(([surface]) => surface)
    .sort();
}

function executionBinding(promptFile, targetDir, policy = loadPolicy()) {
  const prompt = fs.readFileSync(promptFile);
  const target = fs.realpathSync(targetDir);
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    promptSha256: sha256(prompt),
    targetIdentitySha256: sha256(target),
    targetHead: requireCleanVersionedTarget(target),
    classifiedProtectedSurfaces: classifiedProtectedSurfaces(
      prompt.toString("utf8"),
      policy,
    ),
  };
}

function resolveExecution(facts, promptFile, targetDir, policy = loadPolicy()) {
  assertFacts(facts, policy);
  const binding = executionBinding(promptFile, targetDir, policy);
  const declared = facts.protectedSurfaces ?? [];
  const protectedSurfaces = [
    ...new Set([...declared, ...binding.classifiedProtectedSurfaces]),
  ].sort();
  return {
    ...resolveLaunch({ ...facts, protectedSurfaces }, policy),
    executionBinding: binding,
  };
}

function normalizedPhaseV2(phase) {
  return phase === "test" ? "verify" : phase;
}

function phaseRequestValid(request, policy) {
  if (!request || request.schemaVersion !== 2) return false;
  const phase = normalizedPhaseV2(request.phase);
  const caller = policy.callers[request.caller];
  const evidence = request.evidence;
  if (
    request.provider !== "codex" ||
    !PHASES_V2.includes(phase) ||
    !caller ||
    !caller.phases.includes(phase) ||
    ACCESS_RANK.indexOf(PHASE_ACCESS[phase]) >
      ACCESS_RANK.indexOf(caller.maxAccess) ||
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  )
    return false;
  const expectedRequest = [
    "schemaVersion",
    "caller",
    "provider",
    "phase",
    "evidence",
  ].sort();
  const expectedEvidence = [
    "localized",
    "reversible",
    "targetedProof",
    "ambiguous",
    "changedFiles",
    "protectedSurfaces",
    "publicContract",
    "crossRepository",
    "plannedPaths",
  ].sort();
  if (
    Object.keys(request).sort().join("\0") !== expectedRequest.join("\0") ||
    Object.keys(evidence).sort().join("\0") !== expectedEvidence.join("\0")
  )
    return false;
  if (
    ![
      "localized",
      "reversible",
      "targetedProof",
      "ambiguous",
      "publicContract",
      "crossRepository",
    ].every((key) => typeof evidence[key] === "boolean") ||
    !Number.isInteger(evidence.changedFiles) ||
    evidence.changedFiles < 0 ||
    !Array.isArray(evidence.protectedSurfaces) ||
    !evidence.protectedSurfaces.every((surface) =>
      policy.protectedSurfaces.includes(surface),
    ) ||
    !Array.isArray(evidence.plannedPaths) ||
    evidence.plannedPaths.length === 0 ||
    !evidence.plannedPaths.every(
      (candidate) =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        candidate === candidate.trim() &&
        (candidate === "**" ||
          (!path.isAbsolute(candidate) &&
            !candidate.includes("\\") &&
            !candidate.split("/").includes("..") &&
            !candidate.split("/").includes("."))),
    )
  )
    return false;
  return (
    new Set(evidence.plannedPaths).size === evidence.plannedPaths.length &&
    new Set(evidence.protectedSurfaces).size ===
      evidence.protectedSurfaces.length
  );
}

function assertPhaseRequest(request, policy = loadPolicyV2()) {
  requireCondition(
    phaseRequestValid(request, policy),
    "compute-governor: invalid schema-v2 phase request",
  );
}

function phaseExecutionBinding(promptFile, targetDir, policy) {
  const prompt = fs.readFileSync(promptFile);
  const target = fs.realpathSync(targetDir);
  return {
    schemaVersion: 2,
    policyVersion: policy.policyVersion,
    promptSha256: sha256(prompt),
    targetIdentitySha256: sha256(target),
    targetHead: requireCleanVersionedTarget(target),
    classifiedProtectedSurfaces: classifiedProtectedSurfaces(
      prompt.toString("utf8"),
      policy,
    ),
  };
}

function resolvePhaseExecution(
  request,
  promptFile,
  targetDir,
  policy = loadPolicyV2(),
) {
  assertPhaseRequest(request, policy);
  const phase = normalizedPhaseV2(request.phase);
  const binding = phaseExecutionBinding(promptFile, targetDir, policy);
  const protectedSurfaces = [
    ...new Set([
      ...request.evidence.protectedSurfaces,
      ...binding.classifiedProtectedSurfaces,
    ]),
  ].sort();
  const critical =
    protectedSurfaces.length > 0 ||
    request.evidence.publicContract ||
    request.evidence.crossRepository;
  const route = critical ? "critical" : "standard";
  const routePolicy = policy.routes[route];
  const executionProfile = {
    version: policy.executionProfile.version,
    sha256: sha256(canonicalJsonString(policy.executionProfile)),
  };
  return {
    schemaVersion: 2,
    policyVersion: policy.policyVersion,
    route,
    provider: "codex",
    model: routePolicy.model,
    effort: routePolicy.effort,
    contextClass: "fresh-bounded-phase",
    caller: request.caller,
    phase,
    accessProfile: PHASE_ACCESS[phase],
    caps: routePolicy.caps,
    safetyFloor: critical ? "critical" : "standard",
    evidence: canonicalJson({
      ...request.evidence,
      protectedSurfaces,
      plannedPaths: [...request.evidence.plannedPaths].sort(),
    }),
    reasons: critical
      ? ["protected phase work"]
      : ["reliable standard baseline"],
    promotion: "economy-execution-disabled",
    executionProfile,
    executionBinding: binding,
  };
}

function canonicalJsonString(value) {
  return JSON.stringify(canonicalJson(value));
}

function resolveLaunch(facts, policy = loadPolicy()) {
  const candidate = resolve(facts, policy);
  if (!candidate.route.startsWith("economy")) return candidate;
  const mapping = policy.routes.standard.providers[candidate.provider];
  return {
    ...candidate,
    route: "standard",
    model: mapping.model,
    effort: mapping.effort,
    caps: policy.routes.standard.caps,
    reasons: [
      ...candidate.reasons,
      "economy candidate lacks approved calibration",
    ],
    promotion: "calibration-required-standard-fallback",
  };
}

function rank(route) {
  const result = ROUTES.indexOf(route);
  if (result === -1)
    throw new Error(`compute-governor: invalid route '${route}'`);
  return result;
}

function atLeast(current, candidate) {
  return rank(candidate) > rank(current) ? candidate : current;
}

function protectedSurfacesValid(facts, policy) {
  const surfaces = facts.protectedSurfaces ?? [];
  return (
    Array.isArray(surfaces) &&
    surfaces.every(
      (surface) =>
        typeof surface === "string" &&
        policy.protectedSurfaces.includes(surface),
    )
  );
}

function scalarFactsValid(facts) {
  const changedFilesValid =
    facts.changedFiles === undefined ||
    (Number.isInteger(facts.changedFiles) && facts.changedFiles >= 0);
  const failureStreakValid =
    facts.sameFailureStreak === undefined ||
    (Number.isInteger(facts.sameFailureStreak) && facts.sameFailureStreak >= 0);
  const operatorRouteValid =
    facts.operatorRoute === undefined || ROUTES.includes(facts.operatorRoute);
  const booleansValid = [...BOOLEAN_FACT_KEYS].every(
    (key) => facts[key] === undefined || typeof facts[key] === "boolean",
  );
  return (
    changedFilesValid &&
    failureStreakValid &&
    operatorRouteValid &&
    booleansValid
  );
}

function assertFacts(facts, policy) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new Error("compute-governor: facts must be an object");
  }
  if (!["codex", "claude"].includes(facts.provider)) {
    throw new Error("compute-governor: facts.provider must be codex or claude");
  }
  if (
    !["scan", "implement", "test", "review", "diagnose"].includes(facts.phase)
  ) {
    throw new Error("compute-governor: facts.phase is invalid");
  }
  if (!protectedSurfacesValid(facts, policy)) {
    throw new Error("compute-governor: facts.protectedSurfaces is invalid");
  }
  if (!scalarFactsValid(facts)) {
    throw new Error("compute-governor: numeric or route facts are invalid");
  }
  const unsupported = Object.keys(facts).filter((key) => !FACT_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `compute-governor: unsupported execution fact '${unsupported[0]}'`,
    );
  }
}

function canonicalFacts(facts) {
  return Object.fromEntries(
    [...FACT_KEYS]
      .filter((key) => facts[key] !== undefined)
      .sort()
      .map((key) => [key, facts[key]]),
  );
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

function safetyFloor(facts, policy) {
  const surfaces = Array.isArray(facts.protectedSurfaces)
    ? facts.protectedSurfaces
    : [];
  const protectedHit = surfaces.find((surface) =>
    policy.protectedSurfaces.includes(surface),
  );
  if (protectedHit)
    return { route: "critical", reason: `protected surface: ${protectedHit}` };
  if (facts.publicContract === true || facts.crossRepository === true) {
    return {
      route: "critical",
      reason: facts.publicContract
        ? "public contract"
        : "cross-repository dependency",
    };
  }
  return { route: "economy-micro", reason: "no protected surface" };
}

function isEconomyBuilder(facts) {
  return (
    facts.localized === true &&
    facts.reversible === true &&
    facts.targetedProof === true &&
    facts.ambiguous !== true &&
    (facts.changedFiles || 1) <= 2
  );
}

function standardReason(facts) {
  if (facts.ambiguous === true) return "ambiguous behavior";
  if (facts.targetedProof !== true)
    return "targeted deterministic proof missing";
  if ((facts.changedFiles || 0) > 5) return "scope exceeds economy cap";
  return "ordinary implementation or test work";
}

function workTier(facts) {
  const attempts = Number.isInteger(facts.sameFailureStreak)
    ? facts.sameFailureStreak
    : 0;
  if (attempts >= 2)
    return { route: "expert", reasons: ["two matching failed attempts"] };
  if (facts.operatorRoute)
    return { route: facts.operatorRoute, reasons: ["operator override"] };
  if (
    facts.phase === "scan" &&
    facts.readOnly === true &&
    facts.localized === true
  ) {
    return { route: "economy-micro", reasons: ["bounded read-only scan"] };
  }
  if (isEconomyBuilder(facts)) {
    return {
      route: "economy-builder",
      reasons: [
        "localized reversible behavior",
        "targeted deterministic proof",
      ],
    };
  }
  return { route: "standard", reasons: [standardReason(facts)] };
}

function resolveFacts(facts, policy = loadPolicy(), selectWorkTier = workTier) {
  assertFacts(facts, policy);
  const boundFacts = canonicalFacts(facts);
  const floor = safetyFloor(facts, policy);
  const work = selectWorkTier(facts);
  const route = atLeast(floor.route, work.route);
  const mapping = policy.routes[route].providers[facts.provider];
  return { boundFacts, floor, work, route, mapping };
}

function resolve(facts, policy = loadPolicy()) {
  if (facts?.interface === "native-advisory")
    return resolveNative(facts, policy);
  const { boundFacts, floor, work, route, mapping } = resolveFacts(
    facts,
    policy,
  );
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    route,
    provider: facts.provider,
    model: mapping.model,
    effort: mapping.effort,
    contextClass: "fresh-bounded",
    caps: policy.routes[route].caps,
    safetyFloor: floor.route,
    facts: boundFacts,
    reasons: [floor.reason, ...work.reasons],
    promotion: route.startsWith("economy")
      ? "candidate-requires-calibration"
      : "not-applicable",
  };
}

function nativeIdentityValid(identity) {
  return Boolean(
    identity &&
    typeof identity.model === "string" &&
    identity.model.trim().length > 0 &&
    identity.model === identity.model.trim() &&
    (identity.effort === null ||
      (typeof identity.effort === "string" && identity.effort.length > 0)),
  );
}

function nativeTaskValid(task) {
  return Boolean(
    task &&
    typeof task.text === "string" &&
    task.text.trim().length > 0 &&
    task.text === task.text.trim() &&
    Array.isArray(task.plannedPaths) &&
    task.plannedPaths.length > 0 &&
    task.plannedPaths.every(
      (candidate) =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        candidate === candidate.trim() &&
        (candidate === "**" ||
          (!path.isAbsolute(candidate) &&
            !candidate.includes("\\") &&
            !candidate
              .split("/")
              .some((part) => ["", ".", ".."].includes(part)))),
    ) &&
    new Set(task.plannedPaths).size === task.plannedPaths.length,
  );
}

function nativeFacts(facts, policy) {
  requireCondition(
    facts && typeof facts === "object" && !Array.isArray(facts),
    "compute-governor: native consequence facts are incomplete or invalid",
  );
  assertExactKeys(facts, NATIVE_FACT_KEYS, "native advisory facts");
  requireCondition(
    [
      "readOnly",
      "localized",
      "reversible",
      "targetedProof",
      "ambiguous",
      "publicContract",
      "crossRepository",
    ].every((key) => typeof facts[key] === "boolean") &&
      Number.isInteger(facts.changedFiles) &&
      facts.changedFiles >= 0 &&
      Number.isInteger(facts.sameFailureStreak) &&
      facts.sameFailureStreak >= 0 &&
      Array.isArray(facts.protectedSurfaces),
    "compute-governor: native consequence facts are incomplete or invalid",
  );
  requireCondition(
    facts.operatorRoute === null || ROUTES.includes(facts.operatorRoute),
    "compute-governor: native operator route is invalid",
  );
  const normalized = { ...facts };
  if (normalized.operatorRoute === null) delete normalized.operatorRoute;
  assertFacts(normalized, policy);
  return normalized;
}

function nativeModelCapabilityValid(model) {
  return Boolean(
    typeof model?.model === "string" &&
    model.model.trim().length > 0 &&
    Array.isArray(model.efforts) &&
    model.efforts.every(
      (effort) => effort === null || typeof effort === "string",
    ) &&
    new Set(model.efforts).size === model.efforts.length,
  );
}

function nativeProfileCapabilityValid(profile) {
  return Boolean(
    typeof profile?.subagent_type === "string" &&
    profile.subagent_type.trim().length > 0 &&
    (profile.effort === null || typeof profile.effort === "string"),
  );
}

function nativeProfilesValid(profiles) {
  return Boolean(
    profiles === null ||
    (Array.isArray(profiles) &&
      profiles.every(nativeProfileCapabilityValid) &&
      new Set(
        profiles.map((profile) => `${profile.subagent_type}:${profile.effort}`),
      ).size === profiles.length),
  );
}

function nativeCapabilitiesValid(capabilities) {
  return Boolean(
    capabilities &&
    [true, false, null].includes(capabilities.delegation) &&
    [true, false, null].includes(capabilities.overrides) &&
    (capabilities.models === null ||
      (Array.isArray(capabilities.models) &&
        capabilities.models.every(nativeModelCapabilityValid))) &&
    nativeProfilesValid(capabilities.profiles),
  );
}

function assertNativeRequest(request, policy) {
  requireCondition(
    request?.interface === "native-advisory" &&
      request.schemaVersion === 1 &&
      request.work === "delegation",
    "compute-governor: invalid native advisory request",
  );
  assertExactKeys(
    request,
    [
      "interface",
      "schemaVersion",
      "work",
      "facts",
      "task",
      "parent",
      "override",
      "fork",
      "capabilities",
    ],
    "native advisory request",
  );
  requireCondition(
    request.facts &&
      typeof request.facts === "object" &&
      !Array.isArray(request.facts),
    "compute-governor: native consequence facts are incomplete or invalid",
  );
  requireCondition(
    nativeIdentityValid(request.parent) &&
      (request.override === null || nativeIdentityValid(request.override)) &&
      ["all", "bounded", "none"].includes(request.fork) &&
      nativeTaskValid(request.task),
    "compute-governor: invalid native identity, context, or task",
  );
  for (const identity of [request.parent, request.override].filter(Boolean)) {
    assertExactKeys(identity, ["model", "effort"], "native identity");
  }
  const capabilities = request.capabilities;
  requireCondition(
    nativeCapabilitiesValid(capabilities),
    "compute-governor: invalid native capabilities",
  );
  assertExactKeys(
    capabilities,
    ["delegation", "overrides", "models", "profiles"],
    "native capabilities",
  );
  for (const model of capabilities.models || []) {
    assertExactKeys(model, ["model", "efforts"], "native model capability");
  }
  for (const profile of capabilities.profiles || []) {
    assertExactKeys(
      profile,
      ["subagent_type", "effort"],
      "native task profile capability",
    );
  }
  return nativeFacts(request.facts, policy);
}

function nativeWorkTier(facts) {
  const work = workTier(facts);
  if (facts.ambiguous === true && rank(work.route) < rank("standard")) {
    return { route: "standard", reasons: ["ambiguous behavior"] };
  }
  return work;
}

function routeForIdentity(identity, provider, minimumRoute, policy) {
  return ROUTES.find((route) => {
    const mapping = policy.routes[route].providers[provider];
    return (
      rank(route) >= rank(minimumRoute) &&
      mapping.model === identity.model &&
      mapping.effort === identity.effort
    );
  });
}

function profileForIdentity(capabilities, identity) {
  const expectedProfile =
    identity.effort === null
      ? "general-purpose"
      : CLAUDE_TASK_PROFILES[identity.effort];
  if (!expectedProfile) return undefined;
  return capabilities.profiles?.find(
    (profile) =>
      profile.subagent_type === expectedProfile &&
      profile.effort === identity.effort,
  );
}

function capabilitySupportsIdentity(capabilities, identity, provider) {
  const modelSupported = capabilities.models?.some(
    (model) =>
      model.model === identity.model && model.efforts.includes(identity.effort),
  );
  return Boolean(
    modelSupported &&
    (provider !== "claude" ||
      (CLAUDE_TASK_MODEL_ALIASES[identity.model] &&
        profileForIdentity(capabilities, identity))),
  );
}

function nativeModelArguments(provider, identity, capabilities) {
  if (provider === "codex") {
    return { model: identity.model, reasoning_effort: identity.effort };
  }
  const profile = profileForIdentity(capabilities, identity);
  if (!profile) return null;
  return {
    subagent_type: profile.subagent_type,
    model: CLAUDE_TASK_MODEL_ALIASES[identity.model],
  };
}

function nativeBlocks(request, inherited, requested, requestedRoute, provider) {
  const blocks = [];
  if (request.capabilities.delegation !== true) {
    blocks.push("native delegation unavailable or unknown");
  }
  if (inherited && request.override !== null) {
    blocks.push(
      "full-history forks inherit model and effort; overrides are unsupported",
    );
  }
  if (!inherited && request.capabilities.overrides !== true) {
    blocks.push(
      "bounded or fresh model override support unavailable or unknown",
    );
  }
  if (!capabilitySupportsIdentity(request.capabilities, requested, provider)) {
    blocks.push("requested model and effort unavailable or unknown");
  }
  if (!requestedRoute) {
    blocks.push("requested identity is below the native task safety floor");
  }
  return blocks;
}

function resolveNative(request, policy = loadPolicy()) {
  const facts = assertNativeRequest(request, policy);
  const textSurfaces = classifiedProtectedSurfaces(request.task.text, policy);
  const pathSurfaces = classifiedProtectedPaths(request.task.plannedPaths);
  const taskProtectedSurfaces = [
    ...new Set([...facts.protectedSurfaces, ...textSurfaces, ...pathSurfaces]),
  ].sort();
  const classifiedFacts = {
    ...facts,
    protectedSurfaces: taskProtectedSurfaces,
  };
  const classification = resolveFacts(classifiedFacts, policy, nativeWorkTier);
  const safetyFloor = atLeast(
    classification.floor.route,
    facts.operatorRoute || classification.floor.route,
  );
  const recommendationRoute = atLeast(classification.route, safetyFloor);
  const recommendationMapping =
    policy.routes[recommendationRoute].providers[classifiedFacts.provider];
  const recommendation = {
    route: recommendationRoute,
    model: recommendationMapping.model,
    effort: recommendationMapping.effort,
    reasons: [classification.floor.reason, ...classification.work.reasons],
  };
  const inherited = request.fork === "all";
  const requested =
    request.override || (inherited ? request.parent : recommendation);
  const requestedRoute = routeForIdentity(
    requested,
    classifiedFacts.provider,
    safetyFloor,
    policy,
  );
  const blocks = nativeBlocks(
    request,
    inherited,
    requested,
    requestedRoute,
    classifiedFacts.provider,
  );
  const overrideBelowRecommendation = Boolean(
    request.override &&
    requestedRoute &&
    rank(requestedRoute) < rank(recommendation.route),
  );
  const reasons = [
    ...recommendation.reasons,
    ...(overrideBelowRecommendation
      ? ["explicit override is below the advisory recommendation"]
      : []),
    ...blocks,
  ];
  return {
    interface: "native-advisory",
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    status: blocks.length > 0 ? "blocked" : "ready",
    advisoryOnly: true,
    work: request.work,
    provider: facts.provider,
    role: facts.phase,
    parent: { ...request.parent },
    safetyFloor,
    recommendation,
    requested,
    requestedRoute,
    overrideBelowRecommendation,
    modelArguments:
      !inherited && blocks.length === 0
        ? nativeModelArguments(
            classifiedFacts.provider,
            requested,
            request.capabilities,
          )
        : null,
    task: {
      sha256: sha256(canonicalJsonString(request.task)),
      classifiedProtectedSurfaces: taskProtectedSurfaces,
    },
    observed: null,
    usage: null,
    reasons,
    constraints: {
      preserveParentSelection: true,
      preservePermissions: true,
      preserveRequiredContext: true,
      launches: 0,
      executionReceipt: false,
      grantsAuthority: false,
    },
  };
}

function planIdentityValid(plan, policy) {
  const mapping = policy.routes[plan.route].providers[plan.provider];
  return (
    plan.policyVersion === policy.policyVersion &&
    plan.model === mapping.model &&
    plan.effort === mapping.effort
  );
}

function planContractValid(plan, policy) {
  const expectedCaps = policy.routes[plan.route].caps;
  const expectedPromotion = plan.executionBinding
    ? resolveLaunch(plan.facts, policy).promotion
    : plan.route.startsWith("economy")
      ? "candidate-requires-calibration"
      : "not-applicable";
  return (
    plan.contextClass === "fresh-bounded" &&
    plan.facts &&
    JSON.stringify(canonicalJson(plan.caps)) ===
      JSON.stringify(canonicalJson(expectedCaps)) &&
    Array.isArray(plan.reasons) &&
    plan.reasons.length > 0 &&
    plan.reasons.every(
      (reason) => typeof reason === "string" && reason.length > 0,
    ) &&
    plan.promotion === expectedPromotion
  );
}

function executionBindingValid(binding, policy) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding))
    return false;
  const keys = Object.keys(binding).sort();
  const expectedKeys = [...EXECUTION_BINDING_KEYS].sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    binding.schemaVersion === 1 &&
    binding.policyVersion === policy.policyVersion &&
    /^[0-9a-f]{64}$/.test(binding.promptSha256) &&
    /^[0-9a-f]{64}$/.test(binding.targetIdentitySha256) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.targetHead) &&
    Array.isArray(binding.classifiedProtectedSurfaces) &&
    binding.classifiedProtectedSurfaces.every(
      (surface) =>
        typeof surface === "string" &&
        policy.protectedSurfaces.includes(surface),
    ) &&
    new Set(binding.classifiedProtectedSurfaces).size ===
      binding.classifiedProtectedSurfaces.length &&
    JSON.stringify(binding.classifiedProtectedSurfaces) ===
      JSON.stringify([...binding.classifiedProtectedSurfaces].sort())
  );
}

function phaseBindingValid(binding, policy) {
  return Boolean(
    binding &&
    binding.schemaVersion === 2 &&
    binding.policyVersion === policy.policyVersion &&
    /^[0-9a-f]{64}$/.test(binding.promptSha256) &&
    /^[0-9a-f]{64}$/.test(binding.targetIdentitySha256) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.targetHead) &&
    Array.isArray(binding.classifiedProtectedSurfaces) &&
    binding.classifiedProtectedSurfaces.every((surface) =>
      policy.protectedSurfaces.includes(surface),
    ),
  );
}

function validatePhasePlan(plan, policy = loadPolicyV2()) {
  requireCondition(
    plan?.schemaVersion === 2 &&
      ["standard", "critical"].includes(plan.route) &&
      plan.provider === "codex" &&
      PHASES_V2.includes(plan.phase) &&
      plan.accessProfile === PHASE_ACCESS[plan.phase] &&
      policy.callers[plan.caller]?.phases.includes(plan.phase) &&
      ACCESS_RANK.indexOf(plan.accessProfile) <=
        ACCESS_RANK.indexOf(policy.callers[plan.caller].maxAccess),
    "compute-governor: invalid schema-v2 phase plan",
  );
  const protectedWork =
    plan.evidence?.protectedSurfaces?.length > 0 ||
    plan.evidence?.publicContract === true ||
    plan.evidence?.crossRepository === true;
  const expectedRoute = protectedWork ? "critical" : "standard";
  const routePolicy = policy.routes[expectedRoute];
  const expectedProfile = {
    version: policy.executionProfile.version,
    sha256: sha256(canonicalJsonString(policy.executionProfile)),
  };
  requireCondition(
    plan.policyVersion === policy.policyVersion &&
      plan.route === expectedRoute &&
      plan.model === routePolicy.model &&
      plan.effort === routePolicy.effort &&
      plan.safetyFloor === expectedRoute &&
      plan.contextClass === "fresh-bounded-phase" &&
      plan.promotion === "economy-execution-disabled" &&
      canonicalJsonString(plan.caps) ===
        canonicalJsonString(routePolicy.caps) &&
      canonicalJsonString(plan.executionProfile) ===
        canonicalJsonString(expectedProfile) &&
      phaseBindingValid(plan.executionBinding, policy),
    "compute-governor: schema-v2 plan violates phase policy",
  );
  const request = {
    schemaVersion: 2,
    caller: plan.caller,
    provider: plan.provider,
    phase: plan.phase,
    evidence: plan.evidence,
  };
  assertPhaseRequest(request, policy);
  const expectedKeys = [
    "schemaVersion",
    "policyVersion",
    "route",
    "provider",
    "model",
    "effort",
    "contextClass",
    "caller",
    "phase",
    "accessProfile",
    "caps",
    "safetyFloor",
    "evidence",
    "reasons",
    "promotion",
    "executionProfile",
    "executionBinding",
  ];
  assertExactKeys(plan, expectedKeys, "schema-v2 phase plan");
  requireCondition(
    Array.isArray(plan.reasons) &&
      canonicalJsonString(plan.reasons) ===
        canonicalJsonString(
          protectedWork
            ? ["protected phase work"]
            : ["reliable standard baseline"],
        ),
    "compute-governor: schema-v2 plan reasons mismatch",
  );
  return plan;
}

function validatePhaseExecutionPlan(
  plan,
  promptFile,
  targetDir,
  policy = loadPolicyV2(),
) {
  validatePhasePlan(plan, policy);
  requireCondition(
    canonicalJsonString(plan.executionBinding) ===
      canonicalJsonString(phaseExecutionBinding(promptFile, targetDir, policy)),
    "compute-governor: schema-v2 plan is not bound to this prompt and target",
  );
  const expected = resolvePhaseExecution(
    {
      schemaVersion: 2,
      caller: plan.caller,
      provider: plan.provider,
      phase: plan.phase,
      evidence: plan.evidence,
    },
    promptFile,
    targetDir,
    policy,
  );
  requireCondition(
    canonicalJsonString(plan) === canonicalJsonString(expected),
    "compute-governor: schema-v2 phase plan is not exact",
  );
  return plan;
}

function validatePlan(plan, policy = loadPolicy()) {
  if (plan?.schemaVersion === 2) return validatePhasePlan(plan);
  requireCondition(
    plan && plan.schemaVersion === 1 && ROUTES.includes(plan.route),
    "compute-governor: invalid execution plan",
  );
  requireCondition(
    ["codex", "claude"].includes(plan.provider),
    "compute-governor: invalid plan provider",
  );
  requireCondition(
    planIdentityValid(plan, policy),
    "compute-governor: plan model/effort violates policy",
  );
  requireCondition(
    ROUTES.includes(plan.safetyFloor) &&
      rank(plan.route) >= rank(plan.safetyFloor),
    "compute-governor: plan route is below its safety floor",
  );
  requireCondition(
    planContractValid(plan, policy),
    "compute-governor: invalid execution plan contract",
  );
  requireCondition(
    plan.executionBinding === undefined ||
      executionBindingValid(plan.executionBinding, policy),
    "compute-governor: execution binding schema mismatch",
  );
  const expected = {
    ...(plan.executionBinding
      ? resolveLaunch(plan.facts, policy)
      : resolve(plan.facts, policy)),
    ...(plan.executionBinding
      ? { executionBinding: plan.executionBinding }
      : {}),
  };
  requireCondition(
    JSON.stringify(canonicalJson(plan)) ===
      JSON.stringify(canonicalJson(expected)),
    "compute-governor: execution plan is not bound to its facts",
  );
  return plan;
}

function validateExecutionPlan(
  plan,
  promptFile,
  targetDir,
  policy = loadPolicy(),
) {
  if (plan?.schemaVersion === 2)
    return validatePhaseExecutionPlan(plan, promptFile, targetDir);
  validatePlan(plan, policy);
  requireCondition(
    plan.executionBinding &&
      JSON.stringify(canonicalJson(plan.executionBinding)) ===
        JSON.stringify(
          canonicalJson(executionBinding(promptFile, targetDir, policy)),
        ),
    "compute-governor: execution plan is not bound to this prompt and target",
  );
  const expected = resolveExecution(plan.facts, promptFile, targetDir, policy);
  requireCondition(
    JSON.stringify(canonicalJson(plan)) ===
      JSON.stringify(canonicalJson(expected)),
    "compute-governor: protected execution facts do not match task evidence",
  );
  return plan;
}

function runRecordIdentityValid(record) {
  const identity = ["provider", "model", "effort"];
  return (
    identity.every((key) => record.requested[key] === record.plan[key]) &&
    identity.every((key) => record.effective[key] === record.plan[key])
  );
}

function timingValid(record) {
  return (
    Number.isInteger(record.attempts) &&
    record.attempts > 0 &&
    Number.isInteger(record.timing.startedAtEpochMs) &&
    Number.isInteger(record.timing.finishedAtEpochMs) &&
    record.timing.finishedAtEpochMs >= record.timing.startedAtEpochMs
  );
}

function outcomeValid(outcome) {
  const statuses = ["passed", "failed", "timeout", "unavailable", "exhausted"];
  if (!Number.isInteger(outcome.exitCode) || !statuses.includes(outcome.status))
    return false;
  if (outcome.status === "passed") {
    return outcome.exitCode === 0 && outcome.providerFailureCategory === null;
  }
  return (
    outcome.exitCode !== 0 &&
    typeof outcome.providerFailureCategory === "string" &&
    outcome.providerFailureCategory.length > 0
  );
}

function usageValid(usage) {
  return validUsage(usage) || validUsage(usage, { aggregate: true });
}

function validatePhaseRunRecord(record) {
  requireCondition(
    record?.schemaVersion === 2 &&
      record.plan?.schemaVersion === 2 &&
      V2_OUTCOMES.has(record.outcome?.status),
    "compute-governor: invalid schema-v2 phase run record",
  );
  assertNoSensitiveRecordFields(record);
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "plan",
      "requested",
      "effective",
      "timing",
      "outcome",
      "usage",
    ],
    "schema-v2 run record",
  );
  assertExactKeys(
    record.requested,
    ["provider", "model", "effort", "executionProfileSha256"],
    "schema-v2 requested identity",
  );
  assertExactKeys(
    record.effective,
    ["provider", "model", "effort", "executionProfileSha256"],
    "schema-v2 effective identity",
  );
  assertExactKeys(
    record.timing,
    ["startedAtEpochMs", "finishedAtEpochMs"],
    "schema-v2 timing",
  );
  assertExactKeys(
    record.outcome,
    ["status", "exitCode", "category"],
    "schema-v2 outcome",
  );
  validatePhasePlan(record.plan);
  const expectedIdentity = {
    provider: record.plan.provider,
    model: record.plan.model,
    effort: record.plan.effort,
    executionProfileSha256: record.plan.executionProfile.sha256,
  };
  const completed = record.outcome.status === "completed";
  requireCondition(
    canonicalJsonString(record.requested) ===
      canonicalJsonString(expectedIdentity) &&
      canonicalJsonString(record.effective) ===
        canonicalJsonString(expectedIdentity) &&
      Number.isInteger(record.timing.startedAtEpochMs) &&
      Number.isInteger(record.timing.finishedAtEpochMs) &&
      record.timing.finishedAtEpochMs >= record.timing.startedAtEpochMs &&
      Number.isInteger(record.outcome.exitCode) &&
      (completed
        ? record.outcome.exitCode === 0 && record.outcome.category === null
        : record.outcome.exitCode !== 0 &&
          typeof record.outcome.category === "string" &&
          record.outcome.category.length > 0) &&
      usageValid(record.usage),
    "compute-governor: schema-v2 run record contract mismatch",
  );
  return record;
}

function validateRunRecord(record) {
  if (record?.schemaVersion === 2) return validatePhaseRunRecord(record);
  requireCondition(
    record &&
      record.schemaVersion === 1 &&
      record.plan &&
      record.outcome &&
      record.requested &&
      record.effective &&
      record.timing,
    "compute-governor: invalid run record",
  );
  assertNoSensitiveRecordFields(record);
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "plan",
      "requested",
      "effective",
      "attempts",
      "timing",
      "outcome",
      "usage",
    ],
    "run record",
  );
  assertExactKeys(
    record.requested,
    ["provider", "model", "effort"],
    "requested identity",
  );
  assertExactKeys(
    record.effective,
    ["provider", "model", "effort"],
    "effective identity",
  );
  assertExactKeys(
    record.timing,
    ["startedAtEpochMs", "finishedAtEpochMs"],
    "timing",
  );
  assertExactKeys(
    record.outcome,
    ["status", "exitCode", "providerFailureCategory"],
    "outcome",
  );
  validatePlan(record.plan);
  requireCondition(
    runRecordIdentityValid(record) &&
      timingValid(record) &&
      outcomeValid(record.outcome),
    "compute-governor: invalid run record contract",
  );
  if (!usageValid(record.usage)) {
    throw new Error(
      "compute-governor: usage must be null or match the redacted exact-token schema",
    );
  }
  return record;
}

function assertExactKeys(value, allowed, label) {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = allowed.filter((key) => !(key in value));
  requireCondition(
    unknown.length === 0 && missing.length === 0,
    `compute-governor: ${label} schema mismatch`,
  );
}

function assertNoSensitiveRecordFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_RECORD_KEYS.has(key)) {
      throw new Error(`compute-governor: forbidden run-record field '${key}'`);
    }
    assertNoSensitiveRecordFields(child);
  }
}

function calibrationRunValid(run) {
  return Boolean(
    run &&
    typeof run.accepted === "boolean" &&
    typeof run.gatesPassed === "boolean" &&
    Number.isInteger(run.attempts) &&
    run.attempts > 0 &&
    Number.isFinite(run.elapsedMs) &&
    run.elapsedMs >= 0,
  );
}

function calibrationThresholdValid(value) {
  return (
    value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

function calibrationDecision(report) {
  if (
    !report ||
    !Array.isArray(report.baseline) ||
    !Array.isArray(report.candidate) ||
    report.baseline.length === 0 ||
    report.baseline.length !== report.candidate.length
  ) {
    throw new Error(
      "compute-governor: calibration requires equal non-empty baseline and candidate arrays",
    );
  }
  if (
    !report.baseline.every(calibrationRunValid) ||
    !report.candidate.every(calibrationRunValid) ||
    !calibrationThresholdValid(report.maxAcceptanceRateDrop)
  ) {
    throw new Error("compute-governor: calibration run evidence is incomplete");
  }
  const allowedDrop = Number.isFinite(report.maxAcceptanceRateDrop)
    ? report.maxAcceptanceRateDrop
    : 0.05;
  const metrics = (runs) => ({
    acceptanceRate:
      runs.filter((run) => run.accepted === true && run.gatesPassed === true)
        .length / runs.length,
    averageAttempts:
      runs.reduce(
        (sum, run) =>
          sum + (Number.isFinite(run.attempts) ? run.attempts : Infinity),
        0,
      ) / runs.length,
    averageElapsedMs:
      runs.reduce((sum, run) => sum + run.elapsedMs, 0) / runs.length,
  });
  const baseline = metrics(report.baseline);
  const candidate = metrics(report.candidate);
  const accepted =
    candidate.acceptanceRate >= baseline.acceptanceRate - allowedDrop &&
    candidate.averageAttempts <= baseline.averageAttempts;
  return {
    schemaVersion: 1,
    status: accepted ? "eligible-for-default" : "candidate-only",
    threshold: {
      maxAcceptanceRateDrop: allowedDrop,
      maxAverageAttempts: baseline.averageAttempts,
    },
    baseline,
    candidate,
    reasons: accepted
      ? ["candidate meets acceptance and retry thresholds"]
      : ["candidate does not meet acceptance or retry threshold"],
  };
}

function pathWithinPlan(candidate, plannedPaths) {
  return plannedPaths.some((prefix) =>
    prefix === "**"
      ? true
      : prefix.endsWith("/")
        ? candidate.startsWith(prefix)
        : candidate === prefix,
  );
}

function pathMatchesProtectedPrefix(candidate, prefix) {
  const segment = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return (
    candidate === segment ||
    candidate.startsWith(`${segment}/`) ||
    candidate.endsWith(`/${segment}`) ||
    candidate.includes(`/${segment}/`)
  );
}

function validatePhaseCandidate(
  plan,
  targetDir,
  patchFile,
  policy = loadPolicyV2(),
) {
  validatePhasePlan(plan, policy);
  requireCondition(
    plan.accessProfile === "workspace-write",
    "compute-governor: phase candidate requires workspace-write plan",
  );
  const patch = fs.readFileSync(patchFile);
  const actualPatch = execFileSync(
    "git",
    ["diff", "--binary", plan.executionBinding.targetHead, "--"],
    { cwd: targetDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  requireCondition(
    patch.equals(actualPatch),
    "compute-governor: candidate patch bytes changed before classification",
  );
  const raw = execFileSync(
    "git",
    ["diff", "--raw", "-z", plan.executionBinding.targetHead, "--"],
    { cwd: targetDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])(\d*)$/.exec(
      header,
    );
    requireCondition(match, "compute-governor: unclassifiable Git change");
    const [, oldMode, newMode, status] = match;
    requireCondition(
      ["A", "M"].includes(status) &&
        ["100644", "100755"].includes(newMode) &&
        (status === "A" ? oldMode === "000000" : oldMode === newMode),
      "compute-governor: disallowed Git change kind or file mode",
    );
    const changedPath = fields[index++];
    requireCondition(
      typeof changedPath === "string" &&
        changedPath.length > 0 &&
        !path.isAbsolute(changedPath) &&
        !changedPath.includes("\\") &&
        !changedPath
          .split("/")
          .some((part) => [".", "..", ""].includes(part)) &&
        pathWithinPlan(changedPath, plan.evidence.plannedPaths),
      "compute-governor: changed path is malformed, unknown, or outside plan",
    );
    changes.push(changedPath);
  }
  const ignored = execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd: targetDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  requireCondition(
    ignored.length === 0,
    "compute-governor: ignored candidate files are not deliverable",
  );
  const discovered = Object.entries(policy.protectedPathRules)
    .filter(([, prefixes]) =>
      changes.some((changedPath) =>
        prefixes.some((prefix) =>
          pathMatchesProtectedPrefix(changedPath, prefix),
        ),
      ),
    )
    .map(([surface]) => surface)
    .sort();
  const undeclared = discovered.filter(
    (surface) => !plan.evidence.protectedSurfaces.includes(surface),
  );
  requireCondition(
    undeclared.length === 0,
    "compute-governor: candidate discovered an undeclared protected path",
  );
  return {
    schemaVersion: 2,
    status: "approved",
    patchSha256: sha256(patch),
    changedFiles: changes.length,
    discoveredProtectedSurfaces: discovered,
  };
}

function readJson(file) {
  return parseJson(
    fs.readFileSync(file === "-" ? 0 : file, "utf8"),
    file === "-" ? "stdin" : file,
  );
}

function main(argv) {
  const [command, file, promptFile, targetDir] = argv;
  if (
    !file ||
    ![
      "resolve",
      "resolve-execution",
      "explain",
      "validate-plan",
      "validate-execution-plan",
      "validate-run-record",
      "calibrate",
      "resolve-phase-execution",
      "validate-phase-execution-plan",
      "validate-phase-candidate",
    ].includes(command)
  ) {
    throw new Error(
      "usage: compute-governor.js resolve|explain|validate-plan|validate-run-record|calibrate <json-file>; resolve-execution|validate-execution-plan <json-file> <prompt-file> <target-dir>",
    );
  }
  if (
    [
      "resolve-execution",
      "validate-execution-plan",
      "resolve-phase-execution",
      "validate-phase-execution-plan",
    ].includes(command) &&
    (!promptFile || !targetDir)
  ) {
    throw new Error(`${command} requires a prompt file and target directory`);
  }
  if (command === "validate-phase-candidate" && (!promptFile || !targetDir)) {
    throw new Error(
      "validate-phase-candidate requires a target directory and patch file",
    );
  }
  const input = readJson(file);
  const result =
    command === "resolve-phase-execution"
      ? resolvePhaseExecution(input, promptFile, targetDir)
      : command === "validate-phase-execution-plan"
        ? validatePhaseExecutionPlan(input, promptFile, targetDir)
        : command === "validate-phase-candidate"
          ? validatePhaseCandidate(input, promptFile, targetDir)
          : command === "resolve-execution"
            ? resolveExecution(input, promptFile, targetDir)
            : command === "validate-execution-plan"
              ? validateExecutionPlan(input, promptFile, targetDir)
              : command === "resolve" || command === "explain"
                ? resolve(input)
                : command === "validate-plan"
                  ? validatePlan(input)
                  : command === "validate-run-record"
                    ? validateRunRecord(input)
                    : calibrationDecision(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  ROUTES,
  loadPolicy,
  resolve,
  resolveExecution,
  validatePlan,
  validateExecutionPlan,
  validateRunRecord,
  calibrationDecision,
  PHASES_V2,
  loadPolicyV2,
  resolvePhaseExecution,
  validatePhasePlan,
  validatePhaseExecutionPlan,
  validatePhaseRunRecord,
  validatePhaseCandidate,
};
