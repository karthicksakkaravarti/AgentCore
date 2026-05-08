# React Desktop Wrapper

This sample runs `agent-core` in the Electron main process and streams text deltas to a React renderer through IPC.

```sh
cd agent-wrappers/react-desktop
npm install
npm run dev
```

Set a provider key before starting, or paste one into the app:

```sh
export OPENAI_API_KEY="sk-..."
export AGENT_CORE_MODEL="openai/gpt-4o"
```
