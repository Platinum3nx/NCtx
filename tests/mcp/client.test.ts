import { describe, expect, it } from "vitest";

import { makeClient } from "../../src/mcp/client.js";
import type { NctxMcpConfig } from "../../src/mcp/config.js";

const config: NctxMcpConfig = {
  mode: "hosted",
  install_token: "nctx_it_test",
  proxy_url: "https://worker.example",
  project_name: "test-project",
  version: "0.1.0",
  config_path: "/tmp/project/.nctx/config.json"
};

describe("MCP hosted memory client", () => {
  it("calls Worker semantic search and normalizes current response fields", async () => {
    const requests: Request[] = [];
    const client = makeClient(config, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);

      return Response.json({
        results: [
          {
            title: "Semantic memory",
            summary: "Current semantic shape",
            relevance_score: 0.91,
            match_highlights: ["current highlight"]
          }
        ]
      });
    });

    const results = await client.searchContexts("stripe webhook", 3, "semantic");

    expect(requests[0].url).toBe(
      "https://worker.example/contexts/semantic-search?q=stripe+webhook&limit=3&project_name=test-project&include_highlights=true"
    );
    expect(requests[0].headers.get("Authorization")).toBe("Bearer nctx_it_test");
    expect(results[0]).toMatchObject({
      title: "Semantic memory",
      score: 0.91,
      highlights: ["current highlight"]
    });
  });

  it("calls Worker text search and normalizes legacy response fields", async () => {
    const requests: Request[] = [];
    const client = makeClient(config, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);

      return Response.json({
        contexts: [
          {
            title: "Text memory",
            summary: "Legacy text shape",
            score: 0.5,
            highlights: ["legacy highlight"]
          }
        ]
      });
    });

    const results = await client.searchContexts("where left off", 2, "text");

    expect(requests[0].url).toBe(
      "https://worker.example/contexts/search?q=where+left+off&limit=2&project_name=test-project"
    );
    expect(results[0]).toMatchObject({
      title: "Text memory",
      score: 0.5,
      highlights: ["legacy highlight"]
    });
  });

  it("surfaces Worker errors with useful context", async () => {
    const client = makeClient(config, async () =>
      Response.json({ error: "Invalid install token" }, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.searchContexts("anything")).rejects.toThrow(
      "NCtx memory search failed (401 Unauthorized): Invalid install token"
    );
  });

  it("preserves proxy path prefixes when building Worker URLs", async () => {
    const requests: Request[] = [];
    const client = makeClient(
      {
        ...config,
        proxy_url: "https://gateway.example/nctx/proxy/"
      },
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ results: [] });
      }
    );

    await client.searchContexts("proxy prefix", 1, "semantic");

    expect(requests[0].url).toBe(
      "https://gateway.example/nctx/proxy/contexts/semantic-search?q=proxy+prefix&limit=1&project_name=test-project&include_highlights=true"
    );
  });
});
