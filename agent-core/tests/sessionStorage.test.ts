import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEntry,
  createSessionId,
  createSessionMetadata,
  FileSystemSessionStorage,
  getProjectStorageDir,
  getSessionPath,
  initializeTranscript,
  listSessions,
  loadLatestSession,
  loadSessionById,
  NullSessionStorage,
  recordMessage,
  recordUsage,
  STORAGE_VERSION,
  updateSessionMetadata,
} from "../src/sessionStorage.js";

// ──────────────────────────────────────────────
// createSessionId
// ──────────────────────────────────────────────

describe("createSessionId", () => {
  it("returns a UUID string", () => {
    const id = createSessionId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => createSessionId()));
    expect(ids.size).toBe(10);
  });
});

// ──────────────────────────────────────────────
// createSessionMetadata
// ──────────────────────────────────────────────

describe("createSessionMetadata", () => {
  it("returns metadata with correct fields", () => {
    const meta = createSessionMetadata({
      cwd: "/ws",
      model: "claude-3",
      sessionId: "test-id",
    });
    expect(meta.version).toBe(STORAGE_VERSION);
    expect(meta.sessionId).toBe("test-id");
    expect(meta.model).toBe("claude-3");
    expect(meta.cwd).toContain("ws");
    expect(typeof meta.createdAt).toBe("string");
    expect(typeof meta.updatedAt).toBe("string");
  });

  it("resolves relative cwd to absolute", () => {
    const meta = createSessionMetadata({
      cwd: ".",
      model: "m",
      sessionId: "s",
    });
    expect(path.isAbsolute(meta.cwd)).toBe(true);
  });
});

describe("session storage paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-home-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("uses AGENT_CORE_HOME when set", () => {
    const original = process.env.AGENT_CORE_HOME;
    const home = path.join(tmpDir, "agent-home");
    process.env.AGENT_CORE_HOME = home;
    try {
      const projectDir = getProjectStorageDir(path.join(tmpDir, "my project"));
      expect(projectDir).toContain(path.join(home, "projects"));
      expect(projectDir).toMatch(/my-project-[0-9a-f]{12}$/);
    } finally {
      if (original === undefined) delete process.env.AGENT_CORE_HOME;
      else process.env.AGENT_CORE_HOME = original;
    }
  });
});

// ──────────────────────────────────────────────
// FileSystemSessionStorage
// ──────────────────────────────────────────────

describe("FileSystemSessionStorage", () => {
  let tmpDir: string;
  let storage: FileSystemSessionStorage;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-session-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    storage = new FileSystemSessionStorage({ cwd: tmpDir });
    sessionId = createSessionId();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("initSession creates a JSONL file", async () => {
    await storage.initSession({
      cwd: tmpDir,
      model: "claude-3",
      sessionId,
    });
    const filePath = storage.getSessionPath(sessionId);
    const { pathExists } = await import("../src/utils/fs.js");
    expect(await pathExists(filePath)).toBe(true);
  });

  it("initSession returns valid metadata", async () => {
    const meta = await storage.initSession({
      cwd: tmpDir,
      model: "claude-3",
      sessionId,
    });
    expect(meta.sessionId).toBe(sessionId);
    expect(meta.model).toBe("claude-3");
    expect(meta.version).toBe(STORAGE_VERSION);
  });

  it("appendEntry persists and loadTranscript returns it", async () => {
    await storage.initSession({ cwd: tmpDir, model: "claude-3", sessionId });
    await storage.appendEntry(sessionId, {
      type: "message",
      at: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    const entries = await storage.loadTranscript(sessionId);
    const msgEntry = entries.find((e) => e.type === "message");
    expect(msgEntry).toBeDefined();
    expect(msgEntry!.type === "message" && msgEntry.message.content[0]!.type === "text"
      && (msgEntry.message.content[0] as { type: "text"; text: string }).text).toBe("hello");
  });

  it("transcript first entry is metadata", async () => {
    await storage.initSession({ cwd: tmpDir, model: "claude-3", sessionId });
    const entries = await storage.loadTranscript(sessionId);
    expect(entries[0]!.type).toBe("metadata");
  });

  it("listSessions returns session summary", async () => {
    await storage.initSession({ cwd: tmpDir, model: "claude-3", sessionId });
    await storage.appendEntry(sessionId, {
      type: "message",
      at: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const sessions = await storage.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    const found = sessions.find((s) => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found!.model).toBe("claude-3");
    expect(found!.messageCount).toBe(1);
  });

  it("getSessionPath returns a .jsonl file path", () => {
    const p = storage.getSessionPath(sessionId);
    expect(p).toContain(sessionId);
    expect(p.endsWith(".jsonl")).toBe(true);
  });

  it("initializeTranscript does not rewrite an existing transcript", async () => {
    await initializeTranscript({ cwd: tmpDir, model: "claude-3", sessionId });
    await initializeTranscript({ cwd: tmpDir, model: "claude-4", sessionId });

    const lines = readFileSync(storage.getSessionPath(sessionId), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.metadata.model).toBe("claude-3");
  });

  it("recordUsage appends a usage entry", async () => {
    await initializeTranscript({ cwd: tmpDir, model: "claude-3", sessionId });
    await recordUsage(tmpDir, sessionId, {
      inputTokens: 3,
      outputTokens: 4,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
    });

    const entries = await storage.loadTranscript(sessionId);
    expect(entries.at(-1)).toEqual({
      type: "usage",
      at: expect.any(String),
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 2,
      },
    });
  });
});

// ──────────────────────────────────────────────
// loadSessionById / loadLatestSession
// ──────────────────────────────────────────────

describe("loadSessionById", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-load-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("round-trips messages", async () => {
    const sessionId = createSessionId();
    await initializeTranscript({ cwd: tmpDir, model: "claude-3", sessionId });
    await recordMessage(tmpDir, sessionId, {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    });
    const loaded = await loadSessionById(tmpDir, sessionId);
    expect(loaded.metadata.sessionId).toBe(sessionId);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]!.role).toBe("user");
  });

  it("throws for non-existent session", async () => {
    await expect(
      loadSessionById(tmpDir, createSessionId()),
    ).rejects.toThrow();
  });

  it("loads a session by absolute transcript path", async () => {
    const sessionId = createSessionId();
    await initializeTranscript({ cwd: tmpDir, model: "claude-3", sessionId });
    await recordMessage(tmpDir, sessionId, {
      role: "user",
      content: [{ type: "text", text: "absolute" }],
    });
    const filePath = getSessionPath(tmpDir, sessionId);

    const loaded = await loadSessionById(tmpDir, filePath);

    expect(loaded.path).toBe(filePath);
    expect(loaded.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "absolute",
    });
  });

  it("rethrows stat errors other than ENOENT", async () => {
    await expect(loadSessionById(tmpDir, "\0bad")).rejects.toThrow();
  });

  it("normalizes string message content into text blocks", async () => {
    const sessionId = createSessionId();
    const metadata = createSessionMetadata({
      cwd: tmpDir,
      model: "claude-3",
      sessionId,
    });
    const filePath = getSessionPath(tmpDir, sessionId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "metadata", metadata }),
        JSON.stringify({
          type: "message",
          at: "2026-05-08T00:00:00.000Z",
          message: { role: "user", content: "string content" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const loaded = await loadSessionById(tmpDir, sessionId);

    expect(loaded.messages[0]?.content).toEqual([
      { type: "text", text: "string content" },
    ]);
  });

  it("filters invalid content blocks and falls back to an empty text block", async () => {
    const sessionId = createSessionId();
    const metadata = createSessionMetadata({
      cwd: tmpDir,
      model: "claude-3",
      sessionId,
    });
    const filePath = getSessionPath(tmpDir, sessionId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "metadata", metadata }),
        JSON.stringify({
          type: "message",
          at: "2026-05-08T00:00:00.000Z",
          message: { role: "user", content: [null, 42] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const loaded = await loadSessionById(tmpDir, sessionId);

    expect(loaded.messages[0]?.content).toEqual([{ type: "text", text: "" }]);
  });

  it("normalizes tool_use and tool_result content blocks", async () => {
    const sessionId = createSessionId();
    const metadata = createSessionMetadata({
      cwd: tmpDir,
      model: "claude-3",
      sessionId,
    });
    const filePath = getSessionPath(tmpDir, sessionId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "metadata", metadata }),
        JSON.stringify({
          type: "message",
          at: "2026-05-08T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "Read",
                input: ["not an object"],
              },
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: [{ text: "read result" }],
                is_error: true,
              },
              {
                type: "tool_result",
                toolUseId: "tool_2",
                content: { ok: true },
              },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const loaded = await loadSessionById(tmpDir, sessionId);

    expect(loaded.messages[0]?.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "Read", input: {} },
      {
        type: "tool_result",
        toolUseId: "tool_1",
        content: "read result",
        isError: true,
      },
      {
        type: "tool_result",
        toolUseId: "tool_2",
        content: '{"ok":true}',
        isError: undefined,
      },
    ]);
  });
});

describe("loadLatestSession", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-latest-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns null when no sessions exist", async () => {
    const result = await loadLatestSession(tmpDir);
    expect(result).toBeNull();
  });

  it("returns the most recent session", async () => {
    const id1 = createSessionId();
    const id2 = createSessionId();
    await initializeTranscript({ cwd: tmpDir, model: "m", sessionId: id1 });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await initializeTranscript({ cwd: tmpDir, model: "m", sessionId: id2 });
    await recordMessage(tmpDir, id2, {
      role: "user",
      content: [{ type: "text", text: "latest" }],
    });
    const latest = await loadLatestSession(tmpDir);
    expect(latest).not.toBeNull();
    expect(latest!.metadata.sessionId).toBe(id2);
  });
});

// ──────────────────────────────────────────────
// updateSessionMetadata
// ──────────────────────────────────────────────

describe("updateSessionMetadata", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-update-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("rewrites metadata and preserves message entries", async () => {
    const sessionId = createSessionId();
    await initializeTranscript({ cwd: tmpDir, model: "old-model", sessionId });
    await recordMessage(tmpDir, sessionId, {
      role: "user",
      content: [{ type: "text", text: "preserved" }],
    });
    await updateSessionMetadata(tmpDir, sessionId, (meta) => ({
      ...meta,
      title: "My Session Title",
    }));
    const loaded = await loadSessionById(tmpDir, sessionId);
    expect(loaded.metadata.title).toBe("My Session Title");
    expect(loaded.messages).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
// NullSessionStorage
// ──────────────────────────────────────────────

describe("NullSessionStorage", () => {
  it("id is 'null'", () => {
    expect(new NullSessionStorage().id).toBe("null");
  });

  it("initSession returns metadata without filesystem writes", async () => {
    const storage = new NullSessionStorage();
    const meta = await storage.initSession({
      cwd: "/ws",
      model: "m",
      sessionId: "s123",
    });
    expect(meta.sessionId).toBe("s123");
  });

  it("loadTranscript returns empty array", async () => {
    const entries = await new NullSessionStorage().loadTranscript("any");
    expect(entries).toEqual([]);
  });

  it("listSessions returns empty array", async () => {
    const sessions = await new NullSessionStorage().listSessions();
    expect(sessions).toEqual([]);
  });

  it("appendEntry does nothing", async () => {
    await expect(
      new NullSessionStorage().appendEntry("any", {
        type: "message",
        at: new Date().toISOString(),
        message: { role: "user", content: [] },
      }),
    ).resolves.toBeUndefined();
  });
});
