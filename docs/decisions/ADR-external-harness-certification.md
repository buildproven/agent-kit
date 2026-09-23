# ADR: Retire experimental harness certification

## Status

Supersedes the frozen-baseline certification decision from #624.
Accepted direction after independent Claude Opus 5.5 architecture review,
2026-09-23. Implementation and merge verification remain separate obligations.

## Context

The certifier recorded baseline and candidate commit identities but executed
mutable candidate configuration and tests with host authority. Pinning tools did
not isolate candidate execution, protect its evidence, or prove that the tested
content still matched the recorded revisions. Extending the runner into a generic
certification platform added a second delivery path without meeting those claims.

A source trace of agent-kit and agent-setup found no production admission or merge
consumer of these receipts. References are the experimental runner, its recovery
and status commands, tests and selector mappings. Manual callers may still exist,
so retain explicit compatibility refusals instead of silently removing commands.

## Decision

Retire execution and recovery. Both old command names exit 78 with a reason and
the supported alternative, without reading candidate inputs, running Git or
providers, creating receipts, or changing historical evidence.

Keep the status command read-only. For valid historical receipts it returns
`state: RETIRED`, the original `recordedState`, and
`authority: historical-only`. It must not imply that an old passing receipt
authorizes merge or that a missing parent PID makes descendants safe to restart.
No automatic migration or deletion of existing receipts occurs.

Use direct repository checks and independent review from a stable control
checkout, with required hooks, CI and existing merge protection. Candidate
runtime code remains a test subject, not its own policy or merge authority.
Retiring this command does not establish host isolation of ordinary repository
gates or finish provider-worker sandbox integration.

## Alternatives

Repair baseline selection only: rejected because it does not solve mutable
content, authority or evidence integrity.

Build stronger generic certification: rejected as unnecessary scope for a
command with no required production consumer.

Remove all three command files: rejected because unknown manual callers need
an actionable refusal and historical receipts must remain inspectable.

## Verification and rollback

Public CLI tests prove refusal, no new receipt, preservation of old receipts,
historical-only status and rejection of malformed historical states. Required
independent review and CI apply to the final revision.

Git history preserves the retired implementation. Restoring execution requires
a separately reviewed supported design and verified boundary; do not revive it
as an automatic fallback. Existing protected delivery remains unchanged.
