# ADR: Governed builder routing and economy admission

## Status

Proposed for BUI-793.

## Context

`compute-governor.js` can recommend a model and reasoning effort, and
`provider-run.sh` can launch a fresh, isolated Codex worker with that exact
identity. The schema-v2 phase path deliberately chooses only `standard`
(Terra/medium) or `critical` (Sol/high). It does not use the existing Luna
economy routes, because the old calibration function accepts ad-hoc arrays and
does not bind real task attempts, deterministic verification, merge outcomes,
or later escaped defects.

The interactive coordinator also has no portable, safe way to replace its own
model in place. Asking an operator to switch a chat model therefore bypasses
the governor and makes cost depend on session choice instead of work risk.

## Decision

Ordinary autonomous implementation is a fresh schema-v2 builder worker. The
coordinator keeps operator context, but dispatches the bounded work item through
`provider-run.sh`; it never treats its own model as the worker selection.

The governor creates one stable campaign identity before the first phase. It
binds the repository identity, approved task-intent digest, caller, policy, and
the 900-second shared wall budget. A campaign attempt separately binds its
parent campaign, target HEAD, prompt digest, phase, derived safety facts, route,
model, effort, execution profile, and policy digest. A remediation attempt may
advance HEAD only when its changed intent is linked to an exact prior finding;
otherwise it starts a new campaign.

The ledger atomically reserves the remaining shared campaign budget before each
provider, gate, fallback, verification, or retry phase starts. It records the
actual active time and releases only unused reserved time. A target revision
therefore creates a new immutable attempt record, but cannot reset budget,
prior failures, or retry lineage.

The route policy is monotonic:

- Protected, public-contract, cross-repository, or ambiguous work is
  `critical`: Sol/high.
- Ordinary non-economy work is `standard`: Terra/medium.
- An eligible localized, reversible, deterministically-proved task is an
  `economy-builder` candidate: Luna/high. It runs as standard until a durable
  admission record permits the economy route.
- Before an admission exists, only the governor can select a signed,
  policy-scoped `calibration-canary`: Luna/high with its own strict quota,
  shared campaign cap, protected-surface exclusion, and mandatory deterministic
  verification. It creates explicitly marked production candidate receipts for
  matched holdouts. A caller cannot request, expand, or repeat a canary. A
  missing quota, policy scope, or trusted baseline selects standard.
- A typed, same-task worker failure may escalate one route only. A changed
  task, ambiguous failure, unavailable usage, or missing prior receipt does
  not down-route and cannot fabricate a retry lineage.

Admission and revocation use append-only, atomic records outside the audited
repository. Ingestion partitions trusted production, test, and fixture
namespaces before a receipt can be stored. Production readers reject a fixture,
test, unsigned, unknown-provenance, or malformed receipt. An authenticated
production attempt is retained regardless of whether it merged, failed,
exhausted its budget, or was rejected. Merge evidence is required only to
classify a successful completed delivery; failed and unmerged attempts remain
in the completion and retry denominator. A public dispatcher test must use the
test namespace; it can never write production calibration evidence.

A valid admission record contains a signed scope and policy-versioned
thresholds. Its scope binds the application and repository, fixed caller,
canonical phase, access profile, provider, model, effort, execution profile,
route, and task class. It also binds a calibration epoch, verifier and gate
contract digest, issuance time, and bounded rolling-holdout validity window.
Every dispatch compares each scope dimension, the live epoch, and the live gate
contract before it can select economy; a changed contract, expired window, or
scope mismatch selects standard.

The record also contains a complete, matched production holdout. The holdout
must meet the policy minimum sample, task-class coverage, confidence, and
token-or-latency improvement thresholds; it must also establish non-inferior
completion, independent deterministic verification, exact-head finding
dispositions, protected merge evidence for completed deliveries, and a closed
escaped-defect observation window for every candidate. Nullable or missing
usage is not economy evidence. The governor verifies each required receipt and
the active policy thresholds, not only a threshold digest, before admitting an
economy route. Fixtures, arbitrary hand-built metric arrays, and recent
incomplete pairs are never production admission evidence. A linked escaped
defect, expired calibration epoch, changed gate contract, or a below-threshold
holdout writes a revocation record immediately; selection then returns to
standard until a new complete admission is valid.

The public interface is a small builder-dispatch request. Callers provide only
the prompt, target, fixed caller ID, phase, and an immutable approved-plan
reference. The reference is a governor- or creator-signed plan receipt whose
provenance, task binding, immutable digest, and exact worker-prompt digest the
governor verifies before it derives eligibility from that plan, the exact
target, deterministic test selection, and trusted verification receipts. The
supplied prompt must match that signed digest; otherwise dispatch fails before
route selection. Caller-declared booleans, changed-file counts, and paths can
retain a safety route or force escalation, but can never down-route work. The
governor owns identity construction, route selection, durable receipts, caps,
retry classification, admission, revocation, and the provider invocation.
Callers do not choose a model or reasoning effort.

`builder-dispatch` is the only schema-v2 ingress for a write phase. It creates
the campaign and signed plan receipt before `provider-run.sh` can launch.
`overnight-loop.sh`, `steward/orchestrate.sh`, and Ralph migrate to this ingress.
`provider-run.sh` rejects an unledgered schema-v2 write plan; specialized
allowlisted paths keep their explicit exemption and cannot create economy
evidence. The migration inventory is a blocking test, so a future write caller
cannot restore a direct phase-request path.

## Alternatives

### Change the live interactive model

Rejected. The client has no portable in-place model switch with preserved
context or auditable worker evidence.

### Enable Luna from prompt heuristics alone

Rejected. A small diff and a passing test do not prove comparable completion,
retry, or escaped-defect rates.

### Keep model selection as advisory text

Rejected. It leaves the expensive session as the actual execution path and
requires an operator to make routine routing decisions.

## Invariants

1. A coordinator model never determines a governed builder worker model.
2. A route cannot be below the safety floor or above its exact wall cap.
3. A worker process receives only the model and effort stored in its plan.
4. Economy selection needs an unrevoked, exact-policy durable admission record.
5. Missing, malformed, or fixture evidence selects standard. An unmerged
   receipt cannot prove completed delivery or merge success, but remains in the
   holdout denominator and cannot be discarded to select economy.
6. A revision creates an immutable attempt but cannot reset its campaign budget
   or lineage; an unrelated task or unlinked prompt change starts a new
   campaign.
7. Caller claims can escalate but cannot qualify work for economy routing.
8. Production admission reads only signed production-namespace receipts.
9. Economy admission requires complete, threshold-checked, closed-window
   holdout evidence and is otherwise standard.
10. Economy admission has an exact signed application, provider, model, effort,
    execution-profile, route, task-class, caller, phase, and access-profile
    scope plus a live epoch and gate-contract binding; a mismatch selects
    standard.
11. The governor alone can spend the separate bounded calibration-canary quota;
    it is the only cold-start source of Luna receipts and cannot select critical
    or excluded work.
12. Failed or unmerged production receipts remain valid denominator evidence,
    but cannot be classified as completed deliveries or satisfy merge evidence.
13. Every schema-v2 write launch has a signed campaign/plan receipt from
    `builder-dispatch`; direct phase requests are rejected.
14. Claude schema-v2 requests fail before provider launch and cannot create
    economy evidence until OS-enforced isolation proves that the model, hooks,
    and verifiers cannot mutate outside approved paths.
15. Revocation is automatic and fail-closed for subsequent selection.
16. Model selection does not add filesystem, network, merge, deploy, publish,
    spend, or approval authority.

## Rollout and verification

First ship governed standard and critical builder dispatch with public CLI tests
that prove the parent identity cannot leak into the worker command. Then add the
campaign/attempt ledger, atomic shared-budget debit, and provenance-separated
receipt ingestion. The same delivery migrates every schema-v2 write caller and
makes a direct unledgered write launch fail before provider execution. Then
enable the policy-scoped canary quota to collect the first matched Luna receipts
and close their holdout windows. Enable ordinary economy routing only after the
ledger produces an unrevoked admission from those real, matched production
holdouts.
Tests mutate the selected model, effort, cap, task digest, revision, prior
receipt, receipt provenance, admission threshold, observation window, and
revocation state; each must reject or choose the required non-economy route.
Tests also prove that failed and unmerged authenticated production attempts
remain in the denominator, an admission scope mismatch selects standard, and
every Claude schema-v2 request fails before provider launch, hooks, or a
verifier. Tests also reject an unsigned plan, stale epoch, changed gate contract,
direct write caller, and caller-requested canary; they prove that only an
in-scope governor canary can create initial Luna evidence. Claude remains
disabled until its separate OS-isolation proof lands.
The complete regression, independent review, exact-head merge, release, setup
propagation, installed dispatch, and measured natural work runs remain required.
