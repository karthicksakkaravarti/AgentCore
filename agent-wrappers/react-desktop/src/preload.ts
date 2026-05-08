import { contextBridge, ipcRenderer } from "electron";
import crypto from "node:crypto";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type RunPayload = {
  prompt: string;
  model?: string;
  apiKey?: string;
  messages?: ChatMessage[];
};

type RunHandlers = {
  onDelta(text: string): void;
  onDone(payload: unknown): void;
  onError(message: string): void;
};

contextBridge.exposeInMainWorld("agentDesktop", {
  getDefaults() {
    return ipcRenderer.invoke("agent:defaults") as Promise<{ model: string }>;
  },
  run(payload: RunPayload, handlers: RunHandlers) {
    const runId = crypto.randomUUID();
    const deltaChannel = `agent:delta:${runId}`;
    const doneChannel = `agent:done:${runId}`;
    const errorChannel = `agent:error:${runId}`;

    const removeListeners = () => {
      ipcRenderer.removeAllListeners(deltaChannel);
      ipcRenderer.removeAllListeners(doneChannel);
      ipcRenderer.removeAllListeners(errorChannel);
    };

    ipcRenderer.on(deltaChannel, (_event, text: string) => handlers.onDelta(text));
    ipcRenderer.once(doneChannel, (_event, result: unknown) => {
      removeListeners();
      handlers.onDone(result);
    });
    ipcRenderer.once(errorChannel, (_event, message: string) => {
      removeListeners();
      handlers.onError(message);
    });
    ipcRenderer.send("agent:run", { ...payload, runId });
    return () => {
      ipcRenderer.send("agent:cancel", runId);
      removeListeners();
    };
  },
});
