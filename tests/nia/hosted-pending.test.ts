import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedConfig, saveConfig } from "../../src/config/load.js";
import { readMemoryFrontmatter, runReindex } from "../../src/cli/reindex.js";
import { memoryDir, pendingDir } from "../../src/lib/fs.js";
import { HostedNiaClient, registerHostedInstall } from "../../src/nia/hosted.js";
import { normalizeSearchResult } from "../../src/nia/client.js";
import { drainPendingContexts, enqueuePendingContext, listPendingContexts, queuePending } from "../../src/lib/pending.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-nia-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hosted Nia client", () => {
  it("registers installs through the Worker package guard header", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ install_token: "nctx_it_hosted_install_token_long_enough" });
    };

    const response = await registerHostedInstall({
      proxyUrl: "https://worker.example/",
      packageSecret: "package-secret",
      fetchImpl
    });

    expect(response.install_token).toBe("nctx_it_hosted_install_token_long_enough");
    expect(calls[0].url).toBe("https://worker.example/installs");
    expect(calls[0].headers.get("x-nctx-package-secret")).toBe("package-secret");
  });

  it("uses bearer install token and strips caller-supplied install tags", async () => {
    let captured: Request | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        id: "ctx_123",
        tags: ["project:demo", "install:server-side"],
        agent_source: "nctx-claude-code"
      });
    };
    const client = new HostedNiaClient(
      createHostedConfig({
        installToken: "nctx_it_hosted_install_token_long_enough",
        proxyUrl: "https://worker.example/",
        projectRoot: "/tmp/demo"
      }),
      fetchImpl
    );

    await client.saveContext({
      title: "Title",
      summary: "A summary long enough",
      content: "This content is long enough to satisfy the hosted request shape.",
      tags: ["install:spoofed", "project:demo"],
      memory_type: "fact",
      metadata: { install_id: "spoofed" }
    });

    const request = captured as Request | null;
    expect(request).not.toBeNull();
    if (!request) throw new Error("fetch was not called");
    expect(request.headers.get("Authorization")).toBe("Bearer nctx_it_hosted_install_token_long_enough");
    const body = JSON.parse(await request.text());
    expect(body.tags).toEqual(["project:demo"]);
    expect(body.metadata).not.toHaveProperty("install_id");
  });

  it("times out stalled Worker saves", async () => {
    const fetchImpl: typeof fetch = async () => new Promise<Response>(() => {});
    const client = new HostedNiaClient(
      createHostedConfig({
        installToken: "nctx_it_hosted_install_token_long_enough",
        proxyUrl: "https://worker.example/",
        projectRoot: "/tmp/demo"
      }),
      fetchImpl,
      10
    );

    await expect(
      client.saveContext({
        title: "Title",
        summary: "A summary long enough",
        content: "This content is long enough to satisfy the hosted request shape.",
        tags: ["project:demo"],
        memory_type: "fact",
        metadata: {}
      })
    ).rejects.toThrow("Worker save timed out");
  });

  it("normalizes current and legacy semantic search fields", () => {
    expect(
      normalizeSearchResult({
        id: "ctx",
        title: "Memory",
        relevance_score: 0.8,
        match_highlights: ["current"],
        tags: ["a"]
      })
    ).toMatchObject({ score: 0.8, highlights: ["current"], tags: ["a"] });

    expect(
      normalizeSearchResult({
        id: "ctx",
        title: "Memory",
        score: 0.4,
        highlights: ["legacy"]
      })
    ).toMatchObject({ score: 0.4, highlights: ["legacy"] });
  });
});

describe("pending queue", () => {
  it("queues failed context writes and drains them with a client", async () => {
    const root = await tempRoot();
    const filePath = await enqueuePendingContext(root, {
      captureId: "capture:1",
      memoryType: "episodic",
      request: {
        title: "Queued",
        summary: "Queued request",
        content: "Queued content that is long enough for the pending queue test.",
        memory_type: "episodic"
      },
      error: new Error("network down")
    });

    expect(JSON.parse(await readFile(filePath, "utf8")).last_error).toBe("network down");
    expect(await listPendingContexts(root)).toHaveLength(1);

    const drained = await drainPendingContexts(root, {
      async saveContext(request) {
        return { id: `ctx_${request.memory_type}` };
      },
      async searchContexts() {
        return [];
      }
    });

    expect(drained.saved).toHaveLength(1);
    expect(await listPendingContexts(root)).toHaveLength(0);
  });

  it("keeps same-capture sibling pending files when one memory type still fails", async () => {
    const root = await tempRoot();
    await enqueuePendingContext(root, {
      captureId: "capture:shared",
      memoryType: "fact",
      request: {
        title: "Fact",
        summary: "Fact request",
        content: "Fact content that is long enough for the pending queue test.",
        memory_type: "fact"
      }
    });
    await enqueuePendingContext(root, {
      captureId: "capture:shared",
      memoryType: "procedural",
      request: {
        title: "Pattern",
        summary: "Pattern request",
        content: "Pattern content that is long enough for the pending queue test.",
        memory_type: "procedural"
      }
    });

    const drained = await drainPendingContexts(root, {
      async saveContext(request) {
        if (request.memory_type === "procedural") throw new Error("still down");
        return { id: `ctx_${request.memory_type}` };
      },
      async searchContexts() {
        return [];
      }
    });

    expect(drained.saved).toHaveLength(1);
    expect(drained.failed).toHaveLength(1);
    const remaining = await listPendingContexts(root);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].draft.memory_type).toBe("procedural");
  });

  it("continues draining valid pending files when one pending file is corrupt", async () => {
    const root = await tempRoot();
    await enqueuePendingContext(root, {
      captureId: "capture:good",
      memoryType: "fact",
      request: {
        title: "Good",
        summary: "Good request",
        content: "Good content that is long enough for the pending queue test.",
        memory_type: "fact"
      }
    });
    const corruptPath = path.join(pendingDir(root), "capture-corrupt.fact.json");
    await writeFile(corruptPath, "{not-json", "utf8");

    expect(await listPendingContexts(root)).toHaveLength(1);
    const drained = await drainPendingContexts(root, {
      async saveContext(request) {
        return { id: `ctx_${request.memory_type}` };
      },
      async searchContexts() {
        return [];
      }
    });

    expect(drained.saved).toHaveLength(1);
    expect(drained.failed).toHaveLength(1);
    expect(path.basename(drained.failed[0].file_path)).toBe("capture-corrupt.fact.json");
    await expect(readFile(corruptPath, "utf8")).resolves.toBe("{not-json");
    expect(await listPendingContexts(root)).toHaveLength(0);
  });

  it("serializes concurrent drains so one pending file is saved once", async () => {
    const root = await tempRoot();
    await enqueuePendingContext(root, {
      captureId: "capture:serialized",
      memoryType: "episodic",
      request: {
        title: "Serialized",
        summary: "Serialized request",
        content: "Serialized content that is long enough for the pending queue test.",
        memory_type: "episodic"
      }
    });
    let releaseFirst!: () => void;
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let saves = 0;
    const client = {
      async saveContext(request: any) {
        saves += 1;
        firstStarted();
        await releaseFirstPromise;
        return { id: `ctx_${request.memory_type}` };
      },
      async searchContexts() {
        return [];
      }
    };

    const first = drainPendingContexts(root, client);
    await firstSaveStarted;
    const second = drainPendingContexts(root, client);
    await sleep(30);

    expect(saves).toBe(1);
    releaseFirst();
    const results = await Promise.all([first, second]);

    expect(results.flatMap((result) => result.saved)).toHaveLength(1);
    expect(saves).toBe(1);
    expect(await listPendingContexts(root)).toHaveLength(0);
  });

  it("reindexes local memory files and backfills per-memory-type context ids", async () => {
    const root = await tempRoot();
    const nested = path.join(root, "packages", "app");
    await saveConfig(
      root,
      createHostedConfig({
        installToken: "nctx_it_hosted_install_token_long_enough",
        proxyUrl: "https://worker.example",
        projectName: "demo",
        projectRoot: root
      })
    );

    await mkdir(nested, { recursive: true });
    await mkdir(memoryDir(root), { recursive: true });
    const memoryPath = path.join(memoryDir(root), "capture-1.md");
    await writeFile(
      memoryPath,
      [
        "---",
        'id: "capture-1"',
        "context_ids:",
        'session_id: "session-1"',
        'trigger: "session-end"',
        'project: "demo"',
        'files_touched: ["src/app.ts"]',
        'tags: ["project:demo", "install:spoofed"]',
        'memory_types: ["fact", "procedural", "episodic"]',
        'summary: "Demo memory"',
        "---",
        "",
        "## Decision: Keep local-first durability",
        "",
        "The hook writes markdown before remote saves.",
        "",
        "## Pattern: Isolate install tags",
        "",
        "The Worker owns the install tag boundary.",
        "",
        "## State",
        "",
        "In progress: finishing reindex."
      ].join("\n"),
      "utf8"
    );

    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({ id: `ctx_${body.memory_type}` });
    });

    await runReindex(nested);

    expect(bodies.map((body) => body.memory_type)).toEqual(["fact", "procedural", "episodic"]);
    expect(bodies.flatMap((body) => body.tags)).not.toContain("install:spoofed");
    const frontmatter = await readMemoryFrontmatter(memoryPath);
    expect(frontmatter.context_ids).toEqual({
      fact: "ctx_fact",
      procedural: "ctx_procedural",
      episodic: "ctx_episodic"
    });

    bodies.length = 0;
    await runReindex(root);
    expect(bodies).toHaveLength(0);
  });

  it("backfills memory frontmatter when reindex drains queued pending contexts", async () => {
    const root = await tempRoot();
    await saveConfig(
      root,
      createHostedConfig({
        installToken: "nctx_it_hosted_install_token_long_enough",
        proxyUrl: "https://worker.example",
        projectName: "demo",
        projectRoot: root
      })
    );
    await mkdir(memoryDir(root), { recursive: true });
    const memoryPath = path.join(memoryDir(root), "capture-pending.md");
    await writeFile(
      memoryPath,
      [
        "---",
        'id: "capture-pending"',
        "context_ids:",
        'session_id: "session-1"',
        'trigger: "session-end"',
        'project: "demo"',
        "files_touched: []",
        'tags: ["project:demo"]',
        'memory_types: ["fact"]',
        'summary: "Pending memory"',
        "---",
        "",
        "## Decision: Pending fact",
        "",
        "Pending-only memory."
      ].join("\n"),
      "utf8"
    );
    await queuePending(
      root,
      "capture-pending",
      {
        title: "Pending fact",
        summary: "Pending fact",
        content: "Pending fact content that is long enough for Nia.",
        tags: ["project:demo"],
        memory_type: "fact",
        metadata: {}
      },
      { memoryPath }
    );

    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({ id: `ctx_${body.memory_type}` });
    });

    await runReindex(root);

    expect(bodies.map((body) => body.memory_type)).toEqual(["fact"]);
    expect(await listPendingContexts(root)).toHaveLength(0);
    const frontmatter = await readMemoryFrontmatter(memoryPath);
    expect(frontmatter.context_ids).toEqual({ fact: "ctx_fact" });
  });

  it("backfills successful reindex saves and queues failed memory types", async () => {
    const root = await tempRoot();
    await saveConfig(
      root,
      createHostedConfig({
        installToken: "nctx_it_hosted_install_token_long_enough",
        proxyUrl: "https://worker.example",
        projectName: "demo",
        projectRoot: root
      })
    );
    await mkdir(memoryDir(root), { recursive: true });
    const memoryPath = path.join(memoryDir(root), "capture-partial.md");
    await writeFile(
      memoryPath,
      [
        "---",
        'id: "capture-partial"',
        "context_ids:",
        'session_id: "session-1"',
        'trigger: "session-end"',
        'project: "demo"',
        'files_touched: ["src/app.ts"]',
        'tags: ["project:demo"]',
        'memory_types: ["fact", "procedural"]',
        'summary: "Partial memory"',
        "---",
        "",
        "## Decision: Keep successes",
        "",
        "Successful reindex saves should be backfilled.",
        "",
        "## Pattern: Queue failures",
        "",
        "Failed memory types should stay pending."
      ].join("\n"),
      "utf8"
    );

    const firstBodies: any[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      firstBodies.push(body);
      if (body.memory_type === "procedural") {
        return new Response("temporarily down", { status: 503 });
      }
      return Response.json({ id: `ctx_${body.memory_type}` });
    });

    await runReindex(root);

    expect(firstBodies.map((body) => body.memory_type)).toEqual(["fact", "procedural"]);
    let frontmatter = await readMemoryFrontmatter(memoryPath);
    expect(frontmatter.context_ids).toEqual({ fact: "ctx_fact" });
    let remaining = await listPendingContexts(root);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: "capture-partial",
      memory_path: memoryPath,
      draft: { memory_type: "procedural" }
    });

    const secondBodies: any[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      secondBodies.push(body);
      return Response.json({ id: `ctx_${body.memory_type}` });
    });

    await runReindex(root);

    expect(secondBodies.map((body) => body.memory_type)).toEqual(["procedural"]);
    remaining = await listPendingContexts(root);
    expect(remaining).toHaveLength(0);
    frontmatter = await readMemoryFrontmatter(memoryPath);
    expect(frontmatter.context_ids).toEqual({ fact: "ctx_fact", procedural: "ctx_procedural" });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
