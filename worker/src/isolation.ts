export const NIA_BASE = "https://apigcp.trynia.ai/v2";
export const TOKEN_PREFIX = "nctx_it_";
export const AGENT_SOURCE = "nctx-claude-code";
export const DEFAULT_SEMANTIC_LIMIT = 5;
export const MAX_SEMANTIC_LIMIT = 100;
export const SEMANTIC_OVERFETCH_FACTOR = 10;

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

  upstreamUrl.searchParams.set("q", query);
  upstreamUrl.searchParams.set("limit", String(upstreamLimit));
  upstreamUrl.searchParams.set(
    "include_highlights",
    url.searchParams.get("include_highlights") ?? "true"
  );

  return { requestedLimit, upstreamUrl };
}

export function filterSemanticSearchResponse(
  rawBody: unknown,
  installTag: string,
  requestedLimit: number
): Record<string, unknown> {
  const body = isRecord(rawBody) ? { ...rawBody } : {};
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const results = rawResults
    .filter((result) => isOwnedByInstall(result, installTag))
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

export function normalizeMemoryTypeFromTags(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tags)) return result;
  const tags = result.tags.map((tag) => (typeof tag === "string" ? tag.toLowerCase() : ""));
  let memoryType = result.memory_type;
  if (tags.includes("decisions") || tags.includes("gotchas")) memoryType = "fact";
  if (tags.includes("patterns")) memoryType = "procedural";
  if (tags.includes("state") || tags.includes("next-steps")) memoryType = "episodic";
  return { ...result, memory_type: memoryType };
}

export function buildTextSearchUrl(requestUrl: string, installTag: string, base = NIA_BASE): URL {
  const url = new URL(requestUrl);
  const upstreamUrl = new URL(`${base}/contexts/search`);

  for (const [key, value] of url.searchParams) {
    if (key !== "tags") upstreamUrl.searchParams.append(key, value);
  }

  upstreamUrl.searchParams.set("tags", installTag);
  return upstreamUrl;
}
