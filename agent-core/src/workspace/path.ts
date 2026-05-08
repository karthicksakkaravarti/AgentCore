import path from "node:path";

export function resolveLocalPath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || cwd;
    return path.resolve(home, filePath.slice(1));
  }
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd, filePath);
}

export function normalizeVirtualRoot(root: string): string {
  const normalized = normalizeAbsoluteVirtualPath(root || "/workspace");
  return normalized === "/" ? "/workspace" : normalized;
}

export function resolveVirtualPath(
  inputPath: string,
  options: { root: string; cwd?: string },
): string {
  const root = normalizeVirtualRoot(options.root);
  const cwd = normalizeCwdWithinRoot(options.cwd ?? root, root);
  const raw = normalizeSlashes(inputPath || ".");
  const joined = raw.startsWith("/")
    ? raw === root || raw.startsWith(`${root}/`)
      ? raw
      : path.posix.join(root, raw)
    : path.posix.join(cwd, raw);
  const resolved = normalizeAbsoluteVirtualPath(joined);

  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return resolved;
}

export function workspaceRelativePath(absolutePath: string, root: string): string {
  const normalizedRoot = normalizeVirtualRoot(root);
  const normalized = resolveVirtualPath(absolutePath, { root: normalizedRoot });
  if (normalized === normalizedRoot) return "";
  return normalized.slice(normalizedRoot.length + 1);
}

export function joinStoragePrefix(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => normalizeSlashes(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeSlashes(pattern || "**/*");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const following = normalized[index + 2];
      if (following === "/") {
        source += "(?:.*\\/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  source += "$";
  return new RegExp(source);
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeCwdWithinRoot(cwd: string, root: string): string {
  const raw = normalizeSlashes(cwd || root);
  const normalized = normalizeAbsoluteVirtualPath(
    raw.startsWith("/")
      ? raw === root || raw.startsWith(`${root}/`)
        ? raw
        : path.posix.join(root, raw)
      : path.posix.join(root, raw),
  );
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`Path escapes workspace root: ${cwd}`);
  }
  return normalized;
}

function normalizeAbsoluteVirtualPath(value: string): string {
  const normalized = path.posix.normalize(`/${normalizeSlashes(value)}`);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
