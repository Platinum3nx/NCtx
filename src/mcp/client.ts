import { normalizeSearchResultsResponse, type McpSearchResult } from "./format.js";
import type { NctxMcpConfig } from "./config.js";
import { AGENT_SOURCE } from "../lib/constants.js";

export type MemorySearchMode = "semantic" | "text";

export interface NctxMemoryClient {
  searchContexts(query: string, limit?: number, mode?: MemorySearchMode): Promise<McpSearchResult[]>;
}

type FetchLike = typeof fetch;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

export function makeClient(config: NctxMcpConfig, fetchImpl: FetchLike = fetch): NctxMemoryClient {
  return new DirectNctxMemoryClient(config, fetchImpl);
}

class DirectNctxMemoryClient implements NctxMemoryClient {
  constructor(
    private readonly config: NctxMcpConfig,
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS
  ) {}

  async searchContexts(query: string, limit = 5, mode: MemorySearchMode = "semantic"): Promise<McpSearchResult[]> {
    const normalizedLimit = normalizeLimit(limit);
    const url = this.searchUrl(query, normalizedLimit, mode);

    const response = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.nia_api_key}`
        }
      },
      this.timeoutMs
    );

    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(formatSearchError(response, body));
    }

    const projectTag = projectTagFor(this.config.project_name);
    return normalizeSearchResultsResponse(body)
      .filter((result) => result.agent_source === AGENT_SOURCE && result.tags.includes(projectTag))
      .slice(0, normalizedLimit);
  }

  private searchUrl(query: string, limit: number, mode: MemorySearchMode): URL {
    const path = mode === "semantic" ? "/contexts/semantic-search" : "/contexts/search";
    const url = serviceEndpointUrl(this.config.nia_base_url, path);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    if (mode === "semantic") {
      url.searchParams.set("include_highlights", "true");
    } else {
      url.searchParams.set("tags", projectTagFor(this.config.project_name));
    }
    return url;
  }
}

function serviceEndpointUrl(baseUrl: string, endpointPath: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${endpointPath}`;
  url.search = "";
  url.hash = "";
  return url;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`NCtx memory search timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatSearchError(response: Response, body: unknown): string {
  const detail = errorDetail(body);
  const suffix = detail ? `: ${detail}` : "";
  return `NCtx memory search failed (${response.status} ${response.statusText})${suffix}`;
}

function errorDetail(body: unknown): string | null {
  if (typeof body === "string") return sanitizeErrorDetail(body);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return sanitizeErrorDetail(value);
  }

  return null;
}

function sanitizeErrorDetail(value: string): string {
  return value.replace(/[\n\r\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
}

function projectTagFor(projectNameOrTag: string): string {
  const trimmed = projectNameOrTag.trim();
  const rawProject = trimmed.toLowerCase().startsWith("project:") ? trimmed.slice("project:".length) : trimmed;
  const normalized = rawProject.trim().toLowerCase().replace(/\s+/g, "-");
  return `project:${normalized || "project"}`;
}
