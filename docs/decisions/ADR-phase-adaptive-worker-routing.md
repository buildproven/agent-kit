# ADR: Phase-adaptive autonomous worker routing

## Status

### Superseding selection decision, 2026-09-23

The reviewed harness completion plan replaces the future calibration-platform
dependency with a small static task table. This change affects compute selection,
not access, mutation, review or merge authority. Claude Opus/high reviewed this
decision; the revised review approved implementation with the safeguards below.
The historical decision below remains the v1/v2 release
record, not a requirement to build a new calibration service.

For new schema-v2 plans: protected/public/cross-repository work stays critical
(Sol/high); bounded unambiguous localized scans of at most two explicit planned
paths use economy-micro (Luna/medium, 300 seconds); similarly bounded reversible
docs-only edits with targeted proof use economy-builder (Luna/medium, 900
seconds). Docs-only means explicit `.md` files, not broad directory prefixes or
globs, at most two paths and two changed files. Instructions (`AGENTS.md`,
`CLAUDE.md`, `SKILL.md`), command/skill/client configuration trees, policies and
ADRs are protected before economy selection. Planned paths join declared and
prompt-classified surfaces at initial selection, using the existing classifier.
Ordinary features/fixes stay standard (Terra/medium). Diagnosis spanning
multiple files or non-local scope uses expert (Terra/high). Unknown, broad or
ambiguous work cannot qualify for economy. All routes retain one worker and
existing task budget, path classification and handoff controls. Model choices
must be recorded explicitly and later measured, not claimed superior by fiat.

Planner booleans are hints that may veto economy, not evidence of semantic
correctness or a source of permission. Structural path count/type, phase-derived
access, protected classification and unchanged delivery gates bound the route.
A broad refactor falsely labeled as simple must still stay inside those paths,
pass the same deterministic tests and independent review, and spend the same
bounded task budget. This policy does not promise every initial model succeeds.
It does not require a new proof-command or calibration-admission service.

Existing `validatePhaseCandidate` requires workspace-write, binds the actual
patch and rejects paths outside the plan; read-only scans cannot hand off a
patch. For economy-builder, strengthen its existing check to require exact path
membership (not prefix membership), at most two changed files, `.md` extension
and non-executable regular-file mode. Refuse an ineligible patch; never escalate
after applying it. Tests exercise this public handoff as well as route selection.
Use Git's NUL-delimited raw status/mode metadata, already checked against the
bound patch, rather than a second text-header parser. Only additions or
modifications of mode `100644` pass the economy edit check; no deletions, renames,
copies, symlinks, gitlinks, executable modes, binary content or case-variant
`.MD` extension. Protected classification is case-insensitive and runs again
on actual changed paths. Membership in planned paths remains byte-exact.
The two-path scan limit selects compute; it is not a claim that the read-only
sandbox can read only those two files. Per-route time caps consume the existing
task budget and never create extra retry allowance.

Selection and plan validation share one pure route decision. Tests cover every
eligibility boundary, protected-path dominance, route/model/effort/cap tampering
and the public runner's actual model arguments. Policy version advances; stale
execution plans refuse before launch and require a new bound plan. Historical
records are preserved unchanged and remain tied to their original release;
the frozen v1 policy and validator are unchanged. No historical record is
relabeled as a new-policy result. Rollback returns new launches to the prior
released policy, without rewriting evidence or granting authority.

This slice does not enable the still-unsupported Claude v2 or verification
profile, introduce history-based promotion, or claim automatic escalation has
been proved. Those remaining acceptance gaps stay open. Ordinary caller migration
and observed identity must be verified before A10 is marked complete.

Accepted for BUI-792 after a Codex Sol/high adversarial architecture review
returned `CLEAN` on 2026-08-22.

## Context

`compute-governor.js` already binds a fresh provider process to an explicit
model, effort, prompt, clean target, exact Git HEAD, safety floor, and runtime
cap. Its low-level fact packet is used by unattended Ralph and cross-review,
but it does not cover every ordinary autonomous phase. Fleet steward repair is
ungoverned, and the phase vocabulary does not include planning, verification,
or remediation.

The interactive coordinator is outside this decision. It owns conversation
continuity and operator intent. A model change starts a new provider process; it
cannot safely replace the active session in place.

Current industry routers combine task complexity with availability and expose
the selected model. They also retain a reliable baseline and require ongoing
quality and cost measurement. A general prompt router does not know this
repository's exact revision, deterministic proof, protected surfaces, or
authority rules, so the local governor remains authoritative.

Primary sources:

- GitHub Copilot Auto model selection:
  <https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/models/auto-model-selection>
- Amazon Bedrock intelligent prompt routing:
  <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html>

## Decision

Deepen `compute-governor.js` as the one ordinary autonomous-worker routing
module. This release adds a schema-v2 phase request, plan, and run record for the
canonical phases `scan`, `plan`, `implement`, `verify`, `remediate`, `diagnose`,
and `review`. Legacy schema-v1 facts and plans keep their frozen resolver and
validator. Legacy `test` remains `test` in v1 and normalizes to `verify` only
when a caller migrates to v2.

The governor derives a phase access profile:

- `scan`, `plan`, and `review` are `read-only`;
- `verify` is `verification-only` and fails closed at launch in this release.
  It is enabled only after a repository-owned verifier can rerun the bound
  commands against immutable source with separate scratch/output paths;
- `implement`, `remediate`, and `diagnose` are `workspace-write`.

The request also contains a policy-known caller ID. Policy maps each caller to
its allowed phases and maximum access profile. Supported entrypoints pass a
fixed `--caller` value separately from the request. The runner requires an exact
match before it resolves or executes the plan, so task data cannot silently
claim another ordinary caller. Migrated v2 callers explicitly select Codex.
`auto` and a Claude policy default are invalid for v2.

Caller identity prevents mismatches between repository-owned workflows and
their request data. It is not a security boundary against a hostile process
running as the same local user: a same-user process that can invoke arbitrary
commands can choose both request and command arguments or replace the public
kit. Repository inventory tests prove that supported ordinary entrypoints pass
their own fixed caller ID.

`provider-run.sh` binds its sandbox to this profile and rejects a conflicting
`--sandbox` argument. Codex uses its existing authentication/configuration home,
but the runner passes a minimal environment and command-line overrides that set
approval to `never`, replace MCP servers and plugins with empty maps, disable
hooks and web search, remove extra writable roots, and select native read-only
or workspace-write sandboxing. The plan binds the execution-profile version and
digest, and the run record persists that effective digest. The boundary protects
target mutation integrity and limits ambient operational tools. It is not a
configuration-isolation or confidentiality boundary: the provider process has
provider authentication and can read the bound target and prompt. All Claude
schema-v2 phase requests fail closed before provider launch.
Tool allowlists do not isolate lifecycle hooks or external verifiers from the
host. Claude phase execution remains disabled until an OS-enforced sandbox
proves that the model, hooks, and verifiers cannot mutate outside their approved
paths. This restriction does not change legacy schema-v1 caller behavior.

Selection is conservative and monotonic:

- declared or prompt-classified auth, authorization, payments, durable data,
  migration, public contract, deployment, security, or cross-repository work
  selects `critical`;
- all other launchable phase work selects at least `standard`.

Schema v2 does not claim automatic repeated-failure escalation. The existing
`sameFailureStreak` field remains a legacy v1 caller assertion and is not
accepted by v2. Trusted escalation requires the same canonical task identity,
transactional receipt lineage, and cumulative budget control as automatic
economy admission. Until that control plane exists, workflow-owned retry caps
stop repeated work and protected work retains its critical floor.

Economy routes remain analysis candidates only. This release does not launch an
economy model. Existing calibration output remains advisory. Live telemetry is
not yet a sound admission source: test fixtures pollute fleet aggregates,
successful merges are missing, and provider token samples are absent. Automatic
economy admission requires a separate durable control plane with canonical task
identity, transactional lineage receipts, cumulative spend limits, exact
candidate/verifier binding, application-scoped calibration, and positive late
defect adjudication. Those controls must be implemented and reviewed before any
down-routing is enabled.

Before a write handoff, the runner freezes one binary patch from the detached
candidate, hashes its exact bytes, and reads Git's NUL-delimited raw status for
that candidate. The only allowed change kinds are additions and modifications
of regular files. The v2 request contains normalized planned path prefixes, and
policy contains versioned protected path rules. Absolute paths, parent
traversal, malformed paths, symlinks, gitlinks, submodules, ignored files,
unknown change kinds, unknown paths, renames, copies, deletions, type changes,
unmerged entries, or changes outside the planned prefixes fail closed as
`replan-required`. A newly found protected path that was not in the plan also
requires a critical replan. The governor, runner, provider policy, deadline and
provider-evidence helpers, autonomous runtime, migrated caller entrypoints, and
versioned policy files are protected security paths, so standard workers cannot
rewrite their own control plane. Immediately before target mutation, the runner
acquires a repository-scoped exclusive handoff lease. The lease remains held
across destination HEAD/cleanliness validation, application of only the already
classified patch bytes, digest verification, and rollback or terminal release.
Any drift rejects or rolls back the handoff while the fence still excludes a
second governed writer. Ambiguous lease ownership preserves the lock and fails
for reconciliation. The route changes
compute only. It does not expand file, network, command, merge, publish, spend,
or deployment authority.

New phase plans remain exact-HEAD plans. They bind provider, canonical phase,
access profile, facts, model, effort, prompt hash, target identity, target HEAD,
policy, caps, classified surfaces, and effective execution-profile digest.
Prompt, target, HEAD, provider, phase, profile, fact, model, effort, cap, policy,
execution profile, or plan drift fails before launch.
Run records persist the same phase/profile identity, timing, typed outcome, and
exact redacted usage when available. They never persist prompts, credentials,
raw responses, or arbitrary provider metadata.

Schema-v2 run records have exact-key validation and embed a v2 plan. Their typed
outcomes are `completed`, `provider-failed`, `provider-timeout`,
`provider-unavailable`, `provider-exhausted`, `replan-required`, and
`capability-disabled`. Verification rejection writes a v2 receipt without
starting a provider, hook, or verifier. Claude phase requests fail validation
before a plan exists, so they do not produce a run receipt. V1 records retain
their existing outcome vocabulary and validator.

Ordinary callers migrate to the phase contract:

- interactive Ralph implementation workers that explicitly select Codex;
- overnight Ralph attempts that explicitly select Codex;
- fleet steward repair workers that explicitly select Codex;
- Codex cross-review read-only workers. Claude cross-review keeps the legacy v1
  path until the Claude phase sandbox exists.

An unset Ralph or steward provider retains v1 provider-policy resolution. This
keeps Claude-only hosts and configured fallback behavior working; v2 never
silently turns an unset or `auto` provider into Codex.

Quality's revision-bound review panel remains under its stronger manifest and
diversity contract. Strategy panels remain explicit multi-provider
deliberation. Neither exemption may invoke an ungoverned ordinary
implementation worker.
`provider-run.sh` requires exactly one explicit mode. Read-only v2 phases use
`--phase-request`; workspace-write v2 phases use a signed `--builder-receipt`
with its external builder state directory; `--execution-facts` and
`--execution-plan` are frozen v1 interfaces. A raw unclassified launch is
rejected. Repository caller inventory tests fail if an ordinary writer bypasses
Builder Dispatch, uses an exemption, or omits its mode.

## Alternatives

### Change the interactive model in place

Rejected. Provider CLIs do not offer one portable in-place contract, and a
switch can discard conversational context.

### Build the automatic economy control plane in this release

Rejected. The required identity, receipt, sandbox, budget, calibration, and
late-defect systems do not exist. Prompt heuristics and caller claims are not
adequate quality evidence.

### Add a second workflow router

Rejected. It would duplicate safety floors, model mappings, validation, and
evidence.

### Use a hosted general-purpose prompt router as authority

Rejected. It cannot replace exact-HEAD binding, repository policy,
deterministic proof, or local authority controls.

## Invariants

1. The interactive coordinator model never changes implicitly.
2. Every new phase worker is fresh, bounded, exact-HEAD, and explicitly routed.
3. A schema-v2 route is never below `standard` or the protected floor.
4. Caller policy and phase determine access. A caller cannot ask for broader
   sandbox authority.
5. Read-only and verification workers cannot hand a patch to the target.
6. A discovered protected path stops before target mutation and requires a
   critical replan.
7. Economy execution remains disabled until a separately accepted control-plane
   decision enables it.
8. Model selection never expands operational authority.
9. Fallback providers require a separately resolved plan and receipt.
10. Exact token counts and estimates remain distinct; missing exact usage stays
    null.
11. Schema-v2 workers do not inherit ambient MCP, plugin, hook, writable root,
    approval, remote-control, search, or nonessential environment authority.
12. The provider authentication/read boundary is explicit and is not represented
    as host confidentiality.
13. One repository handoff lease fences validation, apply, verification,
    rollback, and terminal release.

## Migration and rollback

Phase support is additive. Existing facts, plans, and run records remain valid
through an explicit frozen schema-v1 policy snapshot, resolver, and validator.
Installing v2 policy cannot change v1 model, effort, cap, route, or validation.
Migrated callers
use schema v2, canonical phases, and derived access. A v1 plan never validates
as v2, and a v2 plan cannot omit its phase access profile. Rollback returns
migrated callers to conservative v1 facts; it does not enable economy routing
or change specialized quality routing.

## Verification

Behavioral tests use the public CLI and `provider-run.sh` seams:

- every canonical phase resolves for Codex;
- every Claude schema-v2 phase request fails before provider launch;
- legacy v1 plans keep exact v1 validation, while v2 `test` input normalizes to
  `verify`;
- every phase derives its exact access profile;
- every caller is limited to its policy-known phases and maximum access;
- all ordinary/economy-candidate launches remain at least `standard`;
- protected/public/cross-repository work is `critical`;
- a sandbox conflict fails before provider launch;
- read-only runs cannot use ambient external tools or writable roots and cannot
  hand a patch to the target;
- verification requests fail before provider launch;
- every Claude phase request fails closed without invoking Claude, hooks, or a
  verifier;
- newly discovered protected changed paths record `replan-required` and do not
  mutate the target;
- regular-file additions and modifications hand off only when their immutable
  patch digest matches; every other Git change kind, symlink, gitlink, ignored,
  malformed, unknown, and out-of-plan path fails closed before handoff;
- destination HEAD/cleanliness drift or patch-byte drift fails atomically;
- a concurrent governed writer cannot enter the handoff, and an ambiguous
  rollback preserves the exclusion lease;
- prompt, target, HEAD, plan, policy, phase, access profile, and model tampering
  fail before launch;
- a schema-v2 write request or plan without a Builder Dispatch receipt fails
  before provider discovery; the receipt binds the reservation to one external
  campaign and the terminal run record settles only its observed active time;
- migrated callers pass canonical phase facts and leave a run record;
- a v1 plan and record still validate after v2 policy installation;
- v2 receipts validate each terminal and prelaunch outcome exactly;
- every provider-run caller declares v2, v1, or an allowlisted specialized
  exemption, and ordinary callers cannot use the exemption;
- focused tests, complete regression, lint, format, security, license, mutation,
  independent review, exact-head delivery, and protected merge pass.

## Adversarial architecture review

Three Codex Sol/high reviews on 2026-08-22 rejected automatic economy execution
until it has trusted semantic outcomes, a canonical task identity, transactional
and bounded lineage state, exact candidate verification, real provider
sandboxes, application-scoped calibration, rolling revocation, and positive
late-defect adjudication. This decision removes automatic economy execution
from BUI-792 and retains `standard` as the reliable baseline. A final review of
this reduced design found three further gaps: Claude tool permissions were not
an OS boundary, caller failure counts were not trusted lineage, and expanded v1
plans could not preserve exact validation. This revision fails closed for all
Claude v2 phases, defers automatic escalation with the durable control plane,
and introduces an explicit v2 contract with a frozen v1 path. A later focused
review found that Codex still inherited ambient authority and that a model could
transiently edit code while verifying it. This revision binds an isolated,
sanitized Codex execution profile and fails closed for verification until an
immutable independent verifier exists. A later review found ambiguous caller
authority, provider selection, v2 receipts, v1 policy preservation, path
classification, and raw-run bypass. This revision adds caller policy, pins v2
to Codex, defines exact v2 outcomes, freezes v1 policy, fails closed across all
Git path/change forms, and requires an explicit invocation mode. The final
Codex Sol/high review returned `CLEAN` on 2026-08-22.
