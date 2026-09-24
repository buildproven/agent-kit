# ADR: Bounded provider review and deterministic delivery baseline

## Status

Accepted for the quality-runtime simplification change. This decision applies
to `agent-kit` and the `core/` submodule consumed by `agent-setup`.

## Problem

The review runner currently gives a provider-owned repository exploration command
the same bounded clock as the actual review. A small patch can therefore spend
its entire review budget on `git status`, full-file reads, and instruction
discovery before a structured verdict exists. The fallback path can then be
skipped by a stale provider-health circuit even when the provider is currently
logged in. The resulting incomplete checkpoint blocks the delivery workflow and
causes repeated CI pushes and billed workflow rounds.

The patch that exposed this behavior was only 67 additions and 2 deletions in
two files. The large input was provider-side context expansion, not a large Git
diff.

## Decisions

### 1. Build review evidence before the provider clock

The quality runtime already materializes the exact base-to-HEAD diff, changed
file list, commit log, identity, focus, and input digest. That envelope is the
only review input. Both Codex and Claude receive the same prompt file. The
Codex discovery path must not call the native `review --base` command, because
that command is allowed to rediscover repository context inside the timeout.

Provider execution starts in the review artifact directory with no repository
context. The provider may inspect only the supplied envelope and must return the
structured schema. Preparation and hashing remain outside the provider timeout.
Claude review also disables user/project setting sources and MCP loading and
replaces the default system prompt with the selected reviewer body. A measured
control invocation fell from roughly 176k-195k cached context tokens to 160
input tokens before the actual review envelope; global setup context is not part
of a bounded static review.
The envelope uses compact JSON because formatting whitespace is repeated in each
provider request and does not improve review quality. Terminal telemetry records
the exact prompt/output artifact character counts and a clearly labelled
`artifact-chars/4` token estimate; provider-reported token usage remains nullable
until a stable cross-provider usage contract exists.

### 2. Provider order is configuration, not architecture

The valid routes are `claude -> codex`, `codex -> claude`, or a single provider.
The quality runtime must not identify a provider as "primary" or "fallback" by
model family, and critical-path handling must not hard-code Claude as the
required final reviewer. The manifest records the configured order and the
actual reviewer independently.

### 3. Provider health is a hint, not an unverified veto

An exhaustion or billing record is retained for diagnostics, but an open circuit
must first perform a cheap live CLI/auth probe. If the probe succeeds, the
provider is allowed one normal bounded attempt; typed exhaustion or billing
metadata records a fresh circuit failure. A stale circuit may not silently turn
an available fallback into "did not run."

### 4. AI review is advisory; deterministic evidence is authoritative

An unavailable, timed-out, or malformed provider produces a signed
`review-incomplete` checkpoint bound to the exact HEAD and diff. It is never
converted into a clean AI verdict. It also does not override deterministic gate,
CI, exact-head, security, or branch-protection failures. When those authoritative
checks pass, an incomplete AI checkpoint does not require a human merely to
repeat an unavailable provider.

Critical changes may still require an explicit human-required merge policy when
the repository config sets that floor. That is a merge-authority decision, not
an implicit provider-availability decision.

### 5. External account integrations are outside the baseline

Stripe, Vercel, LinkedIn, and similar MCP OAuth grants are operational
integrations. An `invalid_grant`, missing login, or expired account token is not
evidence that the build system or quality runtime is broken. Registration and
configuration parity can be checked, but account-scoped calls remain a separate
non-blocking integration track.

### 6. CI budget is an explicit quality constraint

The billed setup repository uses one cached dependency installation per
authoritative concern. Duplicate `test-setup.sh --ci` executions are removed
where another required workflow already runs the same signal. Draft PRs do not
start expensive jobs. The minute audit reports per-job rounded billing rather
than raw wall-clock time so repeated retries are visible.

The public runtime supports an optional fleet policy. Agent-initiated direct
pushes and final merge admission consult one cached snapshot. At the hard limit,
direct pushes stop before creating a workflow run; a signed, expiring operator
capability may select the existing local exact-head path during a verified
billing outage. Absence of private fleet policy keeps the public kit standalone.

### 7. Model escalation is scoped, not session mutation

The quality scorer selects the Codex reviewer mechanically: Luna for low,
Terra for medium/high, and Sol for critical. The selected model and effort are
passed on the bounded provider command. Skills do not replace the operator's
interactive builder model, and a stronger interactive session does not silently
downshift. Claude subagents continue to inherit the Claude session model; its
critical diversity policy remains separate.

### 8. Exact-head CI evidence is immutable and reusable

A successful GitHub Actions check may be cached and reused without another API
call only when repository, workflow, check name, base SHA, candidate SHA and
kind, GitHub Actions app identity, source URL, and conclusion match. Any mismatch
forces a fresh fetch or fails closed; PR-level rollups and user-authored
attestations are not trusted evidence.

## Acceptance evidence

- A review artifact contains the complete diff and prompt before any provider
  process starts.
- Codex discovery and Claude review consume the same prompt digest and do not
  invoke repository exploration as part of the review command.
- `claude -> codex` and `codex -> claude` fixtures both select the configured
  primary and use the other provider only for a typed fallback.
- A stale provider-health record is live-probed before the provider is skipped.
- An incomplete provider result is signed and remains distinct from a clean
  result; deterministic failures still block.
- The relevant kit and setup workflow checks run once per concern, use npm
  caching where dependencies are installed, and expose billed-minute estimates.
- MCP account OAuth failures do not enter the core quality baseline.
