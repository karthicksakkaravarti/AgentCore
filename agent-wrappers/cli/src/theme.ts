import chalk from "chalk";

export const thinking = chalk.dim.cyan;
export const turnHeader = (n: number, m: string): string =>
  chalk.dim.cyan(`\n[turn ${n}] ${m}\n`);
export const toolStartHeader = (name: string): string =>
  chalk.yellow.bold(`\n  tool ❯ ${name}`);
export const toolInput = chalk.dim;
export const toolSuccess = (name: string): string => chalk.green(`  ✔ ${name}`);
export const toolError = (name: string): string => chalk.red.bold(`  ✖ ${name}`);
export const toolResultBody = chalk.dim;
export const promptSymbol = chalk.bold.blue("❯ ");
export const dimText = chalk.dim;
export const errorText = chalk.red;
export const permBoxTop = chalk.yellow("┌─ Tool Permission ─────────────────────┐");
export const permBoxBottom = chalk.yellow("└───────────────────────────────────────┘");
export const permBoxSide = chalk.yellow("│");
export const permToolName = chalk.yellow.bold;
export const permReason = chalk.white;
