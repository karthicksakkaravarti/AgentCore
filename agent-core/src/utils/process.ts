import { spawn } from "node:child_process";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export function execShellCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 1000).unref();
    }, options.timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 1000).unref();
    };

    options.signal.addEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (code) => finish(code));
  });
}
