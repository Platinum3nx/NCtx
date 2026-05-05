import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ToolAction } from "../types.js";
import { ensureDir, sessionsDir } from "../lib/fs.js";

export type ParsedTranscript = {
  text: string;
  nextLine: number;
  toolActions: ToolAction[];
};

export async function readSessionCursor(cwd: string, sessionId: string): Promise<number> {
  const path = join(sessionsDir(cwd), `${sessionId}.pos`);
  if (!existsSync(path)) return 0;
  const raw = await readFile(path, "utf8");
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function writeSessionCursor(cwd: string, sessionId: string, line: number): Promise<void> {
  const dir = sessionsDir(cwd);
  await ensureDir(dir);
  await writeFile(join(dir, `${sessionId}.pos`), `${line}\n`, "utf8");
}

export async function transcriptToText(jsonlPath: string, sinceLine = 0): Promise<ParsedTranscript> {
  const raw = await readFile(jsonlPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const turns: string[] = [];
  const toolActions: ToolAction[] = [];

  for (const line of lines.slice(sinceLine)) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "user") {
      const text = extractUserText(event.message?.content);
      if (text) turns.push(`USER: ${text}`);
      continue;
    }

    if (event.type === "assistant") {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      const textBlocks: string[] = [];
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          textBlocks.push(block.text.trim());
        } else if (block?.type === "tool_use") {
          const action = toolUseToLedgerEntry(block);
          if (action) toolActions.push(action);
        }
      }
      if (textBlocks.length) turns.push(`ASSISTANT: ${textBlocks.join("\n")}`);
    }
  }

  const ledger = renderToolActionLedger(toolActions);
  return {
    text: [turns.join("\n\n"), ledger].filter(Boolean).join("\n\n"),
    nextLine: lines.length,
    toolActions
  };
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function toolUseToLedgerEntry(block: any): ToolAction | null {
  const tool = block.name || block.tool_name;
  const input = block.input || {};
  if (!tool || typeof tool !== "string") return null;

  const filePath = input.file_path || input.path || input.notebook_path || input.old_path || input.new_path;
  let operation: ToolAction["operation"] = "tool";
  if (/^(Read|Grep|Glob|LS|View)$/.test(tool)) operation = "read";
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(tool)) operation = "edit";
  if (/^(Bash|exec_command)$/.test(tool)) operation = "command";

  return {
    tool,
    file_path: typeof filePath === "string" ? filePath : undefined,
    operation
  };
}

export function renderToolActionLedger(actions: ToolAction[]): string {
  const seen = new Set<string>();
  const compact: ToolAction[] = [];
  for (const action of actions) {
    const key = `${action.tool}:${action.operation ?? ""}:${action.file_path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compact.push(action);
    if (compact.length >= 200) break;
  }
  if (!compact.length) return "";
  return [
    "TOOL ACTION LEDGER (compact; tool outputs omitted):",
    ...compact.map((action) => {
      const op = action.operation ? ` (${action.operation})` : "";
      const file = action.file_path ? `: ${action.file_path}` : "";
      return `- ${action.tool}${op}${file}`;
    })
  ].join("\n");
}

export function defaultCaptureId(sessionId: string, date = new Date()): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}-${basename(sessionId).slice(0, 8)}`;
}

