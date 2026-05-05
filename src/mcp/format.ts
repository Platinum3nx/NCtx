import {
  normalizeSearchResult as normalizeSharedSearchResult,
  normalizeSearchResultsResponse as normalizeSharedSearchResultsResponse
} from "../nia/client.js";
import type { NormalizedSearchResult } from "../types.js";

export interface McpSearchResult extends NormalizedSearchResult {
  file_paths: string[];
}

export function normalizeSearchResultsResponse(body: unknown): McpSearchResult[] {
  return normalizeSharedSearchResultsResponse(body).map(withFilePaths);
}

export function normalizeSearchResult(raw: unknown): McpSearchResult {
  return withFilePaths(normalizeSharedSearchResult(raw));
}

export function formatResults(rawResults: unknown[]): string {
  const results = rawResults.map((result) =>
    isRecord(result) && Array.isArray(result.file_paths)
      ? (result as unknown as McpSearchResult)
      : normalizeSearchResult(result)
  );
  if (!results.length) return "No NCtx memories found.";
  return results.map((result, index) => formatOne(result, index + 1)).join("\n\n---\n\n");
}

function formatOne(result: McpSearchResult, index: number): string {
  const visible = visibleTags(result.tags);
  const lines = [
    `# ${index}. ${result.title}`,
    result.summary ? `Summary: ${result.summary}` : "",
    result.memory_type ? `Memory type: ${result.memory_type}` : "",
    result.created_at ? `Date: ${result.created_at}` : "",
    result.score != null ? `Score: ${result.score.toFixed(3)}` : "",
    visible.length ? `Tags: ${visible.join(", ")}` : "",
    result.file_paths.length ? `Files: ${result.file_paths.join(", ")}` : "",
    result.highlights.length ? `Highlights:\n${result.highlights.slice(0, 3).map((h) => `- ${h}`).join("\n")}` : "",
    result.content ? `\n${trimContent(result.content)}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withFilePaths(result: NormalizedSearchResult): McpSearchResult {
  return {
    ...result,
    file_paths: collectFilePaths(result.metadata, result.edited_files)
  };
}

function collectFilePaths(metadata: Record<string, unknown>, editedFiles: Array<Record<string, unknown>>): string[] {
  const files = new Set<string>();
  for (const file of editedFiles) {
    if (typeof file.file_path === "string") files.add(file.file_path);
  }
  for (const key of ["files_touched", "files"]) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      for (const file of value) if (typeof file === "string") files.add(file);
    }
  }
  return [...files];
}

function visibleTags(tags: string[]): string[] {
  return tags.filter((tag) => !tag.toLowerCase().startsWith("install:"));
}

function trimContent(content: string): string {
  return content.length > 1500 ? `${content.slice(0, 1497)}...` : content;
}
