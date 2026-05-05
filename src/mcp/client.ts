import { normalizeSearchResultsResponse, type NormalizedSearchResult } from "./format.js";
import type { NctxMcpConfig } from "./config.js";

export type MemorySearchMode = "semantic" | "text";

export interface NctxMemoryClient {
  searchContexts(query: string, limit?: number, mode?: MemorySearchMode): Promise<NormalizedSearchResult[]>;
}

type FetchLike = typeof fetch;

export function makeClient(config: NctxMcpConfig, fetchImpl: FetchLike = fetch): NctxMemoryClient {
  return new HostedNctxMemoryClient(config, fetchImpl);
}

class HostedNctxMemoryClient implements NctxMemoryClient {
  constructor(private readonly config: NctxMcpConfig, private readonly fetchImpl: FetchLike) {}

  async searchContexts(query: string, limit = 5, mode: MemorySearchMode = "semantic"): Promise<NormalizedSearchResult[]> {
    const normalizedLimit = normalizeLimit(limit);
    const url = this.searchUrl(query, normalizedLimit, mode);

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.install_token}`
      }
    });

    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(formatSearchError(response, body));
    }

    return normalizeSearchResultsResponse(body).slice(0, normalizedLimit);
  }

  private searchUrl(query: string, limit: number, mode: MemorySearchMode): URL {
    const path = mode === "semantic" ? "/contexts/semantic-search" : "/contexts/search";
    const url = new URL(path, this.config.proxy_url);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    if (mode === "semantic") {
      url.searchParams.set("include_highlights", "true");
    }
    return url;
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
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
  if (typeof body === "string") return body.slice(0, 500);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }

  return null;
}
