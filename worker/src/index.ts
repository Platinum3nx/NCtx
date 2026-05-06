import { DurableObject } from "cloudflare:workers";
import {
  NIA_BASE,
  TOKEN_PREFIX,
  bearerToken,
  buildSemanticSearchRequest,
  buildTextSearchUrl,
  filterSemanticSearchResponse,
  filterTextSearchResponse,
  isolateContextBody,
  json,
  mintToken,
  projectTagFromRequestUrl,
  requestedTextLimit,
  sha256Hex
} from "./isolation";
import type { SemanticSearchRequest } from "./isolation";

export interface Env {
  NIA_API_KEY: string;
  PACKAGE_SHARED_SECRET: string;
  INSTALLS: KVNamespace;
  INSTALL_COUNTER: DurableObjectNamespace<InstallCounter>;
  IP_RATE_LIMITER: RateLimit;
}

const PER_INSTALL_DAILY_CAP = 500;
const INSTALL_MINT_IP_DAILY_CAP = 25;
const PUBLIC_INSTALL_MINT_DAILY_CAP = 1_000;
const NIA_UPSTREAM_TIMEOUT_MS = 15_000;
const PUBLIC_BETA_PACKAGE_SHARED_SECRET = "nctx-public-beta-client-v1";
export const MAX_SAVE_BODY_BYTES = 256 * 1024;

type AuthedRoute = "save" | "semantic-search" | "text-search";

async function installForToken(env: Env, token: string): Promise<{
  tokenHash: string;
  installId: string;
  installTag: string;
} | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 40) return null;
  const tokenHash = await sha256Hex(token);
  const installId = await env.INSTALLS.get(`install:${tokenHash}`);
  return installId ? { tokenHash, installId, installTag: `install:${installId}` } : null;
}

export class InstallCounter extends DurableObject<Env> {
  async incrementAndCheck(cap: number): Promise<{ allowed: boolean; count: number; remaining: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const current =
      (await this.ctx.storage.get<{ date: string; count: number }>("daily")) ?? { date: today, count: 0 };
    const count = current.date === today ? current.count : 0;
    if (count >= cap) return { allowed: false, count, remaining: 0 };
    const next = count + 1;
    await this.ctx.storage.put("daily", { date: today, count: next });
    return { allowed: true, count: next, remaining: Math.max(0, cap - next) };
  }
}

async function checkDailyCap(env: Env, tokenHash: string): Promise<Response | null> {
  const result = await incrementDailyCounter(env, tokenHash, PER_INSTALL_DAILY_CAP);
  return result.allowed ? null : json({ error: "Rate limited", cap: PER_INSTALL_DAILY_CAP }, 429);
}

async function incrementDailyCounter(
  env: Env,
  counterName: string,
  cap: number
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  const id = env.INSTALL_COUNTER.idFromName(counterName);
  const stub = env.INSTALL_COUNTER.get(id);
  return stub.incrementAndCheck(cap);
}

async function checkInstallMintThrottle(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256Hex(ip);
  const ipCounter = await incrementDailyCounter(env, `install-mint:ip:${ipHash}`, INSTALL_MINT_IP_DAILY_CAP);
  if (!ipCounter.allowed) {
    return json(
      { error: "Install registration rate limited", scope: "ip", cap: INSTALL_MINT_IP_DAILY_CAP },
      429
    );
  }

  if (env.PACKAGE_SHARED_SECRET !== PUBLIC_BETA_PACKAGE_SHARED_SECRET) return null;

  const globalCounter = await incrementDailyCounter(
    env,
    "install-mint:public-beta",
    PUBLIC_INSTALL_MINT_DAILY_CAP
  );
  return globalCounter.allowed
    ? null
    : json(
        { error: "Install registration rate limited", scope: "public-beta", cap: PUBLIC_INSTALL_MINT_DAILY_CAP },
        429
      );
}

async function checkIpRateLimit(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const path = new URL(request.url).pathname;
  const result = await env.IP_RATE_LIMITER.limit({ key: `${ip}:${path}` });
  return result.success ? null : json({ error: "Too many requests" }, 429);
}

async function registerInstall(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("x-nctx-package-secret") !== env.PACKAGE_SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  const throttled = await checkInstallMintThrottle(request, env);
  if (throttled) return throttled;

  const token = mintToken();
  const tokenHash = await sha256Hex(token);
  const installId = crypto.randomUUID();
  await env.INSTALLS.put(`install:${tokenHash}`, installId, {
    metadata: { created_at: new Date().toISOString() }
  });
  return json({ install_token: token });
}

async function forwardSave(
  request: Request,
  env: Env,
  install: { installId: string; installTag: string }
): Promise<Response> {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const body = isolateContextBody(parsed.body, install);
  if (!body) return json({ error: "Invalid context body" }, 400);

  const upstream = await fetchNia(`${NIA_BASE}/contexts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NIA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!upstream.ok) {
    return json({ error: "Upstream error", status: upstream.status }, upstream.status >= 500 ? 502 : upstream.status);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
  });
}

async function readJsonBody(request: Request): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: Response }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAX_SAVE_BODY_BYTES) {
      return { ok: false, response: json({ error: "Request body too large" }, 413) };
    }
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_SAVE_BODY_BYTES) {
    return { ok: false, response: json({ error: "Request body too large" }, 413) };
  }

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "Invalid JSON" }, 400) };
  }
}

async function forwardSemanticSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const search = buildSemanticSearchRequest(request.url);
  if (!search) return json({ error: "Missing search query" }, 400);

  const upstream = await fetchNia(search.upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });

  // If semantic succeeds, process normally
  if (upstream.ok) {
    let body: unknown;
    try {
      body = await upstream.json();
    } catch {
      // Semantic returned non-JSON — fall through to text fallback
      return textFallbackOrError(request, env, installTag, search, "Upstream returned non-JSON response");
    }

    const filtered = filterSemanticSearchResponse(body, installTag, search.requestedLimit, search.projectTag);
    if (searchResults(filtered).length >= search.requestedLimit) {
      return json(filtered, upstream.status);
    }

    // Semantic returned fewer results than requested — supplement with text fallback
    const fallbackResults = await safeTextFallback(request, env, installTag, search.requestedLimit, search.projectTag);
    if (fallbackResults !== null && fallbackResults.length) {
      filtered.results = mergeSearchResults(searchResults(filtered), fallbackResults, search.requestedLimit);
      const existingMeta = isRecord(filtered.search_metadata) ? filtered.search_metadata : {};
      filtered.search_metadata = {
        ...existingMeta,
        total_results: searchResults(filtered).length,
        text_fallback_used: true
      };
    }
    return json(filtered, upstream.status);
  }

  // Semantic failed — try text fallback before returning error
  return textFallbackOrError(request, env, installTag, search, `Semantic upstream error ${upstream.status}`);
}

async function textFallbackOrError(
  request: Request,
  env: Env,
  installTag: string,
  search: SemanticSearchRequest,
  semanticError: string
): Promise<Response> {
  const fallbackResults = await safeTextFallback(request, env, installTag, search.requestedLimit, search.projectTag);
  // Text fallback succeeded (even if empty) — return 200 with results
  if (fallbackResults !== null) {
    return json({
      results: fallbackResults.slice(0, search.requestedLimit),
      search_metadata: {
        total_results: Math.min(fallbackResults.length, search.requestedLimit),
        text_fallback_used: true,
        semantic_error: semanticError
      }
    });
  }
  // Both semantic and text actually failed
  return json({ error: "Upstream error", detail: semanticError }, 502);
}

async function forwardTextSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const upstreamUrl = buildTextSearchUrl(request.url, installTag);
  const upstream = await fetchNia(upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });

  if (!upstream.ok) {
    return json({ error: "Upstream error", status: upstream.status }, upstream.status >= 500 ? 502 : upstream.status);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: "Upstream returned non-JSON response" }, 502);
  }

  return json(
    filterTextSearchResponse(
      body,
      installTag,
      requestedTextLimit(request.url),
      projectTagFromRequestUrl(request.url)
    ),
    upstream.status
  );
}

/**
 * Attempt text search as a fallback. Returns an array of results on success
 * (possibly empty — that's a valid outcome), or null if the fallback itself failed.
 */
async function safeTextFallback(
  request: Request,
  env: Env,
  installTag: string,
  requestedLimit: number,
  projectTag: string | null
): Promise<unknown[] | null> {
  try {
    const upstream = await fetchNia(buildTextSearchUrl(request.url, installTag), {
      headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
    });
    if (!upstream.ok) return null;

    let body: unknown;
    try {
      body = await upstream.json();
    } catch {
      return null;
    }

    const filtered = filterTextSearchResponse(body, installTag, requestedLimit, projectTag);
    return searchResults(filtered);
  } catch {
    // Any fallback failure (network, DNS, TLS, unexpected) should not crash the primary search path
    return null;
  }
}

function searchResults(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.contexts)) return body.contexts;
  return [];
}

function mergeSearchResults(primary: unknown[], fallback: unknown[], limit: number): unknown[] {
  const seen = new Set(primary.map(resultId).filter((id): id is string => Boolean(id)));
  const merged = [...primary];
  for (const result of fallback) {
    const id = resultId(result);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(result);
    if (merged.length >= limit) break;
  }
  return merged;
}

function resultId(result: unknown): string | null {
  return isRecord(result) && typeof result.id === "string" && result.id ? result.id : null;
}

function authedRoute(method: string, pathname: string): AuthedRoute | null {
  if (method === "POST" && pathname === "/contexts") return "save";
  if (method === "GET" && pathname === "/contexts/semantic-search") return "semantic-search";
  if (method === "GET" && pathname === "/contexts/search") return "text-search";
  return null;
}

/**
 * Fetch wrapper for the Nia upstream with a timeout.
 *
 * On timeout, returns a JSON Response with status 504 and body
 * `{ error: "Nia upstream timed out" }` rather than throwing.
 * This is intentional because all callers check `!upstream.ok`
 * before processing the response body.
 */
async function fetchNia(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NIA_UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      return json({ error: "Nia upstream timed out" }, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rateLimited = await checkIpRateLimit(request, env);
    if (rateLimited) return rateLimited;

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/installs") {
      return registerInstall(request, env);
    }

    const route = authedRoute(request.method, url.pathname);
    if (!route) return json({ error: "Not found" }, 404);

    const token = bearerToken(request);
    if (!token) return json({ error: "Missing bearer token" }, 401);
    const install = await installForToken(env, token);
    if (!install) return json({ error: "Invalid install token" }, 401);
    const capResponse = await checkDailyCap(env, install.tokenHash);
    if (capResponse) return capResponse;

    if (route === "save") {
      return forwardSave(request, env, install);
    }
    if (route === "semantic-search") {
      return forwardSemanticSearch(request, env, install.installTag);
    }
    if (route === "text-search") {
      return forwardTextSearch(request, env, install.installTag);
    }
    return json({ error: "Not found" }, 404);
  }
} satisfies ExportedHandler<Env>;
