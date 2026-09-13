#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RECEIPT_KINDS = new Set([
  "behavioralTests",
  "acceptanceEvidence",
  "deploymentReceipt",
  "hostedJourney",
  "realUserEvidence",
]);

const LEGACY_TRUST_ROOTS = Object.freeze({
  producer: Object.freeze({
    darwin:
      "/Library/Application Support/claude-kit/product-evidence-public-key",
    linux: "/etc/claude-kit/product-evidence-public-key",
    win32: "C:\\ProgramData\\claude-kit\\product-evidence-public-key",
  }),
  admission: Object.freeze({
    darwin:
      "/Library/Application Support/claude-kit/product-admission-public-key",
    linux: "/etc/claude-kit/product-admission-public-key",
    win32: "C:\\ProgramData\\claude-kit\\product-admission-public-key",
  }),
});

const PRODUCT_TRUST_FILE = "product-trust.json";
const PRODUCT_TRUST_PURPOSES = new Set(["producer", "admission"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected
      .slice()
      .sort()
      .every((key, index) => key === actual[index])
  );
}

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("signed payload contains invalid Unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("signed payload contains invalid Unicode");
    }
  }
}

function canonicalJson(value) {
  if (typeof value === "string") assertValidUnicode(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertValidUnicode(key);
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("signed payload contains a non-JSON value");
}

function containedRealFile(root, relativePath, label) {
  if (!nonEmptyString(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path`);
  }
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, relativePath);
  if (!candidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${label} must stay inside the evidence directory`);
  }
  let cursor = realRoot;
  for (const part of path.relative(realRoot, candidate).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} must not use symbolic links`);
    }
  }
  const resolved = fs.realpathSync(candidate);
  if (!resolved.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${label} must stay inside the evidence directory`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`${label} must name a file`);
  }
  return resolved;
}

function decodeBase64(value, label, url = false, allowUnpadded = false) {
  if (!nonEmptyString(value)) throw new Error(`${label} is not valid base64`);
  if (url && value.includes("=")) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  const bytes = Buffer.from(value, url ? "base64url" : "base64");
  const encoded = bytes.toString(url ? "base64url" : "base64");
  const compatibleUnpadded =
    allowUnpadded && encoded.replace(/=+$/, "") === value;
  if (encoded !== value && !compatibleUnpadded) {
    throw new Error(`${label} is not canonical base64`);
  }
  return bytes;
}

function fixedTrustPath(platform = process.platform) {
  const legacy = LEGACY_TRUST_ROOTS.producer[platform];
  return legacy && path.join(path.dirname(legacy), PRODUCT_TRUST_FILE);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateRootOwnedPath(stat, label) {
  if (stat.uid !== 0) throw new Error(`${label} must be root-owned`);
  if (stat.mode & 0o022) {
    throw new Error(`${label} must not be group or other writable`);
  }
}

function assertSafeRegistryFile(stat, label) {
  if (stat.isSymbolicLink()) {
    throw new Error("product trust registry must not be a symbolic link");
  }
  if (!stat.isFile()) {
    throw new Error("product trust registry must be a regular file");
  }
  validateRootOwnedPath(stat, label);
}

function assertSafeRegistryDirectory(directory, fsImpl) {
  const parent = fsImpl.lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(
      "product trust registry directory must be a real directory",
    );
  }
  validateRootOwnedPath(parent, "product trust registry directory");
}

function readSafeRegistryFile(
  file,
  { fsImpl = fs, platform = process.platform } = {},
) {
  const noFollow = fsImpl.constants?.O_NOFOLLOW;
  if (!noFollow) {
    throw new Error(
      "repository product trust needs O_NOFOLLOW support on this platform",
    );
  }
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      file,
      fsImpl.constants.O_RDONLY | noFollow | fsImpl.constants.O_NONBLOCK,
    );
    if (platform === "win32") {
      throw new Error(
        "repository product trust needs a native ownership verifier on this platform",
      );
    }
    assertSafeRegistryDirectory(path.dirname(file), fsImpl);
    const opened = fsImpl.fstatSync(descriptor);
    assertSafeRegistryFile(opened, "opened product trust registry");
    const after = fsImpl.lstatSync(file);
    if (!sameFile(opened, after)) {
      throw new Error("product trust registry changed while it was opened");
    }
    assertSafeRegistryFile(after, "product trust registry");
    return fsImpl.readFileSync(descriptor);
  } catch (error) {
    if (descriptor === undefined && error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      throw new Error("product trust registry must not be a symbolic link", {
        cause: error,
      });
    }
    if (
      error.message === "product trust registry changed while it was opened"
    ) {
      throw error;
    }
    throw new Error(`product trust registry cannot be read: ${error.message}`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function publicKeyFromSpki(encoded, label, { allowUnpadded = false } = {}) {
  const der = decodeBase64(encoded, label, false, allowUnpadded);
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (error) {
    throw new Error(
      `${label} is not a valid SPKI public key: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} is not an Ed25519 public key`);
  }
  const canonicalDer = key.export({ format: "der", type: "spki" });
  if (
    der.length !== canonicalDer.length ||
    !crypto.timingSafeEqual(der, canonicalDer)
  ) {
    throw new Error(`${label} is not canonical Ed25519 SPKI`);
  }
  return key;
}

function validateRepositoryIdentity(repository, repositoryId, label) {
  if (
    typeof repository !== "string" ||
    !/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository) ||
    !/^[1-9][0-9]*$/.test(repositoryId || "")
  ) {
    throw new Error(`${label} has a non-canonical repository identity`);
  }
}

function parseProductTrust(bytes) {
  let registry;
  try {
    registry = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(
      `product trust registry is not valid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (
    !exactKeys(registry, ["schemaVersion", "repositories"]) ||
    registry.schemaVersion !== 1 ||
    !Array.isArray(registry.repositories)
  ) {
    throw new Error("product trust registry has an invalid schema");
  }
  const repositoryIds = new Set();
  const repositories = new Set();
  const fingerprints = new Set();
  const entries = registry.repositories.map((entry) => {
    if (
      !exactKeys(entry, [
        "repository",
        "repositoryId",
        "producerPublicKey",
        "admissionPublicKey",
      ])
    ) {
      throw new Error("product trust registry entry has an invalid schema");
    }
    validateRepositoryIdentity(
      entry.repository,
      entry.repositoryId,
      "product trust registry entry",
    );
    if (
      repositoryIds.has(entry.repositoryId) ||
      repositories.has(entry.repository)
    ) {
      throw new Error("product trust registry repeats a repository identity");
    }
    repositoryIds.add(entry.repositoryId);
    repositories.add(entry.repository);
    const producer = publicKeyFromSpki(
      entry.producerPublicKey,
      "product trust producer key",
    );
    const admission = publicKeyFromSpki(
      entry.admissionPublicKey,
      "product trust admission key",
    );
    for (const key of [producer, admission]) {
      const fingerprint = sha256(key.export({ format: "der", type: "spki" }));
      if (fingerprints.has(fingerprint)) {
        throw new Error("product trust registry key fingerprint is reused");
      }
      fingerprints.add(fingerprint);
    }
    return { ...entry, producer, admission };
  });
  return { registry, entries };
}

function repositoryTrustKey(expected, purpose, options) {
  if (!PRODUCT_TRUST_PURPOSES.has(purpose)) {
    throw new Error(`unsupported product trust purpose '${purpose}'`);
  }
  validateRepositoryIdentity(
    expected?.repository,
    expected?.repositoryId,
    "expected product trust",
  );
  const trustFile = options.trustRoot || fixedTrustPath(options.platform);
  if (!trustFile) {
    throw new Error(
      `product evidence is unsupported on ${options.platform || process.platform}`,
    );
  }
  const bytes = readSafeRegistryFile(trustFile, options);
  if (bytes === null) return null;
  const { entries } = parseProductTrust(bytes);
  const entry = entries.find(
    (candidate) =>
      candidate.repositoryId === expected.repositoryId &&
      candidate.repository === expected.repository,
  );
  if (!entry) {
    throw new Error("expected repository has no trusted entry");
  }
  return entry[purpose];
}

function legacyTrustKey(
  purpose,
  {
    fsImpl = fs,
    platform = process.platform,
    legacyTrustRoots = LEGACY_TRUST_ROOTS,
  } = {},
) {
  const trustRoot = legacyTrustRoots[purpose]?.[platform];
  if (!trustRoot) {
    throw new Error(`product evidence is unsupported on ${platform}`);
  }
  let encoded;
  try {
    encoded = fsImpl.readFileSync(trustRoot, "utf8").trim();
  } catch (error) {
    throw new Error(
      `product evidence trust root cannot be read: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return publicKeyFromSpki(encoded, "product evidence trust root", {
    allowUnpadded: true,
  });
}

function trustKey(trustedPublicKey, expected, purpose, options = {}) {
  if (trustedPublicKey) return trustedPublicKey;
  const repositoryKey = repositoryTrustKey(expected, purpose, options);
  return repositoryKey || legacyTrustKey(purpose, options);
}

function trustedPublicKeyFingerprint(trustedPublicKey) {
  const der = trustKey(trustedPublicKey).export({
    format: "der",
    type: "spki",
  });
  return sha256(der);
}

function verifyAdmissionEnvelope(
  envelope,
  expected,
  { trustedPublicKey, trustRoot, fsImpl, platform, legacyTrustRoots } = {},
) {
  const key = trustKey(trustedPublicKey, expected, "admission", {
    trustRoot,
    fsImpl,
    platform,
    legacyTrustRoots,
  });
  if (!exactKeys(envelope, ["payload", "signature"])) {
    throw new Error("product admission envelope has unexpected fields");
  }
  const payload = envelope.payload;
  if (
    !exactKeys(payload, [
      "schemaVersion",
      "issuer",
      "repository",
      "repositoryId",
      "head",
      "requirementsDigest",
      "evidenceIndexSha256",
      "producerRunId",
      "sourceRunId",
      "keyFingerprint",
      "admittedAt",
    ]) ||
    payload.schemaVersion !== 1 ||
    payload.issuer !== "github-actions-product-evidence" ||
    payload.repository !== expected.repository ||
    payload.repositoryId !== expected.repositoryId ||
    payload.head !== expected.head ||
    payload.requirementsDigest !== expected.requirementsDigest ||
    payload.evidenceIndexSha256 !== expected.evidenceIndexSha256 ||
    !/^[1-9][0-9]*$/.test(payload.producerRunId || "") ||
    !/^[0-9a-f]{64}$/.test(payload.requirementsDigest || "") ||
    !/^[1-9][0-9]*$/.test(payload.sourceRunId || "") ||
    !/^[0-9a-f]{64}$/.test(payload.keyFingerprint || "") ||
    !nonEmptyString(payload.admittedAt) ||
    Number.isNaN(Date.parse(payload.admittedAt))
  ) {
    throw new Error(
      "product admission has the wrong identity or malformed fields",
    );
  }
  if (payload.keyFingerprint !== trustedPublicKeyFingerprint(key)) {
    throw new Error(
      "product admission was made with a rotated or untrusted key",
    );
  }
  const signature = decodeBase64(
    envelope.signature,
    "product admission signature",
    true,
  );
  if (
    !crypto.verify(null, Buffer.from(canonicalJson(payload)), key, signature)
  ) {
    throw new Error("product admission signature is invalid");
  }
  return payload;
}

function payloadKeys(kind, expected) {
  const keys = [
    "schemaVersion",
    "issuer",
    "repository",
    "repositoryId",
    "head",
    "requirementsDigest",
    "kind",
    "observedAt",
    "evidenceSource",
    "result",
    "environment",
    "provenance",
    "artifact",
  ];
  if (kind === "behavioralTests") keys.push("command");
  if (
    ["deploymentReceipt", "hostedJourney", "realUserEvidence"].includes(kind) ||
    expected.deploymentIdentity
  ) {
    keys.push("deploymentIdentity");
  }
  if (kind === "hostedJourney") keys.push("url");
  return keys;
}

function validateCommonPayload(payload, expected) {
  if (
    payload.schemaVersion !== 2 ||
    payload.kind !== expected.kind ||
    payload.repository !== expected.repository ||
    payload.repositoryId !== expected.repositoryId ||
    payload.head !== expected.head ||
    payload.requirementsDigest !== expected.requirementsDigest
  ) {
    throw new Error(
      `${expected.kind} receipt has the wrong schema, kind, repository identity, head, or requirements`,
    );
  }
  if (
    !/^[0-9a-f]{40}$/.test(payload.head || "") ||
    !/^[0-9a-f]{64}$/.test(payload.requirementsDigest || "") ||
    !/^[^/]+\/[^/]+$/.test(payload.repository || "") ||
    !/^[1-9][0-9]*$/.test(payload.repositoryId || "")
  ) {
    throw new Error(`${expected.kind} receipt has malformed identity fields`);
  }
  validateObservation(payload, expected);
}

function validateObservation(payload, expected) {
  if (!nonEmptyString(payload.issuer)) {
    throw new Error(`${expected.kind} receipt is missing issuer`);
  }
  if (
    !nonEmptyString(payload.evidenceSource) ||
    !nonEmptyString(payload.environment) ||
    payload.result !== "passed" ||
    !nonEmptyString(payload.observedAt) ||
    Number.isNaN(Date.parse(payload.observedAt))
  ) {
    throw new Error(
      `${expected.kind} receipt has invalid time, source, environment, or result`,
    );
  }
}

function validateProvenance(payload, expected) {
  if (
    !exactKeys(payload.provenance, [
      "executionOwner",
      "runId",
      "runnerIsolation",
    ]) ||
    payload.provenance.executionOwner !== "issuer" ||
    payload.provenance.runnerIsolation !== "fresh-protected" ||
    !nonEmptyString(payload.provenance.runId)
  ) {
    throw new Error(`${expected.kind} receipt has invalid trusted provenance`);
  }
}

function validateExpectedBindings(payload, expected) {
  if (expected.environment && payload.environment !== expected.environment) {
    throw new Error(`${expected.kind} receipt has the wrong environment`);
  }
  if (
    expected.deploymentIdentity &&
    payload.deploymentIdentity !== expected.deploymentIdentity
  ) {
    throw new Error(
      `${expected.kind} receipt has the wrong deployment identity`,
    );
  }
}

function validateKindFields(payload, expected) {
  if (expected.kind === "behavioralTests" && !nonEmptyString(payload.command)) {
    throw new Error("behavioralTests receipt is missing command");
  }
  if (
    ["deploymentReceipt", "hostedJourney", "realUserEvidence"].includes(
      expected.kind,
    ) &&
    !nonEmptyString(payload.deploymentIdentity)
  ) {
    throw new Error(`${expected.kind} receipt is missing deploymentIdentity`);
  }
  if (expected.kind === "hostedJourney") {
    try {
      const url = new URL(payload.url);
      if (url.protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      throw new Error("hostedJourney receipt needs an HTTPS URL");
    }
  }
}

function validateArtifact(payload, expected) {
  if (
    !exactKeys(payload.artifact, ["path", "sha256"]) ||
    !nonEmptyString(payload.artifact.path) ||
    !/^[a-f0-9]{64}$/.test(payload.artifact.sha256 || "")
  ) {
    throw new Error(`${expected.kind} receipt has an invalid artifact binding`);
  }
}

function validatePayload(payload, expected) {
  if (!RECEIPT_KINDS.has(expected.kind)) {
    throw new Error(`unsupported product evidence kind '${expected.kind}'`);
  }
  if (!exactKeys(payload, payloadKeys(expected.kind, expected))) {
    throw new Error(
      `${expected.kind} receipt has unexpected or missing fields`,
    );
  }
  validateCommonPayload(payload, expected);
  validateExpectedBindings(payload, expected);
  validateKindFields(payload, expected);
  validateProvenance(payload, expected);
  validateArtifact(payload, expected);
}

function verifyReceipt(
  reference,
  expected,
  {
    evidencePath,
    trustedPublicKey,
    trustRoot,
    fsImpl,
    platform,
    legacyTrustRoots,
  } = {},
) {
  if (
    !exactKeys(reference, ["receipt", "sha256"]) ||
    !nonEmptyString(reference.receipt) ||
    !/^[a-f0-9]{64}$/.test(reference.sha256 || "")
  ) {
    throw new Error(`${expected.kind} needs receipt and sha256`);
  }
  const key = trustKey(trustedPublicKey, expected, "producer", {
    trustRoot,
    fsImpl,
    platform,
    legacyTrustRoots,
  });
  const evidenceRoot = path.dirname(path.resolve(evidencePath || ""));
  const receipt = containedRealFile(
    evidenceRoot,
    reference.receipt,
    `${expected.kind} receipt`,
  );
  const body = fs.readFileSync(receipt);
  if (sha256(body) !== reference.sha256) {
    throw new Error(`${expected.kind} receipt digest does not match`);
  }
  let envelope;
  try {
    envelope = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${expected.kind} receipt is not valid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (!exactKeys(envelope, ["payload", "signature"])) {
    throw new Error(`${expected.kind} receipt envelope has unexpected fields`);
  }
  if (!nonEmptyString(envelope.signature)) {
    throw new Error(`${expected.kind} receipt is unsigned`);
  }
  validatePayload(envelope.payload, expected);
  const signature = decodeBase64(
    envelope.signature,
    `${expected.kind} receipt signature`,
    true,
  );
  if (
    !crypto.verify(
      null,
      Buffer.from(canonicalJson(envelope.payload)),
      key,
      signature,
    )
  ) {
    throw new Error(`${expected.kind} receipt signature is invalid`);
  }
  const artifact = containedRealFile(
    evidenceRoot,
    envelope.payload.artifact.path,
    `${expected.kind} artifact`,
  );
  if (sha256(fs.readFileSync(artifact)) !== envelope.payload.artifact.sha256) {
    throw new Error(`${expected.kind} artifact digest does not match`);
  }
  return envelope.payload;
}

module.exports = {
  canonicalJson,
  fixedTrustPath,
  parseProductTrust,
  sha256,
  trustedPublicKeyFingerprint,
  verifyAdmissionEnvelope,
  verifyReceipt,
};
