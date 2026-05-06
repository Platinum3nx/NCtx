import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedConfig, saveConfig } from "../../src/config/load.js";
import { memoryDir, sessionsDir } from "../../src/lib/fs.js";
import type { ExtractionResult } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  extractMemory: vi.fn(),
  saveContext: vi.fn(),
  makeClient: vi.fn()
}));

vi.mock("../../src/capture/extract.js", () => ({
  extractMemory: mocks.extractMemory
}));

vi.mock("../../src/nia/hosted.js", () => ({
  makeClient: mocks.makeClient
}));

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nctx-capture-"));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  mocks.extractMemory.mockReset();
  mocks.saveContext.mockReset();
  mocks.makeClient.mockReset();
  mocks.saveContext.mockImplementation(async (draft) => ({ id: `ctx_${draft.memory_type}` }));
  mocks.makeClient.mockReturnValue({
    saveContext: mocks.saveContext,
    searchContexts: vi.fn(async () => [])
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runCapture", () => {
  it("no-ops before transcript parsing and extraction when the project is not initialized", async () => {
    const root = await tempRoot();
    const { runCapture } = await import("../../src/cli/capture.js");

    await runCapture(
      "session-end",
      Readable.from([
        JSON.stringify({
          session_id: "session-1",
          transcript_path: join(root, "does-not-exist.jsonl"),
          cwd: root
        })
      ])
    );

    expect(mocks.extractMemory).not.toHaveBeenCalled();
    expect(mocks.makeClient).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".nctx"))).toBe(false);
  });

  it("uses the initialized project root for nested capture state", async () => {
    const root = await tempRoot();
    const nested = join(root, "packages", "app", "src");
    await mkdir(nested, { recursive: true });
    await saveConfig(
      root,
      createHostedConfig({
        installToken: "nctx_it_hosted_install_token_long_enough",
        proxyUrl: "https://worker.example",
        projectName: "demo",
        projectRoot: root
      })
    );
    await writeFile(join(root, "CLAUDE.md"), "root project memory", "utf8");
    await writeFile(join(nested, "CLAUDE.md"), "nested project memory", "utf8");
    const transcriptPath = join(root, "session.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({ type: "user", message: { content: "remember the initialized root" } }),
      "utf8"
    );
    const extraction: ExtractionResult = {
      summary: "Nested capture",
      tags: ["durability"],
      files_touched: ["src/app.ts"],
      decisions: [{ title: "Resolve root", rationale: "Capture state belongs to the initialized project." }],
      gotchas: [],
      patterns: [],
      state: { in_progress: null, next_steps: [], files: [] }
    };
    mocks.extractMemory.mockResolvedValue(extraction);
    const { runCapture } = await import("../../src/cli/capture.js");

    await runCapture(
      "session-end",
      Readable.from([
        JSON.stringify({
          session_id: "nested/session",
          transcript_path: transcriptPath,
          cwd: nested
        })
      ])
    );

    expect(mocks.extractMemory).toHaveBeenCalledWith(
      expect.stringContaining("USER: remember the initialized root"),
      "root project memory",
      []
    );
    const memoryFiles = await readdir(memoryDir(root));
    expect(memoryFiles.filter((entry) => entry.endsWith(".md"))).toHaveLength(1);
    const memory = await readFile(join(memoryDir(root), memoryFiles[0]), "utf8");
    expect(memory).toContain("project: demo");
    expect(memory).toContain("fact: ctx_fact");
    await expect(readFile(join(sessionsDir(root), "nested-session.pos"), "utf8")).resolves.toBe("1\n");
    expect(existsSync(join(nested, ".nctx"))).toBe(false);
  });
});
