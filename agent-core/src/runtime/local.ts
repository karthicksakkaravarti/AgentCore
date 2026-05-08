import type { BackgroundShell } from "../types.js";
import { execShellCommand } from "../utils/process.js";
import { startBackgroundShell } from "../tools/backgroundShells.js";
import type {
  Runtime,
  RuntimeExecOptions,
  RuntimeExecResult,
  RuntimeSpawnOptions,
} from "./types.js";

export class LocalRuntime implements Runtime {
  readonly id = "local";

  exec(
    command: string,
    options: RuntimeExecOptions,
  ): Promise<RuntimeExecResult> {
    return execShellCommand(command, options);
  }

  spawn(command: string, options: RuntimeSpawnOptions): BackgroundShell {
    return startBackgroundShell(command, options.cwd);
  }
}
