import type { AgentTool } from "../types.js";
import { asString } from "../utils/json.js";

export const AskUserQuestionTool: AgentTool = {
  name: "AskUserQuestion",
  description:
    "Ask the human a focused question when required information cannot be safely inferred.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask the user." },
    },
    required: ["question"],
  },
  readOnly: true,
  concurrencySafe: false,
  async execute(input, context) {
    const question = asString(input.question);
    if (!context.askUser) {
      return {
        content: `Cannot ask the user in this runtime. Question was: ${question}`,
        isError: true,
      };
    }
    const answer = await context.askUser(question);
    return { content: answer || "(user gave no answer)" };
  },
};

export const ExitPlanModeTool: AgentTool = {
  name: "ExitPlanMode",
  description:
    "Present an implementation plan to the user. In this standalone core it records the plan as tool output.",
  inputSchema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "Concise Markdown plan." },
    },
    required: ["plan"],
  },
  readOnly: true,
  concurrencySafe: false,
  async execute(input) {
    return { content: asString(input.plan) };
  },
};
