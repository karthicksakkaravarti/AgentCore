import crypto from "node:crypto";
import type { BackgroundShell } from "../types.js";
import type {
  Runtime,
  RuntimeExecOptions,
  RuntimeExecResult,
  RuntimeSpawnOptions,
} from "./types.js";

const MESSAGE = "Shell execution is not available in this environment.";

export class DisabledRuntime implements Runtime {
  readonly id = "disabled";

  async exec(
    _command: string,
    _options: RuntimeExecOptions,
  ): Promise<RuntimeExecResult> {
    return {
      stdout: "",
      stderr: MESSAGE,
      exitCode: 126,
      timedOut: false,
    };
  }

  spawn(command: string, _options: RuntimeSpawnOptions): BackgroundShell {
    return {
      id: `bash_${crypto.randomUUID().slice(0, 8)}`,
      command,
      startedAt: Date.now(),
      done: true,
      exitCode: 126,
      stdout: [],
      stderr: [MESSAGE],
      readCursor: 0,
      kill() {
        return undefined;
      },
    };
  }
}
