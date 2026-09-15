# BUI-858: Native advisory task selection

## Requirements

- `compute-governor resolve|explain` accepts a native-only advisory request.
- The request requires complete V1 consequence facts, full task text, planned
  paths, parent identity, optional override, context mode, and live client
  capabilities.
- Advice selects the least capable approved V1 pair for the classified native
  task without changing V1/V2 governed execution or quality.
- Protected task text or paths, public contracts, and cross-repository work
  retain the existing Critical floor. Ambiguous work is at least Standard.
- Native advice returns only task digest and classified surfaces, never task text.
- Unsupported native controls and below-floor overrides fail visibly with no
  model arguments.
- Claude uses declared neutral task profiles to supply low, medium, or high
  effort. The resolver returns a matching Task profile only when it is declared
  available. It does not alter specialist quality agents or global settings.

## Acceptance

Focused public CLI tests prove the advisory result. Existing compute-governor
regressions prove V1/V2 behavior is unchanged. Caller instructions consume only
ready native arguments and do not claim native invocation evidence. Installer
coverage proves the native task profiles are available through the normal agent
directory link.
