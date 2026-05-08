import type { BackgroundShell } from "../types.js";

export type RuntimeExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type RuntimeExecOptions = {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
};

export type RuntimeSpawnOptions = {
  cwd: string;
};

export interface Runtime {
  readonly id: string;
  exec(command: string, options: RuntimeExecOptions): Promise<RuntimeExecResult>;
  spawn(command: string, options: RuntimeSpawnOptions): BackgroundShell;
}
