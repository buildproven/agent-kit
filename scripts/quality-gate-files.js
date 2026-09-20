"use strict";

const { git } = require("./quality-git-identity.js");

function committedFiles(root, head) {
  try {
    return git(root, ["ls-tree", "-r", "--name-only", head])
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function changedFiles(root, baseSha, head) {
  if (!baseSha) return null;
  try {
    return git(root, [
      "diff",
      "-z",
      "--name-only",
      "--no-renames",
      `${baseSha}..${head}`,
    ])
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

function diffTouchesPython(root, baseSha, head) {
  const changed = changedFiles(root, baseSha, head);
  return (
    changed === null ||
    changed.some((file) => file.endsWith(".py") || file.endsWith(".pyi"))
  );
}

module.exports = { changedFiles, committedFiles, diffTouchesPython };
