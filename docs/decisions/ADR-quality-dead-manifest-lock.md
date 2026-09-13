# Recover dead manifest locks under the repository guard

## Decision

Recover an inner manifest lock only while this process holds the exact
repository metadata guard. Require a regular lock owned by the effective user,
the exact local hostname, a valid PID and acquisition timestamp, and positive
ESRCH liveness evidence.

Every manifest writer, including the raw compatibility entry point, first
acquires the repository metadata guard. A caller that already holds the exact
guard reuses it. This makes dead-lock validation, removal, and exclusive
creation one serialized operation for all repository writers.

Open the lock through a no-follow, nonblocking descriptor before validating
its type and owner with fstat. Re-read through another descriptor, compare
device, inode, and body while the guard remains held, then unlink and acquire
with exclusive creation. A competing compatibility writer that acquires the
guard first remains the owner.

## Invariants

- Live, remote, malformed, EPERM, unavailable, and replaced owners fail closed.
- Lock age never permits recovery.
- Recovery retains manifest state, evidence, and budgets.
- Existing lease and terminal fences continue to reject stale writers.
- The metadata guard serializes raw, leased, and terminal manifest writers.

## Verification

The invocation tests cover a dead child writer, concurrent recovery, and every
adverse ownership case above.
