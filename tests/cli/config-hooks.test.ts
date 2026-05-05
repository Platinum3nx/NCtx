import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPath,
  createHostedConfig,
  loadConfig,
  saveConfig,
  validateConfig
} from "../../src/config/load.js";
import { getHooksStatus, registerHooks, unregisterHooks } from "../../src/config/hooks.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-cli-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("config load/save", () => {
  it("writes hosted config without trusted server secrets", async () => {
    const root = await tempRoot();
    const config = createHostedConfig({
      installToken: "nctx_it_test_token_that_is_long_enough",
      proxyUrl: "http://127.0.0.1:8787/",
      projectRoot: root
    });

    await saveConfig(root, config);

    const raw = await readFile(configPath(root), "utf8");
    expect(raw).not.toContain("shared_secret");
    expect(raw).not.toContain("install_id");
    expect(raw).not.toContain("nia_api_key");
    await expect(loadConfig(root)).resolves.toMatchObject({
      mode: "hosted",
      install_token: "nctx_it_test_token_that_is_long_enough",
      proxy_url: "http://127.0.0.1:8787"
    });
  });

  it("rejects hosted configs that leak install id or Nia keys", () => {
    const result = validateConfig({
      mode: "hosted",
      install_token: "nctx_it_test_token_that_is_long_enough",
      proxy_url: "https://example.com",
      project_name: "demo",
      version: "0.1.0",
      install_id: "server-side-only",
      nia_api_key: "nk_secret"
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("install_id");
    expect(result.errors.join(" ")).toContain("nia_api_key");
  });
});

describe("Claude hook registration", () => {
  it("adds guarded async hooks idempotently while preserving unrelated hooks", async () => {
    const root = await tempRoot();
    const settingsPath = path.join(root, ".claude", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: "echo keep-me" }] }]
        }
      }),
      "utf8"
    );

    await registerHooks(root);
    await registerHooks(root);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const sessionEndCommands = settings.hooks.SessionEnd.flatMap((group: any) =>
      group.hooks.map((hook: any) => hook.command)
    );

    expect(sessionEndCommands.filter((command: string) => command.includes("nctx capture"))).toHaveLength(1);
    expect(sessionEndCommands).toContain("echo keep-me");

    const status = await getHooksStatus(root);
    expect(status.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "SessionEnd",
          registered: true,
          hasRecursionGuard: true,
          isAsync: true,
          timeoutSeconds: 60
        }),
        expect.objectContaining({
          event: "PreCompact",
          registered: true,
          hasRecursionGuard: true
        })
      ])
    );
  });

  it("removes only NCtx hook commands", async () => {
    const root = await tempRoot();
    await registerHooks(root);
    await unregisterHooks(root);

    const status = await getHooksStatus(root);
    expect(status.events.every((event) => !event.registered)).toBe(true);
  });
});
