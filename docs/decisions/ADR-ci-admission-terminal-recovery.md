# CI admission terminal recovery

Status: accepted. Independent Sol/high review: clean after defining creator-only continuation.

## Decision

A proven transport failure during a read-only required-check request will return
a distinct exit status. Prepare or ensure will preserve that status in a typed
`ci-admission-read-failed` terminal. It is not `ci:failed` and cannot use signed
CI-outage capabilities. Configuration, authentication, malformed responses, and
internal errors will remain fail-closed generic failures. The runner will retain
merge failure stdout and stderr in structured failure evidence. A bounded retry applies
only to read-only GitHub GET transport failures; workflow dispatch is never
retried blindly.

One historical generic `merge admission failed with exit 1` terminal may reopen
only when the persisted runner is at its first running merge step for the exact
head, merge intent and repository lease are present, no execution or merge is
active, all required gate artifacts and review authorization are valid, and the
open exact-head PR has current nonempty green checks. Recovery holds the same
repository metadata guard, rechecks the manifest, archives the terminal,
increments its epoch, and records a one-use recovery marker and active
`recovering` sentinel. That sentinel remains fail-closed in older runtimes and
permits continuation of the same normal merge preflight only in the process
whose atomic mutation creates this sentinel. The continuation grant is returned
in memory and is never reconstructed from a persisted sentinel. A second runner
or a restart after a crash treats that sentinel as terminal and cannot replace
it with a different failure. This one-use historical path has no automatic
crash takeover; any later recovery requires a separately reviewed owner-fencing
contract. It changes no
provider, gate, deadline, budget, admission, or review evidence. The ordinary
merge transaction must rerun every preflight and authorize the final mutation.
A later failure cannot use historical recovery again.

## Alternatives and invariants

Manual manifest edits lose provenance. A new campaign would discard the bounded
ledger. A blanket blocked-terminal retry would reopen failed review or gate
work. All are rejected. Unknown phases, stale artifacts, active ownership,
changed heads, explicit admission blocks, and repeat recovery fail closed.
Green GitHub checks only permit re-entry; they do not authorize a merge.

## Rollback and verification

Removing recovery will leave the active recovering sentinel and archived history
intact, so the old runtime will remain terminal. Tests will cover valid historical recovery, unchanged budgets, stale
head/gate/review evidence, execution ownership, wrong phase, repeated attempts,
red checks, transient read failure, and two concurrent entrants where only the
creator continues and a pre-existing sentinel stays terminal. The original public runner must reach
normal merge admission without a new campaign or provider attempt.

## Design review

Initial high-effort review identified overbroad CI failure classification and
missing rollback sentinel. This proposal now requires a distinct transport
status and an active recovering terminal; no CI-outage authority is added.

## Implementation evidence — 2026-09-13

Independent Sol/high code review is clean after repairing the wait transport
status before CI-waiver handling. The real stamp CLI regression reproduced
false success with a valid waiver before the fix; it now returns 75 without
waiver evaluation or merge mutation. The selected nine-file test plan passed
506 tests. Focused recovery tests preserve budgets and artifacts, reject invalid
state, and leave a pre-existing creator-only sentinel unchanged.
