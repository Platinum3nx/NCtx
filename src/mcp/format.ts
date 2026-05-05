export interface NormalizedSearchResult {
  id?: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  agent_source?: string;
  memory_type?: string;
  created_at?: string;
  metadata: Record<string, unknown>;
  edited_files: Array<Record<string, unknown>>;
  score: number | null;
  highlights: string[];
  match_metadata: Record<string, unknown>;
  file_paths: string[];
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
  const metadata = objectValue(result.metadata);
  const editedFiles = Array.isArray(result.edited_files) ? result.edited_files.filter(isRecord) : [];
  const tags = arrayOfStrings(result.tags);

  return {
    id: stringValue(result.id),
    title: stringValue(result.title) ?? "(untitled memory)",
    summary: stringValue(result.summary) ?? "",
    content: stringValue(result.content) ?? "",
    tags,
    agent_source: stringValue(result.agent_source),
    memory_type: stringValue(result.memory_type),
    created_at: stringValue(result.created_at),
    metadata,
    edited_files: editedFiles,
    score: numberValue(result.relevance_score ?? result.score),
    highlights: normalizeHighlights(result.match_highlights ?? result.highlights),
    match_metadata: objectValue(result.match_metadata),
    file_paths: collectFilePaths(metadata, editedFiles)
  };
}

export function formatResults(rawResults: unknown[]): string {
  const results = rawResults.map((result) =>
    isRecord(result) && Array.isArray(result.file_paths)
      ? (result as unknown as NormalizedSearchResult)
      : normalizeSearchResult(result)
  );
  if (!results.length) return "No NCtx memories found.";
  return results.map((result, index) => formatOne(result, index + 1)).join("\n\n---\n\n");
}

function formatOne(result: NormalizedSearchResult, index: number): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
