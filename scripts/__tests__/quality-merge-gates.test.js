import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILL = readFileSync(path.join(ROOT, "skills/quality/SKILL.md"), "utf8");
const VALIDATOR = readFileSync(
  path.join(ROOT, "scripts/quality-validate-review-trailers.sh"),
  "utf8",
);
const BOOTSTRAP = readFileSync(
  path.join(ROOT, "scripts/quality-bootstrap.sh"),
  "utf8",
);
const WRAPPER = readFileSync(
  path.join(ROOT, "scripts/quality-wrapper.js"),
  "utf8",
);
const INVOCATION = readFileSync(
  path.join(ROOT, "scripts/quality-invocation.js"),
  "utf8",
);
const RUN_REVIEW = readFileSync(
  path.join(ROOT, "scripts/quality-run-review.sh"),
  "utf8",
);
const PRESERVE_PRIMARY = path.join(
  ROOT,
  "scripts/quality-preserve-primary-evidence.sh",
);
const AUTHORIZE = readFileSync(
  path.join(ROOT, "scripts/quality-authorize-merge.sh"),
  "utf8",
);
const REPOSITORY_LEASE = readFileSync(
  path.join(ROOT, "scripts/quality-repo-lease.js"),
  "utf8",
);
const STAMP_AND_MERGE = readFileSync(
  path.join(ROOT, "scripts/quality-stamp-and-merge.sh"),
  "utf8",
);
const MERGE_CLEANUP = readFileSync(
  path.join(ROOT, "scripts/quality-merge-cleanup.sh"),
  "utf8",
);
const QUALITY_COMMAND = readFileSync(
  path.join(ROOT, "commands/bs/quality.md"),
  "utf8",
);
const WORKFLOW_COMMAND = readFileSync(
  path.join(ROOT, "commands/bs/workflow.md"),
  "utf8",
);

/**
 * On 2026-07-12 a review panel returned FAIL with 2 blocking findings; the skill
 * stamped `findings=2` into the Reviewed-By trailer and merged anyway, shipping
 * an install-bricking bug to a public repo.
 *
 * Root cause: BLOCKING_COUNT was only ever interpolated into the trailer string —
 * never compared to zero. Every gate verified the review RAN; none verified it
 * PASSED. These tests pin the gate that closes that hole.
 */
describe("quality merge gates", () => {
  it.each([
    {
      command: "wait",
      name: "preserves wait transport failure",
      prepareResult: '{"dispatches":[]}',
    },
    {
      command: "ensure",
      name: "preserves ensure transport failure",
      prepareResult: '{"dispatches":[{"workflowId":1}]}',
    },
  ])(
    "$name outside billing waiver and merge authority",
    ({ command, prepareResult }) => {
      const root = makeTempDir("quality-stamp-transport-");
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const head = "a".repeat(40);
      const calls = path.join(root, "calls.jsonl");
      writeFileSync(calls, "");
      const script = (name, body) =>
        writeFileSync(path.join(root, name), body, { mode: 0o755 });
      const record = `require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(1)) + "\\n");`;
      script("quality-stamp-and-merge.sh", STAMP_AND_MERGE);
      script(
        "quality-repo-lease-pin.sh",
        "quality_pin_repository_lease() { return 0; }\n",
      );
      script("quality-assert-clean.sh", "#!/bin/bash\nexit 0\n");
      script(
        "quality-invocation.js",
        `
const fields = ${JSON.stringify({
          "revisions.currentHead": head,
          "repo.pr": "7",
          "repo.githubRepository": "owner/repo",
          "repo.headRefName": "feature/fix",
          "repo.headRepository": "owner/repo",
          "revisions.baseRef": "main",
        })};
if (process.argv[2] === "locate") console.log(${JSON.stringify(root)});
else if (process.argv[2] === "field") console.log(fields[process.argv[4]] || "");
else if (process.argv[2] === "ci-billing-capability") process.exit(1);
`,
      );
      script(
        "quality-authorize-merge.sh",
        `#!/bin/bash
if [ "\${3:-}" = --preflight ]; then
  printf 'BS_QUALITY_PR_HEAD=${head}\nBS_QUALITY_BASE_PROTECTION=true\n'
else
  node '${root}/quality-merge-mutation.js'
fi
`,
      );
      script("quality-merge-mutation.js", `${record} process.exit(0);\n`);
      script("quality-review-check.js", "process.exit(0);\n");
      script(
        "quality-required-checks.js",
        `
${record}
if (process.argv[2] === "prepare") console.log(${JSON.stringify(prepareResult)});
else if (process.argv[2] === ${JSON.stringify(command)}) {
  console.error('Get "https://api.github.com": unexpected EOF');
  process.exit(75);
} else process.exit(1);
`,
      );
      script("ci-budget-admission.js", "process.exit(0);\n");
      script("quality-run-bounded.sh", '#!/bin/bash\nshift 3\nexec "$@"\n');
      script("quality-ci-billing-waiver.js", `${record} process.exit(0);\n`);
      script("quality-terminal-status.js", `${record} process.exit(0);\n`);
      script("quality-merge-cleanup.sh", "#!/bin/bash\nexit 0\n");
      writeFileSync(
        path.join(bin, "git"),
        `#!/bin/bash
case "$1" in
  rev-parse) echo '${head}' ;;
  remote) if [ "$#" = 1 ]; then echo origin; else echo https://github.com/owner/repo.git; fi ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(bin, "gh"),
        `#!/bin/bash
case "$1 $2" in
  'pr checks') echo '[{"state":"PENDING"}]' ;;
  'repo view') echo owner/repo ;;
  'pr view') echo '${head}' ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          path.join(root, "quality-stamp-and-merge.sh"),
          "--manifest",
          path.join(root, "invocation.json"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY: "fixture",
            QUALITY_LOCAL_REVIEW_EVIDENCE: "false",
          },
        },
      );
      expect(result.status, result.stderr).toBe(75);
      const observed = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        observed.some(
          (call) =>
            call[0].endsWith("quality-required-checks.js") &&
            call[1] === command,
        ),
      ).toBe(true);
      expect(
        observed.some((call) =>
          call[0].endsWith("quality-ci-billing-waiver.js"),
        ),
      ).toBe(false);
      expect(
        observed.some((call) => call[0].endsWith("quality-terminal-status.js")),
      ).toBe(false);
      expect(
        observed.some((call) => call[0].endsWith("quality-merge-mutation.js")),
      ).toBe(false);
      expect(observed).toHaveLength(2);
    },
  );

  it("admits budget whenever preparation proves a dispatch is needed", () => {
    const source = STAMP_AND_MERGE;
    expect(source).toContain('gh pr checks "$PR"');
    expect(source).toContain("--required --json state");
    expect(source).toContain('"no required checks reported"*');
    expect(source).toMatch(
      /REQUIRED_CHECKS_LOOKUP_SUCCEEDED=false[\s\S]*REQUIRED_CHECKS_LOOKUP_SUCCEEDED=true[\s\S]*case "\$REQUIRED_CHECKS_OUTPUT" in[\s\S]*"no required checks reported"\*\) REQUIRED_CHECKS_ABSENT=true/,
    );
    expect(source).not.toMatch(
      /--required --json state 2>\/dev\/null \|\| true/,
    );
    expect(source).toMatch(
      /REQUIRED_CHECKS_ABSENT=true[\s\S]*REGISTERED_CHECKS_JSON[\s\S]*gh pr checks "\$PR"/,
    );
    expect(source).toMatch(
      /CHECKS_FOR_ADMISSION_JSON="\$REQUIRED_CHECKS_JSON"[\s\S]*CHECKS_FOR_ADMISSION_JSON="\$REGISTERED_CHECKS_JSON"/,
    );
    expect(source).toContain('if [ "$CI_ALREADY_REGISTERED" != true ]; then');
    expect(source).toMatch(/CI_ALREADY_REGISTERED[\s\S]*admit_ci_dispatch/);
    expect(source).toMatch(
      /quality-required-checks\.js" prepare[\s\S]*PREPARED_DISPATCH_COUNT[\s\S]*if \[ "\$PREPARED_DISPATCH_COUNT" -gt 0 \]; then[\s\S]*admit_ci_dispatch[\s\S]*enforce_ci_budget_admission[\s\S]*quality-required-checks\.js" ensure[\s\S]*fi[\s\S]*quality-required-checks\.js" wait/,
    );
    expect(source.indexOf('quality-required-checks.js" prepare')).toBeLessThan(
      source.lastIndexOf("enforce_ci_budget_admission"),
    );
    expect(source.lastIndexOf("enforce_ci_budget_admission")).toBeLessThan(
      source.indexOf('quality-required-checks.js" ensure'),
    );
    expect(source).toContain(
      "local CI budget policy denied new workflow spend for this candidate",
    );
    expect(source).not.toContain(
      "GitHub Actions minute policy denied this candidate",
    );
    expect(source).toContain(
      "CI budget admission could not produce a policy decision",
    );
  });

  it("waits for required CI before using local evidence when check publication is unavailable", () => {
    expect(STAMP_AND_MERGE).toMatch(
      /quality-review-check\.js" publish[\s\S]*LOCAL_REVIEW_EVIDENCE_DEFERRED=true/,
    );
    expect(STAMP_AND_MERGE).toMatch(
      /quality-required-checks\.js" wait[\s\S]*LOCAL_REVIEW_EVIDENCE_DEFERRED[\s\S]*prepare_local_review_evidence/,
    );
    expect(STAMP_AND_MERGE).not.toContain(
      "custom review check publication failed before required CI was green",
    );
    expect(STAMP_AND_MERGE).toContain("QUALITY_LOCAL_REVIEW=true");
    expect(STAMP_AND_MERGE).toMatch(
      /quality-review-check\.js" write-local[\s\S]*quality-review-check\.js" verify-local[\s\S]*LOCAL_REVIEW_EVIDENCE=true/,
    );
    expect(STAMP_AND_MERGE).toContain(
      'QUALITY_LOCAL_REVIEW_ARTIFACT="$LOCAL_REVIEW_EVIDENCE_ARTIFACT"',
    );
    expect(STAMP_AND_MERGE).toMatch(
      /if \[ "\$CI_BILLING_WAIVED" = true \]; then[\s\S]*QUALITY_CI_BILLING_LOCAL_REVIEW="\$LOCAL_REVIEW_EVIDENCE"[\s\S]*QUALITY_LOCAL_REVIEW_ARTIFACT="\$LOCAL_REVIEW_EVIDENCE_ARTIFACT"[\s\S]*quality-authorize-merge\.sh/,
    );
    expect(VALIDATOR).toMatch(
      /QUALITY_LOCAL_REVIEW_ARTIFACT[\s\S]*quality-review-check\.js" verify-local/,
    );
    expect(VALIDATOR).toMatch(
      /AUTH_STATUS" = complete[\s\S]*AUTH_STATUS" = policy-exempt/,
    );
    expect(VALIDATOR).toMatch(
      /AUTH_STATUS" = incomplete[\s\S]*AUTH_REVIEW_OVERRIDE" = true/,
    );
    expect(VALIDATOR).toMatch(
      /operatorOverride == true[\s\S]*override\.acceptedConditions[\s\S]*startswith\("review:"\)/,
    );
  });
  it("lets the composed ref-CAS capability advance an exhausted review", () => {
    expect(BOOTSTRAP).toMatch(
      /operator-quality-override[\s\S]*operator-nonstrict-refcas-override[\s\S]*review:provider-exhaustion/,
    );
    expect(WRAPPER).toMatch(
      /function needsDescendantAdvanceAuthorization[\s\S]*isOperatorOverrideScope\(request\.scope\)[\s\S]*acceptedConditions\.includes\("review:provider-exhaustion"\)/,
    );
    expect(WRAPPER).toContain(
      "if (needsDescendantAdvanceAuthorization(request))",
    );
    expect(WRAPPER).toMatch(
      /function prepareDescendantAdvanceAuthorization[\s\S]*operator-quality-override[\s\S]*operator-nonstrict-refcas-override[\s\S]*includes\(scope\)/,
    );
    expect(INVOCATION).toMatch(
      /function validateDescendantAdvanceAuthorization[\s\S]*operator-quality-override[\s\S]*operator-nonstrict-refcas-override[\s\S]*includes\(payload\?\.scope\)/,
    );
  });
  it("passes administrator authority to the protected non-strict ref-CAS lease", () => {
    expect(AUTHORIZE).toMatch(
      /MERGE_MODE" = protected-nonstrict-ref-cas[\s\S]*LEASE_ADMIN=true[\s\S]*administrator non-force ref update authorized/,
    );
    expect(AUTHORIZE).toMatch(
      /MERGE_MODE" = protected-nonstrict-ref-cas[\s\S]*BS_QUALITY_PROTECTION_RECHECK[\s\S]*quality-repo-lease\.js" merge[\s\S]*--admin "\$LEASE_ADMIN"/,
    );
  });
  it("keeps deterministic failures blocking while AI leads stay advisory", () => {
    expect(SKILL).toMatch(/zero deterministic findings/);
    expect(SKILL).toMatch(/AI leads and completion status are advisory/);
    expect(QUALITY_COMMAND).toMatch(
      /AI leads and completion status are\s+advisory/,
    );
    expect(WORKFLOW_COMMAND).toMatch(
      /AI leads and completion status are\s+advisory/,
    );
    expect(QUALITY_COMMAND).not.toMatch(
      /malformed or inconclusive review output.*hard merge blocks/s,
    );
  });

  it("states the deterministic-findings gate before the trailer contract", () => {
    const findingsGate = SKILL.indexOf("zero deterministic findings");
    const trailerGate = SKILL.indexOf("Reviewed-By: quality");
    expect(findingsGate).toBeGreaterThan(-1);
    expect(trailerGate).toBeGreaterThan(-1);
    // A merge must not be authorized by a trailer while findings are outstanding.
    expect(findingsGate).toBeLessThan(trailerGate);
  });

  it("authorizes either reviewer through a provider-neutral quality trailer", () => {
    expect(SKILL).toMatch(/Reviewed-By: quality/);
    expect(SKILL).toMatch(/reviewer=<provider>/);
    expect(SKILL).not.toMatch(/requires a 'Reviewed-By: codex'/);
  });

  it("binds neutral evidence to HEAD/HEAD~1 and merge-base", () => {
    expect(SKILL).toMatch(/head=<reviewed-head>, base=<base-sha>/);
    expect(SKILL).toMatch(/quality-stamp-and-merge\.sh/);
    expect(STAMP_AND_MERGE).toMatch(/review-authorization/);
    expect(STAMP_AND_MERGE).toMatch(/quality-authorize-merge\.sh/);
    expect(VALIDATOR).toMatch(/STAMP_HEAD.*CURRENT_PARENT/s);
    expect(VALIDATOR).toMatch(/STAMP_BASE.*CURRENT_BASE/s);
    expect(VALIDATOR).toMatch(/grep -Fxq "\$EXPECTED"/);
  });

  it("makes the reusable trailer validator verify signed provider evidence", () => {
    expect(VALIDATOR).toMatch(/quality-review-evidence\.js" verify/);
    expect(VALIDATOR).toContain("Quality-Evidence-Signature");
    expect(VALIDATOR).toContain("QUALITY_REVIEW_EVIDENCE_PUBLIC_KEY");
    expect(VALIDATOR).toContain("--require-signature");
    expect(VALIDATOR).toContain(
      "high/critical evidence requires --require-signature",
    );
    expect(VALIDATOR).toContain(
      "high/critical evidence requires a configured primary reviewer",
    );
    expect(VALIDATOR).toContain("--required-tier");
    expect(VALIDATOR).toContain("operator-quality-override");
    expect(VALIDATOR).toContain(
      "high/critical evidence requires the configured primary reviewer",
    );
    expect(VALIDATOR).toMatch(
      /\[ -z "\$STAMP_CONTRACT" \].*configured primary reviewer/s,
    );
  });

  it("requires signed evidence at the merge authorization boundary", () => {
    expect(AUTHORIZE).toMatch(
      /quality-validate-review-trailers\.sh"[\s\S]*--required-tier "\$TIER" --require-signature/,
    );
  });

  it("derives a local verifier key only from the configured operator signer", () => {
    expect(STAMP_AND_MERGE).toMatch(/quality-review-evidence\.js" public-key/);
  });

  it("head-binds the merge and verifies terminal merged state", () => {
    expect(REPOSITORY_LEASE).toMatch(/"--match-head-commit",\s*head/);
    expect(REPOSITORY_LEASE).toMatch(/spawnSync\("gh", args/);
    expect(REPOSITORY_LEASE).toMatch(
      /"pr",\s*"view"[\s\S]*state,mergedAt,mergeCommit/,
    );
    expect(REPOSITORY_LEASE).toMatch(/remote\.state === "MERGED"/);
    expect(REPOSITORY_LEASE).toMatch(/remote\.mergeCommit\?\.oid/);
    expect(AUTHORIZE).toMatch(/quality-repo-lease\.js" merge/);
    expect(AUTHORIZE).toMatch(/--expected-head "\$ACTUAL_HEAD"/);
    expect(REPOSITORY_LEASE).toMatch(/options\.expectedHead !== head/);
  });

  it("does not mutate the lease-backed terminal state after merge releases the lease", () => {
    expect(STAMP_AND_MERGE).toContain(
      "quality-repo-lease.js merge` records the write-once `merged` terminal state",
    );
    expect(STAMP_AND_MERGE).not.toMatch(
      /quality-invocation\.js" terminal-state[\s\S]*--state merged/,
    );
  });

  it("keeps post-merge cleanup on the phase-pinned lease credential", () => {
    expect(MERGE_CLEANUP).toMatch(
      /source "\$SCRIPT_DIR\/quality-repo-lease-pin\.sh"/,
    );
    expect(MERGE_CLEANUP).toMatch(/quality_pin_repository_lease "\$MANIFEST"/);
    expect(MERGE_CLEANUP).not.toMatch(/merge\.repositoryLease\.token/);
    expect(MERGE_CLEANUP).toMatch(/LEASE_RESULT="\$\(node/);
    expect(MERGE_CLEANUP).toMatch(/\.reconciled \/\/ false/);
    expect(MERGE_CLEANUP).toMatch(/repository merge remains quarantined/);
    expect(MERGE_CLEANUP).toMatch(/PRESERVE_BRANCH=true/);
    expect(REPOSITORY_LEASE).toMatch(
      /function releaseMergeGuard[\s\S]*withMetadataGuard/,
    );
    expect(REPOSITORY_LEASE).toMatch(
      /function releaseVerifiedOutcome[\s\S]*record\.disposition = "released"[\s\S]*recordMergedTerminalRaw/,
    );
    expect(STAMP_AND_MERGE).not.toMatch(/quality-repo-lease\.js" release/);
  });

  it("fails closed on already-merged PRs without pre-merge authorization", () => {
    expect(STAMP_AND_MERGE).not.toContain("BS_QUALITY_ALREADY_MERGED=true");
    expect(AUTHORIZE).toMatch(
      /already merged at \$MERGED_EXPECTED_HEAD without this invocation's persisted pre-merge authorization/,
    );
    expect(SKILL).toMatch(/--state verified-unmerged/);
    expect(SKILL.indexOf("--state verified-unmerged")).toBeLessThan(
      SKILL.indexOf('quality-telemetry.js" record'),
    );
  });

  it("preflights without mutation and preserves legacy stamp resumability", () => {
    expect(STAMP_AND_MERGE).toMatch(/--manifest "\$MANIFEST" --preflight/);
    expect(STAMP_AND_MERGE).toMatch(/if \[ -n "\$STAMP_HEAD" \]; then/);
    expect(STAMP_AND_MERGE).toMatch(
      /--force-with-lease="refs\/heads\/\$EXPECTED_HEAD_REF:\$PREFLIGHT_PR_HEAD"/,
    );
    expect(STAMP_AND_MERGE).toMatch(
      /"\$HEAD_REMOTE" "\$STAMP_HEAD:refs\/heads\/\$EXPECTED_HEAD_REF"/,
    );
    expect(STAMP_AND_MERGE).toMatch(
      /quality-review-check\.js" publish --manifest "\$MANIFEST"/,
    );
    expect(STAMP_AND_MERGE).toMatch(
      /if \[ -z "\$STAMP_HEAD" \] && \[ "\$PREFLIGHT_PR_HEAD" != "\$MERGE_HEAD" \]; then/,
    );
    expect(AUTHORIZE).toMatch(
      /already merged at \$MERGED_EXPECTED_HEAD without this invocation's persisted pre-merge authorization/,
    );
    expect(STAMP_AND_MERGE).not.toMatch(/HUSKY=0 git commit --allow-empty/);
    expect(AUTHORIZE).toMatch(/repo\.githubRepository/);
    expect(AUTHORIZE).toMatch(/repo\.headRefName/);
    expect(AUTHORIZE).toMatch(/--repo "\$EXPECTED_REPOSITORY"/);
  });

  it("delegates concrete ruleset applicability to GitHub", () => {
    expect(AUTHORIZE).toMatch(/rules\/branches\/\$ENCODED_BASE_NAME/);
    expect(AUTHORIZE).not.toMatch(/rulesets\?includes_parents/);
    expect(AUTHORIZE).not.toMatch(/conditions\.ref_name/);
    expect(AUTHORIZE).toMatch(/strict_required_status_checks_policy == true/);
    expect(AUTHORIZE).toMatch(/gh api graphql/);
    expect(AUTHORIZE).toMatch(/matchingRefs\(first:100\)/);
    expect(AUTHORIZE).toMatch(/pageInfo\{hasNextPage\}/);
    expect(AUTHORIZE).toMatch(/hasNextPage == false/);
    expect(AUTHORIZE).toMatch(/isAdminEnforced/);
    expect(AUTHORIZE).toMatch(/ADMIN_BASE_FRESHNESS/);
    expect(AUTHORIZE).toMatch(/ATOMIC_BASE_SOURCE/);
    expect(AUTHORIZE).toMatch(/ADMIN_BASE_SOURCE/);
    expect(AUTHORIZE).toMatch(/ruleset_id/);
    expect(AUTHORIZE).toMatch(/bypass_actors/);
    expect(AUTHORIZE).toMatch(/BS_QUALITY_PROTECTION_RECHECK/);
    expect(AUTHORIZE).toMatch(/REPOSITORY_ADMIN_PERMISSION/);
    expect(AUTHORIZE).toMatch(/CURRENT_USER_ID/);
    expect(AUTHORIZE).toMatch(/ORGANIZATION_ADMIN_PERMISSION/);
    expect(AUTHORIZE).toMatch(/RepositoryRole/);
    expect(AUTHORIZE).toMatch(/actor_type == "Team"/);
    expect(AUTHORIZE).toMatch(/orgs\/\$ORGANIZATION\/teams/);
    expect(AUTHORIZE).toMatch(/memberships\/\$CURRENT_USER_LOGIN/);
    expect(AUTHORIZE).toMatch(/AUTHORIZED_TEAM_ACTOR_IDS_JSON/);
    expect(AUTHORIZE).toMatch(
      /select\(\.type == "required_status_checks"\)[\s\S]*strict_required_status_checks_policy/,
    );
    expect(AUTHORIZE).toMatch(
      /REPOSITORY_ADMIN_PERMISSION" = true[\s\S]*ADMIN_BASE_SOURCE=graphql/,
    );
    expect(AUTHORIZE).toMatch(
      /PREFLIGHT[\s\S]*BS_QUALITY_PROTECTION_RECHECK[\s\S]*reserved for the internal preflight/,
    );
  });

  it("uses one manifest-bound operation for composed CI billing capability checks", () => {
    expect(AUTHORIZE).toMatch(
      /quality-invocation\.js" ci-billing-capability "\$MANIFEST/,
    );
    expect(STAMP_AND_MERGE).toMatch(
      /quality-invocation\.js" ci-billing-capability "\$MANIFEST/,
    );
    expect(VALIDATOR).toMatch(
      /quality-invocation\.js" ci-billing-capability "\$MANIFEST/,
    );
    expect(AUTHORIZE).not.toMatch(
      /field "\$MANIFEST"[\s\S]*acceptedConditions/,
    );
  });

  it("requires approval only for an explicit human-required policy during preflight", () => {
    const authority = AUTHORIZE.indexOf('MERGE_AUTHORITY="$(node');
    const approval = AUTHORIZE.indexOf(
      '[ "$MERGE_AUTHORITY" = human-required ]',
    );
    const preflight = AUTHORIZE.lastIndexOf('[ "$PREFLIGHT" = false ]');
    expect(authority).toBeGreaterThan(-1);
    expect(approval).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(approval);
    expect(AUTHORIZE).toMatch(
      /\[ -n "\$MERGE_AUTHORITY" \] \|\| MERGE_AUTHORITY=human-required/,
    );
    expect(AUTHORIZE).toMatch(
      /autonomous campaigns merge once their revision-bound review, CI, base, and/,
    );
  });

  it("documents only persisted-policy gate invocations", () => {
    expect(SKILL).toMatch(/--manifest "<exact-manifest-path>" --name lint/);
    expect(SKILL).not.toMatch(/--name (?:lint|test|security) -- </);
  });

  it("publishes exact-head evidence and waits boundedly for candidate CI", () => {
    expect(STAMP_AND_MERGE).toMatch(/merge\.stampHead/);
    expect(STAMP_AND_MERGE).toMatch(/record-stamp/);
    expect(STAMP_AND_MERGE).toMatch(/MERGE_HEAD="\$REVIEWED_HEAD"/);
    expect(STAMP_AND_MERGE).toMatch(/quality-run-bounded\.sh/);
    expect(STAMP_AND_MERGE).toMatch(/quality-required-checks\.js" wait/);
    expect(STAMP_AND_MERGE).toMatch(
      /PREFLIGHT_BASE_PROTECTION" = unprotectable[\s\S]*quality-wait-required-checks\.sh/,
    );
    expect(
      STAMP_AND_MERGE.indexOf('quality-required-checks.js" wait'),
    ).toBeLessThan(STAMP_AND_MERGE.lastIndexOf("quality-authorize-merge.sh"));
    expect(AUTHORIZE).toMatch(/persisted empty stamp/);
    expect(STAMP_AND_MERGE).toMatch(
      /--head "\$MERGE_HEAD" --timeout "\$CI_TIMEOUT" --interval 10 \\\n[ ]{6}--manifest "\$MANIFEST" \|\| RC=\$\?/,
    );
    expect(STAMP_AND_MERGE).toMatch(
      /quality-required-checks\.js" ensure[\s\S]*--manifest "\$MANIFEST"[\s\S]*--timeout "\$CI_TIMEOUT"/,
    );
    expect(AUTHORIZE).toMatch(
      /quality-ci-billing-waiver\.js[\s\S]*LEASE_ADMIN=true/,
    );
    expect(STAMP_AND_MERGE).not.toContain(
      "BS_QUALITY_ALLOW_LOCAL_REVIEW_EVIDENCE",
    );
    expect(VALIDATOR).toContain("QUALITY_LOCAL_REVIEW");
  });

  it("consumes a signed billing override before workflow dispatch", () => {
    const overrideBranch = STAMP_AND_MERGE.indexOf(
      'if [ "$CI_BUDGET_MODE" = local-exact-head ]; then',
    );
    const waiverValidation = STAMP_AND_MERGE.indexOf(
      'node "$SCRIPT_DIR/quality-ci-billing-waiver.js"',
      overrideBranch,
    );
    const workflowDispatch = STAMP_AND_MERGE.indexOf(
      'quality-required-checks.js" ensure',
    );
    expect(overrideBranch).toBeGreaterThan(-1);
    expect(waiverValidation).toBeGreaterThan(overrideBranch);
    expect(workflowDispatch).toBeGreaterThan(waiverValidation);
    expect(STAMP_AND_MERGE).toMatch(
      /if \[ "\$CI_BUDGET_MODE" = local-exact-head \]; then[\s\S]*CI_BILLING_WAIVED=true[\s\S]*elif \[ "\$PREFLIGHT_BASE_PROTECTION" = unprotectable \]/,
    );
  });

  it("validates an exact-head billing waiver before bypassing the green-CI guard", () => {
    const firstWaiverValidation = AUTHORIZE.indexOf(
      'node "$SCRIPT_DIR/quality-ci-billing-waiver.js"',
    );
    const requiredChecks = AUTHORIZE.indexOf(
      'node "$SCRIPT_DIR/quality-required-checks.js" assert',
    );
    const finalWaiverValidation = AUTHORIZE.lastIndexOf(
      'node "$SCRIPT_DIR/quality-ci-billing-waiver.js"',
    );
    const adminMerge = AUTHORIZE.lastIndexOf("LEASE_ADMIN=true");
    expect(firstWaiverValidation).toBeGreaterThan(-1);
    expect(requiredChecks).toBeGreaterThan(firstWaiverValidation);
    expect(AUTHORIZE).toMatch(
      /quality-required-checks\.js" assert[\s\S]*--manifest "\$MANIFEST"/,
    );
    expect(finalWaiverValidation).toBeGreaterThan(requiredChecks);
    expect(adminMerge).toBeGreaterThan(finalWaiverValidation);
    expect(AUTHORIZE).toMatch(
      /if \[ "\$PREFLIGHT" = false \] && \[ "\$\{CI_BILLING_WAIVED:-false\}" = false \]; then[\s\S]*gh pr checks/,
    );
    expect(AUTHORIZE).toMatch(
      /if \[ "\$\{CI_BILLING_WAIVED:-false\}" = true \]; then[\s\S]*LEASE_ADMIN=true/,
    );
    expect(AUTHORIZE).toMatch(
      /\[ "\$ATOMIC_BASE_FRESHNESS" = unprotectable \][\s\S]*quality-ci-billing-waiver\.js[\s\S]*LEASE_ADMIN=true/,
    );
  });

  it("never uses a billing admin merge on a protectable repository", () => {
    const restriction = AUTHORIZE.indexOf(
      '[ "$ATOMIC_BASE_FRESHNESS" != unprotectable ]',
    );
    const adminMerge = AUTHORIZE.indexOf("LEASE_ADMIN=true");
    expect(restriction).toBeGreaterThan(-1);
    expect(adminMerge).toBeGreaterThan(restriction);
    expect(AUTHORIZE).toMatch(
      /CI billing waivers are limited to plan-proven unprotectable private repositories/,
    );
    expect(SKILL).toMatch(
      /except on a plan-proven unprotectable private repository/,
    );
  });

  it("requires explicit opt-in to merge on an unprotectable base", () => {
    // Private repos without GitHub Pro get HTTP 403 on the protection API, so
    // ATOMIC_BASE_FRESHNESS can never become true and --merge is unsatisfiable
    // there, pushing operators to --admin (which skips EVERY gate, not just
    // this one). The escape hatch must be opt-in and off by default.
    expect(AUTHORIZE).toMatch(/BS_QUALITY_ALLOW_UNPROTECTABLE_BASE:-false/);
    expect(AUTHORIZE).toMatch(/ATOMIC_BASE_FRESHNESS=unprotectable/);
    expect(AUTHORIZE).toMatch(
      /case "\$ATOMIC_BASE_FRESHNESS" in[\s\S]*MERGE_MODE=strict[\s\S]*MERGE_MODE=protected-nonstrict-ref-cas[\s\S]*MERGE_MODE=unprotectable/,
    );
    expect(AUTHORIZE).toMatch(
      /\[ "\$ATOMIC_BASE_FRESHNESS" = unprotectable \]; then[\s\S]*gh pr checks "\$PR" --repo "\$EXPECTED_REPOSITORY" >\/dev\/null/,
    );
    expect(AUTHORIZE).toMatch(
      /else\s*\n\s*node "\$SCRIPT_DIR\/quality-required-checks\.js" assert/,
    );
    expect(
      AUTHORIZE.indexOf(
        'if [ "$ATOMIC_BASE_FRESHNESS" = unprotectable ]; then',
      ),
    ).toBeGreaterThan(AUTHORIZE.indexOf('case "$ATOMIC_BASE_FRESHNESS" in'));
  });

  describe("unprotectable-base classification", () => {
    const PLAN_LIMIT =
      "Upgrade to GitHub Pro or make this repository public to enable this feature.";
    const classify = (args) => {
      // The body travels as a FILE, never argv: command substitution and shell
      // arguments strip NUL bytes, which would normalize a malformed response
      // into a well-formed authorized one before the classifier sees it.
      const bodyFile = path.join(makeTempDir("protectability-"), "body.json");
      writeFileSync(bodyFile, args.body ?? "");
      try {
        execFileSync(
          "bash",
          [
            path.join(ROOT, "scripts/quality-base-protectability.sh"),
            "--private",
            args.private,
            "--rc",
            String(args.rc),
            "--body-file",
            bodyFile,
          ],
          { stdio: "pipe" },
        );
        return "unprotectable";
      } catch {
        return "blocked";
      }
    };

    it("accepts only a proven plan limit on a private repo", () => {
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{"message":"${PLAN_LIMIT}","status":"403"}`,
        }),
      ).toBe("unprotectable");
    });

    it("rejects a SUCCESSFUL response that merely quotes the upgrade text", () => {
      // A substring search over the body would authorize here. The request has
      // to have failed for a plan limit to be the explanation.
      expect(
        classify({
          private: "true",
          rc: 0,
          body: `{"required_status_checks":{"contexts":["${PLAN_LIMIT}"]}}`,
        }),
      ).toBe("blocked");
    });

    it("rejects a rate-limit 403 that embeds the plan-limit sentence", () => {
      // Throttling also returns 403, so comparing .message in full — not as a
      // substring — is what keeps a retryable failure from becoming an approval.
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{"message":"API rate limit exceeded. ${PLAN_LIMIT}","status":"403"}`,
        }),
      ).toBe("blocked");
    });

    it("rejects 404, unparseable output, and unknown privacy", () => {
      expect(
        classify({
          private: "true",
          rc: 1,
          body: '{"message":"Not Found","status":"404"}',
        }),
      ).toBe("blocked");
      expect(
        classify({ private: "true", rc: 1, body: "gh: connection refused" }),
      ).toBe("blocked");
      expect(
        classify({
          private: "unknown",
          rc: 1,
          body: `{"message":"${PLAN_LIMIT}","status":"403"}`,
        }),
      ).toBe("blocked");
    });

    it("rejects public repos, which can always be protected", () => {
      expect(
        classify({
          private: "false",
          rc: 1,
          body: `{"message":"${PLAN_LIMIT}","status":"403"}`,
        }),
      ).toBe("blocked");
    });

    it("rejects duplicate keys hidden behind JSON unicode escapes", () => {
      // Counting raw `"message":` occurrences in the text cannot see this: the
      // escaped key reads as zero occurrences, while any parser resolves it to
      // a second `message` that overwrites the rate-limit value with the
      // plan-limit one.
      const escaped =
        `{"message":"rate limited",` +
        `"m\\u0065ssage":"${PLAN_LIMIT}",` +
        `"status":"429","s\\u0074atus":"403"}`;
      expect(classify({ private: "true", rc: 1, body: escaped })).toBe(
        "blocked",
      );
    });

    it("rejects duplicate keys whose first value is a non-empty container", () => {
      // `jq --stream` emits paths for LEAVES, so a duplicate whose first value
      // is a non-empty object or array never produces a depth-1 key path and
      // slipped through the stream-based counter entirely. Only walking the
      // tokens and counting member names as they appear catches these.
      const cases = [
        `{"message":{"x":1},"message":"${PLAN_LIMIT}","status":403}`,
        `{"status":{"x":1},"status":403,"message":"${PLAN_LIMIT}"}`,
        `{"message":[1,2],"message":"${PLAN_LIMIT}","status":403}`,
        `{"message":{"a":{"b":[1,{"c":2}]}},"message":"${PLAN_LIMIT}","status":403}`,
        `{"m\\u0065ssage":{"a":[1]},"message":"${PLAN_LIMIT}","status":403}`,
      ];
      for (const body of cases) {
        expect(classify({ private: "true", rc: 1, body })).toBe("blocked");
      }
    });

    it("rejects duplicate keys at any depth, not just the top level", () => {
      // These do not change how message/status resolve, but "exactly one
      // unambiguous JSON object" has to hold for the whole document — an
      // ambiguous body is not the response GitHub sends.
      const nested = [
        `{"message":"${PLAN_LIMIT}","status":403,"details":{"reason":"a","reason":"b"}}`,
        `{"message":"${PLAN_LIMIT}","status":403,"metadata":[{"status":429,"status":403}]}`,
        `{"message":"${PLAN_LIMIT}","status":403,"d":{"reason":"a","r\\u0065ason":"b"}}`,
      ];
      for (const body of nested) {
        expect(classify({ private: "true", rc: 1, body })).toBe("blocked");
      }
    });

    it("compares the status value, not its string coercion", () => {
      // `String([403])` is "403", so a coercing check accepted {"status":[403]}
      // as a genuine 403 response.
      const wrapped = [
        `{"message":"${PLAN_LIMIT}","status":[403]}`,
        `{"message":"${PLAN_LIMIT}","status":[403,403]}`,
        `{"message":"${PLAN_LIMIT}","status":{}}`,
        `{"message":"${PLAN_LIMIT}","status":"403 "}`,
        `{"message":["${PLAN_LIMIT}"],"status":403}`,
      ];
      for (const body of wrapped) {
        expect(classify({ private: "true", rc: 1, body })).toBe("blocked");
      }
    });

    it("rejects bodies that are not valid UTF-8", () => {
      // Buffer.toString("utf8") rewrites invalid sequences to U+FFFD, which
      // would launder a body that is not valid UTF-8 JSON into one that parses.
      const bodyFile = path.join(makeTempDir("protectability-"), "body.json");
      writeFileSync(
        bodyFile,
        Buffer.concat([
          Buffer.from(`{"message":"${PLAN_LIMIT}","status":403,"x":"`, "utf8"),
          Buffer.from([0xff]),
          Buffer.from('"}', "utf8"),
        ]),
      );
      let verdict = "unprotectable";
      try {
        execFileSync(
          "bash",
          [
            path.join(ROOT, "scripts/quality-base-protectability.sh"),
            "--private",
            "true",
            "--rc",
            "1",
            "--body-file",
            bodyFile,
          ],
          { stdio: "pipe" },
        );
      } catch {
        verdict = "blocked";
      }
      expect(verdict).toBe("blocked");
    });

    it("fails closed on deeply nested input without crashing", () => {
      // Unbounded recursion raised an uncaught RangeError at ~5k nested
      // arrays. A depth limit turns that into an ordinary rejection.
      const body = "[".repeat(6000) + "]".repeat(6000);
      expect(classify({ private: "true", rc: 1, body })).toBe("blocked");
    });

    it("accepts GitHub's real response shape and formatting variants", () => {
      // The genuine body carries documentation_url alongside message/status,
      // and the status may be numeric. Extra non-conflicting fields are not
      // ambiguity, so tightening must not reject the real thing.
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{"message":"${PLAN_LIMIT}","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"403"}`,
        }),
      ).toBe("unprotectable");
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{\n  "message" : "${PLAN_LIMIT}" ,\n  "status" : 403\n}`,
        }),
      ).toBe("unprotectable");
    });

    it("rejects a plan-limit object smuggled into a larger response", () => {
      // Recovering a JSON fragment with sed/grep would accept every one of
      // these. The whole body has to be exactly one JSON object, so noise
      // around a genuine-looking object is unobserved, not unprotectable.
      const valid = `{"message":"${PLAN_LIMIT}","status":"403"}`;
      const smuggled = [
        `prefix ${valid}`,
        `${valid} suffix`,
        `gh: transport failure\n${valid}`,
        `{"message":"rate limited","status":"403"}\nnoise ${valid}`,
        `${valid}${valid}`,
      ];
      for (const body of smuggled) {
        expect(classify({ private: "true", rc: 1, body })).toBe("blocked");
      }
    });

    it("rejects a concatenated object that contributes no competing fields", () => {
      // jq streams multiple JSON values, so validating shape, status, and
      // message as separate invocations accepted `{}` + a valid object: the
      // empty object satisfied a per-value `type == "object"` test and emitted
      // nothing for .status/.message, letting the second object answer for the
      // whole body. Only a slurped `length == 1` check catches this, and the
      // two-valid-objects case above passed for an unrelated reason.
      const valid = `{"message":"${PLAN_LIMIT}","status":"403"}`;
      expect(classify({ private: "true", rc: 1, body: `{}${valid}` })).toBe(
        "blocked",
      );
      expect(classify({ private: "true", rc: 1, body: `${valid}{}` })).toBe(
        "blocked",
      );
    });

    it("rejects a body containing NUL bytes", () => {
      // Passing the body through a shell variable would silently strip NULs,
      // normalizing a malformed raw response into a well-formed authorized one.
      // The classifier reads a file and rejects NULs outright.
      const valid = `{"message":"${PLAN_LIMIT}","status":"403"}`;
      expect(classify({ private: "true", rc: 1, body: `\0${valid}` })).toBe(
        "blocked",
      );
      expect(classify({ private: "true", rc: 1, body: `${valid}\0` })).toBe(
        "blocked",
      );
    });

    it("rejects duplicate message/status keys", () => {
      // jq keeps the LAST occurrence, so a body that leads with a rate-limit
      // message and repeats the key with the plan-limit text would otherwise
      // parse as a genuine plan limit.
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{"message":"rate limited","message":"${PLAN_LIMIT}","status":429,"status":403}`,
        }),
      ).toBe("blocked");
    });

    it("requires the observed status to be 403", () => {
      // A body carrying the plan-limit message under any other status is not a
      // plan limit; bind the classification to the status GitHub reported.
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{"message":"${PLAN_LIMIT}","status":"500"}`,
        }),
      ).toBe("blocked");
      expect(
        classify({
          private: "true",
          rc: 1,
          body: `{"message":"${PLAN_LIMIT}"}`,
        }),
      ).toBe("blocked");
    });
  });

  it("states the unprotectable path is weaker, not an equivalent guarantee", () => {
    // GitHub exposes no base-SHA precondition on merge, so no client-side check
    // reconstructs atomic base freshness. The code must not claim it does.
    expect(AUTHORIZE).toMatch(/NON-ATOMIC base freshness/);
    expect(AUTHORIZE).toMatch(/base may advance before the merge lands/);
    expect(AUTHORIZE).toMatch(/not a reproduction of the strong one/);
  });

  it("fails closed if the pre-merge base re-read cannot be completed", () => {
    // `git ls-remote | awk` reports awk's status, not git's, and this script
    // does not set pipefail — a failed lookup with partial parseable output
    // would have read as a successful re-read. Capture before piping.
    expect(AUTHORIZE).toMatch(/FINAL_BASE_LS="\$\(git ls-remote/);
    expect(AUTHORIZE).toMatch(/could not re-read the base ref/);
    expect(AUTHORIZE).toMatch(/base ref lookup returned no OID/);
    expect(AUTHORIZE).toMatch(/-n "\$FINAL_BASE_OID"/);
  });

  it("falls back to the secondary provider on a bounded-budget timeout (rc 76)", () => {
    // A primary that merely ran slow used to block the merge outright: the
    // fallback branch gated on rc 75 (quota) and rc 2 (CLI missing) only, so
    // rc 76 fell through to "MERGE BLOCKED ... no usable fallback is
    // configured" even with fallback=claude set. The fallback exists for
    // precisely this case, so 76 must be inside the branch condition.
    const branch = RUN_REVIEW.slice(
      RUN_REVIEW.indexOf('if { [ "$PROVIDER_RC" -eq 75 ]'),
      RUN_REVIEW.indexOf('[ "$QUALITY_FALLBACK" != none ]; then'),
    );
    expect(branch).toMatch(/PROVIDER_RC" -eq 76/);

    // The blocked message must not assert a missing fallback without checking,
    // or a failed fallback run reads as a configuration error.
    expect(RUN_REVIEW).toMatch(/if \[ "\$QUALITY_FALLBACK" = none \]/);
    expect(RUN_REVIEW).not.toMatch(
      /bounded review budget and no usable fallback is configured/,
    );
  });

  it("falls back once when native Codex or Gemini parsing is inconclusive (rc 4)", () => {
    // Codex and Gemini both report parser-inconclusive output the same way
    // (rc=4) from their normalized-output parsers, so both must fail over.
    // Claude's rc=4 combines parser/timeout/unresolved-agent failures and
    // must stay fail-closed, so it is deliberately excluded here.
    expect(RUN_REVIEW).toMatch(
      /PRIMARY_HAS_STRUCTURED_RC4=false[\s\S]{0,80}case "\$QUALITY_PRIMARY" in[\s\S]{0,40}codex \| gemini\)/,
    );
    const branch = RUN_REVIEW.slice(
      RUN_REVIEW.indexOf('if { [ "$PROVIDER_RC" -eq 75 ]'),
      RUN_REVIEW.indexOf('[ "$QUALITY_FALLBACK" != none ]; then'),
    );
    expect(branch).toMatch(
      /PROVIDER_RC" -eq 4 \] && \[ "\$PRIMARY_HAS_STRUCTURED_RC4" = true/,
    );
    expect(branch).not.toMatch(/\[ "\$PROVIDER_RC" -eq 4 \] \|\|/);
    expect(RUN_REVIEW).toMatch(
      /review was inconclusive; switching once to \$QUALITY_FALLBACK/,
    );
    expect(RUN_REVIEW).toMatch(
      /4\)\s+echo "❌ MERGE BLOCKED: \$REVIEW_PROVIDER review was inconclusive \$FALLBACK_NOTE\."/,
    );
  });

  it("removes synthetic CI-only clean coverage", () => {
    expect(RUN_REVIEW).toMatch(/if \[ "\$TIER" = low \]; then/);
    expect(RUN_REVIEW).toMatch(/record-policy-exempt-review/);
    expect(RUN_REVIEW).toMatch(/record-incomplete-review/);
    expect(RUN_REVIEW).not.toMatch(/ci-only\.findings\.txt/);
    expect(RUN_REVIEW).not.toMatch(/record-advisory-review/);
  });

  it("preserves conclusive findings when a later primary pass is inconclusive", () => {
    const reviewOut = makeTempDir("quality-evidence-");
    writeFileSync(
      path.join(reviewOut, "codex.findings.txt"),
      "BLOCKING: src/example.js:12 — real finding\nFix it.\nINCONCLUSIVE: pass 2 parser failed\n",
    );
    writeFileSync(
      path.join(reviewOut, "codex-1.normalized.json"),
      JSON.stringify({
        verdict: "needs-attention",
        summary: "completed pass",
        findings: [{ severity: "high", title: "real finding" }],
      }),
    );
    writeFileSync(path.join(reviewOut, "codex-2.json"), "{}\n");
    writeFileSync(path.join(reviewOut, "codex-2.stderr"), "parse failure\n");

    execFileSync("bash", [
      PRESERVE_PRIMARY,
      "--review-out",
      reviewOut,
      "--mode",
      "parser-inconclusive",
    ]);

    expect(existsSync(path.join(reviewOut, "codex.findings.txt"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(
          path.join(reviewOut, "primary-codex-1.result.json"),
          "utf8",
        ),
      ).findings,
    ).toEqual([
      expect.objectContaining({ severity: "high", title: "real finding" }),
    ]);
    expect(
      readFileSync(
        path.join(reviewOut, "failed-primary", "codex.findings.txt"),
        "utf8",
      ),
    ).toContain("INCONCLUSIVE: pass 2 parser failed");
    expect(
      existsSync(path.join(reviewOut, "failed-primary", "codex-2.json")),
    ).toBe(true);
    expect(
      existsSync(path.join(reviewOut, "failed-primary", "codex-2.stderr")),
    ).toBe(true);
  });

  it("quarantines repeated primary evidence without replacing the authoritative result", () => {
    const reviewOut = makeTempDir("quality-collision-");
    writeFileSync(
      path.join(reviewOut, "primary-codex-1.result.json"),
      JSON.stringify({ findings: [{ title: "earlier evidence" }] }),
    );
    writeFileSync(
      path.join(reviewOut, "codex-1.normalized.json"),
      JSON.stringify({ findings: [{ title: "new evidence" }] }),
    );
    writeFileSync(
      path.join(reviewOut, "codex.findings.txt"),
      "INCONCLUSIVE:\n",
    );

    expect(() =>
      execFileSync("bash", [
        PRESERVE_PRIMARY,
        "--review-out",
        reviewOut,
        "--mode",
        "parser-inconclusive",
      ]),
    ).not.toThrow();
    expect(
      JSON.parse(
        readFileSync(
          path.join(reviewOut, "primary-codex-1.result.json"),
          "utf8",
        ),
      ).findings[0].title,
    ).toBe("earlier evidence");
    expect(
      JSON.parse(
        readFileSync(
          path.join(reviewOut, "failed-primary", "codex-1.normalized.json"),
          "utf8",
        ),
      ).findings[0].title,
    ).toBe("new evidence");
  });

  it("does not promote a marker-only inconclusive review to evidence", () => {
    const reviewOut = makeTempDir("quality-evidence-");
    mkdirSync(path.join(reviewOut, "unrelated"));
    writeFileSync(
      path.join(reviewOut, "codex.findings.txt"),
      "INCONCLUSIVE: parser failed\n\n",
    );

    execFileSync("bash", [
      PRESERVE_PRIMARY,
      "--review-out",
      reviewOut,
      "--mode",
      "parser-inconclusive",
    ]);

    expect(existsSync(path.join(reviewOut, "codex.findings.txt"))).toBe(false);
    expect(
      readFileSync(
        path.join(reviewOut, "failed-primary", "codex.findings.txt"),
        "utf8",
      ),
    ).toBe("INCONCLUSIVE: parser failed\n\n");
  });

  it("quarantines partial findings when the primary produced no evidence", () => {
    const reviewOut = makeTempDir("quality-evidence-");
    writeFileSync(
      path.join(reviewOut, "codex.findings.txt"),
      "BLOCKING: partial pass before timeout\n",
    );

    execFileSync("bash", [
      PRESERVE_PRIMARY,
      "--review-out",
      reviewOut,
      "--mode",
      "evidence-absent",
    ]);

    expect(existsSync(path.join(reviewOut, "codex.findings.txt"))).toBe(false);
    expect(
      readFileSync(
        path.join(reviewOut, "failed-primary", "codex.findings.txt"),
        "utf8",
      ),
    ).toContain("partial pass before timeout");
  });

  it("persists and reloads the exact reviewed base across fenced shells", () => {
    expect(RUN_REVIEW).toMatch(/quality-invocation\.js" record-review/);
    expect(RUN_REVIEW).toMatch(/--from "\$REVIEW_DIFF_BASE"/);
    expect(RUN_REVIEW).toMatch(/--to "\$REVIEWED_HEAD"/);
    expect(SKILL).toMatch(/contiguous review checkpoints/);
  });

  it("does not downgrade a successful primary critical review to incomplete", () => {
    // Fallback is availability-only. A clean Codex primary result must become
    // ordinary complete evidence; otherwise the no-fallback path records a
    // successful review that the merge authority can never consume.
    expect(RUN_REVIEW).not.toMatch(/INCOMPLETE_DISCOVERY_ARGS/);
    expect(RUN_REVIEW).not.toMatch(
      /Critical discovery used one configured provider/,
    );
  });

  it("Quality-Findings is explicitly deterministic, not a model vote", () => {
    expect(SKILL).toMatch(/zero deterministic findings/);
    expect(SKILL).toMatch(/lead becomes merge-blocking only when converted/);
  });

  /** The gate is worthless if the model never sees it — see check-skill-size.sh. */
  it("SKILL.md stays inside the compaction re-attach budget", () => {
    // Exits non-zero if any SKILL.md exceeds ~5000 tokens, at which point
    // everything past the cutoff (including these merge gates) is silently
    // dropped after any compaction. That is how the gates vanished in the first
    // place — the file was 17,394 tokens and the gates lived at the tail.
    const out = execFileSync(
      "bash",
      [path.join(ROOT, "scripts/check-skill-size.sh")],
      {
        encoding: "utf8",
      },
    );
    expect(out).toMatch(/within the .* budget/i);
  });
});
