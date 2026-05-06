# Agent Core

Standalone TypeScript agent core migrated from the source Claude-style coding agent in this workspace. It does not use the bundled `karthickcode` runtime or any UI framework.

## What It Includes

- Anthropic Messages API loop with tool use continuation.
- Local tools: `Bash`, `BashOutput`, `KillShell`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`, and a focused `Agent` subagent tool.
- Permission modes: `default`, `acceptEdits`, `bypassPermissions`, and `plan`.
- Plain TypeScript library export plus a simple CLI.

## Run

```sh
cd agent-core
nvm use
npm install
npm run dev
```

Set your key as an environment variable:

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
npm run dev
```

Or pass a one-shot prompt:

```sh
npm run dev -- --prompt "Inspect this repo and explain how the source agent loop works"
```

For autonomous local execution:

```sh
npm run dev -- --yes --prompt "Run the tests and fix the failing TypeScript errors"
```

## Build

```sh
npm run build
npm start
```

## Library Usage

```ts
import { AgentCore } from "./dist/index.js";

const agent = new AgentCore({
  apiKey: process.env.ANTHROPIC_API_KEY,
  cwd: process.cwd(),
  permissionMode: "default",
  onEvent(event) {
    if (event.type === "assistant_text") process.stdout.write(event.text);
  },
});

const result = await agent.run("Read package.json and summarize the project");
console.log(result.text);
```

## Notes

This is a runnable TypeScript core, not a byte-for-byte port of the original terminal product. The original source includes React/Ink UI, remote sessions, feature flags, analytics, MCP/LSP plumbing, custom native runtime behavior, and bundled product integrations. Those pieces are intentionally separated from this first core so the agent can run as ordinary JavaScript/TypeScript.
