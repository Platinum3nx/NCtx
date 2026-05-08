import { AGENT_SOURCE, DEFAULT_NIA_BASE_URL } from "../lib/constants.js";
import type { ContextDraft, DirectNctxConfig, NctxConfig, NormalizedSearchResult, SavedContext } from "../types.js";
import type { NiaClient } from "./client.js";
import { normalizeSearchResultsResponse } from "./client.js";

const DEFAULT_DIRECT_TIMEOUT_MS = 15_000;
const MAX_DIRECT_SEARCH_LIMIT = 100;
const SEMANTIC_OVERFETCH_FACTOR = 10;

export class DirectNiaClient implements NiaClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: DirectNctxConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_DIRECT_TIMEOUT_MS
  ) {
    this.baseUrl = (config.nia_base_url ?? DEFAULT_NIA_BASE_URL).replace(/\/+$/, "");
  }

  async saveContext(draft: ContextDraft): Promise<SavedContext> {
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/contexts`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify(this.sanitizeDirectDraft(draft))
      },
      this.timeoutMs,
      "Nia save"
    );
    if (!res.ok) throw new Error(`Nia save failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as SavedContext;
  }

  async searchContexts(query: string, limit = 5, mode: "semantic" | "text" = "semantic"): Promise<NormalizedSearchResult[]> {
    const requestedLimit = boundedLimit(limit);
    const endpoint = mode === "text" ? "/contexts/search" : "/contexts/semantic-search";
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(mode === "semantic" ? overfetchLimit(requestedLimit) : requestedLimit));

    const projectTag = this.projectTag();
    if (mode === "semantic") {
      url.searchParams.set("include_highlights", "true");
    } else {
      url.searchParams.set("tags", projectTag);
    }

    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        headers: this.authHeaders()
      },
      this.timeoutMs,
      "Nia search"
    );
    if (!res.ok) throw new Error(`Nia search failed (${res.status}): ${await res.text()}`);

    const results = normalizeSearchResultsResponse(await res.json());
    return results
      .filter((result) => result.agent_source === AGENT_SOURCE && result.tags.includes(projectTag))
      .slice(0, requestedLimit);
  }

  private sanitizeDirectDraft(draft: ContextDraft): ContextDraft {
    const metadata = { ...(draft.metadata ?? {}) };
    delete metadata.install_id;

    return {
      ...draft,
      agent_source: AGENT_SOURCE,
      tags: normalizeTags([...draft.tags, this.projectTag()]),
      metadata,
      edited_files: draft.edited_files?.map((file) => ({
        ...file,
        changes_description: file.changes_description || "Touched during the captured Claude Code session."
      }))
    };
  }

  private projectTag(): string {
    return normalizeProjectTag(this.config.project_name);
  }

  private authHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.nia_api_key}`
    };
  }

  private jsonHeaders(): HeadersInit {
    return {
      ...this.authHeaders(),
      "Content-Type": "application/json"
    };
  }
}

export function makeClient(config: NctxConfig): DirectNiaClient {
  if (config.mode !== "direct") {
    throw new Error(`Unsupported NCtx mode: ${config.mode}`);
  }
  if (!config.nia_api_key.trim()) {
    throw new Error("Direct NCtx mode requires nia_api_key.");
  }
  return new DirectNiaClient(config);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(input, {
        ...init,
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(MAX_DIRECT_SEARCH_LIMIT, Math.floor(limit)));
}

function overfetchLimit(limit: number): number {
  return Math.min(MAX_DIRECT_SEARCH_LIMIT, limit * SEMANTIC_OVERFETCH_FACTOR);
}

function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .filter((tag) => !/[\u0000-\u001f\u007f]/.test(tag))
        .filter((tag) => !tag.toLowerCase().startsWith("install:"))
    )
  ];
}


function normalizeProjectTag(projectNameOrTag: string): string {
  const trimmed = projectNameOrTag.trim();
  const rawProject = trimmed.toLowerCase().startsWith("project:") ? trimmed.slice("project:".length) : trimmed;
  const normalized = rawProject.trim().toLowerCase().replace(/\s+/g, "-");
  return `project:${normalized || "project"}`;
}
