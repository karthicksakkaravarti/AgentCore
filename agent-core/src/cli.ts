#!/usr/bin/env node
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentCore } from "./agent.js";
import {
  listSessions,
  loadLatestSession,
  loadSessionById,
  type LoadedSession,
  type SessionSummary,
} from "./sessionStorage.js";
import type {
  AgentEvent,
  AgentTool,
  JsonObject,
  PermissionDecision,
  PermissionMode,
} from "./types.js";
import { truncateMiddle } from "./utils/json.js";

type CliArgs = {
  apiKey?: string;
  model?: string;
  cwd?: string;
  maxTurns?: number;
  permissionMode: PermissionMode;
  prompt?: string;
  continueSession?: string | true;
  resumeSession?: string | true;
  listSessionsOnly: boolean;
  allowedTools?: string[];
  disabledTools?: string[];
  verbose: boolean;
  help: boolean;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const rl = readline.createInterface({ input, output });
  const cwd = args.cwd ?? process.cwd();

  if (args.listSessionsOnly) {
    printSessionList(await listSessions(cwd));
    rl.close();
    return;
  }

  const restored = await resolveSessionSelection(args, rl, cwd);
  const apiKey =
    args.apiKey ??
    process.env.ANTHROPIC_API_KEY ??
    (await questionHidden("Anthropic API key: "));

  const agent = new AgentCore({
    apiKey,
    model: args.model ?? restored?.metadata.model,
    cwd,
    sessionId: restored?.metadata.sessionId,
    initialMessages: restored?.messages,
    initialUsage: restored?.usage,
    maxTurns: args.maxTurns,
    permissionMode: args.permissionMode,
    allowedTools: args.allowedTools,
    disabledTools: args.disabledTools,
    askUser: async (question) => {
      output.write(`\nagent asks> ${question}\n`);
      return rl.question("you> ");
    },
    permissionPrompt: async (tool, toolInput, options) =>
      promptForPermission(rl, tool, toolInput, options.reason),
    onEvent: createEventPrinter(args.verbose),
  });

  output.write(
    `Agent core ready. Model: ${args.model ?? restored?.metadata.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"}\n`,
  );
  output.write(`CWD: ${cwd}\n`);
  output.write(`Session: ${agent.getSessionInfo().sessionId}\n`);
  output.write(`Transcript: ${agent.getSessionInfo().path}\n`);
  output.write(`Tools: ${agent.listTools().join(", ")}\n`);
  if (restored) {
    output.write(`Resumed ${restored.messages.length} prior message(s).\n`);
  }

  if (args.prompt) {
    const result = await agent.run(args.prompt);
    if (result.stoppedBy !== "end_turn") {
      output.write(`\nStopped by ${result.stoppedBy}.\n`);
    }
    rl.close();
    return;
  }

  output.write("\nType /exit to quit, /clear to reset history, /usage for token usage.\n\n");
  for (;;) {
    const prompt = (await rl.question("you> ")).trim();
    if (!prompt) continue;
    if (prompt === "/exit" || prompt === "/quit") break;
    if (prompt === "/clear") {
      agent.clearHistory();
      output.write(`Conversation history cleared. New session: ${agent.getSessionInfo().sessionId}\n`);
      continue;
    }
    if (prompt === "/usage") {
      output.write(`${JSON.stringify(agent.getUsage(), null, 2)}\n`);
      continue;
    }
    if (prompt === "/tools") {
      output.write(`${agent.listTools().join("\n")}\n`);
      continue;
    }
    if (prompt === "/sessions") {
      printSessionList(await listSessions(cwd));
      continue;
    }
    if (prompt.startsWith("/model ")) {
      const model = prompt.slice("/model ".length).trim();
      agent.setModel(model);
      output.write(`Model set to ${model}\n`);
      continue;
    }

    const result = await agent.run(prompt);
    if (result.stoppedBy !== "end_turn") {
      output.write(`\nStopped by ${result.stoppedBy}.\n`);
    }
    output.write("\n");
  }

  rl.close();
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    permissionMode: "default",
    listSessionsOnly: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? "";
    const optionalNext = (): string | true => {
      const value = argv[i + 1];
      if (value && !value.startsWith("-")) {
        i += 1;
        return value;
      }
      return true;
    };
    switch (arg) {
      case "--api-key":
        args.apiKey = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--cwd":
        args.cwd = next();
        break;
      case "--max-turns":
        args.maxTurns = Number(next());
        break;
      case "--permission-mode":
        args.permissionMode = parsePermissionMode(next());
        break;
      case "--yes":
      case "-y":
        args.permissionMode = "bypassPermissions";
        break;
      case "--prompt":
      case "-p":
        args.prompt = next();
        break;
      case "--continue":
      case "-c":
        args.continueSession = optionalNext();
        break;
      case "--resume":
      case "-r":
        args.resumeSession = optionalNext();
        break;
      case "--list-sessions":
        args.listSessionsOnly = true;
        break;
      case "--tool":
        args.allowedTools = [...(args.allowedTools ?? []), next()];
        break;
      case "--disable-tool":
        args.disabledTools = [...(args.disabledTools ?? []), next()];
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          args.prompt = [arg, ...argv.slice(i + 1)].join(" ");
          i = argv.length;
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return args;
}

function parsePermissionMode(value: string): PermissionMode {
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan"
  ) {
    return value;
  }
  throw new Error(`Invalid permission mode: ${value}`);
}

async function resolveSessionSelection(
  args: CliArgs,
  rl: readline.Interface,
  cwd: string,
): Promise<LoadedSession | undefined> {
  if (args.continueSession && args.resumeSession) {
    throw new Error("Use either --continue or --resume, not both.");
  }

  if (args.continueSession) {
    if (args.continueSession === true) {
      const latest = await loadLatestSession(cwd);
      if (!latest) throw new Error("No previous sessions found for this cwd.");
      return latest;
    }
    return loadSessionById(cwd, args.continueSession);
  }

  if (args.resumeSession) {
    if (args.resumeSession !== true) {
      return loadSessionById(cwd, args.resumeSession);
    }
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      throw new Error("No previous sessions found for this cwd.");
    }
    printSessionList(sessions.slice(0, 20));
    const answer = (await rl.question("Resume session number or id: ")).trim();
    const index = Number(answer);
    const selected =
      Number.isInteger(index) && index >= 1 && index <= sessions.length
        ? sessions[index - 1]
        : sessions.find((session) => session.sessionId.startsWith(answer));
    if (!selected) {
      throw new Error(`No session matched ${JSON.stringify(answer)}.`);
    }
    return loadSessionById(cwd, selected.sessionId);
  }

  return undefined;
}

function printSessionList(sessions: SessionSummary[]): void {
  if (sessions.length === 0) {
    output.write("No saved sessions for this cwd.\n");
    return;
  }
  output.write("Saved sessions:\n");
  sessions.forEach((session, index) => {
    output.write(`${index + 1}. ${formatSessionSummary(session)}\n`);
  });
}

function formatSessionSummary(session: SessionSummary): string {
  const date = session.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const title = session.title ? ` - ${session.title}` : "";
  return `${session.sessionId.slice(0, 8)} ${date} ${session.messageCount} msg ${session.model}${title}`;
}

async function promptForPermission(
  rl: readline.Interface,
  tool: AgentTool,
  inputValue: JsonObject,
  reason: string,
): Promise<PermissionDecision> {
  output.write(`\nTool permission requested: ${tool.name}\n`);
  output.write(`${reason}\n`);
  output.write(`${truncateMiddle(JSON.stringify(inputValue, null, 2), 4000)}\n`);
  const answer = (
    await rl.question("Allow? [y]es / [a]lways / [n]o / [q]uit: ")
  )
    .trim()
    .toLowerCase();
  if (answer === "a" || answer === "always") {
    return { behavior: "allow", remember: true };
  }
  if (answer === "y" || answer === "yes" || answer === "") {
    return { behavior: "allow" };
  }
  if (answer === "q" || answer === "quit") {
    return { behavior: "deny", message: "User quit during permission prompt.", interrupt: true };
  }
  const message = await rl.question("Optional denial guidance: ");
  return {
    behavior: "deny",
    message: message || `User denied ${tool.name}.`,
  };
}

function createEventPrinter(verbose: boolean): (event: AgentEvent) => void {
  return (event) => {
    switch (event.type) {
      case "request":
        output.write(`\n[turn ${event.turn}] ${event.model}\n`);
        break;
      case "assistant_text":
        output.write(`\n${event.text}\n`);
        break;
      case "tool_start":
        output.write(
          `\n[tool start] ${event.name} ${truncateMiddle(JSON.stringify(event.input), 1000)}\n`,
        );
        break;
      case "tool_result": {
        const body = verbose
          ? event.result.content
          : event.result.content.split(/\r?\n/).slice(0, 8).join("\n");
        output.write(
          `[tool ${event.result.isError ? "error" : "done"}] ${event.name}\n${truncateMiddle(body, verbose ? 12000 : 2000)}\n`,
        );
        break;
      }
      case "usage":
        if (verbose) output.write(`[usage] ${JSON.stringify(event.usage)}\n`);
        break;
      case "assistant_message":
        break;
    }
  };
}

async function questionHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(question);
    rl.close();
    return answer;
  }

  return new Promise((resolve) => {
    let value = "";
    output.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      const char = chunk.toString("utf8");
      if (char === "\r" || char === "\n" || char === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.off("data", onData);
        output.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u0003") {
        process.exit(130);
      }
      if (char === "\u007f") {
        value = value.slice(0, -1);
        output.write("\b \b");
        return;
      }
      value += char;
      output.write("*");
    };
    process.stdin.on("data", onData);
  });
}

function printHelp(): void {
  output.write(`agent-core

Usage:
  npm run dev -- [options]
  agent-core [options]

Options:
  -p, --prompt <text>             Run a single prompt and exit
      --api-key <key>             Anthropic API key (or ANTHROPIC_API_KEY)
      --model <model>             Model (default: ANTHROPIC_MODEL or claude-sonnet-4-6)
      --cwd <path>                Working directory for tools
      --max-turns <n>             Max model/tool loop turns
  -c, --continue [id]             Continue latest session, or the provided session id/path
  -r, --resume [id]               Pick a session to resume, or load the provided id/path
      --list-sessions             List saved sessions for this cwd and exit
      --permission-mode <mode>    default | acceptEdits | bypassPermissions | plan
  -y, --yes                       Alias for --permission-mode bypassPermissions
      --tool <name>               Allow only this tool; repeatable
      --disable-tool <name>       Disable a tool; repeatable
  -v, --verbose                   Print full tool results and usage
  -h, --help                      Show this help

Interactive commands:
  /exit, /clear, /usage, /tools, /sessions, /model <name>
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
