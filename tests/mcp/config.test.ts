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
  it("loads direct BYOK config for normal plugin retrieval", async () => {
    const root = await tempRoot();
    const configPath = path.join(root, ".nctx", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mode: "direct",
        nia_api_key: "nia_test_user_key_that_is_long_enough",
        nia_base_url: "https://apigcp.trynia.ai/v2",
        project_name: "demo",
        version: "0.2.0"
      }),
      "utf8"
    );

    expect(loadConfig(root)).toMatchObject({
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      project_name: "demo",
      config_path: configPath
    });
  });

  it("rejects direct MCP configs that still contain hosted Worker credentials", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      install_token: "nctx_it_old_hosted_token_that_is_long_enough",
      proxy_url: "https://worker.example",
      project_name: "demo",
      version: "0.2.0"
    });

    expect(() => loadConfig(root)).toThrow("direct mode must not contain hosted Worker credentials");
  });

  it("walks up from nested project directories", async () => {
    const root = await tempRoot();
    const nested = path.join(root, "packages", "app", "src");
    const configPath = path.join(root, ".nctx", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mode: "direct",
        nia_api_key: "nia_test_user_key_that_is_long_enough",
        nia_base_url: "https://apigcp.trynia.ai/v2",
        project_name: "demo",
        version: "0.2.0"
      }),
      "utf8"
    );

    expect(findConfigPath(nested)).toBe(configPath);
    expect(loadConfig(nested)).toMatchObject({
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      config_path: configPath
    });
  });

  it("reports missing config with MCP tool context", async () => {
    const root = await tempRoot();

    expect(() => loadConfig(root)).toThrow(
      "NCtx config not found. Run `nctx init` from this project before using nctx_memory."
    );
  });

  it("rejects remote plaintext HTTP Nia URLs", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "http://api.example",
      project_name: "demo",
      version: "0.2.0"
    });

    expect(() => loadConfig(root)).toThrow("remote plaintext HTTP is not allowed");
  });

  it("allows plaintext localhost development Nia URLs", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "http://127.0.0.1:8787/nctx",
      project_name: "demo",
      version: "0.2.0"
    });

    expect(loadConfig(root)).toMatchObject({
      nia_base_url: "http://127.0.0.1:8787/nctx"
    });
  });
});

async function writeConfig(root: string, config: Record<string, unknown>): Promise<void> {
  const configPath = path.join(root, ".nctx", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), "utf8");
}
