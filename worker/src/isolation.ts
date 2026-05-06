export const NIA_BASE = "https://apigcp.trynia.ai/v2";
export const TOKEN_PREFIX = "nctx_it_";
export const AGENT_SOURCE = "nctx-claude-code";
export const DEFAULT_SEMANTIC_LIMIT = 5;
export const MAX_SEMANTIC_LIMIT = 100;
export const SEMANTIC_OVERFETCH_FACTOR = 10;
export const MAX_TEXT_LIMIT = 100;
export const MAX_TEXT_OFFSET = 10_000;

export interface InstallIdentity {
  installId: string;
  installTag: string;
}

export interface IsolatedContextBody extends Record<string, unknown> {
  agent_source: typeof AGENT_SOURCE;
  tags: string[];
  metadata: Record<string, unknown> & { install_id: string };
}

export interface SemanticSearchRequest {
  requestedLimit: number;
  upstreamUrl: URL;
  projectTag: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(body), { status, headers });
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64url(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function isInstallTag(tag: string): boolean {
  return tag.toLowerCase().startsWith("install:");
}

export function sanitizeAndInjectTags(input: unknown, installTag: string): string[] {
  const existing = Array.isArray(input) ? input : [];
  const clean = existing
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .filter((tag) => !/[\u0000-\u001f\u007f]/.test(tag))
    .filter((tag) => !isInstallTag(tag));

  return [...new Set([...clean, installTag])];
}

export function isolateContextBody(rawBody: unknown, install: InstallIdentity): IsolatedContextBody | null {
  if (!isRecord(rawBody)) return null;

  const metadata = isRecord(rawBody.metadata) ? rawBody.metadata : {};

  return {
    ...rawBody,
    tags: sanitizeAndInjectTags(rawBody.tags, install.installTag),
    agent_source: AGENT_SOURCE,
    metadata: {
      ...metadata,
      install_id: install.installId
    }
  };
}

export function isOwnedByInstall(result: unknown, installTag: string): boolean {
  if (!isRecord(result)) return false;

  return (
    Array.isArray(result.tags) &&
    result.tags.includes(installTag) &&
    result.agent_source === AGENT_SOURCE
  );
}

export function isInProjectScope(result: unknown, projectTag: string | null): boolean {
  if (!projectTag) return true;
  if (!isRecord(result) || !Array.isArray(result.tags)) return false;
  return result.tags.includes(projectTag);
}

function parseRequestedLimit(rawLimit: string | null): number {
  if (!rawLimit) return DEFAULT_SEMANTIC_LIMIT;

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed)) return DEFAULT_SEMANTIC_LIMIT;

  return Math.max(1, Math.min(MAX_SEMANTIC_LIMIT, Math.floor(parsed)));
}

export function buildSemanticSearchRequest(requestUrl: string, base = NIA_BASE): SemanticSearchRequest | null {
  const url = new URL(requestUrl);
  const query = url.searchParams.get("q") ?? "";
  if (!query.trim()) return null;

  const requestedLimit = parseRequestedLimit(url.searchParams.get("limit"));
  const upstreamLimit = Math.min(MAX_SEMANTIC_LIMIT, requestedLimit * SEMANTIC_OVERFETCH_FACTOR);
  const upstreamUrl = new URL(`${base}/contexts/semantic-search`);
  const projectTag = projectTagFromSearchParams(url.searchParams);

  upstreamUrl.searchParams.set("q", query);
  upstreamUrl.searchParams.set("limit", String(upstreamLimit));
  upstreamUrl.searchParams.set(
    "include_highlights",
    url.searchParams.get("include_highlights") ?? "true"
  );

  return { requestedLimit, upstreamUrl, projectTag };
}

export function filterSemanticSearchResponse(
  rawBody: unknown,
  installTag: string,
  requestedLimit: number,
  projectTag: string | null = null
): Record<string, unknown> {
  const body = isRecord(rawBody) ? { ...rawBody } : {};
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const results = rawResults
    .filter((result) => isOwnedByInstall(result, installTag) && isInProjectScope(result, projectTag))
    .map((result) => normalizeMemoryTypeFromTags(result))
    .slice(0, requestedLimit);

  body.results = results;

  if (isRecord(body.search_metadata)) {
    body.search_metadata = {
      ...body.search_metadata,
      total_results: results.length
    };
  }

  return body;
}

export function filterTextSearchResponse(
  rawBody: unknown,
  installTag: string,
  requestedLimit: number,
  projectTag: string | null = null
): Record<string, unknown> {
  const body = isRecord(rawBody) ? { ...rawBody } : {};
  const resultsKey = Array.isArray(body.results) ? "results" : Array.isArray(body.contexts) ? "contexts" : "results";
  const rawResults = Array.isArray(body[resultsKey]) ? body[resultsKey] : [];
  const results = rawResults
    .filter((result) => isOwnedByInstall(result, installTag) && isInProjectScope(result, projectTag))
    .map((result) => normalizeMemoryTypeFromTags(result))
    .slice(0, requestedLimit);

  body[resultsKey] = results;
  if (resultsKey !== "results" && Array.isArray(body.results)) {
    body.results = filterSearchResults(body.results, installTag, requestedLimit, projectTag);
  }
  if (resultsKey !== "contexts" && Array.isArray(body.contexts)) {
    body.contexts = filterSearchResults(body.contexts, installTag, requestedLimit, projectTag);
  }

  if (isRecord(body.search_metadata)) {
    body.search_metadata = {
      ...body.search_metadata,
      total_results: results.length
    };
  }

  return body;
}

export function normalizeMemoryTypeFromTags(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tags)) return result;
  const tags = result.tags.map((tag) => (typeof tag === "string" ? tag.toLowerCase() : ""));
  let memoryType = result.memory_type;
  if (tags.includes("decisions") || tags.includes("gotchas")) memoryType = "fact";
  if (tags.includes("patterns")) memoryType = "procedural";
  if (tags.includes("state") || tags.includes("next-steps")) memoryType = "episodic";
  return { ...result, memory_type: memoryType };
}

export const TEXT_OVERFETCH_FACTOR = 3;
export const MIN_PROJECT_OVERFETCH = 15;

export function buildTextSearchUrl(requestUrl: string, installTag: string, base = NIA_BASE): URL {
  const url = new URL(requestUrl);
  const upstreamUrl = new URL(`${base}/contexts/search`);

  const query = url.searchParams.get("q");
  if (query !== null) upstreamUrl.searchParams.set("q", query);

  const projectTag = projectTagFromSearchParams(url.searchParams);
  if (projectTag) {
    // Overfetch when project filtering will be applied post-response
    const rawLimit = url.searchParams.get("limit");
    const requestedLimit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : DEFAULT_SEMANTIC_LIMIT;
    const overfetched = Math.min(MAX_TEXT_LIMIT, Math.max(MIN_PROJECT_OVERFETCH, requestedLimit * TEXT_OVERFETCH_FACTOR));
    upstreamUrl.searchParams.set("limit", String(overfetched));
  } else {
    copyBoundedIntegerParam(url, upstreamUrl, "limit", 1, MAX_TEXT_LIMIT);
  }

  copyBoundedIntegerParam(url, upstreamUrl, "offset", 0, MAX_TEXT_OFFSET);

  const includeHighlights = parseBooleanParam(url.searchParams.get("include_highlights"));
  if (includeHighlights !== null) {
    upstreamUrl.searchParams.set("include_highlights", includeHighlights);
  }

  upstreamUrl.searchParams.set("tags", installTag);
  return upstreamUrl;
}

export function requestedTextLimit(requestUrl: string): number {
  const url = new URL(requestUrl);
  return parseRequestedLimit(url.searchParams.get("limit"));
}

export function projectTagFromRequestUrl(requestUrl: string): string | null {
  return projectTagFromSearchParams(new URL(requestUrl).searchParams);
}

function filterSearchResults(
  rawResults: unknown[],
  installTag: string,
  requestedLimit: number,
  projectTag: string | null
): unknown[] {
  return rawResults
    .filter((result) => isOwnedByInstall(result, installTag) && isInProjectScope(result, projectTag))
    .map((result) => normalizeMemoryTypeFromTags(result))
    .slice(0, requestedLimit);
}

function projectTagFromSearchParams(searchParams: URLSearchParams): string | null {
  const projectName = firstNonBlank(searchParams.get("project_name"), searchParams.get("project"));
  const tagFromProjectName = projectName ? normalizeProjectTag(projectName) : null;
  if (tagFromProjectName) return tagFromProjectName;

  for (const rawTags of searchParams.getAll("tags")) {
    for (const rawTag of rawTags.split(",")) {
      const tag = sanitizeSearchScopeTag(rawTag);
      if (tag?.toLowerCase().startsWith("project:")) return tag;
    }
  }

  return null;
}

function firstNonBlank(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value?.trim()) return value;
  }
  return null;
}

function normalizeProjectTag(projectNameOrTag: string): string | null {
  const trimmed = sanitizeSearchScopeTag(projectNameOrTag);
  if (!trimmed) return null;
  const rawProject = trimmed.toLowerCase().startsWith("project:") ? trimmed.slice("project:".length) : trimmed;
  const normalized = rawProject.toLowerCase().replace(/\s+/g, "-");
  return normalized ? `project:${normalized}` : null;
}

function sanitizeSearchScopeTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (isInstallTag(trimmed)) return null;
  return trimmed;
}

function copyBoundedIntegerParam(
  source: URL,
  target: URL,
  key: string,
  min: number,
  max: number
): void {
  const raw = source.searchParams.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return;

  target.searchParams.set(key, String(parsed));
}

function parseBooleanParam(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  return normalized === "true" || normalized === "false" ? normalized : null;
}
