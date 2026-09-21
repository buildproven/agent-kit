"use strict";

// Python repository discovery is independent from invocation lifecycle state.
// Keep its gate selection together so the campaign state machine only composes
// declared and language-specific gate policies (BUI-905).
function hasPythonTool(pyproject, tool) {
  return new RegExp(`^\\s*\\[tool\\.${tool}(?:[.\\]]|$)`, "m").test(pyproject);
}

function isPythonRepository(root, head, pyproject, { committedFiles }) {
  if (pyproject !== "") return true;
  return committedFiles(root, head).some(
    (file) =>
      /^requirements[^/]*\.(?:txt|in)$/.test(file) ||
      [
        "setup.py",
        "setup.cfg",
        "Pipfile",
        "Pipfile.lock",
        "poetry.lock",
        "uv.lock",
        "pytest.ini",
        "tox.ini",
      ].includes(file),
  );
}

function pythonEnvironment(root, head, pyproject, { committedFile }) {
  if (committedFile(root, head, "uv.lock") !== null) return "uv";
  if (
    committedFile(root, head, "poetry.lock") !== null ||
    hasPythonTool(pyproject, "poetry")
  ) {
    return "poetry";
  }
  if (
    committedFile(root, head, "Pipfile") !== null ||
    committedFile(root, head, "Pipfile.lock") !== null
  ) {
    return "pipenv";
  }
  return null;
}

function pythonDirectGate({
  root,
  head,
  pyproject,
  name,
  tool,
  args,
  allowSkip,
  committedFile,
  directGate,
}) {
  const environment = pythonEnvironment(root, head, pyproject, {
    committedFile,
  });
  return environment
    ? directGate(
        name,
        `python:${tool}`,
        environment,
        ["run", tool, ...args],
        allowSkip,
      )
    : directGate(name, `python:${tool}`, tool, args, allowSkip);
}

function pythonAuditArgs(
  root,
  head,
  pyproject,
  { committedFile, committedFiles },
) {
  if (pyproject !== "") return ["."];
  const requirements = committedFiles(root, head).filter((file) =>
    /^requirements[^/]*\.(?:txt|in)$/.test(file),
  );
  if (requirements.length > 0)
    return requirements.flatMap((file) => ["-r", file]);
  if (
    committedFile(root, head, "Pipfile") !== null ||
    committedFile(root, head, "Pipfile.lock") !== null
  ) {
    return [];
  }
  return null;
}

function hasCommittedPythonTests(root, head, { committedFiles }) {
  return committedFiles(root, head).some((file) =>
    /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(file),
  );
}

function pythonGate({
  root,
  head,
  baseSha,
  name,
  pyproject,
  pythonRepository,
  allowSkip = false,
  committedFile,
  committedFiles,
  diffTouchesPython,
  directGate,
}) {
  if (!pythonRepository) return null;
  const dependencies = { committedFile, committedFiles };
  if (name === "lint" && hasPythonTool(pyproject, "ruff")) {
    return pythonDirectGate({
      root,
      head,
      pyproject,
      name,
      tool: "ruff",
      args: ["check", "."],
      allowSkip,
      committedFile,
      directGate,
    });
  }
  if (
    name === "test" &&
    (hasPythonTool(pyproject, "pytest") ||
      committedFile(root, head, "pytest.ini") !== null ||
      committedFile(root, head, "tox.ini") !== null ||
      hasCommittedPythonTests(root, head, dependencies))
  ) {
    return pythonDirectGate({
      root,
      head,
      pyproject,
      name,
      tool: "pytest",
      args: [],
      allowSkip,
      committedFile,
      directGate,
    });
  }
  if (name === "security") {
    const args = pythonAuditArgs(root, head, pyproject, dependencies);
    return args === null
      ? null
      : pythonDirectGate({
          root,
          head,
          pyproject,
          name,
          tool: "pip-audit",
          args,
          allowSkip,
          committedFile,
          directGate,
        });
  }
  if (
    name === "type" &&
    hasPythonTool(pyproject, "mypy") &&
    diffTouchesPython(root, baseSha, head)
  ) {
    return pythonDirectGate({
      root,
      head,
      pyproject,
      name,
      tool: "mypy",
      args: ["."],
      allowSkip,
      committedFile,
      directGate,
    });
  }
  return null;
}

module.exports = { isPythonRepository, pythonGate };
