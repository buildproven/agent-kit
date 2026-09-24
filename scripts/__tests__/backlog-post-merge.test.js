import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "backlog-post-merge.sh");
const PR_TEMPLATE = path.join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md");
const CUSTOM_WORKFLOW = path.join(
  ROOT,
  ".github",
  "workflows",
  "linear-post-merge.yml",
);

function fixture() {
  const root = makeTempDir("backlog-post-merge-");
  const bin = path.join(root, "bin");
  const log = path.join(root, "curl.log");
  const result = spawnSync("mkdir", ["-p", bin]);
  expect(result.status).toBe(0);

  const curl = path.join(bin, "curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CURL_LOG"
case "$*" in
  *"query Issue("*)
    team_id="team-a"
    [[ "$*" == *"BUI-202"* ]] && team_id="team-b"
    printf '{"data":{"issue":{"team":{"id":"%s"}}}}' "$team_id"
    ;;
  *"query TeamCompletedStatuses("*)
    state_id="done-a"
    [[ "$*" == *"team-b"* ]] && state_id="done-b"
    printf '{"data":{"team":{"states":{"nodes":[{"id":"%s","position":1}]}}}}' "$state_id"
    ;;
  *"mutation CloseIssue("*)
    if [[ -n "\${FAIL_UPDATE_ID:-}" && "$*" == *"$FAIL_UPDATE_ID"* ]]; then
      printf '%s' '{"data":{"issueUpdate":{"success":false}}}'
    else
      printf '%s' '{"data":{"issueUpdate":{"success":true}}}'
    fi
    ;;
  *) printf '%s' '{"errors":[{"message":"unexpected test query"}]}' ;;
esac
`,
  );
  chmodSync(curl, 0o755);
  return { bin, log };
}

describe("backlog-post-merge", () => {
  it("uses the native Linear integration contract for hosted merges", () => {
    expect(existsSync(CUSTOM_WORKFLOW)).toBe(false);
    expect(readFileSync(PR_TEMPLATE, "utf8")).toContain("Closes TEAM-123");
  });

  it("closes every unique identifier supplied by a bundled merge", () => {
    const fx = fixture();
    const result = spawnSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_LOG: fx.log,
        ITEM_ID_OVERRIDE: "Closes BUI-101, BUI-202, BUI-101",
        LINEAR_API_KEY: "test-token",
        PATH: `${fx.bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Marked BUI-101 as Done");
    expect(result.stdout).toContain("Marked BUI-202 as Done");
    const requests = spawnSync("cat", [fx.log], { encoding: "utf8" });
    expect(requests.stdout).toContain("BUI-101");
    expect(requests.stdout).toContain("BUI-202");
    expect(requests.stdout).toContain('"teamId":"team-a"');
    expect(requests.stdout).toContain('"teamId":"team-b"');
    expect(requests.stdout).toContain('"stateId":"done-a"');
    expect(requests.stdout).toContain('"stateId":"done-b"');
  });

  it("also reads every identifier cited in the associated pull request body", () => {
    const fx = fixture();
    const gh = path.join(fx.bin, "gh");
    writeFileSync(
      gh,
      "#!/usr/bin/env bash\nprintf '%s' 'Closes BUI-303, BUI-404'\n",
    );
    chmodSync(gh, 0o755);

    const result = spawnSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_LOG: fx.log,
        GITHUB_REPOSITORY: "buildproven/agent-kit",
        GITHUB_SHA: "deadbeef",
        LINEAR_API_KEY: "test-token",
        PATH: `${fx.bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Marked BUI-303 as Done");
    expect(result.stdout).toContain("Marked BUI-404 as Done");
  });

  it("fails visibly when referenced issues cannot be closed without a token", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ITEM_ID_OVERRIDE: "BUI-101",
        LINEAR_API_KEY: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINEAR_API_KEY is required");
  });

  it("attempts every cited issue before reporting partial failures", () => {
    const fx = fixture();
    const result = spawnSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_LOG: fx.log,
        FAIL_UPDATE_ID: "BUI-202",
        ITEM_ID_OVERRIDE: "BUI-101 BUI-202 BUI-303",
        LINEAR_API_KEY: "test-token",
        PATH: `${fx.bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Marked BUI-101 as Done");
    expect(result.stdout).toContain("Marked BUI-303 as Done");
    expect(result.stderr).toContain("failed to close: BUI-202");
  });

  it("fails visibly when associated pull request bodies cannot be read", () => {
    const fx = fixture();
    const gh = path.join(fx.bin, "gh");
    writeFileSync(gh, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(gh, 0o755);

    const result = spawnSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_LOG: fx.log,
        GITHUB_REPOSITORY: "buildproven/agent-kit",
        GITHUB_SHA: "deadbeef",
        LINEAR_API_KEY: "test-token",
        PATH: `${fx.bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "could not collect Linear issue identifiers",
    );
  });
});
