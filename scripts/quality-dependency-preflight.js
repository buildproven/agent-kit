#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const {
  parse: parseJsonc,
  printParseErrorCode,
  visit: visitJson,
} = require("jsonc-parser");
const { parseSyml } = require("@yarnpkg/parsers");
const { ZipFS } = require("@yarnpkg/libzip");
const semver = require("semver");
const { Lexer: YamlLexer, parseAllDocuments, parseDocument } = require("yaml");
const { parse: parseToml } = require("smol-toml");

const SUPPORTED_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 1_000_000;
const MAX_ZIP_ENTRIES = 50_000;
const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;

function readJson(file, label, root = null) {
  try {
    const text = readText(file, label, root);
    validateJsonText(text, label);
    const value = JSON.parse(text);
    validateObjectLimits(value, label);
    return value;
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error.message}`, {
      cause: error,
    });
  }
}

function validateJsonText(text, label, options = {}) {
  let depth = 0;
  let nodes = 0;
  const count = () => {
    nodes += 1;
    if (nodes > MAX_NODES)
      throw new Error(`${label} exceeds ${MAX_NODES} nodes`);
  };
  const enter = () => {
    count();
    depth += 1;
    if (depth > MAX_DEPTH)
      throw new Error(`${label} exceeds ${MAX_DEPTH} levels`);
  };
  visitJson(
    text,
    {
      onObjectBegin: enter,
      onObjectProperty(name) {
        count();
        if (name === "__proto__") {
          throw new Error(`${label} contains forbidden property '${name}'`);
        }
      },
      onObjectEnd() {
        depth -= 1;
      },
      onArrayBegin: enter,
      onArrayEnd() {
        depth -= 1;
      },
      onLiteralValue: count,
      onError(error) {
        throw new Error(`${label} is malformed: ${printParseErrorCode(error)}`);
      },
    },
    {
      allowTrailingComma: options.allowTrailingComma === true,
      disallowComments: options.allowComments !== true,
    },
  );
}

function validateObjectLimits(value, label) {
  const stack = [{ value, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > MAX_DEPTH) {
      throw new Error(`${label} exceeds ${MAX_DEPTH} levels`);
    }
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new Error(`${label} exceeds ${MAX_NODES} nodes`);
    }
    if (
      current.value === null ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function validateYamlText(text, label) {
  let tokens = 0;
  let flowDepth = 0;
  let lineSequenceDepth = 0;
  let atLineStart = true;
  let indentation = 0;
  const indentationStack = [0];
  for (const token of new YamlLexer().lex(text)) {
    if (token === "\n" || token === "\r\n") {
      atLineStart = true;
      indentation = 0;
      lineSequenceDepth = 0;
      continue;
    }
    if (/^\s*$/u.test(token) || token.startsWith("#")) {
      if (atLineStart) indentation = token.length;
      continue;
    }
    tokens += 1;
    if (tokens > MAX_NODES) {
      throw new Error(`${label} exceeds ${MAX_NODES} pre-parse tokens`);
    }
    if (atLineStart) {
      while (
        indentationStack.length > 1 &&
        indentation < indentationStack.at(-1)
      ) {
        indentationStack.pop();
      }
      if (indentation > indentationStack.at(-1)) {
        indentationStack.push(indentation);
      }
      atLineStart = false;
    }
    if (/^(?:---|\.\.\.)$/u.test(token)) {
      if (flowDepth !== 0) {
        throw new Error(`${label} has unbalanced pre-parse flow tokens`);
      }
      indentationStack.splice(1);
      lineSequenceDepth = 0;
      continue;
    }
    if (token === "[" || token === "{") flowDepth += 1;
    if (token === "]" || token === "}") {
      if (flowDepth === 0) {
        throw new Error(`${label} has pre-parse flow-depth underflow`);
      }
      flowDepth -= 1;
    }
    if (/^-$/u.test(token)) lineSequenceDepth += 1;
    if (
      indentationStack.length - 1 + flowDepth + lineSequenceDepth >
      MAX_DEPTH
    ) {
      throw new Error(`${label} exceeds ${MAX_DEPTH} pre-parse levels`);
    }
  }
}

function validateTomlText(text, label) {
  let tokens = 0;
  for (const character of text) {
    if (!["=", ",", "[", "{"].includes(character)) continue;
    tokens += 1;
    if (tokens > MAX_NODES) {
      throw new Error(`${label} exceeds ${MAX_NODES} pre-parse tokens`);
    }
  }
}

function stableReadsSupported(constants = fs.constants) {
  return typeof constants.O_NOFOLLOW === "number";
}

function readBuffer(file, label, root = null) {
  try {
    if (!stableReadsSupported()) {
      throw new Error("this platform cannot guarantee non-symlink reads");
    }
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile()) throw new Error("must be a regular file");
      if (before.size > MAX_FILE_BYTES) throw new Error("exceeds 256 MiB");
      if (root) {
        const resolvedRoot = fs.realpathSync(root);
        const resolvedFile = fs.realpathSync(file);
        if (!isSubpath(resolvedRoot, resolvedFile)) {
          throw new Error("opened object escapes the repository");
        }
        const pathIdentity = fs.statSync(resolvedFile);
        if (
          before.dev !== pathIdentity.dev ||
          before.ino !== pathIdentity.ino
        ) {
          throw new Error("opened object does not match the contained path");
        }
      }
      const data = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error("changed while being read");
      }
      return data;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error.message}`, {
      cause: error,
    });
  }
}

function readText(file, label, root = null) {
  return readBuffer(file, label, root).toString("utf8");
}

function parseYaml(text, label) {
  validateYamlText(text, label);
  const document = parseDocument(text, {
    maxAliasCount: 100,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label} is malformed: ${document.errors[0].message}`);
  }
  const value = document.toJS({ maxAliasCount: 100 });
  validateObjectLimits(value, label);
  return value;
}

function directDependencies(pkg) {
  return Object.keys({
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  }).sort();
}

function dependencySpecs(pkg) {
  return {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
}

function packageBinEntries(name, pkg) {
  if (typeof pkg.bin === "string") return [[name.split("/").at(-1), pkg.bin]];
  if (!pkg.bin || typeof pkg.bin !== "object") return [];
  return Object.entries(pkg.bin);
}

function semverIdentifier(value) {
  return (
    value !== "" &&
    [...value].every(
      (character) =>
        (character >= "0" && character <= "9") ||
        (character >= "A" && character <= "Z") ||
        (character >= "a" && character <= "z") ||
        character === "-",
    )
  );
}

function semverNumber(value) {
  return (
    value !== "" &&
    (value.length === 1 || value[0] !== "0") &&
    [...value].every((character) => character >= "0" && character <= "9")
  );
}

function exactVersion(value) {
  const source = String(value);
  const buildParts = source.split("+");
  if (
    buildParts.length > 2 ||
    (buildParts.length === 2 &&
      !buildParts[1].split(".").every(semverIdentifier))
  ) {
    return false;
  }
  const version = buildParts[0];
  const dash = version.indexOf("-");
  const core = dash === -1 ? version : version.slice(0, dash);
  const prerelease = dash === -1 ? null : version.slice(dash + 1);
  if (
    prerelease !== null &&
    !prerelease.split(".").every((identifier) => {
      const numeric = [...identifier].every(
        (character) => character >= "0" && character <= "9",
      );
      return (
        semverIdentifier(identifier) && (!numeric || semverNumber(identifier))
      );
    })
  ) {
    return false;
  }
  const coreParts = core.split(".");
  return coreParts.length === 3 && coreParts.every(semverNumber);
}

function registrySelectionSatisfies(name, spec, selectedName, version) {
  let expectedName = name;
  let range = String(spec);
  if (range.startsWith("npm:")) {
    const alias = range.slice("npm:".length);
    const separator = alias.lastIndexOf("@");
    if (separator <= 0) return false;
    expectedName = alias.slice(0, separator);
    range = alias.slice(separator + 1);
  }
  const validRange = semver.validRange(range);
  return (
    selectedName === expectedName &&
    validRange !== null &&
    semver.satisfies(version, validRange)
  );
}

function installedVersionMatches(installed, locked) {
  if (typeof installed !== "string" || typeof locked !== "string") return false;
  // npm normalizes a publisher's leading v in the lockfile, but preserves the
  // original package manifest. Keep prerelease and build identity exact.
  const normalized = installed.startsWith("v") ? installed.slice(1) : installed;
  return (
    exactVersion(normalized) && exactVersion(locked) && normalized === locked
  );
}

function localSelectionSatisfies(spec, selected, version) {
  const requirement = String(spec);
  const locator = String(selected);
  if (/^(?:file|link|portal):/.test(requirement)) {
    return locator === requirement;
  }
  if (requirement.startsWith("workspace:")) {
    const selector = requirement.slice("workspace:".length);
    if (selector === "*") return true;
    if (selector === "^") return semver.satisfies(version, `^${version}`);
    if (selector === "~") return semver.satisfies(version, `~${version}`);
    if (semver.validRange(selector)) return semver.satisfies(version, selector);
    return locator.replace(/^(?:file|link|workspace):/, "") === selector;
  }
  const range = semver.validRange(requirement);
  return range !== null && semver.satisfies(version, range);
}

function versionParts(value) {
  return String(value)
    .split(/[+-]/, 1)[0]
    .split(".")
    .map((part) => Number(part));
}

function managerVersionSupportsSchema(manager, version, schema) {
  if (!version) return true;
  const [major, minor] = versionParts(version);
  if (manager === "npm") {
    if (schema === 2) return major >= 7;
    return [3, 4].includes(schema) && major >= 9;
  }
  if (manager === "pnpm") return String(schema) === "9.0" && major >= 9;
  if (manager === "yarn") return [8, 9, 10].includes(schema) && major >= 4;
  if (manager === "bun") {
    if (schema === 1) return major > 1 || (major === 1 && minor >= 2);
    return (
      [2, 3].includes(schema) && (major > 1 || (major === 1 && minor >= 4))
    );
  }
  return false;
}

function schemaCompatibilityFailure(manager, version, schema) {
  return managerVersionSupportsSchema(manager, version, schema)
    ? []
    : [
        `${manager}@${version} is incompatible with ${manager} lock schema ${schema}`,
      ];
}

function packageManager(root, pkg) {
  const present = {
    npm: fs.existsSync(path.join(root, "package-lock.json")),
    pnpm: fs.existsSync(path.join(root, "pnpm-lock.yaml")),
    yarn: fs.existsSync(path.join(root, "yarn.lock")),
    bun:
      fs.existsSync(path.join(root, "bun.lock")) ||
      fs.existsSync(path.join(root, "bun.lockb")),
  };
  if (pkg.packageManager !== undefined) {
    const declaration = String(pkg.packageManager);
    const separator = declaration.indexOf("@");
    const declared = declaration.slice(0, separator);
    const version = declaration.slice(separator + 1);
    if (
      separator < 1 ||
      !SUPPORTED_MANAGERS.includes(declared) ||
      !exactVersion(version)
    ) {
      throw new Error(
        "packageManager must be <npm|pnpm|yarn|bun>@<exact-version>",
      );
    }
    if (!present[declared]) {
      throw new Error(`${declared}: declared lockfile is missing`);
    }
    return { name: declared, version };
  }
  const candidates = SUPPORTED_MANAGERS.filter((manager) => present[manager]);
  if (candidates.length !== 1) {
    throw new Error(
      `package manager is ${candidates.length === 0 ? "missing" : `ambiguous (${candidates.join(", ")})`}; add an exact packageManager declaration`,
    );
  }
  return { name: candidates[0], version: null };
}

function npmLockedIdentity(lock, name) {
  const relative = `node_modules/${name}`;
  const record = lock.packages?.[relative];
  if (typeof record?.version === "string") {
    return { version: record.version, target: null };
  }
  if (record?.link === true && typeof record.resolved === "string") {
    const target = lock.packages?.[record.resolved];
    if (typeof target?.version === "string") {
      return { version: target.version, target: record.resolved };
    }
  }
  const legacy = lock.dependencies?.[name];
  return typeof legacy?.version === "string"
    ? { version: legacy.version, target: null }
    : null;
}

function isSubpath(parent, candidate, pathApi = path) {
  const relative = pathApi.relative(parent, candidate);
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`))
  );
}

function containedRealpath(root, candidate, label) {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(candidate);
  if (!isSubpath(resolvedRoot, resolved)) {
    throw new Error(`${label} escapes the repository`);
  }
  return resolved;
}

function validateInstalled(
  root,
  name,
  expectedVersion,
  packageRoot,
  {
    expectedName = name,
    checkCommandLinks = true,
    lockedCommandRoots = null,
  } = {},
) {
  const failures = [];
  if (!fs.existsSync(packageRoot)) return [`${name}: package is not installed`];
  try {
    const resolvedRoot = containedRealpath(
      root,
      packageRoot,
      `${name} package`,
    );
    const installed = readJson(
      path.join(resolvedRoot, "package.json"),
      `${name} package.json`,
      root,
    );
    if (installed.name !== expectedName) {
      failures.push(
        `${name}: installed package is named ${installed.name || "missing"}, lockfile requires ${expectedName}`,
      );
    } else if (!installedVersionMatches(installed.version, expectedVersion)) {
      failures.push(
        `${name}: installed ${installed.version || "unknown"}, lockfile requires ${expectedVersion}`,
      );
    } else if (lockedCommandRoots) {
      lockedCommandRoots.add(resolvedRoot);
    }
    for (const [bin, relativeTarget] of packageBinEntries(
      expectedName,
      installed,
    )) {
      const target = containedRealpath(
        root,
        path.resolve(resolvedRoot, relativeTarget),
        `${name} bin ${bin}`,
      );
      if (!isSubpath(resolvedRoot, target)) {
        failures.push(`${name}: declared bin ${bin} escapes its package`);
        continue;
      }
      if (!checkCommandLinks) continue;
      const command = path.join(root, "node_modules", ".bin", bin);
      if (!fs.existsSync(command)) {
        failures.push(`${name}: package-local executable ${bin} is missing`);
        continue;
      }
      const commandStat = fs.lstatSync(command);
      if (
        commandStat.isSymbolicLink() &&
        containedRealpath(root, command, `${name} executable ${bin}`) !== target
      ) {
        failures.push(`${name}: executable ${bin} targets the wrong file`);
      } else if (!commandStat.isSymbolicLink()) {
        const markerPrefix = "# cmd-shim-target=";
        const marker = readText(command, `${name} executable ${bin}`)
          .trimEnd()
          .split("\n")
          .at(-1);
        let markerTarget = null;
        if (marker?.startsWith(markerPrefix)) {
          try {
            markerTarget = containedRealpath(
              root,
              marker.slice(markerPrefix.length),
              `${name} executable marker`,
            );
          } catch {
            markerTarget = null;
          }
        }
        if (markerTarget !== target) {
          failures.push(`${name}: executable ${bin} targets the wrong file`);
        }
      }
    }
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
  return failures;
}

function validateLocalInstall(
  root,
  name,
  localRoot,
  expectedVersion,
  lockedCommandRoots = null,
) {
  const installedRoot = path.join(root, "node_modules", name);
  if (!fs.existsSync(installedRoot))
    return [`${name}: package is not installed`];
  try {
    const resolvedLocal = containedRealpath(
      root,
      localRoot,
      `${name} local package`,
    );
    const resolvedInstalled = containedRealpath(
      root,
      installedRoot,
      `${name} installed package`,
    );
    if (resolvedInstalled !== resolvedLocal) {
      return [`${name}: installed link does not match the locked local target`];
    }
    return validateInstalled(root, name, expectedVersion, installedRoot, {
      lockedCommandRoots,
    });
  } catch (error) {
    return [`${name}: ${error.message}`];
  }
}

function pnpmPackageIdentity(name, selected) {
  if (!selected.startsWith("npm:"))
    return { name, depPath: `${name}@${selected}` };
  const identity = selected.slice("npm:".length);
  const separator = pnpmPackageSeparator(identity);
  if (separator <= 0) return { name, depPath: `${name}@${selected}` };
  return {
    name: identity.slice(0, separator),
    depPath: identity,
  };
}

function pnpmPackageSeparator(identity) {
  const scopeEnd = identity.startsWith("@") ? identity.indexOf("/") : -1;
  return identity.indexOf("@", scopeEnd + 1);
}

function pnpmDepPathIdentity(depPath) {
  const identity = depPath.split("(", 1)[0];
  const separator = pnpmPackageSeparator(identity);
  if (separator <= 0) return { name: identity, version: "" };
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  };
}

function pnpmDepPathFilename(depPath, maxLength = 120) {
  let value = depPath;
  const separator = value.indexOf("@", 1);
  if (!value.startsWith("file:") && separator !== -1) {
    value = `${value.slice(0, separator)}@${value.slice(separator + 1)}`;
  } else if (value.startsWith("file:")) {
    value = value.replace(":", "+");
  }
  value = [...value]
    .map((char) => ('\\/:*?"<>|#'.includes(char) ? "+" : char))
    .join("");
  if (value.includes("(")) {
    value = value
      .replace(/\)$/u, "")
      .replaceAll(")(", "_")
      .replaceAll("(", "_")
      .replaceAll(")", "_");
  }
  if (
    value.length > maxLength ||
    (value !== value.toLowerCase() && !value.startsWith("file+"))
  ) {
    const hash = crypto
      .createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 32);
    return `${value.slice(0, maxLength - 33)}_${hash}`;
  }
  return value;
}

function containedPath(root, candidate) {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedCandidate = fs.existsSync(candidate)
    ? fs.realpathSync(candidate)
    : path.resolve(candidate);
  return isSubpath(resolvedRoot, resolvedCandidate);
}

function addLockedPackageRoot(
  lockedCommandRoots,
  root,
  candidate,
  expectedVersion,
) {
  if (!fs.existsSync(candidate)) return;
  try {
    const resolved = containedRealpath(root, candidate, "locked package");
    const pkg = readJson(
      path.join(resolved, "package.json"),
      "locked package.json",
      root,
    );
    if (installedVersionMatches(pkg.version, expectedVersion)) {
      lockedCommandRoots.add(resolved);
    }
  } catch {
    // The owning manager's direct-package validation reports actionable errors.
  }
}

function shimNodePath(text) {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith("  export NODE_PATH="));
  if (!line) return [];
  const quoted = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
  const value = quoted.endsWith(":$NODE_PATH")
    ? quoted.slice(0, -":$NODE_PATH".length)
    : quoted;
  return value ? value.split(":") : [];
}

function commandNodePathContained(root, entry) {
  // pnpm emits optional NODE_PATH entries for peer locations that may not
  // exist in a flat install. Missing entries are inert; validate only paths
  // that resolve so a normal pnpm shim is not rejected as an escape.
  let cursor = entry;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return containedPath(root, cursor);
}

async function expectedCommandFiles(target, command, nodePath) {
  const writes = new Map();
  const memoryFs = {
    promises: {
      chmod: async () => {},
      mkdir: async () => {},
      readFile: async (file, encoding) => {
        const bytes = readBuffer(file, `${path.basename(file)} command target`);
        return encoding ? bytes.toString(encoding) : bytes;
      },
      stat: async (file) => fs.statSync(file),
      unlink: async () => {},
      writeFile: async (file, data) => {
        writes.set(file, String(data));
      },
    },
  };
  const { cmdShim } = await import("@zkochan/cmd-shim");
  await cmdShim(target, command, {
    createCmdFile:
      process.platform === "win32" || fs.existsSync(`${command}.cmd`),
    createPwshFile:
      process.platform === "win32" || fs.existsSync(`${command}.ps1`),
    fs: memoryFs,
    nodePath,
  });
  return writes;
}

async function validateCommandGroup(root, command, target, name) {
  const stat = fs.lstatSync(command);
  if (stat.isSymbolicLink()) {
    if (containedRealpath(root, command, `${name} executable`) !== target) {
      return [`${name}: executable targets the wrong file`];
    }
    const expected = await expectedCommandFiles(target, command, []);
    const failures = [];
    for (const [file, content] of expected) {
      if (file === command) continue;
      if (!fs.existsSync(file)) {
        failures.push(
          `${name}: command wrapper ${path.extname(file)} is missing`,
        );
      } else if (readText(file, `${name} command wrapper`) !== content) {
        failures.push(
          `${name}: command wrapper ${path.extname(file)} differs from the supported template`,
        );
      }
    }
    return failures;
  }
  const text = readText(command, `${name} executable`);
  const markerPrefix = "# cmd-shim-target=";
  const marker = text.trimEnd().split("\n").at(-1);
  let markerTarget = null;
  let markerPath = null;
  if (marker?.startsWith(markerPrefix)) {
    markerPath = marker.slice(markerPrefix.length);
    try {
      markerTarget = containedRealpath(
        root,
        markerPath,
        `${name} executable marker`,
      );
    } catch {
      markerTarget = null;
    }
  }
  if (markerTarget !== target) {
    return [`${name}: regular executable has no exact target marker`];
  }
  const nodePath = shimNodePath(text);
  for (const entry of nodePath) {
    if (!commandNodePathContained(root, entry)) {
      return [`${name}: executable NODE_PATH escapes the repository`];
    }
  }
  // The marker is already proven to resolve to the locked target. Generate
  // the complete template using its lexical path, as pnpm does for symlinks.
  const expected = await expectedCommandFiles(markerPath, command, nodePath);
  const failures = [];
  for (const [file, content] of expected) {
    if (!fs.existsSync(file)) {
      failures.push(
        `${name}: command wrapper ${path.extname(file) || "POSIX"} is missing`,
      );
    } else if (readText(file, `${name} command wrapper`) !== content) {
      failures.push(
        `${name}: command wrapper ${path.extname(file) || "POSIX"} differs from the supported template`,
      );
    }
  }
  return failures;
}

function declaredCommandOwner(root, commandName, target) {
  const resolvedRoot = fs.realpathSync(root);
  let cursor = path.dirname(target);
  while (containedPath(resolvedRoot, cursor)) {
    const manifest = path.join(cursor, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = readJson(manifest, `${commandName} owner package.json`);
      if (
        packageBinEntries(pkg.name || "", pkg).some(
          ([name, relative]) =>
            name === commandName && path.resolve(cursor, relative) === target,
        )
      ) {
        return fs.realpathSync(cursor);
      }
    }
    if (cursor === resolvedRoot) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

async function validateBinDirectory(root, lockedCommandRoots) {
  const binRoot = path.join(root, "node_modules", ".bin");
  if (!fs.existsSync(binRoot)) return [];
  const failures = [];
  const entries = fs.readdirSync(binRoot);
  for (const entry of entries) {
    if (entry.endsWith(".cmd") || entry.endsWith(".ps1")) continue;
    const command = path.join(binRoot, entry);
    const stat = fs.lstatSync(command);
    let target;
    if (stat.isSymbolicLink()) {
      target = containedRealpath(root, command, `${entry} executable`);
    } else {
      const text = readText(command, `${entry} executable`);
      const marker = text.trimEnd().split("\n").at(-1);
      if (!marker.startsWith("# cmd-shim-target=")) {
        failures.push(
          `${entry}: regular executable has no exact target marker`,
        );
        continue;
      }
      target = containedRealpath(
        root,
        marker.slice("# cmd-shim-target=".length),
        `${entry} target`,
      );
    }
    failures.push(
      ...(await validateCommandGroup(root, command, target, entry)),
    );
    const owner = declaredCommandOwner(root, entry, target);
    if (!owner) {
      failures.push(
        `${entry}: executable is not declared by its target package`,
      );
    } else if (!lockedCommandRoots.has(owner)) {
      failures.push(`${entry}: executable owner is not bound by the lockfile`);
    }
  }
  for (const entry of entries.filter(
    (candidate) => candidate.endsWith(".cmd") || candidate.endsWith(".ps1"),
  )) {
    const base = entry.endsWith(".cmd")
      ? entry.slice(0, -4)
      : entry.slice(0, -4);
    if (!entries.includes(base))
      failures.push(`${entry}: command wrapper has no base shim`);
  }
  return failures;
}

function pnpmSelection(lock, name) {
  const importer = lock.importers?.["."];
  return {
    ...(importer?.dependencies || {}),
    ...(importer?.devDependencies || {}),
  }[name];
}

function inspectPnpm(
  root,
  dependencies,
  specs,
  managerVersion,
  lockedCommandRoots,
) {
  const text = readText(path.join(root, "pnpm-lock.yaml"), "pnpm-lock.yaml");
  validateYamlText(text, "pnpm-lock.yaml");
  const documents = parseAllDocuments(text, {
    maxAliasCount: 100,
    uniqueKeys: true,
  });
  if (![1, 2].includes(documents.length)) {
    return [
      "pnpm: lockfile must contain one project document or one environment plus one project document",
    ];
  }
  if (documents.some((document) => document.errors.length > 0)) {
    return [`pnpm: malformed lockfile (${documents[0].errors[0]?.message})`];
  }
  const locks = documents.map((document) =>
    document.toJS({ maxAliasCount: 100 }),
  );
  for (const lock of locks) validateObjectLimits(lock, "pnpm-lock.yaml");
  if (locks.some((lock) => String(lock?.lockfileVersion) !== "9.0")) {
    return ["pnpm: unsupported lockfile schema"];
  }
  const compatibility = schemaCompatibilityFailure(
    "pnpm",
    managerVersion,
    "9.0",
  );
  if (compatibility.length > 0) return compatibility;
  if (locks.length === 2 && !locks[0]?.importers?.["."]?.configDependencies) {
    return ["pnpm: first document is not an environment lockfile"];
  }
  const lock = locks.at(-1);
  if (!lock?.importers?.["."]) return ["pnpm: root importer is missing"];
  const modulesFile = path.join(root, "node_modules", ".modules.yaml");
  const modules = fs.existsSync(modulesFile)
    ? parseYaml(
        readText(modulesFile, "pnpm modules state"),
        "pnpm modules state",
      )
    : {};
  for (const depPath of Object.keys(lock.snapshots || {})) {
    const { name: packageName, version } = pnpmDepPathIdentity(depPath);
    if (!packageName || !version) continue;
    if (!exactVersion(version)) continue;
    addLockedPackageRoot(
      lockedCommandRoots,
      root,
      path.join(
        root,
        "node_modules",
        ".pnpm",
        pnpmDepPathFilename(depPath, modules.virtualStoreDirMaxLength || 120),
        "node_modules",
        packageName,
      ),
      version,
    );
  }
  const failures = [];
  for (const name of dependencies) {
    const selection = pnpmSelection(lock, name);
    if (selection?.specifier !== specs[name]) {
      failures.push(
        `${name}: package.json requires ${specs[name]}, pnpm-lock records ${selection?.specifier || "missing"}`,
      );
      continue;
    }
    const selected = String(selection.version || "");
    if (!selected) {
      failures.push(`${name}: missing pnpm lock selection`);
      continue;
    }
    if (/^(?:link|file):/.test(selected)) {
      const packageRoot = path.resolve(
        root,
        selected.replace(/^(?:link|file):/, ""),
      );
      try {
        const local = readJson(
          path.join(
            containedRealpath(root, packageRoot, `${name} local package`),
            "package.json",
          ),
          `${name} package.json`,
        );
        if (!localSelectionSatisfies(specs[name], selected, local.version)) {
          failures.push(
            `${name}: pnpm local selection ${selected} does not satisfy ${specs[name]}`,
          );
          continue;
        }
        failures.push(
          ...validateLocalInstall(
            root,
            name,
            packageRoot,
            local.version,
            lockedCommandRoots,
          ),
        );
      } catch (error) {
        failures.push(error.message);
      }
      continue;
    }
    const identity = pnpmPackageIdentity(name, selected);
    const packageKey = identity.depPath.split("(", 1)[0];
    const packageRecord = lock.packages?.[packageKey];
    const snapshotRecord = lock.snapshots?.[identity.depPath];
    if (
      !packageRecord ||
      typeof packageRecord !== "object" ||
      !snapshotRecord ||
      typeof snapshotRecord !== "object" ||
      typeof packageRecord.resolution?.integrity !== "string" ||
      packageRecord.resolution.integrity.length === 0
    ) {
      failures.push(
        `${name}: pnpm package graph does not bind ${identity.depPath}`,
      );
      continue;
    }
    const { version } = pnpmDepPathIdentity(identity.depPath);
    if (
      !registrySelectionSatisfies(name, specs[name], identity.name, version)
    ) {
      failures.push(
        `${name}: pnpm selection ${identity.name}@${version} does not satisfy ${specs[name]}`,
      );
      continue;
    }
    const expectedRoot = path.join(
      root,
      "node_modules",
      ".pnpm",
      pnpmDepPathFilename(
        identity.depPath,
        modules.virtualStoreDirMaxLength || 120,
      ),
      "node_modules",
      identity.name,
    );
    try {
      if (
        containedRealpath(
          root,
          path.join(root, "node_modules", name),
          `${name} package`,
        ) !== containedRealpath(root, expectedRoot, `${name} locked package`)
      ) {
        failures.push(
          `${name}: installed pnpm locator does not match ${identity.depPath}`,
        );
        continue;
      }
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      continue;
    }
    failures.push(
      ...validateInstalled(
        root,
        name,
        version,
        path.join(root, "node_modules", name),
        { expectedName: identity.name, lockedCommandRoots },
      ),
    );
  }
  return failures;
}

function yarnRootRecord(lock, pkg) {
  const resolution = `${pkg.name}@workspace:.`;
  return (
    lock[resolution] ||
    Object.values(lock).find((record) => record?.resolution === resolution)
  );
}

function yarnSelectedRecord(lock, name, selector) {
  const exact = `${name}@${selector}`;
  const keys = Object.keys(lock).filter((key) =>
    key.split(/,\s*/).includes(exact),
  );
  return keys.length === 1 ? lock[keys[0]] : null;
}

function yarnLocalTarget(root, name, record) {
  const prefix = `${name}@`;
  if (!String(record?.resolution || "").startsWith(prefix)) return null;
  const reference = record.resolution.slice(prefix.length);
  const match = reference.match(/^(workspace|file|link|portal):(.+)$/u);
  if (!match) return null;
  const selector = match[2].split("::", 1)[0];
  if (!selector || /^[~^*]/u.test(selector)) {
    throw new Error(`${name}: Yarn local locator has no concrete path`);
  }
  if (record.linkType !== "soft") {
    throw new Error(`${name}: Yarn local locator must use a soft link`);
  }
  return containedRealpath(
    root,
    path.resolve(root, selector),
    `${name} locked Yarn local package`,
  );
}

function yarnLocatorSlug(name, reference) {
  const scopeSeparator = name.startsWith("@") ? name.indexOf("/") : -1;
  const scope = scopeSeparator === -1 ? null : name.slice(1, scopeSeparator);
  const bareName =
    scopeSeparator === -1 ? name : name.slice(scopeSeparator + 1);
  const identHash = crypto
    .createHash("sha512")
    .update(`${scope || ""}${bareName}`)
    .digest("hex");
  const locatorHash = crypto
    .createHash("sha512")
    .update(`${identHash}${reference}`)
    .digest("hex");
  const colon = reference.indexOf(":");
  const protocol = colon === -1 ? "exotic" : reference.slice(0, colon);
  const selector = colon === -1 ? reference : reference.slice(colon + 1);
  const humanReference = exactVersion(selector)
    ? `${protocol}-${selector}`
    : protocol;
  const ident = scope === null ? bareName : `@${scope}-${bareName}`;
  return `${ident}-${humanReference}-${locatorHash.slice(0, 10)}`;
}

function inspectYarn(
  root,
  pkg,
  dependencies,
  specs,
  { managerVersion, lockedCommandRoots },
) {
  let lock;
  try {
    const text = readText(path.join(root, "yarn.lock"), "yarn.lock");
    validateYamlText(text, "yarn.lock");
    lock = parseSyml(text);
    validateObjectLimits(lock, "yarn.lock");
  } catch (error) {
    return [`yarn.lock is malformed: ${error.message}`];
  }
  if (![8, 9, 10].includes(Number(lock.__metadata?.version))) {
    return [
      `yarn: unsupported lock schema ${lock.__metadata?.version || "missing"}`,
    ];
  }
  const compatibility = schemaCompatibilityFailure(
    "yarn",
    managerVersion,
    Number(lock.__metadata.version),
  );
  if (compatibility.length > 0) return compatibility;
  const rootRecord = yarnRootRecord(lock, pkg);
  if (!rootRecord) return ["yarn: root workspace record is missing"];
  const configFile = path.join(root, ".yarnrc.yml");
  const config = fs.existsSync(configFile)
    ? parseYaml(readText(configFile, ".yarnrc.yml"), ".yarnrc.yml")
    : {};
  const linker = config.nodeLinker || "pnp";
  if (linker === "pnp") {
    if (
      config.pnpEnableInlining !== false ||
      !fs.existsSync(path.join(root, ".pnp.data.json"))
    ) {
      return [
        "yarn: inline PnP is unsupported; set pnpEnableInlining: false and run yarn install --immutable",
      ];
    }
    return inspectYarnPnp(root, rootRecord, lock, dependencies, specs);
  }
  if (!["node-modules", "pnpm"].includes(linker)) {
    return [`yarn: unsupported linker ${linker}`];
  }
  let state = null;
  if (linker === "node-modules") {
    const stateFile = path.join(root, "node_modules", ".yarn-state.yml");
    if (!fs.existsSync(stateFile)) {
      return ["yarn: node_modules/.yarn-state.yml is missing"];
    }
    state = parseYaml(readText(stateFile, "Yarn state"), "Yarn state");
    if (Number(state.__metadata?.version) !== 1) {
      return [
        `yarn: unsupported install-state schema ${state.__metadata?.version || "missing"}`,
      ];
    }
    for (const record of Object.values(lock)) {
      if (!record?.resolution || typeof record.version !== "string") continue;
      for (const location of state[record.resolution]?.locations || []) {
        addLockedPackageRoot(
          lockedCommandRoots,
          root,
          path.resolve(root, location),
          record.version,
        );
      }
    }
  }
  const packageMap =
    linker === "pnpm"
      ? readJson(
          path.join(root, "node_modules", ".package-map.json"),
          "Yarn package map",
        )
      : null;
  const failures = [];
  for (const name of dependencies) {
    const selector = rootRecord.dependencies?.[name];
    if (String(selector || "").replace(/^npm:/, "") !== specs[name]) {
      failures.push(
        `${name}: package.json requires ${specs[name]}, yarn.lock records ${selector || "missing"}`,
      );
      continue;
    }
    const record = yarnSelectedRecord(lock, name, selector);
    if (!record) {
      failures.push(`${name}: yarn.lock selection is ambiguous or missing`);
      continue;
    }
    const localRecord = /^(?:workspace|file|link|portal):/.test(
      String(record.resolution).slice(`${name}@`.length),
    );
    if (
      localRecord &&
      !localSelectionSatisfies(
        specs[name],
        String(record.resolution).slice(`${name}@`.length),
        record.version,
      )
    ) {
      failures.push(
        `${name}: Yarn local selection does not satisfy ${specs[name]}`,
      );
      continue;
    }
    if (
      !localRecord &&
      !registrySelectionSatisfies(name, specs[name], name, record.version)
    ) {
      failures.push(
        `${name}: Yarn selection ${record.version} does not satisfy ${specs[name]}`,
      );
      continue;
    }
    if (
      linker === "node-modules" &&
      !state[record.resolution]?.locations?.includes(`node_modules/${name}`)
    ) {
      failures.push(`${name}: Yarn install state does not bind yarn.lock`);
      continue;
    }
    const packageRoot =
      linker === "pnpm"
        ? path.join(
            root,
            "node_modules",
            packageMap?.packages?.["."]?.dependencies?.[name] || "",
          )
        : path.join(root, "node_modules", name);
    try {
      const localTarget = yarnLocalTarget(root, name, record);
      if (
        localTarget &&
        containedRealpath(root, packageRoot, `${name} installed package`) !==
          localTarget
      ) {
        failures.push(
          `${name}: installed package does not match the locked Yarn local target`,
        );
        continue;
      }
      if (
        localTarget &&
        linker === "node-modules" &&
        !fs.lstatSync(packageRoot).isSymbolicLink()
      ) {
        failures.push(`${name}: Yarn local package is not installed as a link`);
        continue;
      }
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      continue;
    }
    if (linker === "pnpm") {
      const reference = record.resolution.slice(`${name}@`.length);
      const expectedMap = `.store/${yarnLocatorSlug(name, reference)}/package`;
      const mapped = packageMap?.packages?.["."]?.dependencies?.[name];
      if (mapped !== expectedMap) {
        failures.push(
          `${name}: Yarn package map does not bind ${record.resolution}`,
        );
        continue;
      }
      try {
        if (
          containedRealpath(
            root,
            path.join(root, "node_modules", name),
            `${name} package`,
          ) !== containedRealpath(root, packageRoot, `${name} mapped package`)
        ) {
          failures.push(
            `${name}: Yarn package link does not match package map`,
          );
          continue;
        }
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        continue;
      }
    }
    failures.push(
      ...validateInstalled(root, name, record.version, packageRoot, {
        lockedCommandRoots,
      }),
    );
  }
  return failures;
}

function inspectYarnPnp(root, rootRecord, lock, dependencies, specs) {
  const data = readJson(path.join(root, ".pnp.data.json"), ".pnp.data.json");
  const registry = new Map(
    (data.packageRegistryData || []).map(([name, references]) => [
      name,
      new Map(references),
    ]),
  );
  const rootLocators = (data.dependencyTreeRoots || []).filter(
    (locator) =>
      `${locator?.name}@${locator?.reference}` === rootRecord.resolution,
  );
  if (rootLocators.length !== 1) {
    return ["yarn: exact root package is not unique in .pnp.data.json"];
  }
  const [rootLocator] = rootLocators;
  const rootInfo = registry.get(rootLocator?.name)?.get(rootLocator?.reference);
  if (!rootInfo) return ["yarn: root package is missing from .pnp.data.json"];
  try {
    if (
      rootInfo.linkType !== "SOFT" ||
      containedRealpath(
        root,
        path.resolve(root, rootInfo.packageLocation),
        "Yarn PnP root package",
      ) !== fs.realpathSync(root)
    ) {
      return ["yarn: root package location does not match the repository"];
    }
  } catch (error) {
    return [`yarn: ${error.message}`];
  }
  const rootDependencies = new Map(rootInfo.packageDependencies || []);
  const failures = [];
  for (const name of dependencies) {
    const selector = rootRecord.dependencies?.[name];
    if (String(selector || "").replace(/^npm:/, "") !== specs[name]) {
      failures.push(`${name}: package.json and yarn.lock specs differ`);
      continue;
    }
    const reference = rootDependencies.get(name);
    const record = yarnSelectedRecord(lock, name, selector);
    const info = registry.get(name)?.get(reference);
    if (!record || record.resolution !== `${name}@${reference}` || !info) {
      failures.push(`${name}: PnP reference does not bind yarn.lock`);
      continue;
    }
    if (String(info.packageLocation).includes(".zip")) {
      if (
        info.linkType !== "HARD" ||
        record.linkType !== "hard" ||
        !String(reference).startsWith("npm:")
      ) {
        failures.push(
          `${name}: only registry hard-cache archives may be external`,
        );
        continue;
      }
      failures.push(
        ...validateYarnArchive(root, name, info.packageLocation, record),
      );
      continue;
    }
    try {
      const localTarget = yarnLocalTarget(root, name, record);
      if (
        localTarget &&
        (info.linkType !== "SOFT" ||
          containedRealpath(
            root,
            path.resolve(root, info.packageLocation),
            `${name} PnP package`,
          ) !== localTarget)
      ) {
        failures.push(
          `${name}: PnP package does not match the locked Yarn local target`,
        );
        continue;
      }
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      continue;
    }
    failures.push(
      ...validateInstalled(
        root,
        name,
        record.version,
        path.resolve(root, info.packageLocation),
        { expectedName: name, checkCommandLinks: false },
      ),
    );
  }
  return failures;
}

function zipEntryNameSafe(name) {
  if (!name || name.startsWith("/") || name.startsWith("\\")) return false;
  if (name.length > 1 && name[1] === ":") return false;
  return !name
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "..");
}

function inspectRawZip(bytes, name) {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  let eocd = -1;
  const lower = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= lower; offset -= 1) {
    if (bytes.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1)
    throw new Error(`${name}: Yarn archive has no central directory`);
  const count = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  let offset = bytes.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES)
    throw new Error(`${name}: Yarn archive has too many entries`);
  if (offset + size > eocd)
    throw new Error(`${name}: Yarn archive central directory is invalid`);
  const end = offset + size;
  const names = new Set();
  let expanded = 0;
  const aggregateBudget = Math.min(
    MAX_ZIP_EXPANDED_BYTES,
    Math.max(bytes.length * 100, 1),
  );
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== centralSignature) {
      throw new Error(`${name}: Yarn archive central directory is invalid`);
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const entrySize = bytes.readUInt32LE(offset + 24);
    const attributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const entryName = bytes.toString(
      "utf8",
      offset + 46,
      offset + 46 + nameLength,
    );
    if (
      entryName.includes("\0") ||
      !zipEntryNameSafe(entryName) ||
      names.has(entryName)
    ) {
      throw new Error(`${name}: Yarn archive has a duplicate or unsafe entry`);
    }
    names.add(entryName);
    const fileType = (attributes >>> 16) & 0o170000;
    if (![0, 0o040000, 0o100000].includes(fileType)) {
      throw new Error(`${name}: Yarn archive has a non-file entry`);
    }
    if (entrySize > MAX_ZIP_ENTRY_BYTES)
      throw new Error(`${name}: Yarn archive entry is too large`);
    if (expanded + entrySize > aggregateBudget) {
      throw new Error(`${name}: Yarn archive expansion limit exceeded`);
    }
    if ((flags & 0x08) !== 0) {
      throw new Error(
        `${name}: Yarn archive uses an unsupported data descriptor`,
      );
    }
    if (
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== localSignature
    ) {
      throw new Error(`${name}: Yarn archive local header is invalid`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const localName = bytes.toString(
      "utf8",
      localOffset + 30,
      localOffset + 30 + localNameLength,
    );
    if (
      localName !== entryName ||
      bytes.readUInt16LE(localOffset + 8) !== method ||
      bytes.readUInt32LE(localOffset + 18) !== compressedSize ||
      bytes.readUInt32LE(localOffset + 22) !== entrySize ||
      dataOffset + compressedSize > bytes.length
    ) {
      throw new Error(`${name}: Yarn archive local and central sizes differ`);
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let actual;
    if (method === 0) {
      actual = compressed;
    } else if (method === 8) {
      actual = zlib.inflateRawSync(compressed, {
        maxOutputLength:
          Math.min(MAX_ZIP_ENTRY_BYTES, aggregateBudget - expanded) + 1,
      });
    } else {
      throw new Error(`${name}: Yarn archive compression is unsupported`);
    }
    if (actual.length !== entrySize) {
      throw new Error(
        `${name}: Yarn archive expanded size differs from metadata`,
      );
    }
    expanded += actual.length;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end)
    throw new Error(`${name}: Yarn archive central directory is invalid`);
  if (
    expanded > MAX_ZIP_EXPANDED_BYTES ||
    expanded > Math.max(bytes.length * 100, 1)
  ) {
    throw new Error(`${name}: Yarn archive expansion limit exceeded`);
  }
}

function validateYarnArchive(root, name, packageLocation, record) {
  let archive;
  try {
    const resolvedLocation = path.resolve(root, packageLocation);
    const marker = resolvedLocation.indexOf(".zip") + 4;
    archive = resolvedLocation.slice(0, marker);
    const inner = resolvedLocation.slice(marker).replaceAll(path.sep, "/");
    const bytes = readBuffer(archive, `${name} Yarn archive`);
    const expected = String(record.checksum || "")
      .split("/")
      .at(-1);
    const actual = crypto.createHash("sha512").update(bytes).digest("hex");
    if (!expected || expected !== actual) {
      return [`${name}: Yarn archive checksum does not match yarn.lock`];
    }
    inspectRawZip(bytes, name);
    const zip = new ZipFS(bytes, { readOnly: true });
    try {
      const files = zip.getAllFiles();
      if (files.length > MAX_ZIP_ENTRIES) {
        return [`${name}: Yarn archive has too many entries`];
      }
      let expanded = 0;
      for (const file of files) {
        const stat = zip.lstatSync(file);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          return [`${name}: Yarn archive has an unsafe entry`];
        }
        if (stat.isFile()) {
          if (stat.size > MAX_ZIP_ENTRY_BYTES) {
            return [`${name}: Yarn archive entry is too large`];
          }
          expanded += stat.size;
        }
      }
      if (
        expanded > MAX_ZIP_EXPANDED_BYTES ||
        expanded > Math.max(bytes.length * 100, 1)
      ) {
        return [`${name}: Yarn archive expansion limit exceeded`];
      }
      const packageRoot = path.posix.normalize(inner).replace(/\/+$/u, "");
      const manifestPath = `${packageRoot}/package.json`;
      if (zip.lstatSync(manifestPath).size > MAX_FILE_BYTES) {
        return [`${name}: Yarn archive package manifest is too large`];
      }
      const manifestText = zip.readFileSync(manifestPath, "utf8");
      validateJsonText(manifestText, `${name} Yarn archive package manifest`);
      const installed = JSON.parse(manifestText);
      validateObjectLimits(installed, `${name} Yarn archive package manifest`);
      if (
        installed.name !== name ||
        !installedVersionMatches(installed.version, record.version)
      ) {
        return [`${name}: Yarn archive identity does not match yarn.lock`];
      }
      for (const [, target] of packageBinEntries(name, installed)) {
        const portableTarget = String(target).replaceAll("\\", "/");
        const targetPath = path.posix.normalize(
          path.posix.join(packageRoot, portableTarget),
        );
        if (
          portableTarget.includes("\0") ||
          path.posix.isAbsolute(portableTarget) ||
          (portableTarget.length > 1 && portableTarget[1] === ":") ||
          (targetPath !== packageRoot &&
            !targetPath.startsWith(`${packageRoot}/`))
        ) {
          return [`${name}: Yarn archive declared bin escapes package root`];
        }
        if (!zip.existsSync(targetPath)) {
          return [`${name}: Yarn archive declared bin is missing`];
        }
      }
      return [];
    } finally {
      zip.discardAndClose();
    }
  } catch (error) {
    return [
      `${name}: Yarn archive ${archive || "state"} is invalid (${error.message})`,
    ];
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function bunLocalPath(root, locator) {
  const separator = locator.indexOf(":");
  return path.resolve(root, locator.slice(separator + 1));
}

function bunOverrideVersion(pkg, name) {
  const override = pkg.overrides?.[name];
  if (override === undefined) return { present: false, version: null };
  const value = String(override);
  if (exactVersion(value)) return { present: true, version: value };
  const prefix = `npm:${name}@`;
  if (value.startsWith(prefix) && exactVersion(value.slice(prefix.length))) {
    return { present: true, version: value.slice(prefix.length) };
  }
  return { present: true, version: null };
}

function inspectBun(
  root,
  pkg,
  dependencies,
  specs,
  { managerVersion, lockedCommandRoots },
) {
  if (
    fs.existsSync(path.join(root, "bun.lockb")) &&
    !fs.existsSync(path.join(root, "bun.lock"))
  ) {
    return [
      "bun: bun.lockb is unsupported; run bun install --save-text-lockfile --frozen-lockfile --lockfile-only",
    ];
  }
  const errors = [];
  const lock = parseJsonc(
    (() => {
      const text = readText(path.join(root, "bun.lock"), "bun.lock");
      validateJsonText(text, "bun.lock", {
        allowComments: true,
        allowTrailingComma: true,
      });
      return text;
    })(),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length > 0) {
    return [`bun.lock is malformed: ${printParseErrorCode(errors[0].error)}`];
  }
  validateObjectLimits(lock, "bun.lock");
  if (
    !Object.hasOwn(lock, "lockfileVersion") ||
    !Object.hasOwn(lock, "workspaces") ||
    !Object.hasOwn(lock, "packages") ||
    ![1, 2, 3].includes(lock.lockfileVersion)
  ) {
    return [
      `bun: unsupported lock schema ${lock.lockfileVersion || "missing"}`,
    ];
  }
  const compatibility = schemaCompatibilityFailure(
    "bun",
    managerVersion,
    lock.lockfileVersion,
  );
  if (compatibility.length > 0) return compatibility;
  const bunfigFile = path.join(root, "bunfig.toml");
  if (fs.existsSync(bunfigFile)) {
    const text = readText(bunfigFile, "bunfig.toml");
    validateTomlText(text, "bunfig.toml");
    const bunfig = parseToml(text);
    validateObjectLimits(bunfig, "bunfig.toml");
    if (bunfig.install?.globalStore === true) {
      return [
        "bun: install.globalStore is unsupported; disable it and run bun install --frozen-lockfile",
      ];
    }
  }
  if (
    lock.lockfileVersion === 3 &&
    JSON.stringify(canonicalJson(lock.overrides || {})) !==
      JSON.stringify(canonicalJson(pkg.overrides || {}))
  ) {
    return ["bun: schema 3 overrides do not match package.json"];
  }
  if (
    typeof lock.workspaces !== "object" ||
    lock.workspaces === null ||
    !Object.hasOwn(lock.workspaces, "")
  ) {
    return ["bun: root workspace record is missing"];
  }
  const rootWorkspace = lock.workspaces[""];
  const rootSpecs = {
    ...(rootWorkspace?.dependencies || {}),
    ...(rootWorkspace?.devDependencies || {}),
  };
  for (const [packageName, record] of Object.entries(lock.packages || {})) {
    const locator = String(record?.[0] || "");
    const version = locator.slice(locator.lastIndexOf("@") + 1).split("/")[0];
    if (!exactVersion(version)) continue;
    addLockedPackageRoot(
      lockedCommandRoots,
      root,
      path.join(root, "node_modules", packageName),
      version,
    );
  }
  const failures = [];
  for (const name of dependencies) {
    if (rootSpecs[name] !== specs[name]) {
      failures.push(
        `${name}: package.json requires ${specs[name]}, bun.lock records ${rootSpecs[name] || "missing"}`,
      );
      continue;
    }
    if (
      typeof lock.packages !== "object" ||
      lock.packages === null ||
      !Object.hasOwn(lock.packages, name)
    ) {
      failures.push(`${name}: missing Bun package record`);
      continue;
    }
    const record = lock.packages[name];
    const locator = String(record?.[0] || "");
    const locatorPrefix = `${name}@`;
    if (!locator.startsWith(locatorPrefix)) {
      failures.push(`${name}: Bun package locator does not bind its name`);
      continue;
    }
    const locatorReference = locator.slice(locatorPrefix.length);
    const override = bunOverrideVersion(pkg, name);
    if (override.present && override.version === null) {
      failures.push(
        `${name}: unsupported Bun override ${Object.hasOwn(pkg.overrides || {}, name) ? pkg.overrides[name] : "missing"}`,
      );
      continue;
    }
    if (/^(?:file|workspace|link):/.test(locatorReference)) {
      if (override.present) {
        failures.push(`${name}: Bun override does not select the local record`);
        continue;
      }
      const localLocator = locatorReference;
      const localRoot = bunLocalPath(root, localLocator);
      try {
        const contained = containedRealpath(
          root,
          localRoot,
          `${name} local package`,
        );
        const local = readJson(
          path.join(contained, "package.json"),
          `${name} package.json`,
        );
        if (
          !localSelectionSatisfies(specs[name], locatorReference, local.version)
        ) {
          failures.push(
            `${name}: Bun local selection ${locatorReference} does not satisfy ${specs[name]}`,
          );
          continue;
        }
        failures.push(
          ...validateLocalInstall(
            root,
            name,
            localRoot,
            local.version,
            lockedCommandRoots,
          ),
        );
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
      continue;
    }
    if (locator.includes("git+") || locator.includes("github:")) {
      failures.push(`${name}: unsupported Bun remote locator ${locator}`);
      continue;
    }
    if (
      lock.lockfileVersion >= 2 &&
      typeof record?.[1] === "string" &&
      record[1].startsWith("http") &&
      !record?.[3]
    ) {
      failures.push(
        `${name}: Bun schema ${lock.lockfileVersion} remote package has no integrity`,
      );
      continue;
    }
    const version = locator.slice(locator.lastIndexOf("@") + 1).split("/")[0];
    if (!exactVersion(version)) {
      failures.push(`${name}: missing or unsupported Bun package record`);
      continue;
    }
    if (
      !override.present &&
      !registrySelectionSatisfies(name, specs[name], name, version)
    ) {
      failures.push(
        `${name}: Bun selection ${version} does not satisfy ${specs[name]}`,
      );
      continue;
    }
    if (override.present && override.version !== version) {
      failures.push(
        `${name}: Bun override requires ${override.version}, lock selects ${version}`,
      );
      continue;
    }
    failures.push(
      ...validateInstalled(
        root,
        name,
        version,
        path.join(root, "node_modules", name),
        { lockedCommandRoots },
      ),
    );
  }
  return failures;
}

async function inspectDependencies(root) {
  if (!stableReadsSupported()) {
    return {
      manager: null,
      failures: [
        "unsupported host platform: dependency preflight requires O_NOFOLLOW stable reads (Linux or macOS)",
      ],
    };
  }
  const packageFile = path.join(root, "package.json");
  if (!fs.existsSync(packageFile)) return { manager: null, failures: [] };
  const pkg = readJson(packageFile, "package.json");
  const dependencies = directDependencies(pkg);
  const specs = dependencySpecs(pkg);
  const lockedCommandRoots = new Set();
  if (dependencies.length === 0) {
    const binRoot = path.join(root, "node_modules", ".bin");
    const entries = fs.existsSync(binRoot) ? fs.readdirSync(binRoot) : [];
    return {
      manager: null,
      failures:
        entries.length === 0
          ? []
          : ["dependency-free project has unbound node_modules/.bin entries"],
    };
  }
  let managerInfo;
  try {
    managerInfo = packageManager(root, pkg);
  } catch (error) {
    const declared = String(pkg.packageManager || "").split("@")[0];
    return {
      manager: SUPPORTED_MANAGERS.includes(declared) ? declared : null,
      failures: [error.message],
    };
  }
  const manager = managerInfo.name;
  const managerVersion = managerInfo.version;
  if (manager === "pnpm") {
    try {
      return {
        manager,
        failures: [
          ...inspectPnpm(
            root,
            dependencies,
            specs,
            managerVersion,
            lockedCommandRoots,
          ),
          ...(await validateBinDirectory(root, lockedCommandRoots)),
        ],
      };
    } catch (error) {
      return {
        manager,
        failures: [`pnpm inspection failed: ${error.message}`],
      };
    }
  }
  if (manager === "yarn") {
    try {
      return {
        manager,
        failures: [
          ...inspectYarn(root, pkg, dependencies, specs, {
            managerVersion,
            lockedCommandRoots,
          }),
          ...(await validateBinDirectory(root, lockedCommandRoots)),
        ],
      };
    } catch (error) {
      return {
        manager,
        failures: [`yarn inspection failed: ${error.message}`],
      };
    }
  }
  if (manager === "bun") {
    try {
      return {
        manager,
        failures: [
          ...inspectBun(root, pkg, dependencies, specs, {
            managerVersion,
            lockedCommandRoots,
          }),
          ...(await validateBinDirectory(root, lockedCommandRoots)),
        ],
      };
    } catch (error) {
      return { manager, failures: [`bun inspection failed: ${error.message}`] };
    }
  }
  const lockFile = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockFile)) {
    return { manager: "npm", failures: ["package-lock.json is missing"] };
  }
  let lock;
  try {
    lock = readJson(lockFile, "package-lock.json");
  } catch (error) {
    return {
      manager: "npm",
      failures: [`npm inspection failed: ${error.message}`],
    };
  }
  const failures = [];
  if (![2, 3].includes(lock.lockfileVersion)) {
    return {
      manager: "npm",
      failures: [
        `npm: unsupported package-lock schema ${lock.lockfileVersion || "missing"}`,
      ],
    };
  }
  const compatibility = schemaCompatibilityFailure(
    "npm",
    managerVersion,
    lock.lockfileVersion,
  );
  if (compatibility.length > 0) {
    return { manager: "npm", failures: compatibility };
  }
  const lockedRootSpecs = {
    ...(lock.packages?.[""]?.dependencies || {}),
    ...(lock.packages?.[""]?.devDependencies || {}),
  };
  for (const [relative, record] of Object.entries(lock.packages || {})) {
    if (!relative || typeof record !== "object" || record === null) continue;
    const expectedVersion =
      record.link === true
        ? lock.packages?.[record.resolved]?.version
        : record.version;
    if (typeof expectedVersion !== "string") continue;
    addLockedPackageRoot(
      lockedCommandRoots,
      root,
      path.resolve(root, relative),
      expectedVersion,
    );
  }
  for (const name of dependencies) {
    const relative = `node_modules/${name}`;
    const installedFile = path.join(root, relative, "package.json");
    const lockedIdentity = npmLockedIdentity(lock, name);
    if (lockedRootSpecs[name] !== specs[name]) {
      failures.push(
        `${name}: package.json requires ${specs[name]}, package-lock records ${lockedRootSpecs[name] || "missing"}`,
      );
      continue;
    }
    if (!lockedIdentity) {
      failures.push(`${name}: missing lockfile package record`);
      continue;
    }
    if (
      !registrySelectionSatisfies(
        name,
        specs[name],
        name,
        lockedIdentity.version,
      ) &&
      !lockedIdentity.target
    ) {
      failures.push(
        `${name}: npm selection ${lockedIdentity.version} does not satisfy ${specs[name]}`,
      );
      continue;
    }
    const installedRoot = path.dirname(installedFile);
    if (lockedIdentity.target) {
      try {
        const lockedTarget = containedRealpath(
          root,
          path.resolve(root, lockedIdentity.target),
          `${name} locked workspace`,
        );
        const installedTarget = containedRealpath(
          root,
          installedRoot,
          `${name} installed workspace`,
        );
        if (installedTarget !== lockedTarget) {
          failures.push(
            `${name}: installed workspace does not match package-lock target`,
          );
          continue;
        }
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        continue;
      }
    }
    failures.push(
      ...validateInstalled(root, name, lockedIdentity.version, installedRoot, {
        lockedCommandRoots,
      }),
    );
  }
  failures.push(...(await validateBinDirectory(root, lockedCommandRoots)));
  return { manager: "npm", failures };
}

function telemetryFile(env = process.env) {
  return (
    env.BS_QUALITY_PREFLIGHT_TELEMETRY_FILE ||
    path.join(
      env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
      "claude-kit",
      "quality-preflight.jsonl",
    )
  );
}

function recordFailure(root, result, env = process.env) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const record = {
    schemaVersion: 1,
    recordClass: "preflight",
    recordedAt: new Date().toISOString(),
    repositoryKey: crypto
      .createHash("sha256")
      .update(root)
      .digest("hex")
      .slice(0, 16),
    head,
    manager: result.manager,
    failureCount: result.failures.length,
    failures: result.failures,
  };
  const file = telemetryFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

async function check(root, env = process.env) {
  let result;
  try {
    result = await inspectDependencies(root);
  } catch (error) {
    result = {
      manager: null,
      failures: [`package inspection failed: ${error.message}`],
    };
  }
  if (result.failures.length === 0) return result;
  try {
    recordFailure(root, result, env);
  } catch (error) {
    process.stderr.write(
      `quality dependency preflight: telemetry write failed (${error.message}); dependency failure remains authoritative\n`,
    );
  }
  const detail = result.failures.map((failure) => `  - ${failure}`).join("\n");
  const installCommand = {
    npm: "npm ci",
    pnpm: "pnpm install --frozen-lockfile",
    yarn: "yarn install --immutable",
    bun: "bun install --frozen-lockfile",
  }[result.manager];
  const remediation = installCommand
    ? `Run ${installCommand} in this exact worktree before starting quality.`
    : "Declare one exact supported packageManager and its matching lockfile, then install dependencies in this exact worktree.";
  throw new Error(
    `package dependencies are not ready:\n${detail}\n${remediation}`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const repoIndex = argv.indexOf("--repo");
  const root = repoIndex === -1 ? "" : path.resolve(argv[repoIndex + 1] || "");
  if (!root || argv.length !== 2) {
    process.stderr.write(
      "usage: quality-dependency-preflight.js --repo <path>\n",
    );
    return 64;
  }
  try {
    await check(root);
    process.stdout.write("[quality] package dependency preflight passed\n");
    return 0;
  } catch (error) {
    process.stderr.write(`quality dependency preflight: ${error.message}\n`);
    return 78;
  }
}

module.exports = {
  check,
  inspectDependencies,
  isSubpath,
  pnpmDepPathIdentity,
  pnpmPackageIdentity,
  stableReadsSupported,
  telemetryFile,
  validateJsonText,
  validateYamlText,
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
