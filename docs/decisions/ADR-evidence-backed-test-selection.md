# ADR: Evidence-backed test selection

- Status: Accepted
- Date: 2026-08-12
- Decision owner: claude-kit
- Tracking: BUI-733

## Context

The first fleet test-impact implementation treated a missing dependency map as
an instruction to run every test. In practice, any Python source, shell,
workflow, configuration, style, dependency, or unknown file selected the full
suite. The final-candidate policy then required another complete run. This made
uncertainty expensive without making the uncertainty visible, and it routinely
spent time and CI minutes on tests that could not observe the changed behavior.

Supported tools already expose narrower, dependency-aware selection. Jest's
`--findRelatedTests` and Vitest's `related` mode select tests associated with
changed source files. Nx computes affected projects and tasks from the project
graph. Pytest supports precise files, node IDs, keywords, and markers, but it
does not infer a sound cross-file Python dependency graph by itself. Regression
test-selection research finds substantial time savings, while also showing that
an unsafe selector can miss faults. The correct fallback is therefore visible
uncertainty plus an owned mapping or explicit audit decision, not an automatic
full run hidden behind the word "conservative."

Primary references:

- https://jestjs.io/docs/cli#--findrelatedtestsspaceseparatedlistofsourcefiles
- https://vitest.dev/guide/cli.html#related
- https://nx.dev/docs/features/ci-features/affected
- https://docs.pytest.org/en/stable/how-to/usage.html#specifying-which-tests-to-run
- https://digitalcommons.unl.edu/csearticles/11/
- https://doi.org/10.1016/j.jss.2021.111186

## Decision

The normal merge gate runs the smallest test set with evidence that it covers
the diff:

1. JavaScript and TypeScript use the repository's supported related-test
   selector. Plain Node script suites run changed JavaScript test files directly;
   TypeScript tests and source files still need a repository mapping because
   Node has no portable dependency graph or TypeScript-loader contract.
2. Changed Python test files run directly.
3. Python source, shell, workflow, configuration, executable documentation,
   and other domain-specific files use repository-owned path-to-test mappings.
4. Prose-only Markdown and text require no behavioral test.
5. If any changed file has no proven selector or mapping, the plan is
   `unmapped`. Authorization stops with the uncovered paths and a remediation.
   A repository may declare an explicit complete-suite `fallback`; it runs only
   when uncovered paths remain and keeps new file classes safe during migration.
6. A complete suite is an explicit `audit` mapping with a concrete reason. Use
   it for releases, scheduled selector audits, dependency/test-infrastructure
   changes that genuinely invalidate the graph, or an approved risk exception.
7. Scheduled audits periodically compare affected selection with a complete
   suite. A missed failure is a selector defect and must repair the map before
   affected-only authorization resumes.
8. Adding or changing the selector policy is self-referential, so that diff
   runs the repository's pre-existing complete/native test gate once. A stable
   policy deliberately selects the ordinary test gate for subsequent diffs.

The committed repository policy is `.buildproven/test-impact.json`. Commands
are argv arrays, never shell strings. Every file is classified, and mixed diffs
remain blocked when even one executable path is unmapped.

An `audit` selection runs the complete native test contract. It therefore
inherits the repository's declared test timeout when quality plans the campaign.
A `focused` selection keeps the smaller proportional timeout so routine changes
do not reserve full-suite capacity.

## Consequences

- Small changes stop paying the fixed cost of unrelated tests.
- Unknown impact becomes actionable evidence instead of hidden compute spend.
- Repositories must maintain a small map for ecosystems without a sound native
  dependency selector.
- An explicit fallback preserves coverage for a new or missed file class without
  making the complete suite the normal path.
- Complete regression still exists, but its frequency and reason are explicit
  and measurable.
- Selector safety is audited rather than assumed.
