import { describe, expect, it } from "vitest";
import { defaultTools, filterTools, findTool } from "../src/tools/registry.js";

describe("defaultTools", () => {
  it("returns exactly 15 tools", () => {
    expect(defaultTools()).toHaveLength(15);
  });

  it("each tool has required fields", () => {
    for (const tool of defaultTools()) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("includes expected tool names", () => {
    const names = defaultTools().map((t) => t.name);
    expect(names).toContain("Bash");
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");
    expect(names).toContain("WebFetch");
    expect(names).toContain("WebSearch");
    expect(names).toContain("TodoWrite");
    expect(names).toContain("NotebookEdit");
    expect(names).toContain("AskUserQuestion");
    expect(names).toContain("ExitPlanMode");
    expect(names).toContain("Agent");
    expect(names).toContain("BashOutput");
    expect(names).toContain("KillShell");
  });
});

describe("filterTools", () => {
  const tools = defaultTools();

  it("returns all tools when no filters applied", () => {
    expect(filterTools(tools, {})).toHaveLength(tools.length);
  });

  it("filters to only allowedTools", () => {
    const filtered = filterTools(tools, { allowedTools: ["Bash", "Read"] });
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.name)).toEqual(expect.arrayContaining(["Bash", "Read"]));
  });

  it("excludes disabledTools", () => {
    const filtered = filterTools(tools, { disabledTools: ["Bash"] });
    expect(filtered.map((t) => t.name)).not.toContain("Bash");
    expect(filtered.length).toBe(tools.length - 1);
  });

  it("combined: allowedTools takes precedence over disabledTools", () => {
    const filtered = filterTools(tools, {
      allowedTools: ["Bash", "Read"],
      disabledTools: ["Bash"],
    });
    expect(filtered.map((t) => t.name)).not.toContain("Bash");
    expect(filtered.map((t) => t.name)).toContain("Read");
  });

  it("returns empty array when allowedTools list has no matches", () => {
    const filtered = filterTools(tools, { allowedTools: ["NonExistentTool"] });
    expect(filtered).toHaveLength(0);
  });
});

describe("findTool", () => {
  const tools = defaultTools();

  it("finds an existing tool by name", () => {
    const tool = findTool(tools, "Read");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("Read");
  });

  it("returns undefined for a missing tool", () => {
    expect(findTool(tools, "NonExistent")).toBeUndefined();
  });
});
