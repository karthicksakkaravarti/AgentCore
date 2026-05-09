import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "../src/tools/agentTool.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";
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

function makeContext(runSubagent?: (prompt: string, desc?: string) => Promise<string>): ToolExecutionContext {
  return {
    cwd: "/ws",
    workspace: new MemoryWorkspace(),
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state: makeState(),
    runSubagent,
  };
}

describe("AgentTool", () => {
  it("returns error when runSubagent is not available", async () => {
    const result = await AgentTool.execute(
      { description: "Test", prompt: "Do something" },
      makeContext(undefined),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("calls runSubagent with prompt and description", async () => {
    const runSubagent = vi.fn().mockResolvedValue("subagent result");
    const result = await AgentTool.execute(
      { description: "Quick task", prompt: "Find the bug" },
      makeContext(runSubagent),
    );
    expect(runSubagent).toHaveBeenCalledWith("Find the bug", "Quick task");
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("subagent result");
  });

  it("passes description as second argument", async () => {
    const runSubagent = vi.fn().mockResolvedValue("done");
    await AgentTool.execute(
      { description: "My description", prompt: "My prompt" },
      makeContext(runSubagent),
    );
    expect(runSubagent).toHaveBeenCalledWith("My prompt", "My description");
  });

  it("is marked as concurrencySafe", () => {
    expect(AgentTool.concurrencySafe).toBe(true);
  });

  it("is not readOnly (it can modify things)", () => {
    expect(AgentTool.readOnly).toBe(false);
  });

  it("returns empty string result from subagent gracefully", async () => {
    const runSubagent = vi.fn().mockResolvedValue("");
    const result = await AgentTool.execute(
      { description: "Empty task", prompt: "Do nothing" },
      makeContext(runSubagent),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("");
  });
});
