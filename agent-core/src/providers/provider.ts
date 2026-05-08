import type {
  NeutralMessage,
  NeutralToolDefinition,
  ProviderStreamEvent,
} from "./types.js";

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  stream(opts: {
    system: string;
    messages: NeutralMessage[];
    tools: NeutralToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<ProviderStreamEvent>;
}
