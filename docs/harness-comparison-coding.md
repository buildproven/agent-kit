# Coding comparison controls

Status: draft, not frozen, no scored model runs. BUI-971 is part of BUI-921.
Architecture decision: none required. These are reversible test artifacts, not
a new agent runner, service, authentication interface, or delivery controller.

The corpus covers T01–T07: missing CLI values, read-only check mode, JSON output,
optional filtering, a two-file documentation correction, an unproved bug report,
and a bug hidden by incomplete tests. Each task has literal prompt bytes,
starting files, permitted paths, independent expected outputs, and a trusted
known-correct control. The entire corpus file is private to the evaluator.

For a future model attempt, expose only that task's `files` and `prompt` in a
fresh isolated repository. Never copy `solution`, `checks`, mutation controls,
or the evaluator repository into its readable scope. Use the existing isolated
worker boundary for executing model-produced programs; the control test suite
is not a safe launcher for arbitrary model output.

Run the trusted control checks with:

```sh
npx vitest run scripts/__tests__/harness-comparison-coding.test.js
```

The checks accept each known-correct control, reject each incomplete/incorrect
control, and reject out-of-scope files. T02 snapshots include empty directories.
T06 also executes the original implementation to check the reported observations;
its incomplete control lacks the required diagnosis, not a deliberately inserted
code defect. T01 and T07 run the submitted regression against the original
implementation in a separate copy. T07 also checks that total-49 coverage was
not removed. Vacuous test controls must be rejected.

During development, the vacuous-test controls exposed that the revert copy used
the known-correct test, not the submitted test: both controls failed. The copy
now preserves the submitted test and reverts only implementation bytes; both
controls pass. No model attempt was run before this correction.

CodeQL also rejected the initial snapshot path check followed by a separate
path read. Snapshot files now open with `O_NOFOLLOW`; metadata and contents use
that same descriptor, closed in `finally`. A synthetic symlink control is
rejected. This remains trusted fixture inspection, not a confinement boundary
for concurrently hostile candidate processes.

This draft does not freeze a complete comparison. T08–T12, actual isolated
acceptance execution, fixture tree/prompt/scorer hashes, independent review and
the final manifest freeze remain required before the planned 48 attempts.
Neither passing controls nor fixture count is evidence of SOTA, model quality,
token savings, unattended completion, or finished product acceptance.

The selector contract tests also require the corpus, control suite, and this
document to select the coding-control suite. Removing the corpus mapping must
produce a failing regression rather than leave future corpus edits unmapped.
The explicit mutation-plan mode selects selector contract tests for policy
metadata; ordinary policy changes still select the complete regression audit.
