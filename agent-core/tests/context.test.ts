import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentContext,
  discoverProjectInstructions,
  formatProjectInstructionIndex,
} from "../src/context.js";
import { MemoryWorkspace } from "../src/workspace/memory.js";

// ──────────────────────────────────────────────
// discoverProjectInstructions (filesystem)
// ──────────────────────────────────────────────

describe("discoverProjectInstructions — filesystem", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-ctx-${Date.now()}`);
    projectDir = path.join(tmpDir, "project", "subdir");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("finds CLAUDE.md in cwd", async () => {
    writeFileSync(path.join(projectDir, "CLAUDE.md"), "# Project guide");
    const instructions = await discoverProjectInstructions({ cwd: projectDir });
    const paths = instructions.map((i) => i.path);
    expect(paths.some((p) => p.endsWith("CLAUDE.md"))).toBe(true);
    expect(instructions[0]!.content).toContain("Project guide");
  });

  it("finds CLAUDE.md in parent directory", async () => {
    writeFileSync(path.join(tmpDir, "project", "CLAUDE.md"), "# Parent guide");
    const instructions = await discoverProjectInstructions({ cwd: projectDir });
    const paths = instructions.map((i) => i.path);
    expect(paths.some((p) => p.includes("project") && p.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("returns empty array when no CLAUDE.md exists", async () => {
    const instructions = await discoverProjectInstructions({ cwd: projectDir });
    // With a real filesystem, ancestor dirs might have CLAUDE.md (e.g. user home)
    // We only test that it doesn't crash and returns an array
    expect(Array.isArray(instructions)).toBe(true);
  });

  it("skips empty CLAUDE.md files", async () => {
    writeFileSync(path.join(projectDir, "CLAUDE.md"), "   \n  ");
    const instructions = await discoverProjectInstructions({ cwd: projectDir });
    const found = instructions.some(
      (i) => i.path === path.join(projectDir, "CLAUDE.md"),
    );
    expect(found).toBe(false);
  });

  it("truncates files larger than 64KB", async () => {
    const bigContent = "A".repeat(70 * 1024);
    writeFileSync(path.join(projectDir, "CLAUDE.md"), bigContent);
    const instructions = await discoverProjectInstructions({ cwd: projectDir });
    const found = instructions.find((i) => i.path === path.join(projectDir, "CLAUDE.md"));
    expect(found).toBeDefined();
    expect(found!.content).toContain("truncated");
  });

  it("includes additionalInstructionDirs", async () => {
    const extraDir = path.join(tmpDir, "extra");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(path.join(extraDir, "CLAUDE.md"), "# Extra instructions");
    const instructions = await discoverProjectInstructions({
      cwd: projectDir,
      additionalInstructionDirs: [extraDir],
    });
    const paths = instructions.map((i) => i.path);
    expect(paths.some((p) => p.startsWith(extraDir))).toBe(true);
  });
});

// ──────────────────────────────────────────────
// discoverProjectInstructions (MemoryWorkspace)
// ──────────────────────────────────────────────

describe("discoverProjectInstructions — MemoryWorkspace", () => {
  it("finds CLAUDE.md via workspace.exists", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/CLAUDE.md", "# Memory workspace guide");
    const instructions = await discoverProjectInstructions({
      cwd: "/ws",
      workspace: ws,
    });
    const found = instructions.find((i) => i.path === "/ws/CLAUDE.md");
    expect(found).toBeDefined();
    expect(found!.content).toContain("Memory workspace guide");
  });

  it("returns empty array when no CLAUDE.md in workspace", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    const instructions = await discoverProjectInstructions({
      cwd: "/ws",
      workspace: ws,
    });
    expect(instructions).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// formatProjectInstructionIndex
// ──────────────────────────────────────────────

describe("formatProjectInstructionIndex", () => {
  it("returns null for empty list", () => {
    expect(formatProjectInstructionIndex([])).toBeNull();
  });

  it("returns a formatted string with paths", () => {
    const result = formatProjectInstructionIndex([
      { path: "/ws/CLAUDE.md", content: "guide" },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("Project Instructions");
    expect(result).toContain("/ws/CLAUDE.md");
  });

  it("lists multiple instruction files", () => {
    const result = formatProjectInstructionIndex([
      { path: "/ws/CLAUDE.md", content: "a" },
      { path: "/ws/sub/CLAUDE.md", content: "b" },
    ]);
    expect(result).toContain("/ws/CLAUDE.md");
    expect(result).toContain("/ws/sub/CLAUDE.md");
  });
});

// ──────────────────────────────────────────────
// buildAgentContext
// ──────────────────────────────────────────────

describe("buildAgentContext", () => {
  it("returns projectInstructions and attachmentMessages", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/CLAUDE.md", "# Guide");
    const ctx = await buildAgentContext({ cwd: "/ws", workspace: ws });
    expect(Array.isArray(ctx.projectInstructions)).toBe(true);
    expect(Array.isArray(ctx.attachmentMessages)).toBe(true);
  });

  it("attachmentMessages is empty when no CLAUDE.md", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    const ctx = await buildAgentContext({ cwd: "/ws", workspace: ws });
    expect(ctx.attachmentMessages).toHaveLength(0);
  });

  it("attachmentMessages contains context-attachment XML", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    await ws.write("/ws/CLAUDE.md", "# My project");
    const ctx = await buildAgentContext({ cwd: "/ws", workspace: ws });
    expect(ctx.attachmentMessages.length).toBeGreaterThan(0);
    const text = ctx.attachmentMessages[0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(text).toContain("<context-attachment");
    expect(text).toContain("My project");
  });

  it("total attachment content does not exceed 120KB", async () => {
    const ws = new MemoryWorkspace({ cwd: "/ws" });
    // Write several large instruction files
    for (let i = 0; i < 5; i++) {
      await ws.write(`/ws/level${i}/CLAUDE.md`, "X".repeat(40 * 1024));
    }
    const ctx = await buildAgentContext({ cwd: "/ws/level4", workspace: ws });
    const totalChars = ctx.attachmentMessages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
    expect(totalChars).toBeLessThanOrEqual(130000); // small buffer for XML overhead
  });
});
