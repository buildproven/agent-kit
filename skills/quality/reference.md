# Quality Reference — Flags, Scopes, Levels, and Modes

## Target Resolution (Step -1)

### Invocation manifest and isolation

Bootstrap creates one schema-versioned JSON manifest and prints its exact path.
Every later entrypoint requires `--manifest <that-path>` and validates the
repository realpath, PR, base SHA, and expected HEAD before reading or writing
state. There is no session sentinel, active-state glob, mtime lookup, or
`latest` pointer.

`scripts/quality-run.js --manifest <exact-path>` is the public phase runner.
It persists versioned orchestration progress under the same manifest lock and
reuses exact-head gate, mutation, and review evidence on resume. Its JSON result
is `complete`, `terminal`, `action-required`, or `work-required`. Exit 3 is
reserved for a named external capability or branch-governance action. Exit 4
requests bounded local lead verification or remediation and must resume the
same manifest. Gate, stale-head,
provider-contract, CI, and signal
failures retain their typed terminal state and one idempotent telemetry record.
An exhausted incomplete review cannot become `verified-unmerged`; it records
`provider-incomplete`. Merge success requires exact-head `merged` terminal
evidence from the protected merge transaction, not only process exit zero.

Risk resolution also records a deterministic task type from the branch commit
range and, when commit intent is unavailable, an all-specialized path set:
`docs`, `ci`, `build`, `chore`, `feature`, `bugfix`, `performance`, or
`unknown`. Bug-fix and performance work impose the non-security high-review
floor; feature work imposes the standard floor. Task routing can raise review
depth but never lower path, magnitude, or security floors. The initial type is
reused while advancing the same campaign so remediation commit labels do not
change its identity or budget.

The state directory is:

```text
$TMPDIR/bs-quality/<repo-hash>/pr-<number|none>/<base-sha>/<invocation-id>/
```

Provider artifacts add `reviews/<head-sha>/round-N/`. Safe resumption is
explicit and accepts only a descendant HEAD. Each successful checkpoint
records its exact `from..to` range and diff hash, allowing fix rounds to review
only `previousReviewedHead..currentHead` while final evidence remains bound to
the complete base/final-HEAD relationship.

Merge authority is distinct from review depth and is persisted in the manifest
at risk resolution. The global default is `autonomous`: a clean critical review
merges without a human hop. Quality stops rather than merges when findings,
provider output, CI, revision identity, or review coverage are unresolved.

Repositories that need manual governance can explicitly set
`scorePolicy.mergeAuthority` to `human-required`. Only that opt-in enables
break-glass approval: a signed outer-wrapper capability bound to repository key,
PR, HEAD, invocation ID, approver, issue time, and expiry. Nested autonomous
quality processes have no approval-mint command. HEAD changes and expiry fail
closed.

**Bug fixed 2026-05-11**: when invoked as `/bs:quality --merge` with PR
context in the natural-language args (e.g. `#410`, `codex/foo`, or a
worktree path), prior versions ignored those references and audited
whatever happened to be in the operator's cwd — producing irrelevant
reports about uncommitted changes in the primary checkout. Target
resolution (in `scripts/quality-bootstrap.sh`, calling
`scripts/quality-target-resolver.js`) honors, in priority order:

1. **Explicit PR number** in args (`#NNN`, `PR NNN`, `pr#NNN`, `pull/NNN`, or
   `--pr NNN`) — `gh pr view <N> --json headRefName` resolves the head
   branch, then we look up the local worktree.
2. **Branch name** in args (e.g. `codex/foo`, `feat/bar`) or via `--branch`
   — find the local worktree for that branch.
3. **Worktree path** via `--target-dir <path>` / `--target <path>` /
   `--worktree <path>` or any bare absolute-path arg that exists.
4. **cwd is a non-primary worktree** — audit cwd's diff vs base ("I'm
   working in my feature branch worktree" case).
5. **Fallback: primary checkout** — only with a LOUD warning. **Forbidden
   under `--merge`** — `--merge` hard-refuses to fall through to (5).

The parsing + resolution logic is pure and unit-tested at
`scripts/__tests__/quality-target-resolution.test.js`; the bootstrap script
calls it as a subprocess and acts on the JSON result. If no local worktree
exists for a resolved PR/branch, `scripts/worktree-manager.js` materializes it
under the canonical sibling `.worktrees/<repo-name>/<branch-slug>` container,
so repeat invocations reuse it deterministically.

## Reviewer Provider Policy

Claude Code, Codex, and the opt-in Gemini quality adapter read the shared workflow policy at
`${XDG_CONFIG_HOME:-~/.config}/buildproven/agent-providers.json`. Configure it
with `scripts/provider-config.sh --primary codex --fallback claude`
(or reverse the providers). Gemini is accepted only by the quality-specific
policy surface; select it explicitly with `BS_QUALITY_PRIMARY=gemini` or
`BS_QUALITY_FALLBACK=gemini`. The Gemini leg runs the installed `gemini` CLI in
bounded, read-only plan mode and validates its JSON response against the same
strict review schema as Codex. `BS_QUALITY_PRIMARY`, `BS_QUALITY_FALLBACK`, and
`BS_QUALITY_PROVIDER_CONFIG` are per-run overrides. The fallback runs for typed
account exhaustion (HTTP 429, weekly/rate/usage limit, exhausted quota), an
unavailable CLI, or — when `BS_QUALITY_FALLBACK_ON_TIMEOUT=1` (the default) — a
primary that exhausts its bounded review clock without converging (a degraded
primary shouldn't block a merge while a healthy fallback is idle). It does NOT
run when the primary reports code findings.

For the Wave 3 comparison, `--review-arm native` assigns Codex primary with
Claude fallback and `--review-arm bespoke` assigns Claude primary with Codex
fallback. Bootstrap persists both the assigned arm and resolved provider order
at campaign creation. Telemetry records the assigned arm, actual reviewer,
effort, nullable provider token count, and explicit artifact character/token
estimates separately; provider fallback therefore does
not corrupt intent-to-treat attribution. Campaigns without an explicit arm
keep ordinary provider policy and infer the received arm from the actual
reviewer.

Selected Claude reviewers share a cancellation sentinel: the first exhausted
reviewer causes sibling process groups to terminate. Medium and High select
one reviewer by changed-domain evidence; Critical selects `code-reviewer` plus
one distinct domain specialist or the reliability backstop. Every selected
reviewer must return usable evidence. A successful review records HEAD; later
fix rounds use that SHA as their diff base so unchanged commits are not
reviewed again. Bootstrap clears this state for every new invocation.

When structured exhaustion metadata includes a reset timestamp, quality prints
that timestamp and the exact manifest-bound retry command. The terminal
diagnosis reports repository gates, provider checkpoint, merge-authority state,
and GitHub CI separately; it does not flatten quota, parser, billing/auth,
code-finding, and CI failures into one generic merge message.

### Remote dispatch claim retention

Protected-check dispatch claims use lightweight Git refs under the versioned
`buildproven-dispatch-claim-v3/` and `buildproven-dispatch-claim-v3-meta/`
namespaces. The deterministic claim ref remains the atomic cross-host nonce
claim; the separate timestamped metadata ref records the issue time. Creating
metadata before the claim means a losing race leaves no unreferenced Git
object. Prune
expired claims with the bounded operator command (default retention: 24 hours):

```bash
node scripts/quality-required-checks.js cleanup-claims --repo owner/name
```

The cleanup command deletes only expired annotated claim refs. It retains
claims with missing or invalid metadata and never deletes legacy lightweight
claim refs in the original `buildproven-dispatch-claim/` or v2 namespaces.
Those legacy refs are quarantined and do not suppress v3 claims. Run cleanup from a
scheduled maintenance process, not from every quality invocation.

## Regression History

- **2026-05-11**: target resolution ignored PR/branch args in favor of
  operator cwd (see above) — fixed by the resolver + priority order.
- **2026-05-12**: `Skill(args=...)` did not propagate into a forked skill's
  `$@`. The temporary args-file bridge was removed in July 2026 in favor of
  direct arguments plus the structured invocation manifest.
- **2026-05-13**: cwd and shell vars set in one fenced bash block do not
  survive into the next — every step must restore `$GIT_ROOT` via the
  sentinel dance in `quality-load-root.sh`, or silently operate on the
  fork's raw harness cwd instead of the resolved target.
- **2026-05-21**: the skill bailed to "investigation mode" after a
  successful Step -1 resolution because the worktree had uncommitted
  artifacts from a parallel session — fixed by the explicit "never divert"
  guard at the top of SKILL.md.
- **2026-06-04**: a review child could re-enter `/bs:quality` via a hook,
  agent, or stray `/goal`, causing fork → review child → fork recursion —
  fixed by the `BS_QUALITY_HEADLESS=1` guard in `quality-bootstrap.sh`.
- **2026-07-01**: review agents were spawned via the Task tool. Task-tool
  agents are fire-and-forget — results arrive asynchronously as
  notifications to the PARENT session, never inside the fork's turn — so the
  merge gate downstream of review never ran. This was the #1 way `--merge`
  silently failed to complete; confirmed structural (nested Task agents are
  async too — also breaks inside Task-agent callers).
  Fixed by running review as a blocking subprocess
  (`scripts/claude-review-companion.sh`, invoked from
  `scripts/quality-run-review.sh`).
- **2026-07-01**: `test-generator` was removed from the agent panel — it had
  no agent `.md` file anywhere, and an unresolvable agent is marked
  INCONCLUSIVE by the review runner, which permanently blocks high/critical
  merges. `pr-test-analyzer` covers test quality instead.
- **2026-07-03**: two PRs in one night ran 128min/6 commits and 167min/13
  commits with no circuit breaker on the outer fix→re-review cycle — see
  "Run Governor — Incident History" below for the full writeup and the
  mid-poll wall-clock recheck this produced.
- **2026-07-10**: the review runner (`claude-review-companion.sh`) and the
  governor script were each resolved by checking exactly two hardcoded
  paths. On the primary install (`~/.claude/scripts` → an overlay repo that
  never carried either script) both missed, `bash <missing>` returned 127,
  and the skill printed "MERGE BLOCKED (rc=127)" after doing all the other
  work — the "runs everything, then never merges" stall. Fixed by
  `bs_quality_find_script()` (in `quality-load-root.sh`), which checks every
  known install layout and fails loud if none match.
- **2026-07-10**: `TIER`, `AGENT_COUNT`, and `QUALITY_PIPELINE_RAN` were bash
  variables set in one fenced block (Step 1.8 / Step 2.5) and read in a
  later block (Step 4) — which always saw the `:-false`/empty default
  because bash vars don't cross fenced blocks. Consequences: the auto-stamp
  trailer branch could never fire, and the high/critical Codex XOR gate
  compared `TIER` against `""` and silently failed OPEN. Fixed by the
  `BS_QUALITY_RUNSTATE_FILE` sentinel (same pattern as the git-root and
  governor sentinels) written at the end of Step 2.5's Review Stamp and
  loaded at the top of Step 4.
- **2026-07-11 (#70)**: SKILL.md itself was ~17,300 tokens — the auto-
  compaction re-attach budget is the first 5,000 tokens of each skill (see
  https://code.claude.com/docs/en/skills#skill-content-lifecycle), so
  everything from original Step 1 onward (including the round-cap gate,
  judge synthesis, and all of Step 4's merge gates) was silently dropped
  after any mid-run compaction — exactly the failure mode most likely in the
  long sessions `--merge` runs produce. Fixed by this progressive-disclosure
  split: SKILL.md keeps only the execution flow, the three must-survive
  gates (round cap, companion/model resolution, Step 4 merge gates), and
  navigation pointers; everything else moved to `reference.md`,
  `checklist.md`, or `scripts/`. A CI check (`scripts/check-skill-size.sh`,
  wired as a hard gate in `.github/workflows/quality.yml`) now fails the
  build if any `SKILL.md` in the repo exceeds the budget again.

## Step 1.3: Hard Test Gate — Implementation

Behavioral test evidence must be reviewed and the suite must pass. This is a
hard blocker, not advisory (skip with `--skip-tests` for config-only repos).
SKILL.md Step 1.3 states the rule; the mechanics are here.

**1.3a — Behavioral test evidence signal.** A source-file-to-test-file mapping
is not a valid quality target: behavior often crosses several files and should
be tested once at a stable public seam. Mechanically detect only the strongest
gap signal—production behavior changed but no test changed—then hand it to the
test reviewer to inspect existing coverage.

```bash
bash "$HOME/.claude/scripts/quality-load-root.sh" --manifest "<exact-manifest-path>"
GIT_ROOT="$(node "$HOME/.claude/scripts/quality-invocation.js" field "<exact-manifest-path>" repo.realpath)"
cd "$GIT_ROOT"

CHANGED_SRC=$(git diff --name-only main...HEAD | grep -E '\.(ts|tsx|js|jsx|py|rb|go)$' | grep -v -E '\.(test|spec)\.|(^|/)test_.*\.py$|_test\.(py|go)$' || true)
CHANGED_TESTS=$(git diff --name-only main...HEAD | grep -E '(^|/)(test|tests|spec|__tests__)/|\.(test|spec)\.|(^|/)test_.*\.py$|_test\.(py|go)$' || true)

if [ -n "$CHANGED_SRC" ] && [ -z "$CHANGED_TESTS" ]; then
  echo "⚠️ Production behavior changed with no test delta."
  echo "   This is a review signal, not proof of missing coverage: inspect existing"
  echo "   tests at the public seam before requesting a new test."
  TEST_GAPS="Production behavior changed with no test delta; verify existing behavioral coverage."
fi
```

**1.3b — Run tests (hard gate).**

```bash
bash "$HOME/.claude/scripts/quality-load-root.sh" --manifest "<exact-manifest-path>"
GIT_ROOT="$(node "$HOME/.claude/scripts/quality-invocation.js" field "<exact-manifest-path>" repo.realpath)"
cd "$GIT_ROOT"

npm test 2>&1
TEST_EXIT=$?

if [ $TEST_EXIT -ne 0 ]; then
  echo "❌ Tests failed — attempting auto-fix (up to 3 attempts)"
  for attempt in 1 2 3; do
    echo "Fix attempt $attempt/3..."
    npm test 2>&1
    TEST_EXIT=$?
    if [ $TEST_EXIT -eq 0 ]; then break; fi
  done
  if [ $TEST_EXIT -ne 0 ]; then
    echo "❌ HARD FAIL: Tests still failing after 3 fix attempts"
    echo "Cannot proceed to review agents with broken tests."
    exit 1
  fi
fi
echo "✅ All tests passing"
```

**1.3c — Test-gap reporting.** There is no `test-generator` review agent (it
had no agent definition and was removed from the panel on 2026-07-01;
`pr-test-analyzer` covers test quality). `$TEST_GAPS` is surfaced in the
review context and the summary as a coverage signal for the human, not
handed to an auto-generator. If tests are generated or edited as part of the
auto-fix loop, re-run `npm test` to verify they pass before continuing.

## Flags

| Flag                                 | Default | Description                                                                                  |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `--level N`                          | auto    | Quality level: `auto` (read tier from harness-config.json), `95`, or `98`                    |
| `--scope S`                          | branch  | Revision-bound branch scope; other values fail fast                                          |
| `--merge`                            | false   | Auto-merge PR after quality                                                                  |
| `--skip-tests`                       | false   | Skip hard test gate (config-only repos)                                                      |
| `--verify-app`                       | false   | Add the `verify-app` gate: boot the app and browser-check the root page (BUI-306, see below) |
| `--pr <number>`                      | -       | Bind to one open PR                                                                          |
| `approve --pr <number> --head <sha>` | -       | Legacy `human-required` policy only: mint signed approval for one exact PR/HEAD              |
| `--manifest <path>`                  | -       | Resume one exact persisted invocation; accepts no other flags                                |
| `--target-dir <path>`                | -       | Run against this repo (use when invoking from a forked/agent context with no inherited cwd)  |

### Quarantined runner recovery

A dead runner with `childInFlight: true` stays unavailable until child
quiescence is proved. Use `scripts/quality-runner-reconcile.js` with the exact
manifest, current head, owner host, PID, and nonce. Schema-v2 ownership proves
the recorded process group absent. A legacy schema-v1 record also requires
`--confirm-legacy-child-quiescent` after explicit process-tree inspection. The
reconciler removes only the exact fenced ownership file; it does not change the
manifest, budgets, reviews, or terminal history. See
`docs/decisions/ADR-quality-runner-reconciliation.md` for the command contract.

### `--verify-app` gate (BUI-306)

Every deterministic gate up to this point (lint/type/build/test/security/
consumer) proves the code compiles and its own test suite passes — none of
them boot the app, so "green" has never meant "the thing runs." `--verify-app`
closes that gap by discovering an additional `verify-app` required gate,
implemented in `scripts/quality-verify-app.sh` and invoked exactly like every
other gate through `quality-run-gate.sh` (same recording, same reuse-on-
unchanged-HEAD, same evidence contract). It is opt-in only — never discovered
without the flag — because booting a real process/browser is slower and more
environment-sensitive than a static gate.

Project-type detection is `package.json`-only, in this order:

- **web** — `scripts.dev` or `scripts.start` exists, the process binds a
  discoverable port, and an HTTP probe of that port returns HTML. The gate
  drives `agent-browser` (see `skills/agent-browser/SKILL.md`) to load the
  root page, then reads `agent-browser errors --json` and
  `agent-browser console --json` and fails if either reports a JS error /
  `console.error`.
- **server** — a dev/start script exists but the booted port does not answer
  with HTML (JSON API, gRPC, raw TCP, ...). The gate only requires the
  process to bind its port and stay alive past the boot window; no browser
  is invoked.
- **CLI** — no dev/start script, but `package.json#bin` is set. The gate runs
  `<bin> --help` and requires a clean exit.
- **library** — none of the above. There is no runnable entrypoint, so the
  gate exits 0 immediately with a "not applicable" message. It cannot use the
  manifest's `status: "skipped"` path — `quality-invocation.js`
  `gateEvidenceInput` hard-restricts that status to the `test` gate only, so
  every other required gate (including `verify-app`) must report `success`
  or `verifyGateEvidence` blocks the campaign. A library therefore records a
  genuine clean pass, not a skip.

Port discovery order: `.quality-app-flows.json`'s `"port"` field, then a
literal `PORT=<n>` / `--port <n>` / `-p <n>` / `:<n>` found in the dev/start
script string, then the conventional default `3000`. Boot and page timeouts
default to 45s/30s and are overridable via `QUALITY_VERIFY_APP_BOOT_TIMEOUT`
and `QUALITY_VERIFY_APP_PAGE_TIMEOUT`.

The zero-config baseline — root page loads, zero JS errors, zero
`console.error` — requires no repo opt-in beyond `--verify-app` itself, per
BUI-306's own "no per-repo config bloat" resolution. A repo that wants deeper
checks may declare 1+ named flows in a `.quality-app-flows.json` at the repo
root:

```json
{
  "port": 3000,
  "flows": [
    {
      "name": "login",
      "steps": ["open /login", "wait --load networkidle", "click @e1"]
    }
  ]
}
```

Each step is one literal `agent-browser` subcommand + args (no shell
metacharacters, no chaining); the gate runs each step in order and fails the
same way as the baseline load if any step exits non-zero or the flow leaves
behind a JS error. This file is entirely optional — its absence is not an
error and does not change the baseline check.

A repository can also override the gate's command entirely via
`.quality-gates.json`'s native-gate policy (`gates.verify-app`, same schema as
every other native gate name); the script above is only the default.

### Environment Variables

| Variable                              | Default | Description                                                                                                                                                                                            |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BS_QUALITY_PRIMARY`                  | config  | Per-run primary override: `claude`, `codex`, or opt-in `gemini`.                                                                                                                                       |
| `BS_QUALITY_FALLBACK`                 | config  | Per-run fallback override: `claude`, `codex`, opt-in `gemini`, or `none`.                                                                                                                              |
| `BS_QUALITY_FALLBACK_ON_TIMEOUT`      | `1`     | On `1`, a primary timeout fails over once. Set `0` to hard-block on the first timeout.                                                                                                                 |
| `BS_QUALITY_PROVIDER_HEALTH_FILE`     | state   | Operator-state provider circuit file/prefix. Legacy aggregate files are read; writes use race-safe per-provider records beside it.                                                                     |
| `BS_QUALITY_CI_BILLING_WAIVER_UNTIL`  | config  | ISO timestamp overriding `ciBillingWaiverUntil` in the shared provider config; authorizes only exact-HEAD zero-runner/zero-step Actions failures.                                                      |
| `BS_QUALITY_TARGET_DIR`               | -       | Default target repo path for forked/agent invocations. Precedence: `--target-dir` > env var > cwd.                                                                                                     |
| `BS_QUALITY_MAX_FIX_COMMITS`          | 1       | May lower the one-commit batched-remediation cap; values above the hard maximum are rejected.                                                                                                          |
| `BS_QUALITY_MAX_REVIEW_ROUNDS`        | 2       | May lower the discovery-plus-verification cap; values above the hard maximum are rejected.                                                                                                             |
| `BS_QUALITY_MAX_PROVIDER_ATTEMPTS`    | 2       | May lower the primary-plus-one-fallback start allowance per review pass. The runtime reserves the same allowance for the one exact-head verification pass; values above the hard maximum are rejected. |
| `BS_QUALITY_MAX_REMEDIATION_SECONDS`  | planned | Batched-fix allowance remaining after proportional discovery and verification reserves.                                                                                                                |
| `BS_QUALITY_REREVIEW_RESERVE_SECONDS` | planned | Workload-scaled allowance for one targeted validation review after fixes.                                                                                                                              |
| `BS_QUALITY_TELEMETRY_FILE`           | -       | Absolute path for the campaign telemetry log. Default: operator state under `$XDG_STATE_HOME/claude-kit/quality-telemetry/` (or `~/.local/state`).                                                     |
| `BS_QUALITY_ALLOW_UNPROTECTABLE_BASE` | `false` | Accepts non-atomic base freshness on a private repo whose plan cannot enforce branch protection at all. See below.                                                                                     |

### `BS_QUALITY_ALLOW_UNPROTECTABLE_BASE` (base-protection escape hatch)

`scripts/quality-authorize-merge.sh` normally requires the PR base to carry
server-enforced strict required-status checks (classic branch protection or an
equivalent ruleset) before it will authorize a merge. That guarantee is
**atomic**: GitHub itself refuses to advance the base out from under the merge,
so the reviewed diff and the merged diff are provably identical.

Some plans can't supply that guarantee at all — most commonly a **private**
repo without the GitHub tier/rulesets needed to configure required-status
checks. On such a repo, strict protection isn't "unconfigured", it's
unconfigurable, and the gate would block every merge forever.

Setting `BS_QUALITY_ALLOW_UNPROTECTABLE_BASE=true` lets `quality-authorize-merge.sh`
proceed anyway, but only after it proves the repo genuinely can't protect the
branch — never merely that protection is off. That classification runs in
`scripts/quality-base-protectability.sh`, which requires all of:

- the repo is private (`gh api repos/<repo>` `.private == true`) — a public repo
  can always be protected, so this alone fails closed;
- the branch-protection API call itself failed (non-zero `gh` exit status);
- the failure body is a genuine plan-limit response, parsed by
  `scripts/quality-parse-plan-limit.js` from a STDOUT-only capture (stderr is
  never merged in, so a malformed or injected body can't be recovered into a
  well-formed one).

Any other outcome — API error, rate limit, ambiguous body, unreadable
response — is treated as "protectable or unknown" and the merge stays
blocked. The classifier fails closed on every ambiguity by design.

**What's weakened when it's on:** the base-freshness check becomes
best-effort instead of atomic. The base branch can advance between the
review and the merge landing, so the diff GitHub actually merges is no
longer guaranteed identical to the diff that was reviewed. This is an
accepted, narrowly-scoped trade for repos with no other option — leave it
unset unless `quality-authorize-merge.sh` reports the base as unprotectable
on your plan.

### Protected non-strict ref-CAS

A protected branch with non-empty required checks and GitHub `strict: false`
is not unprotectable. A clean campaign with `mergeAuthority=autonomous` may use
the protected non-strict ref-CAS path without an operator prompt only when the
repository commits `scorePolicy.protectedNonstrictRefCas` as
`"accept-non-atomic-pr-state"`. The default is `"signed-only"`. The explicit
policy accepts the unavoidable concurrent close-or-retarget race once instead
of asking on every later green PR. Risk resolution reads it from the exact
protected-base commit, binds that source SHA in the manifest, and the lease
re-reads the same revision at the mutation boundary. A candidate cannot add the
authority that it consumes. `mergeAuthority` is resolved and rebound from that
same base policy so a candidate cannot remove manual governance either. The lease
independently rechecks complete exact-head review and gates, green required
checks, App bindings, the complete classic-protection digest, resolved
conversations, exact identity, and ancestry immediately before its non-force
update.

The separate signed `operator-nonstrict-refcas-override` remains the exception
path. During a classified Actions billing outage, it binds `ci:failed` and the
exact outage artifact. If provider discovery is exhausted, the same capability
also binds `review:provider-exhaustion`. Every included condition requires its
category-specific acknowledgement; two separate capabilities cannot be
composed after signing.

For an exception, the final repository lease reloads the signed capability and
requires enough remaining validity for the bounded request. For the autonomous
green path, it reruns provider-neutral review authorization and required CI
validation. Both paths recheck the live base, protection digest, administrator
permission, immediate PR identity, head ancestry, and every required review
conversation. The direct immutable-head integration cannot atomically bind a
concurrent PR close or retarget. It updates only the exact base ref to the exact
reviewed head through GitHub's ref API with `force: false`. A verified
non-fast-forward rejection releases only the short operation guard and keeps
the campaign lease resumable. Any other uncertain response stays quarantined
until exact integration or exact closed-without-merge state is proven.

### Run Governor (runaway-loop guardrails)

Two PRs run in one night (#529: 128min/6 commits, #532: 167min/13 commits)
completed with no circuit breaker — `CODEX_ROUNDS` only bounds provider
discovery, not the outer cycle of lead → deterministic verification → fix →
delta discovery across the whole invocation. `scripts/quality-run-governor.js`
tracks governor state inside the explicit invocation manifest with:

#### Fixed-cost repository gates

Diff size controls review depth and the initial per-gate slice. Test selection
is independent: the repository's test-impact evidence chooses the smallest
affected set, reports unmapped paths instead of guessing, and uses a complete
suite only for an explicit audit. A micro change therefore retains a
120-second planned check slice plus enough bounded reserve when a legitimate
audit gate needs it.
The shared ledger is allocated up front for the initial exact head and the one
permitted remediation head, so advancing after review cannot mint more time.
Within each pass, time used by lint or another gate reduces what remains for
tests. Nothing becomes unbounded: a hung command is killed at the smaller of
its slice plus reserve and the remaining global gate ledger, and the governor
still permits at most one fix commit. This floor prevents tiny changes in
repositories with large integration suites from timing out solely because the
diff is small (BUI-389).

- **Fix-commit cap** (`BS_QUALITY_MAX_FIX_COMMITS`, default and hard maximum
  1. — one batched remediation commit, checked before every fix attempt and
     verification. Environment configuration may lower this cap but cannot raise
     it. The review-round and provider-attempt hard maxima are 2 under the same
     rule.
- **Proportional phase caps** — changed lines plus 25 units per changed file
  select a micro/small/medium/large/huge band. The whole default campaign is
  capped at 900 seconds. Critical discovery receives up to 540 seconds based on
  measured xhigh review latency; lower-risk discovery and the single
  verification reserve remain workload-scaled inside that campaign cap.
- **Two-review convergence** — one discovery review and one targeted
  delta discovery are allowed. A deterministic failure discovered by
  verification is reported as the terminal result; it cannot trigger another
  fix/review recursion.
- **Repeated-pattern detection** — findings are recorded round-over-round;
  if a round's findings mostly repeat a shape seen in an earlier round (e.g.
  the same on-disk-vs-loaded-job gap at 4 different call sites), the skill is
  told to batch-fix every matching call site in one commit instead of
  spending a separate round per occurrence.
- **Live status** — every round prints `[quality] elapsed Xm/Ym, fix-commits
N/M` so the operator can see the loop's position in real time, not just in
  the final summary.

**On a tripped cap**, the skill hard-stops autonomous continuation — no
further rounds, no `--merge` — and hands back a plain-text summary of what
was tried and why it did not converge. Repeating the unchanged request resumes
the same exhausted campaign; environment changes cannot mint a replacement
budget. A code finding must be addressed in a new commit and reviewed as a new
HEAD. The skill never raises its own cap.

**`BS_QUALITY_TARGET_DIR` usage**: when a spawning harness (e.g. a Task agent
running in an isolated worktree) exports this env var, every forked
`/bs:quality` invocation in that scope auto-targets the right repo without
needing `--target-dir` on each call. Prevents the "forked skill silently
scanned the agent's cwd" failure mode.

### Campaign telemetry (closed-loop value measurement)

At the terminal step (SKILL.md Step 6), the public `quality-invocation.js
terminal-state` command automatically asks `scripts/quality-telemetry.js` to
append one JSON line per finished campaign, summarizing the invocation manifest
— no model judgment. Fields: invocation id, repo/PR/branch, base/head SHAs,
resolved risk tier + score, wall and active duration, exact provider-reported
token usage when available, separately labeled artifact estimates, successful
review rounds, agents run, review status, signed per-finding dispositions,
deterministic failure count, merge-requested flag, exact merged terminal receipt,
a derived verdict, and the covered file list (`baseSha..head`). Recording is
idempotent for each invocation and terminal state. A later verified merge may
append one stronger `merged` receipt; readers select the latest record for that
invocation. Writes are fail-soft and never block the campaign outcome. Reports
exclude preflight, `vitest/*`, and missing-repository records by default; use
`--include-fixtures` only for explicit diagnostics. Missing usage and finding
settlements remain visible sample gaps, never inferred as zero or relabeled from
artifact estimates.

### Exact-head review evidence

When `--merge` is used and the quality pipeline ran in the same invocation
(Step 1.8 completed), the merge gate (Step 4) publishes a signed
`quality-review-evidence` check run on the reviewed HEAD. The payload binds the
reviewed HEAD, merge-base, risk tier, deterministic findings, selected reviewers,
and v2 policy/diff evidence when present. Publication is idempotent and never
creates an empty commit or force-pushes the PR branch. Final authorization
verifies the check run on that exact HEAD before the protected merge.

Existing campaigns that already persisted an empty stamp continue through the
legacy trailer path so an interrupted merge can resume without creating a second
stamp. New campaigns must not create or require one.

If the pipeline did NOT run in this invocation (e.g. operator passed
`--merge` alone with no prior quality work), the gate hard-blocks instead
of publishing evidence — publishing then would be forging review evidence.

## Scope

`branch` is the only executable scope: the manifest binds the merge-base and
HEAD, gates run from committed policy, and review covers that exact range.
`changed` and `all` fail at bootstrap until they have distinct, testable
execution semantics.

## Quality Levels

### Level auto (Default — tier-aware)

When `harness-config.json` exists in the repo root, the skill reads the resolved risk tier and mechanically selects provider-equivalent depth:

| Tier       | Provider-equivalent depth  | Minimum review |
| ---------- | -------------------------- | -------------- |
| `low`      | focused regression         | 75s            |
| `medium`   | broad correctness/security | 120s           |
| `high`     | deep adversarial           | 180s           |
| `critical` | release-veto review        | 540s           |

Workload can raise these limits, but the complete default campaign remains
bounded at 5–15 minutes of active execution. Gates, mutation, primary review,
fallback, retry, and verification spend one shared cap. Phase limits and
reserves prevent fallback or earlier gates from doubling or consuming later
required capacity. Approval, CI wait, and other idle lifecycle time do not
spend the active cap.

### Level 95 (Ship-Ready, no tier classification)

- 6 quality agents regardless of changed-file risk
- For repos without harness-config.json, or to override auto when you want full review on a low-tier change
- Codex runs as cross-reviewer (legacy default)

### Level 98 (Comprehensive — Production-Perfect)

- 10 agents (Phase 1: 7, Phase 2: 3)
- Adds: code-simplifier, accessibility-tester, performance-engineer, architect-reviewer
- Requires at least `--scope branch` (not compatible with changed)
- For production launches, customer-facing features

## Provider Invocation

Codex uses the native `codex exec review` surface with the scorer-selected
`model_reasoning_effort`; this avoids ambient-effort drift and avoids pasting
the repository diff into a generic prompt. Current Codex versions return
native priority-marked review text even when `--output-schema` is supplied, so
the runner normalizes that format into the same strict internal finding schema.
`quality-run-bounded.sh` places it in a process group and enforces the tier cap:

```
codex exec --ephemeral -s read-only --json \
  -c 'model_reasoning_effort="high"' --output-schema <schema> \
  review --base origin/main
```

The runner normalizes native review text, root-level structured output, and the
legacy `{result: ...}` envelope before parsing findings. It pins the exact
merge-base SHA before starting the first provider so a fetch in another linked
worktree cannot move `origin/main` and inject reverse-diff findings. Later
rounds review from the last successfully reviewed SHA. Claude uses the same tier
timeout around each parallel reviewer and cancels sibling process groups on
account exhaustion. Gemini receives the exact revision identity and committed
diff on stdin, uses one or two workload-selected static-analysis passes, runs
with `--approval-mode plan`, and fails closed on malformed, contradictory, or
unstructured output.

## Trailer Convention

```
Reviewed-By: quality
Reviewed-By: codex
Quality-Tier: high
Quality-Reviewer: codex
Quality-Primary: codex
Quality-Fallback: claude
Quality-Findings: 0
Quality-Head: <SHA>
Quality-Base: <SHA>
Quality-Contract: 2
Quality-Policy: <policy-digest>
Quality-Agents: <selected-agent-set-hash>
Quality-Domain: <selected-domain>
Quality-Selection: <selection-rule>
Quality-Repository: <repository-key>
Quality-Diff: <complete-base-to-head-diff-hash>
Quality-Review-Evidence: <artifact-chain-hash>
```

- `Reviewed-By: quality` is the provider-neutral authorization record.
- `Quality-Reviewer` records which reviewer actually completed; it can differ
  from `Quality-Primary` when fallback was required.
- Every trailer required by the campaign's contract version is present exactly
  once. `Quality-Findings` is the integer `0`, and `Quality-Tier` must meet the
  recomputed risk tier. Version 2 binds the effective policy, selected agents,
  domain rule, repository, complete diff, and retained review artifacts.
- Legacy `Quality-Head` must equal HEAD or HEAD~1 (a dedicated stamp commit),
  and `Quality-Base` must equal the current merge-base. Any later code commit
  invalidates that legacy stamp. New campaigns use the signed exact-head
  `quality-review-evidence` check run instead and do not emit these trailers.
- Parenthetical `Reviewed-By` metadata is legacy reader compatibility only and
  must not be emitted by new quality campaigns.
- **Legacy authorization path is queryable from the trailer; new authorization
  is queryable from the exact-head check run, with no telemetry inference
  needed.** A version-2 Low campaign uses a signed `policy-exempt` artifact
  with `aiReviewRequired: false`; it never synthesizes a clean provider
  verdict. Medium and above require completed evidence from every selected
  reviewer.

## Deep Review Mode (`--audit --deep`)

Spawns 6 agents in parallel:

| Agent                 | Focus                           | Return Format       |
| --------------------- | ------------------------------- | ------------------- |
| code-reviewer         | Bugs, logic errors, code smells | JSON findings array |
| silent-failure-hunter | Empty catches, swallowed errors | JSON findings array |
| type-design-analyzer  | Any abuse, weak generics        | JSON findings array |
| security-auditor      | OWASP top 10, secrets           | JSON findings array |
| performance-engineer  | N+1, memory leaks               | JSON findings array |
| architect-reviewer    | Tech debt, patterns             | JSON findings array |

After completion:

1. Display agent summary table
2. If `--dry-run=false`: create Linear issues for findings via mcp**linear**create_issue
3. If `--dry-run=true`: preview without modifying

## Teams Mode (`--teams`)

Uses agent teams instead of Task subagents. Provides:

- tmux split-pane visibility
- Cross-reviewer communication
- Coordinated retry on failures

Best for a separate advisory workflow; the revision-bound quality engine does
not expose `--teams`.

## Merge Flow (`--merge`)

1. Push branch, create PR
2. Wait for CI (unless `--skip-ci`)
3. Auto-merge via `gh pr merge --squash`
4. Manually verify the deployed system using your normal deployment tooling

### Worktree lifecycle locks: recovering a stale cross-host lock

`scripts/worktree-manager.js` serializes create/lock/unlock/remove/reconcile
operations per worktree with a directory-based lock
(`withLifecycleLock`) at:

```
<repo-common-dir>/worktree-manager/locks/<hash-of-branch>.lock/
  owner.json   # { pid, hostname, operation, key, createdAt }
```

On a stuck lock, `worktree-manager.js` can only prove the owning process is
dead when `owner.hostname` matches the current machine's `os.hostname()` — it
then signals the recorded `pid` with `kill(pid, 0)` and reclaims the lock if
that fails with `ESRCH`. If the lock was left by a process on a **different
host** (e.g. that host crashed, or the lock was created in CI or another
worktree environment before the box died), there is no way to verify
liveness, so the lock is deliberately retained forever rather than guessed
stale — every lifecycle operation on that worktree fails with
`LIFECYCLE_BUSY` until it's cleared. This is a conservative choice (never
falsely reclaim a lock that might still be held), not a data-loss risk.

**Manual recovery**: once you've independently confirmed the owning host/process
is actually gone, remove the stale lock directory directly:

```bash
rm -rf "<repo-common-dir>/worktree-manager/locks/<hash>.lock"
# or, to clear every lock for the repo:
rm -rf "<repo-common-dir>/worktree-manager/locks"
```

`<repo-common-dir>` is `git rev-parse --git-common-dir` for the repo (the
shared `.git` dir, not a linked worktree's private gitdir). There is currently
no CLI flag for this — `worktree-manager.js help` does not mention the lock
directory, and removal is a manual filesystem operation only.

## Next-Step Suggestions (CS-046)

After quality completes:

- `--merge`: "Run `/clear` then `/bs:dev` for next feature"
- Failed: "Run `/debug` to investigate"
- `--audit`: "Run `/bs:quality` to fix issues found"

## Parallel Sub-Review Mode (`--parallel`, acpx)

When invoked with `--parallel`, fire security, coverage, and perf sub-reviews
as concurrent acpx sessions instead of running them sequentially inside the
main loop. Requires acpx >= 0.5.3 (commands are agent-scoped, `acpx claude
…`, in current versions).

1. **Check acpx availability**: `command -v acpx`. If unavailable, fall back
   to sequential (log a warning) — see Fallback below.
2. **Create sessions, then fire prompts concurrently**:

```bash
bash "$HOME/.claude/scripts/quality-load-root.sh" --manifest "<exact-manifest-path>"
GIT_ROOT="$(node "$HOME/.claude/scripts/quality-invocation.js" field "<exact-manifest-path>" repo.realpath)"
cd "$GIT_ROOT"

TIMESTAMP=$(date +%s)
for kind in security coverage perf; do
  acpx claude sessions new --name "quality-${kind}-${TIMESTAMP}" >/dev/null
done

acpx claude prompt --no-wait -s "quality-security-${TIMESTAMP}" \
  "Security review: examine [diff/files] for OWASP top 10, secrets, injection flaws. Output structured findings."
acpx claude prompt --no-wait -s "quality-coverage-${TIMESTAMP}" \
  "Coverage review: examine [diff/files] for missing tests, uncovered branches, weak assertions. Output structured findings."
acpx claude prompt --no-wait -s "quality-perf-${TIMESTAMP}" \
  "Performance review: examine [diff/files] for N+1 queries, unguarded loops, missing memoization. Output structured findings."
```

3. **Poll until all sessions complete** (status can stay "running"
   post-completion, so detect an assistant entry after the latest user entry
   via history):

```bash
session_done() {
  local session="$1"
  acpx claude sessions read "$session" --tail 4 2>/dev/null \
    | awk '/^user/{u=NR} /^assistant/{a=NR} END{exit !(a>u)}'
}

for session in quality-security-${TIMESTAMP} quality-coverage-${TIMESTAMP} quality-perf-${TIMESTAMP}; do
  for _ in $(seq 1 80); do
    session_done "$session" && break
    sleep 3
  done
done
```

4. **Collect outputs** (read session history):

```bash
SECURITY_OUT=$(acpx claude sessions read "quality-security-${TIMESTAMP}" --tail 1)
COVERAGE_OUT=$(acpx claude sessions read "quality-coverage-${TIMESTAMP}" --tail 1)
PERF_OUT=$(acpx claude sessions read "quality-perf-${TIMESTAMP}" --tail 1)

for kind in security coverage perf; do
  acpx claude sessions close "quality-${kind}-${TIMESTAMP}" >/dev/null 2>&1 || true
done
```

5. **Synthesize**: combine all three outputs into the unified quality report
   (same format as sequential mode). Continue to Step 2 (Agent Result
   Validation) as normal.

### Fallback

If `acpx` is not installed or any session fails to launch, log:

```
[quality] acpx unavailable or launch failed — falling back to sequential sub-reviews
```

Then run security → coverage → perf in order using the standard sequential
flow.

## Run Governor — Incident History

Two PRs in one night (#529: 128min/6 commits, #532: 167min/13 commits)
completed with no circuit breaker on 2026-07-03 — `CODEX_ROUNDS` only bounds
the inner Codex adversarial loop, not the outer cycle of BLOCKING-finding ->
auto-fix -> re-review across the whole invocation. This led to
`scripts/quality-run-governor.js`, which tracks a per-invocation JSON
sentinel (alongside the Step -1 git-root sentinel) with a fix-commit cap, a
wall-clock cap, and repeated-finding-shape detection (see the script's own
header comment for the full mechanism).

A follow-up 2026-07-10 finding: the original governor had no _round_
dimension and was never called on the review leg itself — its three call
sites were all downstream of the panel. `bump-round` (called immediately
before every review panel, see SKILL.md Step 2.0) closes that gap: it is the
governor call that actually terminates the outer fix -> re-review loop, by
incrementing `rounds_used` and exiting non-zero at `max_review_rounds`
(default 2). Before that fix, the round cap was a sentence of prose — and
since the MODEL orchestrates this loop, prose is not a cap.

A further 2026-07-15 finding showed a foreground Codex review could outlive the
governor entirely. `quality-run-bounded.sh` now owns a hard tier deadline and
kills the provider process group before a typed timeout can trigger fallback.

**Never make the governor check silently optional.** Every call site fails
CLOSED when the governor script or its sentinel file is missing or
unreadable — a bare `if [ -f ... ] && [ -f ... ]; then ... fi` with no `else`
was independently flagged by 4 review agents across two rounds as
reintroducing exactly the "circuit breaker quietly stopped breaking" failure
mode this whole feature exists to prevent.
