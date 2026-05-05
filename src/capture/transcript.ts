import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { ToolAction } from "../types.js";
import { ensureDir, sessionsDir } from "../lib/fs.js";

const DEFAULT_TRANSCRIPT_TEXT_MAX_CHARS = 80_000;
const DEFAULT_TOOL_ACTION_MAX = 200;

export type ParsedTranscript = {
  text: string;
  nextLine: number;
  toolActions: ToolAction[];
  truncated: boolean;
};

export type TranscriptParseOptions = {
  maxTextChars?: number;
  maxToolActions?: number;
};

export async function readSessionCursor(cwd: string, sessionId: string): Promise<number> {
  const path = sessionCursorPath(cwd, sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return 0;
    throw err;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function writeSessionCursor(cwd: string, sessionId: string, line: number): Promise<void> {
  const dir = sessionsDir(cwd);
  const path = sessionCursorPath(cwd, sessionId);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await ensureDir(dir);
  await writeFile(tmpPath, `${line}\n`, "utf8");
  await rename(tmpPath, path);
}

export async function transcriptToText(
  jsonlPath: string,
  sinceLine = 0,
  options: TranscriptParseOptions = {}
): Promise<ParsedTranscript> {
  const maxTextChars = positiveInteger(options.maxTextChars, transcriptTextMaxChars());
  const maxToolActions = positiveInteger(options.maxToolActions, DEFAULT_TOOL_ACTION_MAX);
  const turns = new RecentTextBuffer(maxTextChars);
  const toolActions: ToolAction[] = [];
  const seenToolActions = new Set<string>();
  let nextLine = 0;

  const lines = createInterface({
    input: createReadStream(jsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (!line) continue;
    const currentLine = nextLine;
    nextLine += 1;
    if (currentLine < sinceLine) continue;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "user") {
      const text = extractUserText(event.message?.content, maxTextChars);
      if (text) turns.append(`USER: ${text}`);
      continue;
    }

    if (event.type === "assistant") {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      let textBlocks = "";
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          textBlocks = appendTail(textBlocks, block.text.trim(), "\n", maxTextChars);
        } else if (block?.type === "tool_use") {
          const action = toolUseToLedgerEntry(block);
          if (action) appendToolAction(toolActions, seenToolActions, action, maxToolActions);
        }
      }
      if (textBlocks.length) turns.append(`ASSISTANT: ${textBlocks}`);
    }
  }

  const ledger = renderToolActionLedger(toolActions);
  return {
    text: [turns.render(), ledger].filter(Boolean).join("\n\n"),
    nextLine,
    toolActions,
    truncated: turns.truncated
  };
}

function extractUserText(content: unknown, maxTextChars: number): string {
  if (typeof content === "string") return tail(content.trim(), maxTextChars);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const value = block.text.trim();
    if (!value) continue;
    text = appendTail(text, value, "\n", maxTextChars);
  }
  return text;
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

export function safeSessionFilePart(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 160) || "session";
}

function sessionCursorPath(cwd: string, sessionId: string): string {
  return join(sessionsDir(cwd), `${safeSessionFilePart(sessionId)}.pos`);
}

function appendToolAction(
  actions: ToolAction[],
  seen: Set<string>,
  action: ToolAction,
  maxActions: number
): void {
  const key = toolActionKey(action);
  if (seen.has(key)) {
    const index = actions.findIndex((candidate) => toolActionKey(candidate) === key);
    if (index >= 0) actions.splice(index, 1);
  } else if (actions.length >= maxActions) {
    const removed = actions.shift();
    if (removed) seen.delete(toolActionKey(removed));
  }
  seen.add(key);
  actions.push(action);
}

function toolActionKey(action: ToolAction): string {
  return `${action.tool}:${action.operation ?? ""}:${action.file_path ?? ""}`;
}

class RecentTextBuffer {
  private value = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(turn: string): void {
    const rawLength = this.value ? this.value.length + 2 + turn.length : turn.length;
    const next = appendTail(this.value, turn, "\n\n", this.maxChars);
    if (next.length < rawLength) this.truncated = true;
    this.value = next;
  }

  render(): string {
    if (!this.truncated) return this.value;
    return [
      `[Earlier transcript text truncated; keeping the most recent ${this.maxChars} characters.]`,
      this.value.trimStart()
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}

function appendTail(existing: string, addition: string, separator: string, maxChars: number): string {
  const next = existing ? `${existing}${separator}${addition}` : addition;
  return tail(next, maxChars);
}

function tail(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function transcriptTextMaxChars(): number {
  const raw = process.env.NCTX_TRANSCRIPT_TEXT_MAX_CHARS;
  if (!raw) return DEFAULT_TRANSCRIPT_TEXT_MAX_CHARS;
  return positiveInteger(Number(raw), DEFAULT_TRANSCRIPT_TEXT_MAX_CHARS);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
