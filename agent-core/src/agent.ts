import Anthropic from "@anthropic-ai/sdk";
import type { Anthropic as AnthropicTypes } from "@anthropic-ai/sdk";
import { buildAgentContext } from "./context.js";
import { decidePermission, isToolConcurrencySafe } from "./permissions.js";
import {
  createSessionId,
  getSessionPath,
  initializeTranscript,
  recordMessage,
  recordUsage,
} from "./sessionStorage.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import type {
  AgentEvent,
  AgentOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentState,
  AgentTool,
  JsonObject,
  ToolExecutionContext,
  ToolResult,
} from "./types.js";
import { filterTools, findTool, defaultTools } from "./tools/registry.js";
import { stringifyForToolResult } from "./utils/json.js";

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type TextBlock = {
  type: "text";
  text: string;
};

const DEFAULT_MODEL = "claude-sonnet-4-6";

export class AgentCore {
  private readonly client: Anthropic;
  private readonly tools: AgentTool[];
  private readonly state: AgentState;
  private readonly abortController: AbortController;
  private messages: AnthropicTypes.MessageParam[] = [];
  private contextInjected: boolean;
  private transcriptStarted = false;
  private sessionId: string;
  private model: string;
  private cwd: string;
  private maxTurns: number;
  private maxTokens: number;
  private options: AgentOptions;

  constructor(options: AgentOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey.",
      );
    }

    this.options = options;
    this.client = new Anthropic({ apiKey });
    this.cwd = options.cwd ?? process.cwd();
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    this.sessionId = options.sessionId ?? createSessionId();
    this.maxTurns = options.maxTurns ?? 20;
    this.maxTokens = options.maxTokens ?? 4096;
    this.abortController = options.abortController ?? new AbortController();
    this.messages = structuredClone(options.initialMessages ?? []);
    this.contextInjected = this.messages.length > 0;
    this.tools = filterTools(defaultTools(), {
      allowedTools: options.allowedTools,
      disabledTools: options.disabledTools,
    });
    this.state = {
      todos: [],
      backgroundShells: new Map(),
      alwaysAllowedTools: new Set(),
      alwaysDeniedTools: new Set(),
      readFiles: new Set(),
      usage: {
        inputTokens: options.initialUsage?.inputTokens ?? 0,
        outputTokens: options.initialUsage?.outputTokens ?? 0,
        cacheCreationInputTokens:
          options.initialUsage?.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: options.initialUsage?.cacheReadInputTokens ?? 0,
      },
    };
  }

  listTools(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  getMessages(): AnthropicTypes.MessageParam[] {
    return structuredClone(this.messages);
  }

  clearHistory(): void {
    this.messages = [];
    this.contextInjected = false;
    this.transcriptStarted = false;
    this.sessionId = createSessionId();
  }

  setModel(model: string): void {
    this.model = model;
  }

  getUsage(): AgentState["usage"] {
    return { ...this.state.usage };
  }

  getSessionInfo(): { sessionId: string; path: string; persisted: boolean } {
    return {
      sessionId: this.sessionId,
      path: getSessionPath(this.cwd, this.sessionId),
      persisted: this.shouldPersist(),
    };
  }

  async run(
    prompt: string,
    runOptions: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const signal = runOptions.signal ?? this.abortController.signal;
    const maxTurns = runOptions.maxTurns ?? this.maxTurns;
    const context = await buildAgentContext({
      cwd: this.cwd,
      additionalInstructionDirs: this.options.additionalInstructionDirs,
    });
    const system = await buildSystemPrompt({
      cwd: this.cwd,
      model: this.model,
      customSystemPrompt: this.options.customSystemPrompt,
      appendSystemPrompt: this.options.appendSystemPrompt,
      projectInstructions: context.projectInstructions,
    });

    await this.ensureTranscriptStarted();
    if (!this.contextInjected && context.attachmentMessages.length > 0) {
      for (const attachment of context.attachmentMessages) {
        this.messages.push(attachment);
        await this.recordMessage(attachment);
      }
      this.contextInjected = true;
    }

    const userMessage: AnthropicTypes.MessageParam = {
      role: "user",
      content: prompt,
    };
    this.messages.push(userMessage);
    await this.recordMessage(userMessage);

    let finalText = "";

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      this.emit({ type: "request", turn, model: this.model });
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system,
          messages: this.messages,
          tools: this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        },
        { signal },
      );

      this.accumulateUsage(response.usage);
      await this.recordUsage();
      this.emit({ type: "assistant_message", message: response });
      this.emit({ type: "usage", usage: this.getUsage() });
      const assistantMessage: AnthropicTypes.MessageParam = {
        role: "assistant",
        content: response.content as AnthropicTypes.MessageParam["content"],
      };
      this.messages.push(assistantMessage);
      await this.recordMessage(assistantMessage);

      const contentBlocks = response.content as unknown[];
      const textBlocks = contentBlocks.filter(isTextBlock);
      for (const block of textBlocks) {
        finalText += block.text;
        this.emit({ type: "assistant_text", text: block.text });
      }

      const toolUses = contentBlocks.filter(isToolUseBlock);
      if (toolUses.length === 0) {
        return {
          text: finalText,
          sessionId: this.sessionId,
          messages: this.getMessages(),
          usage: this.getUsage(),
          stoppedBy: "end_turn",
        };
      }

      const toolResults = await this.executeToolUses(toolUses, signal);
      const toolResultMessage: AnthropicTypes.MessageParam = {
        role: "user",
        content: toolResults.map(({ id, result }) => ({
          type: "tool_result",
          tool_use_id: id,
          content: result.content,
          is_error: result.isError === true,
        })),
      };
      this.messages.push(toolResultMessage);
      await this.recordMessage(toolResultMessage);
    }

    return {
      text: finalText,
      sessionId: this.sessionId,
      messages: this.getMessages(),
      usage: this.getUsage(),
      stoppedBy: "max_turns",
    };
  }

  private async executeToolUses(
    toolUses: ToolUseBlock[],
    signal: AbortSignal,
  ): Promise<Array<{ id: string; result: ToolResult }>> {
    const results: Array<{ id: string; result: ToolResult }> = [];
    for (const batch of partitionToolUses(toolUses, this.tools)) {
      if (batch.concurrent) {
        const batchResults = await Promise.all(
          batch.items.map((toolUse) => this.executeOneToolUse(toolUse, signal)),
        );
        results.push(...batchResults);
      } else {
        for (const toolUse of batch.items) {
          results.push(await this.executeOneToolUse(toolUse, signal));
        }
      }
    }
    return results;
  }

  private async executeOneToolUse(
    toolUse: ToolUseBlock,
    signal: AbortSignal,
  ): Promise<{ id: string; result: ToolResult }> {
    const tool = findTool(this.tools, toolUse.name);
    const input = normalizeInput(toolUse.input);

    if (!tool) {
      return {
        id: toolUse.id,
        result: {
          content: `Unknown tool: ${toolUse.name}`,
          isError: true,
        },
      };
    }

    this.emit({ type: "tool_start", id: toolUse.id, name: tool.name, input });

    const context = this.createToolContext(signal);
    const permission = await decidePermission(tool, input, context, {
      mode: this.options.permissionMode ?? "default",
      prompt: this.options.permissionPrompt,
    });
    if (permission.behavior === "deny") {
      const result = {
        content: permission.message,
        isError: true,
      };
      this.emit({ type: "tool_result", id: toolUse.id, name: tool.name, result });
      return { id: toolUse.id, result };
    }

    try {
      const result = await tool.execute(input, context);
      this.emit({ type: "tool_result", id: toolUse.id, name: tool.name, result });
      return { id: toolUse.id, result };
    } catch (error) {
      const result = {
        content: stringifyForToolResult({
          error: error instanceof Error ? error.message : String(error),
        }),
        isError: true,
      };
      this.emit({ type: "tool_result", id: toolUse.id, name: tool.name, result });
      return { id: toolUse.id, result };
    }
  }

  private createToolContext(signal: AbortSignal): ToolExecutionContext {
    return {
      cwd: this.cwd,
      abortSignal: signal,
      state: this.state,
      askUser: this.options.askUser,
      runSubagent: async (subPrompt, description) => {
        const subagent = new AgentCore({
          ...this.options,
          cwd: this.cwd,
          model: this.model,
          maxTurns: Math.min(8, this.maxTurns),
          persistSession: false,
          sessionId: undefined,
          initialMessages: [],
          initialUsage: undefined,
          disabledTools: [...(this.options.disabledTools ?? []), "Agent"],
          appendSystemPrompt: [
            this.options.appendSystemPrompt,
            description
              ? `You are running as a focused subagent for: ${description}. Return a concise final report to the parent agent.`
              : "You are running as a focused subagent. Return a concise final report to the parent agent.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        const result = await subagent.run(subPrompt, { maxTurns: 8, signal });
        const usage = subagent.getUsage();
        this.state.usage.inputTokens += usage.inputTokens;
        this.state.usage.outputTokens += usage.outputTokens;
        this.state.usage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
        this.state.usage.cacheReadInputTokens += usage.cacheReadInputTokens;
        return result.text || `Subagent stopped by ${result.stoppedBy}.`;
      },
    };
  }

  private accumulateUsage(usage: AnthropicTypes.Usage): void {
    this.state.usage.inputTokens += usage.input_tokens ?? 0;
    this.state.usage.outputTokens += usage.output_tokens ?? 0;
    this.state.usage.cacheCreationInputTokens +=
      usage.cache_creation_input_tokens ?? 0;
    this.state.usage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }

  private shouldPersist(): boolean {
    return this.options.persistSession !== false;
  }

  private async ensureTranscriptStarted(): Promise<void> {
    if (this.transcriptStarted || !this.shouldPersist()) return;
    await initializeTranscript({
      cwd: this.cwd,
      model: this.model,
      sessionId: this.sessionId,
    });
    this.transcriptStarted = true;
  }

  private async recordMessage(message: AnthropicTypes.MessageParam): Promise<void> {
    if (!this.shouldPersist()) return;
    await this.ensureTranscriptStarted();
    await recordMessage(this.cwd, this.sessionId, message);
  }

  private async recordUsage(): Promise<void> {
    if (!this.shouldPersist()) return;
    await this.ensureTranscriptStarted();
    await recordUsage(this.cwd, this.sessionId, this.getUsage());
  }
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "tool_use" &&
    typeof (block as { id?: unknown }).id === "string" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

function normalizeInput(input: unknown): JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as JsonObject)
    : {};
}

function partitionToolUses(
  toolUses: ToolUseBlock[],
  tools: AgentTool[],
): Array<{ concurrent: boolean; items: ToolUseBlock[] }> {
  const batches: Array<{ concurrent: boolean; items: ToolUseBlock[] }> = [];
  for (const toolUse of toolUses) {
    const tool = findTool(tools, toolUse.name);
    const input = normalizeInput(toolUse.input);
    const concurrent = tool ? isToolConcurrencySafe(tool, input) : false;
    const previous = batches.at(-1);
    if (concurrent && previous?.concurrent) {
      previous.items.push(toolUse);
    } else {
      batches.push({ concurrent, items: [toolUse] });
    }
  }
  return batches;
}
