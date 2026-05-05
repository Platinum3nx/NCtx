import type { ContextDraft, NormalizedSearchResult, SavedContext } from "../types.js";
import { makeClient as makeHostedClient } from "./hosted.js";
import type { NctxConfig } from "../types.js";

export type NiaContextRequest = ContextDraft;

export interface NiaClient {
  saveContext(draft: ContextDraft): Promise<SavedContext>;
  searchContexts(query: string, limit?: number, mode?: "semantic" | "text"): Promise<NormalizedSearchResult[]>;
}

export function normalizeSearchResult(result: SavedContext): NormalizedSearchResult {
  return {
    id: result.id,
    title: result.title ?? "(untitled memory)",
    summary: result.summary ?? "",
    content: result.content ?? "",
    tags: Array.isArray(result.tags) ? result.tags : [],
    agent_source: result.agent_source,
    memory_type: result.memory_type,
    created_at: result.created_at,
    metadata: result.metadata ?? {},
    edited_files: Array.isArray(result.edited_files) ? result.edited_files : [],
    score: result.relevance_score ?? result.score ?? null,
    highlights: result.match_highlights ?? result.highlights ?? [],
    match_metadata: result.match_metadata ?? {}
  };
}

export function makeClient(config: NctxConfig): NiaClient {
  return makeHostedClient(config);
}
