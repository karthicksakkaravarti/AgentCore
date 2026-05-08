import type {
  Workspace,
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceStat,
} from "./types.js";
import {
  globToRegExp,
  normalizeVirtualRoot,
  resolveVirtualPath,
  workspaceRelativePath,
} from "./path.js";

type MemoryFile = {
  content: string;
  mtimeMs: number;
};

export class MemoryWorkspace implements Workspace {
  readonly id = "memory";
  readonly cwd: string;
  private readonly root: string;
  private readonly files = new Map<string, MemoryFile>();

  constructor(options: { cwd?: string } = {}) {
    this.root = normalizeVirtualRoot(options.cwd ?? "/workspace");
    this.cwd = this.root;
  }

  resolvePath(filePath: string, cwd = this.cwd): string {
    return resolveVirtualPath(filePath, { root: this.root, cwd });
  }

  async read(filePath: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    const file = this.files.get(resolved);
    if (!file) throw new Error(`File not found: ${resolved}`);
    return file.content;
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.read(filePath));
  }

  async write(filePath: string, content: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    this.files.set(resolved, { content, mtimeMs: Date.now() });
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
    const file = this.files.get(resolved);
    if (file) {
      return {
        type: "file",
        size: Buffer.byteLength(file.content, "utf8"),
        mtimeMs: file.mtimeMs,
      };
    }

    const prefix = resolved === this.root ? `${resolved}/` : `${resolved}/`;
    if (resolved === this.root || [...this.files.keys()].some((key) => key.startsWith(prefix))) {
      return { type: "directory", size: 0, mtimeMs: 0 };
    }
    throw new Error(`Path not found: ${resolved}`);
  }

  async list(
    pattern: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceEntry[]> {
    const cwd = this.resolvePath(options.cwd ?? this.cwd);
    const matcher = globToRegExp(pattern);
    const entries: WorkspaceEntry[] = [];

    for (const [filePath, file] of this.files) {
      if (!isWithin(filePath, cwd)) continue;
      const relative = workspaceRelativePath(filePath, cwd);
      if (!matcher.test(relative)) continue;
      entries.push({
        path: filePath,
        type: "file",
        size: Buffer.byteLength(file.content, "utf8"),
        mtimeMs: file.mtimeMs,
      });
      if (entries.length >= (options.limit ?? 5000)) break;
    }

    return entries;
  }

  async delete(filePath: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    for (const key of [...this.files.keys()]) {
      if (key === resolved || key.startsWith(`${resolved}/`)) {
        this.files.delete(key);
      }
    }
  }
}

function isWithin(filePath: string, directory: string): boolean {
  return filePath === directory || filePath.startsWith(`${directory}/`);
}
