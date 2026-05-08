import {
  AgentCore,
  createSessionId,
  DisabledRuntime,
  MemoryWorkspace,
  NullSessionStorage,
  SupabaseSessionStorage,
  SupabaseWorkspace,
  type NeutralMessage,
  type SessionStorageBackend,
  type Workspace,
} from "@agent-core/core";

export const runtime = "nodejs";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatRequest = {
  messages?: ChatMessage[];
  sessionId?: string;
  model?: string;
  apiKey?: string;
};

const SYSTEM_PROMPT = `You are a helpful, intelligent AI assistant. Answer clearly and concisely.`;

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

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const messages = sanitizeMessages(body.messages ?? []);
  const prompt = messages.at(-1)?.content.trim();
  if (!prompt) {
    return Response.json({ error: "Missing prompt" }, { status: 400 });
  }
  const sessionId = body.sessionId ?? createSessionId();
  const workspace = createWorkspace(sessionId);
  const sessionStorage = createSessionStorage();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const textSplitter = createThinkBlockSplitter();
      try {
        const agent = new AgentCore({
          apiKey: body.apiKey,
          model:
            body.model ??
            process.env.AGENT_CORE_MODEL ??
            process.env.ANTHROPIC_MODEL ??
            "claude-sonnet-4-6",
          cwd: "/workspace",
          workspace,
          runtime: new DisabledRuntime(),
          sessionStorage,
          sessionId,
          permissionMode: "acceptEdits",
          allowedTools: SALES_SAFE_TOOLS,
          initialMessages: toNeutralMessages(messages.slice(0, -1)),
          customSystemPrompt: SYSTEM_PROMPT,
          onEvent(event) {
            switch (event.type) {
              case "text_delta": {
                const { visible, thinking } = textSplitter.push(event.text);
                writeTextDelta(controller, encoder, visible);
                writeThinkingDelta(controller, encoder, thinking);
                break;
              }
              case "tool_start":
                writeJson(controller, encoder, {
                  type: "tool_start",
                  id: event.id,
                  name: event.name,
                  input: event.input,
                });
                break;
              case "tool_result":
                writeJson(controller, encoder, {
                  type: "tool_result",
                  id: event.id,
                  name: event.name,
                  ok: event.result.isError !== true,
                  summary: truncate(event.result.content, 200),
                });
                break;
            }
          },
        });

        const result = await agent.run(prompt);
        const flushed = textSplitter.flush();
        writeTextDelta(controller, encoder, flushed.visible);
        writeThinkingDelta(controller, encoder, flushed.thinking);
        writeJson(controller, encoder, {
          type: "done",
          sessionId: result.sessionId,
          stoppedBy: result.stoppedBy,
          usage: result.usage,
        });
      } catch (error) {
        writeJson(controller, encoder, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

function createWorkspace(sessionId: string): Workspace {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    return new SupabaseWorkspace({
      url: supabaseUrl,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      anonKey: process.env.SUPABASE_ANON_KEY,
      bucket: process.env.SUPABASE_WORKSPACE_BUCKET ?? "agent-workspaces",
      tenantId: process.env.AGENT_CORE_TENANT_ID ?? "local-dev",
      sessionId,
    });
  }
  if (!supabaseUrl) {
    console.warn(
      "[next-sales-chat] SUPABASE_URL not set -- falling back to MemoryWorkspace; generated files will not persist.",
    );
  } else {
    console.warn(
      "[next-sales-chat] Supabase key not set -- falling back to MemoryWorkspace; generated files will not persist.",
    );
  }
  return new MemoryWorkspace();
}

function createSessionStorage(): SessionStorageBackend {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    return new SupabaseSessionStorage({
      url: supabaseUrl,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      anonKey: process.env.SUPABASE_ANON_KEY,
      tenantId: process.env.AGENT_CORE_TENANT_ID ?? "local-dev",
    });
  }
  if (!supabaseUrl) {
    console.warn(
      "[next-sales-chat] SUPABASE_URL not set -- falling back to NullSessionStorage; chat transcripts will not persist.",
    );
  } else {
    console.warn(
      "[next-sales-chat] Supabase key not set -- falling back to NullSessionStorage; chat transcripts will not persist.",
    );
  }
  return new NullSessionStorage();
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string",
    )
    .slice(-20);
}

function toNeutralMessages(messages: ChatMessage[]): NeutralMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
}

function writeJson(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  payload: unknown,
): void {
  controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
}

function writeTextDelta(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  text: string,
): void {
  if (!text) return;
  writeJson(controller, encoder, { type: "text_delta", text });
}

function writeThinkingDelta(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  text: string,
): void {
  if (!text) return;
  writeJson(controller, encoder, { type: "thinking_delta", text });
}

function truncate(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max - 1)}...`;
}

type SplitResult = { visible: string; thinking: string };

function createThinkBlockSplitter(): {
  push(text: string): SplitResult;
  flush(): SplitResult;
} {
  const openTag = "<think>";
  const closeTag = "</think>";
  let buffer = "";
  let insideThinkBlock = false;

  return {
    push(text: string): SplitResult {
      buffer += text;
      let visible = "";
      let thinking = "";

      for (;;) {
        if (insideThinkBlock) {
          const closeIndex = buffer.indexOf(closeTag);
          if (closeIndex === -1) {
            thinking += buffer.slice(0, buffer.length - keepPotentialTagPrefix(buffer, closeTag).length);
            buffer = keepPotentialTagPrefix(buffer, closeTag);
            return { visible, thinking };
          }
          thinking += buffer.slice(0, closeIndex);
          buffer = buffer.slice(closeIndex + closeTag.length);
          insideThinkBlock = false;
          continue;
        }

        const openIndex = buffer.indexOf(openTag);
        if (openIndex === -1) {
          const suffix = keepPotentialTagPrefix(buffer, openTag);
          visible += buffer.slice(0, buffer.length - suffix.length);
          buffer = suffix;
          return { visible, thinking };
        }

        visible += buffer.slice(0, openIndex);
        buffer = buffer.slice(openIndex + openTag.length);
        insideThinkBlock = true;
      }
    },
    flush(): SplitResult {
      if (insideThinkBlock) {
        const thinking = buffer;
        buffer = "";
        insideThinkBlock = false;
        return { visible: "", thinking };
      }
      const visible = buffer;
      buffer = "";
      return { visible, thinking: "" };
    },
  };
}

function keepPotentialTagPrefix(text: string, tag: string): string {
  const maxLength = Math.min(text.length, tag.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (tag.startsWith(suffix)) return suffix;
  }
  return "";
}
