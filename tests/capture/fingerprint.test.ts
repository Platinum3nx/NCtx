import { describe, expect, it } from "vitest";
import { computeDraftFingerprint, filterDuplicateDrafts } from "../../src/capture/fingerprint.js";
import type { ContextDraft } from "../../src/types.js";

function makeDraft(overrides: Partial<ContextDraft> & Pick<ContextDraft, "memory_type" | "content" | "tags">): ContextDraft {
  return {
    title: "Test draft",
    summary: "A test draft",
    agent_source: "nctx-claude-code",
    metadata: {},
    ...overrides
  };
}

describe("computeDraftFingerprint", () => {
  it("produces the same fingerprint for identical content", () => {
    const draft = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis dedup\n\nStripe retries events.\n\n## Gotcha: Missing idempotency key\n\nCause: No key set\n\nFix: Add key",
      tags: ["project:demo", "stripe"]
    });

    const fp1 = computeDraftFingerprint(draft);
    const fp2 = computeDraftFingerprint(draft);

    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it("produces the same fingerprint regardless of heading order in content", () => {
    const draft1 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Alpha\n\nDetails\n\n## Decision: Beta\n\nDetails",
      tags: ["project:demo"]
    });

    const draft2 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Beta\n\nDetails\n\n## Decision: Alpha\n\nDetails",
      tags: ["project:demo"]
    });

    expect(computeDraftFingerprint(draft1)).toBe(computeDraftFingerprint(draft2));
  });

  it("produces different fingerprints for different content", () => {
    const draft1 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:demo"]
    });

    const draft2 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Postgres\n\nFor persistence",
      tags: ["project:demo"]
    });

    expect(computeDraftFingerprint(draft1)).not.toBe(computeDraftFingerprint(draft2));
  });

  it("produces different fingerprints for different memory types", () => {
    const draft1 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:demo"]
    });

    const draft2 = makeDraft({
      memory_type: "procedural",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:demo"]
    });

    expect(computeDraftFingerprint(draft1)).not.toBe(computeDraftFingerprint(draft2));
  });

  it("produces different fingerprints for different projects", () => {
    const draft1 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:alpha"]
    });

    const draft2 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:beta"]
    });

    expect(computeDraftFingerprint(draft1)).not.toBe(computeDraftFingerprint(draft2));
  });

  it("produces different fingerprints for same heading but different body/rationale", () => {
    const draft1 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nRationale: We need sub-millisecond latency for session lookups.",
      tags: ["project:demo"]
    });

    const draft2 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nRationale: We need pub/sub for real-time event broadcasting.",
      tags: ["project:demo"]
    });

    expect(computeDraftFingerprint(draft1)).not.toBe(computeDraftFingerprint(draft2));
  });

  it("produces different fingerprints when content differs after the first 100 chars", () => {
    // Both bodies share the same first 100+ characters but diverge in conclusion
    const sharedPrefix = "Rationale: We evaluated multiple caching solutions and determined that the best approach for our tea";
    // sharedPrefix is exactly 100 chars
    expect(sharedPrefix).toHaveLength(100);

    const draft1 = makeDraft({
      memory_type: "fact",
      content: `## Decision: Use Redis\n\n${sharedPrefix}am is to use Redis for its sub-millisecond latency and built-in TTL support.`,
      tags: ["project:demo"]
    });

    const draft2 = makeDraft({
      memory_type: "fact",
      content: `## Decision: Use Redis\n\n${sharedPrefix}am is to use Memcached for its simplicity and multi-threaded architecture.`,
      tags: ["project:demo"]
    });

    expect(computeDraftFingerprint(draft1)).not.toBe(computeDraftFingerprint(draft2));
  });

  it("produces the same fingerprint when only trivial whitespace differs", () => {
    const draft1 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching with low latency",
      tags: ["project:demo"]
    });

    const draft2 = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor  caching   with\n low   latency",
      tags: ["project:demo"]
    });

    expect(computeDraftFingerprint(draft1)).toBe(computeDraftFingerprint(draft2));
  });
});

describe("filterDuplicateDrafts", () => {
  it("filters out fact drafts whose fingerprint matches existing", () => {
    const draft = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:demo"]
    });

    const fp = computeDraftFingerprint(draft);
    const existing = new Set([fp]);

    const { toPublish, skipped } = filterDuplicateDrafts([draft], existing);

    expect(toPublish).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].fingerprint).toBe(fp);
  });

  it("filters out procedural drafts whose fingerprint matches existing", () => {
    const draft = makeDraft({
      memory_type: "procedural",
      content: "## Pattern: Webhook handlers are idempotent\n\nRationale: Retries happen.",
      tags: ["project:demo"]
    });

    const fp = computeDraftFingerprint(draft);
    const existing = new Set([fp]);

    const { toPublish, skipped } = filterDuplicateDrafts([draft], existing);

    expect(toPublish).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("never deduplicates episodic drafts even if fingerprint matches", () => {
    const draft = makeDraft({
      memory_type: "episodic",
      content: "## State\n\nIn progress: Fixing webhook signature rotation",
      tags: ["project:demo"]
    });

    const fp = computeDraftFingerprint(draft);
    const existing = new Set([fp]);

    const { toPublish, skipped } = filterDuplicateDrafts([draft], existing);

    expect(toPublish).toHaveLength(1);
    expect(toPublish[0]).toBe(draft);
    expect(skipped).toHaveLength(0);
  });

  it("passes through drafts that have no matching fingerprint", () => {
    const draft = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Postgres\n\nFor data persistence",
      tags: ["project:demo"]
    });

    const existing = new Set(["deadbeef12345678"]);

    const { toPublish, skipped } = filterDuplicateDrafts([draft], existing);

    expect(toPublish).toHaveLength(1);
    expect(toPublish[0]).toBe(draft);
    expect(skipped).toHaveLength(0);
  });

  it("handles mixed drafts correctly — only deduplicates fact/procedural", () => {
    const factDraft = makeDraft({
      memory_type: "fact",
      content: "## Decision: Use Redis\n\nFor caching",
      tags: ["project:demo"]
    });
    const proceduralDraft = makeDraft({
      memory_type: "procedural",
      content: "## Pattern: Handlers are idempotent\n\nRationale: Retries happen.",
      tags: ["project:demo"]
    });
    const episodicDraft = makeDraft({
      memory_type: "episodic",
      content: "## State\n\nIn progress: Fixing rotation",
      tags: ["project:demo"]
    });

    const factFp = computeDraftFingerprint(factDraft);
    const episodicFp = computeDraftFingerprint(episodicDraft);
    // Only fact fingerprint is in existing set
    const existing = new Set([factFp, episodicFp]);

    const { toPublish, skipped } = filterDuplicateDrafts(
      [factDraft, proceduralDraft, episodicDraft],
      existing
    );

    // fact is skipped, procedural passes (no match), episodic always passes
    expect(toPublish).toHaveLength(2);
    expect(toPublish.map((d) => d.memory_type)).toEqual(["procedural", "episodic"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].draft.memory_type).toBe("fact");
  });
});
