# BUI-887: one campaign deadline for required checks

Status: approved by independent Sol/high design review on 2026-09-13.

## Problem

Required-check preparation uses two 30-second registration windows before a
separate 900-second completion wait. Accepted protected dispatches can therefore
block a campaign while still queued. Their nonce is lost when the process exits.

## Decision

Keep the required-check controller and existing manifest mutation owner. Add a
head-scoped CI monitor record to the campaign manifest through
`quality-invocation.withManifestLock`. The record binds repository, candidate
head, source head, base branch, resolved base SHA, start/deadline timestamps,
required contexts/apps, workflow IDs, transport, nonce and external ID.

The merge script supplies its exact manifest to ensure and wait. Initialize the
deadline once before dispatch, using the configured CI timeout (default 900
seconds). Both registration and completion consume this same absolute deadline.
Repeated reads and base changes never extend it. A changed base requires a
visible blocked result; a legitimate descendant head gets a new record while
retaining the old record as history.

Persist each dispatch intent before the external write. Record acceptance only
after success. A process interrupted between intent and acceptance must resume
read-only reconciliation. Never repeat an intended or accepted dispatch merely
because the check is absent. Existing signed local/remote nonce claims remain
authoritative. Missing, uncertain, malformed, wrong-app, wrong-source, failed,
or expired checks never become successful evidence.

Classify write outcomes before reconciliation. A network failure after a POST
is ambiguous, so its exact intended record remains read-only on resume. An HTTP
authentication, authorization, or validation response is a definite rejection.
Remove only the creator-owned matching `intended` record for that rejected
write, propagate the error, and allow the same monitor to create a new attempt
after the external condition is corrected. Never remove an accepted, changed,
or differently bound record.

After the short initial registration grace, dispatch missing eligible checks
once. Poll all dispatched requirements against exact nonce/head/base/app/source
bindings until registration or the original deadline. Completion uses these same
bindings and deadline. Clamp polling sleeps to remaining time. Existing plain
workflow dispatch correlation stays exact-head/workflow/ref bound.

Protected dispatch authorization expires at the same persisted deadline, within
the protocol's existing maximum 15-minute lifetime. Reject a protected monitor
timeout above that maximum before dispatch. Persist the authorization issue and
expiry timestamps with intent; never renew them on resume. This avoids the
existing 10-minute envelope expiring while the 15-minute monitor is still open.
Do not change signature verification or its expiry enforcement.

The legacy direct API without a manifest retains compatibility for existing
non-campaign callers. The production merge caller must use manifest persistence.
No new scheduler, signing path, or campaign recovery capability is introduced.

## Alternatives

- Increase each local timeout: rejected because resume still renews the deadline
  and loses dispatch identity.
- Redispatch on each resume: rejected because ambiguous writes are not safe to
  repeat and can consume extra CI resources.
- Sidecar state owner: rejected because the manifest already owns campaign state.

## Invariants and rollback

Only the existing campaign mutation lock writes the monitor. Validate manifest
repository and current candidate before reads or writes. Expiry stays blocked.
Do not clear terminal state, add provider budget, or recover historical reviews.
Rollback is a reviewed revert; existing monitor records remain audit evidence.

## Verification

Exercise the public required-check API with fake GitHub responses and virtual
time: registration after 30 seconds but before 900; one nonce/dispatch across
resume; unchanged deadline; deadline exhaustion; wrong head/app/source/nonce;
base changes; and ambiguous dispatch intent. Verify merge-script wiring and run
the repository affected-test plan. No live dispatch is needed for regression.

Initial CLI ADR review was stopped after 13 minutes without a design verdict.
It expanded into reviewing the intentionally RED regression and repeated source
inspection. It is incomplete evidence, not approval. A narrowly scoped design
review resolved the ADR before production implementation: CLEAN, with explicit
confirmation that intent and acceptance must use separate manifest mutations.
