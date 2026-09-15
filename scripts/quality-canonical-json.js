#!/usr/bin/env node
"use strict";

// JSON helpers shared across the quality runtime.
//
// canonicalJson sorts object keys recursively so a value hashes and compares
// identically regardless of insertion order. Signed evidence depends on that:
// two runs that produce the same content must produce the same digest.
//
// Extracted from quality-invocation.js because the git-identity module needs
// it too, and duplicating a hashing primitive is how two callers quietly stop
// agreeing on what a digest means (BUI-905).

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

module.exports = { parseJson, canonicalJson };
