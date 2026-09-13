# ADR: Fenced quality runner reconciliation

Status: Accepted.

Scope: [BUI-892](https://linear.app/buildproven/issue/BUI-892/recover-quarantined-runner-ownership-after-a-proved-foreground-failure).

## Context

The quality runner retains its ownership file when a foreground child has an
ambiguous exit. This prevents a second runner from entering while a descendant
can still write. The original ownership record has no child identity, so a dead
owner can leave an exact campaign unavailable after an operator proves that the
whole process tree is gone.

## Decision

On POSIX systems, new ownership records use schema version 2. Before each
foreground execution, the runner creates a dedicated process group and persists
its leader PID, process-group ID, and start time. A direct child exit is safe to
release only when both the PID and the complete process group return `ESRCH`.
If the direct child succeeds but a descendant remains, the runner keeps the
original child provenance and refuses every later child dispatch, including
terminal-state recording. The campaign remains nonterminal until reconciliation
proves that the process group is gone. Any live, foreign, inaccessible,
malformed, or unproved process remains quarantined. Signals target the dedicated
process group.

Windows does not provide POSIX process-group proof. Until the runtime owns a
native Job Object implementation, Windows writes the schema-v1 compatibility
record and requires explicit child-quiescence confirmation. It does not emit a
schema-v2 record whose recovery condition cannot be satisfied.

`quality-runner-reconcile.js` is the supported recovery path. It takes the exact
manifest path, current head, owner host, owner PID, and owner nonce. It acquires
the same exclusive recovery fence as normal runner admission, validates the
manifest in its bound repository, requires null `governor.activeExecution`,
proves the owner PID absent, re-reads the same lock inode and nonce, and removes
only that exact ownership file. A schema-v2 quarantine also requires the
recorded child PID and process group to be absent.

Schema-v1 locks have no child provenance. Their recovery additionally requires
`--confirm-legacy-child-quiescent`, which records the operator's explicit
decision in command output. The operator must first inspect the owner and its
possible descendants. This confirmation does not create review evidence,
change a budget, edit the manifest, or rewrite terminal history.

## Operational command

```bash
node scripts/quality-runner-reconcile.js \
  --manifest "$MANIFEST" \
  --head "$HEAD" \
  --owner-host "$OWNER_HOST" \
  --owner-pid "$OWNER_PID" \
  --owner-nonce "$OWNER_NONCE" \
  --confirm-legacy-child-quiescent
```

Omit the confirmation flag for schema-v2 ownership. Read all binding values
from the inspected manifest and adjacent ownership file. Do not recover a
foreign host or a process that does not return `ESRCH`.

## Verification

Tests cover automatic release after a quiescent dedicated process group,
preserved nonterminal refusal while a successful orphan child can write, exact legacy binding
and confirmation, held recovery fences, live and foreign owners, malformed
records, null active-execution enforcement, and byte-identical manifest state
across reconciliation.
