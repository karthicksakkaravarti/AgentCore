# Next Sales Chat Wrapper

This sample uses `agent-core` from a Next.js API route and streams text and tool events into a CRM-style sales chat. It is web-safe by default: Bash is disabled, while file/search/web tools run through the workspace abstraction.

```sh
cd agent-wrappers/next-sales-chat
npm install
npm run dev
```

Set a provider key before starting, for example:

```sh
export OPENAI_API_KEY="sk-..."
export AGENT_CORE_MODEL="openai/gpt-4o"
```

## Supabase Setup

Create a private Storage bucket named `agent-workspaces`, or set `SUPABASE_WORKSPACE_BUCKET` to the bucket name you choose. Generated files land at:

```txt
<tenantId>/<sessionId>/<path>
```

For example:

```txt
local-dev/7b7a.../maya-followup.md
```

Then open the Supabase SQL editor and run this schema for persistent chat transcripts and usage rows:

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

Use server-only Supabase credentials in `.env.local`:

```sh
SUPABASE_URL="https://..."
SUPABASE_SERVICE_ROLE_KEY="..."
SUPABASE_WORKSPACE_BUCKET="agent-workspaces"
AGENT_CORE_TENANT_ID="local-dev"

OPENAI_API_KEY="sk-..."
AGENT_CORE_MODEL="openai/gpt-4o"
```

`SUPABASE_SERVICE_ROLE_KEY` is preferred because this route runs on the server and writes to a private bucket. `SUPABASE_ANON_KEY` is supported only if your Supabase policies allow the needed storage/database writes.

## What Persists

- Supabase Storage stores generated files from `Read`, `Write`, `Edit`, `Glob`, and `Grep` through `SupabaseWorkspace`.
- Supabase Postgres stores chat transcripts and usage rows through `SupabaseSessionStorage`.
- Bash is intentionally disabled through `DisabledRuntime`. File tools still work because they call the workspace interface directly, not the runtime.
- If `SUPABASE_URL` or a Supabase key is missing, the dev server logs a warning and falls back to `MemoryWorkspace` plus `NullSessionStorage`.

## Smoke Test

Run the app and ask:

```txt
Draft a follow-up email handling the pricing objection, save it to /workspace/maya-followup.md, then read it back to me.
```

Expected result:

- The UI shows `Write` and `Read` tool chips in the assistant bubble.
- Supabase Storage contains `local-dev/<sessionId>/maya-followup.md`.
- `agent_sessions` has one row for the session.
- `agent_transcript_entries` contains message and usage entries for the conversation.
