import type { AgentTool as CoreAgentTool } from "../types.js";
import { asString } from "../utils/json.js";

export const AgentTool: CoreAgentTool = {
  name: "Agent",
  description:
    "Run a focused subagent for an independent investigation or implementation task. The subagent has its own conversation and returns a concise result.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Short 3-5 word description of the task.",
      },
      prompt: { type: "string", description: "Task for the subagent." },
      subagent_type: {
        type: "string",
        description: "Optional agent type label, e.g. general-purpose.",
      },
    },
    required: ["description", "prompt"],
  },
  readOnly: false,
  destructive: false,
  concurrencySafe: true,
  async execute(input, context) {
    if (!context.runSubagent) {
      return {
        content: "Subagents are not available in this runtime.",
        isError: true,
      };
    }
    const result = await context.runSubagent(
      asString(input.prompt),
      asString(input.description),
    );
    return { content: result };
  },
};
