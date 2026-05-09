import { describe, expect, it } from "vitest";
import { LocalRuntime } from "../src/runtime/local.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";
import { startBackgroundShell } from "../src/tools/backgroundShells.js";

async function waitForShellDone(shell: { done: boolean }, timeoutMs = 3000) {
  const started = Date.now();
  while (!shell.done && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ──────────────────────────────────────────────
// LocalRuntime
// ──────────────────────────────────────────────

describe("LocalRuntime", () => {
  const runtime = new LocalRuntime();

  it("has id 'local'", () => {
    expect(runtime.id).toBe("local");
  });

  it("executes a simple echo command", async () => {
    const result = await runtime.exec("echo hello", {
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("returns non-zero exit code on failure", async () => {
    const result = await runtime.exec("exit 42", {
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(42);
  });

  it("reports stdout and stderr separately", async () => {
    const result = await runtime.exec("echo out; echo err >&2", {
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  });

  it("times out slow commands", async () => {
    const result = await runtime.exec("sleep 10", {
      cwd: process.cwd(),
      timeoutMs: 200,
      signal: new AbortController().signal,
    });
    expect(result.timedOut).toBe(true);
  }, 3000);

  it("respects AbortSignal cancellation", async () => {
    const ac = new AbortController();
    const promise = runtime.exec("sleep 10", {
      cwd: process.cwd(),
      timeoutMs: 30000,
      signal: ac.signal,
    });
    ac.abort();
    const result = await promise;
    expect(result.exitCode !== 0 || result.timedOut).toBe(true);
  }, 3000);

  it("spawns a background shell", () => {
    const shell = runtime.spawn("echo hello", { cwd: process.cwd() });
    expect(shell.id).toBeTruthy();
    expect(shell.command).toBe("echo hello");
    expect(typeof shell.kill).toBe("function");
  });
});

// ──────────────────────────────────────────────
// DisabledRuntime
// ──────────────────────────────────────────────

describe("DisabledRuntime", () => {
  const runtime = new DisabledRuntime();

  it("has id 'disabled'", () => {
    expect(runtime.id).toBe("disabled");
  });

  it("returns exitCode 126 for any command", async () => {
    const result = await runtime.exec("echo hello", {
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(126);
    expect(result.timedOut).toBe(false);
  });

  it("returns error message in stderr", async () => {
    const result = await runtime.exec("anything", {
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.stderr).toContain("not available");
  });

  it("spawn returns a done shell with exitCode 126", () => {
    const shell = runtime.spawn("ls", { cwd: process.cwd() });
    expect(shell.done).toBe(true);
    expect(shell.exitCode).toBe(126);
    expect(shell.stderr.length).toBeGreaterThan(0);
  });

  it("spawned shell kill returns undefined", () => {
    const shell = runtime.spawn("ls", { cwd: process.cwd() });
    expect(shell.kill()).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// backgroundShells
// ──────────────────────────────────────────────

describe("backgroundShells", () => {
  it("kill terminates a running process", async () => {
    const shell = startBackgroundShell("sleep 60", process.cwd());

    shell.kill();
    await waitForShellDone(shell);

    expect(shell.done).toBe(true);
  }, 5000);

  it("keeps stdout bounded when output exceeds the buffer", async () => {
    const shell = startBackgroundShell(
      'node -e "for (let i = 0; i < 2500; i++) console.log(i)"',
      process.cwd(),
    );

    await waitForShellDone(shell);

    expect(shell.done).toBe(true);
    expect(shell.stdout.length).toBeLessThanOrEqual(2000);
    expect(shell.stdout.at(0)).not.toBe("0");
  }, 5000);
});
