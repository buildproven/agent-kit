---
name: bs:quality
description: Autonomous quality loop with configurable thoroughness. Runs checks, revision-bound review, remediation, CI, and optional merge.
argument-hint: "[status --manifest <path>] [--level auto|95|98] [--scope branch] [--review-arm native|bespoke] [--delivery-claim contract|engineering|local-product|hosted|validated] [--product-prd <path> --product-tasks <path> --delivery-evidence <json>] [--verify-app] [--merge] [--pr <number>] [--manifest <path>] [--target-dir <path>]"
tags: [quality, ci, review]
category: quality
---

For on-demand status of an in-flight or stalled campaign, the supported
command is:

```text
/bs:quality status --manifest <exact-manifest-path>
```

This does NOT fork the quality skill or start/resume a campaign — it is a
direct, read-only diagnosis print. Resolve and run it exactly like this:

```bash
STATUS_SCRIPT=""
for candidate in \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/quality-status.sh" \
  "${CLAUDE_KIT_ROOT:-}/scripts/quality-status.sh" \
  "$HOME/.claude/scripts/quality-status.sh" \
  "./scripts/quality-status.sh"; do
  [ -n "$candidate" ] && [ -f "$candidate" ] && { STATUS_SCRIPT="$candidate"; break; }
done
[ -n "$STATUS_SCRIPT" ] || { echo "quality-status.sh not found" >&2; exit 1; }
bash "$STATUS_SCRIPT" --manifest "<exact-manifest-path-from-the-command-arguments>"
```

There is deliberately no PR-number or session lookup for `status` — the
caller must supply the exact manifest path, same as every other resume path
in this skill (printed as `BS_QUALITY_MANIFEST=` by an earlier
bootstrap/resume). If `--manifest` is missing from the command arguments,
report that to the user rather than guessing.

For every other invocation, run bootstrap in this wrapper before forking:

```bash
BOOTSTRAP=""
for candidate in \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/quality-bootstrap.sh" \
  "${CLAUDE_KIT_ROOT:-}/scripts/quality-bootstrap.sh" \
  "$HOME/.claude/scripts/quality-bootstrap.sh" \
  "./scripts/quality-bootstrap.sh"; do
  [ -n "$candidate" ] && [ -f "$candidate" ] && {
    BOOTSTRAP="$candidate"
    break
  }
done
[ -n "$BOOTSTRAP" ] || {
  echo "quality-bootstrap.sh not found" >&2
  exit 1
}
WRAPPER="$(dirname "$BOOTSTRAP")/quality-wrapper.js"
[ -f "$WRAPPER" ] || {
  echo "quality-wrapper.js not found" >&2
  exit 1
}
node "$WRAPPER" "$BOOTSTRAP" <<'BS_QUALITY_REQUEST'
{"argv": ["<each invocation argument as one JSON string token>"]}
BS_QUALITY_REQUEST
```

The forked quality skill passes the returned exact manifest to
`scripts/quality-run.js`. The model does not sequence gate, review, or merge
scripts. A runner exit of 3 names the external capability needed to resume.

Construct the JSON array directly from the parsed slash-command arguments; do
not interpolate the raw argument string into shell. JSON escaping preserves
spaces, quotes, and metacharacters as inert argument data.

Quality merges are autonomous by default, including critical-tier changes. Risk
changes the depth of bounded AI discovery; it never creates a routine human
approval step. Under review contract v2, AI leads and completion status are
advisory: unavailable or malformed provider output is signed as `incomplete`,
never presented as a clean review. Deterministic gate or mutation failures,
stale revision identity, invalid evidence or signatures, required CI failures,
and explicit human-required policy remain hard merge blocks.
If custom review-check publication is unavailable while exact-head CI is still
pending, merge waits for CI and signs local review evidence only after CI is
green. The pending state is not recorded as a terminal failure.
Claude fallback review streams the exact prompt through standard input. Large
diffs do not enter the process argument list or depend on the host ARG_MAX.
Critical Claude fallback requires usable evidence for every selected role. It
does not terminal-block only because those roles inherit one model family.

Declare the strongest delivery claim. `contract` is the default only for
backward-compatible non-product campaigns. `engineering` requires an enabled,
closed policy at the exact current protected base. It preserves deterministic
gates, independent review, required CI, freshness, and merge authority. It does
not accept product evidence or establish product acceptance. Any `local-product`, `hosted`, or
`validated` claim requires `--product-prd`, `--product-tasks`, and a JSON
`--delivery-evidence` file; quality runs the separate product-completion
verifier after deterministic gates. Product claims accept only signed version
2 receipts from the fixed system Ed25519 trust root. Each receipt binds the
numeric GitHub repository ID, exact HEAD, selected PRD/task digest, protected
producer provenance, and exact artifact. The campaign binds one evidence-index
digest per HEAD; an authorized HEAD advance archives and renews that binding.
Local verification is preflight only. Admission uses a trusted verifier on a
fresh protected worker. This verifier does not weaken or replace quality gates.
A valid candidate-worker preflight never authorizes a product merge. The runner
returns `product-admission` as a typed external capability until protected
admission evidence is available.

`--review-arm native|bespoke` is the bounded Wave 3 experiment control.
`native` assigns Codex's provider-native structured review with Claude fallback;
`bespoke` assigns the Claude companion panel with Codex fallback. The assigned
arm and actual reviewer are recorded separately, so a fallback stays visible
without relabeling the experiment treatment. Without this flag, ordinary
provider policy remains unchanged and telemetry infers the received arm from
the actual reviewer.

The review runner owns one bounded same-range retry for an incomplete v2
provider-failure attestation. If that retry is also incomplete, it records
`reviewStatus: incomplete`, which remains visible in the signed trailers while
deterministic gates continue to merge authorization. Provider availability is
not itself a human-intervention gate.

A provider that rejects the exact review envelope because it exceeds that
provider's input limit is not retried with the same impossible input. The
runner preserves the complete envelope and immediately tries the configured
fallback once. If no fallback completes, signed incomplete evidence remains
fail-closed.

`--verify-app` (BUI-306) is opt-in only — never enabled by default. Every
other gate (lint/type/build/test/security) proves the code compiles and its
unit tests pass; none of them boot the app. This flag adds a `verify-app`
required gate that actually boots it: it detects the project's runtime shape
(web / server / CLI / library) from `package.json`, boots the dev server or
binary within a bounded timeout, and for a web project drives a real headless
browser (`agent-browser`) to load the root page and assert zero JavaScript
errors and zero `console.error` output. A library with no runnable
entrypoint records a clean pass with a "not applicable" note rather than
failing or being silently skipped. Boot cost and environmental flakiness are
real (cold caches, port contention, a slow-starting dev server), which is why
this stays opt-in rather than a default gate — use it on PRs that touch
runtime-affecting code (bootstrap, routing, top-level providers) where
"compiles and unit-tests pass" is not enough evidence that the app still
starts. A repo can declare 1-2 richer critical flows in
`.quality-app-flows.json` (see `scripts/quality-verify-app.sh`); the
zero-config baseline requires no repo opt-in beyond this flag.

Repositories that explicitly set `scorePolicy.mergeAuthority` to
`"human-required"` retain the legacy signed break-glass capability. The
ordinary exact-identity approval command is:

```text
/bs:quality approve --pr <number> --head <exact-40-character-sha>
```

The wrapper removes only the `approve` and `--head` control tokens before
bootstrap, verifies bootstrap resolved that exact PR and HEAD, then creates the
same signed, expiring capability used by the legacy outer
`BREAK_GLASS_APPROVED=true` channel. Nested/headless children cannot mint this
capability. The wrapper prints repository key, PR, HEAD, invocation, approver,
and expiry before the quality skill continues with the returned manifest.

When the operator explicitly accepts one or more diagnosed terminal
conditions — a failing deterministic gate, missing mutation evidence,
legacy-v1 unresolved provider review, or a specific accepted code finding —
use the standalone override command:

```text
/bs:quality override --pr <number> --head <exact-40-character-sha> --reason "<text>" --accept <condition-id>[,<condition-id>...]
```

When the diagnosis belongs to an existing campaign, bind the override to that
exact invocation instead of starting or resolving another campaign:

```text
/bs:quality override --manifest <exact-manifest-path> --pr <number> --head <exact-40-character-sha> --reason "<text>" --accept <condition-id>[,<condition-id>...]
```

In this form, `--manifest` is the only selector forwarded to bootstrap;
`--pr` and `--head` remain mandatory signed identity assertions and must match
the selected manifest. Campaign-creation options cannot be combined with an
exact-manifest approval. Never guess or discover a manifest from the PR number.

If the selected campaign is terminal because its bounded provider retry is
exhausted and the PR now contains a legitimate descendant fix, the override
must name the descendant HEAD. Bootstrap may advance that same manifest only
with `review:provider-exhaustion` plus `--i-understand-missing-review`; it keeps
the prior review incomplete, does not create another provider budget, and
requires deterministic gates and mutation evidence to be rerun at the new
HEAD before the signed override is attached. A changed HEAD never inherits a
clean review verdict. Once that transition is recorded, the exhausted campaign
cannot authorize another provider attempt; a later code change requires a
fresh campaign rather than reusing its provider history.

`override` is a strict alias for
`approve --override-quality --reason ... --accept ...`; both mint the same
signed `operator-quality-override` capability through the one path in
`quality-wrapper.js` that ever creates that scope. This is never automatic
and never a substitute for the normal quality path — it exists for the
narrow case where the evidence is already adequate for the repository
owner's risk tolerance but automation cannot proceed on its own (unavailable
or malformed legacy-v1 review output, a flaky gate, exhausted CI billing, or a
code finding the operator consciously accepts for a time-bound release).

Before minting the capability, the wrapper prints the full terminal
diagnosis and the exact evidence snapshot, then lists every currently
diagnosed condition by its stable id (`gate:<name>`, `mutation:missing`,
`review:<reason>`, `review:finding:<id>`, `ci:<reason>`). `--accept` must
name every diagnosed condition exactly — an incomplete or stale list is
rejected. Accepting a high-risk condition (a security or test gate, missing
CI, or an unresolved code finding) additionally requires the matching
acknowledgement flag: `--i-understand-security-risk`,
`--i-understand-test-risk`, `--i-understand-missing-ci`, or
`--i-understand-code-finding`; accepting exhausted provider review also
requires `--i-understand-missing-review`. These flags are deliberately available to the
repository owner, never technically blocked — they exist to make accepting
serious risk a harder-to-fat-finger action than the ordinary accept path.

The resulting capability is bound to repository, PR, exact HEAD, exact base
SHA, invocation, the accepted condition-id list, approver, reason, and a
short expiry (`BS_QUALITY_OVERRIDE_APPROVAL_TTL_SECONDS`, default 900s —
shorter than the standard approval's default 3600s, since this is a
one-shot exception decision, not routine sign-off). Any HEAD, base, or
invocation drift, or expiry, refuses reuse and requires a fresh, explicit
decision. Deterministic gates and mutation evidence still gate the merge for
every condition that was NOT explicitly accepted; CI, protected-base
freshness, and the merge audit trail remain mandatory regardless of what was
accepted. New campaigns carry this decision in signed exact-head evidence;
legacy stamped campaigns additionally carry `Quality-Override:
operator-quality-override`, `Quality-Override-Reason`,
`Quality-Override-Accepted`, and `Quality-Override-Approver` alongside — not
instead of — the normal evidence trailers; it never fabricates a clean AI
review or hides that the operator accepted the remaining risk. The bounded
automatic retry for a marker-only fallback review (a separate mechanism)
still gets its chance before an operator needs to reach for this — override
is the final step after diagnosis, not a way to skip retrying first.

A protected base with required checks and GitHub `strict: false` uses the
non-force exact-head ref-CAS path automatically when merge authority is
autonomous, the repository explicitly sets
`scorePolicy.protectedNonstrictRefCas` to
`"accept-non-atomic-pr-state"`, and exact-head review, gates, required CI,
protection, conversations, identity, and ancestry are complete. This committed
policy must already exist on the exact protected base; a PR cannot authorize
itself. It accepts the close-or-retarget race once, so do not request operator
approval for each later green delivery. Repositories without it remain
signed-only. `mergeAuthority` comes from that same base commit, so a candidate
cannot remove human-required governance for its own delivery.

If the bounded provider review is exhausted, use the exception command and add
`review:provider-exhaustion` to `--accept` and add
`--i-understand-missing-review`. Do not mint a second capability; the one signed
artifact must contain every accepted condition.

During a classified Actions billing outage, also accept and bind the missing CI.
The provider condition and acknowledgement can be added to this same command:

```text
/bs:quality approve --manifest <exact-manifest-path> --pr <number> --head <exact-40-character-sha> --override-nonstrict-refcas --reason "<text>" --ci-failure failed --accept ci:failed,base:protected-nonstrict,pr:non-atomic-state --i-understand-missing-ci --i-understand-admin-ref-mutation --i-understand-pr-state-race
```

This mints `operator-nonstrict-refcas-override`, not the general quality or CI
scope. It binds the complete classic-protection digest, exact required-check App
identities, and exact CI evidence. The final lease rechecks protection,
repository-admin
authority, resolved review threads, base SHA, PR identity, and head ancestry,
then performs one GitHub ref update with `force: false`. A stale-base rejection
keeps the campaign resumable. An ambiguous response remains quarantined.

Capture the exact `BS_QUALITY_MANIFEST=` path from bootstrap output. Invoke the
`quality` skill exactly once with only:

```text
--manifest <captured-exact-path>
```

Do not pass the original arguments into the fork, create an args tempfile,
duplicate argument channels, or re-enter this wrapper. Bootstrap enforces two
recursion guards: it refuses when `BS_QUALITY_HEADLESS=1` (a read-only review
child) and, once a campaign starts, exports `BS_QUALITY_ACTIVE=1` so any
descendant that tries to launch a _fresh_ campaign (no `--manifest`) is refused
— only a `--manifest` resume of the same campaign is allowed through. PR
selection is explicit: `--pr <number>`; ambiguous positional forms such as
`--merge 1` are invalid.

For a safe continuation, pass the exact manifest printed by the earlier run:

```text
/bs:quality --manifest /exact/path/to/invocation.json
```

There is deliberately no "latest invocation" lookup or session-state glob.
`BS_QUALITY_HEADLESS=1` remains the recursion guard for provider children.
