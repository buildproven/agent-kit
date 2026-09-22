# Frozen certification isolation

## Decision

`harness-certify` will run every candidate-facing gate in its own disposable,
exact-SHA checkout under the macOS Seatbelt sandbox. The certifier process
keeps the baseline and receipt outside that sandbox. It supplies a minimal
tool environment and records each gate process group for diagnosis.

## Invariants

- Baseline and candidate source checkouts are clean before and after a run.
- Each gate checkout is created from the declared candidate SHA. It is not the
  PR worktree and cannot change the source worktree or a later gate's files.
- Candidate gates cannot read the operator home, unrelated temporary files,
  the receipt, or the baseline. They can write only their disposable checkout
  and sandbox scratch directory.
- Gate networking is denied. A security gate that needs the network fails
  closed rather than widening the boundary.
- Recovery never reuses a gate checkout or evidence from a dead certifier.
  A descendant that escapes its recorded process group remains confined to a
  unique sandbox directory and has no route to the receipt, baseline, source
  worktree, or a later gate. Recovery starts new isolated gate directories.
- The receipt records the baseline policy/toolchain digest before and after
  gates. A change makes certification fail.

## Alternatives

- Environment filtering only: rejected. It cannot protect credential files or
  the operator home.
- Run gates in the PR worktree: rejected. A clean commit SHA does not prove
  the files actually executed.
- Container or VM: not selected for the macOS-native first implementation.
  It adds an external runtime and is not present on every supported host.

## Rollback

The certifier fails before creating a passing receipt if Seatbelt is absent or
the profile cannot start a gate. No fallback runs candidate code on the host.

## Verification

Tests must prove that dirty baseline/candidate checkouts are refused, every
gate uses a new disposable exact-SHA checkout, a malicious fixture cannot
read a host sentinel or receipt, policy digest drift fails, and a detached
descendant cannot affect a later gate or recovery evidence.
