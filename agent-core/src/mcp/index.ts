import { createRequire } from "node:module";

import type { AgentTool, JsonObject, ToolResult } from "../types.js";
import { stringifyForToolResult } from "../utils/json.js";

const packageJson = createRequire(import.meta.url)("../../package.json") as {
  version?: unknown;
};

const AGENT_CORE_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "unknown";

export type McpServerConfig = {
  name: string;
  url: string;
  token?: string;
  transport?: "http" | "sse";
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
};

type McpSession = {
  sessionId?: string;
  initialized: boolean;
  initializePromise?: Promise<void>;
};

export async function loadMcpTools(
  servers: McpServerConfig[],
): Promise<{ tools: AgentTool[]; close: () => Promise<void> }> {
  const tools: AgentTool[] = [];
  const serverSessions: Array<{
    server: McpServerConfig;
    session: McpSession;
  }> = [];

  for (const server of servers) {
    const session: McpSession = { initialized: false };
    serverSessions.push({ server, session });
    const discovered = await listTools(server, session);
    for (const tool of discovered) {
      tools.push(toAgentTool(server, session, tool));
    }
  }

  return {
    tools,
    async close() {
      await Promise.allSettled(
        serverSessions.map(({ server, session }) =>
          closeMcpSession(server, session),
        ),
      );
    },
  };
}

async function listTools(
  server: McpServerConfig,
  session: McpSession,
): Promise<McpToolDefinition[]> {
  const result = await callJsonRpc(server, session, "tools/list", {});
  const tools = normalizeToolList(result);
  return tools.map((tool) => ({
    ...tool,
    name: namespacedToolName(server.name, tool.name),
  }));
}

function toAgentTool(
  server: McpServerConfig,
  session: McpSession,
  tool: McpToolDefinition,
): AgentTool {
  return {
    name: tool.name,
    description:
      tool.description ?? `Tool '${tool.name}' provided by MCP server '${server.name}'.`,
    inputSchema: normalizeInputSchema(tool.inputSchema),
    readOnly: false,
    concurrencySafe: false,
    async execute(input): Promise<ToolResult> {
      const remoteToolName = denamespaceToolName(server.name, tool.name);
      const result = await callJsonRpc(server, session, "tools/call", {
        name: remoteToolName,
        arguments: input,
      });

      return {
        content: normalizeToolResultContent(result),
        isError: normalizeToolResultIsError(result),
      };
    },
  };
}

async function callJsonRpc(
  server: McpServerConfig,
  session: McpSession,
  method: string,
  params: JsonObject,
): Promise<unknown> {
  if (method !== "initialize" && method !== "notifications/initialized") {
    await ensureMcpSessionInitialized(server, session);
  }

  return sendJsonRpcRequest(server, session, method, params);
}

async function ensureMcpSessionInitialized(
  server: McpServerConfig,
  session: McpSession,
): Promise<void> {
  if (session.initialized) return;

  if (!session.initializePromise) {
    session.initializePromise = (async () => {
      await sendJsonRpcRequest(server, session, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "agent-core",
          version: AGENT_CORE_VERSION,
        },
      });
      await sendJsonRpcNotification(
        server,
        session,
        "notifications/initialized",
      );
      session.initialized = true;
    })().finally(() => {
      session.initializePromise = undefined;
    });
  }

  await session.initializePromise;
}

async function sendJsonRpcRequest(
  server: McpServerConfig,
  session: McpSession,
  method: string,
  params: JsonObject,
): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(server.url, {
    method: "POST",
    headers: buildJsonRpcHeaders(server, session),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `MCP ${server.name} ${method} failed: ${response.status} ${response.statusText}`,
    );
  }

  const rpcResponse =
    server.transport === "sse" ||
    response.headers.get("content-type")?.includes("text/event-stream")
      ? await readSseJsonRpcResponse(response, id)
      : ((await response.json()) as JsonRpcResponse);

  captureMcpSessionId(response, session);

  if (rpcResponse.error) {
    throw new Error(
      rpcResponse.error.message ||
        `MCP ${server.name} ${method} failed with JSON-RPC error`,
    );
  }

  return rpcResponse.result;
}

async function sendJsonRpcNotification(
  server: McpServerConfig,
  session: McpSession,
  method: string,
  params?: JsonObject,
): Promise<void> {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
  };
  if (params) {
    body.params = params;
  }

  const response = await fetch(server.url, {
    method: "POST",
    headers: buildJsonRpcHeaders(server, session),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `MCP ${server.name} ${method} failed: ${response.status} ${response.statusText}`,
    );
  }

  captureMcpSessionId(response, session);
  await response.body?.cancel().catch(() => undefined);
}

async function closeMcpSession(
  server: McpServerConfig,
  session: McpSession,
): Promise<void> {
  if (!session.sessionId) return;

  try {
    await fetch(server.url, {
      method: "DELETE",
      headers: buildSessionHeaders(server, session),
    });
  } catch {
    // Best-effort cleanup only.
  } finally {
    session.initialized = false;
    session.sessionId = undefined;
  }
}

function buildJsonRpcHeaders(
  server: McpServerConfig,
  session: McpSession,
): Record<string, string> {
  return {
    ...buildSessionHeaders(server, session),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
}

function buildSessionHeaders(
  server: McpServerConfig,
  session: McpSession,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (server.token) {
    headers.Authorization = `Bearer ${server.token}`;
  }
  if (session.sessionId) {
    headers["Mcp-Session-Id"] = session.sessionId;
  }
  return headers;
}

function captureMcpSessionId(response: Response, session: McpSession): void {
  const sessionId = response.headers.get("Mcp-Session-Id");
  if (sessionId) {
    session.sessionId = sessionId;
  }
}

async function readSseJsonRpcResponse(
  response: Response,
  id: string,
): Promise<JsonRpcResponse> {
  if (!response.body) {
    throw new Error("MCP SSE response did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") continue;

      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (parsed.id === id || parsed.id == null) {
        return parsed;
      }
    }
  }

  throw new Error("MCP SSE response ended before JSON-RPC result arrived");
}

function normalizeToolList(result: unknown): McpToolDefinition[] {
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { tools?: unknown }).tools)
  ) {
    return (result as { tools: McpToolDefinition[] }).tools;
  }
  if (Array.isArray(result)) {
    return result as McpToolDefinition[];
  }
  return [];
}

function normalizeInputSchema(schema: JsonObject | undefined): JsonObject {
  if (schema && typeof schema === "object") {
    return schema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function normalizeToolResultContent(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return (result as { content: unknown[] }).content
      .map((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return (item as { text: string }).text;
        }
        return stringifyForToolResult(item);
      })
      .join("\n");
  }
  return typeof result === "string" ? result : stringifyForToolResult(result);
}

function normalizeToolResultIsError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

function namespacedToolName(serverName: string, toolName: string): string {
  return `${sanitizeName(serverName)}__${sanitizeName(toolName)}`;
}

function denamespaceToolName(serverName: string, namespacedName: string): string {
  const prefix = `${sanitizeName(serverName)}__`;
  return namespacedName.startsWith(prefix)
    ? namespacedName.slice(prefix.length)
    : namespacedName;
}

function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || "mcp_tool";
}
