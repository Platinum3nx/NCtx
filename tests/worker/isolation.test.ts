import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SOURCE,
  bearerToken,
  buildSemanticSearchRequest,
  buildTextSearchUrl,
  filterSemanticSearchResponse,
  isolateContextBody,
  normalizeMemoryTypeFromTags,
  sanitizeAndInjectTags
} from "../../worker/src/isolation.js";

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
      headers: { "x-nctx-package-secret": "package-secret" }
    }),
    env
  );
  const initBody = (await initResponse.json()) as { install_token: string };
  return initBody.install_token;
}

function makeEnv(
  options: {
    incrementAndCheck?: () => Promise<{ allowed: boolean; count: number; remaining: number }>;
  } = {}
): any {
  const installs = new Map<string, string>();
  return {
    NIA_API_KEY: "nia-key",
    PACKAGE_SHARED_SECRET: "package-secret",
    INSTALLS: {
      get: async (key: string) => installs.get(key) ?? null,
      put: async (key: string, value: string) => {
        installs.set(key, value);
      }
    },
    INSTALL_COUNTER: {
      idFromName: (name: string) => name,
      get: () => ({
        incrementAndCheck:
          options.incrementAndCheck ?? (async () => ({ allowed: true, count: 1, remaining: 499 }))
      })
    },
    IP_RATE_LIMITER: {
      limit: async () => ({ success: true })
    }
  };
}
