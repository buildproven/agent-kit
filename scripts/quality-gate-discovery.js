"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const path = require("path");
const testImpact = require("./test-impact.js");
const { git } = require("./quality-git-identity.js");
const { parseJson } = require("./quality-canonical-json.js");
const { isPythonRepository, pythonGate } = require("./quality-python-gates.js");
const {
  nativeGate,
  discoverNativeGates,
  declaredGateTimeouts,
} = require("./quality-native-gates.js");
const {
  changedFiles,
  committedFiles,
  diffTouchesPython,
  scriptGate,
  directGate,
  baselineGate,
} = require("./quality-gate-files.js");

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
      committedFile,
      committedFiles,
      diffTouchesPython,
      directGate,
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
        committedFile,
        committedFiles,
        diffTouchesPython,
        directGate,
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
  const pythonRepository = isPythonRepository(root, head, pyproject, {
    committedFiles,
  });
  const nativeGates = discoverNativeGates({
    root,
    head,
    committedFile,
    parseJson,
  });
  const gateTimeouts = declaredGateTimeouts({
    root,
    head,
    committedFile,
    parseJson,
  });
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
    ) {
      return gate;
    }
    const timeoutSeconds = gateTimeouts.get(gate.name);
    return timeoutSeconds ? { ...gate, timeoutSeconds } : gate;
  });
}

module.exports = { discoverRequiredGates };
