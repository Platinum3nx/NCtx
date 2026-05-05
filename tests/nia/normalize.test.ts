import { describe, expect, it } from "vitest";
import { normalizeSearchResult } from "../../src/nia/client.js";

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
});

