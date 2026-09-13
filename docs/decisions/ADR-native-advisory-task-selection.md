# ADR: Native advisory task selection

## Status

Approved for this bounded implementation by the independent architecture review
of `ADR-four-goal-builder-delivery.md` lines 30-72 on 2026-09-11. This approval
covers native advisory selection only. It does not approve a headless economy
execution route, a new launcher, a quality change, or a merge.

## Decision

Add a versioned `native-advisory` request to `compute-governor resolve` and
`explain`. It returns task-scoped model and reasoning advice for a native
delegation. It does not invoke a client tool or provider.

The request supplies complete V1 consequence facts, the full task text, planned
paths, the selected parent identity, an optional explicit child override, context
mode, and the current native client's declared capabilities. Missing facts,
unknown capabilities, unsupported model/effort pairs, and overrides below the
hard floor return a visible blocked result with no arguments.

Native classification reuses the V1 facts classifier without the launch-time
economy promotion. Bounded low-risk work can therefore receive the V1 Luna
mapping. Protected, public, and cross-repository work retains the Critical
floor. Ambiguous work is never an economy recommendation. Repeated failure is
an advisory reason for Expert selection; it creates no execution receipt,
authority, or budget.

The resolver classifies both the supplied task text and planned paths using the
existing protected-surface policy, unions that result with declared surfaces,
and returns only a SHA-256 digest and the classified surface names. It does not
return the task text.

V1/V2 governed execution, calibration promotion, provider launch isolation,
and quality routing remain unchanged. Native callers consume ready arguments
only through the native Task or `spawn_agent` surface that declares matching
capabilities. A full-history fork preserves its parent and cannot take an
override.

Claude Task obtains the selected effort from one of the neutral native task
profiles (`native-task-low`, `native-task-medium`, or `native-task-high`), not
from a global setting or an unrelated specialist. The neutral profiles inherit available parent tools and permissions; they do
not impose a developer-only tool allowlist on research tasks. Callers check the
required task tools before spawning. The caller passes the ready model alias
and profile name, then checks `/tasks` for the effective identity.
The built-in `general-purpose` type covers the Haiku/null-effort pair.

## Consequences

- A native advisory result is capability advice. It is not a security boundary
  against a dishonest caller and does not grant permissions or merge authority.
- An explicit supported override can be below the recommendation only when it
  remains at or above the hard safety floor, including an explicit operator
  route. The result records that downgrade.
- A caller that cannot set the recommended effort reports the blocked result and
  either continues safe local work or uses another supported route. It does not
  silently inherit a global default.

## Verification

Test the public resolve/explain CLI result for complete-fact validation, task
digesting, text and path classification, route/model/effort mappings, ambiguity,
floor-respecting explicit overrides, full-history inheritance, and unsupported
capabilities. Test consumer instructions by inspection; native tool invocation
cannot be asserted from JavaScript.
