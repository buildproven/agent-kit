# Portable autonomous-loop usage checks

Install/update claude-kit using its normal installer on each computer. The
installer links `scripts/provider-usage-adapter.js` with the other runtime
scripts; no machine-specific absolute path is stored in the repository.

Install the CodexBar CLI on each computer and sign in to the selected coding
provider locally. CodexBar owns provider authentication and usage retrieval.
See <https://github.com/steipete/CodexBar> for installation and platform support.
Credentials and usage snapshots must never be copied between computers or
committed to this repository.

The long-lived loop launcher runs:

```bash
node "$HOME/.claude/scripts/autonomous-loop-runtime.js" admit \
  --kind ralph --id "$LOOP_ID" --provider codex --owner-pid "$$"
```

Use `--provider claude` when Claude will execute the work. Provider selection
is explicit; a Claude loop cannot use Codex capacity as evidence. Provider
fallback must be declared with `--fallback claude` or `--fallback codex`;
admission checks both providers before admitting a loop that can use either.
The overnight launcher resolves its configured provider automatically and uses
the same selection for admission and execution. Its Codex phase currently has
no fallback, so only Codex capacity is checked on that path.

The adapter queries CodexBar automatically, retains only provider and numeric
capacity windows, and rejects observations older than five minutes or more
than thirty seconds in the future. Missing CLI, authentication failures,
ambiguous accounts, and invalid observations stop admission with an actionable
error. No historical session scan or manually maintained JSON is required.
The existing utilization and concurrent-loop limits remain unchanged.

Legacy `--usage-command` integrations remain supported with the original
`fiveHourPercent` and `sevenDayPercent` numeric response contract.

Release the slot in the same live launcher process with `release --id
"$LOOP_ID" --owner-pid "$$"`. Tests use an isolated temporary state directory.

## Local acceptance contract

Tracking: BUI-842. These checks describe the delivered local behavior, not
protected admission receipts or installation on a second physical computer.

- [x] 1.0 Read current capacity for the selected provider without manual snapshots.
  - Phase: implementation
  - Delivers: Strict, fresh Codex and Claude usage windows with sanitized errors.
  - Evidence: `scripts/__tests__/provider-usage-adapter.test.js`; local live probes for both providers.
- [x] 2.0 Distribute the reader through the normal installer.
  - Phase: implementation
  - Delivers: A clean isolated installation can resolve the shipped reader.
  - Evidence: `scripts/__tests__/autonomous-loop-runtime.test.js` installation contract.
- [x] 3.0 Admit unattended work using its execution provider.
  - Phase: implementation
  - Delivers: Both default-reader launcher paths work without a custom usage command.
  - Evidence: `scripts/__tests__/overnight-loop.test.js` provider admission cases.
- [ ] 4.0 Approve and verify the rollout on each target computer.
  - Phase: validation
  - Delivers: Final operator review and per-machine authentication/install verification.
  - Verification: Protected quality admission, final approval, and an authenticated read on each physical computer; not claimed by local fixture tests.
