import type { AgentTool } from "../types.js";
import { asBoolean, asNumber, asString, truncateMiddle } from "../utils/json.js";

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
    const cwd = input.path
      ? context.workspace.resolvePath(asString(input.path), context.cwd)
      : context.cwd;
    const matches = await context.workspace.list(pattern, {
      cwd,
      includeDirectories: true,
      limit: 5000,
    });
    const sorted = matches
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 1000)
      .map(({ path }) => path);

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
    const target = input.path
      ? context.workspace.resolvePath(asString(input.path), context.cwd)
      : context.cwd;
    const mode = asString(input.output_mode, "files_with_matches");

    const regex = new RegExp(
      pattern,
      `${input["-i"] ? "i" : ""}${input.multiline ? "s" : ""}`,
    );
    const before = asNumber(input["-B"], asNumber(input["-C"], 0, { min: 0, max: 50 }), {
      min: 0,
      max: 50,
    });
    const after = asNumber(input["-A"], asNumber(input["-C"], 0, { min: 0, max: 50 }), {
      min: 0,
      max: 50,
    });
    const files = await collectSearchFiles(input, context, target);
    const matches = await grepFiles(files, regex, {
      workspace: context.workspace,
      mode,
      showLineNumbers: asBoolean(input["-n"], true),
      before,
      after,
      multiline: asBoolean(input.multiline),
    });

    if (matches.length === 0) {
      return { content: `No matches for ${JSON.stringify(pattern)} in ${target}.` };
    }

    const limit = input.head_limit
      ? asNumber(input.head_limit, 100, { min: 1, max: 5000 })
      : undefined;
    const limited = limit ? matches.slice(0, limit) : matches;
    const suffix =
      limit && matches.length > limit
        ? `\n... ${matches.length - limit} more line${matches.length - limit === 1 ? "" : "s"}`
        : "";
    return { content: truncateMiddle(limited.join("\n") + suffix, 40000) };
  },
};

async function collectSearchFiles(
  input: Record<string, unknown>,
  context: Parameters<AgentTool["execute"]>[1],
  target: string,
): Promise<string[]> {
  const targetStat = await context.workspace.stat(target).catch(() => null);
  const files =
    targetStat?.type === "file"
      ? [{ path: target, type: "file" as const, size: targetStat.size, mtimeMs: targetStat.mtimeMs }]
      : await context.workspace.list(asString(input.glob, "**/*"), {
          cwd: target,
          limit: 5000,
        });
  const type = asString(input.type);
  return files
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path)
    .filter((filePath) => matchesFileType(filePath, type));
}

async function grepFiles(
  files: string[],
  regex: RegExp,
  options: {
    workspace: Parameters<AgentTool["execute"]>[1]["workspace"];
    mode: string;
    showLineNumbers: boolean;
    before: number;
    after: number;
    multiline: boolean;
  },
): Promise<string[]> {
  const output: string[] = [];
  for (const filePath of files) {
    const text = await options.workspace.read(filePath).catch(() => "");
    if (!text) continue;
    if (options.multiline) {
      if (!regex.test(text)) continue;
      if (options.mode === "files_with_matches") output.push(filePath);
      else if (options.mode === "count") output.push(`${filePath}:1`);
      else output.push(filePath);
      continue;
    }

    const lines = text.split(/\r?\n/);
    const matchedLineIndexes: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      regex.lastIndex = 0;
      if (regex.test(lines[index] ?? "")) matchedLineIndexes.push(index);
    }
    if (matchedLineIndexes.length === 0) continue;
    if (options.mode === "files_with_matches") {
      output.push(filePath);
      continue;
    }
    if (options.mode === "count") {
      output.push(`${filePath}:${matchedLineIndexes.length}`);
      continue;
    }
    for (const lineIndex of matchedLineIndexes) {
      const start = Math.max(0, lineIndex - options.before);
      const end = Math.min(lines.length - 1, lineIndex + options.after);
      for (let index = start; index <= end; index += 1) {
        const separator = index === lineIndex ? ":" : "-";
        const lineNumber = options.showLineNumbers ? `${index + 1}${separator}` : "";
        output.push(`${filePath}:${lineNumber}${lines[index] ?? ""}`);
      }
    }
  }
  return output;
}

function matchesFileType(filePath: string, type: string): boolean {
  if (!type) return true;
  const extension = filePath.toLowerCase().split(".").at(-1);
  const typeExtensions: Record<string, string[]> = {
    js: ["js", "jsx", "mjs", "cjs"],
    ts: ["ts", "tsx", "mts", "cts"],
    py: ["py"],
    rust: ["rs"],
    go: ["go"],
    json: ["json"],
    css: ["css"],
    html: ["html", "htm"],
    md: ["md", "mdx"],
  };
  return typeExtensions[type]?.includes(extension ?? "") ?? true;
}
