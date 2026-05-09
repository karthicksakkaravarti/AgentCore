import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../src/providers/types.js";

const geminiMocks = vi.hoisted(() => {
  const mockGenerateContentStream = vi.fn();
  const MockGoogleGenAI = vi.fn();
  return { mockGenerateContentStream, MockGoogleGenAI };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: geminiMocks.MockGoogleGenAI,
  FinishReason: {
    STOP: "STOP",
    MAX_TOKENS: "MAX_TOKENS",
    FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
  },
  FunctionCallingConfigMode: { AUTO: "AUTO" },
}));

import { createGemini } from "../src/providers/gemini.js";

function makeGeminiStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function collect(
  chunks: unknown[],
  options: {
    messages?: Parameters<ReturnType<typeof createGemini>["stream"]>[0]["messages"];
    tools?: Parameters<ReturnType<typeof createGemini>["stream"]>[0]["tools"];
  } = {},
): Promise<ProviderStreamEvent[]> {
  geminiMocks.mockGenerateContentStream.mockResolvedValue(makeGeminiStream(chunks));
  const provider = createGemini({
    id: "google",
    apiKey: "test-key",
    model: "gemini-test",
  });
  const output: ProviderStreamEvent[] = [];
  for await (const event of provider.stream({
    system: "system prompt",
    messages: options.messages ?? [],
    tools: options.tools ?? [],
    maxTokens: 123,
    signal: new AbortController().signal,
  })) {
    output.push(event);
  }
  return output;
}

describe("createGemini", () => {
  beforeEach(() => {
    geminiMocks.mockGenerateContentStream.mockReset();
    geminiMocks.MockGoogleGenAI.mockReset();
    geminiMocks.MockGoogleGenAI.mockImplementation(() => ({
      models: {
        generateContentStream: geminiMocks.mockGenerateContentStream,
      },
    }));
  });

  it("returns a provider with the requested id and model", () => {
    const provider = createGemini({
      id: "google",
      apiKey: "test-key",
      model: "gemini-test",
    });
    expect(provider.id).toBe("google");
    expect(provider.model).toBe("gemini-test");
    expect(geminiMocks.MockGoogleGenAI).toHaveBeenCalledWith({
      apiKey: "test-key",
    });
  });

  it("streams text deltas and final usage", async () => {
    const events = await collect([
      {
        candidates: [
          {
            content: { parts: [{ text: "Gem" }, { text: "ini" }] },
            finishReason: "STOP",
          },
        ],
      },
      {
        candidates: [],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
      },
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "Gem" },
      { type: "text_delta", text: "ini" },
      {
        type: "message_end",
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "end_turn",
      },
    ]);
  });

  it.each([
    ["STOP", "end_turn"],
    ["MAX_TOKENS", "max_tokens"],
    ["FINISH_REASON_UNSPECIFIED", "other"],
  ] as const)("maps finish reason %s to %s", async (input, expected) => {
    const events = await collect([
      {
        candidates: [{ content: { parts: [] }, finishReason: input }],
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

  it("streams function calls and forces tool_use stop reason", async () => {
    const events = await collect([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: "call_1",
                    name: "Read",
                    args: { file_path: "a.ts" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ]);

    expect(events).toEqual([
      { type: "tool_use_start", id: "call_1", name: "Read" },
      {
        type: "tool_use_input_delta",
        id: "call_1",
        partialJson: '{\n  "file_path": "a.ts"\n}',
      },
      { type: "tool_use_end", id: "call_1", input: { file_path: "a.ts" } },
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
  });

  it("generates incrementing synthetic IDs for function calls without IDs", async () => {
    const events = await collect([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "One", args: { one: true } } },
                { functionCall: { name: "Two", args: { two: true } } },
              ],
            },
          },
        ],
      },
    ]);

    expect(events).toContainEqual({
      type: "tool_use_start",
      id: "gemini_tool_call_0",
      name: "One",
    });
    expect(events).toContainEqual({
      type: "tool_use_start",
      id: "gemini_tool_call_1",
      name: "Two",
    });
  });

  it("sends neutral messages, tool results, and tools in Gemini format", async () => {
    await collect([], {
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
            {
              type: "tool_result",
              toolUseId: "call_1",
              content: "file contents",
            },
            {
              type: "tool_result",
              toolUseId: "missing",
              content: "bad result",
              isError: true,
            },
          ],
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read files",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(geminiMocks.mockGenerateContentStream).toHaveBeenCalledWith({
      model: "gemini-test",
      contents: [
        {
          role: "model",
          parts: [
            { text: "I will read." },
            {
              functionCall: {
                id: "call_1",
                name: "Read",
                args: { file_path: "a.ts" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call_1",
                name: "Read",
                response: { output: "file contents" },
              },
            },
            {
              functionResponse: {
                id: "missing",
                name: "tool_result",
                response: { error: "bad result" },
              },
            },
          ],
        },
      ],
      config: {
        abortSignal: expect.any(AbortSignal),
        maxOutputTokens: 123,
        systemInstruction: "system prompt",
        tools: [
          {
            functionDeclarations: [
              {
                name: "Read",
                description: "Read files",
                parametersJsonSchema: { type: "object" },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "AUTO",
          },
        },
      },
    });
  });

  it("omits tool config when no tools are provided", async () => {
    await collect([]);

    expect(geminiMocks.mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          tools: undefined,
          toolConfig: undefined,
        }),
      }),
    );
  });

  it("normalizes array or missing function call args to empty objects", async () => {
    const events = await collect([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: "array", name: "Array", args: [] } },
                { functionCall: { id: "missing", name: "Missing" } },
              ],
            },
          },
        ],
      },
    ]);

    expect(events).toContainEqual({
      type: "tool_use_end",
      id: "array",
      input: {},
    });
    expect(events).toContainEqual({
      type: "tool_use_end",
      id: "missing",
      input: {},
    });
  });
});
