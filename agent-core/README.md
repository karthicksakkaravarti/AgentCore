# Agent Core

Standalone TypeScript agent core migrated from the source Claude-style coding agent in this workspace. It does not use the bundled `karthickcode` runtime or any UI framework.

## What It Includes

- Streaming LLM provider loop with Anthropic, OpenAI, Google Gemini, and OpenAI-compatible provider adapters.
- Local tools: `Bash`, `BashOutput`, `KillShell`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`, and a focused `Agent` subagent tool.
- Permission modes: `default`, `acceptEdits`, `bypassPermissions`, and `plan`.
- JSONL transcript helpers under `<cwd>/.agent-core/sessions/<session-id>.jsonl`.
- Pluggable workspace, runtime, and session storage backends for local apps and SaaS wrappers.
- `CLAUDE.md` discovery from the cwd and parent directories, injected as context attachments.
- Plain TypeScript library exports for wrappers and host applications.

## Install

```sh
cd agent-core
nvm use
npm install
```

## Build

```sh
npm run build
```

## Provider Models

Set your key as an environment variable. Bare model names still default to Anthropic for backwards compatibility:

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
AGENT_CORE_MODEL=claude-sonnet-4-6
AGENT_CORE_MODEL=anthropic/claude-sonnet-4-6
```

Other providers use a `<provider>/<model>` string:

```sh
export OPENAI_API_KEY="sk-..."
AGENT_CORE_MODEL=openai/gpt-4o

export GOOGLE_API_KEY="..."
AGENT_CORE_MODEL=google/gemini-2.5-pro

export MINIMAX_API_KEY="..."
AGENT_CORE_MODEL=minimax/MiniMax-Text-01
```

OpenAI-compatible providers use the same adapter with provider-specific base URLs:

| Prefix | Environment variable |
| --- | --- |
| `minimax/` | `MINIMAX_API_KEY` |
| `mistral/` | `MISTRAL_API_KEY` |
| `deepseek/` | `DEEPSEEK_API_KEY` |
| `xai/` | `XAI_API_KEY` |
| `groq/` | `GROQ_API_KEY` |
| `openrouter/` | `OPENROUTER_API_KEY` |
| `together/` | `TOGETHER_API_KEY` |

## Library Usage

```ts
import { AgentCore } from "@agent-core/core";

const agent = new AgentCore({
  model: "openai/gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  cwd: process.cwd(),
  permissionMode: "default",
  onEvent(event) {
    if (event.type === "text_delta") process.stdout.write(event.text);
  },
});

const result = await agent.run("Read package.json and summarize the project");
console.log(result.text);
console.log(result.sessionId);
```

The final `assistant_text` event is still emitted for consumers that have not moved to `text_delta`.

## Workspace, Runtime, And Sessions

`AgentCore` defaults to local-disk behavior for CLI and desktop wrappers:

```ts
import { AgentCore, LocalRuntime, LocalWorkspace } from "@agent-core/core";

const agent = new AgentCore({
  workspace: new LocalWorkspace({ cwd: process.cwd() }),
  runtime: new LocalRuntime(),
});
```

Web wrappers can swap those ports without changing the tools:

```ts
import {
  AgentCore,
  DisabledRuntime,
  NullSessionStorage,
  SupabaseWorkspace,
} from "@agent-core/core";

const agent = new AgentCore({
  cwd: "/workspace",
  workspace: new SupabaseWorkspace({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: "agent-workspaces",
    tenantId,
    sessionId,
  }),
  runtime: new DisabledRuntime(),
  sessionStorage: new NullSessionStorage(),
});
```

Use `MemoryWorkspace` for short-lived web sessions, `SupabaseWorkspace` for durable generated files, `DisabledRuntime` when shell execution is unavailable, and `SupabaseSessionStorage` when you have created the session tables. The exported `SUPABASE_SESSION_STORAGE_SCHEMA` contains the SQL for those tables.

## Wrappers

Runnable host applications live outside this package in `../agent-wrappers`:

- `cli` for terminal usage
- `next-sales-chat` for a Next.js chat interface
- `react-desktop` for an Electron React desktop shell

## Notes

This is a reusable TypeScript core, not a byte-for-byte port of the original terminal product. The original source includes React/Ink UI, remote sessions, feature flags, analytics, MCP/LSP plumbing, custom native runtime behavior, and bundled product integrations. Those pieces are intentionally separated so the agent can run as ordinary JavaScript/TypeScript in different wrappers.
