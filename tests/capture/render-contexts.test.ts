import { test } from "vitest";
import assert from "node:assert/strict";
import { buildContextDrafts } from "../../src/capture/contexts.js";
import { buildExtractionPrompt } from "../../src/capture/prompt.js";
import { makeCaptureId, memoryTypesForExtraction, renderMemoryMarkdown } from "../../src/capture/render.js";

const extraction = {
  summary: "Chose idempotent webhook handler with Redis-backed dedup",
  tags: ["stripe", "webhooks"],
  files_touched: ["src/api/stripe/webhook.ts"],
  decisions: [
    {
      title: "Idempotent webhook handling",
      rationale: "Stripe retries reuse the same event ID, so Redis-backed dedup prevents double processing.",
      files: ["src/api/stripe/webhook.ts"]
    }
  ],
  gotchas: [
    {
      problem: "Stripe sends events out of order",
      cause: "payment_intent.succeeded can arrive before payment_intent.created under load.",
      fix: "Treat events as order-independent and reconcile with timestamps.",
      files: ["src/api/stripe/webhook.ts"]
    }
  ],
  patterns: [
    {
      pattern: "Webhook handlers are idempotent and order-independent",
      rationale: "Provider retries and ordering are not reliable.",
      files: ["src/api/stripe/webhook.ts"]
    }
  ],
  state: {
    in_progress: "webhook signature rotation handling",
    next_steps: ["failure-mode tests for retry exhaustion"],
    files: ["src/api/stripe/webhook.ts"]
  }
};

test("renderMemoryMarkdown writes frontmatter and category sections", () => {
  const markdown = renderMemoryMarkdown({
    extraction,
    captureId: "2026-05-04T14-32-00Z-stripe-webhook-session",
    contextIds: { fact: "ctx_fact_1" },
    sessionId: "sid",
    date: "2026-05-04T14:32:00Z",
    trigger: "session-end",
    sessionEndReason: "exit",
    projectName: "aletheia"
  });

  assert.match(markdown, /^---\n/);
  assert.match(markdown, /context_ids:\n  fact: "ctx_fact_1"/);
  assert.match(markdown, /trigger: "session-end"/);
  assert.match(markdown, /session_end_reason: "exit"/);
  assert.match(markdown, /tags: \["stripe", "webhooks", "project:aletheia"\]/);
  assert.match(markdown, /memory_types: \["fact", "procedural", "episodic"\]/);
  assert.match(markdown, /## Decision: Idempotent webhook handling/);
  assert.match(markdown, /## Gotcha: Stripe sends events out of order/);
  assert.match(markdown, /## Pattern: Webhook handlers are idempotent/);
  assert.match(markdown, /## State/);
});

test("memoryTypesForExtraction omits empty placeholders", () => {
  assert.deepEqual(memoryTypesForExtraction({
    summary: "explored only",
    tags: [],
    files_touched: [],
    decisions: [],
    gotchas: [],
    patterns: [],
    state: { in_progress: null, next_steps: [], files: [] }
  }), []);
});

test("buildContextDrafts emits typed drafts and does not include install metadata", () => {
  const drafts = buildContextDrafts({
    extraction,
    captureId: "capture-1",
    sessionId: "sid",
    projectName: "aletheia",
    trigger: "session-end",
    sessionEndReason: "other",
    toolActions: [
      { tool: "Read", operation: "read", file_path: "src/api/stripe/webhook.ts" },
      { tool: "Edit", operation: "edit", file_path: "src/api/stripe/webhook.ts" }
    ]
  });

  assert.deepEqual(drafts.map((draft) => draft.memory_type), ["fact", "procedural", "episodic"]);
  assert.equal(drafts.every((draft) => draft.agent_source === "nctx-claude-code"), true);
  assert.equal(drafts.some((draft) => "install_id" in draft.metadata), false);
  assert.equal(drafts.some((draft) => draft.tags.some((tag) => tag.startsWith("install:"))), false);
  assert.match(drafts[0]?.content ?? "", /## Decision:/);
  assert.match(drafts[1]?.content ?? "", /## Pattern:/);
  assert.match(drafts[2]?.content ?? "", /## State/);
  assert.deepEqual(drafts[0]?.edited_files, [
    {
      file_path: "src/api/stripe/webhook.ts",
      operation: "edited",
      changes_description: "Touched during the captured Claude Code session."
    }
  ]);
});

test("buildContextDrafts strips caller-supplied install tags", () => {
  const drafts = buildContextDrafts({
    extraction: {
      ...extraction,
      tags: ["stripe", "install:spoofed"]
    },
    captureId: "capture-1",
    sessionId: "sid",
    projectName: "aletheia",
    trigger: "precompact"
  });

  assert.equal(drafts.some((draft) => draft.tags.includes("install:spoofed")), false);
});

test("prompt includes capped CLAUDE.md context area and transcript insertion", () => {
  const prompt = buildExtractionPrompt({
    claudeMd: "Existing distinctive sentence.",
    transcriptText: "USER: Build the capture pipeline."
  });

  assert.match(prompt, /<CLAUDE_MD>\nExisting distinctive sentence\.\n<\/CLAUDE_MD>/);
  assert.match(prompt, /Tool\noutputs have been omitted/);
  assert.match(prompt, /Transcript:\nUSER: Build the capture pipeline\./);
});

test("makeCaptureId creates a filesystem-friendly dated slug", () => {
  assert.equal(
    makeCaptureId("2026-05-04T14:32:00Z", "Stripe webhook session!", "session-end"),
    "2026-05-04T14-32-00Z-stripe-webhook-session"
  );
});
