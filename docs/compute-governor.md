# Compute Governor

Compute Governor gives fresh autonomous workers one explicit model, effort,
access profile, runtime cap, prompt hash, and exact Git revision. It does not
change the interactive builder model.

## Native advisory selection

For an installed caller, locate `scripts/compute-governor.js` under the active
plugin, project `.claude`, or `~/.claude` directory. Resolve that symlink to the
source script. This reference is `../docs/compute-governor.md` relative to its
source directory, regardless of the caller's working directory. Invoke
`node <installed-governor> resolve <request.json>` with the request below.

Native Codex and Claude delegation can call `resolve` or `explain` with the
separate `native-advisory` request. The result launches nothing and is not a V1
or V2 execution plan.

```json
{
  "interface": "native-advisory",
  "schemaVersion": 1,
  "work": "delegation",
  "facts": {
    "provider": "codex",
    "phase": "scan",
    "readOnly": true,
    "localized": true,
    "reversible": true,
    "targetedProof": true,
    "ambiguous": false,
    "changedFiles": 1,
    "protectedSurfaces": [],
    "sameFailureStreak": 0,
    "publicContract": false,
    "crossRepository": false,
    "operatorRoute": null
  },
  "task": {
    "text": "Inspect the targeted worker behavior.",
    "plannedPaths": ["src/worker.js"]
  },
  "parent": { "model": "gpt-5.6-sol", "effort": "high" },
  "override": null,
  "fork": "bounded",
  "capabilities": {
    "delegation": true,
    "overrides": true,
    "models": [{ "model": "gpt-5.6-luna", "efforts": ["medium"] }],
    "profiles": []
  }
}
```

Every fact is required. The task text and planned paths must describe the full
delegated task. The result returns a task SHA-256 and classified protected
surfaces, not the task text or paths. Unknown capabilities, unsupported
model/effort pairs, and below-floor overrides return `blocked` with no
`modelArguments`.

For a fresh or bounded Codex worker, consume ready `modelArguments` through
`spawn_agent` `model` and `reasoning_effort` controls. For Claude,
`modelArguments` names the Task `subagent_type` and model alias. The selected task profile supplies its
effort; Task has no per-call effort control. The kit profiles are
`native-task-low`, `native-task-medium`, and `native-task-high`, all with
`model: inherit` and their named `effort:` frontmatter. They omit `tools` and
`permissionMode` so the client inherits the parent's available tool surface and
permissions, including available WebSearch and MCP tools. Confirm required task
tools are available before delegating; a ready model pair does not prove tool
availability. See [Claude subagent tools](https://code.claude.com/docs/en/sub-agents#available-tools). Claude uses the built-in
`general-purpose` type for the Haiku/null-effort pair. Declare only installed
profiles in `capabilities.profiles`, then inspect `/tasks` to confirm the
effective model and effort. Do not mutate global model settings. A full-history
fork preserves its parent selection and receives no model arguments. Do not
silently replace a blocked selection with an inherited global default; continue
safe local work or use an already-supported route.

Native advice uses the V1 task classifier without launch-time economy promotion:
unprotected, complete low-risk work can select Luna; ordinary work selects
Terra; protected/public/cross-repository work remains Critical. Ambiguous work
is at least Standard. Repeated-failure facts only explain an Expert
recommendation; they do not grant a budget, authority, execution receipt, or
sandbox. An explicit supported override may be below the recommendation only
when it stays at or above the hard safety floor. Native advice does not change
V1/V2 execution, quality, the active coordinator, permissions, or merge policy.

## Phase-v2 workers

Schema v2 covers `scan`, `plan`, `implement`, `verify`, `remediate`, `diagnose`,
and `review`. Create a request:

```json
{
  "schemaVersion": 2,
  "caller": "interactive-ralph",
  "provider": "codex",
  "phase": "implement",
  "evidence": {
    "localized": true,
    "reversible": true,
    "targetedProof": true,
    "ambiguous": false,
    "changedFiles": 1,
    "protectedSurfaces": [],
    "publicContract": false,
    "crossRepository": false,
    "plannedPaths": ["src/feature/"]
  }
}
```

Resolve without launching:

```bash
node ~/.claude/scripts/compute-governor.js resolve-phase-execution \
  phase-request.json prompt.md /path/to/clean/worktree
```

Launch:

```bash
bash ~/.claude/scripts/provider-run.sh \
  --prompt-file prompt.md \
  --phase-request phase-request.json \
  --caller interactive-ralph \
  --provider codex \
  --fallback none \
  --target-dir /path/to/clean/worktree \
  --output-dir /tmp/run-evidence
```

V2 uses the reliable `standard` Codex route for ordinary work and `critical`
for auth, authorization, payments, durable data, migrations, public contracts,
deployment, security, and cross-repository work. Economy execution is disabled
until application telemetry, exact token data, lineage, budgets, and late-defect
adjudication can prove it safe. Repeated-failure escalation is also deferred
until that lineage exists.

The governor, provider runner, provider policy, deadline and provider-evidence
helpers, autonomous runtime, migrated caller entrypoints, and both versioned
policy files are protected security paths. A standard worker that discovers a
change to this control plane must stop and obtain a new critical plan.

Caller policy and phase derive access. `scan`, `plan`, and `review` are
read-only. `implement`, `remediate`, and `diagnose` use workspace-write in a
detached exact-HEAD worktree. `verify` and every Claude v2 request fail closed
before provider launch until their OS sandbox or independent verifier exists.
Supported v2 entrypoints also pass a fixed `--caller` argument. The runner
requires it to match the request or plan before provider launch.

The Codex v2 adapter pins approval, disables ambient MCP/plugins/hooks/search,
passes a minimal environment, and binds the execution-profile digest into the
plan and receipt. This is a target mutation-integrity boundary, not a host
confidentiality boundary.

Before write handoff, the runner freezes and hashes one binary patch. It permits
only regular-file additions and content modifications with a stable file mode
inside planned paths. Protected paths match at any directory depth. Protected,
unknown, malformed, ignored, symlink, gitlink, rename, copy, delete, mode-change,
type-change, unmerged, and out-of-plan workspace-write changes stop as
`replan-required`. Read-only tracked changes also stop; ignored read-only cache
files are discarded with the detached worktree and never enter a handoff. One
repository lease fences destination validation, exact patch application,
digest verification, rollback, and release.

The v2 `run-record.json` persists only the plan, requested/effective identity,
execution-profile digest, timing, typed outcome, and redacted exact token usage
when the provider reports it. Missing usage stays `null`. Prompts, credentials,
raw responses, and arbitrary provider metadata are rejected.

## Frozen schema v1

Existing `--execution-facts` and `--execution-plan` callers keep the frozen v1
policy, resolver, plan, record, and validation behavior. Legacy `test` remains
`test`. Claude cross-review, explicitly selected Claude Ralph/steward workers,
and Ralph/steward workers with no explicit provider stay on v1 until Claude has
the required v2 OS sandbox. Explicit Codex selection opts those workers into v2.

Every call to `provider-run.sh` must choose one mode: `--phase-request`,
`--execution-facts`, `--execution-plan`, or a policy-known specialized exemption
for the quality or strategy panel. Raw unclassified provider launches fail.

See [ADR-phase-adaptive-worker-routing.md](decisions/ADR-phase-adaptive-worker-routing.md)
for the reviewed decision and deferred automatic-economy control plane.
