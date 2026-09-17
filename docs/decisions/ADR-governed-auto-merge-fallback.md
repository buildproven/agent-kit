# ADR: Governed Auto-Merge Fallback

## Decision

Use GitHub auto-merge only when the exact-head protected merge request fails
with GitHub's explicit instruction to add `--auto`.

## Invariants

- The existing lease, PR, base, head, merge method, and required evidence stay
  unchanged.
- The fallback never adds `--admin` and never bypasses branch protection.
- The lease is released only after GitHub proves the exact head merged.
- An open, queued, changed, or unreadable PR remains quarantined.

## Reason

GitHub can reject a direct protected merge while an exact workflow-dispatch
check is green and attached to the PR. Auto-merge is the server's ordinary
policy path in that case. Treating it as a manual exception strands a clean
release.

## Rollback and verification

Remove the narrowly matched fallback to restore direct-only behavior. Verify a
fake GitHub response that requests `--auto`, then prove the exact merged
read-back still controls lease release.
