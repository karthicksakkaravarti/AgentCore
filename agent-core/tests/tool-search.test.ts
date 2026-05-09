import { describe, expect, it, beforeEach } from "vitest";
import { GlobTool, GrepTool } from "../src/tools/search.js";
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

// ──────────────────────────────────────────────
// GlobTool
// ──────────────────────────────────────────────

describe("GlobTool", () => {
  let ws: MemoryWorkspace;
  let ctx: ToolExecutionContext;

  beforeEach(async () => {
    ws = new MemoryWorkspace({ cwd: "/ws" });
    ctx = makeContext(ws);
    await ws.write("/ws/a.ts", "ts file");
    await ws.write("/ws/b.js", "js file");
    await ws.write("/ws/sub/c.ts", "nested ts");
  });

  it("matches *.ts in the root", async () => {
    const result = await GlobTool.execute({ pattern: "*.ts" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("b.js");
  });

  it("matches **/*.ts recursively", async () => {
    const result = await GlobTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("c.ts");
  });

  it("returns no-match message when nothing found", async () => {
    const result = await GlobTool.execute({ pattern: "**/*.py" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No files matched");
  });

  it("matches all files with **/*", async () => {
    const result = await GlobTool.execute({ pattern: "**/*" }, ctx);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("b.js");
    expect(result.content).toContain("c.ts");
  });

  it("searches from input.path when provided", async () => {
    await ws.write("/ws/sub/only-here.ts", "nested");

    const result = await GlobTool.execute(
      { pattern: "*.ts", path: "sub" },
      ctx,
    );

    expect(result.content).toContain("/ws/sub/c.ts");
    expect(result.content).toContain("/ws/sub/only-here.ts");
    expect(result.content).not.toContain("/ws/a.ts");
  });
});

// ──────────────────────────────────────────────
// GrepTool
// ──────────────────────────────────────────────

describe("GrepTool", () => {
  let ws: MemoryWorkspace;
  let ctx: ToolExecutionContext;

  beforeEach(async () => {
    ws = new MemoryWorkspace({ cwd: "/ws" });
    ctx = makeContext(ws);
    await ws.write("/ws/file1.ts", "const foo = 1;\nconst bar = 2;\nconst FOO = 3;");
    await ws.write("/ws/file2.ts", "function hello() {}\nconst foo = 42;");
    await ws.write("/ws/notes.md", "This mentions foo in passing.\nSecond line here.");
  });

  it("finds a regex match (default files_with_matches mode)", async () => {
    const result = await GrepTool.execute({ pattern: "foo" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("file1.ts");
    expect(result.content).toContain("file2.ts");
  });

  it("case-insensitive with -i flag", async () => {
    const result = await GrepTool.execute(
      { pattern: "foo", "-i": true, output_mode: "files_with_matches" },
      ctx,
    );
    expect(result.content).toContain("file1.ts");
  });

  it("content mode shows matching lines", async () => {
    const result = await GrepTool.execute(
      { pattern: "foo", output_mode: "content" },
      ctx,
    );
    expect(result.content).toContain("const foo");
  });

  it("count mode shows match count per file", async () => {
    const result = await GrepTool.execute(
      { pattern: "foo", output_mode: "count" },
      ctx,
    );
    expect(result.content).toContain("file1.ts:");
    expect(result.content).toContain("file2.ts:");
  });

  it("context lines with -B and -A", async () => {
    const result = await GrepTool.execute(
      { pattern: "bar", output_mode: "content", "-B": 1, "-A": 1 },
      ctx,
    );
    // Should include line before and after "const bar = 2;"
    expect(result.content).toContain("const foo = 1;");
    expect(result.content).toContain("const bar = 2;");
    expect(result.content).toContain("const FOO = 3;");
  });

  it("returns no-match message when nothing found", async () => {
    const result = await GrepTool.execute({ pattern: "zzzzznotfound" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No matches");
  });

  it("glob filter limits files searched", async () => {
    const result = await GrepTool.execute(
      { pattern: "foo", glob: "**/*.md", output_mode: "files_with_matches" },
      ctx,
    );
    expect(result.content).toContain("notes.md");
    expect(result.content).not.toContain("file1.ts");
  });

  it("line numbers shown with -n flag in content mode", async () => {
    const result = await GrepTool.execute(
      { pattern: "foo", output_mode: "content", "-n": true },
      ctx,
    );
    // Expect line number format like "file1.ts:1:..."
    expect(result.content).toMatch(/\d+:/);
  });

  it("searches a single file when input.path points to a file", async () => {
    const result = await GrepTool.execute(
      { pattern: "foo", path: "file1.ts", output_mode: "content" },
      ctx,
    );

    expect(result.content).toContain("/ws/file1.ts:1:const foo = 1;");
    expect(result.content).not.toContain("/ws/file2.ts");
  });

  it("limits output with head_limit and reports truncation", async () => {
    await ws.write(
      "/ws/many.ts",
      Array.from({ length: 20 }, (_, index) => `match ${index}`).join("\n"),
    );

    const result = await GrepTool.execute(
      {
        pattern: "match",
        path: "many.ts",
        output_mode: "content",
        head_limit: 3,
      },
      ctx,
    );

    expect(result.content.split("\n").filter((line) => line.includes("match"))).toHaveLength(3);
    expect(result.content).toContain("... 17 more lines");
  });

  it("supports multiline matching across line breaks", async () => {
    await ws.write("/ws/multiline.txt", "one\ntwo\nthree");

    const result = await GrepTool.execute(
      {
        pattern: "one.two",
        path: "multiline.txt",
        output_mode: "content",
        multiline: true,
      },
      ctx,
    );

    expect(result.content).toBe("/ws/multiline.txt");
  });

  it("filters by known file types and lets unknown types pass through", async () => {
    const tsOnly = await GrepTool.execute(
      {
        pattern: "foo",
        output_mode: "files_with_matches",
        type: "ts",
      },
      ctx,
    );
    expect(tsOnly.content).toContain("file1.ts");
    expect(tsOnly.content).not.toContain("notes.md");

    const unknownType = await GrepTool.execute(
      {
        pattern: "foo",
        output_mode: "files_with_matches",
        type: "unknown",
      },
      ctx,
    );
    expect(unknownType.content).toContain("file1.ts");
    expect(unknownType.content).toContain("notes.md");

    const pyOnly = await GrepTool.execute(
      {
        pattern: "foo",
        output_mode: "files_with_matches",
        type: "py",
      },
      ctx,
    );
    expect(pyOnly.content).toContain("No matches");
  });
});
