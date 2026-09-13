# Quality assurance contract v1

The public contract is the small interchange surface for any Claude Code or
Codex builder. Internal leases, retries, and provider lifecycle state remain
private runtime details.

Validate an envelope:

```bash
node scripts/quality-assurance-contract.js assurance-envelope.json
```

The schema at
`scripts/schemas/quality-assurance-envelope.schema.json` binds requirements,
repository/base/head/candidate identity, risk, deterministic gates, advisory
review evidence, terminal result, and an optional merge receipt. Existing v1
fields are stable; additive data requires a new schema version when it changes
consumer interpretation.

Terminal results have deliberately narrow meanings:

- `passed`: deterministic evidence is complete for the exact candidate.
- `blocked`: a deterministic gate, authorization, freshness, or policy check
  failed.
- `incomplete`: required evidence is unavailable or malformed; it is never a
  clean result.

Use `scripts/test-impact.js <changed-files...>` for the test plan. JS/TS uses
the configured Vitest or Jest related-test selector. Plain Node suites run each
changed `.js`, `.mjs`, or `.cjs` test file directly. TypeScript tests and Node
source files still need a mapping.
Changed Python tests run directly, and prose-only documentation needs no
behavioral test. Files without a sound native selector use committed
path-to-command mappings in
`.buildproven/test-impact.json`. An uncovered executable path returns
`unmapped` and blocks authorization with a remediation unless the repository
declares an explicit `fallback`. A fallback runs the complete native gate only
for uncovered paths. It does not affect mapped, related-test, direct-test, or
documentation-only changes. Glob patterns use
Node path-glob syntax; a pattern ending in `/` explicitly covers that directory
prefix.

Use the protected base policy in trusted CI controllers by passing
`--policy-root <protected-checkout>`. Candidate code remains the execution root;
the candidate cannot replace its own selector policy.
The persisted test gate binds the policy's SHA-256 digest, so a policy edit after
manifest creation cannot change the command selection.

The impact plan intentionally selects the normal test gate after the repository
declares its complete/native gate. That native gate remains the bootstrap and
policy-change safety net: when `.buildproven/test-impact.json` itself is added or
changed, the current diff cannot authorize its own narrower evidence, so the
pre-existing complete gate runs once. After that policy is on the base branch,
ordinary diffs use its affected-test selection.

A complete regression is an explicit `audit` rule with a reason, reserved for
scheduled selector audits, releases, dependency/test-infrastructure changes
that genuinely invalidate scoped evidence, or an approved risk exception. The
normal exact-candidate gate uses the smallest evidence-backed selection. Reuse
already successful evidence for the identical candidate rather than repeating
it locally or in CI.

The task-completion hook uses this same selector for staged, unstaged and
untracked working-tree paths. It reports an unmapped or failed selection early,
but it is local feedback only; exact-head quality and product-completion evidence
remain owned by the revision-bound quality runtime.

Example policy:

```json
{
  "version": 1,
  "jsRunner": "vitest",
  "mappings": [
    {
      "paths": ["STRATEGY.md"],
      "commands": [
        {
          "executable": "pytest",
          "args": ["tests/test_direction_consistency.py"]
        }
      ]
    }
  ],
  "audits": [
    {
      "paths": ["package-lock.json"],
      "reason": "dependency graph changed",
      "commands": [{ "executable": "npm", "args": ["test"] }]
    }
  ],
  "fallback": [{ "executable": "npm", "args": ["test"] }]
}
```

Use `scripts/quality-ci-evidence.js` to ingest one trusted GitHub Actions check.
It reuses a cached result only for the identical repository, workflow, check,
base SHA, candidate SHA/kind, GitHub Actions source, URL, and successful
conclusion. Any identity change fetches again or fails closed.
