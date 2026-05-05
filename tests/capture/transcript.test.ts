import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { transcriptToText } from "../../src/capture/transcript.js";

describe("transcriptToText", () => {
  it("keeps user/assistant text, drops tool outputs/thinking, and appends ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nctx-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "system", message: { content: "ignore" } }),
        JSON.stringify({ type: "user", message: { content: "hello" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "secret thought" },
              { type: "text", text: "I will edit the file." },
              { type: "tool_use", name: "Edit", input: { file_path: "src/app.ts" } }
            ]
          }
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", content: "giant file output" },
              { type: "text", text: "thanks" }
            ]
          }
        })
      ].join("\n")
    );

    const parsed = await transcriptToText(path);
    expect(parsed.text).toContain("USER: hello");
    expect(parsed.text).toContain("ASSISTANT: I will edit the file.");
    expect(parsed.text).toContain("USER: thanks");
    expect(parsed.text).toContain("Edit (edit): src/app.ts");
    expect(parsed.text).not.toContain("giant file output");
    expect(parsed.text).not.toContain("secret thought");
  });

  it("keeps recent transcript text under a ceiling while preserving the tool ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nctx-"));
    const path = join(dir, "large-session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "ancient request that should fall out of the prompt" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "ancient assistant explanation that should be truncated" },
              { type: "tool_use", name: "Edit", input: { file_path: "src/ancient.ts" } }
            ]
          }
        }),
        ...Array.from({ length: 12 }, (_, index) =>
          JSON.stringify({ type: "user", message: { content: `middle filler ${index} ${"x".repeat(40)}` } })
        ),
        JSON.stringify({ type: "user", message: { content: "recent decision: keep the lock around cursor writes" } })
      ].join("\n")
    );

    const parsed = await transcriptToText(path, 0, { maxTextChars: 140 });

    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toContain("Earlier transcript text truncated");
    expect(parsed.text).toContain("recent decision: keep the lock around cursor writes");
    expect(parsed.text).toContain("Edit (edit): src/ancient.ts");
    expect(parsed.text).not.toContain("ancient request that should fall out");
    expect(parsed.toolActions).toHaveLength(1);
    expect(parsed.nextLine).toBe(15);
  });

  it("caps the tool ledger to recent unique actions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nctx-"));
    const path = join(dir, "tool-session.jsonl");
    await writeFile(
      path,
      [
        toolUseLine("Read", "src/old.ts"),
        toolUseLine("Edit", "src/middle.ts"),
        toolUseLine("Write", "src/recent.ts")
      ].join("\n")
    );

    const parsed = await transcriptToText(path, 0, { maxToolActions: 2 });

    expect(parsed.text).not.toContain("src/old.ts");
    expect(parsed.text).toContain("Edit (edit): src/middle.ts");
    expect(parsed.text).toContain("Write (edit): src/recent.ts");
    expect(parsed.toolActions.map((action) => action.file_path)).toEqual(["src/middle.ts", "src/recent.ts"]);
  });

  it("does not advance the cursor past a malformed final line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nctx-"));
    const path = join(dir, "partial-session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "stable line" } }),
        '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"'
      ].join("\n")
    );

    const parsed = await transcriptToText(path);

    expect(parsed.text).toContain("USER: stable line");
    expect(parsed.nextLine).toBe(1);

    await writeFile(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "stable line" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "now complete" }] }
        })
      ].join("\n"),
      "utf8"
    );

    const resumed = await transcriptToText(path, parsed.nextLine);
    expect(resumed.text).toContain("ASSISTANT: now complete");
    expect(resumed.nextLine).toBe(2);
  });
});

function toolUseLine(name: string, filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input: { file_path: filePath } }]
    }
  });
}
