import { describe, expect, it, beforeEach } from "vitest";
import { NotebookEditTool } from "../src/tools/notebook.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";
import type { AgentState, ToolExecutionContext } from "../src/types.js";

function makeState(): AgentState {
  return {
    todos: [],
    backgroundShells: new Map(),
    alwaysAllowedTools: new Set(),
    alwaysDeniedTools: new Set(),
    readFiles: new Set(),
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function makeContext(ws: MemoryWorkspace): ToolExecutionContext {
  return {
    cwd: "/ws",
    workspace: ws,
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state: makeState(),
  };
}

function makeNotebook(cells: object[]): string {
  return JSON.stringify({ cells, nbformat: 4, nbformat_minor: 5 });
}

describe("NotebookEditTool", () => {
  let ws: MemoryWorkspace;
  let ctx: ToolExecutionContext;
  const nbPath = "/ws/test.ipynb";

  beforeEach(() => {
    ws = new MemoryWorkspace({ cwd: "/ws" });
    ctx = makeContext(ws);
  });

  it("replace mode updates cell source", async () => {
    await ws.write(
      nbPath,
      makeNotebook([
        { id: "cell1", cell_type: "code", source: ["old code"], outputs: [] },
      ]),
    );
    const result = await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "cell1",
        new_source: "new code",
        edit_mode: "replace",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const updated = JSON.parse(await ws.read(nbPath));
    const source = Array.isArray(updated.cells[0].source)
      ? updated.cells[0].source.join("")
      : updated.cells[0].source;
    expect(source).toBe("new code");
  });

  it("insert mode adds a new cell after the specified cell", async () => {
    await ws.write(
      nbPath,
      makeNotebook([
        { id: "cell1", cell_type: "code", source: ["first"], outputs: [] },
        { id: "cell2", cell_type: "code", source: ["second"], outputs: [] },
      ]),
    );
    const result = await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "cell1",
        new_source: "inserted",
        edit_mode: "insert",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const updated = JSON.parse(await ws.read(nbPath));
    expect(updated.cells).toHaveLength(3);
    const insertedSource = Array.isArray(updated.cells[1].source)
      ? updated.cells[1].source.join("")
      : updated.cells[1].source;
    expect(insertedSource).toBe("inserted");
  });

  it("delete mode removes the cell", async () => {
    await ws.write(
      nbPath,
      makeNotebook([
        { id: "cell1", cell_type: "code", source: ["keep"], outputs: [] },
        { id: "cell2", cell_type: "code", source: ["delete me"], outputs: [] },
      ]),
    );
    const result = await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "cell2",
        new_source: "",
        edit_mode: "delete",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const updated = JSON.parse(await ws.read(nbPath));
    expect(updated.cells).toHaveLength(1);
    const remaining = Array.isArray(updated.cells[0].source)
      ? updated.cells[0].source.join("")
      : updated.cells[0].source;
    expect(remaining).toBe("keep");
  });

  it("returns error for invalid cell_id on replace", async () => {
    await ws.write(
      nbPath,
      makeNotebook([{ id: "cell1", cell_type: "code", source: ["code"], outputs: [] }]),
    );
    const result = await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "nonexistent",
        new_source: "x",
        edit_mode: "replace",
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error for invalid cell_id on delete", async () => {
    await ws.write(
      nbPath,
      makeNotebook([{ id: "cell1", cell_type: "code", source: ["code"], outputs: [] }]),
    );
    const result = await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "bad",
        new_source: "",
        edit_mode: "delete",
      },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("returns error when notebook file missing", async () => {
    const result = await NotebookEditTool.execute(
      { notebook_path: "/ws/missing.ipynb", new_source: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("insert at beginning when no cell_id given", async () => {
    await ws.write(
      nbPath,
      makeNotebook([{ id: "cell1", cell_type: "code", source: ["existing"], outputs: [] }]),
    );
    const result = await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        new_source: "first cell",
        edit_mode: "insert",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const updated = JSON.parse(await ws.read(nbPath));
    expect(updated.cells).toHaveLength(2);
    const firstSource = Array.isArray(updated.cells[0].source)
      ? updated.cells[0].source.join("")
      : updated.cells[0].source;
    expect(firstSource).toBe("first cell");
  });

  it("auto-generates cell id for inserted cell", async () => {
    await ws.write(
      nbPath,
      makeNotebook([{ id: "cell1", cell_type: "code", source: ["x"], outputs: [] }]),
    );
    await NotebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "cell1",
        new_source: "new",
        edit_mode: "insert",
      },
      ctx,
    );
    const updated = JSON.parse(await ws.read(nbPath));
    expect(typeof updated.cells[1].id).toBe("string");
    expect(updated.cells[1].id.length).toBeGreaterThan(0);
  });
});
