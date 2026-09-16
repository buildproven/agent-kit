# Exact replay with upstream overlap (BUI-924)

## Decision

Keep direct application of the original binary/full-index patch to an isolated
index. Omit a changed path only when its complete committed entry is already
identical between the old candidate and the new protected base. Apply the exact
original patch for every remaining path, then require exact candidate-tree
equality. Do not use three-way merges, patch-id or candidate conflict resolutions.

Use Git's NUL-delimited, no-renames path differences to identify changed paths
between old base/head and paths still different between old head/new base.
Their intersection is the required patch path set. Git differences must disable
external diffs and text conversion, include submodules regardless of local
configuration, and use literal pathspecs. This compares committed content, type,
mode and gitlink identity, not filename presence or normalized text.
Pin application with command-scoped `apply.ignoreWhitespace=no` and explicit
`--no-3way`. Do not trust ambient application or merge settings. Keep
`--whitespace=nowarn` only to preserve patch bytes without rewriting whitespace.

## Evidence and scope

PR #538's final currency test repair landed in prerequisite #542. Applying that
identical change again fails. Saved head 7093ba5, prior base 848d88d, protected
base 9c4c8db, and rebased head d80bd8f have a valid expected final tree
97a0be0d72d7384cb160f371a28296fcadf4590f. The duplicated test is identical on
old candidate and new base; all other original changes still need direct replay.

The initial three-way design received a clean Sol/high review, but a subsequent
public regression proved it unsafe: `merge.default=union` resolved conflicting
upstream edits and admitted an unreviewed combined tree. That prototype was
reverted. Three-way application is rejected, not merely configured differently.

## Invariants

- Read all comparisons and patches from exact committed Git objects.
- Only wholly identical changed entries are already satisfied; partial overlap
  remains subject to strict direct application and can fail conservatively.
- Disable rename detection so both sides of a rename are checked separately.
- Preserve binary bytes, whitespace, file modes, deletions and gitlink identity.
- Empty remaining patch means the new base tree is the expected tree; an extra
  candidate edit must still fail the caller's exact-tree comparison.
- Require clean application and a fully resolved writable temporary index.
- Do not modify the candidate worktree/index, manifests or review budgets.
- Missing objects, conflicts and Git failures remain no proof.
- Both shared callers must retain exact candidate-tree equality checks.

## Alternatives

Direct-only application rejects already-landed identical changes. General
three-way replay can consult local merge policy and silently resolve conflicts.
Ignoring paths by filename alone loses proof. Patch-id ignores whitespace.
A fresh campaign would abandon governed recovery rather than fix it.

## Compatibility and rollback

No manifest or artifact schema changes. Patches with no identical upstream
entries retain direct-only behavior. Rename detection is disabled only inside
this proof. Rollback restores conservative duplicate-change rejection without
editing receipts. Deliver separately before resuming #538's saved manifest.

## Verification

Use public invocation advance for identical upstream overlap, extra candidate
whitespace, conflicting upstream edits and an ambient union merge driver.
Add complete-overlap, mode/binary/delete and literal-path boundary evidence
where needed. Compare index and worktree state before/after. Keep existing
direct-rebase and review-carry coverage and run the required repository gates.

Architecture review of revised direct-only design: Sol/high CLEAN, exit 0,
2026-09-16, after the application settings requirement was added.
The second review raised ambient application configuration. The decision now
explicitly disables three-way application and whitespace-ignore behavior; tests
must exercise hostile application settings, not merely an ambient merge driver.

Evidence: public overlap cases failed 5 / passed 4 before repair; the separate
whitespace-ignore case also failed before repair. All 10 pass afterward. The
real #538 replay returns the exact expected tree without changing its manifest.
Selector mapping regressions failed 2 / passed 2 before mapping this helper to
its invocation/mutation consumers; all 52 selector tests pass afterward. The
policy change requires a full regression audit during exact-head quality.

Git documents the whitespace-ignore setting and its explicit `no` value in
[git-apply configuration](https://git-scm.com/docs/git-apply#_configuration).
The review's separate claim that `apply.threeWay` currently enables git-apply
was not reproduced; explicit `--no-3way` still makes the chosen mode unambiguous.
