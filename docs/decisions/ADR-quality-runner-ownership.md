# ADR: Exclusive quality runner ownership

Status: Accepted for prevention-only implementation after independent review.

Scope: [BUI-879](https://linear.app/buildproven/issue/BUI-879/recover-exact-quality-campaigns-after-concurrent-runner-collision).

## Decision

The public `quality-run.js --manifest PATH` runner must own a manifest-scoped
lock for its complete lifetime, including child execution and terminal writes.
Acquire this lock before installing signal handlers or mutating the campaign.
Use the validated manifest real path so directory aliases share ownership;
retain the existing refusal of a manifest file that is itself a symlink. A collision
returns JSON `status: "busy"` with a specific reason and exit code 5. It does not
record a terminal state, run a child, or consume provider or gate budget.

An internal ownership module hides acquisition, positive dead-owner checks,
fenced recovery, and creator-only release behind acquire/release operations.
An exclusive file contains a version, host, PID, random owner nonce, time, and
a durable `childInFlight` flag. The owner sets this flag before invoking any
child executor. Only normal successful completion of the repository phase's
foreground execution contract clears it. Any signal, nonzero exit, spawn error,
or ambiguous completion makes the flag sticky for the rest of the run, including
any later terminal-recording child. The creator retains its ownership file on
that path, even if the direct child has exited. Direct shell-wrapper exit after
interruption is explicitly not descendant-quiescence evidence. This change
does not alter process signalling, infer descendant termination, or recover that
quarantined ownership. Successful phase scripts already wait for their work;
new phases that detach writers would violate this existing foreground contract.
The merge helper's documented exit-3 capability pause is a normal typed
foreground completion, not an execution failure. It is accepted only after the
runner validates matching atomic terminal/admission head, epoch, attempt ID,
conditions, and no active execution. `quality-stamp-and-merge.sh` invokes its
authorization and merge helpers in the foreground; no background writer is
started on this path. The existing typed-pause resume regression stays enabled.
Record file identity and only release the exact file created by this acquisition.
An observer must not remove a lock when acquisition failed. Incomplete,
malformed, symlinked, foreign-host, or inaccessible ownership fails closed as
busy. A PID that responds or fails with anything other than ESRCH remains busy.

A dead idle owner's lock may be reclaimed only after positive same-host ESRCH under
an exclusive recovery fence. Every acquisition path must hold that same fence,
including ordinary creation when no owner lock exists. Re-read and compare the
observed owner and file identity under the fence, then check ESRCH again before
unlinking. The fence holder creates its replacement owner lock before releasing
the fence, so another public runner cannot enter between validation and replacement.
A competing acquisition that sees the fence must leave it and the owner lock alone.
Only the fence creator removes its exact fence. A crashed recovery fence remains
blocked for explicit inspection; this change does not introduce recursive
stale-fence recovery.
A dead owner with `childInFlight` set is always busy, even if an execution
deadline has passed. This prevents admission while an orphan child may still
write. Automatic recovery of that case requires child provenance and is defined
by `ADR-quality-runner-reconciliation.md`; it is not inferred from elapsed time.

Before dead-owner reclamation and after acquiring ownership, re-read the
manifest. Any `governor.activeExecution` returns busy without campaign mutation,
including expired or malformed records. Existing bounded governor reconciliation
remains the campaign owner's responsibility; runner admission does not perform
orphan reconciliation. A live runner lock always wins over an expired execution
timestamp. Only a creator with no sticky ambiguous execution and no remaining
active execution releases its lock. Signals, failed children, and inconclusive
exit retain the lock for explicit process-tree inspection. This conservative
availability cost is deliberate; automatic failure recovery is a separate scope.

## Invariants and boundaries

- One public runner owns a manifest at a time; repository leases continue to
  fence cross-campaign merge authority separately.
- Rejected runners leave manifest bytes, budgets, history, and owner lock intact.
- Legacy terminals are immutable. A late successful review is not evidence of
  the earlier execution because historical artifacts lack that provenance.
- No recovery budget is minted and no execution ledger fields are rewritten by
  this ownership module. Existing governor reconciliation retains that role.
- Direct low-level invocation tools retain their existing contracts. This change
  prevents duplicate public runners; it does not change all tool authorization.
- No lock is reclaimed based on age alone or ambiguous PID reuse.

## Alternatives

Keeping only the repository lease permits two processes for the same campaign.
Holding the manifest transaction lock throughout execution prevents legitimate
child updates. Treating active-execution errors as terminal preserves the bug.
Automatic legacy recovery cannot establish review provenance and is excluded.

## Migration and rollback

There is no manifest migration. New adjacent lock files are private runtime state
and never enter Git. Before activating this runtime, quiesce old runners and
their children and ensure future invocations use the new runtime. Old runners
do not honor these locks, so mixed-version execution is unsupported. This code
change does not activate or modify any running campaign. Rollback removes the
new runner integration only after all its owning processes and children exit.
Do not delete live or ambiguous lock files.

## Verification

Exercise the real public runner with a controlled provider child. Hold the first
runner in review, start a duplicate, verify busy and identical manifest bytes,
then allow the owner to finish. Kill a fixture parent while its controlled child
is alive; verify refusal even with an expired execution timestamp. Test orphan
nonexpired and expired execution refusal, positive dead-idle-owner reclamation,
same-host live PID refusal, foreign-host and malformed locks, held recovery
fences with and without an owner lock, directory aliases, and owner-only cleanup.
Assert original budget and terminal history values survive every rejected run.
Run the repository test-impact selected tests and required source checks.

## Independent review

First ADR-only review: Codex Sol/high, session
`01a09881-2215-74a0-be49-03a9f82c7926`, blocked the initial design because owner
death and deadline expiry do not prove child exit, and mixed-version rollout
was not quiesced. The decision above now refuses ambiguous orphan children and
requires quiescence. No historical recovery or new evidence provenance is added.
Second ADR-only review: Codex Sol/high, session
`01a09884-b4a6-7221-9256-b1766acb45d1`, rejected clearing the marker on signalled
shell-wrapper exit because descendant writers could survive. The revised rule
above keeps ambiguous execution sticky across cleanup and terminal recording;
no claim of descendant quiescence is inferred from direct-child exit.
Final ADR review: Codex Sol/high, session
`01a09888-193e-79e0-a3df-e9dac7dd4bc8`, returned **ADR APPROVED** with no blocking
design findings. The typed normal exit-3 clarification preserves the existing
foreground completion invariant and is verified through existing public resume
tests. The earlier unrestricted review was stopped after it expanded
into intentionally failing regression tests; it supplied no design approval.
