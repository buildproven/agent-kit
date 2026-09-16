# Layered assessment output

Tracking: BUI-918. Status: accepted after bounded Sol/high review.

## Problem and scope

The scorer assumes one public repository, but operators can compose a public
kit, a private overlay, and an installed configuration. A public packaging
requirement is not applicable to the other two layers. A combined number hides
which layer was measured. PR #540 already contains the initial implementation;
this decision governs its completion and downstream migration, not a claim that
the implementation had a prior architecture review.

## Decision

For the planned patch release, retain the existing unversioned, single-root
output by default. Add an explicit `--format layered-v2` CLI opt-in and
`format: "layered-v2"` library option. The legacy default is not a system score;
it must not blend layers. A future default switch needs a major release.

The v2 envelope has `schemaVersion: 2` and named `layers.public_kit`, `layers.private_overlay`, and
`layers.installed_composition` objects. Each present layer has its own label,
root, category results, numeric-category mean, and gaps. Keep `composite: null`;
do not provide a legacy top-level `overall` alias that could be mistaken for a
system result. Report absent roots in `missingLayers`, not as zero scores.
Mark an inapplicable category with a null score and a reason. Exclude it from
the layer mean. A missing applicable control is a gap, not inapplicability.

Explicit roots are the only v2 interface; remove v2 auto-detection instead of
introducing an unreliable CI-versus-local classifier. Library root options
override corresponding environment values. Environment
variables `SOTA_PUBLIC_ROOT`, `SOTA_OVERLAY_ROOT`, and `SOTA_INSTALLED_ROOT`
provide those roots for the CLI. V2 requires an explicit public kit root.
Optional roots not requested are `not_assessed`, with a reason. Requested but
missing or invalid roots have those distinct states, and cause CLI exit 1 while
retaining the diagnostic envelope. Canonicalize roots. Reject identical roots
assigned to different roles; permit only the expected public-kit-inside-overlay
nesting. Installed roots must contain installed `settings.json` plus the linked
control surfaces; source `config/settings.json` alone cannot qualify.
Record root-selection provenance (`argument` or `environment`), canonical
root, and exact Git source revision when available. Unavailable revision stays
null with a reason; never invent a clean-source identity for a dirty tree.
CI must not claim installed-composition evidence from a source checkout.

The scorer must not run arbitrary scripts from assessed roots. Behavioral
governor proof belongs in the kit's tests and quality receipts. Structural
assessment may report present controls, but cannot label their presence as
verified failure behavior. This removes the new host-code execution probe and
its fixed sentinel path rather than trying to sandbox each assessed script.

Keep category scoring in the shared kit. Private consumers pass roots and
format the named results; they do not fork the scorer. The deterministic rubric
is a structural assessment, not comparative proof of SOTA or evidence that
quality, speed, token efficiency, and autonomy targets have been met.

## Migration and rollback

An existing downstream assessment workflow calls the scorer without an overlay
root and reads `entry.overall`. Update that consumer when advancing the kit
pin: explicitly select v2, pass public and private roots, report labelled per-layer results,
and record missing installed evidence. Preserve historical flat history entries
as historical data; do not rewrite them as layered observations. There are no
other production consumers in the kit tree found by a source search.

Consumers must first support mixed history: unversioned records are legacy v1;
explicit v2 records use named layers; unknown explicit schema versions refuse.
Preserve each historical entry unchanged. The same downstream change may add
this reader and advance the pin, but rollback must retain the dual reader and
restore only the pin and output-format selection. Test rollback after writing
at least one v2 record. Never rewrite history or fabricate a composite.

## Category applicability

All 15 categories are structural checks, not installation acceptance. The mean
is the sum of finite numeric scores divided by their count, rounded to one
decimal. Null applies only to the declared inapplicability below. A failed
applicable check remains numeric, including zero, in that denominator.

| Categories                                                                                                          | Public kit           | Private overlay                 | Installed composition                 |
| ------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------- | ------------------------------------- |
| distribution                                                                                                        | public packaging     | not applicable                  | not applicable                        |
| settings_validity, permission_posture, hooks, model_config                                                          | distributed defaults | overlay settings                | installed settings                    |
| native_first, agent_orchestration, bounded_autonomy, skill_design, quality_gates, security, observability, currency | kit controls         | own controls with core fallback | installed linked controls             |
| claude_md                                                                                                           | kit instructions     | overlay instructions            | installed instructions                |
| git_workflow                                                                                                        | kit source gates     | overlay source gates            | not applicable: not a source checkout |

Installation integrity is a prerequisite to assessing an installed root, not a
new score category. A missing or broken linked control is a visible failed
applicable check. Reading links must detect cycles and remain bounded; do not
treat all links as absent or recursively walk an arbitrary external tree.

## Invariants and verification

- Public packaging checks apply only to the public kit.
- Unknown or absent layers remain visible and cannot count as verified.
- Root selection is explicit in automated multi-layer runs.
- Shared control resolution supports the overlay's `core/scripts` layout.
- Structural scores cannot promote product or comparative acceptance.
- Tests cover explicit distinct roots, invalid/duplicate/absent roots, no ambient
  installed-root detection, and source-checkout refusal for the installed role.
- Verify legacy default output and explicit versioned v2 output separately.
- Prove no assessed script executes and no sentinel file is changed.
- Test the applicability matrix, denominator, linked controls, cycle bounds,
  dirty/missing source provenance, and mixed history without rewriting entries.
- Verify forward migration and rollback after v2 history exists; no top-level
  overall or calculated composite is permitted in v2.
- Preserve historical observations and verify the workflow's scorer-to-history
  path after the kit pin advances.

## Alternatives

- One flat score: rejected because it confuses ownership and applicability.
- Average all layers: rejected because missing evidence becomes easy to hide.
- Duplicate a private scorer: rejected because rubric and behavior would drift.
- Keep a top-level compatibility number: rejected because it preserves the
  original misleading contract instead of forcing explicit consumer migration.
- Major release now versus patch opt-in: choose patch opt-in to preserve the
  requested release and existing single-root callers. Do not alias v2 to v1.
- Staged dual-reader rollout versus pin-only atomic change: dual-reader safety
  is required; it can land with the pin only if retained during rollback.
- Separate layer commands versus one envelope: one explicit envelope keeps
  missing-layer and provenance evidence together without blending scores.

## Design review history

The first broad review timed out at 180 seconds without a verdict. A narrowed
ADR-only Sol/high review returned BLOCKING: versioning, explicit root states,
applicability, and rollback after new history needed decisions. The revision
above uses patch opt-in v2, removes auto-detection and assessed-code execution,
defines applicability, and retains a dual reader across rollback. The revised
ADR-only review returned CLEAN before further production edits.

Local implementation evidence: two public-interface regressions failed before
the repair (legacy output absent; assessed script executed). The completed
scorer suite passes 20 tests, including explicit CLI failure diagnostics,
installed linked controls and cycles, root precedence and conflicts, and clean
versus dirty Git provenance. This is local proof, not protected delivery or
completion of the downstream history migration.
