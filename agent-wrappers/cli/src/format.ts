export function truncateMiddle(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const half = Math.floor((maxChars - 80) / 2);
  return `${input.slice(0, half)}\n\n... <truncated ${
    input.length - maxChars
  } chars> ...\n\n${input.slice(-half)}`;
}
