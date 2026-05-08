import type { AgentTool } from "../types.js";
import { asNumber, asString, truncateMiddle } from "../utils/json.js";

function looksDestructive(command: string): boolean {
  return /\b(rm\s+-rf|sudo\b|git\s+push\b|git\s+reset\b|git\s+clean\b|chmod\s+-R|chown\s+-R|mkfs|dd\s+if=|:\(\)\s*\{)/.test(
    command,
  );
}

export const BashTool: AgentTool = {
  name: "Bash",
  description:
    "Execute a shell command in the working directory. Use for tests, builds, package scripts, and git inspection.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute." },
      timeout: {
        type: "number",
        description: "Optional timeout in milliseconds, max 600000.",
      },
      description: {
        type: "string",
        description: "Short human-readable description of what the command does.",
      },
      run_in_background: {
        type: "boolean",
        description:
          "Set true for long-running commands. Use BashOutput to read later output.",
      },
    },
    required: ["command"],
  },
  readOnly: (input) => {
    const command = asString(input.command);
    return /^(pwd|ls\b|find\b|git\s+(status|diff|log|show|branch|rev-parse)\b|cat\b|head\b|tail\b|wc\b|rg\b|grep\b|sed\s+-n\b|npm\s+(test|run|exec)\b|pnpm\s+(test|run|exec)\b|yarn\s+(test|run)\b)/.test(
      command.trim(),
    );
  },
  destructive: (input) => looksDestructive(asString(input.command)),
  concurrencySafe: (input) => !asString(input.command).includes("&&"),
  async execute(input, context) {
    const command = asString(input.command).trim();
    if (!command) return { content: "Missing command.", isError: true };

    if (input.run_in_background === true) {
      const shell = context.runtime.spawn(command, { cwd: context.cwd });
      context.state.backgroundShells.set(shell.id, shell);
      return {
        content: `Started background shell ${shell.id}\nCommand: ${command}`,
      };
    }

    const timeoutMs = asNumber(input.timeout, 120000, {
      min: 1000,
      max: 600000,
    });
    const result = await context.runtime.exec(command, {
      cwd: context.cwd,
      timeoutMs,
      signal: context.abortSignal,
    });
    const parts = [
      `Exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
      result.stdout ? `\nSTDOUT:\n${result.stdout.trimEnd()}` : "",
      result.stderr ? `\nSTDERR:\n${result.stderr.trimEnd()}` : "",
    ];
    return {
      content: truncateMiddle(parts.filter(Boolean).join("\n"), 30000),
      isError: result.exitCode !== 0 || result.timedOut,
    };
  },
};

export const BashOutputTool: AgentTool = {
  name: "BashOutput",
  description: "Read output from a background Bash shell.",
  inputSchema: {
    type: "object",
    properties: {
      bash_id: { type: "string", description: "Background shell ID." },
      filter: {
        type: "string",
        description: "Optional regular expression for filtering output lines.",
      },
    },
    required: ["bash_id"],
  },
  readOnly: true,
  concurrencySafe: true,
  async execute(input, context) {
    const id = asString(input.bash_id);
    const shell = context.state.backgroundShells.get(id);
    if (!shell) return { content: `Unknown background shell: ${id}`, isError: true };

    const allLines = [
      ...shell.stdout.map((line) => `stdout: ${line}`),
      ...shell.stderr.map((line) => `stderr: ${line}`),
    ];
    const unread = allLines.slice(shell.readCursor);
    shell.readCursor = allLines.length;

    const filter = asString(input.filter);
    const filtered = filter
      ? unread.filter((line) => new RegExp(filter).test(line))
      : unread;

    return {
      content: [
        `Shell ${id}: ${shell.done ? `done (exit ${shell.exitCode})` : "running"}`,
        `Command: ${shell.command}`,
        filtered.length ? `\n${filtered.join("\n")}` : "\n(no new output)",
      ].join("\n"),
    };
  },
};

export const KillShellTool: AgentTool = {
  name: "KillShell",
  description: "Terminate a background shell started by Bash.",
  inputSchema: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "Background shell ID to kill." },
    },
    required: ["shell_id"],
  },
  readOnly: false,
  destructive: true,
  async execute(input, context) {
    const id = asString(input.shell_id);
    const shell = context.state.backgroundShells.get(id);
    if (!shell) return { content: `Unknown background shell: ${id}`, isError: true };
    shell.kill();
    return { content: `Sent SIGTERM to ${id}.` };
  },
};
