import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalJson,
  sha256,
  verifyAdmissionEnvelope,
  verifyReceipt,
} from "../product-evidence.js";
import { installProductTrust } from "../install-product-trust.js";

const head = "a".repeat(40);
const expected = (repository, repositoryId) => ({
  repository,
  repositoryId,
  head,
  requirementsDigest: "b".repeat(64),
  evidenceIndexSha256: "c".repeat(64),
});

function spki(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function withStat(stat, values) {
  return Object.assign(
    Object.create(Object.getPrototypeOf(stat)),
    stat,
    values,
  );
}

function rootOwnedFs(replace = {}) {
  const own = (stat) => withStat(stat, { uid: 0, mode: stat.mode & ~0o022 });
  return {
    ...fs,
    chownSync() {},
    statSync(file, ...args) {
      return own(fs.statSync(file, ...args));
    },
    lstatSync(file, ...args) {
      return own(fs.lstatSync(file, ...args));
    },
    fstatSync(descriptor, ...args) {
      return own(fs.fstatSync(descriptor, ...args));
    },
    ...replace,
  };
}

function registry(repositories) {
  return `${JSON.stringify({ schemaVersion: 1, repositories })}\n`;
}

function repositoryRow(repository, repositoryId, producer, admission) {
  return {
    repository,
    repositoryId,
    producerPublicKey: spki(producer),
    admissionPublicKey: spki(admission),
  };
}

function trustedRoot(value, fsImpl = rootOwnedFs()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "product-trust-"));
  const file = path.join(dir, "product-trust.json");
  fs.writeFileSync(file, value, { mode: 0o644 });
  return { dir, file, fsImpl };
}

function admission(privateKey, publicKey, identity) {
  const payload = {
    schemaVersion: 1,
    issuer: "github-actions-product-evidence",
    ...identity,
    producerRunId: "101",
    sourceRunId: "100",
    keyFingerprint: sha256(publicKey.export({ format: "der", type: "spki" })),
    admittedAt: "2026-09-11T00:00:00.000Z",
  };
  return {
    payload,
    signature: crypto
      .sign(null, Buffer.from(canonicalJson(payload)), privateKey)
      .toString("base64url"),
  };
}

function receipt(dir, privateKey, identity) {
  const artifact = path.join(dir, "behavioral.artifact.json");
  fs.writeFileSync(artifact, '{"passed":true}\n');
  const payload = {
    schemaVersion: 2,
    issuer: "buildproven-ci",
    repository: identity.repository,
    repositoryId: identity.repositoryId,
    head: identity.head,
    requirementsDigest: identity.requirementsDigest,
    kind: "behavioralTests",
    observedAt: "2026-09-11T00:00:00.000Z",
    evidenceSource: "protected",
    result: "passed",
    environment: "local",
    provenance: {
      executionOwner: "issuer",
      runId: "123",
      runnerIsolation: "fresh-protected",
    },
    artifact: {
      path: path.basename(artifact),
      sha256: sha256(fs.readFileSync(artifact)),
    },
    command: "npm test",
  };
  const envelope = {
    payload,
    signature: crypto
      .sign(null, Buffer.from(canonicalJson(payload)), privateKey)
      .toString("base64url"),
  };
  const file = path.join(dir, "behavioral.receipt.json");
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  return {
    receipt: path.basename(file),
    sha256: sha256(fs.readFileSync(file)),
  };
}

describe("repository-scoped product trust", () => {
  it("keeps repository trust tests mapped to every mutable trust implementation", () => {
    const policy = JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../.buildproven/test-impact.json",
        ),
        "utf8",
      ),
    );
    const test = "scripts/__tests__/repository-product-trust.test.js";
    const implementation = [
      "scripts/install-product-trust.js",
      "scripts/product-admission.js",
      "scripts/product-evidence.js",
    ];

    for (const source of implementation) {
      const commands = policy.mappings
        .filter(({ paths }) => paths.includes(source))
        .flatMap(({ commands: mappedCommands }) => mappedCommands);
      expect(
        commands.some(({ args }) => args.includes(test)),
        `${source} must select ${test}`,
      ).toBe(true);
    }
  });

  it("selects separate producer and admission keys for two trusted repositories", () => {
    const kit = {
      producer: crypto.generateKeyPairSync("ed25519"),
      admission: crypto.generateKeyPairSync("ed25519"),
    };
    const setup = {
      producer: crypto.generateKeyPairSync("ed25519"),
      admission: crypto.generateKeyPairSync("ed25519"),
    };
    const root = trustedRoot(
      registry([
        repositoryRow(
          "buildproven/claude-kit",
          "1175614110",
          kit.producer.publicKey,
          kit.admission.publicKey,
        ),
        repositoryRow(
          "buildproven/claude-setup",
          "1073180710",
          setup.producer.publicKey,
          setup.admission.publicKey,
        ),
      ]),
    );
    const kitExpected = expected("buildproven/claude-kit", "1175614110");
    const setupExpected = expected("buildproven/claude-setup", "1073180710");
    const evidenceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "product-evidence-"),
    );
    try {
      expect(
        verifyReceipt(
          receipt(evidenceDir, kit.producer.privateKey, kitExpected),
          { ...kitExpected, kind: "behavioralTests" },
          {
            evidencePath: path.join(evidenceDir, "index.json"),
            trustRoot: root.file,
            fsImpl: root.fsImpl,
          },
        ),
      ).toMatchObject({ repository: kitExpected.repository });
      expect(
        verifyAdmissionEnvelope(
          admission(
            setup.admission.privateKey,
            setup.admission.publicKey,
            setupExpected,
          ),
          setupExpected,
          { trustRoot: root.file, fsImpl: root.fsImpl },
        ),
      ).toMatchObject({ repository: setupExpected.repository });
      expect(() =>
        verifyAdmissionEnvelope(
          admission(
            kit.admission.privateKey,
            kit.admission.publicKey,
            setupExpected,
          ),
          setupExpected,
          { trustRoot: root.file, fsImpl: root.fsImpl },
        ),
      ).toThrow(/rotated or untrusted/);
      expect(() =>
        verifyAdmissionEnvelope(
          admission(
            kit.producer.privateKey,
            kit.producer.publicKey,
            kitExpected,
          ),
          kitExpected,
          { trustRoot: root.file, fsImpl: root.fsImpl },
        ),
      ).toThrow(/rotated or untrusted/);
    } finally {
      fs.rmSync(root.dir, { recursive: true, force: true });
      fs.rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["unknown repository", registry([]), /has no trusted entry/],
    ["malformed registry", "{", /not valid JSON/],
    ["duplicate fingerprint", null, /fingerprint is reused/],
  ])("fails closed for a present %s registry", (_name, value, error) => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const root = trustedRoot(
      value ??
        registry([
          repositoryRow(
            "buildproven/claude-kit",
            "1175614110",
            keys.publicKey,
            keys.publicKey,
          ),
        ]),
    );
    const identity = expected("buildproven/claude-kit", "1175614110");
    try {
      expect(() =>
        verifyAdmissionEnvelope(
          admission(keys.privateKey, keys.publicKey, identity),
          identity,
          { trustRoot: root.file, fsImpl: root.fsImpl },
        ),
      ).toThrow(error);
    } finally {
      fs.rmSync(root.dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-canonical encoded public key", () => {
    const producer = crypto.generateKeyPairSync("ed25519");
    const admissionKey = crypto.generateKeyPairSync("ed25519");
    const identity = expected("buildproven/claude-kit", "1175614110");
    const row = repositoryRow(
      identity.repository,
      identity.repositoryId,
      producer.publicKey,
      admissionKey.publicKey,
    );
    row.producerPublicKey = row.producerPublicKey.replace(/=+$/, "");
    const root = trustedRoot(registry([row]));
    try {
      expect(() =>
        verifyAdmissionEnvelope(
          admission(admissionKey.privateKey, admissionKey.publicKey, identity),
          identity,
          { trustRoot: root.file, fsImpl: root.fsImpl },
        ),
      ).toThrow(/canonical base64/);
    } finally {
      fs.rmSync(root.dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe ownership, symlinks, and replacement races", () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const identity = expected("buildproven/claude-kit", "1175614110");
    const value = registry([
      repositoryRow(
        identity.repository,
        identity.repositoryId,
        keys.publicKey,
        keys.publicKey,
      ),
    ]);
    const root = trustedRoot(value);
    const unsafe = rootOwnedFs({
      lstatSync(file, ...args) {
        const stat = fs.lstatSync(file, ...args);
        return withStat(stat, { uid: 501, mode: stat.mode | 0o020 });
      },
    });
    try {
      expect(() =>
        verifyAdmissionEnvelope(
          admission(keys.privateKey, keys.publicKey, identity),
          identity,
          { trustRoot: root.file, fsImpl: unsafe },
        ),
      ).toThrow(/root-owned|group or other writable/);
      const link = path.join(root.dir, "link.json");
      fs.symlinkSync(root.file, link);
      expect(() =>
        verifyAdmissionEnvelope(
          admission(keys.privateKey, keys.publicKey, identity),
          identity,
          { trustRoot: link, fsImpl: root.fsImpl },
        ),
      ).toThrow(/symbolic link/);
      const raced = rootOwnedFs({
        fstatSync(descriptor) {
          const stat = fs.fstatSync(descriptor);
          return withStat(stat, {
            ino: stat.ino + 1,
            uid: 0,
            mode: stat.mode & ~0o022,
          });
        },
      });
      expect(() =>
        verifyAdmissionEnvelope(
          admission(keys.privateKey, keys.publicKey, identity),
          identity,
          { trustRoot: root.file, fsImpl: raced },
        ),
      ).toThrow(/changed while it was opened/);
    } finally {
      fs.rmSync(root.dir, { recursive: true, force: true });
    }
  });

  it("preserves injected-key legacy verification when no registry exists", () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const identity = expected("buildproven/claude-kit", "1175614110");
    expect(
      verifyAdmissionEnvelope(
        admission(keys.privateKey, keys.publicKey, identity),
        identity,
        { trustedPublicKey: keys.publicKey },
      ),
    ).toMatchObject({ repository: identity.repository });
  });

  it("preserves unpadded legacy singleton keys when no registry exists", () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const identity = expected("buildproven/claude-kit", "1175614110");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-trust-"));
    const trustRoot = path.join(dir, "product-admission-public-key");
    fs.writeFileSync(
      trustRoot,
      keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64")
        .replace(/=+$/, ""),
    );
    try {
      expect(
        verifyAdmissionEnvelope(
          admission(keys.privateKey, keys.publicKey, identity),
          identity,
          {
            platform: "fixture",
            trustRoot: path.join(dir, "absent-product-trust.json"),
            legacyTrustRoots: { admission: { fixture: trustRoot } },
          },
        ),
      ).toMatchObject({ repository: identity.repository });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("privileged product-trust installation", () => {
  it("checks the reviewed bytes after elevation, writes atomically, and is idempotent", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "product-trust-install-"),
    );
    const staging = path.join(dir, "reviewed.json");
    const target = path.join(dir, "product-trust.json");
    const keys = crypto.generateKeyPairSync("ed25519");
    const value = registry([
      repositoryRow(
        "buildproven/claude-kit",
        "1175614110",
        keys.publicKey,
        crypto.generateKeyPairSync("ed25519").publicKey,
      ),
    ]);
    fs.writeFileSync(staging, value);
    const fsImpl = rootOwnedFs();
    try {
      expect(
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(value),
          fsImpl,
        }),
      ).toMatchObject({ installed: true });
      expect(fs.readFileSync(target, "utf8")).toBe(value);
      expect(
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(value),
          fsImpl,
        }),
      ).toMatchObject({ installed: false, idempotent: true });
      fs.writeFileSync(staging, `${value} `);
      expect(() =>
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(value),
          fsImpl,
        }),
      ).toThrow(/digest does not match/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses key replacement and unsafe target paths", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "product-trust-install-"),
    );
    const staging = path.join(dir, "reviewed.json");
    const target = path.join(dir, "product-trust.json");
    const first = crypto.generateKeyPairSync("ed25519");
    const second = crypto.generateKeyPairSync("ed25519");
    const value = registry([
      repositoryRow(
        "buildproven/claude-kit",
        "1175614110",
        first.publicKey,
        crypto.generateKeyPairSync("ed25519").publicKey,
      ),
    ]);
    const replacement = registry([
      repositoryRow(
        "buildproven/claude-kit",
        "1175614110",
        second.publicKey,
        crypto.generateKeyPairSync("ed25519").publicKey,
      ),
    ]);
    const fsImpl = rootOwnedFs();
    try {
      fs.writeFileSync(staging, value);
      installProductTrust({
        stagingFile: staging,
        targetFile: target,
        expectedSHA256: sha256(value),
        fsImpl,
      });
      fs.writeFileSync(staging, replacement);
      expect(() =>
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(replacement),
          fsImpl,
        }),
      ).toThrow(/rotation decision/);
      fs.writeFileSync(staging, value);
      fs.unlinkSync(target);
      fs.symlinkSync(staging, target);
      expect(() =>
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(value),
          fsImpl,
        }),
      ).toThrow(/symbolic link/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO trust target without waiting for a writer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "product-trust-fifo-"));
    const staging = path.join(dir, "reviewed.json");
    const target = path.join(dir, "product-trust.json");
    const keys = crypto.generateKeyPairSync("ed25519");
    const value = registry([
      repositoryRow(
        "buildproven/claude-kit",
        "1175614110",
        keys.publicKey,
        crypto.generateKeyPairSync("ed25519").publicKey,
      ),
    ]);
    fs.writeFileSync(staging, value);
    const made = spawnSync("mkfifo", [target], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    let opened = false;
    const fsImpl = rootOwnedFs({
      lstatSync(file, ...args) {
        // The pathname previously named a regular file. The attacker replaces
        // it with a FIFO immediately before the real open.
        const stat = fs.lstatSync(
          file === target && !opened ? staging : file,
          ...args,
        );
        return withStat(stat, { uid: 0, mode: stat.mode & ~0o022 });
      },
      openSync(file, flags, ...args) {
        if (file === target) {
          if (!(flags & fs.constants.O_NONBLOCK)) {
            throw new Error("trust target open would wait for a FIFO writer");
          }
          opened = true;
        }
        return fs.openSync(file, flags, ...args);
      },
    });
    try {
      expect(() =>
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(value),
          fsImpl,
        }),
      ).toThrow(/regular file/);
      opened = false;
      const identity = expected("buildproven/claude-kit", "1175614110");
      expect(() =>
        verifyAdmissionEnvelope(
          admission(keys.privateKey, keys.publicKey, identity),
          identity,
          { trustRoot: target, fsImpl },
        ),
      ).toThrow(/regular file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses removal of a previously trusted repository", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "product-trust-install-"),
    );
    const staging = path.join(dir, "reviewed.json");
    const target = path.join(dir, "product-trust.json");
    const first = crypto.generateKeyPairSync("ed25519");
    const second = crypto.generateKeyPairSync("ed25519");
    const firstAdmission = crypto.generateKeyPairSync("ed25519");
    const secondAdmission = crypto.generateKeyPairSync("ed25519");
    const full = registry([
      repositoryRow(
        "buildproven/claude-kit",
        "1175614110",
        first.publicKey,
        firstAdmission.publicKey,
      ),
      repositoryRow(
        "buildproven/claude-setup",
        "1073180710",
        second.publicKey,
        secondAdmission.publicKey,
      ),
    ]);
    const reduced = registry([
      repositoryRow(
        "buildproven/claude-kit",
        "1175614110",
        first.publicKey,
        firstAdmission.publicKey,
      ),
    ]);
    const fsImpl = rootOwnedFs();
    try {
      fs.writeFileSync(staging, full);
      installProductTrust({
        stagingFile: staging,
        targetFile: target,
        expectedSHA256: sha256(full),
        fsImpl,
      });
      fs.writeFileSync(staging, reduced);
      expect(() =>
        installProductTrust({
          stagingFile: staging,
          targetFile: target,
          expectedSHA256: sha256(reduced),
          fsImpl,
        }),
      ).toThrow(/removal.*rotation decision/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
