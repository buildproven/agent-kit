# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, and other AGENTS.md-compatible tools) when working with code in this repository.

## What this repo is

`claude-kit` is a **complete, standalone, free (MIT) Claude Code toolkit**. It ships commands, skills, agents, hooks, and setup scripts that get symlinked into `~/.claude/` (globally) or `.claude/` (per-project, typically via git submodule) — or installed as a Claude Code plugin. There is no runtime product — the artifacts here _are_ the product. Nothing is held back and there is no paid tier.

This repo is designed to be **extended, not forked**. An operator who wants private
commands, personal preferences, or service integrations puts them in their own
private overlay repo that submodules this one.

See `EXTENSION-ARCHITECTURE.md` for the contract. The key rule: **this repo never
embeds references to anything that overlays it**. Don't hardcode private-overlay paths
in anything under this repo — a public repo must never tell a user to run code from a
path only the author has.

## Installation model (important mental model)

There are two install surfaces, both work via symlinks so edits propagate without copy:

- **Global** — `./install.sh` symlinks this repo's `commands/`, `skills/`, `agents/`, `scripts/` into `~/.claude/`. Hook commands in `config/settings.json` resolve via `$HOME/.claude/scripts/...`. `scripts/setup-claude-sync.sh` is the separate verify/repair tool (`--check` / `--repair`) that `/bs:sync` drives; it links the same set.
- **Per-repo** — `scripts/install-commands-to-repo.sh` or the submodule flow in `QUICK_START.md` / `SUBMODULE_SETUP.md`. Target repo gets `.claude-setup/` (submodule) and `.claude/` with symlinks into it.

When editing, you are editing the source that both surfaces read. There is no build step — changes to a command or skill `.md` are live immediately.

## Commands

```bash
# Install (symlink commands/skills/agents/scripts into ~/.claude/)
./install.sh

# Lint (ESLint 9 flat config, security + defensive plugins)
npm run lint
npm run lint:fix

# Format
npm run format         # writes
npm run format:check   # dry-run

# Tests — Vitest, only runs scripts/__tests__/**.test.js and tests/unit/**.test.js
npm test
npm run test:watch
npm run test:coverage                            # 30% threshold (lines/fns/branches/stmts)
npx vitest run scripts/__tests__/foo.test.js     # single file
npx vitest run -t "pattern name"                 # single test by name

# Pattern / shell checks
npm run test:patterns       # scripts/pattern-check.sh --all
npm run pattern-check       # scripts/pattern-check.sh

# Security / dead code / licenses
npm run security:audit      # npm audit high
npm run security:scan       # semgrep via scripts/run-semgrep.sh
npm run dead-code           # knip (non-blocking)
npm run dead-code:strict    # knip (blocking)
npm run license:check       # MIT/ISC/BSD/Apache/MPL only
npm run check:commands      # scripts/check-command-readme.sh
```

Node 24+ (`engines.node`, pinned via Volta to 24.18.0). Python tooling (ruff/black/mypy) is configured in `pyproject.toml` for the handful of Python scripts in `scripts/` — but there is no `pytest` suite wired up despite `tests/` existing.

## Architecture

### What lives where, and what depends on what

```
commands/         Slash commands — frontmatter + markdown prompts
  bs/             /bs:* workflow commands (dev, quality, test, plan, ...)
  gh/             /gh:* GitHub (fix-issue)
  cc/             /cc:* Claude Code meta (create-command, update-claudemd)
skills/           Auto-invoked capabilities — each has SKILL.md + optional refs
agents/           Subagent definitions — code-reviewer, security-auditor
scripts/          Hooks, CI gates, utilities (bash + node + python)
  __tests__/      Vitest tests (node only) — the ONLY test surface
config/           Template CLAUDE.md + settings.json for distribution
eslint-plugin-defensive/   Local ESLint plugin published via path import
templates/        Starter files copied by /bs:new and related commands
.github/workflows/  quality, auto-release, stale-prs
```

`scripts/` is the only code surface with runtime logic worth testing. Commands, skills, and agents are prompt documents — they're "code" only in that Claude executes them, so keep them terse and concrete rather than trying to unit-test them.

### Hook system (lives in `config/settings.json`)

The distributed `settings.json` wires bash scripts in `scripts/` to Claude Code lifecycle events. Key ones:

- **PreToolUse (Bash)** → `bash-pretooluse-dispatcher.js` (fast common path plus the four compatibility guards: `block-destructive-paths.sh`, `block-push-main.sh`, `block-commit-main.sh`, `branch-drift-guard.sh`)
- **PreToolUse (Edit/Write/MultiEdit)** → `auto-branch-on-main.sh` (forces branching off main before edits)
- **PostToolUse (Edit/Write/MultiEdit)** → `post-edit-lint.sh`
- **Stop** → `stop-validation.sh`, `multi-session-cleanup.sh`
- **SessionStart** → `multi-session-guard.sh`

When changing any of these scripts: the hook invokes them as `$HOME/.claude/scripts/<name>` after symlink, so test via the symlinked path if you hit pathing issues. Claude Code hook timeouts in `settings.json` use **seconds**, not child-process milliseconds. A timed-out command hook can render no decision. The Bash dispatcher must deny before its outer five-second timeout; its child processes share a four-second budget.

### Quality / release automation

- `.github/workflows/quality.yml` runs the gate in CI — lint, format, tests, security scan, license check.
- `.github/workflows/release-please.yml` handles releases; `stale-prs.yml` does non-destructive PR housekeeping.
- `.husky/` + `lint-staged` run prettier/eslint/bash-syntax on commit. `commitlint.config.js` enforces conventional commits (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`).

### ESLint setup

`eslint.config.cjs` is a flat config that **gracefully degrades** if optional plugins aren't installed (`@typescript-eslint/*`, `eslint-plugin-security`, `eslint-plugin-n`). Don't change the try/catch pattern — the config runs inside downstream projects that may not have these installed.

Scripts directory gets looser security rules (`scripts/**/*.js` allows object injection, non-literal fs, non-literal regexp) because build tooling legitimately needs dynamic access.

`eslint-plugin-defensive/` is a local plugin (not published) shipping five rules: `no-unsafe-json-parse`, `no-empty-catch`, `require-auth-middleware`, `require-useCallback`, `require-guard-clause`. It is referenced by path from downstream projects' ESLint configs, not by npm install.

## Gotchas

- **Symlinks, not copies.** Editing a file here changes behavior in every machine/repo that symlinks it. Don't rename or move files under `commands/`, `skills/`, `agents/`, `scripts/` without checking what references them by path — `settings.json` and downstream overlays will have dangling links.
- **No TypeScript sources.** Despite TS plugin config in ESLint, there is no `tsconfig.json` or TS code. The TS branch is there for downstream projects. Don't add TypeScript here without widening scope deliberately.
- **`tests/` vs `scripts/__tests__/`**. Only the latter runs. `tests/__init__.py` is a vestigial Python stub — `pyproject.toml` references it but there's no runner configured.
- **Knip is non-blocking by default** (`dead-code` script swallows exit code). Use `dead-code:strict` before shipping structural refactors.
- **`install.sh` and `scripts/setup-claude-sync.sh` are two independent installers.** `install.sh` does its own symlinking (first-run install); `setup-claude-sync.sh` verifies/repairs (`/bs:sync`). They duplicate the link list — a change to one must be mirrored in the other, or they drift.
