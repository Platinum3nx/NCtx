import { describe, expect, it } from "vitest";
import { buildContextDrafts } from "../../src/capture/contexts.js";
import type { ExtractionResult } from "../../src/types.js";

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

    const drafts = buildContextDrafts(extraction, {
      captureId: "cap",
      projectName: "demo",
      sessionId: "sid",
      trigger: "session-end",
      nctxVersion: "0.1.0"
    });

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
    expect(
      buildContextDrafts(extraction, {
        captureId: "cap",
        projectName: "demo",
        sessionId: "sid",
        trigger: "manual",
        nctxVersion: "0.1.0"
      })
    ).toEqual([]);
  });
});

