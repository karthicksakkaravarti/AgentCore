import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "../types.js";
import { resolvePath } from "../utils/fs.js";
import { asString } from "../utils/json.js";

type NotebookCell = {
  id?: string;
  cell_type?: "code" | "markdown" | string;
  source?: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
};

type Notebook = {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
};

export const NotebookEditTool: AgentTool = {
  name: "NotebookEdit",
  description: "Edit a Jupyter notebook cell by cell id, or insert/delete cells.",
  inputSchema: {
    type: "object",
    properties: {
      notebook_path: {
        type: "string",
        description: "Absolute path to the .ipynb notebook.",
      },
      cell_id: {
        type: "string",
        description:
          "Cell id to edit/delete. Insert after this cell; omit to insert at beginning.",
      },
      new_source: { type: "string", description: "New cell source." },
      cell_type: { type: "string", enum: ["code", "markdown"] },
      edit_mode: {
        type: "string",
        enum: ["replace", "insert", "delete"],
        description: "Defaults to replace.",
      },
    },
    required: ["notebook_path", "new_source"],
  },
  readOnly: false,
  destructive: false,
  async execute(input, context) {
    const filePath = resolvePath(asString(input.notebook_path), context.cwd);
    const raw = await readFile(filePath, "utf8").catch((error: Error) => error);
    if (raw instanceof Error) {
      return { content: `Could not read notebook: ${raw.message}`, isError: true };
    }
    const notebook = JSON.parse(raw) as Notebook;
    if (!Array.isArray(notebook.cells)) {
      return { content: "Notebook JSON does not contain a cells array.", isError: true };
    }

    const mode = asString(input.edit_mode, "replace");
    const cellId = asString(input.cell_id);
    const index = cellId ? notebook.cells.findIndex((cell) => cell.id === cellId) : -1;

    if ((mode === "replace" || mode === "delete") && index < 0) {
      return { content: `Cell id ${cellId || "(missing)"} was not found.`, isError: true };
    }

    if (mode === "delete") {
      notebook.cells.splice(index, 1);
    } else if (mode === "insert") {
      const cellType = asString(input.cell_type, "code") as "code" | "markdown";
      const cell: NotebookCell = {
        id: crypto.randomUUID().slice(0, 8),
        cell_type: cellType,
        metadata: {},
        source: splitSource(asString(input.new_source)),
        ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
      };
      notebook.cells.splice(index >= 0 ? index + 1 : 0, 0, cell);
    } else {
      const cell = notebook.cells[index]!;
      cell.source = splitSource(asString(input.new_source));
      if (input.cell_type) cell.cell_type = asString(input.cell_type);
      if (cell.cell_type === "code") {
        cell.outputs ??= [];
        cell.execution_count ??= null;
      }
    }

    await writeFile(filePath, `${JSON.stringify(notebook, null, 2)}\n`, "utf8");
    context.state.readFiles.add(filePath);
    return { content: `${mode} applied to ${filePath}.` };
  },
};

function splitSource(source: string): string[] {
  if (!source) return [];
  return source.split(/(?<=\n)/);
}
