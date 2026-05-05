import { describe, expect, it } from "vitest";

import { formatResults, normalizeSearchResult, normalizeSearchResultsResponse } from "../../src/mcp/format.js";

describe("MCP result normalization", () => {
  it("normalizes current semantic search fields", () => {
    const results = normalizeSearchResultsResponse({
      results: [
        {
          id: "ctx_abc123",
          title: "Stripe webhook decisions and gotchas",
          summary: "Chose Redis-backed dedup and handled out-of-order Stripe events",
          tags: ["stripe", "webhooks", "install:server-side-id"],
          agent_source: "nctx-claude-code",
          memory_type: "fact",
          created_at: "2026-05-04T14:32:00Z",
          metadata: { files_touched: ["src/api/stripe/webhook.ts"] },
          edited_files: [{ file_path: "src/api/stripe/webhook.ts", operation: "edited" }],
          relevance_score: 0.87,
          match_highlights: ["Redis-backed dedup was chosen for Stripe idempotency."]
        }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      score: 0.87,
      highlights: ["Redis-backed dedup was chosen for Stripe idempotency."],
      file_paths: ["src/api/stripe/webhook.ts"]
    });

    const formatted = formatResults(results);
    expect(formatted).toContain("Stripe webhook decisions and gotchas");
    expect(formatted).toContain("Summary: Chose Redis-backed dedup");
    expect(formatted).toContain("Date: 2026-05-04T14:32:00Z");
    expect(formatted).toContain("Memory type: fact");
    expect(formatted).toContain("Score: 0.870");
    expect(formatted).toContain("Tags: stripe, webhooks");
    expect(formatted).not.toContain("install:server-side-id");
    expect(formatted).toContain("Files: src/api/stripe/webhook.ts");
    expect(formatted).toContain("Highlights:");
    expect(formatted).toContain("- Redis-backed dedup was chosen for Stripe idempotency.");
  });

  it("normalizes legacy text search fields", () => {
    const result = normalizeSearchResult({
      title: "Legacy highlight shape",
      summary: "The older response uses score and highlights fields.",
      tags: ["procedural"],
      memory_type: "procedural",
      created_at: "2026-05-05T01:59:52.399000",
      metadata: { files: ["src/mcp/server.ts"] },
      score: "0.42",
      highlights: [{ text: "Legacy highlights still render." }]
    });

    expect(result.score).toBe(0.42);
    expect(result.highlights).toEqual(["Legacy highlights still render."]);
    expect(result.file_paths).toEqual(["src/mcp/server.ts"]);

    const formatted = formatResults([result]);
    expect(formatted).toContain("Legacy highlight shape");
    expect(formatted).toContain("Memory type: procedural");
    expect(formatted).toContain("Score: 0.420");
    expect(formatted).toContain("Tags: procedural");
    expect(formatted).toContain("Files: src/mcp/server.ts");
    expect(formatted).toContain("- Legacy highlights still render.");
  });

  it("formats empty search responses clearly", () => {
    expect(formatResults(normalizeSearchResultsResponse({ contexts: [] }))).toBe("No NCtx memories found.");
  });
});
