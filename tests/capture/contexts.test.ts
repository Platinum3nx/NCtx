import { describe, expect, it } from "vitest";
import { buildContextDrafts, isHighSignalDraft } from "../../src/capture/contexts.js";
import type { ExtractionResult } from "../../src/types.js";

const defaultOptions = {
  captureId: "cap",
  projectName: "demo",
  sessionId: "sid",
  trigger: "session-end" as const,
  nctxVersion: "0.1.0"
};

describe("buildContextDrafts", () => {
  it("splits extraction into fact, procedural, and episodic contexts without placeholders", () => {
    const extraction: ExtractionResult = {
      summary: "Stripe webhook memory",
      tags: ["stripe"],
      files_touched: ["src/webhook.ts"],
      decisions: [{ title: "Use Redis dedup", rationale: "Stripe retries events.", files: ["src/webhook.ts"] }],
      gotchas: [],
      patterns: [{ pattern: "Webhook handlers are idempotent.", rationale: "Retries happen." }],
      state: { in_progress: "Signature rotation", next_steps: ["Add tests"], files: ["src/webhook.ts"] }
    };

    const { drafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.map((draft) => draft.memory_type)).toEqual(["fact", "procedural", "episodic"]);
    expect(drafts.every((draft) => draft.agent_source === "nctx-claude-code")).toBe(true);
    expect(drafts.every((draft) => draft.tags.some((tag) => tag === "project:demo"))).toBe(true);
  });

  it("does not emit empty placeholder contexts", () => {
    const extraction: ExtractionResult = {
      summary: "Exploration only",
      tags: [],
      files_touched: [],
      decisions: [],
      gotchas: [],
      patterns: [],
      state: { in_progress: null, next_steps: [], files: [] }
    };
    const { drafts } = buildContextDrafts(extraction, {
      captureId: "cap",
      projectName: "demo",
      sessionId: "sid",
      trigger: "manual",
      nctxVersion: "0.1.0"
    });
    expect(drafts).toEqual([]);
  });

  it("uses memory-specific detail instead of generic filler for short content", () => {
    const extraction: ExtractionResult = {
      summary: "UTF-8 CLAUDE.md byte cap hardening",
      tags: ["claude-md"],
      files_touched: ["src/capture/claude-md.ts"],
      decisions: [],
      gotchas: [],
      patterns: [],
      state: { in_progress: "Fix cap", next_steps: [], files: [] }
    };

    const { drafts } = buildContextDrafts(extraction, {
      captureId: "cap",
      projectName: "nctx",
      sessionId: "sid",
      trigger: "manual",
      nctxVersion: "0.1.0"
    });

    // "Fix cap" is too short/generic to pass episodic gate without concrete next steps
    // The gate is conservative, but "Fix cap" is only 7 chars and doesn't mention files/features specifically
    // However it passes because it's > 5 chars and not in the generic phrases set
    expect(drafts).toHaveLength(1);
    expect(drafts[0].content.length).toBeGreaterThanOrEqual(50);
    expect(drafts[0].content).toContain("Session summary: UTF-8 CLAUDE.md byte cap hardening");
    expect(drafts[0].content).not.toContain("This context was extracted");
  });
});

describe("quality gates", () => {
  it("rejects a generic fact extraction with a short/generic decision title", () => {
    const extraction: ExtractionResult = {
      summary: "discussed code",
      tags: [],
      files_touched: [],
      decisions: [{ title: "stuff", rationale: "things" }],
      gotchas: [],
      patterns: [],
      state: { in_progress: null, next_steps: [], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "fact")).toBe(false);
    expect(skippedDrafts.some((s) => s.memoryType === "fact")).toBe(true);
  });

  it("passes a specific fact extraction with a meaningful decision title", () => {
    const extraction: ExtractionResult = {
      summary: "Stripe webhook integration",
      tags: ["stripe"],
      files_touched: ["src/webhook.ts"],
      decisions: [{ title: "Use Redis for webhook dedup", rationale: "Stripe retries events with same ID, need dedup." }],
      gotchas: [],
      patterns: [],
      state: { in_progress: null, next_steps: [], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "fact")).toBe(true);
    expect(skippedDrafts.some((s) => s.memoryType === "fact")).toBe(false);
  });

  it("produces zero drafts for extraction with all empty arrays", () => {
    const extraction: ExtractionResult = {
      summary: "",
      tags: [],
      files_touched: [],
      decisions: [],
      gotchas: [],
      patterns: [],
      state: { in_progress: null, next_steps: [], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts).toHaveLength(0);
    // No skipped drafts either since no drafts were built in the first place
    expect(skippedDrafts).toHaveLength(0);
  });

  it("rejects a procedural draft with a too-short pattern", () => {
    const extraction: ExtractionResult = {
      summary: "session",
      tags: [],
      files_touched: [],
      decisions: [],
      gotchas: [],
      patterns: [{ pattern: "be clean", rationale: "good practice" }],
      state: { in_progress: null, next_steps: [], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "procedural")).toBe(false);
    expect(skippedDrafts.some((s) => s.memoryType === "procedural")).toBe(true);
  });

  it("passes a procedural draft with a specific pattern (> 10 chars)", () => {
    const extraction: ExtractionResult = {
      summary: "webhook patterns",
      tags: [],
      files_touched: [],
      decisions: [],
      gotchas: [],
      patterns: [{ pattern: "Webhook handlers are idempotent and order-independent", rationale: "Provider retries." }],
      state: { in_progress: null, next_steps: [], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "procedural")).toBe(true);
    expect(skippedDrafts.some((s) => s.memoryType === "procedural")).toBe(false);
  });

  it("rejects an episodic draft with only generic in_progress and no next steps", () => {
    const extraction: ExtractionResult = {
      summary: "coding session",
      tags: [],
      files_touched: [],
      decisions: [],
      gotchas: [],
      patterns: [],
      state: { in_progress: "working on code", next_steps: [], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "episodic")).toBe(false);
    expect(skippedDrafts.some((s) => s.memoryType === "episodic")).toBe(true);
  });

  it("passes an episodic draft with specific in_progress", () => {
    const extraction: ExtractionResult = {
      summary: "working on auth",
      tags: [],
      files_touched: ["src/auth.ts"],
      decisions: [],
      gotchas: [],
      patterns: [],
      state: { in_progress: "Implementing OAuth2 PKCE flow for mobile clients", next_steps: [], files: ["src/auth.ts"] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "episodic")).toBe(true);
    expect(skippedDrafts.some((s) => s.memoryType === "episodic")).toBe(false);
  });

  it("passes an episodic draft with concrete next_steps even if in_progress is generic", () => {
    const extraction: ExtractionResult = {
      summary: "session",
      tags: [],
      files_touched: [],
      decisions: [],
      gotchas: [],
      patterns: [],
      state: { in_progress: "coding", next_steps: ["Add retry logic to webhook handler"], files: [] }
    };

    const { drafts, skippedDrafts } = buildContextDrafts(extraction, defaultOptions);

    expect(drafts.some((d) => d.memory_type === "episodic")).toBe(true);
    expect(skippedDrafts.some((s) => s.memoryType === "episodic")).toBe(false);
  });
});
