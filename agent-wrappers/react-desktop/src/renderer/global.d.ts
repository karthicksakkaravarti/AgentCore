type AgentDesktopMessage = {
  role: "user" | "assistant";
  content: string;
};

type AgentDesktopRunPayload = {
  prompt: string;
  model?: string;
  apiKey?: string;
  messages?: AgentDesktopMessage[];
};

type AgentDesktopRunHandlers = {
  onDelta(text: string): void;
  onDone(payload: unknown): void;
  onError(message: string): void;
};

interface Window {
  agentDesktop: {
    getDefaults(): Promise<{ model: string }>;
    run(
      payload: AgentDesktopRunPayload,
      handlers: AgentDesktopRunHandlers,
    ): () => void;
  };
}
