import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { NeutralContentBlock, NeutralMessage } from "./providers/types.js";
import type { AgentState } from "./types.js";

export const STORAGE_VERSION = 2;

export type SessionMetadata = {
  version: number;
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
};

export type TranscriptEntry =
  | {
      type: "metadata";
      metadata: SessionMetadata;
    }
  | {
      type: "message";
      at: string;
      message: NeutralMessage;
    }
  | {
      type: "usage";
      at: string;
      usage: AgentState["usage"];
    };

export type LoadedSession = {
  metadata: SessionMetadata;
  path: string;
  messages: NeutralMessage[];
  usage?: AgentState["usage"];
};

export type SessionSummary = {
  sessionId: string;
  path: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  messageCount: number;
};

export type SessionStorageInitOptions = {
  cwd: string;
  model: string;
  sessionId: string;
  title?: string;
};

export type SessionFilter = {
  cwd?: string;
};

export interface SessionStorageBackend {
  readonly id: string;
  initSession(options: SessionStorageInitOptions): Promise<SessionMetadata>;
  appendEntry(sessionId: string, entry: TranscriptEntry): Promise<void>;
  loadTranscript(sessionId: string): Promise<TranscriptEntry[]>;
  listSessions(filter?: SessionFilter): Promise<SessionSummary[]>;
  getSessionPath?(sessionId: string): string;
}

export class FileSystemSessionStorage implements SessionStorageBackend {
  readonly id = "filesystem";
  private readonly cwd: string;

  constructor(options: { cwd: string }) {
    this.cwd = options.cwd;
  }

  initSession(options: SessionStorageInitOptions): Promise<SessionMetadata> {
    return initializeTranscript({
      cwd: options.cwd ?? this.cwd,
      model: options.model,
      sessionId: options.sessionId,
      title: options.title,
    });
  }

  appendEntry(sessionId: string, entry: TranscriptEntry): Promise<void> {
    return appendTranscriptEntry(this.cwd, sessionId, entry);
  }

  loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    return readTranscriptEntries(this.getSessionPath(sessionId));
  }

  listSessions(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return listSessions(filter.cwd ?? this.cwd);
  }

  getSessionPath(sessionId: string): string {
    return getSessionPath(this.cwd, sessionId);
  }
}

export class NullSessionStorage implements SessionStorageBackend {
  readonly id = "null";

  async initSession(options: SessionStorageInitOptions): Promise<SessionMetadata> {
    return createSessionMetadata(options);
  }

  async appendEntry(
    _sessionId: string,
    _entry: TranscriptEntry,
  ): Promise<void> {
    return undefined;
  }

  async loadTranscript(_sessionId: string): Promise<TranscriptEntry[]> {
    return [];
  }

  async listSessions(_filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return [];
  }
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function getAgentCoreHome(): string {
  return process.env.AGENT_CORE_HOME || "";
}

export function getProjectStorageDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const homeOverride = getAgentCoreHome();
  if (homeOverride) {
    const label =
      path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
    const hash = crypto
      .createHash("sha1")
      .update(resolved)
      .digest("hex")
      .slice(0, 12);
    return path.join(homeOverride, "projects", `${label}-${hash}`);
  }
  return path.join(resolved, ".agent-core", "sessions");
}

export function getSessionPath(cwd: string, sessionId: string): string {
  return path.join(getProjectStorageDir(cwd), `${sessionId}.jsonl`);
}

export async function initializeTranscript(options: {
  cwd: string;
  model: string;
  sessionId: string;
  title?: string;
}): Promise<SessionMetadata> {
  const metadata = createSessionMetadata(options);
  const filePath = getSessionPath(options.cwd, options.sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await stat(filePath);
    return metadata;
  } catch {
    await appendTranscriptEntry(options.cwd, options.sessionId, {
      type: "metadata",
      metadata,
    });
    return metadata;
  }
}

export function createSessionMetadata(
  options: SessionStorageInitOptions,
): SessionMetadata {
  const now = new Date().toISOString();
  return {
    version: STORAGE_VERSION,
    sessionId: options.sessionId,
    cwd: path.resolve(options.cwd),
    model: options.model,
    createdAt: now,
    updatedAt: now,
    title: options.title,
  };
}

export async function appendTranscriptEntry(
  cwd: string,
  sessionId: string,
  entry: TranscriptEntry,
): Promise<void> {
  const filePath = getSessionPath(cwd, sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function recordMessage(
  cwd: string,
  sessionId: string,
  message: NeutralMessage,
): Promise<void> {
  await appendTranscriptEntry(cwd, sessionId, {
    type: "message",
    at: new Date().toISOString(),
    message,
  });
}

export async function recordUsage(
  cwd: string,
  sessionId: string,
  usage: AgentState["usage"],
): Promise<void> {
  await appendTranscriptEntry(cwd, sessionId, {
    type: "usage",
    at: new Date().toISOString(),
    usage,
  });
}

export async function updateSessionMetadata(
  cwd: string,
  sessionId: string,
  updater: (metadata: SessionMetadata) => SessionMetadata,
): Promise<void> {
  const loaded = await loadSessionById(cwd, sessionId);
  const metadata = updater({
    ...loaded.metadata,
    updatedAt: new Date().toISOString(),
  });
  const entries = await readTranscriptEntries(loaded.path);
  const rewritten = entries.map((entry) =>
    entry.type === "metadata" ? { type: "metadata" as const, metadata } : entry,
  );
  await writeFile(
    loaded.path,
    rewritten.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

export async function loadSessionById(
  cwd: string,
  sessionId: string,
): Promise<LoadedSession> {
  const filePath = path.isAbsolute(sessionId)
    ? sessionId
    : getSessionPath(cwd, sessionId);
  const entries = await readTranscriptEntries(filePath);
  let metadata: SessionMetadata | undefined;
  let usage: AgentState["usage"] | undefined;
  const messages: NeutralMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "metadata") metadata = entry.metadata;
    if (entry.type === "message") {
      messages.push(normalizeTranscriptMessage(entry.message));
    }
    if (entry.type === "usage") usage = entry.usage;
  }

  if (!metadata) {
    throw new Error(`Transcript has no metadata entry: ${filePath}`);
  }

  return {
    metadata,
    path: filePath,
    messages,
    usage,
  };
}

export async function loadLatestSession(cwd: string): Promise<LoadedSession | null> {
  const sessions = await listSessions(cwd);
  if (sessions.length === 0) return null;
  return loadSessionById(cwd, sessions[0]!.sessionId);
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = getProjectStorageDir(cwd);
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (file) => summarizeSession(path.join(dir, file))),
  );

  return summaries
    .filter((summary): summary is SessionSummary => summary !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function summarizeSession(filePath: string): Promise<SessionSummary | null> {
  const entries = await readTranscriptEntries(filePath).catch(() => []);
  let metadata: SessionMetadata | undefined;
  let messageCount = 0;
  let lastAt: string | undefined;
  let firstUserTitle: string | undefined;

  for (const entry of entries) {
    if (entry.type === "metadata") metadata = entry.metadata;
    if (entry.type === "message") {
      messageCount += 1;
      lastAt = entry.at;
      if (!firstUserTitle && entry.message.role === "user") {
        const text = extractText(normalizeTranscriptMessage(entry.message));
        if (!text.includes("<context-attachment")) {
          firstUserTitle = text.slice(0, 80);
        }
      }
    }
    if (entry.type === "usage") lastAt = entry.at;
  }

  if (!metadata) return null;
  return {
    sessionId: metadata.sessionId,
    path: filePath,
    cwd: metadata.cwd,
    model: metadata.model,
    createdAt: metadata.createdAt,
    updatedAt: lastAt ?? metadata.updatedAt,
    title: metadata.title ?? firstUserTitle,
    messageCount,
  };
}

async function readTranscriptEntries(filePath: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (!(await exists(filePath))) return entries;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    entries.push(JSON.parse(trimmed) as TranscriptEntry);
  }

  return entries;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractText(message: NeutralMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .trim();
}

function normalizeTranscriptMessage(message: unknown): NeutralMessage {
  const value = message as { role?: unknown; content?: unknown };
  return {
    role: value.role === "assistant" ? "assistant" : "user",
    content: normalizeContentBlocks(value.content),
  };
}

function normalizeContentBlocks(content: unknown): NeutralContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks = content
    .map(normalizeContentBlock)
    .filter((block): block is NeutralContentBlock => block !== null);
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function normalizeContentBlock(block: unknown): NeutralContentBlock | null {
  if (typeof block !== "object" || block === null) return null;
  const value = block as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (
    value.type === "tool_use" &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  ) {
    return {
      type: "tool_use",
      id: value.id,
      name: value.name,
      input: normalizeJsonObject(value.input),
    };
  }
  if (value.type === "tool_result") {
    const toolUseId =
      typeof value.toolUseId === "string"
        ? value.toolUseId
        : typeof value.tool_use_id === "string"
          ? value.tool_use_id
          : "";
    if (!toolUseId) return null;
    return {
      type: "tool_result",
      toolUseId,
      content: normalizeToolResultContent(value.content),
      isError:
        value.isError === true ||
        value.is_error === true ||
        undefined,
    };
  }
  return null;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : "",
      )
      .join(" ")
      .trim();
    if (text) return text;
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
