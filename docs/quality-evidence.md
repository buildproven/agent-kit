# Quality Evidence Trust Boundary

`Reviewed-By` and `Quality-*` trailers are machine-parseable records of a
quality campaign; they are not cryptographic attestations. Any process that can
create a commit can type matching trailers, so a trailer alone must never be
treated as proof that an independent reviewer approved a change.

The quality runtime reduces accidental or negligent-agent failure by binding
trailers to an exact HEAD and merge base, requiring contiguous review coverage,
and checking manifest, CI, and provider artifacts before it authorizes a
merge. Those checks are meaningful for the kit's solo-operator threat model,
but they do not defend against a process that can deliberately forge commits
and alter local quality state.

Break-glass approval has a stronger boundary because it uses a wrapper-pinned,
signed capability. Review authorization does not currently use that mechanism.
If the threat model expands beyond negligent automation, add an operator-held
signature or HMAC verification for review authorization before describing it as
tamper-evident evidence.

## Read-only engineering status

Inspect one exact existing campaign without advancing it:

```bash
node scripts/quality-engineering-status.js --manifest /exact/path/invocation.json
node scripts/quality-engineering-status.js --manifest /exact/path/invocation.json --ci
```

The versioned JSON report validates repository, base, and exact HEAD identity,
then reuses the existing gate/review authorization validator. Recorded gate and
terminal labels are displayed separately from validated proof. In particular,
`verified-unmerged` does not prove that CI passed. Dirty work, stale lifecycle,
missing proof, or unverified CI cannot produce `engineering.status: "ready"`.
Empty stamp descendants need their own manifest HEAD and evidence.

Without `--ci`, CI is `unknown`. With it, the existing required-check assertion
reads GitHub evidence for the exact manifest HEAD, including protected-check
validation. This bounded check does not prepare or dispatch workflows. Missing
GitHub identity remains unknown; failed, pending, unavailable, or timed-out
checks are unverified with their reason. Base identity reflects local Git refs;
the report does not fetch refs or authorize a merge against a changed live base.

Product admission is always reported as unknown by this interface. Any recorded
admission block and delivery-evidence binding remain visible. The report is a
point-in-time inspection, not a signed or durable readiness receipt. It does not
implement a review-ready campaign target, create a campaign, change budgets,
resume work, grant merge authority, merge, or set Linear Done. Existing admission
and exact-head merge checks remain mandatory.
