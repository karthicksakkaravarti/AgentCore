export type JsonObject = Record<string, unknown>;

export type NeutralRole = "user" | "assistant";

export type NeutralContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export type NeutralMessage = {
  role: NeutralRole;
  content: NeutralContentBlock[];
};

export type NeutralToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

export type NeutralUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type ProviderStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "other";

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partialJson: string }
  | { type: "tool_use_end"; id: string; input: JsonObject }
  | {
      type: "message_end";
      usage: NeutralUsage;
      stopReason: ProviderStopReason;
    };

export const ZERO_USAGE: NeutralUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};
