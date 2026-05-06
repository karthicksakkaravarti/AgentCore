export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  return Math.max(min, Math.min(max, raw));
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function stringifyForToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncateMiddle(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const half = Math.floor((maxChars - 80) / 2);
  return `${input.slice(0, half)}\n\n... <truncated ${input.length - maxChars} chars> ...\n\n${input.slice(-half)}`;
}
