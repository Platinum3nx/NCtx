import type { ContextDraft, MemoryType, NormalizedSearchResult, SavedContext } from "../types.js";
import { makeClient as makeDirectClient } from "./direct.js";
import type { NctxConfig } from "../types.js";

export type NiaContextRequest = ContextDraft;

export interface NiaClient {
  saveContext(draft: ContextDraft): Promise<SavedContext>;
  searchContexts(query: string, limit?: number, mode?: "semantic" | "text"): Promise<NormalizedSearchResult[]>;
}

export function normalizeSearchResultsResponse(body: unknown): NormalizedSearchResult[] {
  if (!isRecord(body)) return [];
  const rawResults = Array.isArray(body.results)
    ? body.results
    : Array.isArray(body.contexts)
      ? body.contexts
      : [];
  return rawResults.map((result) => normalizeSearchResult(result));
}

export function normalizeSearchResult(raw: unknown): NormalizedSearchResult {
  const result = isRecord(raw) ? raw : {};

  return {
    id: stringValue(result.id) ?? "",
    title: stringValue(result.title) ?? "(untitled memory)",
    summary: stringValue(result.summary) ?? "",
    content: stringValue(result.content) ?? "",
    tags: arrayOfStrings(result.tags),
    agent_source: stringValue(result.agent_source),
    memory_type: memoryTypeValue(result.memory_type),
    created_at: stringValue(result.created_at),
    metadata: objectValue(result.metadata),
    edited_files: Array.isArray(result.edited_files) ? result.edited_files.filter(isRecord) : [],
    score: numberValue(result.relevance_score ?? result.score),
    highlights: normalizeHighlights(result.match_highlights ?? result.highlights),
    match_metadata: objectValue(result.match_metadata)
  };
}

export function makeClient(config: NctxConfig): NiaClient {
  return makeDirectClient(config);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeHighlights(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (isRecord(item) && typeof item.text === "string") return [item.text];
    return [];
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function memoryTypeValue(value: unknown): MemoryType | undefined {
  return value === "scratchpad" || value === "episodic" || value === "fact" || value === "procedural"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
