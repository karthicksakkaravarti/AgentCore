import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../src/providers/types.js";

const anthropicMocks = vi.hoisted(() => {
  const mockStream = vi.fn();
  const MockAnthropic = vi.fn();
  return { mockStream, MockAnthropic };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: anthropicMocks.MockAnthropic,
}));

import { createAnthropic } from "../src/providers/anthropic.js";

function makeAnthropicStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collect(events: unknown[]): Promise<ProviderStreamEvent[]> {
  anthropicMocks.mockStream.mockReturnValue(makeAnthropicStream(events));
  const provider = createAnthropic({
    id: "anthropic",
    apiKey: "test-key",
    model: "claude-test",
  });
  const output: ProviderStreamEvent[] = [];
  for await (const event of provider.stream({
    system: "system prompt",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "tool_result",
            toolUseId: "tool_1",
            content: "done",
            isError: true,
          },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        inputSchema: { type: "object" },
      },
    ],
    maxTokens: 123,
    signal: new AbortController().signal,
  })) {
    output.push(event);
  }
  return output;
}

describe("createAnthropic", () => {
  beforeEach(() => {
    anthropicMocks.mockStream.mockReset();
    anthropicMocks.MockAnthropic.mockReset();
    anthropicMocks.MockAnthropic.mockImplementation(() => ({
      messages: { stream: anthropicMocks.mockStream },
    }));
  });

  it("returns a provider with the requested id and model", () => {
    const provider = createAnthropic({
      id: "anthropic",
      apiKey: "test-key",
      model: "claude-test",
    });
    expect(provider.id).toBe("anthropic");
    expect(provider.model).toBe("claude-test");
    expect(anthropicMocks.MockAnthropic).toHaveBeenCalledWith({
      apiKey: "test-key",
    });
  });

  it("streams text deltas and final merged usage", async () => {
    const events = await collect([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      {
        type: "message_end",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
        },
        stopReason: "end_turn",
      },
    ]);
    expect(anthropicMocks.mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-test",
        max_tokens: 123,
        system: "system prompt",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: "done",
                is_error: true,
              },
            ],
          },
        ],
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object" },
          },
        ],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("streams tool use blocks with parsed JSON input", async () => {
    const events = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool_1",
          name: "Read",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'path":"a.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 7 },
      },
    ]);

    expect(events).toEqual([
      { type: "tool_use_start", id: "tool_1", name: "Read" },
      {
        type: "tool_use_input_delta",
        id: "tool_1",
        partialJson: '{"file_',
      },
      {
        type: "tool_use_input_delta",
        id: "tool_1",
        partialJson: 'path":"a.ts"}',
      },
      { type: "tool_use_end", id: "tool_1", input: { file_path: "a.ts" } },
      {
        type: "message_end",
        usage: {
          inputTokens: 0,
          outputTokens: 7,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "tool_use",
      },
    ]);
  });

  it("falls back to the initial tool input when no JSON delta arrives", async () => {
    const events = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool_1",
          name: "Read",
          input: { file_path: "fallback.ts" },
        },
      },
      { type: "content_block_stop", index: 0 },
    ]);

    expect(events[1]).toEqual({
      type: "tool_use_end",
      id: "tool_1",
      input: { file_path: "fallback.ts" },
    });
  });

  it("keeps multiple tool use indexes independent", async () => {
    const events = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "a", name: "Read", input: {} },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "b", name: "Write", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"content":"x"}' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
    ]);

    expect(events).toEqual([
      { type: "tool_use_start", id: "a", name: "Read" },
      { type: "tool_use_start", id: "b", name: "Write" },
      {
        type: "tool_use_input_delta",
        id: "b",
        partialJson: '{"content":"x"}',
      },
      {
        type: "tool_use_input_delta",
        id: "a",
        partialJson: '{"file_path":"a"}',
      },
      { type: "tool_use_end", id: "a", input: { file_path: "a" } },
      { type: "tool_use_end", id: "b", input: { content: "x" } },
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
  });

  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["pause_turn", "other"],
  ] as const)("maps stop reason %s to %s", async (input, expected) => {
    const events = await collect([
      {
        type: "message_delta",
        delta: { stop_reason: input },
        usage: {},
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

  it("normalizes malformed and non-object JSON tool inputs to empty objects", async () => {
    const malformed = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "bad", name: "Read", input: [] },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
    const array = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "arr", name: "Read", input: [] },
      },
      { type: "content_block_stop", index: 0 },
    ]);

    expect(malformed).toContainEqual({
      type: "tool_use_end",
      id: "bad",
      input: {},
    });
    expect(array).toContainEqual({
      type: "tool_use_end",
      id: "arr",
      input: {},
    });
  });
});
