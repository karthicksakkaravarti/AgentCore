import { describe, expect, it } from "vitest";
import { BashOutputTool, BashTool, KillShellTool } from "../src/tools/bash.js";
import { isToolReadOnly } from "../src/permissions.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentState, ToolExecutionContext } from "../src/types.js";

function makeState(): AgentState {
  return {
    todos: [],
    backgroundShells: new Map(),
    alwaysAllowedTools: new Set(),
    alwaysDeniedTools: new Set(),
    readFiles: new Set(),
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function makeContext(state = makeState()): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    workspace: new MemoryWorkspace(),
    runtime: new LocalRuntime(),
    abortSignal: new AbortController().signal,
    state,
  };
}

// ──────────────────────────────────────────────
// read-only classification
// ──────────────────────────────────────────────

describe("BashTool readOnly classification", () => {
  it("ls is read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "ls -la" })).toBe(true);
  });
  it("pwd is read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "pwd" })).toBe(true);
  });
  it("git status is read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "git status" })).toBe(true);
  });
  it("git diff is read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "git diff HEAD" })).toBe(true);
  });
  it("npm test is read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "npm test" })).toBe(true);
  });
  it("grep is read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "grep foo bar.ts" })).toBe(true);
  });
  it("npm install is NOT read-only", () => {
    expect(isToolReadOnly(BashTool, { command: "npm install" })).toBe(false);
  });
});

// ──────────────────────────────────────────────
// destructive classification
// ──────────────────────────────────────────────

describe("BashTool destructive classification", () => {
  const destructive = (cmd: string) =>
    typeof BashTool.destructive === "function"
      ? BashTool.destructive({ command: cmd })
      : BashTool.destructive;

  it("rm -rf is destructive", () => {
    expect(destructive("rm -rf /tmp/foo")).toBe(true);
  });
  it("sudo is destructive", () => {
    expect(destructive("sudo apt-get install vim")).toBe(true);
  });
  it("git push is destructive", () => {
    expect(destructive("git push origin main")).toBe(true);
  });
  it("git reset is destructive", () => {
    expect(destructive("git reset --hard")).toBe(true);
  });
  it("echo is not destructive", () => {
    expect(destructive("echo hello")).toBe(false);
  });
  it("ls is not destructive", () => {
    expect(destructive("ls -la")).toBe(false);
  });
});

// ──────────────────────────────────────────────
// concurrencySafe
// ──────────────────────────────────────────────

describe("BashTool concurrencySafe", () => {
  const safe = (cmd: string) =>
    typeof BashTool.concurrencySafe === "function"
      ? BashTool.concurrencySafe({ command: cmd })
      : true;

  it("simple command is concurrency-safe", () => {
    expect(safe("echo hello")).toBe(true);
  });
  it("&& chained command is NOT safe", () => {
    expect(safe("echo a && echo b")).toBe(false);
  });
});

// ──────────────────────────────────────────────
// execute
// ──────────────────────────────────────────────

describe("BashTool execute", () => {
  it("returns stdout output for echo", async () => {
    const result = await BashTool.execute({ command: "echo hello" }, makeContext());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("hello");
  });

  it("reports non-zero exit code as error", async () => {
    const result = await BashTool.execute({ command: "exit 42" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("42");
  });

  it("reports timeout as error", async () => {
    const result = await BashTool.execute(
      { command: "sleep 10", timeout: 200 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  }, 3000);

  it("returns error for empty command", async () => {
    const result = await BashTool.execute({ command: "" }, makeContext());
    expect(result.isError).toBe(true);
  });

  it("background mode returns shell_id", async () => {
    const state = makeState();
    const result = await BashTool.execute(
      { command: "sleep 1", run_in_background: true },
      makeContext(state),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("background shell");
    expect(state.backgroundShells.size).toBe(1);
  });
});

// ──────────────────────────────────────────────
// BashOutputTool
// ──────────────────────────────────────────────

describe("BashOutputTool execute", () => {
  it("returns error for unknown shell id", async () => {
    const result = await BashOutputTool.execute(
      { bash_id: "nonexistent" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown background shell");
  });

  it("reads output from an existing background shell", async () => {
    const state = makeState();
    const ctx = makeContext(state);
    await BashTool.execute(
      { command: "echo fromshell", run_in_background: true },
      ctx,
    );
    const shellId = [...state.backgroundShells.keys()][0]!;
    // Give the shell a moment to produce output
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await BashOutputTool.execute({ bash_id: shellId }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(shellId);
  }, 3000);
});

// ──────────────────────────────────────────────
// KillShellTool
// ──────────────────────────────────────────────

describe("KillShellTool execute", () => {
  it("returns error for unknown shell id", async () => {
    const result = await KillShellTool.execute(
      { shell_id: "nonexistent" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
  });

  it("kills an existing shell", async () => {
    const state = makeState();
    const ctx = makeContext(state);
    await BashTool.execute({ command: "sleep 60", run_in_background: true }, ctx);
    const shellId = [...state.backgroundShells.keys()][0]!;
    const result = await KillShellTool.execute({ shell_id: shellId }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("SIGTERM");
  });
});
