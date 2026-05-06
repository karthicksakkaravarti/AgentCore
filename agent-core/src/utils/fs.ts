import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";

export function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || cwd;
    return path.resolve(home, filePath.slice(1));
  }
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd, filePath);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export function formatLineNumber(line: number, text: string): string {
  return `${String(line).padStart(6, " ")}\t${text}`;
}
