# scripts/

Automation scripts for agent-kit. Most scripts are standalone — run directly or via GitHub Actions.

## Other scripts

Most other scripts in this directory are utilities invoked by slash commands,
GitHub Actions workflows, or pre-commit hooks. See comments at the top of each file.

### Worktree lifecycle

`worktree-manager.js` is the only supported source of worktree paths and
lifecycle policy. It stores linked worktrees at
`<primary-parent>/.worktrees/<repo-name>/<branch-slug>` and exposes JSON-first
`resolve`, `create`, `lock`, `unlock`, `status`, `remove`, `reconcile`,
`repair`, and `migrate` commands.

Existing layouts remain registered and usable during rollout. Preview their
state and proposed destinations with:

```bash
node scripts/worktree-manager.js migrate --repo /path/to/repo --dry-run
```

Apply only after reviewing dirty, locked, and PR state:

```bash
node scripts/worktree-manager.js migrate --repo /path/to/repo --apply
```

The apply path moves only clean, unlocked, unambiguous worktrees and repairs
Git metadata afterward. Active legacy worktrees are never moved implicitly.
