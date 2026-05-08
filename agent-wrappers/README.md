# Agent Wrappers

These packages demonstrate `agent-core` as a reusable library in different host environments.

- `cli` - terminal wrapper moved out of `agent-core`
- `next-sales-chat` - Next.js sales chat interface backed by an API route
- `react-desktop` - Electron + React desktop shell backed by the Electron main process

The wrappers choose the workspace/runtime/session backends for their environment. CLI and desktop use local filesystem/runtime defaults. The Next.js wrapper uses a web-safe `/workspace`, disabled shell execution, and Supabase Storage when `SUPABASE_URL` plus a Supabase key are present.

Each wrapper depends on the local library package:

```sh
"@agent-core/core": "file:../../agent-core"
```

Build the library first when running a wrapper directly:

```sh
cd agent-core
npm install
npm run build
```
