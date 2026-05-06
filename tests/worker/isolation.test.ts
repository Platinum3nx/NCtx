import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SOURCE,
  MIN_PROJECT_OVERFETCH,
  TEXT_OVERFETCH_FACTOR,
  bearerToken,
  buildSemanticSearchRequest,
  buildTextSearchUrl,
  filterSemanticSearchResponse,
  filterTextSearchResponse,
  isolateContextBody,
  normalizeMemoryTypeFromTags,
  projectTagFromRequestUrl,
  sanitizeAndInjectTags
} from "../../worker/src/isolation.js";

const PUBLIC_BETA_PACKAGE_SHARED_SECRET = "nctx-public-beta-client-v1";

vi.mock(
  "cloudflare:workers",
  () => ({
    DurableObject: class {
      protected ctx: unknown;
      protected env: unknown;

      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    }
  }),
  { virtual: true }
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Worker install isolation helpers", () => {
  it("strips caller install tags and injects the server install tag once", () => {
    expect(
      sanitizeAndInjectTags(
        [" project:alpha ", "install:attacker", "INSTALL:attacker", "", "topic", "topic", 7],
        "install:server"
      )
    ).toEqual(["project:alpha", "topic", "install:server"]);
  });

  it("forces context provenance fields before forwarding to Nia", () => {
    const isolated = isolateContextBody(
      {
        title: "Decision",
        agent_source: "malicious-agent",
        tags: ["install:spoofed", "project:alpha"],
        metadata: {
          install_id: "spoofed",
          session_id: "session-1"
        }
      },
      {
        installId: "server-install",
        installTag: "install:server-install"
      }
    );

    expect(isolated).toMatchObject({
      agent_source: AGENT_SOURCE,
      tags: ["project:alpha", "install:server-install"],
      metadata: {
        install_id: "server-install",
        session_id: "session-1"
      }
    });
  });

  it("rewrites text search tags to the server install tag", () => {
    const upstream = buildTextSearchUrl(
      "https://worker.example/contexts/search?q=webhooks&tags=install:evil&limit=10",
      "install:server"
    );

    expect(upstream.toString()).toBe(
      "https://apigcp.trynia.ai/v2/contexts/search?q=webhooks&limit=10&tags=install%3Aserver"
    );
  });

  it("only forwards whitelisted text search query parameters", () => {
    const upstream = buildTextSearchUrl(
      "https://worker.example/contexts/search?q=webhooks&tags=install:evil&limit=10&offset=5&include_highlights=TRUE&workspace_id=secret&api_key=leak",
      "install:server"
    );

    expect(upstream.toString()).toBe(
      "https://apigcp.trynia.ai/v2/contexts/search?q=webhooks&limit=10&offset=5&include_highlights=true&tags=install%3Aserver"
    );
  });

  it("overfetches text search limit when project_name is present", () => {
    const upstream = buildTextSearchUrl(
      "https://worker.example/contexts/search?q=webhooks&limit=1&project_name=alpha",
      "install:server"
    );

    expect(upstream.searchParams.get("limit")).toBe(String(MIN_PROJECT_OVERFETCH));
  });

  it("caps text search overfetch at MAX_TEXT_LIMIT (100)", () => {
    const upstream = buildTextSearchUrl(
      "https://worker.example/contexts/search?q=webhooks&limit=50&project_name=alpha",
      "install:server"
    );

    expect(upstream.searchParams.get("limit")).toBe("100");
  });

  it("does not overfetch text search limit when no project scope is present", () => {
    const upstream = buildTextSearchUrl(
      "https://worker.example/contexts/search?q=webhooks&limit=10",
      "install:server"
    );

    expect(upstream.searchParams.get("limit")).toBe("10");
  });

  it("over-fetches semantic search while preserving caller query options", () => {
    const search = buildSemanticSearchRequest(
      "https://worker.example/contexts/semantic-search?q=stripe&limit=8&include_highlights=false"
    );

    expect(search?.requestedLimit).toBe(8);
    expect(search?.upstreamUrl.toString()).toBe(
      "https://apigcp.trynia.ai/v2/contexts/semantic-search?q=stripe&limit=80&include_highlights=false"
    );
  });

  it("caps semantic over-fetching at 100 upstream results", () => {
    const search = buildSemanticSearchRequest(
      "https://worker.example/contexts/semantic-search?q=stripe&limit=999"
    );

    expect(search?.requestedLimit).toBe(100);
    expect(search?.upstreamUrl.searchParams.get("limit")).toBe("100");
  });

  it("extracts project search scope without forwarding it as the isolation boundary", () => {
    const search = buildSemanticSearchRequest(
      "https://worker.example/contexts/semantic-search?q=stripe&limit=5&project_name=alpha"
    );

    expect(search?.projectTag).toBe("project:alpha");
    expect(search?.upstreamUrl.searchParams.has("tags")).toBe(false);
    expect(projectTagFromRequestUrl("https://worker.example/contexts/search?q=stripe&tags=project:beta")).toBe(
      "project:beta"
    );
  });

  it("post-filters semantic results by install tag and forced agent source", () => {
    const filtered = filterSemanticSearchResponse(
      {
        results: [
          {
            id: "owned",
            tags: ["install:server"],
            agent_source: AGENT_SOURCE,
            relevance_score: 0.9
          },
          {
            id: "other-install",
            tags: ["install:other"],
            agent_source: AGENT_SOURCE,
            relevance_score: 0.8
          },
          {
            id: "other-agent",
            tags: ["install:server"],
            agent_source: "nctx-test",
            relevance_score: 0.7
          }
        ],
        search_metadata: {
          total_results: 3
        }
      },
      "install:server",
      5
    );

    expect(filtered.results).toEqual([
      {
        id: "owned",
        tags: ["install:server"],
        agent_source: AGENT_SOURCE,
        relevance_score: 0.9
      }
    ]);
    expect(filtered.search_metadata).toEqual({ total_results: 1 });
  });

  it("post-filters text search results by install tag, agent source, and project scope", () => {
    const filtered = filterTextSearchResponse(
      {
        contexts: [
          {
            id: "owned-project",
            tags: ["install:server", "project:alpha"],
            agent_source: AGENT_SOURCE
          },
          {
            id: "owned-other-project",
            tags: ["install:server", "project:beta"],
            agent_source: AGENT_SOURCE
          },
          {
            id: "other-install",
            tags: ["install:other", "project:alpha"],
            agent_source: AGENT_SOURCE
          },
          {
            id: "other-agent",
            tags: ["install:server", "project:alpha"],
            agent_source: "nctx-test"
          }
        ],
        search_metadata: { total_results: 4 }
      },
      "install:server",
      5,
      "project:alpha"
    );

    expect(filtered.contexts).toEqual([
      {
        id: "owned-project",
        tags: ["install:server", "project:alpha"],
        agent_source: AGENT_SOURCE
      }
    ]);
    expect(filtered.search_metadata).toEqual({ total_results: 1 });
  });

  it("normalizes NCtx semantic memory types from category tags", () => {
    expect(normalizeMemoryTypeFromTags({ memory_type: "episodic", tags: ["decisions"] })).toMatchObject({
      memory_type: "fact"
    });
    expect(normalizeMemoryTypeFromTags({ memory_type: "episodic", tags: ["patterns"] })).toMatchObject({
      memory_type: "procedural"
    });
    expect(normalizeMemoryTypeFromTags({ memory_type: "fact", tags: ["state", "next-steps"] })).toMatchObject({
      memory_type: "episodic"
    });
  });

  it("extracts bearer tokens and rejects malformed authorization headers", () => {
    expect(
      bearerToken(
        new Request("https://worker.example/contexts", {
          headers: { Authorization: "Bearer nctx_it_token" }
        })
      )
    ).toBe("nctx_it_token");

    expect(
      bearerToken(
        new Request("https://worker.example/contexts", {
          headers: { Authorization: "Basic nctx_it_token" }
        })
      )
    ).toBeNull();
  });

  it("handler forwards saves through the tested isolation boundary", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    let forwardedBody: any = null;

    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body));
      return Response.json({ id: "ctx_saved", ...forwardedBody });
    });

    const installToken = await registerInstall(worker, env);

    const saveResponse = await worker.fetch(
      new Request("https://worker.example/contexts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${installToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: "Decision",
          summary: "A decision",
          content: "A context body long enough to save.",
          agent_source: "attacker",
          tags: [" project:alpha ", " install:spaced ", "INSTALL:upper", "topic"],
          metadata: { install_id: "attacker" }
        })
      }),
      env
    );

    expect(saveResponse.status).toBe(200);
    expect(forwardedBody.agent_source).toBe(AGENT_SOURCE);
    expect(forwardedBody.metadata.install_id).not.toBe("attacker");
    expect(forwardedBody.tags).toEqual(["project:alpha", "topic", `install:${forwardedBody.metadata.install_id}`]);
  });

  it("handler post-filters text search responses before returning them", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);
    const upstreamUrls: string[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      upstreamUrls.push(url.toString());
      const installTag = url.searchParams.get("tags") ?? "install:missing";
      return Response.json({
        contexts: [
          {
            id: "owned",
            tags: [installTag, "project:alpha"],
            agent_source: AGENT_SOURCE
          },
          {
            id: "cross-project",
            tags: [installTag, "project:beta"],
            agent_source: AGENT_SOURCE
          },
          {
            id: "other-agent",
            tags: [installTag, "project:alpha"],
            agent_source: "nctx-test"
          }
        ]
      });
    });

    const response = await worker.fetch(
      new Request("https://worker.example/contexts/search?q=owned&limit=3&project_name=alpha", {
        headers: { Authorization: `Bearer ${installToken}` }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(new URL(upstreamUrls[0]).searchParams.get("tags")).toMatch(/^install:/);
    await expect(response.json()).resolves.toMatchObject({
      contexts: [
        {
          id: "owned",
          agent_source: AGENT_SOURCE
        }
      ]
    });
  });

  it("handler uses isolated text fallback when semantic post-filtering misses recall", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);
    const upstreamUrls: string[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      upstreamUrls.push(url.toString());
      if (url.pathname.endsWith("/contexts/semantic-search")) {
        return Response.json({
          results: [
            {
              id: "other-install",
              tags: ["install:other", "project:alpha"],
              agent_source: AGENT_SOURCE
            }
          ],
          search_metadata: { total_results: 1 }
        });
      }

      const installTag = url.searchParams.get("tags") ?? "install:missing";
      return Response.json({
        contexts: [
          {
            id: "fallback-owned",
            tags: [installTag, "project:alpha"],
            agent_source: AGENT_SOURCE
          },
          {
            id: "fallback-other-project",
            tags: [installTag, "project:beta"],
            agent_source: AGENT_SOURCE
          }
        ]
      });
    });

    const response = await worker.fetch(
      new Request("https://worker.example/contexts/semantic-search?q=recall&limit=1&project_name=alpha", {
        headers: { Authorization: `Bearer ${installToken}` }
      }),
      env
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(upstreamUrls).toHaveLength(2);
    expect(upstreamUrls[0]).toContain("/contexts/semantic-search");
    expect(upstreamUrls[1]).toContain("/contexts/search");
    expect(body.results).toEqual([
      {
        id: "fallback-owned",
        tags: [new URL(upstreamUrls[1]).searchParams.get("tags"), "project:alpha"],
        agent_source: AGENT_SOURCE
      }
    ]);
    expect(body.search_metadata).toMatchObject({
      total_results: 1,
      text_fallback_used: true
    });
  });

  it("bounds install minting by IP before returning public beta tokens", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv({ packageSecret: PUBLIC_BETA_PACKAGE_SHARED_SECRET });
    const headers = {
      "x-nctx-package-secret": PUBLIC_BETA_PACKAGE_SHARED_SECRET,
      "cf-connecting-ip": "203.0.113.10"
    };

    for (let i = 0; i < 25; i += 1) {
      const response = await worker.fetch(
        new Request("https://worker.example/installs", {
          method: "POST",
          headers
        }),
        env
      );
      expect(response.status).toBe(200);
    }

    const response = await worker.fetch(
      new Request("https://worker.example/installs", {
        method: "POST",
        headers
      }),
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: "Install registration rate limited",
      scope: "ip",
      cap: 25
    });
  });

  it("applies a global daily cap when the deployed Worker uses the public beta secret", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const seenCounters: Array<{ id: string; cap: number }> = [];
    const env = makeEnv({
      packageSecret: PUBLIC_BETA_PACKAGE_SHARED_SECRET,
      incrementAndCheck: async (id, cap) => {
        seenCounters.push({ id, cap });
        if (id === "install-mint:public-beta") return { allowed: false, count: cap, remaining: 0 };
        return { allowed: true, count: 1, remaining: cap - 1 };
      }
    });

    const response = await worker.fetch(
      new Request("https://worker.example/installs", {
        method: "POST",
        headers: {
          "x-nctx-package-secret": PUBLIC_BETA_PACKAGE_SHARED_SECRET,
          "cf-connecting-ip": "203.0.113.20"
        }
      }),
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: "Install registration rate limited",
      scope: "public-beta",
      cap: 1000
    });
    expect(seenCounters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.stringMatching(/^install-mint:ip:/), cap: 25 }),
        { id: "install-mint:public-beta", cap: 1000 }
      ])
    );
  });

  it("does not spend the public beta global mint cap for private package secrets", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const seenCounters: string[] = [];
    const env = makeEnv({
      incrementAndCheck: async (id, cap) => {
        seenCounters.push(id);
        return { allowed: true, count: 1, remaining: cap - 1 };
      }
    });

    const response = await worker.fetch(
      new Request("https://worker.example/installs", {
        method: "POST",
        headers: {
          "x-nctx-package-secret": "package-secret",
          "cf-connecting-ip": "203.0.113.30"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(seenCounters).toEqual([expect.stringMatching(/^install-mint:ip:/)]);
  });

  it("returns 400 for invalid save JSON without forwarding upstream", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await worker.fetch(
      new Request("https://worker.example/contexts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${installToken}`,
          "Content-Type": "application/json"
        },
        body: "{"
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 413 for oversized save bodies without forwarding upstream", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await worker.fetch(
      new Request("https://worker.example/contexts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${installToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ content: "x".repeat(300_000) })
      }),
      env
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to text search when semantic search returns 500", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);
    const upstreamUrls: string[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      upstreamUrls.push(url.toString());
      if (url.pathname.endsWith("/contexts/semantic-search")) {
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }

      const installTag = url.searchParams.get("tags") ?? "install:missing";
      return Response.json({
        contexts: [
          {
            id: "text-result",
            tags: [installTag, "project:alpha"],
            agent_source: AGENT_SOURCE
          }
        ]
      });
    });

    const response = await worker.fetch(
      new Request("https://worker.example/contexts/semantic-search?q=recall&limit=3&project_name=alpha", {
        headers: { Authorization: `Bearer ${installToken}` }
      }),
      env
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(upstreamUrls).toHaveLength(2);
    expect(upstreamUrls[0]).toContain("/contexts/semantic-search");
    expect(upstreamUrls[1]).toContain("/contexts/search");
    expect(body.results).toEqual([
      {
        id: "text-result",
        tags: [new URL(upstreamUrls[1]).searchParams.get("tags"), "project:alpha"],
        agent_source: AGENT_SOURCE
      }
    ]);
    expect(body.search_metadata).toMatchObject({
      text_fallback_used: true,
      semantic_error: "Semantic upstream error 500"
    });
  });

  it("returns an empty result set when semantic fails and text fallback succeeds with no matches", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/contexts/semantic-search")) {
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }

      return Response.json({ contexts: [] });
    });

    const response = await worker.fetch(
      new Request("https://worker.example/contexts/semantic-search?q=none&limit=3&project_name=alpha", {
        headers: { Authorization: `Bearer ${installToken}` }
      }),
      env
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.search_metadata).toMatchObject({
      total_results: 0,
      text_fallback_used: true,
      semantic_error: "Semantic upstream error 500"
    });
  });

  it("does not crash the semantic search path when text fallback throws a network error", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/contexts/semantic-search")) {
        // Semantic search succeeds but returns zero owned results
        return Response.json({
          results: [
            {
              id: "other-install",
              tags: ["install:other"],
              agent_source: AGENT_SOURCE
            }
          ],
          search_metadata: { total_results: 1 }
        });
      }
      // Text fallback throws a non-timeout network error (DNS, TLS, etc.)
      throw new TypeError("fetch failed");
    });

    const response = await worker.fetch(
      new Request("https://worker.example/contexts/semantic-search?q=crash&limit=3", {
        headers: { Authorization: `Bearer ${installToken}` }
      }),
      env
    );

    // Should not throw — should return the (empty) semantic results gracefully
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.results).toEqual([]);
  });

  it("does not crash when text fallback throws during semantic failure path", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    const env = makeEnv();
    const installToken = await registerInstall(worker, env);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/contexts/semantic-search")) {
        // Semantic search fails with 500
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }
      // Text fallback also throws a network error
      throw new TypeError("fetch failed");
    });

    const response = await worker.fetch(
      new Request("https://worker.example/contexts/semantic-search?q=crash&limit=3", {
        headers: { Authorization: `Bearer ${installToken}` }
      }),
      env
    );

    // Should not throw — should return 502 since both paths failed
    expect(response.status).toBe(502);
    const body = (await response.json()) as any;
    expect(body.error).toBe("Upstream error");
    expect(body.detail).toContain("Semantic upstream error 500");
  });

  it("does not consume the daily cap for unrouted paths", async () => {
    const { default: worker } = await import("../../worker/src/index.js");
    let capCalls = 0;
    const env = makeEnv({
      incrementAndCheck: async () => {
        capCalls += 1;
        return { allowed: true, count: capCalls, remaining: 499 };
      }
    });
    const installToken = await registerInstall(worker, env);
    capCalls = 0;

    const response = await worker.fetch(
      new Request("https://worker.example/unrouted", {
        headers: {
          Authorization: `Bearer ${installToken}`
        }
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(capCalls).toBe(0);
  });
});

async function registerInstall(worker: any, env: any): Promise<string> {
  const initResponse = await worker.fetch(
    new Request("https://worker.example/installs", {
      method: "POST",
      headers: { "x-nctx-package-secret": env.PACKAGE_SHARED_SECRET }
    }),
    env
  );
  const initBody = (await initResponse.json()) as { install_token: string };
  return initBody.install_token;
}

function makeEnv(
  options: {
    packageSecret?: string;
    incrementAndCheck?: (
      id: string,
      cap: number
    ) => Promise<{ allowed: boolean; count: number; remaining: number }>;
  } = {}
): any {
  const installs = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    NIA_API_KEY: "nia-key",
    PACKAGE_SHARED_SECRET: options.packageSecret ?? "package-secret",
    INSTALLS: {
      get: async (key: string) => installs.get(key) ?? null,
      put: async (key: string, value: string) => {
        installs.set(key, value);
      }
    },
    INSTALL_COUNTER: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        incrementAndCheck: async (cap: number) => {
          if (options.incrementAndCheck) return options.incrementAndCheck(id, cap);

            const count = counters.get(id) ?? 0;
            if (count >= cap) return { allowed: false, count, remaining: 0 };
            const next = count + 1;
            counters.set(id, next);
            return { allowed: true, count: next, remaining: Math.max(0, cap - next) };
        }
      })
    },
    IP_RATE_LIMITER: {
      limit: async () => ({ success: true })
    }
  };
}
