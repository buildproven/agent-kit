#!/usr/bin/env node
"use strict";

// Compatibility refusal for the retired experimental certifier.
// Do not read candidate inputs or produce evidence from this entry point.
function main() {
  process.stderr.write(
    "harness-certify: retired because frozen commands did not isolate candidate code or protect evidence. " +
      "Use direct repository checks, independent review, and protected CI from a stable control checkout. " +
      "Historical receipts remain inspectable with harness-certification-status.js; they do not authorize merge.\n",
  );
  process.exitCode = 78;
}

if (require.main === module) main();

module.exports = { main };
