import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyReceipt } from "../product-evidence.js";
import { produce } from "../product-evidence-producer.js";

const REPOSITORY = "buildproven/claude-kit";
const REPOSITORY_ID = "123456";
const HEAD = "a".repeat(40);

describe("product evidence producer", () => {
  it("signs a protected source bundle and writes bound receipt references", () => {
    const root = mkdtempSync(path.join(tmpdir(), "product-evidence-producer-"));
    const sourceDirectory = path.join(root, "source");
    const outputDirectory = path.join(root, "output");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    try {
      const request = {
        schemaVersion: 1,
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        pullRequest: 7,
        base: "b".repeat(40),
        head: HEAD,
        nonce: "c".repeat(32),
        behavioralCommand: "npm test",
        acceptanceCommand: "npm run test:patterns",
      };
      const event = {
        action: "completed",
        repository: {
          id: Number(REPOSITORY_ID),
          full_name: REPOSITORY,
          default_branch: "main",
        },
        workflow_run: {
          id: 100,
          name: "Product Evidence Source",
          path: ".github/workflows/product-evidence-source.yml",
        },
      };
      const sourceRun = {
        id: 100,
        name: "Product Evidence Source",
        path: ".github/workflows/product-evidence-source.yml",
        event: "repository_dispatch",
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        head_branch: "main",
        updated_at: "2026-09-09T00:00:00Z",
      };
      const sourceJobs = {
        jobs: [
          {
            name: "collect-product-evidence",
            conclusion: "success",
            run_id: 100,
          },
        ],
      };
      const pullRequest = {
        number: 7,
        state: "open",
        head: { repo: { id: Number(REPOSITORY_ID) }, sha: HEAD },
        base: { repo: { id: Number(REPOSITORY_ID) }, ref: "main" },
      };
      const runtime = {
        githubActions: "true",
        eventName: "workflow_run",
        runAttempt: "1",
        workflowRef: ".github/workflows/product-evidence-producer.yml",
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        runId: "200",
      };
      for (const [name, value] of [
        ["request.json", request],
        ["changed-files.json", ["scripts/app.js"]],
      ]) {
        const file = path.join(sourceDirectory, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(value)}\n`);
      }
      writeFileSync(path.join(sourceDirectory, "prd.md"), "# Product\n");
      writeFileSync(
        path.join(sourceDirectory, "tasks.md"),
        "- [x] 1.0 Verify evidence\n",
      );
      writeFileSync(
        path.join(sourceDirectory, "behavioral-tests.log"),
        "passed\n",
      );
      writeFileSync(
        path.join(sourceDirectory, "acceptance-evidence.log"),
        "passed\n",
      );
      const digest = (value) =>
        createHash("sha256").update(value).digest("hex");
      const requirementsDigest = digest(
        JSON.stringify({
          prdSha256: digest(readFileSync(path.join(sourceDirectory, "prd.md"))),
          tasksSha256: digest(
            readFileSync(path.join(sourceDirectory, "tasks.md")),
          ),
        }),
      );

      const result = produce({
        event,
        sourceRun,
        sourceJobs,
        pullRequest,
        sourceDirectory,
        outputDirectory,
        encodedPrivateKey: privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64"),
        runtime,
      });
      const evidencePath = path.join(outputDirectory, "evidence.json");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      expect(result).toMatchObject({ head: HEAD });
      expect(evidence).toMatchObject({
        schemaVersion: 2,
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
      });
      expect(
        verifyReceipt(
          evidence.behavioralTests,
          {
            kind: "behavioralTests",
            repository: REPOSITORY,
            repositoryId: REPOSITORY_ID,
            head: HEAD,
            requirementsDigest,
          },
          { evidencePath, trustedPublicKey: publicKey },
        ),
      ).toMatchObject({ command: "npm test", result: "passed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
