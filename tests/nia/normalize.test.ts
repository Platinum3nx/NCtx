import { describe, expect, it } from "vitest";
import { normalizeSearchResult } from "../../src/nia/client.js";
import { buildContextDraftsFromMemory } from "../../src/nia/reindex.js";

describe("normalizeSearchResult", () => {
  it("accepts current and legacy score/highlight field names", () => {
    expect(
      normalizeSearchResult({
        id: "a",
        relevance_score: 0.9,
        match_highlights: ["new"]
      }).score
    ).toBe(0.9);
    expect(
      normalizeSearchResult({
        id: "b",
        score: 0.4,
        highlights: ["old"]
      }).highlights
    ).toEqual(["old"]);
  });

  it("pads short reindexed content with memory-specific detail", () => {
    const drafts = buildContextDraftsFromMemory({
      file_path: "/tmp/project/.nctx/memories/capture-1.md",
      id: "capture-1",
      frontmatter: {
        memory_type: "fact",
        summary: "Redis webhook dedup decision",
        tags: ["stripe"],
        project_name: "demo"
      },
      body: "Use Redis.",
      raw: "Use Redis."
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].content.length).toBeGreaterThanOrEqual(50);
    expect(drafts[0].content).toContain("Memory summary: Redis webhook dedup decision");
    expect(drafts[0].content).not.toContain("Additional NCtx memory content");
  });
});
