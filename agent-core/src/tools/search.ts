import fg from "fast-glob";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "../types.js";
import { resolvePath } from "../utils/fs.js";
import { asBoolean, asNumber, asString, truncateMiddle } from "../utils/json.js";
import { execShellCommand } from "../utils/process.js";

export const GlobTool: AgentTool = {
  name: "Glob",
  description:
    'Fast filename search using glob patterns such as "**/*.ts" or "src/**/*.js". Results are sorted by modification time.',
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match." },
      path: {
        type: "string",
        description: "Directory to search in. Defaults to cwd.",
      },
    },
    required: ["pattern"],
  },
  readOnly: true,
  concurrencySafe: true,
  async execute(input, context) {
    const pattern = asString(input.pattern);
    const cwd = input.path ? resolvePath(asString(input.path), context.cwd) : context.cwd;
    const matches = await fg(pattern, {
      cwd,
      absolute: true,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      unique: true,
    });
    const withStats = await Promise.all(
      matches.slice(0, 5000).map(async (file) => ({
        file,
        mtimeMs: await stat(file)
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      })),
    );
    const sorted = withStats
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 1000)
      .map(({ file }) => file);

    return {
      content: sorted.length
        ? sorted.join("\n")
        : `No files matched ${JSON.stringify(pattern)} in ${cwd}.`,
    };
  },
};

export const GrepTool: AgentTool = {
  name: "Grep",
  description:
    "Search file contents with ripgrep. Supports regex, glob filters, type filters, context lines, and output modes.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern." },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to cwd.",
      },
      glob: { type: "string", description: "Glob include filter." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode. Defaults to files_with_matches.",
      },
      "-B": { type: "number", description: "Lines before each match." },
      "-A": { type: "number", description: "Lines after each match." },
      "-C": { type: "number", description: "Lines before and after each match." },
      "-n": { type: "boolean", description: "Show line numbers in content mode." },
      "-i": { type: "boolean", description: "Case insensitive search." },
      type: { type: "string", description: "Ripgrep file type, e.g. js, py, rust." },
      head_limit: { type: "number", description: "Limit output lines." },
      multiline: {
        type: "boolean",
        description: "Enable multiline mode with dot matching newlines.",
      },
    },
    required: ["pattern"],
  },
  readOnly: true,
  concurrencySafe: true,
  async execute(input, context) {
    const pattern = asString(input.pattern);
    const target = input.path ? resolvePath(asString(input.path), context.cwd) : context.cwd;
    const mode = asString(input.output_mode, "files_with_matches");
    const args = ["--color", "never"];

    if (mode === "files_with_matches") args.push("--files-with-matches");
    if (mode === "count") args.push("--count");
    if (mode === "content" && asBoolean(input["-n"], true)) args.push("--line-number");
    if (input.glob) args.push("--glob", asString(input.glob));
    if (input.type) args.push("--type", asString(input.type));
    if (input["-i"]) args.push("-i");
    if (input["-A"] !== undefined) args.push("-A", String(asNumber(input["-A"], 0, { min: 0, max: 50 })));
    if (input["-B"] !== undefined) args.push("-B", String(asNumber(input["-B"], 0, { min: 0, max: 50 })));
    if (input["-C"] !== undefined) args.push("-C", String(asNumber(input["-C"], 0, { min: 0, max: 50 })));
    if (input.multiline) args.push("-U", "--multiline-dotall");
    args.push("--", pattern, target);

    const command = `rg ${args.map(shellQuote).join(" ")}`;
    const result = await execShellCommand(command, {
      cwd: context.cwd,
      timeoutMs: 60000,
      signal: context.abortSignal,
    });

    if (result.exitCode === 1) {
      return { content: `No matches for ${JSON.stringify(pattern)} in ${target}.` };
    }
    if (result.exitCode !== 0) {
      return {
        content: result.stderr || result.stdout || `ripgrep exited ${result.exitCode}`,
        isError: true,
      };
    }

    const limit = input.head_limit
      ? asNumber(input.head_limit, 100, { min: 1, max: 5000 })
      : undefined;
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    const limited = limit ? lines.slice(0, limit) : lines;
    const suffix =
      limit && lines.length > limit
        ? `\n... ${lines.length - limit} more line${lines.length - limit === 1 ? "" : "s"}`
        : "";
    return { content: truncateMiddle(limited.join("\n") + suffix, 40000) };
  },
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
