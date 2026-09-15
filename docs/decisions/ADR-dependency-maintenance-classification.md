# Dependency maintenance classification

The delivery gate previously treated every `package.json` change as new product
work. This required customer acceptance receipts even for dependency maintenance.

Classify existing manifests by comparing their committed base and candidate JSON.
Changes limited to dependencies, devDependencies, optionalDependencies,
peerDependencies, overrides, or resolutions are `dependency-maintenance`.
Whitespace is ignored, but nested property order is preserved because conditional
exports and imports use it to choose an entrypoint. All other
fields, including scripts, exports, engines, module type, workspaces, package
manager settings, and framework configuration remain product-affecting. Added,
deleted, invalid, unavailable, or non-regular manifests fail closed. Classification
never reads the mutable worktree. Mixed application changes still require product
admission.

Maintenance uses the existing non-product (`contract`) delivery route; it does not
claim customer acceptance. It still runs the repository's required install,
security, test, build (where configured), review, and exact-commit merge checks.
This change does not add, remove, or waive quality gates. A dependency change can
alter runtime behavior and requires those checks even though it is maintenance.

`quality-run.js` supplies the campaign's repository, base SHA, and candidate SHA to
the shared classifier. The product verifier CLI accepts the same context through
`--repo`, `--base`, and `--head`. Without that context it remains conservative.
Protected product admission consumes signed product receipts and is only invoked
for product claims; dependency maintenance does not enter that receipt workflow.
