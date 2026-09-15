const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  assertEngineeringPolicy,
  validatePolicy,
} = require("../engineering-delivery-policy");

const VALID_POLICY = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../..", ".buildproven/delivery-policy.json"),
    "utf8",
  ),
);

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function repository({ withPolicy = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "engineering-policy-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Policy Test"]);
  git(root, ["config", "user.email", "policy@example.com"]);
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  if (withPolicy) {
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(
      path.join(root, ".buildproven/delivery-policy.json"),
      JSON.stringify(VALID_POLICY),
    );
  }
  const base = commit(root, "test: create protected base");
  git(root, ["update-ref", "refs/remotes/origin/main", base]);
  return { root, base };
}

function manifest(root, base) {
  return {
    repo: { realpath: root },
    revisions: { baseHeadSha: base, baseRef: "origin/main" },
    options: { deliveryClaim: "engineering" },
  };
}

describe("protected engineering delivery policy", () => {
  it("accepts only the closed policy from the current protected base", () => {
    const { root, base } = repository();

    expect(assertEngineeringPolicy(manifest(root, base))).toEqual({
      claim: "engineering",
      policyRevision: base,
      productAcceptance: "not-established",
    });
  });

  it("does not let a candidate-only policy authorize its own claim", () => {
    const { root, base } = repository({ withPolicy: false });
    mkdirSync(path.join(root, ".buildproven"));
    writeFileSync(
      path.join(root, ".buildproven/delivery-policy.json"),
      JSON.stringify(VALID_POLICY),
    );
    commit(root, "test: add candidate-only policy");

    expect(() => assertEngineeringPolicy(manifest(root, base))).toThrow(
      "policy cannot be read from the repository",
    );
  });

  it("rejects a stale policy revision after the protected base moves", () => {
    const { root, base } = repository();
    writeFileSync(path.join(root, "README.md"), "new protected base\n");
    const nextBase = commit(root, "test: move protected base");
    git(root, ["update-ref", "refs/remotes/origin/main", nextBase]);

    expect(() => assertEngineeringPolicy(manifest(root, base))).toThrow(
      "protected base policy is stale",
    );
  });

  it("rejects policy revocation on the current protected base", () => {
    const { root } = repository();
    const revoked = structuredClone(VALID_POLICY);
    revoked.claims.engineering.enabled = false;
    writeFileSync(
      path.join(root, ".buildproven/delivery-policy.json"),
      JSON.stringify(revoked),
    );
    const nextBase = commit(root, "test: revoke engineering claim");
    git(root, ["update-ref", "refs/remotes/origin/main", nextBase]);

    expect(() => assertEngineeringPolicy(manifest(root, nextBase))).toThrow(
      "engineering claim is disabled",
    );
  });

  it.each([
    ["unknown document field", { ...VALID_POLICY, extra: true }],
    [
      "unknown claim",
      { ...VALID_POLICY, claims: { ...VALID_POLICY.claims, hosted: {} } },
    ],
    [
      "incomplete controls",
      {
        ...VALID_POLICY,
        claims: {
          engineering: {
            ...VALID_POLICY.claims.engineering,
            requiredControls: ["deterministic-gates"],
          },
        },
      },
    ],
    [
      "product acceptance",
      {
        ...VALID_POLICY,
        claims: {
          engineering: {
            ...VALID_POLICY.claims.engineering,
            productAcceptance: "complete",
          },
        },
      },
    ],
  ])("rejects %s", (_label, policy) => {
    expect(() => validatePolicy(policy)).toThrow("engineering delivery policy");
  });

  it("re-reads the policy immediately before final merge authorization", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "quality-stamp-and-merge.sh"),
      "utf8",
    );
    const policyCheck = source.indexOf("engineering-delivery-policy.js");
    const authorization = source.lastIndexOf("quality-authorize-merge.sh");

    expect(policyCheck).toBeGreaterThan(0);
    expect(policyCheck).toBeLessThan(authorization);
  });
});
