import chalk from "chalk";
import figlet from "figlet";

export function printBanner(version: string): void {
  const art = figlet.textSync("CLI", { font: "Big" });
  process.stdout.write("\n" + chalk.bold.cyan(art) + "\n");
  process.stdout.write(chalk.dim(`  v${version} — AI Agent CLI\n\n`));
  process.stdout.write(
    chalk.dim("  Tips: ") +
      chalk.white("Tab") +
      chalk.dim(" completes /commands  ") +
      chalk.white("Ctrl+C") +
      chalk.dim(" cancels\n"),
  );
  process.stdout.write(
    chalk.dim("  Commands: /exit /clear /usage /tools /sessions /model <name>\n\n"),
  );
}
