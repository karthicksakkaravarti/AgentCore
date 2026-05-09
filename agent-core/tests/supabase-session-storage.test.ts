import { describe, expect, it, vi } from "vitest";
import { SupabaseSessionStorage } from "../src/sessionStorage/supabase.js";

type QueryMock = Record<string, ReturnType<typeof vi.fn>> &
  PromiseLike<unknown>;

function makeQuery(result: unknown): QueryMock {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: PromiseLike<unknown>["then"];
  } = {};
  for (const method of [
    "select",
    "insert",
    "upsert",
    "update",
    "eq",
    "order",
    "limit",
    "contains",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (onFulfilled, onRejected) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return query as QueryMock;
}

function makeSupabase(queries: QueryMock[]) {
  const pending = [...queries];
  return {
    from: vi.fn(() => {
      const query = pending.shift();
      if (!query) throw new Error("Unexpected Supabase query");
      return query;
    }),
  };
}

const ok = { data: null, error: null };

describe("SupabaseSessionStorage", () => {
  it("requires either a Supabase client or URL credentials", () => {
    expect(
      () => new SupabaseSessionStorage({ tenantId: "tenant" } as never),
    ).toThrow("requires url or supabase");
    expect(
      () =>
        new SupabaseSessionStorage({
          tenantId: "tenant",
          url: "https://example.supabase.co",
        } as never),
    ).toThrow("requires serviceRoleKey");
  });

  it("initializes a session, writes metadata, and uses custom table names", async () => {
    const upsert = makeQuery(ok);
    const firstNextSequence = makeQuery({ data: [], error: null });
    const appendNextSequence = makeQuery({ data: [], error: null });
    const insert = makeQuery(ok);
    const update = makeQuery(ok);
    const supabase = makeSupabase([
      upsert,
      firstNextSequence,
      appendNextSequence,
      insert,
      update,
    ]);
    const storage = new SupabaseSessionStorage({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionsTable: "custom_sessions",
      entriesTable: "custom_entries",
    });

    const metadata = await storage.initSession({
      cwd: "/workspace",
      model: "model",
      sessionId: "session",
      title: "Title",
    });

    expect(metadata.sessionId).toBe("session");
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      "custom_sessions",
      "custom_entries",
      "custom_entries",
      "custom_entries",
      "custom_sessions",
    ]);
    expect(upsert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant",
        session_id: "session",
        cwd: expect.stringContaining("workspace"),
        model: "model",
        title: "Title",
      }),
      { onConflict: "tenant_id,session_id" },
    );
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant",
        session_id: "session",
        seq: 1,
        payload: { type: "metadata", metadata },
        created_at: metadata.createdAt,
      }),
    );
    expect(update.update).toHaveBeenCalledWith({
      updated_at: metadata.updatedAt,
    });
  });

  it("skips the initial metadata transcript entry when entries already exist", async () => {
    const upsert = makeQuery(ok);
    const nextSequence = makeQuery({ data: [{ seq: 3 }], error: null });
    const supabase = makeSupabase([upsert, nextSequence]);
    const storage = new SupabaseSessionStorage({
      supabase: supabase as never,
      tenantId: "tenant",
    });

    await storage.initSession({
      cwd: "/workspace",
      model: "model",
      sessionId: "session",
    });

    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it("throws when session initialization fails", async () => {
    const supabase = makeSupabase([
      makeQuery({ data: null, error: { message: "upsert failed" } }),
    ]);
    const storage = new SupabaseSessionStorage({
      supabase: supabase as never,
      tenantId: "tenant",
    });

    await expect(
      storage.initSession({
        cwd: "/workspace",
        model: "model",
        sessionId: "session",
      }),
    ).rejects.toThrow("upsert failed");
  });

  it("appends entries with allocated sequence and updates session updated_at", async () => {
    const nextSequence = makeQuery({ data: [{ seq: 4 }], error: null });
    const insert = makeQuery(ok);
    const update = makeQuery(ok);
    const supabase = makeSupabase([nextSequence, insert, update]);
    const storage = new SupabaseSessionStorage({
      supabase: supabase as never,
      tenantId: "tenant",
    });
    const entry = {
      type: "message" as const,
      at: "2026-05-08T00:00:00.000Z",
      message: {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
      },
    };

    await storage.appendEntry("session", entry);

    expect(insert.insert).toHaveBeenCalledWith({
      tenant_id: "tenant",
      session_id: "session",
      seq: 5,
      payload: entry,
      created_at: entry.at,
    });
    expect(update.update).toHaveBeenCalledWith({ updated_at: entry.at });
    expect(update.eq).toHaveBeenCalledWith("tenant_id", "tenant");
    expect(update.eq).toHaveBeenCalledWith("session_id", "session");
  });

  it("throws when sequence allocation or insert fails", async () => {
    const sequenceErrorStorage = new SupabaseSessionStorage({
      supabase: makeSupabase([
        makeQuery({ data: null, error: { message: "seq failed" } }),
      ]) as never,
      tenantId: "tenant",
    });
    await expect(
      sequenceErrorStorage.appendEntry("session", {
        type: "usage",
        at: "2026-05-08T00:00:00.000Z",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      }),
    ).rejects.toThrow("seq failed");

    const insertErrorStorage = new SupabaseSessionStorage({
      supabase: makeSupabase([
        makeQuery({ data: [], error: null }),
        makeQuery({ data: null, error: { message: "insert failed" } }),
      ]) as never,
      tenantId: "tenant",
    });
    await expect(
      insertErrorStorage.appendEntry("session", {
        type: "usage",
        at: "2026-05-08T00:00:00.000Z",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      }),
    ).rejects.toThrow("insert failed");
  });

  it("loads transcript payloads and handles null data", async () => {
    const transcript = [
      {
        type: "message" as const,
        at: "2026-05-08T00:00:00.000Z",
        message: {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hi" }],
        },
      },
    ];
    const storage = new SupabaseSessionStorage({
      supabase: makeSupabase([
        makeQuery({ data: transcript.map((payload) => ({ payload })), error: null }),
        makeQuery({ data: null, error: null }),
      ]) as never,
      tenantId: "tenant",
    });

    await expect(storage.loadTranscript("session")).resolves.toEqual(transcript);
    await expect(storage.loadTranscript("empty")).resolves.toEqual([]);
  });

  it("throws when transcript loading fails", async () => {
    const storage = new SupabaseSessionStorage({
      supabase: makeSupabase([
        makeQuery({ data: null, error: { message: "load failed" } }),
      ]) as never,
      tenantId: "tenant",
    });

    await expect(storage.loadTranscript("session")).rejects.toThrow("load failed");
  });

  it("lists sessions with extracted titles, paths, and message counts", async () => {
    const row = {
      tenant_id: "tenant",
      session_id: "session",
      cwd: "/workspace",
      model: "model",
      title: null,
      metadata: {},
      created_at: "2026-05-08T00:00:00.000Z",
      updated_at: "2026-05-08T01:00:00.000Z",
    };
    const supabase = makeSupabase([
      makeQuery({ data: [row], error: null }),
      makeQuery({
        data: [
          {
            payload: {
              type: "message",
              at: "2026-05-08T00:00:00.000Z",
              message: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "<context-attachment>ignore me</context-attachment>",
                  },
                ],
              },
            },
          },
          {
            payload: {
              type: "message",
              at: "2026-05-08T00:00:01.000Z",
              message: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "A useful title that should be extracted from text",
                  },
                ],
              },
            },
          },
        ],
        error: null,
      }),
      makeQuery({ count: 2, error: null }),
    ]);
    const storage = new SupabaseSessionStorage({
      supabase: supabase as never,
      tenantId: "tenant",
    });

    const sessions = await storage.listSessions();

    expect(sessions).toEqual([
      {
        sessionId: "session",
        path: "supabase://tenant/session",
        cwd: "/workspace",
        model: "model",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T01:00:00.000Z",
        title: "A useful title that should be extracted from text",
        messageCount: 2,
      },
    ]);
  });

  it("uses explicit titles and applies cwd filters", async () => {
    const sessionsQuery = makeQuery({
      data: [
        {
          tenant_id: "tenant",
          session_id: "session",
          cwd: "/workspace",
          model: "model",
          title: "Saved title",
          metadata: {},
          created_at: "2026-05-08T00:00:00.000Z",
          updated_at: "2026-05-08T01:00:00.000Z",
        },
      ],
      error: null,
    });
    const supabase = makeSupabase([
      sessionsQuery,
      makeQuery({ count: null, error: { message: "count ignored" } }),
    ]);
    const storage = new SupabaseSessionStorage({
      supabase: supabase as never,
      tenantId: "tenant",
    });

    const sessions = await storage.listSessions({ cwd: "/workspace" });

    expect(sessions[0]?.title).toBe("Saved title");
    expect(sessions[0]?.messageCount).toBe(0);
    expect(sessionsQuery.eq).toHaveBeenCalledWith("tenant_id", "tenant");
    expect(sessionsQuery.eq).toHaveBeenCalledWith("cwd", "/workspace");
  });

  it("leaves the title undefined when there are no valid user messages", async () => {
    const storage = new SupabaseSessionStorage({
      supabase: makeSupabase([
        makeQuery({
          data: [
            {
              tenant_id: "tenant",
              session_id: "session",
              cwd: "/workspace",
              model: "model",
              title: null,
              metadata: {},
              created_at: "2026-05-08T00:00:00.000Z",
              updated_at: "2026-05-08T01:00:00.000Z",
            },
          ],
          error: null,
        }),
        makeQuery({
          data: [
            {
              payload: {
                type: "message",
                at: "2026-05-08T00:00:00.000Z",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "assistant only" }],
                },
              },
            },
          ],
          error: null,
        }),
        makeQuery({ count: 1, error: null }),
      ]) as never,
      tenantId: "tenant",
    });

    const sessions = await storage.listSessions();

    expect(sessions[0]?.title).toBeUndefined();
  });

  it("throws when listing sessions fails", async () => {
    const storage = new SupabaseSessionStorage({
      supabase: makeSupabase([
        makeQuery({ data: null, error: { message: "list failed" } }),
      ]) as never,
      tenantId: "tenant",
    });

    await expect(storage.listSessions()).rejects.toThrow("list failed");
  });
});
