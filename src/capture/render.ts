import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { ContextDraft, ExtractionResult, HookInput, Trigger } from "../types.js";
import { ensureDir, memoryDir } from "../lib/fs.js";
import { withFileLock } from "../lib/lock.js";
import { computeDraftFingerprint, DEDUP_ELIGIBLE_TYPES } from "./fingerprint.js";

export type MemoryFileOptions = {
  captureId: string;
  sessionId: string;
  date?: string;
  trigger: Trigger;
  sessionEndReason?: string;
  hookInput?: Partial<HookInput>;
  projectName: string;
  extraction: ExtractionResult;
  drafts?: ContextDraft[];
  contextIds?: Partial<Record<ContextDraft["memory_type"], string>>;
};

export async function writeMemoryFile(cwd: string, options: MemoryFileOptions): Promise<string> {
  const dir = memoryDir(cwd);
  await ensureDir(dir);
  const path = join(dir, `${options.captureId}.md`);
  await writeFile(path, renderMemoryMarkdown(options), "utf8");
  return path;
}

export async function backfillMemoryContextIds(
  memoryPath: string,
  contextIds: Partial<Record<ContextDraft["memory_type"], string>>
): Promise<void> {
  const entries = Object.entries(contextIds).filter(([, id]) => Boolean(id));
  if (!entries.length) return;

  await withFileLock(`${memoryPath}.lock`, async () => {
    const raw = await readFile(memoryPath, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return;

    const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
    frontmatter.context_ids = {
      ...(isRecord(frontmatter.context_ids) ? frontmatter.context_ids : {}),
      ...Object.fromEntries(entries)
    };

    const next = `---\n${YAML.stringify(frontmatter).trim()}\n---\n${raw.slice(match[0].length)}`;
    const tempPath = `${memoryPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, next, "utf8");
    await rename(tempPath, memoryPath);
  });
}

export function renderMemoryMarkdown(options: MemoryFileOptions): string {
  const tags = [...new Set([...(options.extraction.tags ?? []), `project:${options.projectName}`])]
    .filter((tag) => !tag.toLowerCase().startsWith("install:"));
  const memoryTypes = options.drafts?.map((draft) => draft.memory_type) ?? memoryTypesForExtraction(options.extraction);
  // Compute fingerprints for dedup-eligible drafts
  const fingerprints: Record<string, string> = {};
  if (options.drafts) {
    for (const draft of options.drafts) {
      if (DEDUP_ELIGIBLE_TYPES.has(draft.memory_type)) {
        fingerprints[draft.memory_type] = computeDraftFingerprint(draft);
      }
    }
  }

  const frontmatter = {
    id: options.captureId,
    context_ids: options.contextIds ?? {},
    fingerprints,
    session_id: options.sessionId,
    date: options.date ?? new Date().toISOString(),
    trigger: options.trigger,
    session_end_reason: options.hookInput?.reason ?? options.sessionEndReason,
    project: options.projectName,
    files_touched: options.extraction.files_touched,
    tags,
    memory_types: memoryTypes,
    summary: options.extraction.summary
  };

  return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${renderExtraction(options.extraction)}\n`;
}

export function memoryTypesForExtraction(extraction: ExtractionResult): Array<ContextDraft["memory_type"]> {
  const types: Array<ContextDraft["memory_type"]> = [];
  if ((extraction.decisions?.length ?? 0) > 0 || (extraction.gotchas?.length ?? 0) > 0) types.push("fact");
  if ((extraction.patterns?.length ?? 0) > 0) types.push("procedural");
  if (Boolean(extraction.state?.in_progress) || (extraction.state?.next_steps?.length ?? 0) > 0) types.push("episodic");
  return types;
}

export function makeCaptureId(date: string, summary: string, _trigger: Trigger): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${date.replace(/:/g, "-")}-${slug || "session"}`;
}

function renderFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if ((key === "context_ids" || key === "fingerprints") && typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [memoryType, id] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${memoryType}: ${JSON.stringify(id)}`);
      }
      continue;
    }
    lines.push(`${key}: ${Array.isArray(value) ? inlineJsonList(value) : JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

function inlineJsonList(value: unknown[]): string {
  return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
}

function renderExtraction(extraction: ExtractionResult): string {
  const parts: string[] = [];
  for (const decision of extraction.decisions) {
    parts.push(`## Decision: ${decision.title}\n\n${decision.rationale}${filesLine(decision.files)}`);
  }
  for (const gotcha of extraction.gotchas) {
    parts.push(`## Gotcha: ${gotcha.problem}\n\nCause: ${gotcha.cause}\n\nFix: ${gotcha.fix}${filesLine(gotcha.files)}`);
  }
  for (const pattern of extraction.patterns) {
    parts.push(`## Pattern: ${pattern.pattern}\n\nRationale: ${pattern.rationale}${filesLine(pattern.files)}`);
  }
  if (extraction.state.in_progress || extraction.state.next_steps?.length) {
    parts.push(
      [
        "## State",
        "",
        extraction.state.in_progress ? `In progress: ${extraction.state.in_progress}` : "",
        extraction.state.next_steps?.length ? `Next:\n${extraction.state.next_steps.map((step) => `- ${step}`).join("\n")}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
  return parts.length ? parts.join("\n\n") : `## Summary\n\n${extraction.summary}`;
}

function filesLine(files?: string[]): string {
  return files?.length ? `\n\n**Files:** ${files.map((file) => `\`${file}\``).join(", ")}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
