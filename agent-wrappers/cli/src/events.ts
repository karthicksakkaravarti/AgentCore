import type { AgentEvent } from "@agent-core/core";
import ora, { type Ora } from "ora";
import { truncateMiddle } from "./format.js";
import * as theme from "./theme.js";

export function createEventPrinter(verbose: boolean): (event: AgentEvent) => void {
  let spinner: Ora | null = null;
  let sawTextDelta = false;

  function stopSpinner(): void {
    spinner?.stop();
    spinner = null;
  }

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "request":
        stopSpinner();
        sawTextDelta = false;
        process.stdout.write(theme.turnHeader(event.turn, event.model));
        spinner = ora({
          text: theme.thinking("Thinking…"),
          spinner: "dots",
          color: "cyan",
          stream: process.stdout,
          discardStdin: false,
        }).start();
        break;

      case "text_delta":
        if (!sawTextDelta) {
          stopSpinner();
          sawTextDelta = true;
        }
        process.stdout.write(event.text);
        break;

      case "tool_start":
        stopSpinner();
        process.stdout.write(theme.toolStartHeader(event.name) + "\n");
        process.stdout.write(
          theme.toolInput("  " + truncateMiddle(JSON.stringify(event.input), 200)) + "\n",
        );
        break;

      case "tool_result": {
        const preview = verbose
          ? event.result.content
          : event.result.content.split(/\r?\n/).slice(0, 8).join("\n");
        process.stdout.write(
          (event.result.isError ? theme.toolError(event.name) : theme.toolSuccess(event.name)) +
            "\n",
        );
        process.stdout.write(
          theme.toolResultBody(truncateMiddle(preview, verbose ? 12000 : 2000)) + "\n",
        );
        break;
      }

      case "tool_use_delta":
        if (verbose && event.partialJson) {
          process.stdout.write(
            theme.dimText(`[tool input] ${event.id} ${event.partialJson}\n`),
          );
        }
        break;

      case "assistant_text":
        if (!sawTextDelta) {
          stopSpinner();
          sawTextDelta = true;
          process.stdout.write(event.text + "\n");
        }
        break;

      case "usage":
        if (verbose) process.stdout.write(theme.dimText(`[usage] ${JSON.stringify(event.usage)}\n`));
        break;

      case "assistant_message":
        break;
    }
  };
}
