import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NeutralMessage } from "./providers/types.js";
import { pathExists } from "./utils/fs.js";
import { truncateMiddle } from "./utils/json.js";
import type { Workspace } from "./workspace/types.js";

const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_TOTAL_ATTACHMENT_CHARS = 120000;

export type ProjectInstruction = {
  path: string;
  content: string;
};

export type AgentContext = {
  projectInstructions: ProjectInstruction[];
  attachmentMessages: NeutralMessage[];
};

export async function buildAgentContext(options: {
  cwd: string;
  workspace?: Workspace;
  additionalInstructionDirs?: string[];
}): Promise<AgentContext> {
  const projectInstructions = await discoverProjectInstructions(options);
  return {
    projectInstructions,
    attachmentMessages: buildContextAttachmentMessages(projectInstructions),
  };
}

export async function discoverProjectInstructions(options: {
  cwd: string;
  workspace?: Workspace;
  additionalInstructionDirs?: string[];
}): Promise<ProjectInstruction[]> {
  const candidates = new Set<string>();
  for (const dir of getAncestorDirs(options.cwd)) {
    candidates.add(path.join(dir, "CLAUDE.md"));
  }
  for (const dir of options.additionalInstructionDirs ?? []) {
    candidates.add(path.join(path.resolve(dir), "CLAUDE.md"));
  }

  const instructions: ProjectInstruction[] = [];
  for (const filePath of candidates) {
    if (!(await instructionExists(filePath, options.workspace))) continue;
    const content = await readLimitedTextFile(filePath, options.workspace);
    if (!content.trim()) continue;
    instructions.push({
      path: filePath,
      content,
    });
  }

  return instructions;
}

export function formatProjectInstructionIndex(
  instructions: ProjectInstruction[],
): string | null {
  if (instructions.length === 0) return null;
  return [
    "# Project Instructions",
    "The following project instruction files were discovered and attached as context messages. Treat them as user-provided project guidance. If instructions conflict with the latest user request, follow the latest user request and explain the conflict when relevant.",
    ...instructions.map((instruction) => `- ${instruction.path}`),
  ].join("\n");
}

function buildContextAttachmentMessages(
  instructions: ProjectInstruction[],
): NeutralMessage[] {
  if (instructions.length === 0) return [];

  let remaining = MAX_TOTAL_ATTACHMENT_CHARS;
  const blocks = instructions.map((instruction) => {
    const content = truncateMiddle(instruction.content, remaining);
    remaining = Math.max(0, remaining - content.length);
    return [
      `<context-attachment type="project-instructions" path="${escapeAttribute(instruction.path)}">`,
      content,
      "</context-attachment>",
    ].join("\n");
  });

  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "The following context attachments were discovered before the conversation started. Use them as project guidance.",
            "",
            ...blocks,
          ].join("\n"),
        },
      ],
    },
  ];
}

function getAncestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    dirs.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function instructionExists(
  filePath: string,
  workspace?: Workspace,
): Promise<boolean> {
  return workspace ? workspace.exists(filePath) : pathExists(filePath);
}

async function readLimitedTextFile(
  filePath: string,
  workspace?: Workspace,
): Promise<string> {
  const buffer = workspace
    ? Buffer.from(await workspace.readBytes(filePath))
    : await readFile(filePath);
  const truncated = buffer.byteLength > MAX_INSTRUCTION_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_INSTRUCTION_BYTES) : buffer;
  const content = slice.toString("utf8");
  return truncated
    ? `${content}\n\n... truncated at ${MAX_INSTRUCTION_BYTES} bytes ...`
    : content;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
