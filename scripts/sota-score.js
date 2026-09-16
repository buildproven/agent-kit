#!/usr/bin/env node
/**
 * Deterministic Claude Code SOTA rubric 3.0 scorer.
 *
 * The interactive rubric lives in skills/sota/SKILL.md. Keep this file's
 * categories in one-to-one correspondence with that 15-category rubric so the
 * weekly assessment cannot certify a different, older definition of "SOTA".
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const Ajv = require("ajv");

let ROOT = path.resolve(process.env.SOTA_ROOT || path.join(__dirname, ".."));
let LAYER = "public_kit";
let READ_ERRORS = [];
const SETTINGS_SCHEMA_URL =
  "https://json.schemastore.org/claude-code-settings.json";
const CURRENT_BASELINE = "2.1.233";

function sourcePath(relativePath) {
  const own = path.join(ROOT, relativePath);
  if (fs.existsSync(own) || LAYER !== "private_overlay") return own;
  if (
    /^(?:scripts|skills|agents)\/|^(?:README.md|package.json|package-lock.json)$/.test(
      relativePath,
    )
  ) {
    return path.join(ROOT, "core", relativePath);
  }
  return own;
}

function exists(relativePath) {
  return fs.existsSync(sourcePath(relativePath));
}

function readText(relativePath) {
  try {
    return fs.readFileSync(sourcePath(relativePath), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT")
      READ_ERRORS.push(`${relativePath}: ${error.code || error.message}`);
    return "";
  }
}

function readJSON(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return null;
  }
}

function settingsPath() {
  if (LAYER === "installed_composition") return "settings.json";
  return exists("config/settings.json")
    ? "config/settings.json"
    : "settings.json";
}

function controlPath(name) {
  return `scripts/${name}`;
}

// Directories that never hold repository sources. Scratch and coverage output
// matter as much as node_modules here: this scorer walks the working tree, and
// an untracked scratch directory full of test fixtures otherwise gets scored as
// if it were the repository — inflating command/skill counts and reporting
// fixture content as real findings.
const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "scratchpad",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
]);

function walkFiles(relativeDir, predicate = () => true) {
  const own = walkSurface(relativeDir, predicate);
  if (
    LAYER !== "private_overlay" ||
    !["skills", "agents", "commands"].includes(relativeDir)
  )
    return own;
  const fallback = path.join(ROOT, "core", relativeDir);
  const shared = walkSurface(relativeDir, predicate, fallback);
  const files = new Map(
    shared.map((file) => [path.relative(fallback, file), file]),
  );
  const ownRoot = path.join(ROOT, relativeDir);
  for (const file of own) files.set(path.relative(ownRoot, file), file);
  return [...new Set(files.values())];
}

function walkSurface(relativeDir, predicate, explicitRoot) {
  let root = explicitRoot || sourcePath(relativeDir);
  if (!fs.existsSync(root) && LAYER === "private_overlay")
    root = path.join(ROOT, "core", relativeDir);
  if (!fs.existsSync(root)) return [];
  const results = [];
  const seen = new Set();
  const allowed = [
    root,
    ...["scripts", "skills", "agents", "commands"].map((name) =>
      path.join(ROOT, name),
    ),
  ]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.realpathSync(file));
  let visited = 0;
  const visit = (dir, depth = 0) => {
    const real = fs.realpathSync(dir);
    if (seen.has(real) || depth > 32 || ++visited > 10000) {
      READ_ERRORS.push(
        `${relativeDir}: cyclic or excessive directory traversal`,
      );
      return;
    }
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      READ_ERRORS.push(`${dir}: ${error.code || error.message}`);
      return;
    }
    for (const entry of entries) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // Source scans do not follow links. Installed scans resolve only their
      // declared linked surfaces and reject cycles or out-of-surface links.
      if (entry.isSymbolicLink()) {
        if (LAYER !== "installed_composition") continue;
        try {
          const target = fs.realpathSync(full);
          if (
            !allowed.some(
              (base) =>
                target === base || target.startsWith(`${base}${path.sep}`),
            )
          ) {
            READ_ERRORS.push(
              `${full}: link leaves declared installed surfaces`,
            );
            continue;
          }
          if (fs.statSync(target).isDirectory()) visit(target, depth + 1);
          else if (predicate(target)) results.push(target);
        } catch (error) {
          READ_ERRORS.push(`${full}: ${error.code || error.message}`);
        }
        continue;
      }
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && predicate(full)) results.push(full);
    }
  };
  visit(root);
  return results;
}

function result(score, gap = null, details = undefined) {
  return { score: Math.max(0, Math.min(10, score)), gap, ...details };
}

async function fetchSettingsSchema() {
  const response = await fetch(SETTINGS_SCHEMA_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`settings schema request failed: HTTP ${response.status}`);
  }
  return response.json();
}

function scoreSettingsValidity(schema, schemaError) {
  const settings = readJSON(settingsPath());
  if (!settings)
    return result(0, `${settingsPath()} is missing or invalid JSON`);
  if (!schema) {
    return result(0, `Live settings schema unavailable: ${schemaError}`);
  }
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    formats: { uri: true },
  });
  const valid = ajv.validate(schema, settings);
  if (valid) return result(10);
  const errors = (ajv.errors || []).map((error) => {
    const location = error.instancePath || "settings root";
    return `${location} ${error.message}`;
  });
  return result(0, `${errors.length} live-schema violation(s)`, { errors });
}

function scorePermissionPosture() {
  const settings = readJSON(settingsPath());
  if (!settings) return result(0, "settings.json missing");
  const permissions = settings.permissions || {};
  const allow = permissions.allow || [];
  const deny = permissions.deny || [];
  const ask = permissions.ask || [];
  const sandbox = settings.sandbox || {};
  let score = 0;
  const gaps = [];
  const checks = [
    [
      permissions.defaultMode === "auto",
      4,
      'permissions.defaultMode is not "auto"',
    ],
    [!allow.includes("Bash"), 2, "blanket Bash permission is allowed"],
    [
      deny.some((rule) => rule.includes("rm -rf")),
      1,
      "no destructive-delete deny rule",
    ],
    [
      ask.some((rule) => rule.includes("git push --force")),
      1,
      "force-push is not confirmation-gated",
    ],
    [Boolean(sandbox.credentials), 1, "sandbox.credentials is not configured"],
    [
      Array.isArray(sandbox.network?.deniedDomains) &&
        sandbox.network.deniedDomains.length > 0,
      1,
      "sandbox.network.deniedDomains is not configured",
    ],
  ];
  for (const [passed, points, gap] of checks) {
    if (passed) score += points;
    else gaps.push(gap);
  }
  return result(score, gaps[0] || null, { gaps });
}

function scoreNativeFirst() {
  const obsoletePaths = [
    "commands/bs/cost.md",
    "commands/gh/review-pr.md",
    "commands/bs/session.md",
    "commands/bs/resume.md",
    "commands/bs/context.md",
    "commands/bs/dashboard.md",
    "commands/bs/agent-run.md",
    "commands/bs/agent-new.md",
    "scripts/cost-tracker.js",
    "skills/webapp-testing/SKILL.md",
  ];
  const offenders = obsoletePaths.filter(exists);
  return result(
    10 - offenders.length * 2,
    offenders.length ? `Reimplements native feature: ${offenders[0]}` : null,
    { offenders },
  );
}

function scoreDistribution(layer) {
  if (layer !== "public_kit") {
    return {
      score: null,
      gap: null,
      notApplicable: "not a public distribution",
    };
  }
  const plugin = readJSON(".claude-plugin/plugin.json");
  const marketplace = readJSON(".claude-plugin/marketplace.json");
  let score = 0;
  const gaps = [];
  if (plugin && plugin.name) score += 5;
  else gaps.push("plugin manifest missing or invalid");
  if (marketplace && Array.isArray(marketplace.plugins)) score += 3;
  else gaps.push("marketplace manifest missing or invalid");
  if (plugin && plugin.name === "bs") score += 2;
  else gaps.push("plugin does not provide the bs namespace");
  return result(score, gaps[0] || null, { gaps });
}

function notificationMatchers(settings) {
  return (settings?.hooks?.Notification || []).map((entry) => entry.matcher);
}

function scoreAgentOrchestration() {
  const settings = readJSON(settingsPath());
  if (!settings) return result(0, "settings.json missing");
  const matchers = notificationMatchers(settings);
  const corpus = [
    readText("skills/dev/SKILL.md"),
    readText("skills/ralph/SKILL.md"),
    readText("config/CLAUDE.md"),
  ].join("\n");
  let score = 0;
  const gaps = [];
  // Match the documented portable forms ("background agents" and
  // "background subagents") as well as the runtime's run_in_background
  // option.  The previous case-sensitive singular-only expression scored
  // the existing dev workflow as missing even though it explicitly
  // documents spawning background agents.
  if (/background (?:agents?|subagents?)|run_in_background/i.test(corpus))
    score += 2;
  else gaps.push("no native background-agent workflow found");
  if (/agent team|TeamCreate|TaskCreate/.test(corpus)) score += 2;
  else gaps.push("no agent-team workflow found");
  if (/\bWorkflow\b/.test(corpus)) score += 2;
  else gaps.push("no Workflow-tool usage found");
  if (/isolation:\s*["']worktree["']|worktree isolation/.test(corpus))
    score += 2;
  else gaps.push("no worktree-isolated agent usage found");
  if (matchers.includes("agent_completed")) score += 1;
  else gaps.push("agent_completed notification missing");
  if (matchers.includes("agent_needs_input")) score += 1;
  else gaps.push("agent_needs_input notification missing");
  return result(score, gaps[0] || null, { gaps });
}

function scoreClaudeMd() {
  const claudeMdPath = exists("config/CLAUDE.md")
    ? "config/CLAUDE.md"
    : "CLAUDE.md";
  const content = readText(claudeMdPath);
  if (!content) return result(0, `${claudeMdPath} missing`);
  const lines = content.split("\n").length;
  const requiredBehaviors = [
    /act by default|continue.*autonom/i,
    /\b(?:test|lint|quality)\b/i,
    /\b(?:report|communicat)\b/i,
    /\b(?:git|branch|commit)\b/i,
  ];
  const missing = requiredBehaviors
    .map((behavior, index) => (behavior.test(content) ? null : index))
    .filter((index) => index !== null);
  let score = lines < 100 ? 6 : lines <= 120 ? 5 : 3;
  score += requiredBehaviors.length - missing.length;
  return result(
    score,
    lines >= 100 ? `${lines} lines (target <100)` : missing[0] || null,
    { lines, missing },
  );
}

function scoreBoundedAutonomy() {
  const governor = controlPath("quality-run-governor.js");
  const ralph = controlPath("ralph-next-run.sh");
  const checks = [
    exists(governor),
    exists(ralph),
    /MAX_TRANSITIONS=\d+/.test(readText(ralph)),
    /max_wall_seconds/.test(readText(governor)),
    /max_review_rounds/.test(readText(governor)),
  ];
  const passed = checks.filter(Boolean).length;
  return result(
    passed * 2,
    passed < checks.length ? "Autonomy cap missing" : null,
  );
}

function scoreHooks() {
  const settings = readJSON(settingsPath());
  const hooks = settings?.hooks;
  if (!hooks) return result(0, "No hooks configured");
  const required = ["PreToolUse", "PostToolUse", "Notification"];
  const missing = required.filter((name) => !hooks[name]);
  let score = required.length - missing.length;
  if (exists("scripts/block-push-main.sh")) score += 2;
  if (exists("scripts/block-destructive-paths.sh")) score += 2;
  if (exists(".husky/pre-commit")) score += 2;
  if (hooks.SessionStart) score += 1;
  return result(score, missing[0] ? `Missing ${missing[0]} hook` : null, {
    missing,
  });
}

function scoreSkillDesign() {
  const skillFiles = walkFiles("skills", (file) => file.endsWith("SKILL.md"));
  if (!skillFiles.length) return result(0, "No readable skills");
  const oversized = [];
  const inert = [];
  let forked = 0;
  for (const file of skillFiles) {
    const content = fs.readFileSync(file, "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
    const words = content.trim().split(/\s+/).length;
    if ((words * 13) / 10 > 5_000) oversized.push(path.relative(ROOT, file));
    if (/^(?:invokes|auto_invoke):/m.test(frontmatter))
      inert.push(path.relative(ROOT, file));
    if (/^context:\s*fork\s*$/m.test(content)) forked += 1;
  }
  let score = 10;
  if (oversized.length) score -= 4;
  if (inert.length) score -= 3;
  if (forked === 0) score -= 2;
  const gap =
    oversized[0] || inert[0] || (forked === 0 ? "No forked skills" : null);
  return result(score, gap, { oversized, inert, forked });
}

function scanRetiredModels() {
  const retired = ["claude-3-opus", "claude-3-sonnet", "gemini-2.0-flash-exp"];
  const findings = [];
  for (const file of walkFiles(".", (candidate) =>
    /\.(md|json|js|sh)$/.test(candidate),
  )) {
    if (
      file.endsWith("sota-score.js") ||
      file.endsWith("check-deprecated-apis.sh")
    )
      continue;
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      // Listed by the walk but gone (or unreadable) by the time we read it —
      // a concurrent cleanup, not a scoring failure.
      continue;
    }
    for (const model of retired) {
      if (content.includes(model))
        findings.push(`${path.relative(ROOT, file)}: ${model}`);
    }
  }
  return findings;
}

function scoreModelConfig() {
  const settings = readJSON(settingsPath());
  if (!settings) return result(0, "settings.json missing");
  let score = 0;
  const gaps = [];
  if (
    Array.isArray(settings.fallbackModel) &&
    settings.fallbackModel.length >= 2
  )
    score += 4;
  else gaps.push("fallbackModel chain missing");
  const effortReferences = walkFiles("skills", (file) =>
    file.endsWith(".md"),
  ).some((file) =>
    /(?:effort|codex-effort).*(?:medium|high|xhigh)/.test(
      fs.readFileSync(file, "utf8"),
    ),
  );
  if (effortReferences) score += 2;
  else gaps.push("no deliberate effort routing found");
  if (exists("scripts/check-deprecated-apis.sh")) score += 2;
  else gaps.push("no deprecation scanner");
  const retiredModels = scanRetiredModels();
  if (retiredModels.length === 0) score += 2;
  else gaps.push(`retired model reference: ${retiredModels[0]}`);
  return result(score, gaps[0] || null, { gaps, retiredModels });
}

function scoreQualityGates() {
  const pkg = readJSON("package.json");
  const scripts = pkg?.scripts || {};
  const required = ["lint", "test", "test:patterns", "security:scan"];
  const missing = required.filter((name) => !scripts[name]);
  let score = required.length - missing.length;
  if (exists("skills/quality/SKILL.md")) score += 2;
  if (
    exists("scripts/quality-provider-policy.sh") &&
    exists("scripts/quality-run-bounded.sh")
  )
    score += 2;
  if (exists(controlPath("quality-run-governor.js"))) score += 2;
  return result(score, missing[0] ? `Missing ${missing[0]} gate` : null, {
    missing,
  });
}

function scoreSecurity(layer) {
  const workflow = readText(".github/workflows/quality.yml");
  const semgrepRunner = readText("scripts/run-semgrep.sh");
  const settings = readJSON(settingsPath());
  const checks = [
    exists("scripts/block-destructive-paths.sh"),
    /security:scan:ci/.test(workflow) && /--error/.test(semgrepRunner),
    /license:check/.test(workflow) && /npm audit/.test(workflow),
    exists("package-lock.json") && /npm ci/.test(workflow),
    Boolean(settings?.sandbox?.credentials),
  ];
  const privateLeak =
    layer === "public_kit" &&
    /(?:\/Users\/brett|Projects\/internal|brettstark)/i.test(
      [readText("README.md"), readText("config/settings.json")].join("\n"),
    );
  const passed = checks.filter(Boolean).length;
  return result(
    passed * 2 - (privateLeak ? 2 : 0),
    privateLeak ? "Private path/data leak" : null,
  );
}

function scoreGitWorkflow() {
  if (LAYER === "installed_composition")
    return { score: null, gap: null, notApplicable: "not a source checkout" };
  const checks = [
    exists(".husky/pre-commit"),
    exists(".husky/pre-push"),
    exists(".husky/commit-msg"),
    exists("commitlint.config.js") || exists("commitlint.config.cjs"),
    exists("scripts/block-commit-main.sh"),
  ];
  const passed = checks.filter(Boolean).length;
  return result(
    passed * 2,
    passed < checks.length ? "Git workflow gate missing" : null,
  );
}

function scoreObservability() {
  const corpus = [readText("README.md"), readText("skills/sota/SKILL.md")].join(
    "\n",
  );
  const settings = readJSON(settingsPath());
  const env = settings?.env || {};
  const hasUsage = corpus.includes("/usage");
  const hasOtel =
    Object.keys(env).some((key) => key.startsWith("OTEL_")) ||
    /OpenTelemetry[\s\S]{0,200}opt-in/i.test(corpus);
  const score = (hasUsage ? 6 : 0) + (hasOtel ? 4 : 0);
  return result(
    score,
    !hasUsage
      ? "/usage is not documented"
      : !hasOtel
        ? "OpenTelemetry opt-in is not documented"
        : null,
  );
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function scoreCurrency() {
  const settings = readJSON(settingsPath());
  const pinned = settings?.requiredMinimumVersion;
  const rubric = readText("skills/sota/SKILL.md");
  const reviewedMatch = rubric.match(/Last reviewed:\s*(\d{4}-\d{2}-\d{2})/);
  const reviewed = reviewedMatch
    ? new Date(`${reviewedMatch[1]}T00:00:00Z`)
    : null;
  const ageDays = reviewed
    ? Math.floor((Date.now() - reviewed.getTime()) / 86_400_000)
    : Infinity;
  let score = 0;
  const gaps = [];
  if (pinned && compareVersions(pinned, CURRENT_BASELINE) >= 0) score += 6;
  else gaps.push(`requiredMinimumVersion is below ${CURRENT_BASELINE}`);
  if (ageDays <= 30) score += 4;
  else gaps.push("SOTA rubric is older than 30 days");
  return result(score, gaps[0] || null, {
    pinned,
    baseline: CURRENT_BASELINE,
    ageDays,
  });
}

// A null score means "not applicable to this repo" — e.g. distribution, which is
// meaningless for a private single-user overlay that is never published. Coercing
// N/A to 0 would punish a correct answer, and dividing by the unfiltered length
// would silently deflate every other category (the real 8.79 read as 8.2).
// Exclude non-numeric scores from the mean; never coerce them.
function overallScore(scores) {
  const values = Object.values(scores).filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  if (!values.length) return null;
  return (
    Math.round(
      (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
    ) / 10
  );
}

function scoreLayer(root, layer, { schema, schemaError }) {
  const priorRoot = ROOT;
  const priorLayer = LAYER;
  const priorErrors = READ_ERRORS;
  ROOT = root;
  LAYER = layer;
  READ_ERRORS = [];
  try {
    const categories = {
      settings_validity: scoreSettingsValidity(schema, schemaError),
      permission_posture: scorePermissionPosture(),
      native_first: scoreNativeFirst(),
      distribution: scoreDistribution(layer),
      agent_orchestration: scoreAgentOrchestration(),
      claude_md: scoreClaudeMd(),
      bounded_autonomy: scoreBoundedAutonomy(),
      hooks: scoreHooks(),
      skill_design: scoreSkillDesign(),
      model_config: scoreModelConfig(),
      quality_gates: scoreQualityGates(),
      security: scoreSecurity(layer),
      git_workflow: scoreGitWorkflow(),
      observability: scoreObservability(),
      currency: scoreCurrency(),
    };
    const scores = Object.fromEntries(
      Object.entries(categories).map(([name, value]) => [name, value.score]),
    );
    return {
      label:
        layer === "public_kit"
          ? "Public kit"
          : layer === "private_overlay"
            ? "Private overlay"
            : "Installed composition",
      root,
      overall: overallScore(scores),
      scores,
      topGaps: Object.values(categories)
        .map((value) => value.gap)
        .filter(Boolean)
        .slice(0, 3),
      categories,
      assessmentKind: "structural",
      readErrors: [...new Set(READ_ERRORS)],
    };
  } finally {
    ROOT = priorRoot;
    LAYER = priorLayer;
    READ_ERRORS = priorErrors;
  }
}

function layerRoots(options) {
  const selections = [
    ["public_kit", "publicRoot", "SOTA_PUBLIC_ROOT"],
    ["private_overlay", "overlayRoot", "SOTA_OVERLAY_ROOT"],
    ["installed_composition", "installedRoot", "SOTA_INSTALLED_ROOT"],
  ];
  const roots = {};
  for (const [layer, option, variable] of selections) {
    const value = options[option] ?? process.env[variable];
    const rootSelection =
      options[option] !== undefined ? "argument" : "environment";
    if (!value) {
      roots[layer] = {
        state: layer === "public_kit" ? "invalid" : "not_assessed",
        reason: "explicit root not supplied",
      };
      continue;
    }
    try {
      const root = fs.realpathSync(value);
      if (!fs.statSync(root).isDirectory())
        throw new Error("root is not a directory");
      if (layer === "installed_composition") {
        if (!fs.statSync(path.join(root, "settings.json")).isFile())
          throw new Error("installed settings.json required");
        for (const surface of ["scripts", "skills", "agents", "commands"]) {
          const target = path.join(root, surface);
          if (
            !fs.lstatSync(target).isSymbolicLink() ||
            !fs.statSync(target).isDirectory()
          )
            throw new Error(`installed linked ${surface} required`);
        }
      }
      roots[layer] = { state: "present", root, rootSelection };
    } catch (error) {
      roots[layer] = {
        state: fs.existsSync(value) ? "invalid" : "missing",
        reason: error.message,
        root: path.resolve(value),
        rootSelection,
      };
    }
  }
  const present = Object.entries(roots).filter(
    ([, entry]) => entry.state === "present",
  );
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const [leftName, left] = present[i],
        [rightName, right] = present[j];
      const nested =
        left.root === right.root ||
        left.root.startsWith(`${right.root}${path.sep}`) ||
        right.root.startsWith(`${left.root}${path.sep}`);
      const expected =
        leftName === "public_kit" &&
        rightName === "private_overlay" &&
        left.root === path.join(right.root, "core");
      if (nested && !expected) {
        left.state = right.state = "invalid";
        left.reason = right.reason =
          "layer roots overlap or identify the same tree";
      }
    }
  }
  return roots;
}

function sourceRevision(root) {
  const git = (args) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== root)
    return { revision: null, reason: "root is not a Git source checkout" };
  const status = git(["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim())
    return { revision: null, reason: "source status unavailable or dirty" };
  const head = git(["rev-parse", "HEAD"]);
  return head.status === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim())
    ? { revision: head.stdout.trim(), reason: null }
    : { revision: null, reason: "source revision unavailable" };
}

async function scoreRepository({ schema, schemaError, ...options } = {}) {
  if (options.format !== undefined && options.format !== "layered-v2")
    throw new Error("unsupported assessment format");
  let liveSchema = schema;
  let liveSchemaError = schemaError;
  if (!liveSchema && !liveSchemaError) {
    try {
      liveSchema = await fetchSettingsSchema();
    } catch (error) {
      liveSchemaError = error.message;
    }
  }
  if (!options.format) {
    const root = path.resolve(options.root || process.env.SOTA_ROOT || ROOT);
    const scored = scoreLayer(root, "public_kit", {
      schema: liveSchema,
      schemaError: liveSchemaError,
    });
    return {
      date: new Date().toISOString().split("T")[0],
      rubricVersion: "3.0",
      overall: scored.overall,
      scores: scored.scores,
      topGaps: scored.topGaps,
      categories: scored.categories,
    };
  }
  const roots = layerRoots(options);
  const layers = {};
  const missingLayers = [];
  for (const [layer, entry] of Object.entries(roots)) {
    if (entry.state !== "present") {
      missingLayers.push(layer);
      continue;
    }
    const scored = scoreLayer(entry.root, layer, {
      schema: liveSchema,
      schemaError: liveSchemaError,
    });
    layers[layer] = {
      ...scored,
      rootSelection: entry.rootSelection,
      source: sourceRevision(entry.root),
    };
    if (scored.readErrors.length) {
      entry.state = "invalid";
      entry.reason = "one or more control surfaces could not be read safely";
    }
  }
  return {
    schemaVersion: 2,
    assessmentKind: "structural",
    scorer: sourceRevision(path.resolve(__dirname, "..")),
    date: new Date().toISOString().split("T")[0],
    rubricVersion: "3.0",
    composite: null,
    missingLayers,
    layers,
    layerStates: roots,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length &&
    (args.length !== 2 || args[0] !== "--format" || args[1] !== "layered-v2")
  )
    throw new Error("usage: sota-score.js [--format layered-v2]");
  const output = await scoreRepository(args.length ? { format: args[1] } : {});
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (
    Object.values(output.layerStates || {}).some((entry) =>
      ["missing", "invalid"].includes(entry.state),
    )
  )
    process.exitCode = 1;
}

module.exports = {
  CURRENT_BASELINE,
  compareVersions,
  overallScore,
  scoreLayer,
  scoreRepository,
  scoreSettingsValidity,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`sota-score: ${error.message}\n`);
    process.exit(1);
  });
}
