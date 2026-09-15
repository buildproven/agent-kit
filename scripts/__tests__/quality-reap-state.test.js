import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const REAP = path.join(ROOT, "scripts", "quality-reap-state.js");

const DAY_MS = 24 * 60 * 60 * 1000;

function stateRoot() {
  const base = makeTempDir("quality-reap-");
  const root = path.join(base, "bs-quality");
  mkdirSync(root, { recursive: true });
  return root;
}

// Campaign roots live at <repoKey>/pr-<n>/<baseSha>/<invocationId>.
function campaign(root, id, { manifest, ageDays = 0 } = {}) {
  const directory = path.join(root, "repo0", "pr-1", "basesha", id);
  mkdirSync(directory, { recursive: true });
  if (manifest) {
    writeFileSync(
      path.join(directory, "invocation.json"),
      JSON.stringify(manifest),
    );
  }
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(directory, when, when);
  }
  return directory;
}

function reap(root, extra = []) {
  return execFileSync("node", [REAP, "--root", root, ...extra], {
    encoding: "utf8",
  });
}

function terminalManifest(ageDays) {
  const when = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  return {
    terminalState: { state: "blocked", recordedAt: when },
    governor: { lastActivityAt: when },
  };
}

describe("quality state reaper", () => {
  it("reaps a terminal campaign that is past the retention window", () => {
    const root = stateRoot();
    const directory = campaign(root, "old-terminal", {
      manifest: terminalManifest(10),
    });

    expect(reap(root)).toContain("would reap 1 of 1");
    expect(existsSync(directory)).toBe(true);

    expect(reap(root, ["--apply"])).toContain("reaped 1 of 1");
    expect(existsSync(directory)).toBe(false);
  });

  it("keeps a resumable campaign no matter how old it is", () => {
    // No terminal state means the campaign can still be resumed, and its
    // evidence is the audit trail. Age must not override that.
    const root = stateRoot();
    const when = new Date(Date.now() - 400 * DAY_MS).toISOString();
    const directory = campaign(root, "ancient-unfinished", {
      manifest: { governor: { lastActivityAt: when } },
      ageDays: 400,
    });

    const output = reap(root, ["--apply"]);
    expect(output).toContain("reaped 0 of 1");
    expect(output).toContain("not-terminal");
    expect(existsSync(directory)).toBe(true);
  });

  it("keeps a terminal campaign inside the retention window", () => {
    const root = stateRoot();
    const directory = campaign(root, "fresh-terminal", {
      manifest: terminalManifest(1),
    });

    expect(reap(root, ["--apply"])).toContain("within-retention");
    expect(existsSync(directory)).toBe(true);
  });

  it("reaps an aged orphan that never wrote a manifest", () => {
    const root = stateRoot();
    const directory = campaign(root, "orphan", { ageDays: 30 });

    expect(reap(root, ["--apply"])).toContain("reaped 1 of 1");
    expect(existsSync(directory)).toBe(false);
  });

  it("keeps a recent orphan, which may be a campaign still starting up", () => {
    const root = stateRoot();
    const directory = campaign(root, "new-orphan");

    expect(reap(root, ["--apply"])).toContain("reaped 0 of 1");
    expect(existsSync(directory)).toBe(true);
  });

  it("keeps a campaign whose manifest cannot be parsed", () => {
    const root = stateRoot();
    const directory = campaign(root, "corrupt", { ageDays: 30 });
    writeFileSync(path.join(directory, "invocation.json"), "{ not json");

    const output = reap(root, ["--apply"]);
    expect(output).toContain("unreadable-manifest");
    expect(existsSync(directory)).toBe(true);
  });

  it("refuses a root that is not a bs-quality state directory", () => {
    // Guards against a mistyped --root turning this into a recursive delete.
    const elsewhere = makeTempDir("quality-reap-elsewhere-");
    writeFileSync(path.join(elsewhere, "precious.txt"), "keep me");

    expect(() => reap(elsewhere, ["--apply"])).toThrow();
    expect(existsSync(path.join(elsewhere, "precious.txt"))).toBe(true);
  });

  it("rejects a non-positive retention window", () => {
    const root = stateRoot();
    expect(() => reap(root, ["--retention-days", "0"])).toThrow();
    expect(() => reap(root, ["--retention-days", "notanumber"])).toThrow();
  });
});
