"use client";

import { Check, Loader2, RefreshCw, Send, Sparkles, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";

type ToolActivity = {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  summary?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolActivity[];
};

type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "done"; sessionId: string; stoppedBy: string; usage: unknown }
  | { type: "error"; message: string };

const leads = [
  {
    name: "Maya Chen",
    company: "Northstar Foods",
    stage: "Procurement review",
    value: "$84k",
    tone: "Cost-sensitive",
  },
  {
    name: "Arjun Patel",
    company: "HelioGrid",
    stage: "Security validation",
    value: "$126k",
    tone: "Technical buyer",
  },
  {
    name: "Lena Ortiz",
    company: "Brightline Health",
    stage: "Champion mapping",
    value: "$42k",
    tone: "Relationship-led",
  },
];

const starters = [
  "Draft a follow-up after a pricing objection.",
  "Summarize the deal risk and next best action.",
  "Write a concise executive recap for this lead.",
];

export default function SalesChatPage() {
  const [selectedLead, setSelectedLead] = useState(leads[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Pick a lead and ask for a reply, recap, objection plan, or next action.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [model, setModel] = useState("openai/gpt-4o");
  const [sessionId, setSessionId] = useState<string>();

  const pipelineTotal = useMemo(
    () => leads.reduce((sum, lead) => sum + Number(lead.value.replace(/\D/g, "")), 0),
    [],
  );

  async function sendMessage(text = draft) {
    const prompt = text.trim();
    if (!prompt || isRunning) return;
    const nextMessages = [...messages, { role: "user" as const, content: prompt }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setDraft("");
    setIsRunning(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          sessionId,
          model,
          lead: selectedLead,
        }),
      });

      if (!response.body) throw new Error("No response stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;
          switch (event.type) {
            case "text_delta":
              setMessages((current) => appendAssistantDelta(current, event.text));
              break;
            case "tool_start":
              setMessages((current) =>
                appendAssistantToolStart(current, {
                  id: event.id,
                  name: event.name,
                  status: "running",
                  summary: formatToolInput(event.input),
                }),
              );
              break;
            case "tool_result":
              setMessages((current) =>
                appendAssistantToolResult(current, {
                  id: event.id,
                  name: event.name,
                  status: event.ok ? "ok" : "error",
                  summary: event.summary,
                }),
              );
              break;
            case "done":
              setSessionId(event.sessionId);
              break;
            case "error":
              setMessages((current) =>
                appendAssistantDelta(current, `\n${event.message}`),
              );
              break;
          }
        }
      }
    } catch (error) {
      setMessages((current) =>
        appendAssistantDelta(
          current,
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="shell">
      <aside className="leadRail" aria-label="Leads">
        <div className="brand">
          <Sparkles size={18} />
          <span>Sales Desk</span>
        </div>
        <div className="metric">
          <span>Pipeline</span>
          <strong>${pipelineTotal}k</strong>
        </div>
        <div className="leadList">
          {leads.map((lead) => (
            <button
              className={lead.name === selectedLead.name ? "lead active" : "lead"}
              key={lead.name}
              onClick={() => setSelectedLead(lead)}
              type="button"
            >
              <UserRound size={18} />
              <span>
                <strong>{lead.name}</strong>
                <small>{lead.company}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="chatPane" aria-label="Chat">
        <header className="chatHeader">
          <div>
            <h1>{selectedLead.company}</h1>
            <p>
              {selectedLead.stage} / {selectedLead.value}
            </p>
          </div>
          <label>
            <span>Model</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              spellCheck={false}
            />
          </label>
        </header>

        <div className="messages">
          {messages.map((message, index) => (
            <div className={`message ${message.role}`} key={index}>
              {message.tools && message.tools.length > 0 ? (
                <div className="toolList">
                  {message.tools.map((tool) => (
                    <div className={`toolChip ${tool.status}`} key={tool.id}>
                      {tool.status === "running" ? (
                        <Loader2 size={14} />
                      ) : tool.status === "ok" ? (
                        <Check size={14} />
                      ) : (
                        <X size={14} />
                      )}
                      <span className="toolName">{tool.name}</span>
                      {tool.summary ? <span>{tool.summary}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {message.content ||
                (message.role === "assistant" && !message.tools?.length ? "..." : "")}
            </div>
          ))}
        </div>

        <div className="starterRow">
          {starters.map((starter) => (
            <button
              key={starter}
              onClick={() => sendMessage(starter)}
              type="button"
              disabled={isRunning}
            >
              {starter}
            </button>
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about this opportunity"
            rows={3}
          />
          <button disabled={isRunning || !draft.trim()} type="submit">
            {isRunning ? <RefreshCw size={18} /> : <Send size={18} />}
            <span>{isRunning ? "Running" : "Send"}</span>
          </button>
        </form>
      </section>

      <aside className="insightPane" aria-label="Opportunity">
        <h2>{selectedLead.name}</h2>
        <dl>
          <div>
            <dt>Stage</dt>
            <dd>{selectedLead.stage}</dd>
          </div>
          <div>
            <dt>Value</dt>
            <dd>{selectedLead.value}</dd>
          </div>
          <div>
            <dt>Style</dt>
            <dd>{selectedLead.tone}</dd>
          </div>
        </dl>
      </aside>
    </main>
  );
}

function appendAssistantDelta(messages: ChatMessage[], text: string): ChatMessage[] {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role === "assistant") {
    next[next.length - 1] = { ...last, content: last.content + text };
  }
  return next;
}

function appendAssistantToolStart(
  messages: ChatMessage[],
  tool: ToolActivity,
): ChatMessage[] {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role !== "assistant") return next;
  next[next.length - 1] = {
    ...last,
    tools: [...(last.tools ?? []), tool],
  };
  return next;
}

function appendAssistantToolResult(
  messages: ChatMessage[],
  tool: ToolActivity,
): ChatMessage[] {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role !== "assistant") return next;
  const tools = last.tools ?? [];
  const index = tools.findIndex((item) => item.id === tool.id);
  next[next.length - 1] = {
    ...last,
    tools:
      index >= 0
        ? tools.map((item) => (item.id === tool.id ? { ...item, ...tool } : item))
        : [...tools, tool],
  };
  return next;
}

function formatToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  const path =
    value.file_path ??
    value.path ??
    value.pattern ??
    value.url ??
    value.todo ??
    value.content;
  return typeof path === "string" ? path.replace(/^\/workspace\//, "") : "";
}
