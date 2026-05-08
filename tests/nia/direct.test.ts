import { describe, expect, it, vi, afterEach } from "vitest";

import { makeClient } from "../../src/nia/client.js";

const directConfig = {
  mode: "direct",
  nia_api_key: "nia_test_user_key_that_is_long_enough",
  nia_base_url: "https://apigcp.trynia.ai/v2",
  project_name: "demo",
  version: "0.2.0"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("direct Nia client", () => {
  it("saves contexts directly to Nia with the user's API key and no hosted install data", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ id: "ctx_direct_fact" });
    });

    const client = makeClient(directConfig as any);
    await client.saveContext({
      title: "Direct memory",
      summary: "Direct BYOK memory",
      content: "Direct BYOK content that is long enough for Nia validation.",
      tags: ["project:demo", "install:old-hosted-boundary"],
      agent_source: "spoofed-agent",
      memory_type: "fact",
      metadata: { install_id: "old-hosted-id", project_name: "demo" }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://apigcp.trynia.ai/v2/contexts");
    expect(requests[0].headers.get("Authorization")).toBe("Bearer nia_test_user_key_that_is_long_enough");
    const body = JSON.parse(await requests[0].text());
    expect(body).toMatchObject({
      agent_source: "nctx-claude-code",
      tags: ["project:demo"],
      memory_type: "fact"
    });
    expect(body.metadata).not.toHaveProperty("install_id");
  });

  it("searches Nia directly and keeps project scope local to NCtx", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({
        results: [
          {
            id: "ctx_in_project",
            title: "In project",
            tags: ["project:demo"],
            agent_source: "nctx-claude-code",
            relevance_score: 0.8
          },
          {
            id: "ctx_other_project",
            title: "Other project",
            tags: ["project:other"],
            agent_source: "nctx-claude-code",
            relevance_score: 0.9
          }
        ]
      });
    });

    const client = makeClient(directConfig as any);
    const results = await client.searchContexts("direct recall", 2, "semantic");

    expect(requests[0].url).toBe(
      "https://apigcp.trynia.ai/v2/contexts/semantic-search?q=direct+recall&limit=20&include_highlights=true"
    );
    expect(requests[0].headers.get("Authorization")).toBe("Bearer nia_test_user_key_that_is_long_enough");
    expect(results.map((result) => result.id)).toEqual(["ctx_in_project"]);
  });
});
