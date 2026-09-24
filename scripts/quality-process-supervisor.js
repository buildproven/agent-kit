"use strict";

// The only process which signals a group is its still-live group leader.
// Payload code never runs on the supervisor's deadline event loop.
const { spawn } = require("node:child_process");
const fs = require("node:fs");

function groupAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function supervise(command, args, options) {
  const stopAt = options.stopAt;
  if (!Number.isFinite(stopAt) || process.platform === "win32")
    return Promise.reject(
      new Error("supervised execution requires POSIX and an absolute deadline"),
    );
  if (Date.now() >= stopAt)
    return Promise.resolve({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "",
      deadlineExpired: true,
    });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, String(stopAt)], {
      cwd: options.cwd,
      env: process.env,
      detached: true,
      stdio: ["inherit", "pipe", "pipe", "ipc"],
    });
    let result;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let cancelTimer;
    let cancelled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.connected) child.disconnect();
      child.unref();
      options.onChild?.(null);
      resolve({ ...value, stdout, stderr, childPid: child.pid });
    };
    const observeDeadline = () => {
      const remaining = stopAt + 500 - Date.now();
      if (remaining > 0) {
        timer = setTimeout(observeDeadline, Math.min(remaining, 2147483647));
        return;
      }
      // Do not signal a possibly reused PID from this observer.
      finish({
        code: 1,
        signal: null,
        deadlineExpired: true,
        terminationError: "SUPERVISOR_UNCONFIRMED",
      });
    };
    observeDeadline();
    if (options.cancelFile) {
      cancelTimer = setInterval(() => {
        if (fs.existsSync(options.cancelFile)) {
          cancelled = true;
          if (child.connected) child.disconnect();
        }
      }, 50);
    }
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32768);
      if (options.forwardOutput !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32768);
      if (options.forwardOutput !== false) process.stderr.write(chunk);
    });
    child.on("message", (message) => {
      if (message?.type === "exit" && Number.isInteger(message.code))
        result = message;
      if (message?.type === "payload") options.onMessage?.(message.value);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      reject(error);
    });
    child.once("exit", async () => {
      // SIGKILL delivery to all group members is asynchronous. Observe, do not
      // re-signal a recorded group, before letting ownership clear the child.
      const until = Date.now() + 200;
      while (!groupAbsent(child.pid) && Date.now() < until)
        await new Promise((done) => setTimeout(done, 10));
      const absent = groupAbsent(child.pid);
      if (cancelled && absent)
        return finish({
          code: 143,
          signal: "SIGTERM",
          deadlineExpired: false,
          cancelled: true,
        });
      finish(
        result && (absent || result.terminationError)
          ? result
          : {
              code: 1,
              signal: null,
              deadlineExpired: Date.now() >= stopAt,
              terminationError: absent
                ? "SUPERVISOR_RESULT_MISSING"
                : "GROUP_NOT_QUIESCENT",
            },
      );
    });
    try {
      // This callback fsyncs ownership before the child can execute a payload.
      options.onChild?.(child);
      child.send(
        {
          type: "start",
          command,
          args,
          cwd: options.cwd,
          payloadIpc: Boolean(options.onMessage),
        },
        (error) => {
          if (error && child.connected) child.disconnect();
        },
      );
    } catch (error) {
      if (child.connected) child.disconnect();
      clearTimeout(timer);
      clearInterval(cancelTimer);
      reject(error);
    }
  });
}

function main() {
  const stopAt = Number(process.argv[2]);
  if (!process.send || !Number.isFinite(stopAt) || process.platform === "win32")
    throw new Error("supervisor requires private IPC and a POSIX deadline");
  let stopping = false;
  let started = false;
  const killOwnGroup = () => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch (error) {
      process.stderr.write(
        `supervisor could not stop its group: ${error.code}\n`,
      );
      const exit = () => process.exit(1);
      setTimeout(exit, 50);
      if (process.connected)
        process.send(
          {
            type: "exit",
            code: 1,
            signal: null,
            deadlineExpired: Date.now() >= stopAt,
            terminationError: error.code || "SIGNAL_FAILED",
          },
          exit,
        );
      else exit();
    }
  };
  const finish = (result) => {
    if (stopping) return;
    stopping = true;
    // A blocked IPC consumer must not delay cleanup indefinitely.
    setTimeout(killOwnGroup, 100);
    if (!process.connected) return killOwnGroup();
    process.send({ type: "exit", ...result }, killOwnGroup);
  };
  const deadline = () => {
    const remaining = stopAt - Date.now();
    if (remaining > 0)
      return setTimeout(deadline, Math.min(remaining, 2147483647));
    finish({ code: 1, signal: null, deadlineExpired: true });
  };
  process.once("disconnect", killOwnGroup);
  process.on("message", (message) => {
    if (started || stopping || message?.type !== "start") return;
    started = true;
    if (Date.now() >= stopAt) return deadline();
    if (
      typeof message.command !== "string" ||
      !Array.isArray(message.args) ||
      !message.args.every((arg) => typeof arg === "string")
    )
      return finish({ code: 1, signal: null });
    const payload = spawn(message.command, message.args, {
      cwd: message.cwd,
      env: { ...process.env, BS_QUALITY_SUPERVISED_STOP_AT: String(stopAt) },
      detached: false,
      // A payload IPC channel is freshly created, never the parent's channel.
      stdio: message.payloadIpc
        ? ["inherit", "inherit", "inherit", "ipc"]
        : ["inherit", "inherit", "inherit"],
    });
    payload.on("message", (value) => {
      if (
        !stopping &&
        process.connected &&
        JSON.stringify(value).length <= 32768
      )
        process.send({ type: "payload", value }, (error) => {
          if (error) killOwnGroup();
        });
    });
    payload.once("error", () => finish({ code: 1, signal: null }));
    payload.once("exit", (code, signal) =>
      finish({ code: code ?? 1, signal, deadlineExpired: false }),
    );
  });
  deadline();
}

async function boundedCommand() {
  const [seconds, cancelFile, separator, command, ...args] =
    process.argv.slice(3);
  const inherited = Number(process.env.BS_QUALITY_SUPERVISED_STOP_AT);
  const duration = Number(seconds);
  if (
    separator !== "--" ||
    !command ||
    !Number.isSafeInteger(inherited) ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new Error(
      "bounded supervisor requires a valid inherited deadline and timeout",
    );
  const stopAt = Math.min(inherited, Date.now() + duration * 1000);
  let executable = command;
  let commandArgs = args;
  if (process.platform === "darwin") {
    fs.accessSync("/usr/bin/caffeinate", fs.constants.X_OK);
    executable = "/usr/bin/caffeinate";
    commandArgs = ["-i", command, ...args];
  }
  const result = await supervise(executable, commandArgs, {
    stopAt,
    cancelFile,
  });
  process.exitCode = result.deadlineExpired ? 124 : result.code;
}

if (require.main === module) {
  if (process.argv[2] === "--bounded")
    boundedCommand().catch((error) => {
      process.stderr.write(`quality-run-bounded: ${error.message}\n`);
      process.exitCode = 2;
    });
  else main();
}
module.exports = { supervise };
