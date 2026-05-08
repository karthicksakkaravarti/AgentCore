import { AgentCore, type NeutralMessage } from "@agent-core/core";
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type RunPayload = {
  runId: string;
  prompt: string;
  model?: string;
  apiKey?: string;
  messages?: ChatMessage[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_TIMEOUT_MS = 90_000;
const activeRuns = new Map<string, AbortController>();

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: "Agent Desktop",
    backgroundColor: "#f4f6f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (app.isPackaged) {
    await window.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    await window.loadURL("http://127.0.0.1:5173");
  }
}

ipcMain.on("agent:run", async (event, payload: RunPayload) => {
  const abortController = new AbortController();
  activeRuns.set(payload.runId, abortController);
  const timeout = setTimeout(() => {
    abortController.abort(
      new Error(`Agent request timed out after ${RUN_TIMEOUT_MS / 1000} seconds.`),
    );
  }, RUN_TIMEOUT_MS);

  try {
    const agent = new AgentCore({
      apiKey: payload.apiKey,
      model:
        payload.model ??
        process.env.AGENT_CORE_MODEL ??
        process.env.ANTHROPIC_MODEL ??
        "claude-sonnet-4-6",
      persistSession: false,
      allowedTools: ["__none__"],
      abortController,
      initialMessages: toNeutralMessages(payload.messages ?? []),
      customSystemPrompt:
        "You are a helpful desktop assistant. Keep responses practical and concise.",
      onEvent(agentEvent) {
        if (agentEvent.type === "text_delta") {
          event.sender.send(`agent:delta:${payload.runId}`, agentEvent.text);
        }
      },
    });

    const result = await agent.run(payload.prompt);
    event.sender.send(`agent:done:${payload.runId}`, {
      stoppedBy: result.stoppedBy,
      usage: result.usage,
    });
  } catch (error) {
    const message = abortController.signal.aborted
      ? getAbortMessage(abortController.signal.reason)
      : error instanceof Error
        ? error.message
        : String(error);
    event.sender.send(
      `agent:error:${payload.runId}`,
      message,
    );
  } finally {
    clearTimeout(timeout);
    activeRuns.delete(payload.runId);
  }
});

ipcMain.on("agent:cancel", (_event, runId: string) => {
  activeRuns.get(runId)?.abort(new Error("Agent run cancelled."));
});

ipcMain.handle("agent:defaults", () => ({
  model:
    process.env.AGENT_CORE_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    "claude-sonnet-4-6",
}));

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

function toNeutralMessages(messages: ChatMessage[]): NeutralMessage[] {
  return messages.slice(-20).map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
}

function getAbortMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Agent run cancelled.";
}
