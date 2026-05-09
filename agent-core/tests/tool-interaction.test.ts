import { describe, expect, it, vi } from "vitest";
import { AskUserQuestionTool, ExitPlanModeTool } from "../src/tools/interaction.js";
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

function makeContext(askUser?: (q: string) => Promise<string>): ToolExecutionContext {
  return {
    cwd: "/ws",
    workspace: new MemoryWorkspace(),
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state: makeState(),
    askUser,
  };
}

// ──────────────────────────────────────────────
// AskUserQuestionTool
// ──────────────────────────────────────────────

describe("AskUserQuestionTool", () => {
  it("calls askUser callback with the question", async () => {
    const askUser = vi.fn().mockResolvedValue("blue");
    const result = await AskUserQuestionTool.execute(
      { question: "What is your favorite color?" },
      makeContext(askUser),
    );
    expect(askUser).toHaveBeenCalledWith("What is your favorite color?");
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("blue");
  });

  it("returns error when askUser is not provided", async () => {
    const result = await AskUserQuestionTool.execute(
      { question: "Test?" },
      makeContext(undefined),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot ask");
  });

  it("returns fallback message when user gives empty answer", async () => {
    const askUser = vi.fn().mockResolvedValue("");
    const result = await AskUserQuestionTool.execute(
      { question: "Say something?" },
      makeContext(askUser),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("no answer");
  });

  it("is marked as readOnly", () => {
    expect(AskUserQuestionTool.readOnly).toBe(true);
  });

  it("is NOT concurrencySafe", () => {
    expect(AskUserQuestionTool.concurrencySafe).toBe(false);
  });
});

// ──────────────────────────────────────────────
// ExitPlanModeTool
// ──────────────────────────────────────────────

describe("ExitPlanModeTool", () => {
  it("returns the plan text as content", async () => {
    const result = await ExitPlanModeTool.execute(
      { plan: "1. Do this\n2. Do that" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("1. Do this\n2. Do that");
  });

  it("returns empty string for empty plan", async () => {
    const result = await ExitPlanModeTool.execute({ plan: "" }, makeContext());
    expect(result.content).toBe("");
  });

  it("is marked as readOnly", () => {
    expect(ExitPlanModeTool.readOnly).toBe(true);
  });
});
