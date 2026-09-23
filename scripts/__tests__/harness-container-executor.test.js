const { ENTRYPOINT, invocation } = require("../harness-container-executor.js");

describe("harness container executor", () => {
  it("pins all isolation limits outside candidate control", () => {
    const argv = invocation({
      image: `example.test/harness@sha256:${"a".repeat(64)}`,
      candidate: "/candidate",
      toolchain: "/toolchain",
      containerName: "harness-certification-deadbeef",
      command: ["node", "x.js"],
    });
    expect(argv).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--name",
        "harness-certification-deadbeef",
        "--label",
        "buildproven.harness-certification=harness-certification-deadbeef",
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
    expect(ENTRYPOINT).toContain(
      "ln -s /toolchain/node_modules /candidate/node_modules",
    );
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
        containerName: "harness-certification-deadbeef",
        command: ["true"],
      }),
    ).toThrow("pinned");
    expect(() =>
      invocation({
        image: `sha256:${"a".repeat(64)}`,
        candidate: "/c",
        toolchain: "/t",
        containerName: "harness-certification-deadbeef",
        command: ["true"],
      }),
    ).toThrow("pinned image reference");
    expect(() =>
      invocation({
        image: `example.test/harness@sha256:${"a".repeat(64)}`,
        candidate: "c",
        toolchain: "/t",
        containerName: "harness-certification-deadbeef",
        command: ["true"],
      }),
    ).toThrow("absolute");
  });
});
