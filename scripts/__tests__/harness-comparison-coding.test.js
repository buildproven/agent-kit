import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const corpus = JSON.parse(
  readFileSync(
    new URL("./fixtures/harness-comparison-coding.json", import.meta.url),
    "utf8",
  ),
);

// These tests execute only the committed, trusted control programs. They are
// oracle validation, not an agent runner or a safe launcher for model output.
function materialize(task, solved) {
  const root = makeTempDir(`comparison-${task.id}-`);
  for (const [file, contents] of Object.entries({
    ...task.files,
    ...(solved ? task.solution : {}),
  })) {
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

function snapshot(root, relative = "") {
  const entries = {};
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    const file = path.join(relative, name);
    const full = path.join(root, file);
    const fd = openSync(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      entries[file] = {
        mode: stat.mode,
        contents: stat.isFile() ? readFileSync(fd, "utf8") : null,
      };
      if (stat.isDirectory()) Object.assign(entries, snapshot(root, file));
    } finally {
      closeSync(fd);
    }
  }
  return entries;
}

function run(root, args, input = "") {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/bin:/bin", HOME: root },
  });
  assert.equal(result.error, undefined, "control execution must finish");
  assert.equal(result.signal, null, "control must not be killed");
  return result;
}

function verify(task, root) {
  const actual = snapshot(root);
  for (const file of new Set([
    ...Object.keys(task.files),
    ...Object.keys(actual),
  ])) {
    assert(actual[file]?.contents !== null, `expected regular file: ${file}`);
    if (actual[file]?.contents !== task.files[file]) {
      assert(
        task.permittedPaths.includes(file),
        `out-of-scope change: ${file}`,
      );
    }
  }
  for (const [file, contents] of Object.entries(task.exactFiles || {})) {
    assert.equal(readFileSync(path.join(root, file), "utf8"), contents);
  }
  if (task.diagnosis) {
    const diagnosis = JSON.parse(
      readFileSync(path.join(root, "diagnosis.json"), "utf8"),
    );
    assert.equal(diagnosis.defectReproduced, false);
    assert.deepEqual(diagnosis.cases, [
      { before: ["B", "A"], after: ["B", "A"], result: ["A", "B"] },
      { before: [], after: [], result: [] },
    ]);
    assert.equal(typeof diagnosis.reason, "string");
    assert(diagnosis.reason.trim().length > 0);
    const observed = run(root, [
      "-e",
      "const f=require('./names.cjs').sortedNames;console.log(JSON.stringify([['B','A'],[]].map(a=>{const before=[...a];const result=f(a);return {before,after:a,result}})));",
    ]);
    assert.equal(observed.status, 0);
    assert.deepEqual(JSON.parse(observed.stdout), diagnosis.cases);
  }
  for (const check of task.checks) {
    const before = snapshot(root);
    const result = run(root, ["cli.cjs", ...check.args], check.input);
    assert.equal(result.status, check.status ?? 0);
    assert.equal(result.stdout, check.stdout);
    assert.equal(result.stderr, check.stderr ?? "");
    if (check.unchanged) assert.deepEqual(snapshot(root), before);
    for (const [file, contents] of Object.entries(check.files || {})) {
      assert.equal(readFileSync(path.join(root, file), "utf8"), contents);
    }
  }
  if (task.regression) {
    assert.equal(run(root, [task.regression]).status, 0);
    const reverted = materialize(task, false);
    for (const [file, entry] of Object.entries(actual)) {
      writeFileSync(path.join(reverted, file), entry.contents);
    }
    // The candidate's regression must detect the original defect, not a missing
    // import or missing test file. Only the implementation file is reverted.
    writeFileSync(
      path.join(reverted, task.mutationPath),
      task.files[task.mutationPath],
    );
    const result = run(reverted, [task.regression]);
    assert.notEqual(
      result.status,
      0,
      "regression remained green with original code",
    );
    assert.match(result.stderr, /AssertionError/);
    if (task.preservationMutation) {
      writeFileSync(
        path.join(reverted, task.mutationPath),
        task.preservationMutation,
      );
      const preserved = run(reverted, [task.regression]);
      assert.notEqual(
        preserved.status,
        0,
        "existing regression coverage was removed",
      );
      assert.match(preserved.stderr, /AssertionError/);
    }
  }
}

describe("coding comparison oracle controls (not scored agent runs)", () => {
  it("refuses symlinked snapshot input without following the target", () => {
    const root = makeTempDir("comparison-symlink-");
    const outside = makeTempDir("comparison-outside-");
    writeFileSync(path.join(outside, "canary"), "synthetic only");
    symlinkSync(path.join(outside, "canary"), path.join(root, "input"));
    expect(() => snapshot(root)).toThrow();
  });
  it("T07: rejects removal of the existing boundary coverage", () => {
    const task = corpus.tasks.find((task) => task.id === "T07");
    const root = materialize(task, true);
    writeFileSync(
      path.join(root, "test.cjs"),
      "require('node:assert/strict').equal(require('./shipping.cjs')(50),0);\n",
    );
    expect(() => verify(task, root)).toThrow(
      /existing regression coverage was removed/,
    );
  });
  it("contains exactly the seven specified coding tasks", () => {
    expect(corpus.tasks.map((task) => task.id)).toEqual([
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T06",
      "T07",
    ]);
    expect(corpus.status).toBe("draft-not-frozen");
  });
  for (const task of corpus.tasks) {
    it(`${task.id}: accepts the known-correct control`, () => {
      verify(task, materialize(task, true));
    });
    it(`${task.id}: rejects the unfinished or known-incorrect control`, () => {
      expect(() => verify(task, materialize(task, false))).toThrow();
    });
    it(`${task.id}: rejects an out-of-scope file`, () => {
      const root = materialize(task, true);
      writeFileSync(path.join(root, "unexpected.txt"), "not permitted");
      expect(() => verify(task, root)).toThrow(/out-of-scope/);
    });
  }
  it("T02: detects an empty directory created by check-only", () => {
    const task = corpus.tasks.find((task) => task.id === "T02");
    const root = materialize(task, true);
    mkdirSync(path.join(root, "unexpected"));
    expect(() => verify(task, root)).toThrow(/regular file/);
  });
  it.each(["T01", "T07"])(
    "%s: rejects a vacuous submitted regression",
    (id) => {
      const task = corpus.tasks.find((task) => task.id === id);
      const root = materialize(task, true);
      writeFileSync(path.join(root, task.regression), "process.exit(0);\n");
      expect(() => verify(task, root)).toThrow(/regression remained green/);
    },
  );
});
