import { spawn } from "node:child_process";
import crypto from "node:crypto";
import type { BackgroundShell } from "../types.js";

const MAX_BUFFER_LINES = 2000;

export function startBackgroundShell(command: string, cwd: string): BackgroundShell {
  const id = `bash_${crypto.randomUUID().slice(0, 8)}`;
  const child = spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const shell: BackgroundShell = {
    id,
    command,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    stdout: [],
    stderr: [],
    readCursor: 0,
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
  };

  child.stdout?.on("data", (chunk: Buffer) => pushLines(shell.stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => pushLines(shell.stderr, chunk));
  child.on("close", (code) => {
    shell.done = true;
    shell.exitCode = code;
  });
  child.on("error", (error) => {
    pushLines(shell.stderr, Buffer.from(`${error.message}\n`));
    shell.done = true;
  });

  return shell;
}

function pushLines(target: string[], chunk: Buffer): void {
  target.push(...chunk.toString("utf8").split(/\r?\n/));
  if (target.length > MAX_BUFFER_LINES) {
    target.splice(0, target.length - MAX_BUFFER_LINES);
  }
}
