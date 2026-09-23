# ADR: Provider worker sandbox

## Status

Accepted for BUI-954. The first delivery is a launch wrapper. It is not yet a
claim that every provider workflow is isolated.

## Context

Provider workers inherit the coordinator's local environment by default. This
can expose GitHub credentials, SSH agent sockets, credential helpers, and
personal configuration outside the bound target and output directories. A
provider CLI sandbox alone does not make this host boundary explicit.

The wrapper must fail before worker launch when the operating-system sandbox is
missing or its deny-read policy is not enforced. It must also remove ambient
credential environment variables.

## Decision

Use the Apache-2.0 `@anthropic-ai/sandbox-runtime` package as a local worker
wrapper on macOS. Each launch:

- starts with `env -i` and passes only `PATH`, an account-home value resolved
  from the password database, and `TERM`;
- denies `/`, then opens only the bound paths and required system paths; this
  prevents reads from other user, volume, and temporary directories;
- rejects a target or output root that is the account home, its ancestor, or a
  known credential location;
- opens only the selected provider's configuration directory; and
- keeps writes allow-only, with explicit denials for shared Claude debug paths;
- permits only the bound target, output, required provider configuration,
  installed sandbox runtime, provider binary locations, and standard executable
  locations (including the macOS shell selector);
- permits only provider-specific network domains; and
- creates a unique denied-read sentinel and refuses launch if the runtime can
  read it.

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
- Provider workers do not receive `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_ENTERPRISE_TOKEN`, or `SSH_AUTH_SOCK`.
- Policy contains the exact SSH, GitHub, credential-file, and unique sentinel
  deny paths.

`scripts/__tests__/provider-worker-sandbox.test.js` proves these launch
contracts with a deterministic runtime fixture and a macOS runtime canary.
Live probes must separately prove Keychain, `git credential fill`, launchd,
AppleEvents, controller Git hooks/configuration, real provider authentication,
linked-worktree Git metadata, nested-repository rejection, and a provider
worker canary before this wrapper is wired into normal provider execution.

## Rollback

The wrapper is an unused, fail-closed launch utility until a later provider-run
integration. Removing that integration returns workers to the existing launch
path; it must not silently bypass a selected sandbox policy.
