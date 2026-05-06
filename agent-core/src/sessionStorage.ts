import type { Anthropic } from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AgentState } from "./types.js";

const STORAGE_VERSION = 1;

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
      message: Anthropic.MessageParam;
    }
  | {
      type: "usage";
      at: string;
      usage: AgentState["usage"];
    };

export type LoadedSession = {
  metadata: SessionMetadata;
  path: string;
  messages: Anthropic.MessageParam[];
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

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function getAgentCoreHome(): string {
  return (
    process.env.AGENT_CORE_HOME ||
    path.join(os.homedir(), ".agent-core")
  );
}

export function getProjectStorageDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const label = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const hash = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  return path.join(getAgentCoreHome(), "projects", `${label}-${hash}`);
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
  const now = new Date().toISOString();
  const metadata: SessionMetadata = {
    version: STORAGE_VERSION,
    sessionId: options.sessionId,
    cwd: path.resolve(options.cwd),
    model: options.model,
    createdAt: now,
    updatedAt: now,
    title: options.title,
  };
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
  message: Anthropic.MessageParam,
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
  const messages: Anthropic.MessageParam[] = [];

  for (const entry of entries) {
    if (entry.type === "metadata") metadata = entry.metadata;
    if (entry.type === "message") messages.push(entry.message);
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
        const text = extractText(entry.message);
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

function extractText(message: Anthropic.MessageParam): string {
  if (typeof message.content === "string") return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (
          typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          return block.text;
        }
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}
