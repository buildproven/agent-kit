import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  approveEligibleRun,
  contextFromOptions,
} = require("../quality-approve-trusted-release-workflow.js");

const context = contextFromOptions({
  repo: "owner/repo",
  pr: "42",
  base: "main",
  head: "a".repeat(40),
  "head-ref": "release-please--branches--main--components--agent-kit",
  "workflow-id": "77",
});

function eligibleRun(overrides = {}) {
  return {
    id: 123,
    workflow_id: 77,
    path: ".github/workflows/quality.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "action_required",
    head_sha: context.head,
    head_branch: context.headRef,
    head_repository: { full_name: context.repository },
    repository: { full_name: context.repository },
    actor: { login: "github-actions[bot]" },
    pull_requests: [
      {
        number: 42,
        base: { ref: "main" },
        head: {
          sha: context.head,
          ref: context.headRef,
          repo: { full_name: context.repository },
        },
      },
    ],
    ...overrides,
  };
}

describe("trusted release workflow approval", () => {
  it("approves only the exact same-repository release quality run", () => {
    const approve = vi.fn();
    expect(approveEligibleRun([eligibleRun()], context, approve)).toEqual({
      approved: true,
      runId: 123,
    });
    expect(approve).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith(123);
  });

  it.each([
    ["a fork", { head_repository: { full_name: "attacker/repo" } }],
    ["another SHA", { head_sha: "b".repeat(40) }],
    ["a normal branch", { head_branch: "feature/looks-like-a-release" }],
    ["another workflow", { path: ".github/workflows/codeql.yml" }],
    ["a non-bot actor", { actor: { login: "attacker" } }],
    [
      "a different pull request",
      { pull_requests: [{ ...eligibleRun().pull_requests[0], number: 43 }] },
    ],
  ])("does not approve %s", (_name, overrides) => {
    const approve = vi.fn();
    expect(
      approveEligibleRun([eligibleRun(overrides)], context, approve),
    ).toEqual({
      approved: false,
      runId: null,
    });
    expect(approve).not.toHaveBeenCalled();
  });

  it("fails closed when more than one exact run is awaiting approval", () => {
    expect(() =>
      approveEligibleRun(
        [eligibleRun(), eligibleRun({ id: 124 })],
        context,
        vi.fn(),
      ),
    ).toThrow(/multiple exact trusted release workflows/);
  });
});
