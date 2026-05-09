import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../src/workspace/memory.js";
import { LocalWorkspace } from "../src/workspace/local.js";
import {
  globToRegExp,
  joinStoragePrefix,
  normalizeVirtualRoot,
  resolveLocalPath,
  resolveVirtualPath,
  workspaceRelativePath,
} from "../src/workspace/path.js";

// ──────────────────────────────────────────────
// MemoryWorkspace
// ──────────────────────────────────────────────

describe("MemoryWorkspace", () => {
  let ws: MemoryWorkspace;

  beforeEach(() => {
    ws = new MemoryWorkspace({ cwd: "/workspace" });
  });

  it("write + read round-trip", async () => {
    await ws.write("/workspace/hello.txt", "hello world");
    expect(await ws.read("/workspace/hello.txt")).toBe("hello world");
  });

  it("exists returns false before write", async () => {
    expect(await ws.exists("/workspace/nope.txt")).toBe(false);
  });

  it("exists returns true after write", async () => {
    await ws.write("/workspace/file.txt", "data");
    expect(await ws.exists("/workspace/file.txt")).toBe(true);
  });

  it("stat returns correct size", async () => {
    await ws.write("/workspace/size.txt", "12345");
    const stat = await ws.stat("/workspace/size.txt");
    expect(stat.type).toBe("file");
    expect(stat.size).toBe(5);
  });

  it("stat for root returns directory", async () => {
    const stat = await ws.stat("/workspace");
    expect(stat.type).toBe("directory");
  });

  it("stat throws for missing file", async () => {
    await expect(ws.stat("/workspace/missing.txt")).rejects.toThrow();
  });

  it("list matches glob pattern", async () => {
    await ws.write("/workspace/a.ts", "ts");
    await ws.write("/workspace/b.js", "js");
    await ws.write("/workspace/sub/c.ts", "ts2");
    const entries = await ws.list("**/*.ts");
    const names = entries.map((e) => e.path);
    expect(names.some((n) => n.endsWith("a.ts"))).toBe(true);
    expect(names.some((n) => n.endsWith("c.ts"))).toBe(true);
    expect(names.every((n) => !n.endsWith("b.js"))).toBe(true);
  });

  it("list respects limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await ws.write(`/workspace/file${i}.txt`, "x");
    }
    const entries = await ws.list("**/*.txt", { limit: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it("delete removes the file", async () => {
    await ws.write("/workspace/del.txt", "bye");
    await ws.delete("/workspace/del.txt");
    expect(await ws.exists("/workspace/del.txt")).toBe(false);
  });

  it("resolvePath resolves relative path from cwd", () => {
    const resolved = ws.resolvePath("foo/bar.ts");
    expect(resolved).toBe("/workspace/foo/bar.ts");
  });

  it("resolvePath throws when path escapes the workspace root", () => {
    expect(() => ws.resolvePath("../../etc/passwd")).toThrow();
  });

  it("readBytes returns Uint8Array", async () => {
    await ws.write("/workspace/bytes.txt", "abc");
    const bytes = await ws.readBytes("/workspace/bytes.txt");
    expect(bytes instanceof Uint8Array).toBe(true);
    expect(new TextDecoder().decode(bytes)).toBe("abc");
  });
});

// ──────────────────────────────────────────────
// LocalWorkspace
// ──────────────────────────────────────────────

describe("LocalWorkspace", () => {
  let tmpDir: string;
  let ws: LocalWorkspace;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agent-core-ws-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    ws = new LocalWorkspace({ cwd: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("write + read round-trip", async () => {
    const file = path.join(tmpDir, "hello.txt");
    await ws.write(file, "hello");
    expect(await ws.read(file)).toBe("hello");
  });

  it("exists returns false for missing path", async () => {
    expect(await ws.exists(path.join(tmpDir, "nope.txt"))).toBe(false);
  });

  it("exists returns true for existing file", async () => {
    const file = path.join(tmpDir, "exists.txt");
    writeFileSync(file, "hi");
    expect(await ws.exists(file)).toBe(true);
  });

  it("stat reports isFile correctly", async () => {
    const file = path.join(tmpDir, "f.txt");
    writeFileSync(file, "data");
    const stat = await ws.stat(file);
    expect(stat.type).toBe("file");
    expect(stat.size).toBeGreaterThan(0);
  });

  it("stat reports isDirectory correctly", async () => {
    const stat = await ws.stat(tmpDir);
    expect(stat.type).toBe("directory");
  });

  it("list with glob returns matching files", async () => {
    writeFileSync(path.join(tmpDir, "a.ts"), "ts");
    writeFileSync(path.join(tmpDir, "b.js"), "js");
    const entries = await ws.list("*.ts", { cwd: tmpDir });
    expect(entries.length).toBe(1);
    expect(entries[0]!.path).toContain("a.ts");
  });

  it("readBytes returns bytes that decode to the file content", async () => {
    const file = path.join(tmpDir, "bytes.txt");
    writeFileSync(file, "hello bytes");

    const bytes = await ws.readBytes(file);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe("hello bytes");
  });

  it("delete removes files and ignores missing paths", async () => {
    const file = path.join(tmpDir, "delete-me.txt");
    writeFileSync(file, "bye");

    await ws.delete(file);
    await expect(ws.delete(path.join(tmpDir, "missing.txt"))).resolves.toBeUndefined();

    expect(existsSync(file)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Path utilities
// ──────────────────────────────────────────────

describe("resolveLocalPath", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("resolves tilde through HOME", () => {
    process.env.HOME = "/home/tester";
    process.env.USERPROFILE = "/users/profile";

    expect(resolveLocalPath("~file.txt", "/cwd")).toBe("/home/tester/file.txt");
  });

  it("falls back to USERPROFILE and then cwd for tilde paths", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "/users/profile";
    expect(resolveLocalPath("~file.txt", "/cwd")).toBe("/users/profile/file.txt");

    delete process.env.USERPROFILE;
    expect(resolveLocalPath("~file.txt", "/cwd")).toBe("/cwd/file.txt");
  });

  it("resolves absolute and relative non-tilde paths", () => {
    expect(resolveLocalPath("/tmp/file.txt", "/cwd")).toBe("/tmp/file.txt");
    expect(resolveLocalPath("file.txt", "/cwd")).toBe("/cwd/file.txt");
  });
});

describe("normalizeVirtualRoot", () => {
  it("normalizes empty, slash, and trailing-slash roots", () => {
    expect(normalizeVirtualRoot("")).toBe("/workspace");
    expect(normalizeVirtualRoot("/")).toBe("/workspace");
    expect(normalizeVirtualRoot("/workspace/")).toBe("/workspace");
  });
});

describe("resolveVirtualPath", () => {
  it("resolves a relative path within the root", () => {
    const result = resolveVirtualPath("src/index.ts", {
      root: "/workspace",
      cwd: "/workspace",
    });
    expect(result).toBe("/workspace/src/index.ts");
  });

  it("throws when path escapes the root with ../", () => {
    expect(() =>
      resolveVirtualPath("../../etc/passwd", {
        root: "/workspace",
        cwd: "/workspace",
      }),
    ).toThrow();
  });

  it("accepts absolute paths within the root", () => {
    const result = resolveVirtualPath("/workspace/file.ts", {
      root: "/workspace",
      cwd: "/workspace",
    });
    expect(result).toBe("/workspace/file.ts");
  });

  it("maps absolute paths outside the virtual root into the root", () => {
    const result = resolveVirtualPath("/etc/passwd", {
      root: "/workspace",
      cwd: "/workspace",
    });
    expect(result).toBe("/workspace/etc/passwd");
  });

  it("maps absolute cwd values outside the virtual root into the root", () => {
    const result = resolveVirtualPath("file.txt", {
      root: "/workspace",
      cwd: "/tmp",
    });
    expect(result).toBe("/workspace/tmp/file.txt");
  });

  it("throws when a normalized absolute path escapes the root", () => {
    expect(() =>
      resolveVirtualPath("/workspace/../../etc/passwd", {
        root: "/workspace",
        cwd: "/workspace",
      }),
    ).toThrow("Path escapes workspace root");
  });

  it("throws when cwd normalizes outside the root", () => {
    expect(() =>
      resolveVirtualPath("file.txt", {
        root: "/workspace",
        cwd: "/workspace/../../etc",
      }),
    ).toThrow("Path escapes workspace root");
  });
});

describe("workspaceRelativePath", () => {
  it("returns an empty string for the workspace root", () => {
    expect(workspaceRelativePath("/workspace", "/workspace")).toBe("");
  });
});

describe("joinStoragePrefix", () => {
  it("filters empty parts and normalizes slashes", () => {
    expect(joinStoragePrefix([undefined, "", "tenant\\one", "/session/", "file.ts"])).toBe(
      "tenant/one/session/file.ts",
    );
  });

  it("returns an empty string when every part is empty", () => {
    expect(joinStoragePrefix([undefined, "", "/"])).toBe("");
  });
});

describe("globToRegExp", () => {
  it("matches *.ts files", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.js")).toBe(false);
  });

  it("matches **/*.ts recursively", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/deep/bar.ts")).toBe(true);
    expect(re.test("src/foo.js")).toBe(false);
  });

  it("exact filename match", () => {
    const re = globToRegExp("README.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("readme.md")).toBe(false);
  });

  it("supports question marks and double-star without a following slash", () => {
    const question = globToRegExp("file?.ts");
    expect(question.test("file1.ts")).toBe(true);
    expect(question.test("file12.ts")).toBe(false);

    const doubleStar = globToRegExp("src/**.ts");
    expect(doubleStar.test("src/deep/file.ts")).toBe(true);
  });
});
