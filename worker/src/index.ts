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
  const body = isolateContextBody(await request.json(), install);
  if (!body) return json({ error: "Invalid context body" }, 400);

  const upstream = await fetch(`${NIA_BASE}/contexts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NIA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
  });
}

async function forwardSemanticSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const search = buildSemanticSearchRequest(request.url);
  if (!search) return json({ error: "Missing search query" }, 400);

  const upstream = await fetch(search.upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });
  const body = await upstream.json();
  return json(filterSemanticSearchResponse(body, installTag, search.requestedLimit), upstream.status);
}

async function forwardTextSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const upstreamUrl = buildTextSearchUrl(request.url, installTag);
  const upstream = await fetch(upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rateLimited = await checkIpRateLimit(request, env);
    if (rateLimited) return rateLimited;

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/installs") {
      return registerInstall(request, env);
    }

    const token = bearerToken(request);
    if (!token) return json({ error: "Missing bearer token" }, 401);
    const install = await installForToken(env, token);
    if (!install) return json({ error: "Invalid install token" }, 401);
    const capResponse = await checkDailyCap(env, install.tokenHash);
    if (capResponse) return capResponse;

    if (request.method === "POST" && url.pathname === "/contexts") {
      return forwardSave(request, env, install);
    }
    if (request.method === "GET" && url.pathname === "/contexts/semantic-search") {
      return forwardSemanticSearch(request, env, install.installTag);
    }
    if (request.method === "GET" && url.pathname === "/contexts/search") {
      return forwardTextSearch(request, env, install.installTag);
    }
    return json({ error: "Not found" }, 404);
  }
} satisfies ExportedHandler<Env>;
