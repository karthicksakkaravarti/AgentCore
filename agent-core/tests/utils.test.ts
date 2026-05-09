import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asString,
  stringifyForToolResult,
  truncateMiddle,
} from "../src/utils/json.js";
import {
  ensureParentDirectory,
  formatLineNumber,
  isDirectory,
  pathExists,
  resolvePath,
} from "../src/utils/fs.js";

// ──────────────────────────────────────────────
// json.ts
// ──────────────────────────────────────────────

describe("asString", () => {
  it("returns a string unchanged", () => {
    expect(asString("hello")).toBe("hello");
  });
  it("returns empty string fallback for null", () => {
    expect(asString(null)).toBe("");
  });
  it("returns empty string fallback for undefined", () => {
    expect(asString(undefined)).toBe("");
  });
  it("uses custom fallback for non-string", () => {
    expect(asString(42, "nope")).toBe("nope");
  });
  it("returns empty string for object", () => {
    expect(asString({ a: 1 })).toBe("");
  });
});

describe("asNumber", () => {
  it("returns a number unchanged", () => {
    expect(asNumber(5, 0)).toBe(5);
  });
  it("returns fallback for NaN string", () => {
    expect(asNumber("abc", 99)).toBe(99);
  });
  it("coerces a numeric string", () => {
    expect(asNumber("42", 0)).toBe(42);
  });
  it("clamps to min", () => {
    expect(asNumber(-10, 0, { min: 0 })).toBe(0);
  });
  it("clamps to max", () => {
    expect(asNumber(1000, 0, { max: 100 })).toBe(100);
  });
  it("returns fallback for undefined", () => {
    expect(asNumber(undefined, 7)).toBe(7);
  });
  it("returns fallback for Infinity", () => {
    expect(asNumber(Infinity, 3)).toBe(3);
  });
});

describe("asBoolean", () => {
  it("returns true unchanged", () => {
    expect(asBoolean(true)).toBe(true);
  });
  it("returns false unchanged", () => {
    expect(asBoolean(false)).toBe(false);
  });
  it("returns fallback for string", () => {
    expect(asBoolean("yes")).toBe(false);
  });
  it("uses custom fallback", () => {
    expect(asBoolean("yes", true)).toBe(true);
  });
  it("returns false for null", () => {
    expect(asBoolean(null)).toBe(false);
  });
});

describe("stringifyForToolResult", () => {
  it("returns string as-is", () => {
    expect(stringifyForToolResult("hello")).toBe("hello");
  });
  it("serializes objects to JSON", () => {
    expect(stringifyForToolResult({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("handles circular objects with fallback", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    const result = stringifyForToolResult(obj);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
  it("serializes arrays", () => {
    expect(stringifyForToolResult([1, 2])).toBe("[\n  1,\n  2\n]");
  });
});

describe("truncateMiddle", () => {
  it("returns short strings unchanged", () => {
    expect(truncateMiddle("hello", 100)).toBe("hello");
  });
  it("truncates long strings with ellipsis marker", () => {
    const input = "a".repeat(500);
    const result = truncateMiddle(input, 200);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toContain("truncated");
  });
  it("result preserves start and end of string", () => {
    const input = "START" + "x".repeat(300) + "END";
    const result = truncateMiddle(input, 100);
    expect(result).toContain("START");
    expect(result).toContain("END");
  });
});

// ──────────────────────────────────────────────
// fs.ts
// ──────────────────────────────────────────────

describe("resolvePath", () => {
  it("resolves relative path against cwd", () => {
    const result = resolvePath("foo/bar.ts", "/project");
    expect(result).toBe("/project/foo/bar.ts");
  });
  it("returns absolute path unchanged", () => {
    const result = resolvePath("/etc/hosts", "/project");
    expect(result).toBe("/etc/hosts");
  });
  it("expands tilde to home (without leading slash)", () => {
    // The implementation does filePath.slice(1): "~subdir/f" → "subdir/f"
    // which is relative and resolves against HOME correctly.
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    const result = resolvePath("~subdir/file.txt", "/project");
    expect(result).toBe(path.resolve(home, "subdir/file.txt"));
  });
});

describe("pathExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it("returns true for an existing file", async () => {
    const file = path.join(tmpDir, "exists.txt");
    writeFileSync(file, "hello");
    expect(await pathExists(file)).toBe(true);
  });

  it("returns false for a missing file", async () => {
    expect(await pathExists(path.join(tmpDir, "missing.txt"))).toBe(false);
  });

  it("returns true for an existing directory", async () => {
    expect(await pathExists(tmpDir)).toBe(true);
  });
});

describe("ensureParentDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-test-${Date.now()}`);
  });

  it("creates nested parent directories", async () => {
    const nested = path.join(tmpDir, "a", "b", "c", "file.txt");
    await ensureParentDirectory(nested);
    expect(await pathExists(path.join(tmpDir, "a", "b", "c"))).toBe(true);
  });
});

describe("isDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it("returns true for a directory", async () => {
    expect(await isDirectory(tmpDir)).toBe(true);
  });

  it("returns false for a file", async () => {
    const file = path.join(tmpDir, "file.txt");
    writeFileSync(file, "content");
    expect(await isDirectory(file)).toBe(false);
  });

  it("returns false for a missing path", async () => {
    expect(await isDirectory(path.join(tmpDir, "missing"))).toBe(false);
  });
});

describe("formatLineNumber", () => {
  it("pads line number to 6 chars", () => {
    const result = formatLineNumber(1, "hello");
    expect(result).toMatch(/^\s{5}1\t/);
  });
  it("no padding needed for large line number", () => {
    const result = formatLineNumber(123456, "text");
    expect(result).toMatch(/^123456\t/);
  });
  it("includes the text after the tab", () => {
    const result = formatLineNumber(7, "some code");
    expect(result).toContain("\tsome code");
  });
});
