import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { loadConfig } from "../../src/config/load.js";

const roots: string[] = [];
const OLD_TOKEN = "nctx_it_existing_token_that_is_long_enough_123";
const NEW_TOKEN = "nctx_it_explicit_token_that_is_long_enough_456";
const ROTATED_TOKEN = "nctx_it_rotated_token_that_is_long_enough_789";

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-init-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("init", () => {
  it("reuses an existing hosted config without minting a new install token", async () => {
    const root = await tempRoot();
    await runInit(root, {
      proxyUrl: "https://worker.example/",
      installToken: OLD_TOKEN,
      projectName: "demo",
      skipHooks: true,
      skipMcp: true
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("init should not register an install when config already exists");
    });

    await runInit(root, { skipHooks: true, skipMcp: true });

    await expect(loadConfig(root)).resolves.toMatchObject({
      install_token: OLD_TOKEN,
      proxy_url: "https://worker.example",
      project_name: "demo"
    });
  });

  it("replaces the token without registering when --install-token is explicit", async () => {
    const root = await tempRoot();
    await runInit(root, {
      proxyUrl: "https://worker.example",
      installToken: OLD_TOKEN,
      projectName: "demo",
      skipHooks: true,
      skipMcp: true
    });

    const fetchCalls: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(new Request(input, init));
      throw new Error("explicit install tokens should not call the Worker");
    });

    await runInit(root, { installToken: NEW_TOKEN, skipHooks: true, skipMcp: true });

    expect(fetchCalls).toHaveLength(0);
    await expect(loadConfig(root)).resolves.toMatchObject({
      install_token: NEW_TOKEN,
      proxy_url: "https://worker.example",
      project_name: "demo"
    });
  });

  it("mints a new token with the existing Worker URL when --rotate-token is set", async () => {
    const root = await tempRoot();
    await runInit(root, {
      proxyUrl: "https://worker.example",
      installToken: OLD_TOKEN,
      projectName: "demo",
      skipHooks: true,
      skipMcp: true
    });

    const fetchCalls: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(new Request(input, init));
      return Response.json({ install_token: ROTATED_TOKEN });
    });

    await runInit(root, {
      packageSecret: "package-secret",
      rotateToken: true,
      skipHooks: true,
      skipMcp: true
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://worker.example/installs");
    expect(fetchCalls[0].headers.get("x-nctx-package-secret")).toBe("package-secret");
    await expect(loadConfig(root)).resolves.toMatchObject({
      install_token: ROTATED_TOKEN,
      proxy_url: "https://worker.example",
      project_name: "demo"
    });
  });
});
