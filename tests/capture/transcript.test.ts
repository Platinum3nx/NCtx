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
});

