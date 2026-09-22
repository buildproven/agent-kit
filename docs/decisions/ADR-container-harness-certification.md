# Container-backed harness certification

## Status

Proposed.

## Decision

Replace the macOS-native candidate executor with a Linux container executor
for harness certification. The executor runs from a protected default-branch
workflow after an untrusted source workflow has completed. It checks out the
frozen baseline as executable policy and fetches the declared PR SHA only as
candidate data.

The candidate container must have no network and fixed CPU, memory, PID, and
writable-disk limits. The trusted workflow must record the image digest,
baseline SHA, PR/base/head identity, fixed gate commands, limit values, and
container exit evidence in the certification receipt.

## Rationale

The macOS Seatbelt executor cannot prevent `POSIX_SPAWN_SETSID` while allowing
the subprocess behavior required by the harness test suite. A candidate can
therefore leave the recorded process group. Process-group cleanup is not a
sufficient lifecycle boundary for arbitrary candidate code.

Docker limits provide the required process namespace and cgroup boundary. A
container exit reaps every candidate process, including a new session leader.

## Trusted workflow boundary

1. An untrusted PR worker runs candidate code with no secrets and emits an
   identity-bound raw result.
2. A `workflow_run` workflow, defined on the protected default branch,
   validates the source run and exact PR identity.
3. The protected workflow checks out the baseline SHA, fetches the candidate
   SHA as data, and invokes only baseline-owned executor code.
4. The protected workflow publishes a receipt for the exact candidate head.

`pull_request_target` is not used. It is unsafe for this path because changes
to trigger-adjacent behavior are high-risk and the candidate must never supply
the executor or privileged workflow logic.

## Limits

The initial container contract is:

- `--network none`
- `--cpus 2`
- `--memory 3g`
- `--pids-limit 128`
- one fixed-size writable volume for candidate checkout and scratch
- read-only baseline toolchain volume
- no Docker socket, host home, host Git credentials, or receipt mount

## Verification

- A fixture that calls `setsid` or uses `POSIX_SPAWN_SETSID` cannot outlive
  container exit.
- A fixture exceeds each CPU, memory, PID, network, and disk bound and fails.
- Candidate workflow/configuration changes cannot alter the protected executor.
- A receipt with a changed baseline, PR, base, head, image digest, or limits is
  rejected.
