import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import YAML from "yaml";
import type { ContextDraft, MemoryType, NctxConfig, Trigger } from "../types.js";
import { backfillMemoryContextIds } from "../capture/render.js";
import { loadConfig } from "../config/load.js";
import { memoryDir } from "../lib/fs.js";
import { drainPendingContexts } from "../lib/pending.js";
import { makeClient } from "../nia/hosted.js";

const AGENT_SOURCE = "nctx-claude-code";

type MemoryMarkdown = {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

export async function runReindex(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const client = makeClient(config);

  const drained = await drainPendingContexts(cwd, client);
  for (const item of drained.saved) {
    console.log(`Pushed pending ${item.pending.id} (${item.pending.draft.memory_type}) -> ${item.response.id}`);
    if (item.pending.memory_path) {
      await backfillMemoryContextIds(item.pending.memory_path, {
        [item.pending.draft.memory_type]: item.response.id
      });
    }
  }
  for (const item of drained.failed) {
    console.error(`Still pending ${basename(item.file_path)}: ${item.error.message}`);
  }

  const memories = await listMemoryMarkdown(cwd);
  for (const memory of memories) {
    const drafts = buildDraftsFromMemory(memory, config);
    const contextIds: Partial<Record<ContextDraft["memory_type"], string>> = {};
    for (const draft of drafts) {
      const saved = await client.saveContext(draft);
      contextIds[draft.memory_type] = saved.id;
      console.log(`Reindexed ${basename(memory.path)} (${draft.memory_type}) -> ${saved.id}`);
    }
    await backfillMemoryContextIds(memory.path, contextIds);
  }
}

export async function readMemoryFrontmatter(path: string): Promise<Record<string, unknown>> {
  return (await readMemoryMarkdown(path)).frontmatter;
}

async function listMemoryMarkdown(cwd: string): Promise<MemoryMarkdown[]> {
  const dir = memoryDir(cwd);
  const entries = await readdir(dir).catch(() => []);
  const memories: MemoryMarkdown[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md"))) {
    memories.push(await readMemoryMarkdown(join(dir, entry)));
  }
  return memories;
}

async function readMemoryMarkdown(path: string): Promise<MemoryMarkdown> {
  const raw = await readFile(path, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return {
    path,
    frontmatter: match ? (YAML.parse(match[1]) as Record<string, unknown>) : {},
    body: match ? raw.slice(match[0].length).trim() : raw.trim()
  };
}

function buildDraftsFromMemory(memory: MemoryMarkdown, config: NctxConfig): ContextDraft[] {
  const captureId = stringValue(memory.frontmatter.id) || basename(memory.path, ".md");
  const projectName = stringValue(memory.frontmatter.project) || config.project_name;
  const sessionId = stringValue(memory.frontmatter.session_id) || captureId;
  const trigger = triggerValue(memory.frontmatter.trigger);
  const summary = stringValue(memory.frontmatter.summary) || `NCtx memory ${captureId}`;
  const baseTags = normalizeTags([
    ...arrayOfStrings(memory.frontmatter.tags),
    `project:${projectName}`,
    "nctx",
    "reindexed"
  ]);
  const filesTouched = arrayOfStrings(memory.frontmatter.files_touched);
  const metadata = {
    nctx_version: config.version,
    session_id: sessionId,
    project_name: projectName,
    trigger,
    capture_id: captureId,
    files_touched: filesTouched,
    reindexed_at: new Date().toISOString()
  };
  const edited_files = filesTouched.map((file_path) => ({
    file_path,
    operation: "edited",
    changes_description: "Touched during the captured Claude Code session."
  }));

  const drafts: ContextDraft[] = [];
  for (const memoryType of memoryTypes(memory.frontmatter.memory_types)) {
    const content = contentForMemoryType(memory.body, memoryType);
    if (!content) continue;
    drafts.push({
      title: titleFor(summary, suffixFor(memoryType)),
      summary,
      content,
      tags: normalizeTags([...baseTags, ...tagsFor(memoryType)]),
      agent_source: AGENT_SOURCE,
      memory_type: memoryType,
      metadata,
      edited_files
    });
  }
  return drafts;
}

function contentForMemoryType(body: string, memoryType: ContextDraft["memory_type"]): string {
  const sections = splitSections(body);
  const selected = sections.filter((section) => {
    if (memoryType === "fact") return /^## (Decision|Gotcha):/.test(section.heading);
    if (memoryType === "procedural") return /^## Pattern:/.test(section.heading);
    return /^## State\b/.test(section.heading);
  });
  const content = selected.map((section) => section.raw).join("\n\n").trim();
  if (content) return content;
  return sections.length <= 1 ? body.trim() : "";
}

function splitSections(body: string): Array<{ heading: string; raw: string }> {
  const matches = [...body.matchAll(/^## .+$/gm)];
  if (!matches.length) return body.trim() ? [{ heading: "", raw: body.trim() }] : [];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? body.length : body.length;
    return {
      heading: match[0],
      raw: body.slice(start, end).trim()
    };
  });
}

function memoryTypes(value: unknown): Array<Exclude<MemoryType, "scratchpad">> {
  const input = Array.isArray(value) ? value : [];
  return input.filter(
    (item): item is Exclude<MemoryType, "scratchpad"> =>
      item === "fact" || item === "procedural" || item === "episodic"
  );
}

function triggerValue(value: unknown): Trigger {
  return value === "session-end" || value === "precompact" || value === "manual" ? value : "manual";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter(Boolean)
        .filter((tag) => !tag.startsWith("install:"))
    )
  ];
}

function tagsFor(memoryType: ContextDraft["memory_type"]): string[] {
  if (memoryType === "fact") return ["decisions", "gotchas"];
  if (memoryType === "procedural") return ["patterns"];
  return ["state", "next-steps"];
}

function suffixFor(memoryType: ContextDraft["memory_type"]): string {
  if (memoryType === "fact") return "decisions and gotchas";
  if (memoryType === "procedural") return "patterns";
  return "current state";
}

function titleFor(summary: string, suffix: string): string {
  const title = `${summary.trim() || "NCtx session memory"} - ${suffix}`;
  return title.length > 200 ? `${title.slice(0, 197).trimEnd()}...` : title;
}
