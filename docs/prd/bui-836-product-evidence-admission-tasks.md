# BUI-836 tasks

- [x] 1.0 Create a protected source, producer, and admission workflow chain.
  - Phase: implementation
  - Delivers: A separate worker produces raw evidence and two protected workers sign and admit it.
  - Evidence: workflow definitions and admission tests.
- [x] 2.0 Bind admission to immutable repository identity, exact HEAD, and requirements digest.
  - Phase: implementation
  - Delivers: The quality loop can resume only with a valid signed admission.
  - Evidence: `scripts/__tests__/product-admission.test.js`.
- [ ] 3.0 Provision protected GitHub keys and run a live admission.
  - Phase: validation
  - Delivers: A production check on an exact PR head.
  - Evidence: GitHub Actions run, verified public trust-root provenance when
    required, and `product-admission` check URL.
