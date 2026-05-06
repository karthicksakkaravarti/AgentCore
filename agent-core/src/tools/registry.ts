import type { AgentTool } from "../types.js";
import { AgentTool as SubagentTool } from "./agentTool.js";
import { BashOutputTool, BashTool, KillShellTool } from "./bash.js";
import { EditTool, ReadTool, WriteTool } from "./files.js";
import { AskUserQuestionTool, ExitPlanModeTool } from "./interaction.js";
import { NotebookEditTool } from "./notebook.js";
import { GlobTool, GrepTool } from "./search.js";
import { TodoWriteTool } from "./todo.js";
import { WebFetchTool, WebSearchTool } from "./web.js";

export function defaultTools(): AgentTool[] {
  return [
    SubagentTool,
    BashTool,
    BashOutputTool,
    KillShellTool,
    ReadTool,
    WriteTool,
    EditTool,
    GlobTool,
    GrepTool,
    TodoWriteTool,
    NotebookEditTool,
    WebFetchTool,
    WebSearchTool,
    AskUserQuestionTool,
    ExitPlanModeTool,
  ];
}

export function filterTools(
  tools: AgentTool[],
  options: {
    allowedTools?: string[];
    disabledTools?: string[];
  },
): AgentTool[] {
  const allowed = new Set(options.allowedTools ?? []);
  const disabled = new Set(options.disabledTools ?? []);
  return tools.filter((tool) => {
    if (disabled.has(tool.name)) return false;
    if (allowed.size > 0 && !allowed.has(tool.name)) return false;
    return true;
  });
}

export function findTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((tool) => tool.name === name);
}
