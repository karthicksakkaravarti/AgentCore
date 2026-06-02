import type {
  JsonObject,
  NeutralMessage,
  NeutralUsage,
} from "./providers/types.js";
import type { Runtime } from "./runtime/types.js";
import type { SessionStorageBackend } from "./sessionStorage.js";
import type { Workspace } from "./workspace/types.js";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type ToolExecutionContext = {
  cwd: string;
  workspace: Workspace;
  runtime: Runtime;
  abortSignal: AbortSignal;
  state: AgentState;
  askUser?: (question: string) => Promise<string>;
  runSubagent?: (prompt: string, description?: string) => Promise<string>;
};

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
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
  workspace?: Workspace;
  runtime?: Runtime;
  sessionStorage?: SessionStorageBackend;
  sessionId?: string;
  initialMessages?: NeutralMessage[];
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
  additionalTools?: AgentTool[];
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
  usage: NeutralUsage;
};

export type AgentEvent =
  | { type: "request"; turn: number; model: string }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_use_delta";
      id: string;
      name?: string;
      partialJson?: string;
      input?: JsonObject;
      done?: boolean;
    }
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
      message: NeutralMessage;
    }
  | {
      type: "usage";
      usage: AgentState["usage"];
    };

export type AgentRunResult = {
  text: string;
  sessionId: string;
  messages: NeutralMessage[];
  usage: AgentState["usage"];
  stoppedBy: "end_turn" | "max_turns" | "max_tokens" | "error" | "other";
};

export type {
  JsonObject,
  NeutralContentBlock,
  NeutralMessage,
  NeutralRole,
  NeutralToolDefinition,
  NeutralUsage,
  ProviderStopReason,
  ProviderStreamEvent,
} from "./providers/types.js";
