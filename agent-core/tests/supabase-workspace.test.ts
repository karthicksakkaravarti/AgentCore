import { describe, expect, it, vi } from "vitest";
import { SupabaseWorkspace } from "../src/workspace/supabase.js";

function makeStorageMock() {
  const bucket = {
    download: vi.fn(),
    upload: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  };
  return {
    storage: {
      from: vi.fn(() => bucket),
    },
    __bucket: bucket,
  };
}

describe("SupabaseWorkspace", () => {
  it("requires either a Supabase client or URL credentials", () => {
    expect(
      () =>
        new SupabaseWorkspace({
          tenantId: "tenant",
          sessionId: "session",
        } as never),
    ).toThrow("requires url or supabase");
    expect(
      () =>
        new SupabaseWorkspace({
          tenantId: "tenant",
          sessionId: "session",
          url: "https://example.supabase.co",
        } as never),
    ).toThrow("requires serviceRoleKey");
  });

  it("uses default bucket and cwd, reads bytes, and decodes text", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.download.mockResolvedValue({
      data: new Blob(["hello"]),
      error: null,
    });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    expect(workspace.cwd).toBe("/workspace");
    const bytes = await workspace.readBytes("file.txt");

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(await workspace.read("file.txt")).toBe("hello");
    expect(supabase.storage.from).toHaveBeenCalledWith("agent-workspaces");
    expect(supabase.__bucket.download).toHaveBeenCalledWith(
      "tenant/session/file.txt",
    );
  });

  it("throws on read errors and missing download data", async () => {
    const readError = makeStorageMock();
    readError.__bucket.download.mockResolvedValue({
      data: null,
      error: { message: "download failed" },
    });
    await expect(
      new SupabaseWorkspace({
        supabase: readError as never,
        tenantId: "tenant",
        sessionId: "session",
      }).readBytes("file.txt"),
    ).rejects.toThrow("download failed");

    const missing = makeStorageMock();
    missing.__bucket.download.mockResolvedValue({ data: null, error: null });
    await expect(
      new SupabaseWorkspace({
        supabase: missing as never,
        tenantId: "tenant",
        sessionId: "session",
      }).readBytes("file.txt"),
    ).rejects.toThrow("File not found");
  });

  it("writes files with inferred MIME types and upsert enabled", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.upload.mockResolvedValue({ data: null, error: null });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
      bucket: "custom-bucket",
    });

    for (const filePath of [
      "app.ts",
      "index.html",
      "data.json",
      "README.md",
      "style.css",
      "unknown.xyz",
    ]) {
      await workspace.write(filePath, "content");
    }

    expect(supabase.storage.from).toHaveBeenCalledWith("custom-bucket");
    expect(supabase.__bucket.upload.mock.calls.map((call) => call[1].type)).toEqual([
      "text/javascript; charset=utf-8",
      "text/html; charset=utf-8",
      "application/json; charset=utf-8",
      "text/markdown; charset=utf-8",
      "text/css; charset=utf-8",
      "text/plain; charset=utf-8",
    ]);
    for (const call of supabase.__bucket.upload.mock.calls) {
      expect(call[2]).toEqual({ upsert: true });
    }
  });

  it("throws when upload fails", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.upload.mockResolvedValue({
      data: null,
      error: { message: "upload failed" },
    });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    await expect(workspace.write("file.txt", "content")).rejects.toThrow(
      "upload failed",
    );
  });

  it("reports existence through stat", async () => {
    const present = makeStorageMock();
    present.__bucket.list.mockResolvedValueOnce({
      data: [
        {
          name: "file.ts",
          id: "object-id",
          metadata: { size: 5 },
          updated_at: "2026-05-08T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const presentWorkspace = new SupabaseWorkspace({
      supabase: present as never,
      tenantId: "tenant",
      sessionId: "session",
    });
    await expect(presentWorkspace.exists("file.ts")).resolves.toBe(true);

    const missing = makeStorageMock();
    missing.__bucket.list.mockResolvedValue({ data: [], error: null });
    const missingWorkspace = new SupabaseWorkspace({
      supabase: missing as never,
      tenantId: "tenant",
      sessionId: "session",
    });
    await expect(missingWorkspace.exists("missing.ts")).resolves.toBe(false);
  });

  it("stats root, files, directories, and missing paths", async () => {
    const supabase = makeStorageMock();
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    await expect(workspace.stat("/workspace")).resolves.toEqual({
      type: "directory",
      size: 0,
      mtimeMs: 0,
    });

    supabase.__bucket.list.mockResolvedValueOnce({
      data: [
        {
          name: "file.ts",
          id: "object-id",
          metadata: { size: 5 },
          updated_at: "2026-05-08T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const fileStat = await workspace.stat("file.ts");
    expect(fileStat).toEqual({
      type: "file",
      size: 5,
      mtimeMs: Date.parse("2026-05-08T00:00:00.000Z"),
    });

    supabase.__bucket.list.mockResolvedValueOnce({
      data: [{ name: "folder" }],
      error: null,
    });
    await expect(workspace.stat("folder")).resolves.toEqual({
      type: "directory",
      size: 0,
      mtimeMs: 0,
    });

    supabase.__bucket.list
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    await expect(workspace.stat("missing")).rejects.toThrow("Path not found");
  });

  it("throws when stat listing fails", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.list.mockResolvedValue({
      data: null,
      error: { message: "list failed" },
    });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    await expect(workspace.stat("file.ts")).rejects.toThrow("list failed");
  });

  it("lists files by glob, includes directories on request, and respects limits", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.list
      .mockResolvedValueOnce({
        data: [
          {
            name: "a.ts",
            id: "a",
            metadata: { size: 1 },
            updated_at: "2026-05-08T00:00:00.000Z",
          },
          {
            name: "notes.md",
            id: "notes",
            metadata: { size: 2 },
          },
          { name: "dir" },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ name: "b.ts", id: "b", metadata: { size: 3 } }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { name: "dir" },
          { name: "limited.ts", id: "limited", metadata: { size: 1 } },
        ],
        error: null,
      });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    const tsFiles = await workspace.list("**/*.ts");
    expect(tsFiles.map((entry) => entry.path)).toEqual([
      "/workspace/a.ts",
      "/workspace/dir/b.ts",
    ]);

    const limited = await workspace.list("**/*", {
      includeDirectories: true,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.type).toBe("directory");
  });

  it("throws when recursive listing fails", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.list.mockResolvedValue({
      data: null,
      error: { message: "recursive failed" },
    });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    await expect(workspace.list("**/*")).rejects.toThrow("recursive failed");
  });

  it("deletes files, directories, and missing paths", async () => {
    const fileSupabase = makeStorageMock();
    fileSupabase.__bucket.list.mockResolvedValueOnce({
      data: [{ name: "file.ts", id: "file", metadata: { size: 1 } }],
      error: null,
    });
    fileSupabase.__bucket.remove.mockResolvedValue({ data: null, error: null });
    const fileWorkspace = new SupabaseWorkspace({
      supabase: fileSupabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });
    await fileWorkspace.delete("file.ts");
    expect(fileSupabase.__bucket.remove).toHaveBeenCalledWith([
      "tenant/session/file.ts",
    ]);

    const directorySupabase = makeStorageMock();
    directorySupabase.__bucket.list
      .mockResolvedValueOnce({ data: [{ name: "dir" }], error: null })
      .mockResolvedValueOnce({
        data: [{ name: "file.ts", id: "nested", metadata: { size: 1 } }],
        error: null,
      });
    directorySupabase.__bucket.remove.mockResolvedValue({
      data: null,
      error: null,
    });
    const directoryWorkspace = new SupabaseWorkspace({
      supabase: directorySupabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });
    await directoryWorkspace.delete("dir");
    expect(directorySupabase.__bucket.remove).toHaveBeenCalledWith([
      "tenant/session/dir/file.ts",
    ]);

    const missingSupabase = makeStorageMock();
    missingSupabase.__bucket.list.mockResolvedValue({ data: [], error: null });
    const missingWorkspace = new SupabaseWorkspace({
      supabase: missingSupabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });
    await expect(missingWorkspace.delete("missing")).resolves.toBeUndefined();
    expect(missingSupabase.__bucket.remove).not.toHaveBeenCalled();
  });

  it("throws when delete remove fails", async () => {
    const supabase = makeStorageMock();
    supabase.__bucket.list.mockResolvedValueOnce({
      data: [{ name: "file.ts", id: "file", metadata: { size: 1 } }],
      error: null,
    });
    supabase.__bucket.remove.mockResolvedValue({
      data: null,
      error: { message: "remove failed" },
    });
    const workspace = new SupabaseWorkspace({
      supabase: supabase as never,
      tenantId: "tenant",
      sessionId: "session",
    });

    await expect(workspace.delete("file.ts")).rejects.toThrow("remove failed");
  });
});
