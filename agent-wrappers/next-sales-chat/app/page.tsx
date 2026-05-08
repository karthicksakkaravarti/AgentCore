"use client";

import { Check, Loader2, RefreshCw, Sparkles, X, MessageSquare, ArrowUp, Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

type ToolActivity = {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  summary?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolActivity[];
};

type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  sessionId?: string;
};

type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "done"; sessionId: string; stoppedBy: string; usage: unknown }
  | { type: "error"; message: string };

const capabilityCards = [
  { title: "Explain a concept", desc: "Break down complex topics" },
  { title: "Write some code", desc: "Build applications and scripts" },
  { title: "Summarize text", desc: "Get the key points quickly" },
  { title: "Brainstorm ideas", desc: "Generate creative concepts" },
];

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeConversation = conversations.find(c => c.id === activeId);
  const messages = activeConversation?.messages ?? [];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleNewChat = () => {
    const newId = Date.now().toString();
    const newConv: Conversation = { id: newId, title: "New Chat", messages: [] };
    setConversations([newConv, ...conversations]);
    setActiveId(newId);
    setSidebarOpen(false);
  };

  async function sendMessage(text = draft) {
    const prompt = text.trim();
    if (!prompt || isRunning) return;
    
    let currentActiveId = activeId;
    let currentConversations = [...conversations];
    let currentConv = currentConversations.find(c => c.id === currentActiveId);
    
    if (!currentConv || !currentActiveId) {
      currentActiveId = Date.now().toString();
      currentConv = { 
        id: currentActiveId, 
        title: prompt.slice(0, 40) + (prompt.length > 40 ? "..." : ""), 
        messages: [] 
      };
      currentConversations = [currentConv, ...currentConversations];
      setActiveId(currentActiveId);
    } else if (currentConv.messages.length === 0) {
      currentConv.title = prompt.slice(0, 40) + (prompt.length > 40 ? "..." : "");
    }
    
    const nextMessages = [...currentConv.messages, { role: "user" as const, content: prompt }];
    
    currentConv.messages = [...nextMessages, { role: "assistant" as const, content: "" }];
    setConversations(currentConversations);
    setDraft("");
    setIsRunning(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          sessionId: currentConv.sessionId,
          model,
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
          
          if (event.type === "text_delta" || event.type === "thinking_delta") {
            flushSync(() => {
              setConversations(prevConvs => {
                const nextConvs = [...prevConvs];
                const convIndex = nextConvs.findIndex(c => c.id === currentActiveId);
                if (convIndex === -1) return prevConvs;
                const conv = { ...nextConvs[convIndex] };
                if (event.type === "text_delta") {
                  conv.messages = appendAssistantDelta(conv.messages, event.text);
                } else {
                  conv.messages = appendAssistantThinking(conv.messages, event.text);
                }
                nextConvs[convIndex] = conv;
                return nextConvs;
              });
            });
          } else {
            setConversations(prevConvs => {
              const nextConvs = [...prevConvs];
              const convIndex = nextConvs.findIndex(c => c.id === currentActiveId);
              if (convIndex === -1) return prevConvs;
              const conv = { ...nextConvs[convIndex] };
              switch (event.type) {
                case "tool_start":
                  conv.messages = appendAssistantToolStart(conv.messages, {
                    id: event.id,
                    name: event.name,
                    status: "running",
                    summary: formatToolInput(event.input),
                  });
                  break;
                case "tool_result":
                  conv.messages = appendAssistantToolResult(conv.messages, {
                    id: event.id,
                    name: event.name,
                    status: event.ok ? "ok" : "error",
                    summary: event.summary,
                  });
                  break;
                case "done":
                  conv.sessionId = event.sessionId;
                  break;
                case "error":
                  conv.messages = appendAssistantDelta(conv.messages, `\n${event.message}`);
                  break;
              }
              nextConvs[convIndex] = conv;
              return nextConvs;
            });
          }
        }
      }
    } catch (error) {
      setConversations(prevConvs => {
        const nextConvs = [...prevConvs];
        const convIndex = nextConvs.findIndex(c => c.id === currentActiveId);
        if (convIndex === -1) return prevConvs;
        const conv = { ...nextConvs[convIndex] };
        conv.messages = appendAssistantDelta(
          conv.messages,
          error instanceof Error ? error.message : String(error)
        );
        nextConvs[convIndex] = conv;
        return nextConvs;
      });
    } finally {
      setIsRunning(false);
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const adjustTextareaHeight = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  return (
    <main className="shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} style={sidebarOpen ? { display: 'flex', position: 'absolute', zIndex: 10, height: '100%', width: '260px' } : {}}> 
        <div className="sidebar-header">
          <div className="brand">
            <Sparkles size={20} />
            <span>AI Chat</span>
          </div>
          <button className="new-chat-btn" onClick={handleNewChat} aria-label="New Chat">
            <MessageSquare size={18} />
          </button>
        </div>
        
        <div className="conversation-list">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              className={`conversation-item ${conv.id === activeId ? 'active' : ''}`}
              onClick={() => {
                setActiveId(conv.id);
                setSidebarOpen(false);
              }}
            >
              {conv.title}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-opus-4-7">Claude Opus 4.7</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
            <option value="openai/gpt-4o">GPT-4o</option>
            <option value="minimax/MiniMax-M2.7">MiniMax M2.7</option>
          </select>
        </div>
      </aside>

      <section className="chatArea">
        <div className="mobile-nav">
          <button onClick={() => setSidebarOpen(!sidebarOpen)}>
            <Menu size={20} />
          </button>
          <span style={{ fontWeight: 600 }}>AI Chat</span>
        </div>

        {messages.length === 0 ? (
          <div className="welcomeScreen">
            <h1>How can I help you today?</h1>
            <div className="capability-cards">
              {capabilityCards.map((card, idx) => (
                <div key={idx} className="capability-card" onClick={() => sendMessage(card.title)}>
                  <strong>{card.title}</strong>
                  <span>{card.desc}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages">
            <div className="messages-inner">
              {messages.map((message, index) => (
                <div className={`message ${message.role}`} key={index}>
                  {message.role === "assistant" ? (
                    <div className="assistant-content-wrapper">
                      <div className="assistant-avatar">
                        <Sparkles size={16} />
                      </div>
                      <div className="message-bubble">
                        {message.tools && message.tools.length > 0 ? (
                          <div className="toolList">
                            {message.tools.map((tool) => (
                              <div className={`toolChip ${tool.status}`} key={tool.id}>
                                {tool.status === "running" ? (
                                  <Loader2 size={14} className="animate-spin" />
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
                        {message.thinking && (
                          <ThinkingBlock
                            thinking={message.thinking}
                            isStreaming={isRunning && index === messages.length - 1}
                          />
                        )}
                        {message.content || (message.role === "assistant" && !message.tools?.length ? "..." : "")}
                      </div>
                    </div>
                  ) : (
                    <div className="message-bubble">
                      {message.content}
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        <div className="composer-wrapper">
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendMessage();
            }}
          >
            <textarea
              value={draft}
              onChange={adjustTextareaHeight}
              onKeyDown={handleKeyDown}
              placeholder="Message AI Chat..."
              rows={1}
            />
            <button disabled={isRunning || !draft.trim()} type="submit">
              {isRunning ? <RefreshCw size={16} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </form>
        </div>
      </section>
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

function appendAssistantThinking(messages: ChatMessage[], text: string): ChatMessage[] {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role === "assistant") {
    next[next.length - 1] = { ...last, thinking: (last.thinking ?? "") + text };
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

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <details
      className="thinking-block"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Thinking</summary>
      <div className="thinking-content">{thinking}</div>
    </details>
  );
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
