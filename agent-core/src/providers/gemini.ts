import {
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Tool,
} from "@google/genai";
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

export function createGemini(options: {
  id: string;
  apiKey: string;
  model: string;
}): LLMProvider {
  return new GeminiProvider(options.id, options.apiKey, options.model);
}

class GeminiProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(id: string, apiKey: string, model: string) {
    this.id = id;
    this.model = model;
    this.client = new GoogleGenAI({ apiKey });
  }

  async *stream(opts: {
    system: string;
    messages: NeutralMessage[];
    tools: NeutralToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<ProviderStreamEvent> {
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: toGeminiContents(opts.messages),
      config: {
        abortSignal: opts.signal,
        maxOutputTokens: opts.maxTokens,
        systemInstruction: opts.system,
        tools: opts.tools.length > 0 ? [toGeminiTool(opts.tools)] : undefined,
        toolConfig:
          opts.tools.length > 0
            ? {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.AUTO,
                },
              }
            : undefined,
      },
    });

    let usage: NeutralUsage = { ...ZERO_USAGE };
    let stopReason: ProviderStopReason = "end_turn";
    let sawToolUse = false;
    let syntheticToolCallId = 0;

    for await (const chunk of stream) {
      if (chunk.usageMetadata) {
        usage = fromGeminiUsage(chunk.usageMetadata);
      }

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) {
        stopReason = mapFinishReason(candidate.finishReason);
      }

      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          yield { type: "text_delta", text: part.text };
        }
        if (part.functionCall) {
          sawToolUse = true;
          const id =
            part.functionCall.id ?? `gemini_tool_call_${syntheticToolCallId++}`;
          const name = part.functionCall.name ?? "function";
          const input = normalizeJsonObject(part.functionCall.args);
          yield { type: "tool_use_start", id, name };
          yield {
            type: "tool_use_input_delta",
            id,
            partialJson: stringifyForToolResult(input),
          };
          yield { type: "tool_use_end", id, input };
        }
      }
    }

    yield {
      type: "message_end",
      usage,
      stopReason: sawToolUse ? "tool_use" : stopReason,
    };
  }
}

function toGeminiContents(messages: NeutralMessage[]): Content[] {
  const toolNamesById = new Map<string, string>();
  return messages.map((message) => {
    const parts: Part[] = [];
    for (const block of message.content) {
      const part = toGeminiPart(block, toolNamesById);
      if (part) parts.push(part);
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts,
    };
  });
}

function toGeminiPart(
  block: NeutralContentBlock,
  toolNamesById: Map<string, string>,
): Part | null {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "tool_use":
      toolNamesById.set(block.id, block.name);
      return {
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.input,
        } satisfies FunctionCall,
      };
    case "tool_result":
      return {
        functionResponse: {
          id: block.toolUseId,
          name: toolNamesById.get(block.toolUseId) ?? "tool_result",
          response: block.isError
            ? { error: block.content }
            : { output: block.content },
        },
      };
  }
}

function toGeminiTool(tools: NeutralToolDefinition[]): Tool {
  return {
    functionDeclarations: tools.map(
      (tool): FunctionDeclaration => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      }),
    ),
  };
}

function fromGeminiUsage(
  usage: GenerateContentResponseUsageMetadata,
): NeutralUsage {
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function mapFinishReason(finishReason: FinishReason): ProviderStopReason {
  switch (finishReason) {
    case FinishReason.STOP:
      return "end_turn";
    case FinishReason.MAX_TOKENS:
      return "max_tokens";
    default:
      return "other";
  }
}

function normalizeJsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
