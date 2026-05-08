import fg from "fast-glob";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Workspace,
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceStat,
} from "./types.js";
import { resolveLocalPath } from "./path.js";

export class LocalWorkspace implements Workspace {
  readonly id = "local";
  readonly cwd: string;

  constructor(options: { cwd: string }) {
    this.cwd = path.resolve(options.cwd);
  }

  resolvePath(filePath: string, cwd = this.cwd): string {
    return resolveLocalPath(filePath, cwd);
  }

  async read(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    return readFile(filePath);
  }

  async write(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<WorkspaceStat> {
    const info = await stat(filePath);
    return {
      type: info.isDirectory() ? "directory" : "file",
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  }

  async list(
    pattern: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceEntry[]> {
    const cwd = options.cwd ? this.resolvePath(options.cwd) : this.cwd;
    const matches = await fg(pattern, {
      cwd,
      absolute: true,
      dot: true,
      onlyFiles: options.includeDirectories === true ? false : true,
      followSymbolicLinks: false,
      unique: true,
    });
    const entries = await Promise.all(
      matches.slice(0, options.limit ?? 5000).map(async (filePath) => ({
        path: filePath,
        ...(await this.stat(filePath)),
      })),
    );
    return entries;
  }

  async delete(filePath: string): Promise<void> {
    await rm(filePath, { recursive: true, force: true });
  }
}
