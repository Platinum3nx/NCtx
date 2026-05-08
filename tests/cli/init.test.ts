import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { loadConfig } from "../../src/config/load.js";

const roots: string[] = [];
const OLD_TOKEN = "nctx_it_existing_token_that_is_long_enough_123";

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
  it("initializes plugin mode as direct BYOK without contacting the hosted Worker", async () => {
    const root = await tempRoot();
    const fetchCalls: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(new Request(input, init));
      throw new Error("direct BYOK init must not register a hosted install");
    });

    const result = await runInit(root, {
      niaApiKey: "nia_test_user_key_that_is_long_enough",
      projectName: "demo",
      skipHooks: true,
      skipMcp: true
    } as any);

    expect(result).toMatchObject({ keyAction: "saved" });
    expect(fetchCalls).toHaveLength(0);
    const config = (await loadConfig(root)) as any;
    expect(config).toMatchObject({
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      project_name: "demo"
    });
    expect(config).not.toHaveProperty("install_token");
    expect(config).not.toHaveProperty("proxy_url");
  });

  it("migrates existing hosted config to direct BYOK without reusing the install token", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "hosted",
      install_token: OLD_TOKEN,
      proxy_url: "https://worker.example/",
      project_name: "demo",
      version: "0.1.0"
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("BYOK migration must not mint or rotate hosted tokens");
    });

    const result = await runInit(root, {
      niaApiKey: "nia_test_user_key_that_is_long_enough",
      skipHooks: true,
      skipMcp: true
    } as any);

    expect(result).toMatchObject({ keyAction: "migrated-to-direct" });
    const config = (await loadConfig(root)) as any;
    expect(config.mode).toBe("direct");
    expect(config).toMatchObject({
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      project_name: "demo"
    });
    expect(config).not.toHaveProperty("install_token");
    expect(config).not.toHaveProperty("proxy_url");
  });

  it("reuses an existing direct config without contacting the hosted Worker", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "direct",
      nia_api_key: "nia_test_existing_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      project_name: "demo",
      version: "0.2.0"
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("init should not register an install when config already exists");
    });

    await runInit(root, { skipHooks: true, skipMcp: true });

    await expect(loadConfig(root)).resolves.toMatchObject({
      mode: "direct",
      nia_api_key: "nia_test_existing_key_that_is_long_enough",
      project_name: "demo"
    });
  });

  it("replaces the Nia key without contacting the hosted Worker when --nia-api-key is explicit", async () => {
    const root = await tempRoot();
    await writeConfig(root, {
      mode: "direct",
      nia_api_key: "nia_test_existing_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      project_name: "demo",
      version: "0.2.0"
    });

    const fetchCalls: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(new Request(input, init));
      throw new Error("explicit Nia API keys should not call the Worker");
    });

    await runInit(root, {
      niaApiKey: "nia_test_replacement_key_that_is_long_enough",
      skipHooks: true,
      skipMcp: true
    } as any);

    expect(fetchCalls).toHaveLength(0);
    await expect(loadConfig(root)).resolves.toMatchObject({
      mode: "direct",
      nia_api_key: "nia_test_replacement_key_that_is_long_enough",
      project_name: "demo"
    });
  });

  it("uses NIA_API_KEY from the environment when no explicit key is provided", async () => {
    const root = await tempRoot();
    vi.stubEnv("NIA_API_KEY", "nia_test_env_key_that_is_long_enough");
    vi.stubGlobal("fetch", async () => {
      throw new Error("NIA_API_KEY init must not register a hosted install");
    });

    await runInit(root, {
      skipHooks: true,
      skipMcp: true
    } as any);

    await expect(loadConfig(root)).resolves.toMatchObject({
      mode: "direct",
      nia_api_key: "nia_test_env_key_that_is_long_enough"
    });
  });
});

async function writeConfig(root: string, config: Record<string, unknown>): Promise<void> {
  const configPath = path.join(root, ".nctx", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), "utf8");
}
