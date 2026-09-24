# Claude plugin directory submission

`agent-kit` is ready for community-directory submission. The operator submits
the public GitHub repository through Anthropic's authenticated form; submission
is not automated because it requires account consent.

## Listing

**Name:** agent-kit (`bs`)  
**Job:** Prove agent-written code is ready to merge at the exact revision.  
**Description:** Provider-neutral engineering workflows for change-scoped tests,
bounded code review, exact-revision evidence, autonomous backlog delivery, and
fleet quality auditing. Works with Claude Code or Codex as the primary builder.
**Source/support:** https://github.com/buildproven/agent-kit  
**Security:** https://github.com/buildproven/agent-kit/security/policy

## Disclosure

The plugin installs local skills, commands, agents, hooks, and scripts. It does
not bundle an MCP connector or collect telemetry remotely. Quality telemetry is
local under `$XDG_STATE_HOME/agent-kit` unless the operator explicitly chooses
another local path. Provider CLIs and GitHub access are optional and use the
operator's existing authentication. Review source and permissions before install.

## Submission evidence

- Public repository: `buildproven/agent-kit`.
- Manifest: `.claude-plugin/plugin.json`.
- Marketplace catalog: `.claude-plugin/marketplace.json`.
- Local validation: `claude plugin validate .`.
- License: MIT, except the attributed Anthropic-derived frontend skill retained
  under Apache-2.0 as documented in `NOTICE`.
- Submission form: https://platform.claude.com/plugins/submit.

The directory is community-driven. Inclusion or an Anthropic Verified badge is
Anthropic's decision and must not be claimed before it occurs.
