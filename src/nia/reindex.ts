import type { ParsedMemoryFile } from "../lib/memory-files.js";
import { memorySummary, memoryTitle } from "../lib/memory-files.js";
import { AGENT_SOURCE } from "../lib/constants.js";
import type { ContextDraft } from "../types.js";

type ReindexMemoryType = ContextDraft["memory_type"];

const SECTION_TO_MEMORY_TYPE: Array<{ pattern: RegExp; memoryType: ReindexMemoryType }> = [
  { pattern: /^(decisions?|gotchas?)/i, memoryType: "fact" },
  { pattern: /^(patterns?|procedures?|playbooks?)/i, memoryType: "procedural" },
  { pattern: /^(state|current state|next steps?|handoff|open questions?)/i, memoryType: "episodic" }
];

export function buildContextDraftsFromMemory(memory: ParsedMemoryFile): ContextDraft[] {
  const explicit = explicitContextDrafts(memory);
  if (explicit.length > 0) return explicit;

  const split = splitByKnownSections(memory);
  if (split.length > 0) return split;

  const memoryType = isMemoryType(memory.frontmatter.memory_type) ? memory.frontmatter.memory_type : "episodic";
  return [draft(memory, memoryType, memory.body)];
}

function explicitContextDrafts(memory: ParsedMemoryFile): ContextDraft[] {
  const candidates = memory.frontmatter.contexts ?? memory.frontmatter.nctx_contexts;
  if (!candidates) return [];

  if (Array.isArray(candidates)) {
    return candidates.flatMap((candidate) => draftFromUnknown(memory, candidate));
  }

  if (typeof candidates === "object" && candidates !== null) {
    return Object.entries(candidates as Record<string, unknown>).flatMap(([memoryType, value]) => {
      if (!isMemoryType(memoryType)) return [];
      return draftFromUnknown(memory, value, memoryType);
    });
  }

  return [];
}

function draftFromUnknown(
  memory: ParsedMemoryFile,
  value: unknown,
  forcedType?: ReindexMemoryType
): ContextDraft[] {
  if (typeof value === "string") {
    return [draft(memory, forcedType ?? "episodic", value)];
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const memoryType = forcedType ?? (isMemoryType(record.memory_type) ? record.memory_type : null);
  if (!memoryType) return [];

  const content = typeof record.content === "string" ? record.content : "";
  if (!content.trim()) return [];

  return [
    {
      title: stringValue(record.title, `${memoryTitle(memory)} (${memoryType})`),
      summary: safeSummary(stringValue(record.summary, memorySummary(memory))),
      content,
      tags: stringArray(record.tags),
      agent_source: AGENT_SOURCE,
      memory_type: memoryType,
      metadata: metadataFor(memory),
      edited_files: editedFiles(memory.frontmatter.edited_files)
    }
  ];
}

function splitByKnownSections(memory: ParsedMemoryFile): ContextDraft[] {
  const sections = memory.body.split(/^##\s+/m);
  if (sections.length <= 1) return [];

  const drafts: ContextDraft[] = [];
  for (const section of sections.slice(1)) {
    const [headingLine = "", ...rest] = section.split("\n");
    const match = SECTION_TO_MEMORY_TYPE.find(({ pattern }) => pattern.test(headingLine.trim()));
    const content = rest.join("\n").trim();
    if (!match || content.length < 50) continue;
    drafts.push(draft(memory, match.memoryType, `## ${headingLine}\n${content}`));
  }
  return drafts;
}

function draft(memory: ParsedMemoryFile, memoryType: ReindexMemoryType, content: string): ContextDraft {
  return {
    title: `${memoryTitle(memory)} (${memoryType})`.slice(0, 200),
    summary: safeSummary(memorySummary(memory)),
    content: ensureMinimumContent(content),
    tags: tagsFor(memory),
    agent_source: AGENT_SOURCE,
    memory_type: memoryType,
    metadata: metadataFor(memory),
    edited_files: editedFiles(memory.frontmatter.edited_files)
  };
}

function tagsFor(memory: ParsedMemoryFile): string[] {
  const tags = stringArray(memory.frontmatter.tags).filter((tag) => !tag.startsWith("install:"));
  const projectName = memory.frontmatter.project_name;
  if (typeof projectName === "string" && projectName.trim()) {
    tags.push(`project:${projectName.trim()}`);
  }
  return [...new Set(tags)];
}

function metadataFor(memory: ParsedMemoryFile): Record<string, unknown> {
  return {
    ...(typeof memory.frontmatter.metadata === "object" && memory.frontmatter.metadata !== null
      ? (memory.frontmatter.metadata as Record<string, unknown>)
      : {}),
    capture_id: memory.id,
    source_file: memory.file_path,
    trigger: memory.frontmatter.trigger
  };
}

function editedFiles(value: unknown): Array<{ file_path: string; operation: string; changes_description: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .filter((item) => typeof item.file_path === "string")
    .map((item) => ({
      file_path: item.file_path as string,
      operation: typeof item.operation === "string" ? item.operation : "edited",
      changes_description:
        typeof item.changes_description === "string" && item.changes_description.trim()
          ? item.changes_description
          : "Touched during the captured Claude Code session."
    }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isMemoryType(value: unknown): value is ReindexMemoryType {
  return value === "fact" || value === "procedural" || value === "episodic";
}

function safeSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (normalized.length >= 10) return normalized.slice(0, 1000);
  return "NCtx memory reindexed from a local capture file.";
}

function ensureMinimumContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length >= 50) return trimmed;
  return `${trimmed}\n\nAdditional NCtx memory content preserved from the local capture file.`;
}
