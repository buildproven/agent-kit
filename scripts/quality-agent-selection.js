#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

const SECURITY_PATH =
  /(^|\/)(?:\.github\/workflows|\.husky|auth|security|credentials?|secrets?|keys?|deploy|hooks?)(\/|$)|(?:^|[._-])(?:auth|secret|credential|password|token|signing)(?:[._/-]|$)|\.(?:pem|key|p12|pfx|jks|kdbx?)$/i;
const SECURITY_CONTENT =
  /\b(?:authorize|authentication|permission|credential|private key|secret|password|token|signature verification)\b/i;
const RELIABILITY_PATH =
  /(^|\/)(?:scripts?|install|runtime|recovery|lifecycle|concurrency|retry|errors?)(\/|$)|\.(?:sh|bash|zsh)$/i;
const RELIABILITY_CONTENT =
  /\b(?:set -e|trap |timeout|retry|race|lock|rollback|recover|catch\s*\(|process\.exit|exit\s+[1-9])\b/i;
const CONTRACT_PATH =
  /(^|\/)(?:schemas?|api|protocols?|migrations?|types?)(\/|$)|(?:openapi|schema)\.(?:json|ya?ml)$|\.d\.ts$/i;
const CONTRACT_CONTENT =
  /\b(?:additionalProperties|required|enum|schemaVersion|interface|type\s+\w+\s*=|migration)\b/i;
const PERFORMANCE_PATH = /(^|\/)(?:perf|performance|benchmarks?)(\/|$)/i;
const PERFORMANCE_CONTENT =
  /\b(?:benchmark|throughput|latency|memoiz|cache hit|complexity\s+O\()\b/i;
const ARCHITECTURE_PATH =
  /(^|\/)(?:architecture|adapters?|providers?|modules?)(\/|$)|(?:^|\/)package\.json$/i;

function isTestPath(file) {
  return /(^|\/)(?:__tests__|tests?|spec)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(
    file,
  );
}

function firstMatch(files, content, tier) {
  if (
    tier === "medium" &&
    files.length > 0 &&
    files.every((file) => isTestPath(file))
  ) {
    return {
      agent: "pr-test-analyzer",
      domain: "test-only",
      rule: "medium-test-only",
    };
  }
  if (
    files.some((file) => SECURITY_PATH.test(file)) ||
    SECURITY_CONTENT.test(content)
  ) {
    return {
      agent: "security-auditor",
      domain: "security",
      rule: "security-domain",
    };
  }
  if (
    files.some((file) => RELIABILITY_PATH.test(file)) ||
    RELIABILITY_CONTENT.test(content)
  ) {
    return {
      agent: "silent-failure-hunter",
      domain: "reliability",
      rule: "reliability-domain",
    };
  }
  if (
    files.some((file) => CONTRACT_PATH.test(file)) ||
    CONTRACT_CONTENT.test(content)
  ) {
    return {
      agent: "type-design-analyzer",
      domain: "contract",
      rule: "contract-domain",
    };
  }
  if (
    files.some((file) => PERFORMANCE_PATH.test(file)) ||
    PERFORMANCE_CONTENT.test(content)
  ) {
    return {
      agent: "performance-engineer",
      domain: "performance",
      rule: "performance-domain",
    };
  }
  if (files.some((file) => ARCHITECTURE_PATH.test(file))) {
    return {
      agent: "architect-reviewer",
      domain: "architecture",
      rule: "architecture-domain",
    };
  }
  return null;
}

function selectReviewers({ tier, files = [], patches = [] }) {
  if (!["low", "medium", "high", "critical"].includes(tier)) {
    throw new Error(`invalid risk tier '${tier}'`);
  }
  if (tier === "low") {
    return { agents: [], domain: "policy-exempt", rule: "low-no-ai" };
  }
  const match = firstMatch(files, patches.join("\n"), tier);
  if (tier === "critical") {
    const specialist = match || {
      agent: "silent-failure-hunter",
      domain: "general",
      rule: "critical-reliability-backstop",
    };
    return {
      agents: ["code-reviewer", specialist.agent],
      domain: specialist.domain,
      rule: specialist.rule,
    };
  }
  if (match) {
    return {
      agents: [match.agent],
      domain: match.domain,
      rule: match.rule,
    };
  }
  return {
    agents: ["code-reviewer"],
    domain: "general",
    rule: "general-review",
  };
}

function selectReviewersForRange({ tier, repo, base, head }) {
  const range = `${base}..${head}`;
  const files = execFileSync("git", ["diff", "--name-only", "-z", range], {
    cwd: repo,
    maxBuffer: MAX_DIFF_BUFFER,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
  const patch = execFileSync("git", ["diff", "--no-ext-diff", range], {
    cwd: repo,
    maxBuffer: MAX_DIFF_BUFFER,
  }).toString();
  return selectReviewers({ tier, files, patches: [patch] });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (["--tier", "--repo", "--base", "--head"].includes(name)) {
      options[name.slice(2)] = argv[++index];
    } else {
      throw new Error(`unknown argument '${name}'`);
    }
  }
  for (const required of ["tier", "repo", "base", "head"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(selectReviewersForRange(options))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`quality-agent-selection: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { selectReviewers, selectReviewersForRange };
