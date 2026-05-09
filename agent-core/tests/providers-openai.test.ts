import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../src/providers/types.js";

const openaiMocks = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn();
  return { mockCreate, MockOpenAI };
});

vi.mock("openai", () => ({
  default: openaiMocks.MockOpenAI,
}));

import { createOpenAI } from "../src/providers/openai.js";

function makeOpenAIStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function collect(chunks: unknown[]): Promise<ProviderStreamEvent[]> {
  openaiMocks.mockCreate.mockResolvedValue(makeOpenAIStream(chunks));
  const provider = createOpenAI({
    id: "openai",
    apiKey: "test-key",
    model: "gpt-test",
  });
  const output: ProviderStreamEvent[] = [];
  for await (const event of provider.stream({
    system: "system prompt",
    messages: [],
    tools: [],
    maxTokens: 123,
    signal: new AbortController().signal,
  })) {
    output.push(event);
  }
  return output;
}

describe("createOpenAI", () => {
  beforeEach(() => {
    openaiMocks.mockCreate.mockReset();
    openaiMocks.MockOpenAI.mockReset();
    openaiMocks.MockOpenAI.mockImplementation(() => ({
      chat: { completions: { create: openaiMocks.mockCreate } },
    }));
  });

  it("constructs providers with and without baseURL", () => {
    const defaultProvider = createOpenAI({
      id: "openai",
      apiKey: "test-key",
      model: "gpt-test",
    });
    const compatibleProvider = createOpenAI({
      id: "groq",
      apiKey: "groq-key",
      model: "llama-test",
      baseURL: "https://api.groq.example/openai/v1",
    });

    expect(defaultProvider.id).toBe("openai");
    expect(defaultProvider.model).toBe("gpt-test");
    expect(compatibleProvider.id).toBe("groq");
    expect(compatibleProvider.model).toBe("llama-test");
    expect(openaiMocks.MockOpenAI).toHaveBeenNthCalledWith(1, {
      apiKey: "test-key",
      baseURL: undefined,
    });
    expect(openaiMocks.MockOpenAI).toHaveBeenNthCalledWith(2, {
      apiKey: "groq-key",
      baseURL: "https://api.groq.example/openai/v1",
    });
  });

  it("streams text chunks and captures final usage", async () => {
    const events = await collect([
      {
        choices: [{ delta: { content: "Hel" }, finish_reason: null }],
      },
      {
        choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
      },
      {
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      },
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "message_end",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "end_turn",
      },
    ]);
  });

  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["content_filter", "other"],
  ] as const)("maps finish reason %s to %s", async (input, expected) => {
    const events = await collect([
      {
        choices: [{ delta: {}, finish_reason: input }],
      },
    ]);

    expect(events.at(-1)).toEqual({
      type: "message_end",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: expected,
    });
  });

  it("streams tool calls and emits one start per call index", async () => {
    const events = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "Read", arguments: '{"file_' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'path":"a.ts"}' },
                },
                {
                  index: 1,
                  function: { name: "Write", arguments: '{"content":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    expect(events).toEqual([
      { type: "tool_use_start", id: "call_1", name: "Read" },
      {
        type: "tool_use_input_delta",
        id: "call_1",
        partialJson: '{"file_',
      },
      {
        type: "tool_use_input_delta",
        id: "call_1",
        partialJson: 'path":"a.ts"}',
      },
      { type: "tool_use_start", id: "tool_call_1", name: "Write" },
      {
        type: "tool_use_input_delta",
        id: "tool_call_1",
        partialJson: '{"content":"x"}',
      },
      { type: "tool_use_end", id: "call_1", input: { file_path: "a.ts" } },
      { type: "tool_use_end", id: "tool_call_1", input: { content: "x" } },
      {
        type: "message_end",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "tool_use",
      },
    ]);
    expect(events.filter((event) => event.type === "tool_use_start")).toHaveLength(2);
  });

  it("emits a late tool_use_start when arguments arrive before a name", async () => {
    const events = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "late",
                  function: { arguments: '{"x":1}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    expect(events).toContainEqual({
      type: "tool_use_input_delta",
      id: "late",
      partialJson: '{"x":1}',
    });
    expect(events).toContainEqual({
      type: "tool_use_start",
      id: "late",
      name: "tool_0",
    });
    expect(events).toContainEqual({
      type: "tool_use_end",
      id: "late",
      input: { x: 1 },
    });
  });

  it("sends neutral messages and tools in OpenAI format", async () => {
    openaiMocks.mockCreate.mockResolvedValue(makeOpenAIStream([]));
    const provider = createOpenAI({
      id: "openai",
      apiKey: "test-key",
      model: "gpt-test",
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.stream({
      system: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will read." },
            {
              type: "tool_use",
              id: "call_1",
              name: "Read",
              input: { file_path: "a.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "thanks" },
            {
              type: "tool_result",
              toolUseId: "call_1",
              content: "file contents",
            },
          ],
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read files",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      maxTokens: 50,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "message_end",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "end_turn",
      },
    ]);
    expect(openaiMocks.mockCreate).toHaveBeenCalledWith(
      {
        model: "gpt-test",
        max_tokens: 50,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: "sys" },
          {
            role: "assistant",
            content: "I will read.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "Read",
                  arguments: '{\n  "file_path": "a.ts"\n}',
                },
              },
            ],
          },
          { role: "user", content: "thanks" },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "file contents",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "Read",
              description: "Read files",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it("normalizes empty, malformed, and array tool argument JSON to empty objects", async () => {
    for (const [id, args] of [
      ["empty", ""],
      ["bad", "{"],
      ["array", "[]"],
    ] as const) {
      const events = await collect([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id,
                    function: { name: "Read", arguments: args },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);

      expect(events).toContainEqual({
        type: "tool_use_end",
        id,
        input: {},
      });
    }
  });
});
