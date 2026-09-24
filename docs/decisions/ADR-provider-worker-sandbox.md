# ADR: Provider worker sandbox

## Status

Accepted for BUI-954. The first delivery is a launch wrapper. It is not yet a
claim that every provider workflow is isolated.

## Process-introspection correction (implemented locally; delivery pending)

Sol/high reviewed this ADR on 2026-09-24 at 04:08–04:11 UTC. Its only finding
was an ambiguous observation date; the UTC timestamp below resolves it. No
architecture defect was reported. This is design review, not code review or
merge authorization. The native failed acceptance remains open until repaired.

Native acceptance on 2026-09-24 at 03:48 UTC shows that a worker can call
`sysctl(KERN_PROCARGS2)` for an unrelated, same-user synthetic Node process and
read its environment marker under the current wrapper and Sandbox Runtime
0.0.77. No real credentials were read. Blocking `ps`, clearing the worker's own
environment, and denying credential files do not close this kernel interface.
The synthetic process is needed: the OS omits environment values for some
platform-signed targets, which would give a vacuous passing control.

Decision: retain the existing runtime CLI and lifecycle; carry a
version-pinned, tracked dependency patch adding these two profile restrictions:

```scheme
(deny process-info* (require-not (target self)))
(deny sysctl-read (sysctl-name-prefix "kern.procargs"))
```

Apply the patch with the maintained `patch-package` installer, not an ad hoc
source rewrite or runtime string substitution. Keep the runtime and patch
installer available in the same dependency installation mode. The wrapper
must validate the supported runtime version and the SHA-256 of the patched
profile generator against committed values before any worker or canary launch.
Skipping lifecycle scripts, a missing patch, an unsupported version, or changed
generator bytes therefore refuses execution; it must not quietly use the
unpatched runtime. Future upgrades regenerate/review the patch and expected
digest together, with the native regression and client compatibility proofs.

The license gate rejects `jsonify`, a transitive dependency of patch-package's
serializer. A scoped npm override substitutes MIT-licensed
`fast-json-stable-stringify@2.1.0` for that serializer only. The only caller
writes JSON patch state; compact output preserves its parsed state. An isolated
install proved patch application, the expected generator hash, state save/read
round-trip, and the unchanged license allowlist. This follows the proposed
[upstream replacement](https://github.com/ds300/patch-package/pull/606), which
is not yet merged; it does not claim upstream approval.

Alternatives: a nested second Seatbelt sandbox is refused by the OS. The public
SDK returns a shell command on macOS, not a structured profile hook; editing
that string would couple a new launcher and proxy/signal lifecycle to an
undocumented format. A diagnostic-only string edit proved the policy direction,
but will not ship. A new credential broker, VM service, or broad read grant does
not fix this demonstrated native policy omission. No installed package has
been modified during diagnosis. Check for an upstream release before carrying
the patch; npm currently reports 0.0.77 as latest.

Verification before adoption: the same native synthetic reader must succeed
outside confinement and receive EPERM/no marker under the patched final wrapper;
removing the denial must expose the marker again. Keep positive allowed reads
and writes, denied outside paths, Keychain controls, argv quoting and both native
client startup checks. The captured final wrapper policy and correct allowed
working directory let Claude --version pass both before and after the prototype
denials; Codex startup also passes. Neither version check proves authentication.
Add a missing/altered-patch preflight test that proves the worker never starts,
plus clean-install checks. Do not relax existing filesystem/network policy.

Rollback restores the prior dependency and wrapper together but keeps A9
explicitly failed and the worker boundary uncommissioned. It cannot advertise
credential isolation with a known process-environment read path. This design
does not reset PR647's exhausted review campaign or grant merge authority.

## Context

Local correction evidence (2026-09-24, 04:18–04:20 UTC): the native process
environment regression failed before the patch (marker readable) and passed
after it (EPERM, no marker), with the outside-sandbox positive control retained.
The wrapper now checks the pinned version and patched generator SHA-256 before
any sandbox invocation. Missing, altered, and wrong-version fixtures all refuse
before the worker or write probe starts. The focused suite passes 22 tests with
two opt-in Keychain cases skipped, both before and after a clean `npm ci`.
ESLint, shell syntax, and diff whitespace checks pass. This is local evidence,
not completed independent code review, authenticated acceptance, or merge proof.
An additional opt-in native Keychain run passes the ordinary credential case;
the data-protection case remains unverified because the host baseline lacks its
required entitlement (the other 22 cases were excluded by the test filter).

Provider workers inherit the coordinator's local environment by default. This
can expose GitHub credentials, SSH agent sockets, credential helpers, and
personal configuration outside the bound target and output directories. A
provider CLI sandbox alone does not make this host boundary explicit.

The wrapper must fail before worker launch when the operating-system sandbox is
missing or its deny-read policy is not enforced. It must also remove ambient
credential environment variables.

Policy construction uses the already validated jq executable and receipt-bound
Node runtime. It does not require Python. The Node path resolver starts with an
empty environment so ambient Node options cannot alter controller policy creation.

## Decision

Use the Apache-2.0 `@anthropic-ai/sandbox-runtime` package as a local worker
wrapper on macOS. Each launch:

- starts with `env -i` and passes only `PATH`, an account-home value resolved
  from the password database, and `TERM`;
- resolves the sandbox runtime only from this package's installed dependency;
- accepts only a clean, detached linked worktree with a controller receipt that
  binds its exact HEAD and an empty controller-owned output directory; and
- denies `/`, then opens only the bound paths and required system paths; this
  prevents reads from other user, volume, and temporary directories;
- rejects a target or output root that is the account home, its ancestor, or a
  known credential location;
- denies both provider configuration directories. A later integration must
  prove a minimal authentication broker before it opens any provider state; and
- keeps writes allow-only, with explicit denials for shared Claude debug paths;
- permits only the bound target, output, installed sandbox runtime, provider
  binary locations, and standard executable
  locations (including the macOS shell selector);
- permits only provider-specific network domains; and
- proves one allowed control read and one denied sentinel read under the same
  minimal launch environment before it starts a worker.

The wrapper has no merge, Git credential, or controller authority. It is not a
generic workspace-write API. A worker that may write arbitrary files in a live
Git target can create a nested repository or other future controller input that
an operating-system path policy cannot predict. Production adoption therefore
requires the existing governed provider-run path: a detached exact-head
worktree, classified patch handoff, and controller validation before any change
reaches the live target.

## Alternatives

Keep the existing provider CLI options only. Rejected: they constrain model
tools but do not scrub the parent environment or prove operating-system policy.

Build a new sandbox service. Rejected: it adds a daemon, protocol, and new
state without improving this local launch boundary.

Use a container. Rejected for this first macOS-native worker boundary: it adds
image lifecycle and host integration cost, and does not remove the need for
credential and controller probes.

## Invariants and verification

- No runtime executable: exit 74 and no worker starts.
- A permissive denied-read canary: exit 78 and no worker starts.
- A missing, stale, or dirty governed snapshot: exit 78 and no worker starts.
- Provider workers do not receive `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_ENTERPRISE_TOKEN`, or `SSH_AUTH_SOCK`.
- Policy contains the exact SSH, GitHub, credential-file, and unique sentinel
  deny paths, including Git metadata, Husky, and executable shim directories.

`scripts/__tests__/provider-worker-sandbox.test.js` proves these launch
contracts with a deterministic runtime fixture and a macOS runtime canary.
Live probes must separately prove Keychain, `git credential fill`, launchd,
AppleEvents, controller Git hooks/configuration, real provider authentication,
linked-worktree Git metadata, nested-repository rejection, and a provider
worker canary before this wrapper is wired into normal provider execution.

## Executable-path follow-up (BUI-954, measured decision)

The installed clients fail before startup because their launchers resolve into
denied user directories. A native probe in an already allowed target also fails
when invoked through `/var` rather than its canonical `/private/var` path.

A proposed receipt extension for extra executable reads received a bounded
Claude Opus design review. Its intended red regression then passed on unchanged
code. Actual native Claude and Codex `--version` also pass without extra grants.
Therefore do not implement that extension. Process execution and file reading
are separate sandbox operations; an executable does not always need a read grant.
The Claude shell launcher failed while searching a denied versions directory;
the Codex npm launcher failed, but its native executable did not. A future
controller integration must resolve native binaries before confinement and use
canonical paths. Do not grant package trees to compensate for launcher behavior.
No production wrapper or receipt schema change is needed for these version probes.
This finding does not establish authenticated execution or ordinary tool use.

Before integration, repeat filesystem/environment and native Keychain probes
under the exact final policy. Any policy change invalidates prior results.
The ordinary native `SecItemCopyMatching` canary is readable outside confinement
with the same scrubbed environment and returns no item inside. The synthetic
item is removed in a finally path. Data-protection item creation returns -34018
outside confinement: this case is unverified, not a sandbox pass. The installed
Claude and Codex entitlements contain no Keychain access groups; do not assume
this establishes support or isolation for future signed clients. Authentication
integration must resolve that gap or explicitly reject an unsupported client.
No test reads real account credentials.

Alternatives: broad home/package grants are rejected because they expose
unrelated state. Loading a JS launcher is unnecessary for the installed native
clients and adds interpreter/package-path obligations. Future script-only
installations require a separate bounded launch contract, not silent fallback.

Verification: exact installed native `--version` for both clients; canonical
native execution while the same file remains unreadable; unchanged file/Git
write/ambient-environment denial; and native credential probes. Run the optional
host credential tests with `BS_SANDBOX_CREDENTIAL_PROBE=1 npx vitest run
scripts/__tests__/provider-worker-sandbox.test.js`. They create uniquely named
synthetic items only, clean them up in finally paths, and explicitly skip an
unsupported data-protection baseline instead of claiming it passed. The default
suite does not require access to an operator's Keychain. A selected isolation
mode must never fall back to unrestricted execution.

## Integration rollback

The wrapper is an unused, fail-closed launch utility until a later provider-run
integration. Removing that integration returns workers to the existing launch
path; it must not silently bypass a selected sandbox policy.
