import { describe, expect, it, vi } from "vitest";
import {
  decidePermission,
  isToolConcurrencySafe,
  isToolReadOnly,
} from "../src/permissions.js";
import type { AgentState, AgentTool, ToolExecutionContext } from "../src/types.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    todos: [],
    backgroundShells: new Map(),
    alwaysAllowedTools: new Set(),
    alwaysDeniedTools: new Set(),
    readFiles: new Set(),
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function makeContext(state: AgentState = makeState()): ToolExecutionContext {
  return {
    cwd: "/workspace",
    workspace: new MemoryWorkspace(),
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state,
  };
}

function makeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "TestTool",
    description: "A test tool",
    inputSchema: {},
    readOnly: false,
    execute: async () => ({ content: "ok" }),
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// isToolReadOnly
// ──────────────────────────────────────────────

describe("isToolReadOnly", () => {
  it("returns true when readOnly is true", () => {
    const tool = makeTool({ readOnly: true });
    expect(isToolReadOnly(tool, {})).toBe(true);
  });

  it("returns false when readOnly is false", () => {
    const tool = makeTool({ readOnly: false });
    expect(isToolReadOnly(tool, {})).toBe(false);
  });

  it("calls readOnly as a function with input", () => {
    const tool = makeTool({ readOnly: (input) => input["mode"] === "read" });
    expect(isToolReadOnly(tool, { mode: "read" })).toBe(true);
    expect(isToolReadOnly(tool, { mode: "write" })).toBe(false);
  });
});

// ──────────────────────────────────────────────
// isToolConcurrencySafe
// ──────────────────────────────────────────────

describe("isToolConcurrencySafe", () => {
  it("returns true when concurrencySafe is true", () => {
    const tool = makeTool({ concurrencySafe: true });
    expect(isToolConcurrencySafe(tool, {})).toBe(true);
  });

  it("falls back to readOnly when concurrencySafe is undefined", () => {
    const tool = makeTool({ readOnly: true, concurrencySafe: undefined });
    expect(isToolConcurrencySafe(tool, {})).toBe(true);
  });

  it("returns false when concurrencySafe function returns false", () => {
    const tool = makeTool({
      concurrencySafe: (input) => !String(input["cmd"] ?? "").includes("&&"),
    });
    expect(isToolConcurrencySafe(tool, { cmd: "echo a && echo b" })).toBe(false);
    expect(isToolConcurrencySafe(tool, { cmd: "echo a" })).toBe(true);
  });
});

// ──────────────────────────────────────────────
// decidePermission
// ──────────────────────────────────────────────

describe("decidePermission — alwaysDeniedTools", () => {
  it("denies a tool in alwaysDeniedTools regardless of mode", async () => {
    const state = makeState({ alwaysDeniedTools: new Set(["BadTool"]) });
    const tool = makeTool({ name: "BadTool" });
    const decision = await decidePermission(tool, {}, makeContext(state), {
      mode: "bypassPermissions",
    });
    expect(decision.behavior).toBe("deny");
  });
});

describe("decidePermission — bypassPermissions", () => {
  it("always allows in bypassPermissions mode", async () => {
    const tool = makeTool({ readOnly: false, destructive: true });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "bypassPermissions",
    });
    expect(decision.behavior).toBe("allow");
  });
});

describe("decidePermission — alwaysAllowedTools", () => {
  it("allows a tool in alwaysAllowedTools regardless of readOnly", async () => {
    const state = makeState({ alwaysAllowedTools: new Set(["SpecialTool"]) });
    const tool = makeTool({ name: "SpecialTool", readOnly: false, destructive: true });
    const decision = await decidePermission(tool, {}, makeContext(state), {
      mode: "default",
    });
    expect(decision.behavior).toBe("allow");
  });
});

describe("decidePermission — read-only tools", () => {
  it("auto-allows read-only non-destructive tools in default mode", async () => {
    const tool = makeTool({ readOnly: true, destructive: false });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "default",
    });
    expect(decision.behavior).toBe("allow");
  });

  it("does NOT auto-allow read-only but destructive tools", async () => {
    const tool = makeTool({ readOnly: true, destructive: true });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "default",
    });
    expect(decision.behavior).toBe("deny");
  });
});

describe("decidePermission — plan mode", () => {
  it("denies write tools in plan mode", async () => {
    const tool = makeTool({ readOnly: false, destructive: false });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "plan",
    });
    expect(decision.behavior).toBe("deny");
    expect((decision as { message: string }).message).toContain("Plan mode");
  });

  it("allows read-only tools in plan mode", async () => {
    const tool = makeTool({ readOnly: true, destructive: false });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "plan",
    });
    expect(decision.behavior).toBe("allow");
  });
});

describe("decidePermission — acceptEdits mode", () => {
  it("allows Edit in acceptEdits mode", async () => {
    const tool = makeTool({ name: "Edit", readOnly: false, destructive: false });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "acceptEdits",
    });
    expect(decision.behavior).toBe("allow");
  });

  it("allows Write in acceptEdits mode", async () => {
    const tool = makeTool({ name: "Write", readOnly: false, destructive: true });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "acceptEdits",
    });
    expect(decision.behavior).toBe("allow");
  });

  it("allows TodoWrite in acceptEdits mode", async () => {
    const tool = makeTool({ name: "TodoWrite", readOnly: false, destructive: false });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "acceptEdits",
    });
    expect(decision.behavior).toBe("allow");
  });

  it("calls permissionPrompt for Bash in acceptEdits mode", async () => {
    const tool = makeTool({ name: "Bash", readOnly: false, destructive: false });
    const prompt = vi.fn().mockResolvedValue({ behavior: "allow" });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "acceptEdits",
      prompt,
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(decision.behavior).toBe("allow");
  });
});

describe("decidePermission — permissionPrompt callback", () => {
  it("calls prompt when tool needs permission in default mode", async () => {
    const tool = makeTool({ readOnly: false, destructive: false });
    const prompt = vi.fn().mockResolvedValue({ behavior: "allow" });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "default",
      prompt,
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(decision.behavior).toBe("allow");
  });

  it("denies when no prompt provided and tool needs permission", async () => {
    const tool = makeTool({ readOnly: false });
    const decision = await decidePermission(tool, {}, makeContext(), {
      mode: "default",
    });
    expect(decision.behavior).toBe("deny");
  });

  it("adds tool to alwaysAllowedTools when remember=true", async () => {
    const state = makeState();
    const tool = makeTool({ name: "MyTool", readOnly: false });
    const prompt = vi.fn().mockResolvedValue({ behavior: "allow", remember: true });
    await decidePermission(tool, {}, makeContext(state), {
      mode: "default",
      prompt,
    });
    expect(state.alwaysAllowedTools.has("MyTool")).toBe(true);
  });

  it("adds tool to alwaysDeniedTools when interrupt=true", async () => {
    const state = makeState();
    const tool = makeTool({ name: "DangerTool", readOnly: false });
    const prompt = vi.fn().mockResolvedValue({
      behavior: "deny",
      message: "no",
      interrupt: true,
    });
    await decidePermission(tool, {}, makeContext(state), {
      mode: "default",
      prompt,
    });
    expect(state.alwaysDeniedTools.has("DangerTool")).toBe(true);
  });
});
