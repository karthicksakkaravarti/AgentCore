import { Monitor, Send, Settings2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Open a local conversation and ask the embedded agent to help.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const cancelRunRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    void window.agentDesktop.getDefaults().then((defaults) => {
      if (active) setModel(defaults.model);
    });
    return () => {
      active = false;
    };
  }, []);

  function runAgent() {
    const prompt = draft.trim();
    if (!prompt || isRunning) return;

    const history = messages;
    setMessages([...messages, { role: "user", content: prompt }, { role: "assistant", content: "" }]);
    setDraft("");
    setIsRunning(true);

    cancelRunRef.current = window.agentDesktop.run(
      {
        prompt,
        model: model.trim() || undefined,
        apiKey: apiKey || undefined,
        messages: history,
      },
      {
        onDelta(text) {
          setMessages((current) => appendAssistantDelta(current, text));
        },
        onDone() {
          cancelRunRef.current = null;
          setIsRunning(false);
        },
        onError(message) {
          setMessages((current) => appendAssistantDelta(current, message));
          cancelRunRef.current = null;
          setIsRunning(false);
        },
      },
    );
  }

  function cancelRun() {
    cancelRunRef.current?.();
    cancelRunRef.current = null;
    setIsRunning(false);
    setMessages((current) => appendAssistantDelta(current, "Cancelled."));
  }

  return (
    <main className="desktopShell">
      <aside className="navPane">
        <div className="mark">
          <Monitor size={19} />
          <span>Agent Desktop</span>
        </div>
        <button className="navButton active" type="button">
          Chat
        </button>
        <button className="navButton" type="button">
          Runs
        </button>
        <button className="navButton" type="button">
          Memory
        </button>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div>
            <h1>Local Agent</h1>
            <p>Desktop wrapper sample</p>
          </div>
          <Settings2 size={20} />
        </header>

        <div className="configBar">
          <label>
            <span>Model</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Uses AGENT_CORE_MODEL when empty"
              spellCheck={false}
            />
          </label>
          <label>
            <span>API key</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Uses provider env var when empty"
              spellCheck={false}
              type="password"
            />
          </label>
        </div>

        <div className="transcript">
          {messages.map((message, index) => (
            <div className={`bubble ${message.role}`} key={index}>
              {message.content || (message.role === "assistant" ? "..." : "")}
            </div>
          ))}
        </div>

        <form
          className="inputDock"
          onSubmit={(event) => {
            event.preventDefault();
            runAgent();
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask the desktop agent"
            rows={3}
          />
          <button
            disabled={!isRunning && !draft.trim()}
            onClick={isRunning ? cancelRun : undefined}
            type={isRunning ? "button" : "submit"}
          >
            {isRunning ? <Square size={18} /> : <Send size={18} />}
            <span>{isRunning ? "Stop" : "Send"}</span>
          </button>
        </form>
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
