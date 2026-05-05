import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { memoriesDir } from "../config/load.js";
import { type MemoryType } from "./constants.js";

export interface ParsedMemoryFile {
  file_path: string;
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export async function listMemoryFiles(projectRoot: string): Promise<ParsedMemoryFile[]> {
  const dir = memoriesDir(projectRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const markdown = names.filter((name) => name.endsWith(".md")).sort().reverse();
  const files: ParsedMemoryFile[] = [];
  for (const name of markdown) {
    files.push(await readMemoryFile(path.join(dir, name)));
  }
  return files;
}

export async function readMemoryFile(filePath: string): Promise<ParsedMemoryFile> {
  const raw = await readFile(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    file_path: filePath,
    id: path.basename(filePath, ".md"),
    frontmatter,
    body,
    raw
  };
}

export async function findMemoryFile(projectRoot: string, idOrContextId: string): Promise<ParsedMemoryFile | null> {
  const files = await listMemoryFiles(projectRoot);
  return (
    files.find((file) => file.id === idOrContextId || file.id.includes(idOrContextId)) ??
    files.find((file) => JSON.stringify(file.frontmatter).includes(idOrContextId)) ??
    null
  );
}

export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, body: raw };
  }

  const close = raw.indexOf("\n---", 4);
  if (close === -1) {
    return { frontmatter: {}, body: raw };
  }

  const yaml = raw.slice(4, close);
  const body = raw.slice(close + 4).replace(/^\n/, "");
  const parsed = YAML.parse(yaml);
  return {
    frontmatter:
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body
  };
}

export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body.replace(/^\n/, "")}`;
}

export async function updateMemoryContextId(
  filePath: string,
  memoryType: MemoryType,
  contextId: string
): Promise<void> {
  const memory = await readMemoryFile(filePath);
  const contextIds = normalizeObject(memory.frontmatter.context_ids);
  const current = Array.isArray(contextIds[memoryType]) ? contextIds[memoryType] : [];
  contextIds[memoryType] = [...new Set([...current, contextId])];
  memory.frontmatter.context_ids = contextIds;
  await writeFile(filePath, serializeFrontmatter(memory.frontmatter, memory.body), "utf8");
}

export function memoryTitle(memory: ParsedMemoryFile): string {
  const title = memory.frontmatter.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  const firstHeading = memory.body.match(/^#\s+(.+)$/m)?.[1];
  return firstHeading?.trim() || memory.id;
}

export function memorySummary(memory: ParsedMemoryFile): string {
  const summary = memory.frontmatter.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  return memory.body.replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
