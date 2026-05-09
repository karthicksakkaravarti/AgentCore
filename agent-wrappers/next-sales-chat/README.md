# agent-core Next.js Sales Chat

A Next.js application that runs `@agent-core/core` server-side, streams agent events to the browser via NDJSON, and optionally persists sessions and files to Supabase.

---

## What It Does

- A React chat UI sends messages to a Next.js API route (`POST /api/chat`)
- The route creates an `AgentCore` instance and streams events back as NDJSON
- The browser parses the stream and updates the UI in real time (text, thinking blocks, tool chips)
- Agent files are stored in a virtual `/workspace` directory per session
- Without Supabase: uses in-memory storage (files and transcripts reset on each request)
- With Supabase: persists file objects and JSONL transcripts across requests

---

## Quick Start (no Supabase)

```sh
cd agent-wrappers/next-sales-chat
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and type a message. The agent runs with `MemoryWorkspace` and `NullSessionStorage` — no external services required.

Set at least one provider API key before starting:

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-..."
export AGENT_CORE_MODEL="openai/gpt-4o"
```

---

## Environment Variables

Create a `.env.local` file in the `next-sales-chat/` directory:

```env
# Required: at least one provider key
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional: override default model (default: claude-sonnet-4-6)
AGENT_CORE_MODEL=claude-sonnet-4-6

# Optional: Supabase persistence
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_ANON_KEY=eyJ...
SUPABASE_WORKSPACE_BUCKET=agent-workspaces
AGENT_CORE_TENANT_ID=local-dev
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | One of these | Anthropic API key |
| `OPENAI_API_KEY` | One of these | OpenAI API key |
| `AGENT_CORE_MODEL` | No | Model to use (default: `claude-sonnet-4-6`) |
| `ANTHROPIC_MODEL` | No | Fallback model env var |
| `SUPABASE_URL` | No | Supabase project URL — enables persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Server-only Supabase key (preferred for private bucket writes) |
| `SUPABASE_ANON_KEY` | No | Supabase anon key (fallback if no service role key) |
| `SUPABASE_WORKSPACE_BUCKET` | No | Storage bucket name (default: `agent-workspaces`) |
| `AGENT_CORE_TENANT_ID` | No | Namespace for multi-tenant storage (default: `local-dev`) |

---

## Architecture

```
Browser (React)
    │
    │  POST /api/chat  { messages, sessionId, model, apiKey }
    ▼
Next.js API Route  (app/api/chat/route.ts)
    │
    │  new AgentCore({
    │    allowedTools: SALES_SAFE_TOOLS,
    │    runtime: new DisabledRuntime(),
    │    permissionMode: "acceptEdits",
    │    workspace,          // SupabaseWorkspace or MemoryWorkspace
    │    sessionStorage,     // SupabaseSessionStorage or NullSessionStorage
    │  })
    │  agent.run(prompt)
    │
    │  NDJSON stream  ─────────────────────────────────────►  Browser
    │  { type: "text_delta", text }
    │  { type: "thinking_delta", text }
    │  { type: "tool_start", id, name, input }
    │  { type: "tool_result", id, name, ok, summary }
    │  { type: "done", sessionId, stoppedBy, usage }
    │  { type: "error", message }
    ▼
Workspace & SessionStorage
    ├── MemoryWorkspace  (no Supabase env vars set)
    └── SupabaseWorkspace  (SUPABASE_URL + key set)
```

### Key files

| File | Role |
|---|---|
| `app/api/chat/route.ts` | Receives POST, creates AgentCore, streams NDJSON |
| `app/page.tsx` | React chat UI; parses NDJSON and updates state |
| `app/layout.tsx` | Root layout with fonts and global styles |

---

## Allowed Tools

The route restricts the agent to a safe subset called `SALES_SAFE_TOOLS`:

```ts
const SALES_SAFE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
];
```

`Bash` is excluded because the route uses `DisabledRuntime`, which returns exit code 126 for any shell command. File tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`) work because they call the workspace interface directly, not the runtime. This makes the agent safe to run in serverless / edge environments.

The permission mode is `"acceptEdits"` — file writes are auto-approved without an interactive prompt.

---

## NDJSON Streaming Format

Each line of the response body is a JSON object followed by `\n`. The `Content-Type` header is `application/x-ndjson`.

| Line type | Fields | When fired |
|---|---|---|
| `text_delta` | `text: string` | Each chunk of assistant text (outside `<think>` blocks) |
| `thinking_delta` | `text: string` | Content inside `<think>...</think>` blocks |
| `tool_start` | `id, name, input` | When a tool call begins |
| `tool_result` | `id, name, ok, summary` | When a tool call completes; `ok=false` on error; `summary` is truncated to 200 chars |
| `done` | `sessionId, stoppedBy, usage` | Final event; `stoppedBy` is `"end_turn"` or `"max_turns"` |
| `error` | `message: string` | Unhandled exception in the route |

Example sequence:

```jsonl
{"type":"text_delta","text":"Let me check"}
{"type":"tool_start","id":"t1","name":"Read","input":{"file_path":"/workspace/notes.md"}}
{"type":"tool_result","id":"t1","name":"Read","ok":true,"summary":"# Notes\nContent..."}
{"type":"text_delta","text":" — here is what I found."}
{"type":"done","sessionId":"abc123","stoppedBy":"end_turn","usage":{"inputTokens":410,"outputTokens":55}}
```

---

## Thinking Blocks

Some models emit `<think>...</think>` tags in their output. The route includes a streaming splitter (`createThinkBlockSplitter`) that separates thinking content from visible text without buffering the whole response.

- Visible text → `text_delta` NDJSON lines
- Think-block content → `thinking_delta` NDJSON lines

The browser UI renders thinking blocks as collapsible sections.

---

## Supabase Setup (Persistent Storage)

### 1. Create the database tables

Run this SQL in your Supabase SQL editor:

```sql
create table if not exists agent_sessions (
  tenant_id text not null,
  session_id text not null,
  cwd text not null,
  model text not null,
  title text,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, session_id)
);

create table if not exists agent_transcript_entries (
  tenant_id text not null,
  session_id text not null,
  seq integer not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, session_id, seq),
  foreign key (tenant_id, session_id)
    references agent_sessions (tenant_id, session_id)
    on delete cascade
);

create index if not exists agent_transcript_entries_session_idx
  on agent_transcript_entries (tenant_id, session_id, seq);

notify pgrst, 'reload schema';
```

### 2. Create the storage bucket

In the Supabase dashboard → Storage → New bucket:
- Name: `agent-workspaces` (or match `SUPABASE_WORKSPACE_BUCKET`)
- Public: **no** (private bucket)

### 3. Set environment variables

```env
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_WORKSPACE_BUCKET=agent-workspaces
AGENT_CORE_TENANT_ID=production
```

Use `SUPABASE_SERVICE_ROLE_KEY` when running server-side — it bypasses row-level security for private bucket writes. `SUPABASE_ANON_KEY` is supported as a fallback if your Supabase policies allow the needed writes.

### Storage path format

Files are stored at:

```
<tenantId>/<sessionId>/<path-within-workspace>
```

For example, `/workspace/report.md` for tenant `acme` and session `abc123` is stored at:

```
acme/abc123/workspace/report.md
```

### What persists

- `SupabaseWorkspace` stores generated files written by `Write`, `Edit`, etc.
- `SupabaseSessionStorage` stores chat transcripts and usage rows in Postgres.

### Fallback behavior

If `SUPABASE_URL` or the key are absent, the route automatically falls back to `MemoryWorkspace` + `NullSessionStorage` and logs a warning to stderr. The app continues to function — files and transcripts just do not survive the request.

---

## Extending

### Add more tools

Edit `SALES_SAFE_TOOLS` in `app/api/chat/route.ts`:

```ts
const SALES_SAFE_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "TodoWrite",
  "NotebookEdit",   // add here
];
```

### Change the system prompt

Edit `SYSTEM_PROMPT` in `app/api/chat/route.ts`:

```ts
const SYSTEM_PROMPT = `You are an expert sales assistant for Acme Corp. ...`;
```

### Switch models via the UI

The request body accepts a `model` field. The UI can send a `model` string to override the server default per request.

### Change the default model

Set `AGENT_CORE_MODEL` in `.env.local`:

```env
AGENT_CORE_MODEL=openai/gpt-4o
```

---

## Smoke Test

1. Start the dev server: `npm run dev`
2. Open [http://localhost:3000](http://localhost:3000)
3. Send this message:

   > Draft a follow-up email handling the pricing objection, save it to `/workspace/maya-followup.md`, then read it back to me.

Expected result:
- The UI shows `Write` and `Read` tool chips in the assistant bubble.
- The email content appears in the chat.
- (With Supabase) `agent_sessions` has one row; `SUPABASE_WORKSPACE_BUCKET` contains `<tenantId>/<sessionId>/workspace/maya-followup.md`.
