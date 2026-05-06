import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "../types.js";
import { ensureParentDirectory, formatLineNumber, isDirectory, resolvePath } from "../utils/fs.js";
import { asBoolean, asNumber, asString, truncateMiddle } from "../utils/json.js";

const DEFAULT_READ_LINES = 2000;
const MAX_READ_BYTES = 8 * 1024 * 1024;

export const ReadTool: AgentTool = {
  name: "Read",
  description:
    "Read a local file. Returns text with cat -n style line numbers. Use offset and limit for large files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read.",
      },
      offset: {
        type: "number",
        description: "1-based line number to start reading from.",
      },
      limit: {
        type: "number",
        description: "Number of lines to read.",
      },
    },
    required: ["file_path"],
  },
  readOnly: true,
  concurrencySafe: true,
  async execute(input, context) {
    const filePath = resolvePath(asString(input.file_path), context.cwd);
    if (await isDirectory(filePath)) {
      return {
        content: `${filePath} is a directory. Use Bash(ls) or Glob to inspect directories.`,
        isError: true,
      };
    }

    const info = await stat(filePath).catch((error: Error) => error);
    if (info instanceof Error) {
      return { content: `Could not stat ${filePath}: ${info.message}`, isError: true };
    }
    if (info.size > MAX_READ_BYTES) {
      return {
        content: `${filePath} is ${(info.size / 1024 / 1024).toFixed(1)} MB. Refusing to read more than ${MAX_READ_BYTES / 1024 / 1024} MB at once. Use offset/limit or a shell command for targeted extraction.`,
        isError: true,
      };
    }

    const buffer = await readFile(filePath);
    if (buffer.includes(0)) {
      return {
        content: `${filePath} appears to be a binary file (${buffer.length} bytes).`,
        isError: true,
      };
    }

    const text = buffer.toString("utf8");
    context.state.readFiles.add(filePath);
    if (path.extname(filePath) === ".ipynb") {
      return { content: truncateMiddle(renderNotebook(text, filePath), 40000) };
    }

    if (!text.length) return { content: `${filePath} is empty.` };
    const lines = text.split(/\r?\n/);
    const offset = asNumber(input.offset, 1, { min: 1 });
    const limit = asNumber(input.limit, DEFAULT_READ_LINES, {
      min: 1,
      max: DEFAULT_READ_LINES,
    });
    const selected = lines
      .slice(offset - 1, offset - 1 + limit)
      .map((line, index) => formatLineNumber(offset + index, line));

    const header =
      lines.length > selected.length
        ? `Showing lines ${offset}-${offset + selected.length - 1} of ${lines.length} in ${filePath}\n`
        : `File: ${filePath}\n`;
    return { content: truncateMiddle(header + selected.join("\n"), 40000) };
  },
};

export const WriteTool: AgentTool = {
  name: "Write",
  description:
    "Write a complete file to the local filesystem. Prefer Edit for modifications to existing files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to write.",
      },
      content: { type: "string", description: "Complete file content." },
    },
    required: ["file_path", "content"],
  },
  readOnly: false,
  destructive: true,
  async execute(input, context) {
    const filePath = resolvePath(asString(input.file_path), context.cwd);
    const content = asString(input.content);
    await ensureParentDirectory(filePath);
    await writeFile(filePath, content, "utf8");
    context.state.readFiles.add(filePath);
    return {
      content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}.`,
    };
  },
};

export const EditTool: AgentTool = {
  name: "Edit",
  description:
    "Replace text in an existing file. The old_string must match exactly unless replace_all is true.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to modify.",
      },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: {
        type: "string",
        description: "Replacement text. Must differ from old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences. Defaults to false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  readOnly: false,
  destructive: false,
  async execute(input, context) {
    const filePath = resolvePath(asString(input.file_path), context.cwd);
    const oldString = asString(input.old_string);
    const newString = asString(input.new_string);
    const replaceAll = asBoolean(input.replace_all);

    if (!oldString) {
      return { content: "old_string must not be empty.", isError: true };
    }
    if (oldString === newString) {
      return {
        content: "new_string must be different from old_string.",
        isError: true,
      };
    }

    const text = await readFile(filePath, "utf8").catch((error: Error) => error);
    if (text instanceof Error) {
      return { content: `Could not read ${filePath}: ${text.message}`, isError: true };
    }

    const count = text.split(oldString).length - 1;
    if (count === 0) {
      return {
        content: `old_string was not found in ${filePath}. Read the file and retry with exact text.`,
        isError: true,
      };
    }
    if (!replaceAll && count > 1) {
      return {
        content: `old_string appears ${count} times in ${filePath}. Provide a more specific old_string or set replace_all=true.`,
        isError: true,
      };
    }

    const next = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    await writeFile(filePath, next, "utf8");
    context.state.readFiles.add(filePath);
    return {
      content: `Edited ${filePath}. Replaced ${replaceAll ? count : 1} occurrence${(replaceAll ? count : 1) === 1 ? "" : "s"}.`,
    };
  },
};

function renderNotebook(raw: string, filePath: string): string {
  try {
    const notebook = JSON.parse(raw) as {
      cells?: Array<{
        id?: string;
        cell_type?: string;
        source?: string | string[];
        outputs?: unknown[];
      }>;
    };
    if (!Array.isArray(notebook.cells)) return `File: ${filePath}\n${raw}`;
    const cells = notebook.cells.map((cell, index) => {
      const source = Array.isArray(cell.source)
        ? cell.source.join("")
        : String(cell.source ?? "");
      const outputs = Array.isArray(cell.outputs) && cell.outputs.length
        ? `\nOutputs: ${JSON.stringify(cell.outputs).slice(0, 2000)}`
        : "";
      return `# Cell ${index + 1}${cell.id ? ` (${cell.id})` : ""} [${cell.cell_type ?? "unknown"}]\n${source}${outputs}`;
    });
    return `Notebook: ${filePath}\n\n${cells.join("\n\n")}`;
  } catch {
    return `File: ${filePath}\n${raw}`;
  }
}
