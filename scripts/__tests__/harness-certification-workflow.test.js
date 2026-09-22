const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOW = path.join(
  ROOT,
  ".github",
  "workflows",
  "harness-certification-protected.yml",
);

describe("protected harness certification workflow", () => {
  it("publishes its result as a writable exact candidate-head check", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");

    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("name='Harness Certification Protected'");
    expect(workflow).toContain('head_sha="$head"');
    expect(workflow).toContain('conclusion="$conclusion"');
    expect(workflow).toContain('test "$CERTIFY_OUTCOME" = success');
  });
});
