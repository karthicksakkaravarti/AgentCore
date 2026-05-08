import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LLMProvider } from "./provider.js";
import type {
  JsonObject,
  NeutralContentBlock,
  NeutralMessage,
  NeutralToolDefinition,
  NeutralUsage,
  ProviderStopReason,
  ProviderStreamEvent,
} from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { stringifyForToolResult } from "../utils/json.js";

type ToolCallState = {
  id: string;
  name: string;
  argumentsJson: string;
  started: boolean;
};

export function createOpenAI(options: {
  id: string;
  apiKey: string;
  model: string;
  baseURL?: string;
}): LLMProvider {
  return new OpenAIProvider(
    options.id,
    options.apiKey,
    options.model,
    options.baseURL,
  );
}

class OpenAIProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(id: string, apiKey: string, model: string, baseURL?: string) {
    this.id = id;
    this.model = model;
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async *stream(opts: {
    system: string;
    messages: NeutralMessage[];
    tools: NeutralToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<ProviderStreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: opts.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: opts.system },
          ...toOpenAIMessages(opts.messages),
        ],
        tools: opts.tools.length > 0 ? opts.tools.map(toOpenAITool) : undefined,
      },
      { signal: opts.signal },
    );

    const toolCalls = new Map<number, ToolCallState>();
    let usage: NeutralUsage = { ...ZERO_USAGE };
    let stopReason: ProviderStopReason = "end_turn";

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = fromOpenAIUsage(chunk.usage);
      }

      for (const choice of chunk.choices) {
        if (choice.delta.content) {
          yield { type: "text_delta", text: choice.delta.content };
        }
        for (const toolCallDelta of choice.delta.tool_calls ?? []) {
          const state = getToolCallState(toolCalls, toolCallDelta);
          if (toolCallDelta.id) state.id = toolCallDelta.id;
          if (toolCallDelta.function?.name) {
            state.name = toolCallDelta.function.name;
          }
          if (!state.started && state.name) {
            state.started = true;
            yield { type: "tool_use_start", id: state.id, name: state.name };
          }
          if (toolCallDelta.function?.arguments) {
            state.argumentsJson += toolCallDelta.function.arguments;
            yield {
              type: "tool_use_input_delta",
              id: state.id,
              partialJson: toolCallDelta.function.arguments,
            };
          }
        }
        if (choice.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason);
        }
      }
    }

    for (const state of toolCalls.values()) {
      if (!state.started) {
        yield { type: "tool_use_start", id: state.id, name: state.name };
      }
      yield {
        type: "tool_use_end",
        id: state.id,
        input: parseJsonObject(state.argumentsJson),
      };
    }

    yield { type: "message_end", usage, stopReason };
  }
}

function toOpenAIMessages(
  messages: NeutralMessage[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    const text = message.content
      .filter((block): block is Extract<NeutralContentBlock, { type: "text" }> =>
        block.type === "text",
      )
      .map((block) => block.text)
      .join("");

    const toolUses = message.content.filter(
      (block): block is Extract<NeutralContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    const toolResults = message.content.filter(
      (block): block is Extract<NeutralContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result",
    );

    if (message.role === "assistant") {
      const assistantMessage: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text || null,
      };
      if (toolUses.length > 0) {
        assistantMessage.tool_calls = toolUses.map((toolUse) => ({
          id: toolUse.id,
          type: "function",
          function: {
            name: toolUse.name,
            arguments: stringifyForToolResult(toolUse.input),
          },
        }));
      }
      result.push(assistantMessage);
      continue;
    }

    if (text) {
      result.push({ role: "user", content: text });
    }
    for (const toolResult of toolResults) {
      result.push({
        role: "tool",
        tool_call_id: toolResult.toolUseId,
        content: toolResult.content,
      });
    }
  }

  return result;
}

function toOpenAITool(tool: NeutralToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function getToolCallState(
  toolCalls: Map<number, ToolCallState>,
  delta: NonNullable<
    ChatCompletionChunk.Choice.Delta["tool_calls"]
  >[number],
): ToolCallState {
  const existing = toolCalls.get(delta.index);
  if (existing) return existing;
  const state: ToolCallState = {
    id: delta.id ?? `tool_call_${delta.index}`,
    name: delta.function?.name ?? `tool_${delta.index}`,
    argumentsJson: "",
    started: false,
  };
  toolCalls.set(delta.index, state);
  return state;
}

function fromOpenAIUsage(
  usage: NonNullable<ChatCompletionChunk["usage"]>,
): NeutralUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function mapFinishReason(
  finishReason: ChatCompletionChunk.Choice["finish_reason"],
): ProviderStopReason {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}

function parseJsonObject(value: string): JsonObject {
  if (!value.trim()) return {};
  try {
    return normalizeJsonObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function normalizeJsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
