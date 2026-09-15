import { describe, expect, it } from "vitest";
import adapter from "../provider-usage-adapter.js";

const now = Date.parse("2026-09-09T10:00:00Z");
function read(provider, change = (value) => value) {
  const record = change({
    provider,
    usage: {
      updatedAt: new Date(now).toISOString(),
      primary: { usedPercent: 12.5 },
      secondary: { usedPercent: 71 },
    },
  });
  return adapter.readProviderUsage(provider, {
    now,
    run(command, args) {
      expect(command).toBe("codexbar");
      expect(args).toContain(provider);
      return { status: 0, stdout: JSON.stringify([record]) };
    },
  });
}

describe("portable provider usage", () => {
  it.each(["claude", "codex"])(
    "reads fresh %s windows and discards private data",
    (provider) => {
      expect(
        read(provider, (record) => ({
          ...record,
          account: "private-account",
          usage: {
            ...record.usage,
            identity: { email: "private@example.test" },
          },
        })),
      ).toEqual({ provider, windows: { primary: 12.5, secondary: 71 } });
    },
  );
  it.each([null, "0", false, -1, 101])(
    "refuses invalid capacity %s",
    (value) => {
      expect(() =>
        read("codex", (record) => {
          record.usage.primary.usedPercent = value;
          return record;
        }),
      ).toThrow("invalid");
    },
  );
  it.each([now - 300001, now + 30001, NaN])(
    "refuses stale or invalid timestamps %s",
    (at) => {
      expect(() =>
        read("claude", (record) => {
          record.usage.updatedAt = Number.isFinite(at)
            ? new Date(at).toISOString()
            : "invalid";
          return record;
        }),
      ).toThrow("evidence");
    },
  );
  it("refuses provider substitution", () => {
    expect(() =>
      read("claude", (record) => ({ ...record, provider: "codex" })),
    ).toThrow("mismatched");
  });
  it("fails with an actionable installation error", () => {
    expect(() =>
      adapter.readProviderUsage("codex", {
        run: () => ({ status: null, error: new Error("ENOENT") }),
      }),
    ).toThrow("install CodexBar");
  });
});
