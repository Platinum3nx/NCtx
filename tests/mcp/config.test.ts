import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findConfigPath, loadConfig } from "../../src/mcp/config.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-mcp-config-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP config loading", () => {
  it("walks up from nested project directories", async () => {
    const root = await tempRoot();
    const nested = path.join(root, "packages", "app", "src");
    const configPath = path.join(root, ".nctx", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mode: "hosted",
        install_token: "nctx_it_test_token",
        proxy_url: "https://worker.example",
        project_name: "demo",
        version: "0.1.0"
      }),
      "utf8"
    );

    expect(findConfigPath(nested)).toBe(configPath);
    expect(loadConfig(nested)).toMatchObject({
      mode: "hosted",
      install_token: "nctx_it_test_token",
      proxy_url: "https://worker.example",
      config_path: configPath
    });
  });

  it("reports missing config with MCP tool context", async () => {
    const root = await tempRoot();

    expect(() => loadConfig(root)).toThrow(
      "NCtx config not found. Run `nctx init` from this project before using nctx_memory."
    );
  });

  it("rejects remote plaintext HTTP proxy URLs", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "hosted",
      install_token: "nctx_it_test_token",
      proxy_url: "http://worker.example",
      project_name: "demo"
    });

    expect(() => loadConfig(root)).toThrow("remote plaintext HTTP is not allowed");
  });

  it("allows plaintext localhost development proxy URLs", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "hosted",
      install_token: "nctx_it_test_token",
      proxy_url: "http://127.0.0.1:8787/nctx",
      project_name: "demo"
    });

    expect(loadConfig(root)).toMatchObject({
      proxy_url: "http://127.0.0.1:8787/nctx"
    });
  });
});

async function writeConfig(root: string, config: Record<string, unknown>): Promise<void> {
  const configPath = path.join(root, ".nctx", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), "utf8");
}
