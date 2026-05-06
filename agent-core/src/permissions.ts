import type {
  AgentTool,
  JsonObject,
  PermissionDecision,
  PermissionMode,
  PermissionPrompt,
  ToolExecutionContext,
} from "./types.js";

function valueFromFlag(
  flag: boolean | ((input: JsonObject) => boolean) | undefined,
  input: JsonObject,
): boolean {
  if (typeof flag === "function") return flag(input);
  return Boolean(flag);
}

export function isToolReadOnly(tool: AgentTool, input: JsonObject): boolean {
  return valueFromFlag(tool.readOnly, input);
}

export function isToolConcurrencySafe(
  tool: AgentTool,
  input: JsonObject,
): boolean {
  return valueFromFlag(tool.concurrencySafe ?? tool.readOnly, input);
}

export async function decidePermission(
  tool: AgentTool,
  input: JsonObject,
  context: ToolExecutionContext,
  options: {
    mode: PermissionMode;
    prompt?: PermissionPrompt;
  },
): Promise<PermissionDecision> {
  if (context.state.alwaysDeniedTools.has(tool.name)) {
    return {
      behavior: "deny",
      message: `${tool.name} was denied for this session.`,
    };
  }

  if (
    options.mode === "bypassPermissions" ||
    context.state.alwaysAllowedTools.has(tool.name)
  ) {
    return { behavior: "allow" };
  }

  const readOnly = isToolReadOnly(tool, input);
  const destructive =
    typeof tool.destructive === "function"
      ? tool.destructive(input)
      : Boolean(tool.destructive);

  if (readOnly && !destructive) {
    return { behavior: "allow" };
  }

  if (options.mode === "plan") {
    return {
      behavior: "deny",
      message:
        "Plan mode is active. Mutating tools are disabled until the plan is accepted.",
    };
  }

  if (options.mode === "acceptEdits" && ["Edit", "Write", "TodoWrite"].includes(tool.name)) {
    return { behavior: "allow" };
  }

  if (!options.prompt) {
    return {
      behavior: "deny",
      message: `${tool.name} requires permission in ${options.mode} mode.`,
    };
  }

  const decision = await options.prompt(tool, input, {
    reason: destructive
      ? "This tool may perform a destructive or hard-to-reverse action."
      : "This tool can modify local state or run commands.",
    signal: context.abortSignal,
  });

  if (decision.behavior === "allow" && decision.remember) {
    context.state.alwaysAllowedTools.add(tool.name);
  }
  if (decision.behavior === "deny" && decision.interrupt) {
    context.state.alwaysDeniedTools.add(tool.name);
  }

  return decision;
}
