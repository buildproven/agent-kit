#!/usr/bin/env node
"use strict";

// Approve the one GitHub Actions run that GitHub holds for a release-please
// pull request. This is deliberately narrower than a general workflow
// approval: a fork, another workflow, another PR, another SHA, or a normal
// feature branch must remain action_required.

const { spawnSync } = require("node:child_process");

const RELEASE_HEAD =
  /^release-please--branches--[A-Za-z0-9._/-]+--components--[A-Za-z0-9._/-]+$/;
const MAX_GH_OUTPUT = 16 * 1024 * 1024;

function optionMap(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || argv[index + 1] === undefined)
      throw new Error("expected --name value options");
    options[key.slice(2)] = argv[++index];
  }
  return options;
}

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`--${name} is invalid`);
  return value;
}

function contextFromOptions(options) {
  return {
    repository: required(options, "repo", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pr: Number(required(options, "pr", /^[1-9][0-9]*$/)),
    base: required(options, "base", /^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    head: required(options, "head", /^[0-9a-f]{40}$/),
    headRef: required(options, "head-ref", RELEASE_HEAD),
    workflowId: Number(required(options, "workflow-id", /^[1-9][0-9]*$/)),
  };
}

function matchingWorkflow(run, context) {
  return (
    run.workflow_id === context.workflowId &&
    run.path === ".github/workflows/quality.yml" &&
    run.event === "pull_request" &&
    run.status === "completed" &&
    run.conclusion === "action_required" &&
    run.head_sha === context.head &&
    run.head_branch === context.headRef
  );
}

function sameRepository(run, context) {
  return (
    run.head_repository?.full_name === context.repository &&
    run.repository?.full_name === context.repository &&
    run.actor?.login === "github-actions[bot]"
  );
}

function matchingPullRequestIdentity(pullRequest, context) {
  return (
    pullRequest?.number === context.pr &&
    pullRequest?.base?.ref === context.base &&
    pullRequest?.head?.sha === context.head
  );
}

function matchingPullRequestSource(pullRequest, context) {
  return (
    pullRequest?.head?.ref === context.headRef &&
    pullRequest?.head?.repo?.full_name === context.repository
  );
}

function matchingPullRequest(run, context) {
  const pullRequests = Array.isArray(run.pull_requests)
    ? run.pull_requests
    : [];
  return (
    pullRequests.length === 1 &&
    matchingPullRequestIdentity(pullRequests[0], context) &&
    matchingPullRequestSource(pullRequests[0], context)
  );
}

function matchingRun(run, context) {
  return (
    matchingWorkflow(run, context) &&
    sameRepository(run, context) &&
    matchingPullRequest(run, context)
  );
}

function approveEligibleRun(runs, context, approve) {
  const candidates = runs.filter((run) => matchingRun(run, context));
  if (candidates.length === 0) return { approved: false, runId: null };
  if (candidates.length !== 1)
    throw new Error(
      "multiple exact trusted release workflows require approval",
    );
  const runId = candidates[0].id;
  if (!Number.isInteger(runId) || runId < 1)
    throw new Error("trusted release workflow has an invalid run ID");
  approve(runId);
  return { approved: true, runId };
}

function ghJson(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: MAX_GH_OUTPUT,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || "gh request failed").trim(),
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

function workflowRunsQuery(context) {
  return new URLSearchParams({
    event: "pull_request",
    branch: context.headRef,
    // Only the current exact-head run can be eligible. A small page prevents
    // historical release runs from exhausting the command buffer.
    per_page: "10",
  });
}

function main(argv = process.argv.slice(2)) {
  const context = contextFromOptions(optionMap(argv));
  const query = workflowRunsQuery(context);
  const response = ghJson([
    "api",
    `repos/${context.repository}/actions/workflows/${context.workflowId}/runs?${query}`,
  ]);
  if (!Array.isArray(response.workflow_runs))
    throw new Error("GitHub workflow-runs response is invalid");
  const result = approveEligibleRun(
    response.workflow_runs,
    context,
    (runId) => {
      const approved = spawnSync(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${context.repository}/actions/runs/${runId}/approve`,
        ],
        { encoding: "utf8" },
      );
      if (approved.error) throw approved.error;
      if (approved.status !== 0)
        throw new Error(
          (
            approved.stderr ||
            approved.stdout ||
            "workflow approval failed"
          ).trim(),
        );
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `quality trusted release approval: ${error.message}\n`,
    );
    process.exit(1);
  }
}

module.exports = {
  MAX_GH_OUTPUT,
  contextFromOptions,
  matchingRun,
  approveEligibleRun,
  workflowRunsQuery,
};
