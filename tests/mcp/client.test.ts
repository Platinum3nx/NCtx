import { describe, expect, it } from "vitest";

import { makeClient } from "../../src/mcp/client.js";
import type { NctxMcpConfig } from "../../src/mcp/config.js";

const config: NctxMcpConfig = {
  mode: "direct",
  nia_api_key: "nia_test_user_key_that_is_long_enough",
  nia_base_url: "https://apigcp.trynia.ai/v2",
  project_name: "test-project",
  version: "0.2.0",
  config_path: "/tmp/project/.nctx/config.json"
};

describe("MCP direct memory client", () => {
  it("calls Nia semantic search directly with the user's API key in direct mode", async () => {
    const requests: Request[] = [];
    const client = makeClient(
      {
        mode: "direct",
        nia_api_key: "nia_test_user_key_that_is_long_enough",
        nia_base_url: "https://apigcp.trynia.ai/v2",
        project_name: "test-project",
        version: "0.2.0",
        config_path: "/tmp/project/.nctx/config.json"
      } as any,
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          results: [
            {
              id: "ctx_project",
              title: "Project memory",
              tags: ["project:test-project"],
              agent_source: "nctx-claude-code",
              relevance_score: 0.7
            },
            {
              id: "ctx_other",
              title: "Other memory",
              tags: ["project:other"],
              agent_source: "nctx-claude-code",
              relevance_score: 0.9
            }
          ]
        });
      }
    );

    const results = await client.searchContexts("direct recall", 2, "semantic");

    expect(requests[0].url).toBe(
      "https://apigcp.trynia.ai/v2/contexts/semantic-search?q=direct+recall&limit=2&include_highlights=true"
    );
    expect(requests[0].headers.get("Authorization")).toBe("Bearer nia_test_user_key_that_is_long_enough");
    expect(results.map((result) => result.id)).toEqual(["ctx_project"]);
  });

  it("surfaces direct Nia auth errors without Worker language", async () => {
    const client = makeClient(
      {
        mode: "direct",
        nia_api_key: "nia_test_user_key_that_is_long_enough",
        nia_base_url: "https://apigcp.trynia.ai/v2",
        project_name: "test-project",
        version: "0.2.0",
        config_path: "/tmp/project/.nctx/config.json"
      } as any,
      async () => Response.json({ error: "Invalid API key" }, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.searchContexts("anything")).rejects.toThrow(
      "NCtx memory search failed (401 Unauthorized): Invalid API key"
    );
  });

  it("calls Nia semantic search and normalizes current response fields", async () => {
    const requests: Request[] = [];
    const client = makeClient(config, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);

      return Response.json({
        results: [
          {
            title: "Semantic memory",
            summary: "Current semantic shape",
            tags: ["project:test-project"],
            agent_source: "nctx-claude-code",
            relevance_score: 0.91,
            match_highlights: ["current highlight"]
          }
        ]
      });
    });

    const results = await client.searchContexts("stripe webhook", 3, "semantic");

    expect(requests[0].url).toBe(
      "https://apigcp.trynia.ai/v2/contexts/semantic-search?q=stripe+webhook&limit=3&include_highlights=true"
    );
    expect(requests[0].headers.get("Authorization")).toBe("Bearer nia_test_user_key_that_is_long_enough");
    expect(results[0]).toMatchObject({
      title: "Semantic memory",
      score: 0.91,
      highlights: ["current highlight"]
    });
  });

  it("calls Nia text search and normalizes legacy response fields", async () => {
    const requests: Request[] = [];
    const client = makeClient(config, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);

      return Response.json({
        contexts: [
          {
            title: "Text memory",
            summary: "Legacy text shape",
            tags: ["project:test-project"],
            agent_source: "nctx-claude-code",
            score: 0.5,
            highlights: ["legacy highlight"]
          }
        ]
      });
    });

    const results = await client.searchContexts("where left off", 2, "text");

    expect(requests[0].url).toBe(
      "https://apigcp.trynia.ai/v2/contexts/search?q=where+left+off&limit=2&tags=project%3Atest-project"
    );
    expect(results[0]).toMatchObject({
      title: "Text memory",
      score: 0.5,
      highlights: ["legacy highlight"]
    });
  });

  it("surfaces Nia errors with useful context", async () => {
    const client = makeClient(config, async () =>
      Response.json({ error: "Invalid API key" }, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.searchContexts("anything")).rejects.toThrow(
      "NCtx memory search failed (401 Unauthorized): Invalid API key"
    );
  });

  it("preserves Nia base URL path prefixes", async () => {
    const requests: Request[] = [];
    const client = makeClient(
      {
        ...config,
        nia_base_url: "https://gateway.example/nia/v2/"
      },
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ results: [] });
      }
    );

    await client.searchContexts("proxy prefix", 1, "semantic");

    expect(requests[0].url).toBe(
      "https://gateway.example/nia/v2/contexts/semantic-search?q=proxy+prefix&limit=1&include_highlights=true"
    );
  });
});
