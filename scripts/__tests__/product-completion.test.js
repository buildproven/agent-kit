import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signPayload,
  verify as verifySignature,
} from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import {
  validate,
  verifyClaim,
  next,
  productionCodeChange,
  classifyChange,
} from "../product-completion.js";
import { canonicalJson } from "../product-evidence.js";

const HEAD = "a".repeat(40);
const REPOSITORY = "buildproven/towns";
const REPOSITORY_ID = "123456";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function files({ phase = "implementation", checked = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "product-completion-"));
  const prd = path.join(dir, "towns-prd.md");
  const tasks = path.join(dir, "towns-tasks.md");
  writeFileSync(
    prd,
    "# PRD\n\n## User stories\n\n- As a buyer, I compare towns.\n",
  );
  writeFileSync(
    tasks,
    `- [${checked ? "x" : " "}] 2.0 Find similar towns\n  - Phase: ${phase}\n  - Delivers: A user receives ten explainable alternatives.\n  - Evidence: browser journey + API behavior test\n`,
  );
  return { dir, prd, tasks };
}

function signedReceipt(dir, kind, fields, privateKey, requirementsDigest) {
  const artifact = path.join(dir, `${kind}.artifact.json`);
  writeFileSync(artifact, `${JSON.stringify({ kind, passed: true })}\n`);
  const payload = {
    schemaVersion: 2,
    issuer: "buildproven-ci",
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    head: HEAD,
    requirementsDigest,
    kind,
    observedAt: "2026-08-29T12:00:00Z",
    evidenceSource: "quality-evidence-producer-v1",
    result: "passed",
    environment: "local",
    provenance: {
      executionOwner: "issuer",
      runId: `protected-${kind}`,
      runnerIsolation: "fresh-protected",
    },
    artifact: {
      path: path.basename(artifact),
      sha256: digest(readFileSync(artifact)),
    },
    ...fields,
  };
  const envelope = {
    payload,
    signature: signPayload(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64url"),
  };
  const file = path.join(dir, `${kind}.json`);
  writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  return {
    reference: {
      receipt: path.basename(file),
      sha256: digest(readFileSync(file)),
    },
    artifact,
    file,
  };
}

function evidence(
  dir,
  requirementsDigest,
  { hosted = false, validated = false } = {},
) {
  dir = mkdtempSync(path.join(dir, "evidence-"));
  const keys = generateKeyPairSync("ed25519");
  const deploymentBinding =
    hosted || validated
      ? { environment: "production", deploymentIdentity: "deploy-123" }
      : {};
  const behavioralTests = signedReceipt(
    dir,
    "behavioralTests",
    { command: "npm test -- towns", ...deploymentBinding },
    keys.privateKey,
    requirementsDigest,
  );
  const acceptanceEvidence = signedReceipt(
    dir,
    "acceptanceEvidence",
    deploymentBinding,
    keys.privateKey,
    requirementsDigest,
  );
  const value = {
    schemaVersion: 2,
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    behavioralTests: behavioralTests.reference,
    acceptanceEvidence: acceptanceEvidence.reference,
  };
  const receipts = { behavioralTests, acceptanceEvidence };
  if (hosted || validated) {
    value.expectedEnvironment = "production";
    value.deploymentIdentity = "deploy-123";
    receipts.deploymentReceipt = signedReceipt(
      dir,
      "deploymentReceipt",
      { environment: "production", deploymentIdentity: "deploy-123" },
      keys.privateKey,
      requirementsDigest,
    );
    receipts.hostedJourney = signedReceipt(
      dir,
      "hostedJourney",
      {
        environment: "production",
        deploymentIdentity: "deploy-123",
        url: "https://example.com/towns",
      },
      keys.privateKey,
      requirementsDigest,
    );
    value.deploymentReceipt = receipts.deploymentReceipt.reference;
    value.hostedJourney = receipts.hostedJourney.reference;
  }
  if (validated) {
    receipts.realUserEvidence = signedReceipt(
      dir,
      "realUserEvidence",
      { environment: "production", deploymentIdentity: "deploy-123" },
      keys.privateKey,
      requirementsDigest,
    );
    value.realUserEvidence = receipts.realUserEvidence.reference;
  }
  const file = path.join(dir, "evidence.json");
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  return { value, file, keys, receipts };
}

function claim(result, level, local, options = {}) {
  return verifyClaim(result, level, ["src/towns.js"], local.value, {
    head: HEAD,
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    evidencePath: local.file,
    trustedPublicKey: local.keys.publicKey,
    ...options,
  });
}

function rewriteReceipt(local, name, mutate) {
  const receipt = local.receipts[name];
  const envelope = JSON.parse(readFileSync(receipt.file, "utf8"));
  mutate(envelope.payload);
  envelope.signature = signPayload(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    local.keys.privateKey,
  ).toString("base64url");
  writeFileSync(receipt.file, `${JSON.stringify(envelope)}\n`);
  local.value[name].sha256 = digest(readFileSync(receipt.file));
}

describe("product completion", () => {
  it("requires a phase and an implementation task for user-facing work", () => {
    const { dir, prd, tasks } = files({ phase: "contract", checked: true });
    const result = validate(prd, tasks);
    const local = evidence(dir, result.requirementsDigest);
    expect(result.valid).toBe(false);
    expect(claim(result, "local-product", local).valid).toBe(false);
    expect(next(result).status).toBe("UNVERIFIED");
  });

  it("matches the published schemas and RFC 8785 conformance vector", () => {
    const schemaRoot = path.resolve(import.meta.dirname, "..", "schemas");
    const receiptSchema = JSON.parse(
      readFileSync(
        path.join(schemaRoot, "product-evidence-receipt-v2.schema.json"),
        "utf8",
      ),
    );
    const indexSchema = JSON.parse(
      readFileSync(
        path.join(schemaRoot, "product-delivery-evidence-index-v2.schema.json"),
        "utf8",
      ),
    );
    const vector = JSON.parse(
      readFileSync(
        path.join(schemaRoot, "product-evidence-v2-conformance.json"),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ strict: true });
    ajv.addFormat("date-time", true);
    ajv.addFormat("uri", true);

    expect(ajv.compile(receiptSchema)(vector.receipt)).toBe(true);
    const reference = { receipt: "receipt.json", sha256: "a".repeat(64) };
    expect(
      ajv.compile(indexSchema)({
        schemaVersion: 2,
        repository: "buildproven/example",
        repositoryId: "123456",
        behavioralTests: reference,
        acceptanceEvidence: reference,
      }),
    ).toBe(true);
    expect(canonicalJson(vector.receipt.payload)).toBe(vector.canonicalPayload);
    const publicKey = createPublicKey({
      key: Buffer.from(vector.publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verifySignature(
        null,
        Buffer.from(vector.canonicalPayload),
        publicKey,
        Buffer.from(vector.receipt.signature, "base64url"),
      ),
    ).toBe(true);
    expect(() => canonicalJson({ invalid: "\ud800" })).toThrow(
      /invalid Unicode/,
    );
  });

  it("accepts trusted signed local, hosted, and validated evidence separately", () => {
    const { dir, prd, tasks } = files();
    const result = validate(prd, tasks);
    const local = evidence(dir, result.requirementsDigest);
    const hosted = evidence(dir, result.requirementsDigest, { hosted: true });
    const validated = evidence(dir, result.requirementsDigest, {
      hosted: true,
      validated: true,
    });
    expect(claim(result, "local-product", local)).toMatchObject({
      valid: true,
      requirementsDigest: result.requirementsDigest,
    });
    expect(claim(result, "hosted", local).valid).toBe(false);
    expect(claim(result, "hosted", hosted).valid).toBe(true);
    expect(claim(result, "validated", hosted).valid).toBe(false);
    expect(claim(result, "validated", validated).valid).toBe(true);
  });

  it("rejects hosted chains whose local receipts name another deployment", () => {
    const { dir, prd, tasks } = files();
    const result = validate(prd, tasks);
    const hosted = evidence(dir, result.requirementsDigest, { hosted: true });
    rewriteReceipt(hosted, "behavioralTests", (payload) => {
      payload.deploymentIdentity = "deploy-other";
    });
    expect(claim(result, "hosted", hosted).valid).toBe(false);
  });

  it("accepts an evidence-free contract claim for allowed files", () => {
    const { prd, tasks } = files();
    const result = validate(prd, tasks);
    expect(
      verifyClaim(
        result,
        "contract",
        ["docs/decisions/ADR-quality-runtime.md", "harness-config.json"],
        {},
        {},
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  it("accepts the complete protected infrastructure bootstrap chain", () => {
    const { prd, tasks } = files();
    writeFileSync(
      prd,
      "# Protected admission\n\n## Delivery classification\n\n- Delivery: protected-infrastructure-bootstrap\n",
    );
    const result = validate(prd, tasks);
    const changedFiles = [
      ".github/workflows/product-evidence-admission.yml",
      ".github/workflows/product-evidence-producer.yml",
      ".github/workflows/product-evidence-source.yml",
      "docs/prd/bui-836-product-evidence-admission-tasks.md",
      "docs/prd/bui-836-product-evidence-admission.md",
      "docs/product-evidence-admission-operator-guide.md",
      "scripts/__tests__/product-admission.test.js",
      "scripts/__tests__/quality-run.test.js",
      "scripts/product-admission.js",
      "scripts/product-evidence-producer.js",
      "scripts/product-evidence.js",
      "scripts/quality-run.js",
    ];
    expect(verifyClaim(result, "contract", changedFiles, {}, {})).toMatchObject(
      { valid: true, errors: [] },
    );
    expect(
      verifyClaim(
        result,
        "contract",
        [...changedFiles, "scripts/other.js"],
        {},
        {},
      ),
    ).toMatchObject({ valid: false });
  });

  it("rejects unsigned, untrusted, wrong-repository, and wrong-head receipts", () => {
    const { dir, prd, tasks } = files();
    const result = validate(prd, tasks);
    const local = evidence(dir, result.requirementsDigest);
    const envelope = JSON.parse(
      readFileSync(local.receipts.behavioralTests.file, "utf8"),
    );
    envelope.signature = "unsigned";
    writeFileSync(
      local.receipts.behavioralTests.file,
      `${JSON.stringify(envelope)}\n`,
    );
    local.value.behavioralTests.sha256 = digest(
      readFileSync(local.receipts.behavioralTests.file),
    );
    expect(claim(result, "local-product", local).valid).toBe(false);

    const fresh = evidence(dir, result.requirementsDigest);
    const otherKey = generateKeyPairSync("ed25519").publicKey;
    expect(
      claim(result, "local-product", fresh, { trustedPublicKey: otherKey })
        .valid,
    ).toBe(false);
    expect(
      claim(result, "local-product", fresh, { repository: "other/towns" })
        .valid,
    ).toBe(false);
    expect(
      claim(result, "local-product", fresh, { head: "b".repeat(40) }).valid,
    ).toBe(false);
  });

  it("rejects test-only source changes", () => {
    const { dir, prd, tasks } = files();
    const result = validate(prd, tasks);
    const local = evidence(dir, result.requirementsDigest);
    expect(
      verifyClaim(
        result,
        "local-product",
        ["scripts/__tests__/towns.test.js"],
        local.value,
        {
          head: HEAD,
          repository: REPOSITORY,
          repositoryId: REPOSITORY_ID,
          evidencePath: local.file,
          trustedPublicKey: local.keys.publicKey,
        },
      ).valid,
    ).toBe(false);
  });

  it("classifies contract and quality-control files conservatively", () => {
    for (const file of [
      "docs/decisions/ADR-quality-runtime.md",
      ".buildproven/test-impact.json",
      "harness-config.json",
      "package-lock.json",
      "core",
      "scripts/ci-workflow-contract.js",
      "vitest.config.mjs",
    ]) {
      expect(productionCodeChange(file)).toBe(false);
    }
    for (const file of [
      "src/towns.js",
      "src/Towns.vue",
      "src/prompts/system.txt",
      "src/content/help.mdx",
      "config/app.json",
      "harness-config.js",
      "harness-config.yaml",
    ]) {
      expect(productionCodeChange(file)).toBe(true);
    }
  });

  it("rejects receipts replayed against a different PRD or task set", () => {
    const original = files();
    const originalResult = validate(original.prd, original.tasks);
    const local = evidence(original.dir, originalResult.requirementsDigest);
    writeFileSync(
      original.prd,
      "# PRD\n\n## User stories\n\n- As a buyer, I compare schools.\n",
    );
    const changedResult = validate(original.prd, original.tasks);
    expect(changedResult.requirementsDigest).not.toBe(
      originalResult.requirementsDigest,
    );
    expect(claim(changedResult, "local-product", local).valid).toBe(false);
    expect(claim(changedResult, "local-product", local).errors).toContainEqual(
      expect.stringMatching(/wrong .*requirements/),
    );
  });

  it("rejects candidate-owned execution provenance and a reused repository name", () => {
    const original = files();
    const result = validate(original.prd, original.tasks);
    const local = evidence(original.dir, result.requirementsDigest);
    rewriteReceipt(local, "behavioralTests", (payload) => {
      payload.provenance.executionOwner = "candidate";
    });
    expect(claim(result, "local-product", local).valid).toBe(false);

    const fresh = evidence(original.dir, result.requirementsDigest);
    expect(
      claim(result, "local-product", fresh, { repositoryId: "654321" }).valid,
    ).toBe(false);
  });

  it("rejects missing, changed, or escaping artifacts and failed results", () => {
    const { dir, prd, tasks } = files();
    const result = validate(prd, tasks);
    const missing = evidence(dir, result.requirementsDigest);
    unlinkSync(missing.receipts.acceptanceEvidence.artifact);
    expect(claim(result, "local-product", missing).valid).toBe(false);

    const changed = evidence(dir, result.requirementsDigest);
    writeFileSync(changed.receipts.behavioralTests.artifact, "changed\n");
    expect(claim(result, "local-product", changed).valid).toBe(false);

    const failed = evidence(dir, result.requirementsDigest);
    rewriteReceipt(failed, "behavioralTests", (payload) => {
      payload.result = "failed";
    });
    expect(claim(result, "local-product", failed).valid).toBe(false);

    const escaped = evidence(dir, result.requirementsDigest);
    const outside = path.join(dir, "outside.json");
    const link = path.join(
      path.dirname(escaped.receipts.acceptanceEvidence.file),
      "outside-link.json",
    );
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, link);
    rewriteReceipt(escaped, "acceptanceEvidence", (payload) => {
      payload.artifact = {
        path: path.basename(link),
        sha256: digest(readFileSync(outside)),
      };
    });
    expect(claim(result, "local-product", escaped).valid).toBe(false);
  });

  it("rejects mixed deployment identities", () => {
    const { dir, prd, tasks } = files();
    const result = validate(prd, tasks);
    const hosted = evidence(dir, result.requirementsDigest, { hosted: true });
    hosted.value.deploymentIdentity = "deploy-other";
    expect(claim(result, "hosted", hosted).valid).toBe(false);
  });

  it("requires implementation work and rejects product files under contract", () => {
    const contract = files({ phase: "contract" });
    const result = validate(contract.prd, contract.tasks);
    const local = evidence(contract.dir, result.requirementsDigest);
    expect(claim(result, "local-product", local).valid).toBe(false);
    const contractClaim = verifyClaim(
      result,
      "contract",
      ["docs/prd/towns.md", "src/towns.js"],
      {},
      { head: HEAD, repository: REPOSITORY },
    );
    expect(contractClaim.valid).toBe(false);
    expect(contractClaim.errors).toContain(
      "contract claim cannot cover product-affecting file 'src/towns.js'",
    );
  });

  it("does not call a product done while a contract task is open", () => {
    const { tasks, prd } = files({ checked: true });
    writeFileSync(
      tasks,
      `- [ ] 1.0 Confirm data source\n  - Phase: contract\n  - Delivers: A confirmed source.\n  - Evidence: source decision\n\n- [x] 2.0 Find similar towns\n  - Phase: implementation\n  - Delivers: A user receives ten explainable alternatives.\n  - Evidence: browser journey + API behavior test\n`,
    );
    expect(next(validate(prd, tasks)).status).toBe("next-contract");
  });
});

describe("committed dependency maintenance", () => {
  function revisions(before, after, file = "package.json") {
    const repo = mkdtempSync(path.join(tmpdir(), "manifest-maintenance-"));
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(
      path.join(repo, file),
      typeof before === "string" ? before : JSON.stringify(before),
    );
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    if (after === null) unlinkSync(path.join(repo, file));
    else
      writeFileSync(
        path.join(repo, file),
        typeof after === "string" ? after : JSON.stringify(after),
      );
    git("add", "-A");
    git("commit", "--allow-empty", "-qm", "head");
    return { repo, base, head: git("rev-parse", "HEAD") };
  }

  it("admits dependency updates/removals and overrides without customer evidence", () => {
    const context = revisions(
      {
        name: "app",
        dependencies: { unused: "1" },
        devDependencies: { vitest: "3" },
      },
      {
        name: "app",
        dependencies: {},
        devDependencies: { vitest: "4" },
        overrides: { nested: { vulnerable: "2" } },
      },
    );
    expect(classifyChange("package.json", context).kind).toBe(
      "dependency-maintenance",
    );
    expect(productionCodeChange("package.json", context)).toBe(false);
    // A dirty worktree must not change the decision for the committed candidate.
    writeFileSync(
      path.join(context.repo, "package.json"),
      JSON.stringify({ scripts: { start: "evil" } }),
    );
    expect(productionCodeChange("package.json", context)).toBe(false);
    expect(productionCodeChange("src/app.js", context)).toBe(true);
  });

  it.each([
    ["dependencies", 42],
    ["devDependencies", []],
    ["optionalDependencies", { lib: null }],
    ["peerDependencies", { lib: "" }],
    ["overrides", { lib: { nested: 4 } }],
    ["resolutions", { lib: {} }],
  ])("rejects malformed %s values", (field, value) => {
    const context = revisions({}, { [field]: value });
    expect(productionCodeChange("package.json", context)).toBe(true);
  });

  it("requires product admission when conditional export order changes", () => {
    const context = revisions(
      {
        exports: { default: "./fallback.js", node: "./node.js" },
        devDependencies: { vitest: "3" },
      },
      {
        exports: { node: "./node.js", default: "./fallback.js" },
        devDependencies: { vitest: "4" },
      },
    );
    expect(productionCodeChange("package.json", context)).toBe(true);
  });

  it.each([
    "scripts",
    "exports",
    "type",
    "engines",
    "packageManager",
    "workspaces",
    "config",
    "peerDependenciesMeta",
  ])(
    "requires product admission for mixed dependency and %s changes",
    (field) => {
      const context = revisions(
        { dependencies: { lib: "1" } },
        { dependencies: { lib: "2" }, [field]: "changed" },
      );
      expect(productionCodeChange("package.json", context)).toBe(true);
    },
  );

  it("fails closed for missing context, deleted, malformed, and newly added manifests", () => {
    expect(productionCodeChange("package.json")).toBe(true);
    expect(productionCodeChange("package.json", revisions({}, null))).toBe(
      true,
    );
    expect(productionCodeChange("package.json", revisions({}, "{bad"))).toBe(
      true,
    );
    const context = revisions({}, { dependencies: {} });
    expect(
      productionCodeChange("package.json", {
        ...context,
        base: "0".repeat(40),
      }),
    ).toBe(true);
    expect(productionCodeChange("new/package.json", context)).toBe(true);
  });
});
