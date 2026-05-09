import { describe, expect, it, beforeEach } from "vitest";
import { TodoWriteTool } from "../src/tools/todo.js";
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

function makeContext(state: AgentState): ToolExecutionContext {
  return {
    cwd: "/ws",
    workspace: new MemoryWorkspace(),
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state,
  };
}

describe("TodoWriteTool", () => {
  let state: AgentState;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    state = makeState();
    ctx = makeContext(state);
  });

  it("adds todos to state", async () => {
    const result = await TodoWriteTool.execute(
      {
        todos: [
          { content: "Task A", status: "pending", activeForm: "Doing A" },
          { content: "Task B", status: "in_progress", activeForm: "Working on B" },
        ],
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(state.todos).toHaveLength(2);
    expect(state.todos[0]!.content).toBe("Task A");
    expect(state.todos[1]!.status).toBe("in_progress");
  });

  it("overwrites the existing todo list", async () => {
    await TodoWriteTool.execute(
      { todos: [{ content: "Old", status: "pending", activeForm: "Old" }] },
      ctx,
    );
    await TodoWriteTool.execute(
      { todos: [{ content: "New", status: "completed", activeForm: "New" }] },
      ctx,
    );
    expect(state.todos).toHaveLength(1);
    expect(state.todos[0]!.content).toBe("New");
  });

  it("clears the list with empty todos array", async () => {
    await TodoWriteTool.execute(
      { todos: [{ content: "Task", status: "pending", activeForm: "Task" }] },
      ctx,
    );
    const result = await TodoWriteTool.execute({ todos: [] }, ctx);
    expect(state.todos).toHaveLength(0);
    expect(result.content).toContain("cleared");
  });

  it("normalizes invalid status to pending", async () => {
    await TodoWriteTool.execute(
      { todos: [{ content: "X", status: "invalid_status", activeForm: "X" }] },
      ctx,
    );
    expect(state.todos[0]!.status).toBe("pending");
  });

  it("output lists todos with numbering", async () => {
    const result = await TodoWriteTool.execute(
      {
        todos: [
          { content: "Task A", status: "pending", activeForm: "Task A" },
          { content: "Task B", status: "completed", activeForm: "Task B" },
        ],
      },
      ctx,
    );
    expect(result.content).toContain("1.");
    expect(result.content).toContain("2.");
    expect(result.content).toContain("Task A");
    expect(result.content).toContain("Task B");
    expect(result.content).toContain("[pending]");
    expect(result.content).toContain("[completed]");
  });

  it("uses activeForm from input or falls back to content", async () => {
    await TodoWriteTool.execute(
      { todos: [{ content: "My Task", status: "pending" }] },
      ctx,
    );
    expect(state.todos[0]!.activeForm).toBe("My Task");
  });
});
