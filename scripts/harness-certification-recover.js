#!/usr/bin/env node
"use strict";

// Keep the old command actionable without restarting unsafe candidate execution.
function main() {
  process.stderr.write(
    "harness-certification-recover: retired; no certification will be restarted. " +
      "Preserve prior evidence and inspect it with harness-certification-status.js. " +
      "Use direct repository checks, independent review, and protected CI from a stable control checkout.\n",
  );
  process.exitCode = 78;
}

if (require.main === module) main();

module.exports = { main };
