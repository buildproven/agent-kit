#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const POLICY_FILE = ".buildproven/test-impact.json";
const JS_SOURCE = /\.(?:[cm]?js|jsx|ts|tsx)$/;
const PYTHON = /\.py$/;
const PYTHON_TEST = /(^|\/)(?:tests?|test)\/.*\.py$|(^|\/)test_[^/]+\.py$/;
const DOC_ONLY = /\.(?:md|txt)$/;
const JS_TEST =
  /(^|\/)(?:tests?|spec|__tests__)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NODE_TEST_ENTRY = /\.(?:test|spec)\.[cm]?js$/;

function command(value, label) {
  const invalid =
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value.executable !== "string" ||
    value.executable.trim() === "" ||
    value.executable.includes("\0") ||
    !Array.isArray(value.args) ||
    value.args.some((part) => typeof part !== "string" || part.includes("\0"));
  if (invalid)
    throw new Error(`${label} requires a non-empty executable and string args`);
  return { executable: value.executable, args: [...value.args] };
}

function validatePolicy(value) {
  if (!value || Array.isArray(value) || value.version !== 1)
    throw new Error(`${POLICY_FILE} must declare version 1`);
  const unsupported = Object.keys(value).filter(
    (key) =>
      !["version", "jsRunner", "mappings", "audits", "fallback"].includes(key),
  );
  if (unsupported.length > 0)
    throw new Error(
      `${POLICY_FILE} has unsupported fields: ${unsupported.join(", ")}`,
    );
  const allowedRunners = new Set(["vitest", "jest", "node", "none"]);
  const jsRunner = value.jsRunner || "vitest";
  if (!allowedRunners.has(jsRunner))
    throw new Error(
      `${POLICY_FILE} jsRunner must be vitest, jest, node, or none`,
    );
  const normalizeRules = (rules, kind) => {
    if (rules !== undefined && !Array.isArray(rules))
      throw new Error(`${POLICY_FILE} ${kind} must be an array`);
    return (rules || []).map((rule, index) => {
      if (
        !rule ||
        Array.isArray(rule) ||
        !Array.isArray(rule.paths) ||
        rule.paths.length === 0 ||
        rule.paths.some((glob) => typeof glob !== "string" || glob === "") ||
        !Array.isArray(rule.commands) ||
        rule.commands.length === 0
      )
        throw new Error(`${POLICY_FILE} ${kind}[${index}] is invalid`);
      if (
        kind === "audits" &&
        (!rule.reason || typeof rule.reason !== "string")
      )
        throw new Error(`${POLICY_FILE} audits[${index}] requires a reason`);
      return {
        paths: [...rule.paths],
        commands: rule.commands.map((item, commandIndex) =>
          command(
            item,
            `${POLICY_FILE} ${kind}[${index}].commands[${commandIndex}]`,
          ),
        ),
        ...(kind === "audits" ? { reason: rule.reason } : {}),
      };
    });
  };
  return {
    version: 1,
    jsRunner,
    mappings: normalizeRules(value.mappings, "mappings"),
    audits: normalizeRules(value.audits, "audits"),
    fallback:
      value.fallback === undefined
        ? []
        : (() => {
            if (!Array.isArray(value.fallback))
              throw new Error(`${POLICY_FILE} fallback must be an array`);
            return value.fallback.map((item, index) =>
              command(item, `${POLICY_FILE} fallback[${index}]`),
            );
          })(),
  };
}

function matches(file, patterns) {
  return patterns.some((pattern) =>
    pattern.endsWith("/")
      ? file.startsWith(pattern)
      : path.matchesGlob(file, pattern),
  );
}

function uniqueCommands(commands) {
  const seen = new Set();
  return commands.filter((item) => {
    const key = JSON.stringify([item.executable, item.args]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coalesceExactVitestRuns(commands) {
  const normalized = uniqueCommands(commands);
  const targets = [];
  const targetSet = new Set();
  let firstIndex = -1;
  const compatible = normalized.map((item, index) => {
    const candidates = explicitTestTargets(item);
    const exact =
      candidates.length > 0 &&
      item.args.length === candidates.length + 2 &&
      candidates.every((candidate) => JS_TEST.test(candidate));
    if (!exact) return false;
    if (firstIndex === -1) firstIndex = index;
    for (const candidate of candidates) {
      if (targetSet.has(candidate)) continue;
      targetSet.add(candidate);
      targets.push(candidate);
    }
    return true;
  });
  if (firstIndex === -1) return normalized;
  const result = [];
  normalized.forEach((item, index) => {
    if (index === firstIndex) {
      result.push({ executable: "npx", args: ["vitest", "run", ...targets] });
    }
    if (!compatible[index]) result.push(item);
  });
  return result;
}

function explicitTestTargets(selected) {
  if (selected.executable !== "npx") return [];
  const [runner, verb, ...rest] = selected.args;
  let candidates;
  if (runner === "vitest" && verb === "run") candidates = rest;
  else if (runner === "jest" && !verb?.startsWith("-"))
    candidates = [verb, ...rest];
  else return [];
  // Any runner option can narrow, exclude, shard, or name-filter the selected
  // tests. Only an option-free exact target list proves every positional test
  // was executed and is therefore safe to remove from related-test coverage.
  if (candidates.some((argument) => argument.startsWith("-"))) return [];
  return candidates.filter((argument) => JS_TEST.test(argument));
}

function relatedCommand(runner, files) {
  if (runner === "vitest")
    return {
      executable: "npx",
      args: ["vitest", "related", "--run", ...files],
    };
  if (runner === "jest")
    return {
      executable: "npx",
      args: ["jest", "--findRelatedTests", ...files],
    };
  return null;
}

function explicitMappingSelection(policy, files) {
  const commands = [];
  const covered = new Set();
  for (const rule of policy.mappings) {
    const matched = files.filter((file) => matches(file, rule.paths));
    if (matched.length === 0) continue;
    matched.forEach((file) => covered.add(file));
    commands.push(...rule.commands);
  }
  return { commands, covered };
}

function plan(changed, rawPolicy = { version: 1 }, options = {}) {
  const policy = validatePolicy({ version: 1, ...rawPolicy });
  const files = [...new Set(changed.filter(Boolean))].sort();
  if (files.length === 0)
    return {
      mode: "unmapped",
      reason: "unknown-change-set",
      files: [],
      uncovered: [],
      remediation: "provide the changed paths before authorizing tests",
    };

  const explicit = explicitMappingSelection(policy, files);
  if (
    options.preferExplicitMappings === true &&
    files.every((file) => explicit.covered.has(file))
  )
    return {
      mode: "focused",
      reason: "explicit-mutation-mapping",
      files,
      commands: coalesceExactVitestRuns(explicit.commands),
    };

  const auditRules = policy.audits.filter((rule) =>
    files.some((file) => matches(file, rule.paths)),
  );
  if (auditRules.length > 0)
    return {
      mode: "audit",
      reason: auditRules.map((rule) => rule.reason).join("; "),
      files,
      commands: coalesceExactVitestRuns(
        auditRules.flatMap((rule) => rule.commands),
      ),
    };

  const commands = explicit.commands;
  const covered = explicit.covered;

  // A mapping often names its exact behavioral test as a positional runner
  // target. When that test is changed in the same diff, it must not also be
  // fed to the dependency-aware runner. Arbitrary argv mentions and option
  // values are not execution proof, so this parser is deliberately narrow.
  for (const selected of commands) {
    const targets = explicitTestTargets(selected);
    for (const file of files) {
      if (targets.includes(file)) covered.add(file);
    }
  }

  // Dependency-aware runners cannot prove coverage from a removed input.
  // Keep missing paths uncovered unless repository policy maps or audits them.
  const available = (file) =>
    !options.root || fs.existsSync(path.resolve(options.root, file));
  const js = files.filter(
    (file) => JS_SOURCE.test(file) && !covered.has(file) && available(file),
  );
  if (js.length > 0) {
    if (policy.jsRunner === "node") {
      const directTests = js.filter((file) => NODE_TEST_ENTRY.test(file));
      commands.push(
        ...directTests.map((file) => ({ executable: "node", args: [file] })),
      );
      directTests.forEach((file) => covered.add(file));
    } else {
      const related = relatedCommand(policy.jsRunner, js);
      if (related) {
        commands.push(related);
        js.forEach((file) => covered.add(file));
      }
    }
  }
  const pythonTests = files.filter(
    (file) =>
      PYTHON.test(file) &&
      PYTHON_TEST.test(file) &&
      !covered.has(file) &&
      available(file),
  );
  if (pythonTests.length > 0) {
    commands.push({ executable: "pytest", args: pythonTests });
    pythonTests.forEach((file) => covered.add(file));
  }
  files
    .filter((file) => DOC_ONLY.test(file) && !covered.has(file))
    .forEach((file) => covered.add(file));

  const uncovered = files.filter((file) => !covered.has(file));
  if (uncovered.length > 0 && policy.fallback.length > 0)
    return {
      mode: "audit",
      reason: "unmapped-fallback",
      files,
      fallbackFiles: uncovered,
      commands: uniqueCommands(policy.fallback),
    };
  if (uncovered.length > 0)
    return {
      mode: "unmapped",
      reason: "unproven-test-impact",
      files,
      commands: coalesceExactVitestRuns(commands),
      uncovered,
      remediation: `map ${uncovered.join(", ")} in ${POLICY_FILE}`,
    };

  return commands.length > 0
    ? {
        mode: "focused",
        reason: "evidence-backed-selector",
        files,
        commands: coalesceExactVitestRuns(commands),
      }
    : { mode: "none", reason: "documentation-only", files, commands: [] };
}

function loadPolicy(root = process.cwd()) {
  const policyPath = path.join(root, POLICY_FILE);
  if (!fs.existsSync(policyPath)) return validatePolicy({ version: 1 });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`${POLICY_FILE} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  return validatePolicy(parsed);
}

function policyDigest(root = process.cwd()) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, POLICY_FILE)))
    .digest("hex");
}

function execute(result, root = process.cwd()) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.mode === "unmapped") {
    process.stderr.write(`test-impact: ${result.remediation}\n`);
    return 2;
  }
  for (const item of result.commands || []) {
    // A bare npx can download and reify a newer package even when the
    // lockfile-installed binary exists. npm 11 can then replace the active
    // worktree's node_modules while a quality gate is running. Impact plans
    // are repository contracts, so they must use only prepared dependencies.
    const args =
      item.executable === "npx" && item.args[0] !== "--no-install"
        ? ["--no-install", ...item.args]
        : item.args;
    const child = spawnSync(item.executable, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (child.error) {
      process.stderr.write(`test-impact: ${child.error.message}\n`);
      return 1;
    }
    if (child.status !== 0) return child.status ?? 1;
  }
  return 0;
}

function parseCliOptions(options) {
  const shouldExecute = options.includes("--execute");
  const preferExplicitMappings = options.includes("--prefer-explicit-mappings");
  const digestIndex = options.indexOf("--policy-sha256");
  const expectedDigest = digestIndex === -1 ? "" : options[digestIndex + 1];
  const policyRootIndex = options.indexOf("--policy-root");
  const policyRoot =
    policyRootIndex === -1
      ? process.cwd()
      : path.resolve(options[policyRootIndex + 1] || "");
  const gitRangeIndex = options.indexOf("--git-range");
  const gitBase = gitRangeIndex === -1 ? "" : options[gitRangeIndex + 1];
  const gitHead = gitRangeIndex === -1 ? "" : options[gitRangeIndex + 2];
  const consumed = new Set(["--execute", "--prefer-explicit-mappings"]);
  if (digestIndex !== -1) {
    consumed.add("--policy-sha256");
    consumed.add(expectedDigest);
  }
  if (policyRootIndex !== -1) {
    consumed.add("--policy-root");
    consumed.add(options[policyRootIndex + 1]);
  }
  if (gitRangeIndex !== -1) {
    consumed.add("--git-range");
    consumed.add(gitBase);
    consumed.add(gitHead);
  }
  const unknown = options.filter((option) => !consumed.has(option));
  if (unknown.length > 0) {
    throw new Error(`unsupported option ${unknown[0]}`);
  }
  if (policyRootIndex !== -1 && !options[policyRootIndex + 1]) {
    throw new Error("--policy-root requires a path");
  }
  if (digestIndex !== -1 && !/^[0-9a-f]{64}$/.test(expectedDigest || "")) {
    throw new Error("--policy-sha256 requires a SHA-256 hex digest");
  }
  if (
    gitRangeIndex !== -1 &&
    (!/^[0-9a-f]{40}$/.test(gitBase || "") ||
      !/^[0-9a-f]{40}$/.test(gitHead || ""))
  ) {
    throw new Error("--git-range requires two exact 40-character SHAs");
  }
  return {
    shouldExecute,
    expectedDigest,
    policyRoot,
    preferExplicitMappings,
    gitBase,
    gitHead,
  };
}

function changedPaths(base, head, root = process.cwd()) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, head],
    { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "inherit"] },
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

function workingTreePaths(root = process.cwd()) {
  const queries = [
    ["diff", "--name-only", "--no-renames", "-z"],
    ["diff", "--cached", "--name-only", "--no-renames", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  return [
    ...new Set(
      queries.flatMap((args) =>
        execFileSync("git", args, {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        })
          .split("\0")
          .filter(Boolean),
      ),
    ),
  ].sort();
}

function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? [] : argv.slice(0, separator);
  let parsed;
  try {
    parsed = parseCliOptions(options);
  } catch (error) {
    process.stderr.write(`test-impact: ${error.message}\n`);
    return 2;
  }
  const {
    shouldExecute,
    expectedDigest,
    policyRoot,
    preferExplicitMappings,
    gitBase,
    gitHead,
  } = parsed;
  const explicitFiles = separator === -1 ? argv : argv.slice(separator + 1);
  if (gitBase && explicitFiles.length > 0) {
    process.stderr.write(
      "test-impact: --git-range does not accept explicit paths\n",
    );
    return 2;
  }
  let files;
  try {
    files = gitBase ? changedPaths(gitBase, gitHead) : explicitFiles;
  } catch (error) {
    process.stderr.write(
      `test-impact: cannot resolve Git range: ${error.message}\n`,
    );
    return 2;
  }
  if (expectedDigest && policyDigest(policyRoot) !== expectedDigest) {
    process.stderr.write(
      `test-impact: ${POLICY_FILE} does not match the persisted exact-head policy\n`,
    );
    return 2;
  }
  const result = plan(
    files.map((file) => path.normalize(file)),
    loadPolicy(policyRoot),
    { preferExplicitMappings, root: process.cwd() },
  );
  if (shouldExecute) return execute(result);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  POLICY_FILE,
  execute,
  loadPolicy,
  main,
  plan,
  policyDigest,
  parseCliOptions,
  changedPaths,
  workingTreePaths,
  validatePolicy,
  explicitTestTargets,
  coalesceExactVitestRuns,
};
