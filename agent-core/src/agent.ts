import { buildAgentContext } from "./context.js";
import { decidePermission, isToolConcurrencySafe } from "./permissions.js";
import type { LLMProvider } from "./providers/provider.js";
import { resolveProvider } from "./providers/registry.js";
import type {
  NeutralContentBlock,
  NeutralMessage,
  NeutralToolDefinition,
  NeutralUsage,
  ProviderStopReason,
} from "./providers/types.js";
import { ZERO_USAGE } from "./providers/types.js";
import {
  createSessionId,
  FileSystemSessionStorage,
  type SessionStorageBackend,
} from "./sessionStorage.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { LocalRuntime } from "./runtime/local.js";
import type { Runtime } from "./runtime/types.js";
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
import { LocalWorkspace } from "./workspace/local.js";
import type { Workspace } from "./workspace/types.js";

type ToolUseBlock = Extract<NeutralContentBlock, { type: "tool_use" }>;

const DEFAULT_MODEL = "claude-sonnet-4-6";

export class AgentCore {
  private provider: LLMProvider;
  private readonly tools: AgentTool[];
  private readonly state: AgentState;
  private readonly abortController: AbortController;
  private readonly workspace: Workspace;
  private readonly runtime: Runtime;
  private readonly sessionStorage: SessionStorageBackend;
  private messages: NeutralMessage[] = [];
  private contextInjected: boolean;
  private transcriptStarted = false;
  private sessionId: string;
  private model: string;
  private cwd: string;
  private maxTurns: number;
  private maxTokens: number;
  private options: AgentOptions;

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.cwd = options.cwd ?? process.cwd();
    this.workspace = options.workspace ?? new LocalWorkspace({ cwd: this.cwd });
    this.cwd = this.workspace.cwd;
    this.runtime = options.runtime ?? new LocalRuntime();
    this.sessionStorage =
      options.sessionStorage ?? new FileSystemSessionStorage({ cwd: this.cwd });
    this.model =
      options.model ??
      process.env.AGENT_CORE_MODEL ??
      process.env.ANTHROPIC_MODEL ??
      DEFAULT_MODEL;
    this.provider = resolveProvider(this.model, { apiKey: options.apiKey });
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

  getMessages(): NeutralMessage[] {
    return structuredClone(this.messages);
  }

  clearHistory(): void {
    this.messages = [];
    this.contextInjected = false;
    this.transcriptStarted = false;
    this.sessionId = createSessionId();
  }

  setModel(model: string): void {
    const provider = resolveProvider(model, { apiKey: this.options.apiKey });
    this.model = model;
    this.provider = provider;
  }

  getUsage(): AgentState["usage"] {
    return { ...this.state.usage };
  }

  getSessionInfo(): { sessionId: string; path: string; persisted: boolean } {
    return {
      sessionId: this.sessionId,
      path: this.sessionStorage.getSessionPath?.(this.sessionId) ?? "",
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
      workspace: this.workspace,
      additionalInstructionDirs: this.options.additionalInstructionDirs,
    });
    const system = await buildSystemPrompt({
      cwd: this.cwd,
      model: this.model,
      providerId: this.provider.id,
      runtime: this.runtime,
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

    const userMessage: NeutralMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
    };
    this.messages.push(userMessage);
    await this.recordMessage(userMessage);

    let finalText = "";

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      this.emit({ type: "request", turn, model: this.model });
      const assistantMessage = await this.collectAssistantMessage(
        system,
        signal,
      );

      this.accumulateUsage(assistantMessage.usage);
      await this.recordUsage();
      this.emit({ type: "assistant_message", message: assistantMessage.message });
      this.emit({ type: "usage", usage: this.getUsage() });
      this.messages.push(assistantMessage.message);
      await this.recordMessage(assistantMessage.message);

      if (assistantMessage.text) {
        finalText += assistantMessage.text;
        this.emit({ type: "assistant_text", text: assistantMessage.text });
      }

      const toolUses = assistantMessage.message.content.filter(isToolUseBlock);
      if (toolUses.length === 0) {
        return {
          text: finalText,
          sessionId: this.sessionId,
          messages: this.getMessages(),
          usage: this.getUsage(),
          stoppedBy: stopReasonToRunResult(assistantMessage.stopReason),
        };
      }

      const toolResults = await this.executeToolUses(toolUses, signal);
      const toolResultMessage: NeutralMessage = {
        role: "user",
        content: toolResults.map(({ id, result }) => ({
          type: "tool_result",
          toolUseId: id,
          content: result.content,
          isError: result.isError === true,
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
      workspace: this.workspace,
      runtime: this.runtime,
      abortSignal: signal,
      state: this.state,
      askUser: this.options.askUser,
      runSubagent: async (subPrompt, description) => {
        const subagent = new AgentCore({
          ...this.options,
          cwd: this.cwd,
          workspace: this.workspace,
          runtime: this.runtime,
          sessionStorage: this.sessionStorage,
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

  private async collectAssistantMessage(
    system: string,
    signal: AbortSignal,
  ): Promise<{
    message: NeutralMessage;
    text: string;
    usage: NeutralUsage;
    stopReason: ProviderStopReason;
  }> {
    const content: NeutralContentBlock[] = [];
    const toolUseBlocks = new Map<string, ToolUseBlock>();
    let text = "";
    let usage: NeutralUsage = { ...ZERO_USAGE };
    let stopReason: ProviderStopReason = "end_turn";

    for await (const event of this.provider.stream({
      system,
      messages: this.messages,
      tools: this.getNeutralTools(),
      maxTokens: this.maxTokens,
      signal,
    })) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          appendTextDelta(content, event.text);
          this.emit({ type: "text_delta", text: event.text });
          break;
        case "tool_use_start": {
          const block: ToolUseBlock = {
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: {},
          };
          content.push(block);
          toolUseBlocks.set(event.id, block);
          this.emit({
            type: "tool_use_delta",
            id: event.id,
            name: event.name,
          });
          break;
        }
        case "tool_use_input_delta":
          this.emit({
            type: "tool_use_delta",
            id: event.id,
            partialJson: event.partialJson,
          });
          break;
        case "tool_use_end": {
          const block = toolUseBlocks.get(event.id);
          if (block) {
            block.input = event.input;
          } else {
            content.push({
              type: "tool_use",
              id: event.id,
              name: "tool",
              input: event.input,
            });
          }
          this.emit({
            type: "tool_use_delta",
            id: event.id,
            input: event.input,
            done: true,
          });
          break;
        }
        case "message_end":
          usage = event.usage;
          stopReason = event.stopReason;
          break;
      }
    }

    return {
      message: {
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
      },
      text,
      usage,
      stopReason,
    };
  }

  private getNeutralTools(): NeutralToolDefinition[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private accumulateUsage(usage: NeutralUsage): void {
    this.state.usage.inputTokens += usage.inputTokens;
    this.state.usage.outputTokens += usage.outputTokens;
    this.state.usage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    this.state.usage.cacheReadInputTokens += usage.cacheReadInputTokens;
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }

  private shouldPersist(): boolean {
    return this.options.persistSession !== false;
  }

  private async ensureTranscriptStarted(): Promise<void> {
    if (this.transcriptStarted || !this.shouldPersist()) return;
    await this.sessionStorage.initSession({
      cwd: this.cwd,
      model: this.model,
      sessionId: this.sessionId,
    });
    this.transcriptStarted = true;
  }

  private async recordMessage(message: NeutralMessage): Promise<void> {
    if (!this.shouldPersist()) return;
    await this.ensureTranscriptStarted();
    await this.sessionStorage.appendEntry(this.sessionId, {
      type: "message",
      at: new Date().toISOString(),
      message,
    });
  }

  private async recordUsage(): Promise<void> {
    if (!this.shouldPersist()) return;
    await this.ensureTranscriptStarted();
    await this.sessionStorage.appendEntry(this.sessionId, {
      type: "usage",
      at: new Date().toISOString(),
      usage: this.getUsage(),
    });
  }
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

function appendTextDelta(content: NeutralContentBlock[], text: string): void {
  const last = content.at(-1);
  if (last?.type === "text") {
    last.text += text;
  } else {
    content.push({ type: "text", text });
  }
}

function stopReasonToRunResult(
  stopReason: ProviderStopReason,
): AgentRunResult["stoppedBy"] {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
      return stopReason;
    case "tool_use":
      return "other";
    case "other":
      return "other";
  }
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
