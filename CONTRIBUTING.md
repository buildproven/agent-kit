# Contributing to agent-kit

Thanks for your interest in contributing!

## How to contribute

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm test && npm run lint` — both must pass
4. Open a pull request with a clear description

## Development setup

```bash
git clone https://github.com/buildproven/agent-kit.git
cd agent-kit
npm install
./install.sh      # symlinks into ~/.claude/
```

## Conventions

- Conventional commits are enforced: `feat:`, `fix:`, `docs:`, `chore:`, etc.
- No `eslint-disable` comments — fix the root cause
- No `any` TypeScript, no `--no-verify`
- Tests live in `scripts/__tests__/` — add one for any logic you touch

## What's in scope

- Bug fixes and improvements to existing commands, skills, agents, and scripts
- New commands or skills that are useful to more than one person
- Documentation improvements

Nothing is out of scope for being "too advanced". This repo is the whole toolkit.

## What does NOT belong here

- **Anything Claude Code already does natively.** Check first. We deleted ~5,000
  lines of orchestration in July 2026 because the platform shipped it for free.
  A skill that wraps `/usage`, `/code-review ultra`, background subagents, the
  Workflow tool, or automatic memory will be redirected.
- **Anything with a private path in it.** No `$HOME/Projects/<your-name>/...`, no
  references to repos other people don't have. A public repo must never tell a
  user to run code from a path only you have.
- **Personal data.** No usage stats, billing figures, or private repo names.

## Reporting security vulnerabilities

See [SECURITY.md](SECURITY.md).
