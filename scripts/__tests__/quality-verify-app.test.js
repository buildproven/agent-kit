// Tests for scripts/quality-verify-app.sh — the BUI-306 "does it actually
// boot" gate. Uses real throwaway fixtures (not mocks) per this repo's
// red-capable test preference: a real npm dev script is booted, a real port
// is polled, and for the web path a real headless browser (agent-browser)
// loads the real page and reads its real console/error buffers.
//
// The web-path tests are gated behind an `agent-browser` binary check
// (mirrors the /bin/bash gate in claude-review-companion.test.js) because
// CI does not install it globally — only this repo's own dev machines with
// agent-browser on PATH exercise that path locally. The library/CLI/timeout
// paths need nothing beyond node + bash and always run.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.resolve(__dirname, "..", "quality-verify-app.sh");

function hasBinary(name) {
  const result = spawnSync("bash", ["-c", `command -v ${name}`]);
  return result.status === 0;
}

const HAS_AGENT_BROWSER = hasBinary("agent-browser");

function run(cwd, env = {}, bashBin = "bash") {
  const result = spawnSync(bashBin, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// These fixtures boot real servers and may run at the same time as another
// quality campaign in a different process or worktree. Allocate each test
// port through the OS instead of sharing a hard-coded range between runs.
// The short-lived allocator closes its listener before the fixture starts;
// the gate still owns the authoritative pre-launch check.
function allocatePort() {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const net = require('node:net');",
        "const server = net.createServer();",
        "server.listen(0, '127.0.0.1', () => {",
        "  process.stdout.write(String(server.address().port));",
        "  server.close();",
        "});",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`could not allocate a test port: ${result.stderr}`);
  }
  const port = Number(result.stdout.trim());
  if (!Number.isInteger(port) || port < 1024) {
    throw new Error(`OS returned an invalid test port: ${result.stdout}`);
  }
  return port;
}

// The system /bin/bash on macOS is genuinely bash 3.2 (Apple froze it there
// over the GPLv3 relicense) while a Homebrew `bash` on PATH is typically
// 4+/5+. Using the real /bin/bash — when present and actually 3.2 — gives a
// true (not simulated) red-capable test for the readarray/mapfile
// incompatibility, rather than a static grep standing in for it.
const SYSTEM_BASH = "/bin/bash";
const HAS_BASH_32 = (() => {
  const result = spawnSync(SYSTEM_BASH, ["--version"], { encoding: "utf8" });
  return result.status === 0 && /version 3\./.test(result.stdout || "");
})();

function fixtureDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verify-app-${label}-`));
}

function writePackageJson(dir, contents) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(contents, null, 2),
  );
}

describe("quality-verify-app.sh", () => {
  it("is executable and starts with a bash shebang", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("treats a repo with no package.json as not-applicable and passes", () => {
    const dir = fixtureDir("no-package-json");
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/not applicable/);
  });

  it("treats a library (no dev/start script, no bin) as not-applicable and passes", () => {
    const dir = fixtureDir("library");
    writePackageJson(dir, {
      name: "some-lib",
      version: "1.0.0",
      main: "index.js",
    });
    fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};\n");
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/not applicable/);
    expect(stdout).toMatch(/no-op library gate/);
  });

  it("runs a CLI's --help and passes on a clean exit", () => {
    const dir = fixtureDir("cli-clean");
    fs.mkdirSync(path.join(dir, "bin"));
    writePackageJson(dir, {
      name: "some-cli",
      version: "1.0.0",
      bin: { "some-cli": "bin/cli.js" },
    });
    fs.writeFileSync(
      path.join(dir, "bin", "cli.js"),
      '#!/usr/bin/env node\nif (process.argv.includes("--help")) { console.log("usage"); process.exit(0); }\n',
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/SUCCESS: CLI/);
  });

  it("fails a CLI whose --help exits non-zero", () => {
    const dir = fixtureDir("cli-broken");
    fs.mkdirSync(path.join(dir, "bin"));
    writePackageJson(dir, {
      name: "broken-cli",
      version: "1.0.0",
      bin: { "broken-cli": "bin/cli.js" },
    });
    fs.writeFileSync(
      path.join(dir, "bin", "cli.js"),
      "#!/usr/bin/env node\nprocess.exit(2);\n",
    );
    const { status, stderr } = run(dir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/FAIL:.*exited with status 2/);
  });

  it("fails clearly if package.json#bin points at a missing file", () => {
    const dir = fixtureDir("cli-missing-bin");
    writePackageJson(dir, {
      name: "missing-bin",
      version: "1.0.0",
      bin: { "missing-bin": "bin/does-not-exist.js" },
    });
    const { status, stderr } = run(dir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/FAIL:.*does not exist/);
  });

  it("fails within its boot timeout when the dev script never binds a port", () => {
    const dir = fixtureDir("hangs");
    const port = allocatePort();
    writePackageJson(dir, {
      name: "hangs",
      version: "1.0.0",
      scripts: { dev: "sleep 300" },
    });
    const started = Date.now();
    const { status, stderr } = run(dir, {
      QUALITY_VERIFY_APP_BOOT_TIMEOUT: "3",
      QUALITY_VERIFY_APP_DEFAULT_PORT: String(port),
    });
    const elapsedSeconds = (Date.now() - started) / 1000;
    expect(status).not.toBe(0);
    expect(stderr).toMatch(new RegExp(`did not bind port ${port} within 3s`));
    // This is a process-cleanup bound, not a CPU scheduling benchmark. The
    // isolated case is normally ~9s; allow CI contention but reject anything
    // remotely close to the 300s child sleep it must terminate.
    //
    // The bound was 35s, which flaked at 36.01s under full-suite CPU contention
    // (it passes in isolation on both main and this branch). 35s was never a
    // meaningful threshold — the defect this guards against is "the harness
    // waits out the child's 300s sleep", so any bound comfortably under 300s
    // proves it. Widened to 90s to remove the false failure without weakening
    // what is actually asserted.
    expect(elapsedSeconds).toBeLessThan(90);
  });

  it("fails clearly if the dev script exits before binding its port", () => {
    const dir = fixtureDir("exits-immediately");
    writePackageJson(dir, {
      name: "exits-immediately",
      version: "1.0.0",
      scripts: { dev: 'node -e "process.exit(1)"' },
    });
    const { status, stderr } = run(dir, {
      QUALITY_VERIFY_APP_BOOT_TIMEOUT: "5",
    });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/exited before binding port 3000/);
  });

  // --- BUI-306 Codex review round: 8 findings, each with a fixture below ---

  it("fails clearly when the target port is already occupied by an unrelated service before boot", () => {
    // Regression for finding #1 (HIGH): a pre-existing listener on the
    // target port must be rejected BEFORE the gate ever launches the dev
    // script and starts polling — otherwise wait_for_port succeeds against
    // the wrong, unrelated process and a dead dev script goes unnoticed.
    const dir = fixtureDir("port-squatted");
    const port = allocatePort();
    const squatter = require("node:http").createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>unrelated pre-existing service</body></html>");
    });
    return new Promise((resolve, reject) => {
      squatter.listen(port, "127.0.0.1", () => {
        try {
          writePackageJson(dir, {
            name: "port-squatted",
            version: "1.0.0",
            // Dev script that would exit immediately with EADDRINUSE in
            // reality; here it just sleeps, because what matters is that
            // the gate must reject the pre-existing squatter before ever
            // getting this far.
            scripts: {
              dev: `node -e "setTimeout(() => {}, 60000)" --port ${port}`,
            },
          });
          const { status, stderr } = run(dir, {
            QUALITY_VERIFY_APP_BOOT_TIMEOUT: "5",
          });
          expect(status).not.toBe(0);
          expect(stderr).toMatch(/already in use/);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          squatter.close();
        }
      });
    });
  });

  it("fails clearly (not a silent pass) when .quality-app-flows.json is present but malformed", () => {
    // Regression for finding #3 (HIGH): a present-but-broken flows file must
    // hard-fail the gate with an actionable message, not silently fall back
    // to the zero-config port-detection path (which a downstream "0 flows
    // declared" parse would otherwise report as a clean pass).
    const dir = fixtureDir("malformed-flows");
    const port = allocatePort();
    writePackageJson(dir, {
      name: "malformed-flows",
      version: "1.0.0",
      scripts: {
        dev: `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port})"`,
      },
    });
    fs.writeFileSync(
      path.join(dir, ".quality-app-flows.json"),
      `{ "port": ${port}, "flows": [ ` /* deliberately truncated / invalid JSON */,
    );
    const { status, stderr } = run(dir, {
      QUALITY_VERIFY_APP_BOOT_TIMEOUT: "5",
    });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/not valid JSON/);
  });

  it("still falls back cleanly to zero-config when .quality-app-flows.json is simply absent", () => {
    // Companion to the malformed-file test above: an ABSENT flows file must
    // remain a non-failure, zero-config fallback — only a present-but-broken
    // file is the bug being fixed.
    const dir = fixtureDir("absent-flows");
    const port = allocatePort();
    writePackageJson(dir, {
      name: "absent-flows",
      version: "1.0.0",
      scripts: {
        dev: `PORT=${port} node -e "require('http').createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end('{}')}).listen(${port})"`,
      },
    });
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/non-HTML response, skipping browser check/);
  });

  it("discovers the real listening port from the dev server's own boot-log announcement instead of assuming 3000", () => {
    // Regression for finding #5 (MEDIUM): a dev script that takes no
    // --port/PORT override and doesn't default to 3000 (like vite's 5173)
    // must still be discovered via its own stdout announcement, not left to
    // time out against a hardcoded 3000 guess. The port lives ONLY inside
    // srv/server.js (a separate file), never as a literal in the `dev`
    // script command string itself — otherwise the gate's existing
    // literal-port scan of the command string would find it directly and
    // this test would not actually exercise the discovery fallback.
    const dir = fixtureDir("nonstandard-port");
    const port = allocatePort();
    fs.mkdirSync(path.join(dir, "srv"));
    fs.writeFileSync(
      path.join(dir, "srv", "server.js"),
      [
        "const http = require('http');",
        `const PORT = ${port};`,
        "http.createServer((req, res) => {",
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        "  res.end('{}');",
        "}).listen(PORT, '127.0.0.1', () => {",
        "  console.log(`Local: http://127.0.0.1:${PORT}/`);",
        "});",
      ].join("\n"),
    );
    writePackageJson(dir, {
      name: "nonstandard-port",
      version: "1.0.0",
      scripts: { dev: "node srv/server.js" },
    });
    const { status, stdout } = run(dir, {
      QUALITY_VERIFY_APP_BOOT_TIMEOUT: "10",
    });
    expect(status).toBe(0);
    expect(stdout).toMatch(
      new RegExp(`discovered actual listening port ${port}`),
    );
  });

  it("runs a bin entry with its own shebang directly instead of forcing it through node", () => {
    // Regression for finding #8 (MEDIUM): package.json#bin can point at a
    // non-node executable (shell script here). Forcing `node <path>` on a
    // shell script fails immediately with a syntax error; the fix must
    // invoke the file directly so its own #!/bin/sh shebang governs.
    const dir = fixtureDir("shell-bin");
    fs.mkdirSync(path.join(dir, "bin"));
    const binPath = path.join(dir, "bin", "cli.sh");
    fs.writeFileSync(
      binPath,
      '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "usage: shell-cli"; exit 0; fi\nexit 1\n',
    );
    fs.chmodSync(binPath, 0o755);
    writePackageJson(dir, {
      name: "shell-bin",
      version: "1.0.0",
      bin: { "shell-bin": "bin/cli.sh" },
    });
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/SUCCESS: CLI/);
  });

  it("boots a non-HTML server and passes without invoking a browser", () => {
    const dir = fixtureDir("json-server");
    const port = allocatePort();
    fs.mkdirSync(path.join(dir, "srv"));
    fs.writeFileSync(
      path.join(dir, "srv", "server.js"),
      [
        "const http = require('http');",
        "http.createServer((req, res) => {",
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        "  res.end(JSON.stringify({ ok: true }));",
        `}).listen(${port}, '127.0.0.1');`,
      ].join("\n"),
    );
    writePackageJson(dir, {
      name: "json-server",
      version: "1.0.0",
      // The allocated port is repeated in the script command itself (not just
      // inside server.js) so quality-verify-app.sh's literal port-scan of
      // the dev/start command string can discover it, matching how a real
      // repo's `dev: "PORT=<port> node srv/server.js"` convention would read.
      scripts: { dev: `node srv/server.js --port ${port}` },
    });
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/non-HTML response, skipping browser check/);
  });

  (HAS_AGENT_BROWSER ? describe : describe.skip)(
    "web path (requires agent-browser on PATH)",
    () => {
      function htmlFixture(label, bodyScript, port) {
        const dir = fixtureDir(label);
        const html = `<!doctype html><html><head><title>${label}</title></head><body><h1>hi</h1><script>${bodyScript}</script></body></html>`;
        fs.mkdirSync(path.join(dir, "srv"));
        fs.writeFileSync(
          path.join(dir, "srv", "server.js"),
          [
            "const http = require('http');",
            `const html = ${JSON.stringify(html)};`,
            "http.createServer((req, res) => {",
            "  res.writeHead(200, { 'Content-Type': 'text/html' });",
            "  res.end(html);",
            `}).listen(${port}, '127.0.0.1');`,
          ].join("\n"),
        );
        writePackageJson(dir, {
          name: label,
          version: "1.0.0",
          // Port is repeated in the dev script command itself (see the
          // json-server fixture above) so the gate's literal port scan finds
          // it without needing to parse server.js.
          scripts: { dev: `node srv/server.js --port ${port}` },
        });
        return dir;
      }

      it("passes a known-good web project with a clean console", () => {
        const dir = htmlFixture(
          "good-web",
          'console.log("boot ok")',
          allocatePort(),
        );
        const { status, stdout } = run(dir);
        expect(status).toBe(0);
        expect(stdout).toMatch(
          /root page loaded cleanly: 0 page errors, 0 console\.error messages/,
        );
      });

      it("fails a deliberately-broken web project that throws on mount", () => {
        const dir = htmlFixture(
          "broken-web",
          'throw new Error("boom on mount")',
          allocatePort(),
        );
        const { status, stderr } = run(dir);
        expect(status).not.toBe(0);
        expect(stderr).toMatch(/produced 1 JavaScript error/);
        expect(stderr).toMatch(/boom on mount/);
      });

      it("follows a root redirect and still runs browser verification instead of misclassifying as server-only", () => {
        // Regression for finding #4 (HIGH): a root route that responds with
        // a bodyless redirect (no HTML content-type, no body on the
        // immediate response) must not be misclassified as "server-only" —
        // the gate has to follow the redirect and classify on the FINAL
        // response, which here is real HTML with a script that throws, so
        // the browser check must actually run and catch it.
        const dir = fixtureDir("redirect-web");
        const port = allocatePort();
        fs.mkdirSync(path.join(dir, "srv"));
        fs.writeFileSync(
          path.join(dir, "srv", "server.js"),
          [
            "const http = require('http');",
            "http.createServer((req, res) => {",
            "  if (req.url === '/') {",
            "    res.writeHead(302, { Location: '/final' });",
            "    res.end();",
            "    return;",
            "  }",
            "  res.writeHead(200, { 'Content-Type': 'text/html' });",
            "  res.end('<!doctype html><html><body><script>throw new Error(\"after redirect\")</script></body></html>');",
            `}).listen(${port}, '127.0.0.1');`,
          ].join("\n"),
        );
        writePackageJson(dir, {
          name: "redirect-web",
          version: "1.0.0",
          scripts: { dev: `node srv/server.js --port ${port}` },
        });
        const { status, stderr, stdout } = run(dir);
        // If redirects were NOT followed, this would misclassify as
        // server-only and exit 0 with "skipping browser check" — the
        // opposite of what a red run against the pre-fix code produces.
        expect(stdout).not.toMatch(/skipping browser check/);
        expect(status).not.toBe(0);
        expect(stderr).toMatch(/produced 1 JavaScript error/);
        expect(stderr).toMatch(/after redirect/);
      });

      it("fails closed instead of silently passing when agent-browser's diagnostics call reports success:false", () => {
        // Regression for finding #2 (HIGH): agent-browser can print a
        // well-formed `{"success":false,...}` payload for `errors --json`
        // (e.g. a lost/failed session) — `.data.errors // []` on that shape
        // evaluates to an empty array, which the pre-fix code trusted as
        // "zero errors" instead of treating it as a diagnostics failure.
        // This fakes a minimal `agent-browser` wrapper that behaves
        // normally for open/wait/console/close but returns success:false
        // for `errors --json`, and asserts the gate fails loudly rather
        // than reporting a clean pass.
        const dir = fixtureDir("fake-ab-errors-fail");
        const port = allocatePort();
        fs.mkdirSync(path.join(dir, "srv"));
        fs.writeFileSync(
          path.join(dir, "srv", "server.js"),
          [
            "const http = require('http');",
            "http.createServer((req, res) => {",
            "  res.writeHead(200, { 'Content-Type': 'text/html' });",
            "  res.end('<!doctype html><html><body>hi</body></html>');",
            `}).listen(${port}, '127.0.0.1');`,
          ].join("\n"),
        );
        writePackageJson(dir, {
          name: "fake-ab-errors-fail",
          version: "1.0.0",
          scripts: { dev: `node srv/server.js --port ${port}` },
        });

        const fakeBinDir = fixtureDir("fake-ab-bin");
        const realAgentBrowser = spawnSync("bash", [
          "-c",
          "command -v agent-browser",
        ])
          .stdout.toString()
          .trim();
        fs.writeFileSync(
          path.join(fakeBinDir, "agent-browser"),
          [
            "#!/usr/bin/env bash",
            "set -u",
            'for a in "$@"; do',
            '  if [ "$a" = "errors" ]; then',
            '    echo \'{"success":false,"error":{"message":"session lost"}}\'',
            "    exit 0",
            "  fi",
            "done",
            `exec "${realAgentBrowser}" "$@"`,
            "",
          ].join("\n"),
        );
        fs.chmodSync(path.join(fakeBinDir, "agent-browser"), 0o755);

        const { status, stderr } = run(dir, {
          PATH: `${fakeBinDir}:${process.env.PATH}`,
        });
        expect(status).not.toBe(0);
        expect(stderr).toMatch(/did not report success/);
        expect(stderr).toMatch(/session lost/);
      });

      it("catches a console.error logged mid-flow, not just at the very end", () => {
        // Regression for finding #7 (MEDIUM): a declared flow step that
        // calls console.error() without an uncaught throw was previously
        // invisible — only the end-of-flow `ab errors` (uncaught-exception)
        // check ran, which this scenario never trips. The fix must query
        // the console buffer after each step too.
        const dir = fixtureDir("flow-console-error");
        const port = allocatePort();
        const html =
          "<!doctype html><html><body>" +
          '<button id="go" onclick="console.error(\'mid-flow console error\')">go</button>' +
          "</body></html>";
        fs.mkdirSync(path.join(dir, "srv"));
        fs.writeFileSync(
          path.join(dir, "srv", "server.js"),
          [
            "const http = require('http');",
            `const html = ${JSON.stringify(html)};`,
            "http.createServer((req, res) => {",
            "  res.writeHead(200, { 'Content-Type': 'text/html' });",
            "  res.end(html);",
            `}).listen(${port}, '127.0.0.1');`,
          ].join("\n"),
        );
        writePackageJson(dir, {
          name: "flow-console-error",
          version: "1.0.0",
          scripts: { dev: `node srv/server.js --port ${port}` },
        });
        fs.writeFileSync(
          path.join(dir, ".quality-app-flows.json"),
          JSON.stringify({
            port,
            flows: [{ name: "click-go", steps: ["click #go"] }],
          }),
        );
        const { status, stderr } = run(dir);
        expect(status).not.toBe(0);
        expect(stderr).toMatch(/logged 1 console\.error message/);
        expect(stderr).toMatch(/mid-flow console error/);
      });

      (HAS_BASH_32 ? it : it.skip)(
        "runs a declared flow's steps under the real macOS system bash 3.2 (no readarray/mapfile)",
        () => {
          // Regression for finding #6 (MEDIUM): readarray/mapfile are
          // bash-4+ builtins missing on stock macOS /bin/bash (verified
          // genuinely 3.2 via HAS_BASH_32). Running this exact scenario —
          // one declared flow step — under the real system bash exercises
          // the STEP_ARGS-building line directly: pre-fix, this aborts with
          // "readarray: command not found" before the step ever runs.
          const port = allocatePort();
          const dir = htmlFixture(
            "bash32-flow",
            'console.log("boot ok")',
            port,
          );
          fs.writeFileSync(
            path.join(dir, ".quality-app-flows.json"),
            JSON.stringify({
              port,
              flows: [{ name: "noop", steps: ["get title"] }],
            }),
          );
          const { status, stderr, stdout } = run(
            dir,
            { QUALITY_VERIFY_APP_BOOT_TIMEOUT: "15" },
            SYSTEM_BASH,
          );
          expect(stderr).not.toMatch(/readarray: command not found/);
          expect(stderr).not.toMatch(/mapfile: command not found/);
          expect(status).toBe(0);
          expect(stdout).toMatch(/flow 'noop' passed/);
        },
      );
    },
  );
});
