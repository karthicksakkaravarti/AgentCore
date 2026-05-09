import { describe, expect, it, beforeEach } from "vitest";
import { EditTool, ReadTool, WriteTool } from "../src/tools/files.js";
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

function makeContext(ws?: MemoryWorkspace, state?: AgentState): ToolExecutionContext {
  const workspace = ws ?? new MemoryWorkspace({ cwd: "/ws" });
  return {
    cwd: "/ws",
    workspace,
    runtime: new DisabledRuntime(),
    abortSignal: new AbortController().signal,
    state: state ?? makeState(),
  };
}

// ──────────────────────────────────────────────
// ReadTool
// ──────────────────────────────────────────────

describe("ReadTool", () => {
  let ws: MemoryWorkspace;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    ws = new MemoryWorkspace({ cwd: "/ws" });
    ctx = makeContext(ws);
  });

  it("reads a file with line numbers", async () => {
    await ws.write("/ws/hello.txt", "line1\nline2\nline3");
    const result = await ReadTool.execute({ file_path: "/ws/hello.txt" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("line1");
    expect(result.content).toContain("line2");
    expect(result.content).toContain("     1\t");
  });

  it("returns error for missing file", async () => {
    const result = await ReadTool.execute({ file_path: "/ws/missing.txt" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("offset and limit narrow the output", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    await ws.write("/ws/big.txt", lines);
    const result = await ReadTool.execute(
      { file_path: "/ws/big.txt", offset: 3, limit: 3 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("line3");
    expect(result.content).toContain("line5");
    expect(result.content).not.toContain("line1\n");
    expect(result.content).not.toContain("line7");
  });

  it("returns error for binary file (null bytes)", async () => {
    // Write bytes directly via readBytes approach (force null byte via workspace directly)
    const fakeBin = new Uint8Array([72, 101, 108, 0, 108, 111]);
    // MemoryWorkspace uses write() which takes string — use a workaround: write raw via internal map
    // Instead, test with a file that has a null character when read as text
    await ws.write("/ws/bin.bin", "hel\0lo");
    const result = await ReadTool.execute({ file_path: "/ws/bin.bin" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("binary");
  });

  it("returns error for directory path", async () => {
    // Create a file inside a directory so the directory exists
    await ws.write("/ws/subdir/file.txt", "content");
    const result = await ReadTool.execute({ file_path: "/ws/subdir" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("directory");
  });

  it("adds file to readFiles set on success", async () => {
    const state = makeState();
    const context = makeContext(ws, state);
    await ws.write("/ws/track.txt", "hello");
    await ReadTool.execute({ file_path: "/ws/track.txt" }, context);
    expect(state.readFiles.has("/ws/track.txt")).toBe(true);
  });

  it("renders .ipynb notebooks specially", async () => {
    const notebook = JSON.stringify({
      cells: [
        { id: "cell1", cell_type: "code", source: ["print('hello')"], outputs: [] },
      ],
    });
    await ws.write("/ws/nb.ipynb", notebook);
    const result = await ReadTool.execute({ file_path: "/ws/nb.ipynb" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Notebook:");
    expect(result.content).toContain("print");
  });
});

// ──────────────────────────────────────────────
// WriteTool
// ──────────────────────────────────────────────

describe("WriteTool", () => {
  it("writes a new file", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    const ctx = makeContext(ws);
    const result = await WriteTool.execute(
      { file_path: "/ws/new.txt", content: "hello" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("bytes");
    expect(await ws.read("/ws/new.txt")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/file.txt", "old content");
    const ctx = makeContext(ws);
    await WriteTool.execute({ file_path: "/ws/file.txt", content: "new content" }, ctx);
    expect(await ws.read("/ws/file.txt")).toBe("new content");
  });

  it("reports byte count in result", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    const ctx = makeContext(ws);
    const result = await WriteTool.execute(
      { file_path: "/ws/size.txt", content: "12345" },
      ctx,
    );
    expect(result.content).toContain("5 bytes");
  });
});

// ──────────────────────────────────────────────
// EditTool
// ──────────────────────────────────────────────

describe("EditTool", () => {
  it("replaces text in a file", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/code.ts", "const x = 1;\nconst y = 2;\n");
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      {
        file_path: "/ws/code.ts",
        old_string: "const x = 1;",
        new_string: "const x = 99;",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await ws.read("/ws/code.ts")).toContain("const x = 99;");
  });

  it("returns error when old_string not found", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/file.txt", "hello world");
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      { file_path: "/ws/file.txt", old_string: "nope", new_string: "yes" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when old_string is empty", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/file.txt", "hello");
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      { file_path: "/ws/file.txt", old_string: "", new_string: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("returns error when old_string equals new_string", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/file.txt", "hello");
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      { file_path: "/ws/file.txt", old_string: "hello", new_string: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("returns error when old_string appears multiple times without replace_all", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/file.txt", "foo foo foo");
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      { file_path: "/ws/file.txt", old_string: "foo", new_string: "bar" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears");
  });

  it("replaces all occurrences with replace_all=true", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/file.txt", "foo foo foo");
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      {
        file_path: "/ws/file.txt",
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await ws.read("/ws/file.txt")).toBe("bar bar bar");
  });

  it("returns error for missing file", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    const ctx = makeContext(ws);
    const result = await EditTool.execute(
      { file_path: "/ws/missing.txt", old_string: "a", new_string: "b" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});
