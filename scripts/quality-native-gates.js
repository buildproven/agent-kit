"use strict";

// Native gate declarations are a self-contained policy surface. Keeping their
// parsing here prevents the invocation state machine from owning another
// unrelated configuration language (BUI-905).
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

function discoverNativeGates({ root, head, committedFile, parseJson }) {
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

function declaredGateTimeouts({ root, head, committedFile, parseJson }) {
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

module.exports = { nativeGate, discoverNativeGates, declaredGateTimeouts };
