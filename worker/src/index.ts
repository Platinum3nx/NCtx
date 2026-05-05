import { DurableObject } from "cloudflare:workers";
import {
  NIA_BASE,
  TOKEN_PREFIX,
  bearerToken,
  buildSemanticSearchRequest,
  buildTextSearchUrl,
  filterSemanticSearchResponse,
  isolateContextBody,
  json,
  mintToken,
  sha256Hex
} from "./isolation";

export interface Env {
  NIA_API_KEY: string;
  PACKAGE_SHARED_SECRET: string;
  INSTALLS: KVNamespace;
  INSTALL_COUNTER: DurableObjectNamespace<InstallCounter>;
  IP_RATE_LIMITER: RateLimit;
}

const PER_INSTALL_DAILY_CAP = 500;
const NIA_UPSTREAM_TIMEOUT_MS = 15_000;
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
  const id = env.INSTALL_COUNTER.idFromName(tokenHash);
  const stub = env.INSTALL_COUNTER.get(id);
  const result = await stub.incrementAndCheck(PER_INSTALL_DAILY_CAP);
  return result.allowed ? null : json({ error: "Rate limited", cap: PER_INSTALL_DAILY_CAP }, 429);
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

  if (!upstream.ok) {
    return json({ error: "Upstream error", status: upstream.status }, upstream.status >= 500 ? 502 : upstream.status);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: "Upstream returned non-JSON response" }, 502);
  }

  return json(filterSemanticSearchResponse(body, installTag, search.requestedLimit), upstream.status);
}

async function forwardTextSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const upstreamUrl = buildTextSearchUrl(request.url, installTag);
  const upstream = await fetchNia(upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });

  if (!upstream.ok) {
    return json({ error: "Upstream error", status: upstream.status }, upstream.status >= 500 ? 502 : upstream.status);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
  });
}

function authedRoute(method: string, pathname: string): AuthedRoute | null {
  if (method === "POST" && pathname === "/contexts") return "save";
  if (method === "GET" && pathname === "/contexts/semantic-search") return "semantic-search";
  if (method === "GET" && pathname === "/contexts/search") return "text-search";
  return null;
}

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
