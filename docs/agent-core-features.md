# agent-core Feature Reference

> Phase 1 + Phase 2 clone of Claude Code — a standalone TypeScript agent library.

**Package:** `@agent-core/core` · `agent-core/` · ESM (`"type": "module"`)
**Node:** ≥ 20 · **Build:** `npm run build` · **Test:** `npm test`

---

## Table of Contents

1. [AgentCore Class](#1-agentcore-class)
2. [Event Streaming](#2-event-streaming)
3. [Permission System](#3-permission-system)
4. [Built-in Tools](#4-built-in-tools)
5. [Provider Support](#5-provider-support)
6. [Session Storage](#6-session-storage)
7. [Workspace Abstraction](#7-workspace-abstraction)
8. [Runtime Abstraction](#8-runtime-abstraction)
9. [Context & CLAUDE.md Discovery](#9-context--claudemd-discovery)
10. [System Prompt Builder](#10-system-prompt-builder)
11. [Environment Variables Reference](#11-environment-variables-reference)

---

## 1. AgentCore Class

The main entry point. Instantiate once per conversation thread; call `run()` for each user turn.

```ts
import { AgentCore } from "@agent-core/core";

const agent = new AgentCore({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-6",
});

const result = await agent.run("List all TypeScript files in src/");
console.log(result.text);
```

### Constructor — `AgentOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | env var | API key for the resolved provider |
| `model` | `string` | `"claude-sonnet-4-6"` | Model string, optionally prefixed: `"openai/gpt-4o"` |
| `cwd` | `string` | `process.cwd()` | Working directory for tool execution and CLAUDE.md discovery |
| `workspace` | `Workspace` | `LocalWorkspace` | Filesystem abstraction (local, memory, Supabase) |
| `runtime` | `Runtime` | `LocalRuntime` | Shell execution backend (local or disabled) |
| `sessionStorage` | `SessionStorageBackend` | `FileSystemSessionStorage` | Where to persist transcripts |
| `sessionId` | `string` | auto UUID | Pre-set session ID (use when resuming a prior session) |
| `initialMessages` | `NeutralMessage[]` | `[]` | Seed the message history (for session resume) |
| `initialUsage` | `NeutralUsage` | zeroes | Seed token counters (for session resume) |
| `persistSession` | `boolean` | `true` | Set `false` to skip writing to `sessionStorage` |
| `additionalInstructionDirs` | `string[]` | `[]` | Extra directories to scan for `CLAUDE.md` files |
| `maxTurns` | `number` | `20` | Maximum model + tool loop iterations per `run()` call |
| `maxTokens` | `number` | `4096` | Max output tokens requested per API call |
| `permissionMode` | `PermissionMode` | `"default"` | How tool permission decisions are made (see §3) |
| `customSystemPrompt` | `string` | — | Replaces the default system prompt entirely |
| `appendSystemPrompt` | `string` | — | Appended after the default system prompt |
| `permissionPrompt` | `PermissionPrompt` | — | Callback to ask a human for permission (see §3) |
| `askUser` | `(q: string) => Promise<string>` | — | Callback for `AskUserQuestion` tool |
| `onEvent` | `(event: AgentEvent) => void` | — | Receive streaming events (text deltas, tool updates, usage) |
| `allowedTools` | `string[]` | all tools | Allowlist — only these tools are registered |
| `disabledTools` | `string[]` | `[]` | Denylist — these tools are removed from the pool |
| `abortController` | `AbortController` | auto | Supply your own to cancel a `run()` externally |

### Public Methods

| Method | Signature | Returns | Description |
|---|---|---|---|
| `run` | `(prompt: string, opts?: AgentRunOptions)` | `Promise<AgentRunResult>` | Execute one user turn; runs the model + tool loop up to `maxTurns` |
| `listTools` | `()` | `string[]` | Names of all currently registered tools |
| `getMessages` | `()` | `NeutralMessage[]` | Deep copy of the full conversation history |
| `clearHistory` | `()` | `void` | Wipe message history and start a fresh session ID |
| `setModel` | `(model: string)` | `void` | Switch models mid-conversation (resolves a new provider instance) |
| `getUsage` | `()` | `NeutralUsage` | Accumulated token counts across all turns |
| `getSessionInfo` | `()` | `{ sessionId, path, persisted }` | Current session ID, transcript file path, and persistence flag |

### `AgentRunOptions`

```ts
type AgentRunOptions = {
  maxTurns?: number;    // Override constructor maxTurns for this run only
  signal?: AbortSignal; // Additional cancellation signal
};
```

### `AgentRunResult`

```ts
type AgentRunResult = {
  text: string;          // Final assistant text from the run
  sessionId: string;     // Session this run was saved under
  messages: NeutralMessage[]; // Complete history including this turn
  usage: NeutralUsage;   // Cumulative token usage
  stoppedBy: "end_turn" | "max_turns" | "max_tokens" | "error" | "other";
};
```

---

## 2. Event Streaming

Subscribe via `onEvent` to receive real-time progress during a `run()`.

```ts
const agent = new AgentCore({
  // ...
  onEvent(event) {
    switch (event.type) {
      case "text_delta":      process.stdout.write(event.text); break;
      case "tool_start":      console.log(`→ ${event.name}(${JSON.stringify(event.input)})`); break;
      case "tool_result":     console.log(`← ${event.name}: ${event.result.content.slice(0, 80)}`); break;
      case "usage":           console.log("tokens:", event.usage); break;
    }
  },
});
```

### Event Types

| Event type | When it fires | Key fields |
|---|---|---|
| `request` | Before each API call | `turn: number`, `model: string` |
| `text_delta` | Each streamed text chunk | `text: string` |
| `tool_use_delta` | Partial tool input JSON arriving | `id`, `name?`, `partialJson?`, `input?`, `done?` |
| `assistant_text` | Complete assistant text for one turn | `text: string` |
| `tool_start` | Tool is about to execute | `id`, `name`, `input: JsonObject` |
| `tool_result` | Tool has finished | `id`, `name`, `result: ToolResult` |
| `assistant_message` | Full assistant message assembled | `message: NeutralMessage` |
| `usage` | After each turn | `usage: NeutralUsage` |

### `NeutralUsage`

```ts
type NeutralUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};
```

---

## 3. Permission System

The permission system controls which tools the agent is allowed to run, and how approval is obtained.

### Permission Modes

| Mode | Behaviour |
|---|---|
| `"default"` | Read-only tools auto-allowed; mutations require a `permissionPrompt` callback (deny if none provided) |
| `"acceptEdits"` | Auto-allows `Edit`, `Write`, `TodoWrite` in addition to read-only tools; other mutations still prompt |
| `"bypassPermissions"` | All tools auto-allowed — no prompts ever |
| `"plan"` | Read-only tools allowed; all mutations denied; use with `ExitPlanMode` tool for plan-first workflows |

### `permissionPrompt` Callback

Implement this to show the user an approval UI when a tool needs permission:

```ts
const agent = new AgentCore({
  permissionMode: "default",
  permissionPrompt: async (tool, input, { reason, signal }) => {
    const answer = await askHuman(`Allow ${tool.name}? Reason: ${reason}`);
    if (answer === "always") return { behavior: "allow", remember: true };
    if (answer === "yes")    return { behavior: "allow" };
    if (answer === "never")  return { behavior: "deny", message: "denied", interrupt: true };
    return { behavior: "deny", message: "User denied." };
  },
});
```

**`PermissionDecision` shape:**

```ts
type PermissionDecision =
  | { behavior: "allow"; remember?: boolean }  // remember=true → add to alwaysAllowedTools
  | { behavior: "deny"; message: string; interrupt?: boolean }; // interrupt=true → add to alwaysDeniedTools
```

### Runtime Allow / Deny Lists

The `AgentState` object (accessible during a run via `ToolExecutionContext.state`) holds mutable sets:

- `state.alwaysAllowedTools` — tools always approved without prompting (populated by `remember: true`)
- `state.alwaysDeniedTools` — tools always blocked (populated by `interrupt: true`)

---

## 4. Built-in Tools

### Tool Registry

```ts
import { defaultTools, filterTools, findTool } from "@agent-core/core";

const tools = defaultTools();          // All 15 tools
const safe  = filterTools(tools, { allowedTools: ["Read", "Glob", "WebFetch"] });
const bash  = findTool(tools, "Bash"); // AgentTool | undefined
```

### All 15 Tools

| # | Name | Read-Only | Destructive | Concurrent | Description |
|---|---|---|---|---|---|
| 1 | **Agent** | no | no | yes | Spawn a focused subagent for an independent sub-task; returns a concise result |
| 2 | **Bash** | input-dependent* | input-dependent* | input-dependent* | Execute a shell command; supports background mode and timeout |
| 3 | **BashOutput** | yes | no | yes | Read buffered stdout/stderr from a running background shell |
| 4 | **KillShell** | no | yes | — | Send SIGTERM to a background shell |
| 5 | **Read** | yes | no | yes | Read a file with line numbers; supports offset/limit pagination |
| 6 | **Write** | no | yes | — | Write or overwrite a complete file |
| 7 | **Edit** | no | no | — | Replace exact text in a file; `replace_all` flag for global replace |
| 8 | **Glob** | yes | no | yes | Fast glob filename search, results sorted by mtime |
| 9 | **Grep** | yes | no | yes | Regex content search with context lines, count mode, and file-type filters |
| 10 | **TodoWrite** | no | no | — | Create/update the agent's in-memory task list |
| 11 | **NotebookEdit** | no | no | — | Replace, insert, or delete Jupyter notebook cells by cell ID |
| 12 | **WebFetch** | yes | no | yes | Fetch a URL, strip HTML, return readable text (50 KB cap) |
| 13 | **WebSearch** | yes | no | yes | DuckDuckGo search; returns titles, URLs, and snippets |
| 14 | **AskUserQuestion** | yes | no | no | Pause execution and ask the human a question via `askUser` callback |
| 15 | **ExitPlanMode** | yes | no | no | Record an implementation plan as tool output (used in `"plan"` mode) |

\* Bash `readOnly`/`destructive`/`concurrencySafe` are functions of the command string at runtime.

### Bash Read-Only Commands (auto-allowed in `"default"` mode)

Commands that start with: `pwd`, `ls`, `find`, `git status/diff/log/show/branch/rev-parse`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `sed -n`, `npm test/run/exec`, `pnpm test/run/exec`, `yarn test/run`

### Bash Destructive Commands (always prompt)

Patterns: `rm -rf`, `sudo`, `git push`, `git reset`, `git clean`, `chmod -R`, `chown -R`, `mkfs`, `dd if=`, `:(){`

### Tool Filtering

```ts
// Allowlist: only these tools are available
const agent = new AgentCore({ allowedTools: ["Read", "Glob", "Grep"] });

// Denylist: these tools are removed
const agent = new AgentCore({ disabledTools: ["Bash", "Write"] });
```

### `AgentTool` Interface (for custom tools)

```ts
type AgentTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;              // JSON Schema
  readOnly: boolean | ((input: JsonObject) => boolean);
  destructive?: boolean | ((input: JsonObject) => boolean);
  concurrencySafe?: boolean | ((input: JsonObject) => boolean);
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolResult>;
};
```

---

## 5. Provider Support

### Supported Providers

| Provider ID | Model format | Env key | Base URL | OpenAI-compatible |
|---|---|---|---|---|
| `anthropic` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` | — | no |
| `openai` | `openai/gpt-4o` | `OPENAI_API_KEY` | — | — |
| `google` | `google/gemini-pro` | `GOOGLE_API_KEY` | — | no |
| `groq` | `groq/llama3-8b-8192` | `GROQ_API_KEY` | `api.groq.com/openai/v1` | yes |
| `mistral` | `mistral/mistral-large` | `MISTRAL_API_KEY` | `api.mistral.ai/v1` | yes |
| `deepseek` | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` | `api.deepseek.com/v1` | yes |
| `xai` | `xai/grok-beta` | `XAI_API_KEY` | `api.x.ai/v1` | yes |
| `openrouter` | `openrouter/mistral-7b` | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1` | yes |
| `minimax` | `minimax/MiniMax-M2.7` | `MINIMAX_API_KEY` | `api.minimax.io/v1` | yes |
| `together` | `together/llama-3` | `TOGETHER_API_KEY` | `api.together.xyz/v1` | yes |

### API

```ts
import { resolveProvider, parseProviderModel, listProviders } from "@agent-core/core";

// Parse model string
const { providerId, model } = parseProviderModel("openai/gpt-4o");
// → { providerId: "openai", model: "gpt-4o" }

// Resolve to a provider instance (reads env key automatically)
const provider = resolveProvider("anthropic/claude-sonnet-4-6", { apiKey: "sk-ant-..." });
// provider.id === "anthropic", provider.model === "claude-sonnet-4-6"

// List all available providers
const infos = listProviders();
// [{ id, envKey, baseURL?, openAICompatible }, ...]
```

**Model string rules:**
- No prefix → defaults to `anthropic`: `"claude-sonnet-4-6"` = `"anthropic/claude-sonnet-4-6"`
- With prefix → `"provider/model-name"`: `"openai/gpt-4o"`, `"groq/llama3-8b-8192"`

---

## 6. Session Storage

Sessions are stored as JSONL transcript files. Each line is a JSON entry: metadata, message, or usage.

### Backends

#### `FileSystemSessionStorage` (default)

Saves to `.agent-core/sessions/<sessionId>.jsonl` under the project `cwd`.
Set `AGENT_CORE_HOME` to redirect to a central directory.

```ts
import { FileSystemSessionStorage } from "@agent-core/core";

const storage = new FileSystemSessionStorage({ cwd: "/my/project" });
const agent = new AgentCore({ sessionStorage: storage });
```

#### `NullSessionStorage`

No-op — nothing is written. Use for web endpoints, tests, or ephemeral chats.

```ts
import { NullSessionStorage } from "@agent-core/core";
const agent = new AgentCore({ sessionStorage: new NullSessionStorage() });
```

#### `SupabaseSessionStorage`

Stores transcripts in PostgreSQL via Supabase. Supports multi-tenancy.

```ts
import { SupabaseSessionStorage } from "@agent-core/core";

const storage = new SupabaseSessionStorage({
  url: process.env.SUPABASE_URL!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  anonKey: process.env.SUPABASE_ANON_KEY,
  tenantId: "my-app",
});
```

**Required SQL schema:**

```sql
create table agent_sessions (
  tenant_id  text not null,
  session_id text not null,
  cwd        text not null,
  model      text not null,
  title      text,
  metadata   jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, session_id)
);

create table agent_transcript_entries (
  tenant_id  text not null,
  session_id text not null,
  seq        integer not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, session_id, seq)
);
```

### Session Utility Functions

```ts
import {
  createSessionId,
  loadSessionById,
  loadLatestSession,
  listSessions,
} from "@agent-core/core";

const id = createSessionId();                        // UUID
const session = await loadSessionById(cwd, id);      // LoadedSession
const latest  = await loadLatestSession(cwd);        // LoadedSession | null
const list    = await listSessions(cwd);             // SessionSummary[]
```

### Resuming a Session

```ts
const prior = await loadLatestSession(cwd);
const agent = new AgentCore({
  sessionId:       prior?.metadata.sessionId,
  initialMessages: prior?.messages,
  initialUsage:    prior?.usage,
});
```

### `SessionSummary` shape

```ts
type SessionSummary = {
  sessionId:    string;
  path:         string;
  cwd:          string;
  model:        string;
  createdAt:    string;
  updatedAt:    string;
  title?:       string;
  messageCount: number;
};
```

---

## 7. Workspace Abstraction

The `Workspace` interface abstracts filesystem operations so the agent can run in any environment.

### Interface

| Method | Signature | Description |
|---|---|---|
| `resolvePath` | `(path, cwd?) → string` | Resolve a relative or absolute path |
| `read` | `(path) → Promise<string>` | Read file as UTF-8 text |
| `readBytes` | `(path) → Promise<Uint8Array>` | Read file as raw bytes |
| `write` | `(path, content) → Promise<void>` | Write or overwrite file; creates parent dirs |
| `exists` | `(path) → Promise<boolean>` | Check existence |
| `stat` | `(path) → Promise<WorkspaceStat>` | Returns `{ type: "file"|"directory", size, mtimeMs }` |
| `list` | `(pattern, opts?) → Promise<WorkspaceEntry[]>` | Glob search; opts: `cwd`, `limit`, `includeDirectories` |
| `delete` | `(path) → Promise<void>` | Remove file |

### Implementations

| Class | Use case | Notes |
|---|---|---|
| `LocalWorkspace` | Desktop / CLI | Reads/writes real filesystem; glob via `fast-glob` |
| `MemoryWorkspace` | Tests / in-process web | Virtual Map-based FS; throws on path-escape attempts |
| `SupabaseWorkspace` | Cloud web apps | Stores files in Supabase Storage bucket; tenant+session scoped |

```ts
import { LocalWorkspace, MemoryWorkspace } from "@agent-core/core";

// Default — wraps real FS
const local  = new LocalWorkspace({ cwd: "/my/project" });

// In-memory — for tests or serverless with no FS access
const memory = new MemoryWorkspace({ cwd: "/workspace" });
```

---

## 8. Runtime Abstraction

The `Runtime` interface abstracts shell command execution.

### Interface

| Method | Signature | Description |
|---|---|---|
| `exec` | `(command, { cwd, timeoutMs, signal }) → Promise<RuntimeExecResult>` | Run command, wait for completion |
| `spawn` | `(command, { cwd }) → BackgroundShell` | Start long-running process, read output via `BashOutput` |

`RuntimeExecResult`: `{ stdout, stderr, exitCode, timedOut }`

### Implementations

| Class | Use case | Behaviour |
|---|---|---|
| `LocalRuntime` | CLI / Desktop | Executes real shell commands via `child_process` |
| `DisabledRuntime` | Web / serverless | Returns `exitCode: 126` with "not available" message; no actual execution |

```ts
import { LocalRuntime, DisabledRuntime } from "@agent-core/core";

// For server / web environments — never executes shell
const agent = new AgentCore({ runtime: new DisabledRuntime() });
```

---

## 9. Context & CLAUDE.md Discovery

On every `run()`, the agent auto-discovers project instruction files (`CLAUDE.md`) and injects them into the conversation.

### How it works

1. Walks ancestor directories from `cwd` up to the filesystem root
2. Reads any `CLAUDE.md` file found along the path
3. Checks `additionalInstructionDirs` for extra directories
4. Each file is truncated at **64 KB**; total is capped at **120 KB**
5. Injected as a `user` message with XML `<context-attachment>` tags before the user prompt

### API

```ts
import { buildAgentContext, discoverProjectInstructions } from "@agent-core/core";

// Full context build (used internally by AgentCore.run())
const ctx = await buildAgentContext({
  cwd: "/my/project",
  workspace: myWorkspace,              // optional; defaults to real FS
  additionalInstructionDirs: ["~/global-instructions"],
});
// ctx.projectInstructions — array of { path, content }
// ctx.attachmentMessages  — NeutralMessage[] ready to prepend

// Just the file discovery
const instructions = await discoverProjectInstructions({ cwd: "/my/project" });
```

### `CLAUDE.md` placement

| File location | Scope |
|---|---|
| `/my/project/CLAUDE.md` | Project-specific instructions |
| `/my/project/src/CLAUDE.md` | Sub-directory overrides |
| `~/.claude/CLAUDE.md` (or any ancestor) | User/global instructions |

---

## 10. System Prompt Builder

```ts
import { buildSystemPrompt } from "@agent-core/core";

const prompt = await buildSystemPrompt({
  cwd: "/my/project",
  model: "claude-sonnet-4-6",
  providerId: "anthropic",
  runtime: new LocalRuntime(),
  appendSystemPrompt: "Always respond in bullet points.",
  projectInstructions: ctx.projectInstructions,
});
```

### `buildSystemPrompt` Options

| Option | Type | Description |
|---|---|---|
| `cwd` | `string` | Used for git snapshot context |
| `model` | `string` | Included in runtime context block |
| `providerId` | `string` | Included in runtime context block |
| `runtime` | `Runtime` | Used to run `git` commands for the snapshot |
| `customSystemPrompt` | `string?` | Replaces the entire default agent prompt |
| `appendSystemPrompt` | `string?` | Appended after the default prompt |
| `projectInstructions` | `ProjectInstruction[]?` | List of CLAUDE.md files to include as index |

### Default prompt sections (in order)

1. **Agent identity** — software engineering agent operating rules
2. **Runtime context** — today's date, platform, provider, model, working directory
3. **Git snapshot** — current branch, `git status --short`, last 5 commits (skipped if not a git repo)
4. **Project instruction index** — list of discovered `CLAUDE.md` paths
5. **`appendSystemPrompt`** — user-provided additions

---

## 11. Environment Variables Reference

| Variable | Purpose | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key | AgentCore (auto-resolved) |
| `OPENAI_API_KEY` | OpenAI API key | AgentCore (auto-resolved) |
| `GOOGLE_API_KEY` | Google Gemini key | AgentCore (auto-resolved) |
| `GROQ_API_KEY` | Groq key | AgentCore (auto-resolved) |
| `MISTRAL_API_KEY` | Mistral key | AgentCore (auto-resolved) |
| `DEEPSEEK_API_KEY` | DeepSeek key | AgentCore (auto-resolved) |
| `XAI_API_KEY` | xAI / Grok key | AgentCore (auto-resolved) |
| `OPENROUTER_API_KEY` | OpenRouter key | AgentCore (auto-resolved) |
| `MINIMAX_API_KEY` | MiniMax key | AgentCore (auto-resolved) |
| `TOGETHER_API_KEY` | Together.ai key | AgentCore (auto-resolved) |
| `AGENT_CORE_MODEL` | Default model string | AgentCore constructor fallback |
| `ANTHROPIC_MODEL` | Secondary model fallback | AgentCore constructor fallback |
| `AGENT_CORE_HOME` | Redirect session storage to a central dir | `FileSystemSessionStorage` |
| `SUPABASE_URL` | Supabase project URL | `SupabaseSessionStorage`, `SupabaseWorkspace` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase key (preferred) | `SupabaseSessionStorage`, `SupabaseWorkspace` |
| `SUPABASE_ANON_KEY` | Public Supabase key (fallback) | `SupabaseSessionStorage`, `SupabaseWorkspace` |
| `SUPABASE_WORKSPACE_BUCKET` | Storage bucket name | `SupabaseWorkspace` (default: `agent-workspaces`) |
| `AGENT_CORE_TENANT_ID` | Multi-tenant namespace | `SupabaseSessionStorage`, `SupabaseWorkspace` (default: `local-dev`) |
