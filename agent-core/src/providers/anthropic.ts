import Anthropic from "@anthropic-ai/sdk";
import type { Anthropic as AnthropicTypes } from "@anthropic-ai/sdk";
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

type ToolUseState = {
  id: string;
  name: string;
  partialJson: string;
  input: JsonObject;
};

export function createAnthropic(options: {
  id: string;
  apiKey: string;
  model: string;
}): LLMProvider {
  return new AnthropicProvider(options.id, options.apiKey, options.model);
}

class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(id: string, apiKey: string, model: string) {
    this.id = id;
    this.model = model;
    this.client = new Anthropic({ apiKey });
  }

  async *stream(opts: {
    system: string;
    messages: NeutralMessage[];
    tools: NeutralToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<ProviderStreamEvent> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: opts.messages.map(toAnthropicMessage),
        tools: opts.tools.map(toAnthropicTool),
      },
      { signal: opts.signal },
    );

    const toolUses = new Map<number, ToolUseState>();
    let usage: NeutralUsage = { ...ZERO_USAGE };
    let stopReason: ProviderStopReason = "end_turn";

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          usage = fromAnthropicUsage(event.message.usage);
          if (event.message.stop_reason) {
            stopReason = mapStopReason(event.message.stop_reason);
          }
          break;
        case "message_delta":
          usage = mergeAnthropicDeltaUsage(usage, event.usage);
          if (event.delta.stop_reason) {
            stopReason = mapStopReason(event.delta.stop_reason);
          }
          break;
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            const input = normalizeJsonObject(event.content_block.input);
            toolUses.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              partialJson: "",
              input,
            });
            yield {
              type: "tool_use_start",
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const toolUse = toolUses.get(event.index);
            if (toolUse) {
              toolUse.partialJson += event.delta.partial_json;
              yield {
                type: "tool_use_input_delta",
                id: toolUse.id,
                partialJson: event.delta.partial_json,
              };
            }
          }
          break;
        case "content_block_stop": {
          const toolUse = toolUses.get(event.index);
          if (toolUse) {
            yield {
              type: "tool_use_end",
              id: toolUse.id,
              input:
                toolUse.partialJson.length > 0
                  ? parseJsonObject(toolUse.partialJson)
                  : toolUse.input,
            };
            toolUses.delete(event.index);
          }
          break;
        }
        case "message_stop":
          break;
      }
    }

    yield { type: "message_end", usage, stopReason };
  }
}

function toAnthropicMessage(
  message: NeutralMessage,
): AnthropicTypes.MessageParam {
  return {
    role: message.role,
    content: message.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(
  block: NeutralContentBlock,
): AnthropicTypes.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError === true,
      };
  }
}

function toAnthropicTool(
  tool: NeutralToolDefinition,
): AnthropicTypes.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as AnthropicTypes.Tool.InputSchema,
  };
}

function fromAnthropicUsage(usage: AnthropicTypes.Usage): NeutralUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function mergeAnthropicDeltaUsage(
  current: NeutralUsage,
  usage: AnthropicTypes.MessageDeltaUsage,
): NeutralUsage {
  return {
    inputTokens: usage.input_tokens ?? current.inputTokens,
    outputTokens: usage.output_tokens ?? current.outputTokens,
    cacheCreationInputTokens:
      usage.cache_creation_input_tokens ?? current.cacheCreationInputTokens,
    cacheReadInputTokens:
      usage.cache_read_input_tokens ?? current.cacheReadInputTokens,
  };
}

function mapStopReason(
  stopReason: AnthropicTypes.StopReason,
): ProviderStopReason {
  switch (stopReason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
      return stopReason;
    default:
      return "other";
  }
}

function parseJsonObject(value: string): JsonObject {
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
