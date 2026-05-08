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
  lead?: {
    name?: string;
    company?: string;
    stage?: string;
    value?: string;
  };
};

const SALES_SYSTEM_PROMPT = `You are a concise sales copilot inside a CRM chat surface.
Help the seller prepare replies, summarize account context, identify objections, and propose next actions.
Do not claim to have contacted a prospect or changed CRM data unless the user explicitly provides that result.`;

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
      const textFilter = createThinkBlockFilter();
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
          customSystemPrompt: [
            SALES_SYSTEM_PROMPT,
            body.lead ? formatLeadContext(body.lead) : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
          onEvent(event) {
            switch (event.type) {
              case "text_delta":
                writeTextDelta(controller, encoder, textFilter.push(event.text));
                break;
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
        writeTextDelta(controller, encoder, textFilter.flush());
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

function formatLeadContext(lead: NonNullable<ChatRequest["lead"]>): string {
  return [
    "# Current Lead",
    lead.name ? `- Name: ${lead.name}` : undefined,
    lead.company ? `- Company: ${lead.company}` : undefined,
    lead.stage ? `- Stage: ${lead.stage}` : undefined,
    lead.value ? `- Value: ${lead.value}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
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
  writeJson(controller, encoder, {
    type: "text_delta",
    text,
  });
}

function truncate(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max - 1)}...`;
}

function createThinkBlockFilter(): {
  push(text: string): string;
  flush(): string;
} {
  const openTag = "<think>";
  const closeTag = "</think>";
  let buffer = "";
  let insideThinkBlock = false;

  return {
    push(text: string): string {
      buffer += text;
      let visible = "";

      for (;;) {
        if (insideThinkBlock) {
          const closeIndex = buffer.indexOf(closeTag);
          if (closeIndex === -1) {
            buffer = keepPotentialTagPrefix(buffer, closeTag);
            return visible;
          }
          buffer = buffer.slice(closeIndex + closeTag.length);
          insideThinkBlock = false;
          continue;
        }

        const openIndex = buffer.indexOf(openTag);
        if (openIndex === -1) {
          const suffix = keepPotentialTagPrefix(buffer, openTag);
          visible += buffer.slice(0, buffer.length - suffix.length);
          buffer = suffix;
          return visible;
        }

        visible += buffer.slice(0, openIndex);
        buffer = buffer.slice(openIndex + openTag.length);
        insideThinkBlock = true;
      }
    },
    flush(): string {
      if (insideThinkBlock) {
        buffer = "";
        insideThinkBlock = false;
        return "";
      }
      const visible = buffer;
      buffer = "";
      return visible;
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
