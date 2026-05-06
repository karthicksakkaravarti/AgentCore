import type { Anthropic } from "@anthropic-ai/sdk";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type JsonObject = Record<string, unknown>;

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type ToolExecutionContext = {
  cwd: string;
  abortSignal: AbortSignal;
  state: AgentState;
  askUser?: (question: string) => Promise<string>;
  runSubagent?: (prompt: string, description?: string) => Promise<string>;
};

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  readOnly: boolean | ((input: JsonObject) => boolean);
  destructive?: boolean | ((input: JsonObject) => boolean);
  concurrencySafe?: boolean | ((input: JsonObject) => boolean);
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolResult>;
};

export type PermissionDecision =
  | { behavior: "allow"; remember?: boolean }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type PermissionPrompt = (
  tool: AgentTool,
  input: JsonObject,
  options: {
    reason: string;
    signal: AbortSignal;
  },
) => Promise<PermissionDecision>;

export type AgentOptions = {
  apiKey?: string;
  model?: string;
  cwd?: string;
  sessionId?: string;
  initialMessages?: Anthropic.MessageParam[];
  initialUsage?: AgentState["usage"];
  persistSession?: boolean;
  additionalInstructionDirs?: string[];
  maxTurns?: number;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  permissionPrompt?: PermissionPrompt;
  askUser?: (question: string) => Promise<string>;
  onEvent?: (event: AgentEvent) => void;
  disabledTools?: string[];
  allowedTools?: string[];
  abortController?: AbortController;
};

export type AgentRunOptions = {
  maxTurns?: number;
  signal?: AbortSignal;
};

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

export type BackgroundShell = {
  id: string;
  command: string;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
  readCursor: number;
  kill(signal?: NodeJS.Signals): void;
};

export type AgentState = {
  todos: TodoItem[];
  backgroundShells: Map<string, BackgroundShell>;
  alwaysAllowedTools: Set<string>;
  alwaysDeniedTools: Set<string>;
  readFiles: Set<string>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
};

export type AgentEvent =
  | { type: "request"; turn: number; model: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "tool_start";
      id: string;
      name: string;
      input: JsonObject;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      result: ToolResult;
    }
  | {
      type: "assistant_message";
      message: Anthropic.Message;
    }
  | {
      type: "usage";
      usage: AgentState["usage"];
    };

export type AgentRunResult = {
  text: string;
  sessionId: string;
  messages: Anthropic.MessageParam[];
  usage: AgentState["usage"];
  stoppedBy: "end_turn" | "max_turns" | "error";
};
