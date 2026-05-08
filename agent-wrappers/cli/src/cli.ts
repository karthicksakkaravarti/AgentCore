#!/usr/bin/env node
import "dotenv/config";
import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AgentCore,
  listProviders,
  listSessions,
  loadLatestSession,
  loadSessionById,
  parseProviderModel,
  type AgentTool,
  type JsonObject,
  type LoadedSession,
  type PermissionDecision,
  type PermissionMode,
  type SessionSummary,
} from "@agent-core/core";
import chalk from "chalk";
import { printBanner } from "./banner.js";
import { createEventPrinter } from "./events.js";
import { truncateMiddle } from "./format.js";
import * as theme from "./theme.js";

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

const SLASH_COMMANDS = [
  "/exit",
  "/clear",
  "/usage",
  "/tools",
  "/sessions",
  "/model",
];

function completer(line: string): readline.CompleterResult {
  if (line.startsWith("/")) {
    const hits = SLASH_COMMANDS.filter((command) => command.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  }
  return [[], line];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const rl = readlinePromises.createInterface({ input, output, completer });
  const cwd = args.cwd ?? process.cwd();

  if (args.listSessionsOnly) {
    printSessionList(await listSessions(cwd));
    rl.close();
    return;
  }

  const restored = await resolveSessionSelection(args, rl, cwd);
  const selectedModel =
    args.model ??
    restored?.metadata.model ??
    process.env.AGENT_CORE_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    "claude-sonnet-4-6";
  const provider = resolveProviderInfo(selectedModel);
  const apiKey =
    args.apiKey ??
    process.env[provider.envKey] ??
    (await questionHidden(`${provider.id} API key (${provider.envKey}): `));

  const agent = new AgentCore({
    apiKey,
    model: selectedModel,
    cwd,
    sessionId: restored?.metadata.sessionId,
    initialMessages: restored?.messages,
    initialUsage: restored?.usage,
    maxTurns: args.maxTurns,
    permissionMode: args.permissionMode,
    allowedTools: args.allowedTools,
    disabledTools: args.disabledTools,
    askUser: async (question) => {
      output.write(theme.dimText(`\nagent asks> ${question}\n`));
      return rl.question(theme.promptSymbol);
    },
    permissionPrompt: async (tool, toolInput, options) =>
      promptForPermission(rl, tool, toolInput, options.reason),
    onEvent: createEventPrinter(args.verbose),
  });

  printBanner("0.1.0");
  output.write(chalk.bold.green("  Agent ready\n"));
  output.write(theme.dimText(`  Model:   ${selectedModel}\n`));
  output.write(theme.dimText(`  CWD:     ${cwd}\n`));
  output.write(theme.dimText(`  Session: ${agent.getSessionInfo().sessionId}\n`));
  output.write(theme.dimText(`  Log:     ${agent.getSessionInfo().path}\n`));
  output.write(theme.dimText(`  Tools:   ${agent.listTools().join(", ")}\n`));
  if (restored) {
    output.write(theme.dimText(`  Resumed ${restored.messages.length} prior message(s).\n`));
  }
  output.write("\n");

  if (args.prompt) {
    const result = await agent.run(args.prompt);
    if (result.text) output.write("\n");
    if (result.stoppedBy !== "end_turn") {
      output.write(`\nStopped by ${result.stoppedBy}.\n`);
    }
    rl.close();
    return;
  }

  for (;;) {
    const lines: string[] = [];
    const firstLine = (await rl.question(theme.promptSymbol)).trimEnd();
    if (!firstLine) continue;
    lines.push(firstLine);
    if (!firstLine.startsWith("/")) {
      for (;;) {
        const next = (await rl.question(chalk.dim("… "))).trimEnd();
        if (next === "") break;
        lines.push(next);
      }
    }
    const prompt = lines.join("\n").trim();
    if (!prompt) continue;
    if (prompt === "/exit" || prompt === "/quit") break;
    if (prompt === "/clear") {
      agent.clearHistory();
      output.write(
        theme.dimText(
          `Conversation history cleared. New session: ${agent.getSessionInfo().sessionId}\n`,
        ),
      );
      continue;
    }
    if (prompt === "/usage") {
      output.write(theme.dimText(`${JSON.stringify(agent.getUsage(), null, 2)}\n`));
      continue;
    }
    if (prompt === "/tools") {
      output.write(theme.dimText(`${agent.listTools().join("\n")}\n`));
      continue;
    }
    if (prompt === "/sessions") {
      printSessionList(await listSessions(cwd));
      continue;
    }
    if (prompt.startsWith("/model ")) {
      const model = prompt.slice("/model ".length).trim();
      try {
        agent.setModel(model);
        output.write(theme.dimText(`Model set to ${model}\n`));
      } catch (error) {
        output.write(
          theme.errorText(`${error instanceof Error ? error.message : String(error)}\n`),
        );
      }
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
  rl: readlinePromises.Interface,
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
    output.write(theme.dimText("No saved sessions for this cwd.\n"));
    return;
  }
  output.write(theme.dimText("Saved sessions:\n"));
  sessions.forEach((session, index) => {
    output.write(theme.dimText(`${index + 1}. ${formatSessionSummary(session)}\n`));
  });
}

function formatSessionSummary(session: SessionSummary): string {
  const date = session.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const title = session.title ? ` - ${session.title}` : "";
  return `${session.sessionId.slice(0, 8)} ${date} ${session.messageCount} msg ${session.model}${title}`;
}

async function promptForPermission(
  rl: readlinePromises.Interface,
  tool: AgentTool,
  inputValue: JsonObject,
  reason: string,
): Promise<PermissionDecision> {
  const inputStr = truncateMiddle(JSON.stringify(inputValue, null, 2), 4000);
  output.write("\n" + theme.permBoxTop + "\n");
  output.write(
    theme.permBoxSide + " " + theme.permToolName(` Tool: ${tool.name}`) + "\n",
  );
  output.write(theme.permBoxSide + " " + theme.permReason(reason) + "\n");
  output.write(theme.permBoxSide + "\n");
  for (const line of inputStr.split("\n").slice(0, 10)) {
    output.write(theme.permBoxSide + " " + theme.dimText(line) + "\n");
  }
  output.write(theme.permBoxBottom + "\n");
  const answer = (
    await rl.question(chalk.yellow("  Allow? [y]es / [a]lways / [n]o / [q]uit: "))
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
    return {
      behavior: "deny",
      message: "User quit during permission prompt.",
      interrupt: true,
    };
  }
  const message = await rl.question("Optional denial guidance: ");
  return {
    behavior: "deny",
    message: message || `User denied ${tool.name}.`,
  };
}

async function questionHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const rl = readlinePromises.createInterface({ input, output });
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
  const providers = listProviders()
    .map(
      (provider) =>
        `  ${provider.id.padEnd(10)} ${provider.envKey}${
          provider.baseURL ? ` (${provider.baseURL})` : ""
        }`,
    )
    .join("\n");

  output.write(`agent-core

Usage:
  npm run dev -- [options]
  agent-core [options]

Options:
  -p, --prompt <text>             Run a single prompt and exit
      --api-key <key>             API key for the selected provider
      --model <provider/model>    Model (default: AGENT_CORE_MODEL, ANTHROPIC_MODEL, or claude-sonnet-4-6)
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

Provider prefixes:
${providers}

Bare model names are treated as anthropic/<model> for backwards compatibility.
`);
}

function resolveProviderInfo(model: string): ReturnType<typeof listProviders>[number] {
  const { providerId } = parseProviderModel(model);
  const provider = listProviders().find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown provider '${providerId}'`);
  return provider;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
