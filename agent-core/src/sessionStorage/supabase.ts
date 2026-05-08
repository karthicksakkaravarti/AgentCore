import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  createSessionMetadata,
  type SessionFilter,
  type SessionMetadata,
  type SessionStorageBackend,
  type SessionStorageInitOptions,
  type SessionSummary,
  type TranscriptEntry,
} from "../sessionStorage.js";
import type { NeutralMessage } from "../providers/types.js";

export type SupabaseSessionStorageOptions = {
  supabase?: SupabaseClient;
  url?: string;
  serviceRoleKey?: string;
  anonKey?: string;
  tenantId: string;
  sessionsTable?: string;
  entriesTable?: string;
};

type SessionRow = {
  tenant_id: string;
  session_id: string;
  cwd: string;
  model: string;
  title: string | null;
  metadata: SessionMetadata;
  created_at: string;
  updated_at: string;
};

export class SupabaseSessionStorage implements SessionStorageBackend {
  readonly id = "supabase";
  private readonly supabase: SupabaseClient;
  private readonly tenantId: string;
  private readonly sessionsTable: string;
  private readonly entriesTable: string;

  constructor(options: SupabaseSessionStorageOptions) {
    this.tenantId = options.tenantId;
    this.sessionsTable = options.sessionsTable ?? "agent_sessions";
    this.entriesTable = options.entriesTable ?? "agent_transcript_entries";
    this.supabase =
      options.supabase ??
      createClient(
        requireOption(options.url, "SupabaseSessionStorage requires url or supabase"),
        requireOption(
          options.serviceRoleKey ?? options.anonKey,
          "SupabaseSessionStorage requires serviceRoleKey, anonKey, or supabase",
        ),
        { auth: { persistSession: false } },
      );
  }

  async initSession(
    options: SessionStorageInitOptions,
  ): Promise<SessionMetadata> {
    const metadata = createSessionMetadata(options);
    const { error } = await this.supabase.from(this.sessionsTable).upsert(
      {
        tenant_id: this.tenantId,
        session_id: options.sessionId,
        cwd: metadata.cwd,
        model: metadata.model,
        title: metadata.title ?? null,
        metadata,
        created_at: metadata.createdAt,
        updated_at: metadata.updatedAt,
      },
      { onConflict: "tenant_id,session_id" },
    );
    if (error) {
      throw new Error(`Could not initialize Supabase session: ${error.message}`);
    }

    if ((await this.nextSequence(options.sessionId)) === 1) {
      await this.appendEntry(options.sessionId, {
        type: "metadata",
        metadata,
      });
    }
    return metadata;
  }

  async appendEntry(sessionId: string, entry: TranscriptEntry): Promise<void> {
    const seq = await this.nextSequence(sessionId);
    const { error } = await this.supabase.from(this.entriesTable).insert({
      tenant_id: this.tenantId,
      session_id: sessionId,
      seq,
      payload: entry,
      created_at: "at" in entry ? entry.at : entry.metadata.createdAt,
    });
    if (error) {
      throw new Error(`Could not append Supabase transcript entry: ${error.message}`);
    }

    const updatedAt = "at" in entry ? entry.at : entry.metadata.updatedAt;
    await this.supabase
      .from(this.sessionsTable)
      .update({ updated_at: updatedAt })
      .eq("tenant_id", this.tenantId)
      .eq("session_id", sessionId);
  }

  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const { data, error } = await this.supabase
      .from(this.entriesTable)
      .select("payload")
      .eq("tenant_id", this.tenantId)
      .eq("session_id", sessionId)
      .order("seq", { ascending: true });
    if (error) {
      throw new Error(`Could not load Supabase transcript: ${error.message}`);
    }
    return ((data ?? []) as Array<{ payload: TranscriptEntry }>).map(
      (row) => row.payload,
    );
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    let query = this.supabase
      .from(this.sessionsTable)
      .select("*")
      .eq("tenant_id", this.tenantId)
      .order("updated_at", { ascending: false });
    if (filter.cwd) query = query.eq("cwd", filter.cwd);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Could not list Supabase sessions: ${error.message}`);
    }

    return Promise.all(
      ((data ?? []) as SessionRow[]).map(async (row) => ({
        sessionId: row.session_id,
        path: `supabase://${this.tenantId}/${row.session_id}`,
        cwd: row.cwd,
        model: row.model,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        title: row.title ?? extractTitle(await this.loadTranscript(row.session_id)),
        messageCount: await this.countMessages(row.session_id),
      })),
    );
  }

  private async nextSequence(sessionId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from(this.entriesTable)
      .select("seq")
      .eq("tenant_id", this.tenantId)
      .eq("session_id", sessionId)
      .order("seq", { ascending: false })
      .limit(1);
    if (error) {
      throw new Error(`Could not allocate Supabase transcript sequence: ${error.message}`);
    }
    const last = ((data ?? []) as Array<{ seq: number }>)[0]?.seq ?? 0;
    return last + 1;
  }

  private async countMessages(sessionId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from(this.entriesTable)
      .select("seq", { count: "exact", head: true })
      .eq("tenant_id", this.tenantId)
      .eq("session_id", sessionId)
      .contains("payload", { type: "message" });
    if (error) return 0;
    return count ?? 0;
  }
}

export const SUPABASE_SESSION_STORAGE_SCHEMA = `
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
`;

function extractTitle(entries: TranscriptEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = extractText(entry.message);
    if (text && !text.includes("<context-attachment")) return text.slice(0, 80);
  }
  return undefined;
}

function extractText(message: NeutralMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .trim();
}

function requireOption(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
