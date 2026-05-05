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

    const initResponse = await worker.fetch(
      new Request("https://worker.example/installs", {
        method: "POST",
        headers: { "x-nctx-package-secret": "package-secret" }
      }),
      env
    );
    const initBody = (await initResponse.json()) as { install_token: string };

    const saveResponse = await worker.fetch(
      new Request("https://worker.example/contexts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${initBody.install_token}`,
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
});

function makeEnv(): any {
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
        incrementAndCheck: async () => ({ allowed: true, count: 1, remaining: 499 })
      })
    },
    IP_RATE_LIMITER: {
      limit: async () => ({ success: true })
    }
  };
}
