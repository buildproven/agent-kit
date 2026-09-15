# BUI-874: Shared task completion checks

## Problem

Task completion selected a full test suite independently of quality. Quality
also lost the old path for renamed files, which could omit mapped tests.

## Requirements

- Task completion uses the existing test-impact selector for staged, unstaged,
  untracked, deleted and renamed paths.
- Quality retains both sides of renames when building the same affected plan.
- Missing coverage remains an actionable unmapped error. No caller inserts
  runner flags or silently substitutes a full suite.
- Quality remains the owner of exact-head review, evidence, budgets and merge.
- Builder instructions continue authorized review and merge without routine
  fan-out confirmation; existing safety and failure rules remain in force.

## Acceptance

Public hook and selector fixtures cover mapped paths, deletions, renames,
unmapped paths, non-repository work and failed checks. Full regression verifies
selector infrastructure. Native routing and the BUI-857 parent remain separate.
