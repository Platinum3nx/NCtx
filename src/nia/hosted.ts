import type { NctxConfig, ContextDraft, NormalizedSearchResult, SavedContext } from "../types.js";
import type { NiaClient } from "./client.js";
import { normalizeSearchResult } from "./client.js";

const DEFAULT_WORKER_TIMEOUT_MS = 15_000;

export class HostedNiaClient implements NiaClient {
  constructor(
    private readonly config: NctxConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_WORKER_TIMEOUT_MS
  ) {}

  async saveContext(draft: ContextDraft): Promise<SavedContext> {
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${this.config.proxy_url.replace(/\/$/, "")}/contexts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.install_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(sanitizeHostedDraft(draft))
      },
      this.timeoutMs,
      "Worker save"
    );
    if (!res.ok) throw new Error(`Worker save failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as SavedContext;
  }

  async searchContexts(query: string, limit = 5, mode: "semantic" | "text" = "semantic"): Promise<NormalizedSearchResult[]> {
    const endpoint = mode === "text" ? "/contexts/search" : "/contexts/semantic-search";
    const url = new URL(`${this.config.proxy_url.replace(/\/$/, "")}${endpoint}`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        headers: {
          Authorization: `Bearer ${this.config.install_token}`
        }
      },
      this.timeoutMs,
      "Worker search"
    );
    if (!res.ok) throw new Error(`Worker search failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { results?: SavedContext[]; contexts?: SavedContext[] };
    return (body.results ?? body.contexts ?? []).map(normalizeSearchResult);
  }
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

export function makeClient(config: NctxConfig): HostedNiaClient {
  if (config.mode !== "hosted") throw new Error(`Unsupported NCtx mode: ${config.mode}`);
  return new HostedNiaClient(config);
}

export function isMemoryType(value: unknown): value is ContextDraft["memory_type"] | "scratchpad" {
  return value === "fact" || value === "procedural" || value === "episodic" || value === "scratchpad";
}

export type RegisterHostedInstallOptions = {
  proxyUrl: string;
  packageSecret: string;
  fetchImpl?: typeof fetch;
};

export async function registerHostedInstall(options: RegisterHostedInstallOptions): Promise<{
  install_token: string;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${options.proxyUrl.replace(/\/$/, "")}/installs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nctx-package-secret": options.packageSecret
    },
    body: JSON.stringify({ client: "nctx-cli" })
  });
  if (!res.ok) throw new Error(`Install registration failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { install_token?: string };
  if (!body.install_token || body.install_token.length < 20) {
    throw new Error("Worker did not return a valid install_token.");
  }
  return { install_token: body.install_token };
}

function sanitizeHostedDraft(draft: ContextDraft): ContextDraft {
  const metadata = { ...(draft.metadata ?? {}) };
  delete metadata.install_id;
  return {
    ...draft,
    tags: (draft.tags ?? []).filter((tag) => !tag.toLowerCase().startsWith("install:")),
    metadata,
    edited_files: draft.edited_files?.map((file) => ({
      ...file,
      changes_description: file.changes_description || "Touched during the captured Claude Code session."
    }))
  };
}
