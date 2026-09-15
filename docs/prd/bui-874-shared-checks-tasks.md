# BUI-874 tasks

- [x] 1.0 Route task completion through shared affected-test selection.
  - Phase: implementation
  - Delivers: Relevant checks from one existing selector.
  - Evidence: task-completed-check and test-impact behavioral fixtures.
- [x] 2.0 Preserve both rename paths in quality selection.
  - Phase: implementation
  - Delivers: Old-path mappings remain visible to quality.
  - Evidence: quality-invocation rename regression failed before the repair and passes after it.
- [x] 3.0 Align builder and quality callers with the existing controller.
  - Phase: implementation
  - Delivers: Authorized delivery continues through the quality owner.
  - Evidence: Updated dev and quality instructions.
