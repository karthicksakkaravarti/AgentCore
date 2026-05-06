import type { AgentTool, TodoItem } from "../types.js";

export const TodoWriteTool: AgentTool = {
  name: "TodoWrite",
  description:
    "Create or update the current task list. Use it for multi-step work and keep statuses current.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
            activeForm: { type: "string" },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["todos"],
  },
  readOnly: false,
  destructive: false,
  async execute(input, context) {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    context.state.todos = todos.map((todo) => ({
      content: String((todo as TodoItem).content ?? ""),
      status: normalizeStatus((todo as TodoItem).status),
      activeForm: String((todo as TodoItem).activeForm ?? (todo as TodoItem).content ?? ""),
    }));
    return {
      content: context.state.todos.length
        ? context.state.todos
            .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
            .join("\n")
        : "Todo list cleared.",
    };
  },
};

function normalizeStatus(value: unknown): TodoItem["status"] {
  return value === "in_progress" || value === "completed" ? value : "pending";
}
