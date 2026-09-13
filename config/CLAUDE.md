# CLAUDE.md — Your Global Claude Code Configuration

> Copy this file to `~/.claude/CLAUDE.md` (or let `install.sh` symlink it).
> Edit to match your preferences. This is the file Claude reads on every session.

## Action Defaults

- Match response depth to what was asked. A question gets a concise answer, not an audit.
- When asked to do something specific, just do it. Do not argue that the current setup should already work.

## Code Quality

- Fix ESLint errors at root cause. NEVER use eslint-disable.
- Use specific TypeScript types. NEVER use `any`.
- Let pre-commit hooks run. NEVER bypass with --no-verify.
- Remove unused code entirely.

## Communication

- Concise: < 4 lines unless detail requested. Skip preamble/postamble.
- After multi-step tasks, provide brief summary of what changed.

## Git

- Always create feature branch first. Never commit directly to main/master.
- Conventional commits: feat:, fix:, chore:, docs:
- One concern per branch.

## Tools & Workflow

- Use TodoWrite for complex multi-step tasks.
- Use Grep/Glob instead of bash search. Read files before editing.
- Batch independent tool calls in parallel.
- Keep small work local. Before substantial independent native delegation, use
  the `compute-governor resolve|explain` `native-advisory` request from
  the governor source's `../docs/compute-governor.md` (resolve its installed
  symlink first) with complete facts, full task text, planned paths,
  parent identity, and actual client capabilities.
- Use model and reasoning arguments only from a ready bounded/fresh decision.
  Claude Task uses the returned `subagent_type` and model alias; its
  `native-task-*` profile sets effort. Check `/tasks` for the effective identity.
  Full-history forks retain their parent. A blocked decision is visible: do not
  substitute a global default; continue safe local work when possible.

## Known Mistakes

- _Add patterns here as they occur._
