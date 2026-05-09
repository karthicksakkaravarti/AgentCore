import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AgentCore } from "../src/agent.js";
import { NullSessionStorage } from "../src/sessionStorage.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";
import type { LLMProvider } from "../src/providers/provider.js";
import type { ProviderStreamEvent, NeutralUsage } from "../src/providers/types.js";

// ──────────────────────────────────────────────
// Helper: build a mock LLMProvider
// ──────────────────────────────────────────────

function makeMockProvider(events: ProviderStreamEvent[]): LLMProvider {
  return {
    id: "mock",
    model: "mock-model",
    stream: vi.fn().mockImplementation(async function* () {
      for (const event of events) {
        yield event;
      }
    }),
  };
}

function makeSequencedProvider(eventSets: ProviderStreamEvent[][]): LLMProvider {
  let callCount = 0;
  return {
    id: "mock",
    model: "mock-model",
    stream: vi.fn().mockImplementation(async function* () {
      const events = eventSets[Math.min(callCount, eventSets.length - 1)] ?? [];
      callCount++;
      for (const event of events) {
        yield event;
      }
    }),
  };
}

const SIMPLE_USAGE: NeutralUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function simpleTextResponse(text: string): ProviderStreamEvent[] {
  return [
    { type: "text_delta", text },
    {
      type: "message_end",
      usage: SIMPLE_USAGE,
      stopReason: "end_turn",
    },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────
// Basic run
// ──────────────────────────────────────────────

describe("AgentCore basic run", () => {
  it("uses the built-in default model when env model overrides are unset", async () => {
    const originalAgentModel = process.env.AGENT_CORE_MODEL;
    const originalAnthropicModel = process.env.ANTHROPIC_MODEL;
    delete process.env.AGENT_CORE_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    const provider = makeMockProvider(simpleTextResponse("default"));
    const registry = await import("../src/providers/registry.js");
    const spy = vi.spyOn(registry, "resolveProvider").mockReturnValue(provider);

    try {
      const agent = new AgentCore({
        apiKey: "test-key",
        sessionStorage: new NullSessionStorage(),
        workspace: new MemoryWorkspace(),
        runtime: new DisabledRuntime(),
        permissionMode: "bypassPermissions",
      });
      await agent.run("Hi");

      expect(spy).toHaveBeenCalledWith("claude-sonnet-4-6", {
        apiKey: "test-key",
      });
    } finally {
      if (originalAgentModel === undefined) delete process.env.AGENT_CORE_MODEL;
      else process.env.AGENT_CORE_MODEL = originalAgentModel;
      if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = originalAnthropicModel;
    }
  });

  it("returns text from the provider", async () => {
    const provider = makeMockProvider(simpleTextResponse("Hello from agent!"));

    // We mock resolveProvider to return our mock
    const { default: registryModule } = await import("../src/providers/registry.js");
    const spy = vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Hi");
    expect(result.text).toContain("Hello from agent!");
    expect(result.stoppedBy).toBe("end_turn");

    spy.mockRestore();
  });

  it("accumulates usage tokens", async () => {
    const { resolveProvider } = await import("../src/providers/registry.js");
    const provider = makeMockProvider(simpleTextResponse("OK"));
    const spy = vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    await agent.run("Test");
    const usage = agent.getUsage();
    expect(usage.inputTokens).toBeGreaterThanOrEqual(10);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(5);

    spy.mockRestore();
  });

  it.each([
    ["tool_use", "other"],
    ["other", "other"],
  ] as const)("maps provider stop reason %s without tool calls to %s", async (stopReason, stoppedBy) => {
    const provider = makeMockProvider([
      {
        type: "message_end",
        usage: SIMPLE_USAGE,
        stopReason,
      },
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Test");
    expect(result.stoppedBy).toBe(stoppedBy);
  });

  it("getSessionInfo returns sessionId and persisted=false when persistSession=false", async () => {
    const provider = makeMockProvider(simpleTextResponse("x"));
    const spy = vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      persistSession: false,
    });

    const info = agent.getSessionInfo();
    expect(typeof info.sessionId).toBe("string");
    expect(info.sessionId.length).toBeGreaterThan(0);
    expect(info.persisted).toBe(false);

    spy.mockRestore();
  });

  it("injects discovered attachment messages before the first user prompt", async () => {
    const provider = makeMockProvider(simpleTextResponse("OK"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);
    const workspace = new MemoryWorkspace({ cwd: "/ws" });
    await workspace.write("/ws/CLAUDE.md", "Project-specific instruction");

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace,
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Hi");

    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Project-specific instruction"),
      }),
    );
    expect(provider.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("Project-specific instruction"),
              }),
            ]),
          }),
        ]),
      }),
    );
  });
});

// ──────────────────────────────────────────────
// listTools / clearHistory
// ──────────────────────────────────────────────

describe("AgentCore listTools / clearHistory", () => {
  let agent: AgentCore;

  beforeEach(async () => {
    const provider = makeMockProvider(simpleTextResponse("x"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
    });
  });

  it("listTools returns tool names", () => {
    const tools = agent.listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
  });

  it("clearHistory resets messages", async () => {
    agent.clearHistory();
    expect(agent.getMessages()).toHaveLength(0);
  });

  it("allowedTools filter applies", async () => {
    const provider = makeMockProvider(simpleTextResponse("x"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const limited = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      allowedTools: ["Read", "Glob"],
    });
    expect(limited.listTools()).toEqual(expect.arrayContaining(["Read", "Glob"]));
    expect(limited.listTools()).not.toContain("Bash");
  });

  it("disabledTools filter applies", async () => {
    const provider = makeMockProvider(simpleTextResponse("x"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const noBash = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      disabledTools: ["Bash"],
    });
    expect(noBash.listTools()).not.toContain("Bash");
  });
});

// ──────────────────────────────────────────────
// Tool use loop
// ──────────────────────────────────────────────

describe("AgentCore tool use loop", () => {
  it("executes ExitPlanMode tool call and returns result", async () => {
    const toolEvents: ProviderStreamEvent[] = [
      { type: "tool_use_start", id: "tool1", name: "ExitPlanMode" },
      {
        type: "tool_use_input_delta",
        id: "tool1",
        partialJson: '{"plan":"My implementation plan"}',
      },
      { type: "tool_use_end", id: "tool1", input: { plan: "My implementation plan" } },
      {
        type: "message_end",
        usage: SIMPLE_USAGE,
        stopReason: "tool_use",
      },
    ];
    // After tool result, agent returns final answer
    const finalEvents: ProviderStreamEvent[] = [
      { type: "text_delta", text: "Plan recorded." },
      { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
    ];

    let callCount = 0;
    const provider: LLMProvider = {
      id: "mock",
      model: "mock-model",
      stream: vi.fn().mockImplementation(async function* () {
        const events = callCount === 0 ? toolEvents : finalEvents;
        callCount++;
        for (const event of events) {
          yield event;
        }
      }),
    };

    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Create a plan");
    expect(result.stoppedBy).toBe("end_turn");
    expect(result.text).toContain("Plan recorded.");
  });

  it("stops with max_turns when loop exceeds limit", async () => {
    // Every response returns another tool_use — forcing max_turns
    const infiniteToolEvents: ProviderStreamEvent[] = [
      { type: "tool_use_start", id: "tool1", name: "ExitPlanMode" },
      { type: "tool_use_input_delta", id: "tool1", partialJson: '{"plan":"x"}' },
      { type: "tool_use_end", id: "tool1", input: { plan: "x" } },
      { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
    ];

    const provider: LLMProvider = {
      id: "mock",
      model: "mock-model",
      stream: vi.fn().mockImplementation(async function* () {
        for (const event of infiniteToolEvents) {
          yield event;
        }
      }),
    };

    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
      maxTurns: 2,
    });

    const result = await agent.run("Infinite");
    expect(result.stoppedBy).toBe("max_turns");
  });

  it("permission denial returns error tool result", async () => {
    const events: ProviderStreamEvent[] = [
      { type: "tool_use_start", id: "tu1", name: "Bash" },
      { type: "tool_use_input_delta", id: "tu1", partialJson: '{"command":"rm -rf /"}' },
      { type: "tool_use_end", id: "tu1", input: { command: "rm -rf /" } },
      { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
    ];

    const finalEvents: ProviderStreamEvent[] = [
      { type: "text_delta", text: "Denied." },
      { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
    ];

    let callCount = 0;
    const provider: LLMProvider = {
      id: "mock",
      model: "mock-model",
      stream: vi.fn().mockImplementation(async function* () {
        const evs = callCount === 0 ? events : finalEvents;
        callCount++;
        for (const e of evs) {
          yield e;
        }
      }),
    };

    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const events_emitted: Array<{ type: string }> = [];
    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "plan", // plan mode denies all write tools
      onEvent: (evt) => events_emitted.push(evt),
    });

    const result = await agent.run("Delete everything");
    // The tool result should have been an error (permission denied)
    const toolResultEvent = events_emitted.find(
      (e) => e.type === "tool_result",
    ) as { type: "tool_result"; result: { isError: boolean } } | undefined;
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!.result.isError).toBe(true);
  });

  it("returns an error tool_result for an unknown tool", async () => {
    const provider = makeSequencedProvider([
      [
        { type: "tool_use_start", id: "missing", name: "NonExistentTool" },
        {
          type: "tool_use_end",
          id: "missing",
          input: { value: true },
        },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Handled." },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
      ],
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Use a missing tool");
    const toolResult = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");

    expect(toolResult).toEqual({
      type: "tool_result",
      toolUseId: "missing",
      content: "Unknown tool: NonExistentTool",
      isError: true,
    });
  });

  it("captures Error exceptions thrown by tool execution", async () => {
    class ThrowingWorkspace extends MemoryWorkspace {
      override async write(): Promise<void> {
        throw new Error("boom");
      }
    }
    const provider = makeSequencedProvider([
      [
        { type: "tool_use_start", id: "write", name: "Write" },
        {
          type: "tool_use_end",
          id: "write",
          input: { file_path: "/workspace/file.txt", content: "data" },
        },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Recovered." },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
      ],
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new ThrowingWorkspace({ cwd: "/workspace" }),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Write a file");
    const toolResult = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");

    expect(toolResult).toEqual(
      expect.objectContaining({
        type: "tool_result",
        toolUseId: "write",
        content: '{\n  "error": "boom"\n}',
        isError: true,
      }),
    );
  });

  it("captures non-Error exceptions thrown by tool execution", async () => {
    class ThrowingWorkspace extends MemoryWorkspace {
      override async write(): Promise<void> {
        throw "plain boom";
      }
    }
    const provider = makeSequencedProvider([
      [
        { type: "tool_use_start", id: "write", name: "Write" },
        {
          type: "tool_use_end",
          id: "write",
          input: { file_path: "/workspace/file.txt", content: "data" },
        },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Recovered." },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
      ],
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new ThrowingWorkspace({ cwd: "/workspace" }),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Write a file");
    const toolResult = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");

    expect(toolResult).toEqual(
      expect.objectContaining({
        type: "tool_result",
        toolUseId: "write",
        content: '{\n  "error": "plain boom"\n}',
        isError: true,
      }),
    );
  });

  it("creates a synthetic tool_use block when tool_use_end arrives alone", async () => {
    const provider = makeSequencedProvider([
      [
        {
          type: "tool_use_end",
          id: "orphan",
          input: { command: "echo hi" },
        },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
      ],
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Use orphan tool");
    const syntheticToolUse = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_use");

    expect(syntheticToolUse).toEqual({
      type: "tool_use",
      id: "orphan",
      name: "tool",
      input: { command: "echo hi" },
    });
  });

  it("normalizes non-object tool input before execution", async () => {
    const provider = makeSequencedProvider([
      [
        { type: "tool_use_start", id: "bash", name: "Bash" },
        {
          type: "tool_use_end",
          id: "bash",
          input: "not an object",
        } as unknown as ProviderStreamEvent,
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "message_end", usage: SIMPLE_USAGE, stopReason: "end_turn" },
      ],
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Run bash");
    const toolResult = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");

    expect(toolResult).toEqual(
      expect.objectContaining({
        type: "tool_result",
        toolUseId: "bash",
        content: "Missing command.",
        isError: true,
      }),
    );
  });

  it("adds subagent token usage to the parent agent usage", async () => {
    const parentProvider = makeSequencedProvider([
      [
        { type: "tool_use_start", id: "sub", name: "Agent" },
        {
          type: "tool_use_end",
          id: "sub",
          input: { description: "Check files", prompt: "Inspect the code" },
        },
        {
          type: "message_end",
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "tool_use",
        },
      ],
      [
        { type: "text_delta", text: "Parent done." },
        {
          type: "message_end",
          usage: {
            inputTokens: 5,
            outputTokens: 7,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "end_turn",
        },
      ],
    ]);
    const subagentProvider = makeMockProvider([
      { type: "text_delta", text: "Subagent report." },
      {
        type: "message_end",
        usage: {
          inputTokens: 11,
          outputTokens: 13,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "end_turn",
      },
    ]);
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValueOnce(parentProvider)
      .mockReturnValueOnce(subagentProvider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    const result = await agent.run("Delegate work");

    expect(result.usage.inputTokens).toBe(18);
    expect(result.usage.outputTokens).toBe(23);
  });
});

// ──────────────────────────────────────────────
// Multi-turn conversation
// ──────────────────────────────────────────────

describe("AgentCore multi-turn", () => {
  it("messages array grows across multiple run() calls", async () => {
    const provider = makeMockProvider(simpleTextResponse("response"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
    });

    // First turn
    await agent.run("First message");
    const countAfterFirst = agent.getMessages().length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Mock provider needs to be reset for second call
    const provider2 = makeMockProvider(simpleTextResponse("response2"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider2);
    agent.setModel("mock/mock-model2");

    await agent.run("Second message");
    const countAfterSecond = agent.getMessages().length;
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
  });
});

// ──────────────────────────────────────────────
// onEvent callback
// ──────────────────────────────────────────────

describe("AgentCore onEvent", () => {
  it("emits request, assistant_text, assistant_message, usage events", async () => {
    const provider = makeMockProvider(simpleTextResponse("Hello"));
    vi.spyOn(await import("../src/providers/registry.js"), "resolveProvider")
      .mockReturnValue(provider);

    const emitted: string[] = [];
    const agent = new AgentCore({
      model: "mock/mock-model",
      apiKey: "test-key",
      sessionStorage: new NullSessionStorage(),
      workspace: new MemoryWorkspace(),
      runtime: new DisabledRuntime(),
      permissionMode: "bypassPermissions",
      onEvent: (event) => emitted.push(event.type),
    });

    await agent.run("test");
    expect(emitted).toContain("request");
    expect(emitted).toContain("assistant_message");
    expect(emitted).toContain("usage");
  });
});
