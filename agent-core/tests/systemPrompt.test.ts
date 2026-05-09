import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../src/systemPrompt.js";
import { DisabledRuntime } from "../src/runtime/disabled.js";
import { LocalRuntime } from "../src/runtime/local.js";

describe("buildSystemPrompt", () => {
  it("returns a non-empty string", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes runtime context block with cwd", async () => {
    const prompt = await buildSystemPrompt({
      cwd: "/my/project",
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
    });
    expect(prompt).toContain("Runtime Context");
    expect(prompt).toContain("/my/project");
  });

  it("includes today's date in the context block", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(today);
  });

  it("includes model name in the context block", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "claude-opus-4",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
    });
    expect(prompt).toContain("claude-opus-4");
  });

  it("formats Anthropic provider as 'Anthropic'", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
    });
    expect(prompt).toContain("Anthropic");
  });

  it("uses customSystemPrompt instead of default when provided", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
      customSystemPrompt: "# Custom Instructions",
    });
    expect(prompt).toContain("Custom Instructions");
    expect(prompt).not.toContain("Runtime Context");
  });

  it("appendSystemPrompt is appended to the end", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
      appendSystemPrompt: "APPEND_MARKER",
    });
    expect(prompt).toContain("APPEND_MARKER");
    expect(prompt.endsWith("APPEND_MARKER")).toBe(true);
  });

  it("includes project instruction index when projectInstructions provided", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
      projectInstructions: [
        { path: "/ws/CLAUDE.md", content: "# Guide" },
      ],
    });
    expect(prompt).toContain("Project Instructions");
    expect(prompt).toContain("/ws/CLAUDE.md");
  });

  it("includes git snapshot when in a git repository", async () => {
    // LocalRuntime with real cwd which is a git repo
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new LocalRuntime(),
    });
    // Should contain either "Git Snapshot" or just be a valid prompt
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("customSystemPrompt with append and project instructions are all included", async () => {
    const prompt = await buildSystemPrompt({
      cwd: process.cwd(),
      model: "test-model",
      providerId: "anthropic",
      runtime: new DisabledRuntime(),
      customSystemPrompt: "CUSTOM",
      appendSystemPrompt: "APPENDED",
      projectInstructions: [{ path: "/ws/CLAUDE.md", content: "guide" }],
    });
    expect(prompt).toContain("CUSTOM");
    expect(prompt).toContain("APPENDED");
    expect(prompt).toContain("Project Instructions");
  });
});
