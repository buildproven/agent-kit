const { ENTRYPOINT, invocation } = require("../harness-container-executor.js");

describe("harness container executor", () => {
  it("pins all isolation limits outside candidate control", () => {
    const argv = invocation({
      image: `example.test/harness@sha256:${"a".repeat(64)}`,
      candidate: "/candidate",
      toolchain: "/toolchain",
      command: ["node", "x.js"],
    });
    expect(argv).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "3g",
        "--pids-limit",
        "128",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "65534:65534",
      ]),
    );
    expect(argv.join(" ")).toContain("dst=/source,readonly");
    expect(argv.join(" ")).toContain("dst=/toolchain,readonly");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--tmpfs",
        "/candidate:rw,exec,nosuid,nodev,size=1g",
        "/bin/sh",
        "-ceu",
        ENTRYPOINT,
      ]),
    );
  });
  it("rejects unpinned images and relative mounts", () => {
    expect(() =>
      invocation({
        image: "node:latest",
        candidate: "/c",
        toolchain: "/t",
        command: ["true"],
      }),
    ).toThrow("pinned");
    expect(() =>
      invocation({
        image: `sha256:${"a".repeat(64)}`,
        candidate: "/c",
        toolchain: "/t",
        command: ["true"],
      }),
    ).toThrow("pinned image reference");
    expect(() =>
      invocation({
        image: `example.test/harness@sha256:${"a".repeat(64)}`,
        candidate: "c",
        toolchain: "/t",
        command: ["true"],
      }),
    ).toThrow("absolute");
  });
});
