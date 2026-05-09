# agent-core CLI

A terminal wrapper around the `@agent-core/core` library. Provides an interactive REPL, session management, and all of agent-core's tools over the command line.

---

## Quick Start

```sh
cd agent-wrappers/cli
npm install
npm run dev -- --prompt "list files in the current directory"
```

One-shot with a specific model:

```sh
npm run dev -- --model openai/gpt-4o --prompt "summarize this repo"
```

Interactive REPL (no `--prompt`):

```sh
npm run dev
```

---

## All Flags

| Flag | Short | Default | Description |
|---|---|---|---|
| `--prompt <text>` | `-p` | — | Run a single prompt and exit |
| `--api-key <key>` | — | env var for provider | API key for the selected provider |
| `--model <provider/model>` | — | `AGENT_CORE_MODEL` → `ANTHROPIC_MODEL` → `claude-sonnet-4-6` | Model to use |
| `--cwd <path>` | — | `process.cwd()` | Working directory for all tool operations |
| `--max-turns <n>` | — | library default (unlimited) | Max model/tool loop iterations per `run()` call |
| `--continue [id]` | `-c` | — | Resume latest session, or a specific session by ID |
| `--resume [id]` | `-r` | — | Interactive session picker, or load by ID |
| `--list-sessions` | — | — | Print saved sessions for this cwd and exit |
| `--permission-mode <mode>` | — | `default` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` |
| `--yes` | `-y` | — | Shorthand for `--permission-mode bypassPermissions` |
| `--tool <name>` | — | all tools | Allow only this tool (repeatable; builds an allowlist) |
| `--disable-tool <name>` | — | none disabled | Disable a tool by name (repeatable) |
| `--verbose` | `-v` | `false` | Print full tool results and token usage after each turn |
| `--help` | `-h` | — | Show help and exit |

Bare model names (without a `/`) are treated as `anthropic/<model>` for backwards compatibility.

---

## Permission Modes

| Mode | Write tools | Destructive tools | Interactive prompt |
|---|---|---|---|
| `default` | prompt | prompt | yes |
| `acceptEdits` | auto-allow | prompt | yes |
| `bypassPermissions` / `-y` | auto-allow | auto-allow | no |
| `plan` | deny | deny | no |

When the interactive permission prompt fires you can answer:

- `y` / `yes` / Enter — allow once
- `a` / `always` — allow and remember for this session
- `n` / `no` — deny (optionally provide guidance for the agent)
- `q` / `quit` — deny and interrupt the run immediately

---

## Interactive Commands

Type any of these in the REPL (Tab-completion is supported):

| Command | Description |
|---|---|
| `/exit` or `/quit` | End the session |
| `/clear` | Clear conversation history and start a new session |
| `/usage` | Print token usage for the current session as JSON |
| `/tools` | List all active tools (respects `--tool` / `--disable-tool`) |
| `/sessions` | List saved sessions for the current cwd |
| `/model <name>` | Switch to a different model mid-session (e.g. `/model openai/gpt-4o`) |

Multi-line input: press Enter after the first line; continue typing. An empty line (Enter on a blank line) submits.

---

## Session Management

Sessions are stored as JSONL transcripts in `.agent-core/sessions/` relative to the working directory (overridable with `AGENT_CORE_HOME`).

### Resuming sessions

```sh
# Resume the most recent session
npm run dev -- --continue

# Resume a specific session by ID prefix
npm run dev -- --continue abc12345

# Interactive picker (shows last 20 sessions)
npm run dev -- --resume

# Resume a specific session via the picker
npm run dev -- --resume abc12345
```

### Listing sessions

```sh
npm run dev -- --list-sessions
```

Output format per session:

```
1. <id-prefix> <updatedAt> <messageCount> msg <model> [- title]
```

### Storage location

Override the default `.agent-core/sessions/` path:

```sh
AGENT_CORE_HOME=/var/agent-sessions npm run dev
```

---

## Tool Filtering

### Allowlist (`--tool`)

Pass `--tool` once per tool name to restrict the agent to only those tools:

```sh
npm run dev -- --tool Read --tool Glob --tool Grep --prompt "find all TODO comments"
```

### Denylist (`--disable-tool`)

Pass `--disable-tool` to remove specific tools while keeping everything else:

```sh
npm run dev -- --disable-tool Bash --disable-tool Write
```

Allowlist and denylist cannot be combined (allowlist takes precedence).

Inspect active tools at any time with the `/tools` command.

---

## Event Output

### Normal output

- A spinner appears while the agent is thinking
- Each tool call is shown as `▶ ToolName` with a brief input summary
- The assistant's text streams to stdout in real time
- A prompt symbol (`❯`) appears when waiting for user input

### Verbose mode (`-v`)

With `--verbose`:
- Full tool input and output are printed for each tool call
- Token usage (input / output / cache) is printed after each agent turn

---

## Examples

### One-shot prompt

```sh
npm run dev -- -p "What is 2 + 2?"
```

### One-shot with a non-default model

```sh
npm run dev -- --model google/gemini-2.0-flash -p "Summarize the README in this repo"
```

### Interactive session with plan mode (read-only)

```sh
npm run dev -- --permission-mode plan
```

The agent can read and search but will not write or run destructive commands.

### Bypass all permission prompts

```sh
npm run dev -- -y
# or
npm run dev -- --permission-mode bypassPermissions
```

### Restrict to search tools only

```sh
npm run dev -- --tool Grep --tool Glob --tool Read
```

### Resume the last session and continue

```sh
npm run dev -- --continue
```

### Resume a specific session by ID

```sh
npm run dev -- --continue a1b2c3d4
```

### Interactive session picker

```sh
npm run dev -- --resume
```

---

## Supported Providers

| Provider | Env key | Model prefix |
|---|---|---|
| anthropic | `ANTHROPIC_API_KEY` | `anthropic/` (or bare model name) |
| openai | `OPENAI_API_KEY` | `openai/` |
| google | `GOOGLE_API_KEY` | `google/` |
| groq | `GROQ_API_KEY` | `groq/` |
| mistral | `MISTRAL_API_KEY` | `mistral/` |
| deepseek | `DEEPSEEK_API_KEY` | `deepseek/` |
| xai | `XAI_API_KEY` | `xai/` |
| openrouter | `OPENROUTER_API_KEY` | `openrouter/` |
| minimax | `MINIMAX_API_KEY` | `minimax/` |
| together | `TOGETHER_API_KEY` | `together/` |

If the key is not set as an environment variable, the CLI will prompt for it interactively (input is hidden).

---

## Environment Variables

| Variable | Description |
|---|---|
| `AGENT_CORE_MODEL` | Default model (overrides built-in default) |
| `ANTHROPIC_MODEL` | Fallback default model (Anthropic convention) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google API key |
| `GROQ_API_KEY` | Groq API key |
| `MISTRAL_API_KEY` | Mistral API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `XAI_API_KEY` | xAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `MINIMAX_API_KEY` | MiniMax API key |
| `TOGETHER_API_KEY` | Together AI API key |
| `AGENT_CORE_HOME` | Override default `.agent-core/sessions/` storage path |

A `.env` file in the `cli/` directory is loaded automatically via `dotenv/config`.
