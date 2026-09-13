---
name: bs:workflow
description: Quick reference for the public daily development workflow
argument-hint: "→ daily dev workflow reference"
tags: [workflow, guide, reference]
category: development
model: haiku
---

# Daily Development Workflow

## Model routing

For a substantial independent native task, resolve the complete
`compute-governor` native-advisory request before delegation. Use ready model
arguments only with a bounded or fresh worker; full-history forks inherit the
parent. A blocked capability result is visible; continue safe local work or use
another supported route. It does not weaken quality or permit an implicit
global-model fallback.

Codex uses the ready `spawn_agent` model and effort pair. Claude Task uses the
ready profile and model alias; its profile sets effort. Confirm the effective
identity in `/tasks` and do not change global settings.

Use each runtime's normal medium-effort profile for daily development. The
quality workflow performs any bounded high-effort adversarial escalation; do
not select Opus or a Codex power profile for ordinary commands.

If critical review falls back to Claude, all selected roles must complete. The
fallback can use the configured model family without an automatic Opus route.

`/bs:dev` and `/bs:plan` automatically run the Architecture Decision Gate. An
ADR is required only for an irreversible boundary (auth/payments, durable data,
public contracts, distributed consistency, or cross-repo dependencies). It is
drafted at the normal profile, then receives a bounded high-effort review before
implementation; routine plans and reversible refactors stay on the normal
medium-effort profile.

Quick reference for the public `claude-kit` workflow.

## Core loop

```bash
/bs:dev my-feature  # builds, verifies, reviews, and merges the exact candidate
```

Use `/bs:dev --no-ship my-feature` only when you deliberately want a local
candidate. You can then run `/bs:quality` for a non-merging team review or
`/bs:quality --level 98 --merge --deploy` for a production release.

All linked worktrees use one lifecycle API and live outside the primary
repository:

```text
<primary-repo-parent>/.worktrees/<repo-name>/<branch-slug>
```

```bash
node scripts/worktree-manager.js create --repo /path/to/repo \
  --branch feature/my-feature --creator manual --purpose "my feature"
node scripts/worktree-manager.js status --repo /path/to/repo
node scripts/worktree-manager.js reconcile --repo /path/to/repo --apply
```

`reconcile --apply` is the recovery path after manual/admin merges. It retains
locked, dirty, unpushed, open-PR, recent, and inconclusive worktrees. Use
`migrate --dry-run` before adopting legacy layouts and `repair --apply` after
an explicitly reviewed repository move or rename.

Quality merges autonomously at every risk tier once all revision-bound
deterministic gate, CI, signature, and base-freshness evidence is clean.
Critical changes get deeper bounded AI discovery; they do not require a routine
approval command. Under review contract v2, AI leads and completion status are
advisory: unavailable or malformed provider output is signed as `incomplete`,
never presented as a clean review. A run stops for human direction when
deterministic evidence is unresolved, revision identity is stale, required CI
fails, or repository policy explicitly requires a human.
If the primary rejects the exact envelope as too large, quality preserves the
envelope and tries the configured fallback once instead of replaying the same
impossible primary request.
If custom review-check publication is unavailable while exact-head CI is
pending, quality completes the bounded CI wait before it signs local review
evidence. A failed CI result remains a hard block.
Claude fallback prompts use standard input and preserve the exact review
envelope without placing a large diff in process arguments.

If a bounded provider retry is exhausted and a real descendant fix lands, resume
the same campaign only with an exact-new-HEAD override accepting
`review:provider-exhaustion` plus `--i-understand-missing-review`; rerun
deterministic gates and mutation evidence at that HEAD before attaching it.

Repositories that explicitly set `scorePolicy.mergeAuthority` to
`"human-required"` retain the legacy signed, expiring approval command; it is
invalidated by any genuine HEAD change.
Protected `strict: false` ref-CAS remains signed-only unless the repository also
commits `scorePolicy.protectedNonstrictRefCas` as
`"accept-non-atomic-pr-state"`. That one-time policy accepts the unavoidable
close-or-retarget race without adding an approval prompt to every later green
PR. The runtime resolves and binds it from the protected base, so a candidate
cannot add the authority that it consumes.
Check an in-flight or stalled campaign's state on demand (gates, provider
review, break-glass, CI) without waiting for a failure:

```bash
/bs:quality status --manifest <exact-manifest-path>
```

The quality command hands that exact manifest to one deterministic runner. It
reuses completed exact-head evidence and reports any required operator
capability as a typed pause.
The `engineering` delivery claim reads its authority from the exact current
protected base and still requires all normal gates, review, CI, freshness, and
merge authority. It explicitly leaves product acceptance not established.
For product delivery claims, it also binds the evidence index and verifies
signed protected-producer receipts bound to the numeric repository ID, exact
HEAD, requirements, and artifact. Admission verification runs on a fresh
protected worker.

When invoking from a forked agent context (e.g. a parallel agent whose `cwd` is a harness scratch directory rather than the worktree), pass `--target-dir <path>`:

```bash
/bs:quality --merge --target-dir /path/to/repo
```

This is the canonical pattern for parallel agent fan-outs — without it, the quality skill operates on the wrong directory and the gate fails with no useful output.

## Common paths

### Standard feature work

```bash
/bs:dev my-feature
```

### Larger ambiguous task

```bash
/bs:prd my-feature
/bs:dev implementation-step
```

The PRD decomposes work into independently verifiable vertical slices with
explicit blocking edges. Wide mechanical refactors use expand → migrate →
contract so the branch stays green.

Product receipt checks on the candidate worker are preflight only. A product
merge returns the typed `product-admission` external capability until a fresh
protected verifier supplies admission evidence. Contract-only changes keep the
normal autonomous merge path.

### Bug diagnosis

```bash
/bs:dev login-timeout --fix
# diagnosing-bugs establishes one red-capable reproduction command first
```

### UI work

```bash
# frontend-design routes product vs marketing vs redesign
# ui-reviewer renders/reviews toward the strict 99/100 threshold
/bs:quality --level 98
```

### Autonomous backlog work

The human commands invoke executable `backlog` and `ralph` skills. Agents invoke
the bare skills directly; a skill never calls a user-only slash command.

Unattended admission uses `--provider codex|claude` and the bundled CodexBar
reader. Install CodexBar and sign in locally on each computer; see
`docs/provider-usage.md`. Stale data or a provider mismatch stops admission.

```bash
/bs:backlog
/bs:ralph
```

### Emergency fix

```bash
/bs:hotfix payment-timeout
```

## What runs automatically

- Git hooks for branch safety and code quality
- Post-edit linting hooks
- Stop validation hooks
- CI quality gates on pull requests
- Autonomous green exact-head delivery for protected `strict: false` bases,
  plus signed outage recovery; both use a non-force ref update and keep safely
  rejected campaigns resumable

## Command quick reference

| Command       | Use For                         |
| ------------- | ------------------------------- |
| `/bs:dev`     | Start feature work              |
| `/bs:test`    | Tight test feedback loop        |
| `/bs:quality` | Quality gate before PR or merge |
| `/bs:plan`    | Lightweight multi-repo planning |
| `/bs:prd`     | Strict PRD + vertical slices    |
| `/bs:ralph`   | Autonomous backlog execution    |
| `/bs:backlog` | Prioritization                  |
| `/bs:help`    | Full command lookup             |

## Notes

- This public workflow stops at a clean PR and merge path.
- Deployment, posting, product operations, and internal service workflows are intentionally out of scope for `claude-kit`.
