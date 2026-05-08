export type WorkspaceEntryType = "file" | "directory";

export type WorkspaceStat = {
  type: WorkspaceEntryType;
  size: number;
  mtimeMs: number;
};

export type WorkspaceEntry = WorkspaceStat & {
  path: string;
};

export type WorkspaceListOptions = {
  cwd?: string;
  limit?: number;
  includeDirectories?: boolean;
};

export interface Workspace {
  readonly id: string;
  readonly cwd: string;
  resolvePath(path: string, cwd?: string): string;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<WorkspaceStat>;
  list(pattern: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]>;
  delete(path: string): Promise<void>;
}
