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

- starts with `env -i` and passes only `PATH`, `HOME`, and `TERM`;
- denies home reads plus known GitHub and SSH credential paths; writes remain
  allow-only, so only the bound target and output paths are writable;
- permits only the bound target, output, required provider configuration,
  installed sandbox runtime, provider binary locations, and standard executable
  locations;
- permits only provider-specific network domains; and
- creates a unique denied-read sentinel and refuses launch if the runtime can
  read it.

The wrapper has no merge, Git credential, or controller authority. It is a
small launch boundary that provider orchestration can adopt after the real
client-authentication and controller-hook probes pass.

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
contracts with a deterministic runtime fixture. Live probes must separately
prove Keychain, `git credential fill`, launchd, AppleEvents, controller Git
hooks/configuration, real provider authentication, and a worker canary before
this wrapper is wired into normal provider execution.

## Rollback

The wrapper is an unused, fail-closed launch utility until a later provider-run
integration. Removing that integration returns workers to the existing launch
path; it must not silently bypass a selected sandbox policy.
