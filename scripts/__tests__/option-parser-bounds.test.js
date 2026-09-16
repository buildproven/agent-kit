import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(import.meta.dirname, "..");

// `shift 2` with a single remaining positional FAILS and shifts nothing, so a
// `while [ "$#" -gt 0 ]` option loop re-reads the same flag forever. Proof:
//
//     set -u; set -- --manifest; shift 2; echo $#    ->    1
//
// Under `set -u` nothing errors either: `${2:-}` supplies a default and the
// failing shift is the last command in its `case` arm. The result is an
// infinite loop, not a crash — the script hangs until something kills it.
//
// This was live in 20 of 27 scripts, including the merge-critical path
// (quality-stamp-and-merge.sh, quality-authorize-merge.sh). BUI-844 tracked it
// in 2. These tests are discovery-driven so a newly added parser cannot
// quietly reintroduce it.

function shellScripts() {
  return readdirSync(SCRIPTS)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => ({ name, full: path.join(SCRIPTS, name) }));
}

/**
 * EVERY flag that genuinely CONSUMES a value.
 *
 * Only `shift 2` arms qualify. A boolean flag such as `--dry-run` or
 * `--json` uses a plain `shift`, legitimately takes no value, and exits 0 —
 * testing it for a non-zero exit asserts the opposite of correct behaviour.
 * The match runs from a flag to its own arm terminator (`;;`), so a boolean
 * arm can never borrow the `shift 2` of a later one.
 *
 * This returns all of them, not just the first. An earlier version tested one
 * flag per script and the cross-model review caught it: 16 scripts take more
 * than one value flag, and provider-run.sh takes twelve. Testing `--provider`
 * proved nothing about `--fallback` or `--prompt-file`, each of which could
 * still hang. A guard that covers one arm out of twelve is not coverage.
 */
function valueFlags(source) {
  const flags = [];
  const arms = source.matchAll(/(--[a-z][a-z0-9-]*)\)([\s\S]*?);;/g);
  for (const [, flag, body] of arms) {
    if (/\bshift 2\b/.test(body) && !flags.includes(flag)) flags.push(flag);
  }
  return flags;
}

const withParsers = shellScripts()
  .map((entry) => ({ ...entry, source: readFileSync(entry.full, "utf8") }))
  .filter((entry) => entry.source.includes("shift 2"))
  .flatMap((entry) =>
    valueFlags(entry.source).map((flag) => ({ ...entry, flag })),
  );

describe("option parsers are bounded", () => {
  it("finds the scripts that take flag values", () => {
    // Guards the discovery itself: if this drops the suite below becomes
    // vacuously green, which is the failure mode that let this ship. The
    // count is every value-consuming ARM, not every script, so it is well
    // above the script count.
    expect(withParsers.length).toBeGreaterThan(40);
  });

  it.each(withParsers.map((e) => [e.name, e.flag, e.full]))(
    "%s exits promptly when %s has no value",
    (_name, flag, full) => {
      const result = spawnSync("bash", [full, flag], {
        encoding: "utf8",
        input: "",
        timeout: 5000,
        killSignal: "SIGKILL",
      });

      // A hang surfaces as ETIMEDOUT or a kill signal with null status.
      expect(result.error?.code).not.toBe("ETIMEDOUT");
      expect(result.signal).toBeNull();
      expect(result.status).not.toBeNull();

      // It must refuse, not silently accept an empty value.
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`.trim()).not.toBe("");
    },
  );

  it("leaves no unguarded `${2:-}` + `shift 2` arm anywhere", () => {
    const offenders = shellScripts()
      .map((entry) => ({
        name: entry.name,
        hits: readFileSync(entry.full, "utf8")
          .split("\n")
          .filter((line) => line.includes("shift 2") && line.includes("${2:-}"))
          .length,
      }))
      .filter((entry) => entry.hits > 0);

    expect(offenders).toEqual([]);
  });
});
