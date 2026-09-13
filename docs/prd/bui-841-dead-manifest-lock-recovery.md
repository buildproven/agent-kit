# BUI-841: Dead manifest lock recovery

## Problem

A killed manifest writer can leave an exclusive local lock file that blocks a
valid merge campaign even while the repository metadata guard is held.

## Requirements

- Recover only a regular same-user local lock whose owner PID returns ESRCH.
- Hold and revalidate the exact repository metadata guard before replacement.
- Require every manifest writer, including the raw compatibility path, to use
  that guard so replacement is serialized through exclusive creation.
- Compare lock device, inode, and body before unlinking, then acquire through
  exclusive creation. Keep live, remote, malformed, EPERM, and race cases
  blocked.

## Acceptance

- Recovery preserves manifest evidence and budgets.
- Concurrent recovery permits one writer only; no path deletes a lock by age.
