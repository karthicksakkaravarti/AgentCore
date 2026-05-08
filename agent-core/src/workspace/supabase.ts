import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import path from "node:path";
import type {
  Workspace,
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceStat,
} from "./types.js";
import {
  globToRegExp,
  joinStoragePrefix,
  normalizeVirtualRoot,
  resolveVirtualPath,
  workspaceRelativePath,
} from "./path.js";

type SupabaseFileObject = {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  metadata?: { size?: number } | null;
};

export type SupabaseWorkspaceOptions = {
  supabase?: SupabaseClient;
  url?: string;
  serviceRoleKey?: string;
  anonKey?: string;
  bucket?: string;
  tenantId: string;
  sessionId: string;
  cwd?: string;
};

export class SupabaseWorkspace implements Workspace {
  readonly id = "supabase";
  readonly cwd: string;
  private readonly root: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly supabase: SupabaseClient;

  constructor(options: SupabaseWorkspaceOptions) {
    this.root = normalizeVirtualRoot(options.cwd ?? "/workspace");
    this.cwd = this.root;
    this.bucket = options.bucket ?? "agent-workspaces";
    this.prefix = joinStoragePrefix([options.tenantId, options.sessionId]);
    this.supabase =
      options.supabase ??
      createClient(
        requireOption(options.url, "SupabaseWorkspace requires url or supabase"),
        requireOption(
          options.serviceRoleKey ?? options.anonKey,
          "SupabaseWorkspace requires serviceRoleKey, anonKey, or supabase",
        ),
        { auth: { persistSession: false } },
      );
  }

  resolvePath(filePath: string, cwd = this.cwd): string {
    return resolveVirtualPath(filePath, { root: this.root, cwd });
  }

  async read(filePath: string): Promise<string> {
    const bytes = await this.readBytes(filePath);
    return new TextDecoder().decode(bytes);
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    const key = this.storageKey(filePath);
    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .download(key);
    if (error) throw new Error(`Could not read ${filePath}: ${error.message}`);
    if (!data) throw new Error(`File not found: ${filePath}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async write(filePath: string, content: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const key = this.storageKey(resolved);
    const { error } = await this.supabase.storage
      .from(this.bucket)
      .upload(key, new Blob([content], { type: inferMimeType(resolved) }), {
        upsert: true,
      });
    if (error) throw new Error(`Could not write ${resolved}: ${error.message}`);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<WorkspaceStat> {
    const resolved = this.resolvePath(filePath);
    if (resolved === this.root) {
      return { type: "directory", size: 0, mtimeMs: 0 };
    }

    const relative = workspaceRelativePath(resolved, this.root);
    const parent = path.posix.dirname(relative);
    const base = path.posix.basename(relative);
    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .list(this.prefixed(parent === "." ? "" : parent), {
        limit: 100,
        search: base,
      });
    if (error) throw new Error(`Could not stat ${resolved}: ${error.message}`);

    const exact = (data as SupabaseFileObject[] | null)?.find(
      (item) => item.name === base,
    );
    if (exact) return statFromFileObject(exact);

    const directory = await this.list("**/*", { cwd: resolved, limit: 1 });
    if (directory.length > 0) return { type: "directory", size: 0, mtimeMs: 0 };
    throw new Error(`Path not found: ${resolved}`);
  }

  async list(
    pattern: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceEntry[]> {
    const cwd = this.resolvePath(options.cwd ?? this.cwd);
    const matcher = globToRegExp(pattern);
    const entries: WorkspaceEntry[] = [];
    const cwdRelative = workspaceRelativePath(cwd, this.root);
    const objects = await this.listRecursive(cwdRelative, options.limit ?? 5000);

    for (const entry of objects) {
      const relative = workspaceRelativePath(entry.path, cwd);
      if (!matcher.test(relative)) continue;
      if (entry.type === "directory" && options.includeDirectories !== true) continue;
      entries.push(entry);
      if (entries.length >= (options.limit ?? 5000)) break;
    }

    return entries;
  }

  async delete(filePath: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const stat = await this.stat(resolved).catch(() => null);
    if (!stat) return;

    const keys =
      stat.type === "file"
        ? [this.storageKey(resolved)]
        : (await this.list("**/*", { cwd: resolved, limit: 5000 })).map((entry) =>
            this.storageKey(entry.path),
          );
    if (keys.length === 0) return;
    const { error } = await this.supabase.storage.from(this.bucket).remove(keys);
    if (error) throw new Error(`Could not delete ${resolved}: ${error.message}`);
  }

  private async listRecursive(
    relativePrefix: string,
    limit: number,
  ): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    const stack = [relativePrefix];

    while (stack.length > 0 && entries.length < limit) {
      const current = stack.pop() ?? "";
      const { data, error } = await this.supabase.storage
        .from(this.bucket)
        .list(this.prefixed(current), {
          limit: 1000,
          sortBy: { column: "name", order: "asc" },
        });
      if (error) throw new Error(`Could not list workspace: ${error.message}`);

      for (const item of (data ?? []) as SupabaseFileObject[]) {
        const childRelative = joinStoragePrefix([current, item.name]);
        const absolutePath = resolveVirtualPath(childRelative, {
          root: this.root,
          cwd: this.root,
        });
        const stat = statFromFileObject(item);
        if (stat.type === "directory") {
          stack.push(childRelative);
          entries.push({ path: absolutePath, ...stat });
        } else {
          entries.push({ path: absolutePath, ...stat });
        }
        if (entries.length >= limit) break;
      }
    }

    return entries;
  }

  private storageKey(filePath: string): string {
    return this.prefixed(workspaceRelativePath(filePath, this.root));
  }

  private prefixed(relativePath: string): string {
    return joinStoragePrefix([this.prefix, relativePath]);
  }
}

function statFromFileObject(item: SupabaseFileObject): WorkspaceStat {
  const isDirectory = item.id == null && item.metadata == null;
  return {
    type: isDirectory ? "directory" : "file",
    size: item.metadata?.size ?? 0,
    mtimeMs: Date.parse(item.updated_at ?? item.created_at ?? "") || 0,
  };
}

function inferMimeType(filePath: string): string {
  switch (path.posix.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".tsx":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain; charset=utf-8";
  }
}

function requireOption(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
