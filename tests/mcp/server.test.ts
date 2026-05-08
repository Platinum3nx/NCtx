import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ErrorCode, type CallToolRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeClient as makeMemoryClient, type NctxMemoryClient } from "../../src/mcp/client.js";
import type { NctxMcpConfig } from "../../src/mcp/config.js";
import { createCallToolHandler } from "../../src/mcp/server.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-mcp-server-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP server tool handler", () => {
  it("uses walk-up MCP config and the MCP memory client", async () => {
    const root = await tempRoot();
    const nested = path.join(root, "packages", "app");
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

    const requests: Request[] = [];
    const loadedConfigs: NctxMcpConfig[] = [];
    const handler = createCallToolHandler({
      cwd: () => nested,
      makeClient: (config) => {
        loadedConfigs.push(config);
        return makeMemoryClient(config, async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json({
            results: [
              {
                title: "Remembered decision",
                summary: "A useful project memory",
                tags: ["project:demo"],
                agent_source: "nctx-claude-code",
                relevance_score: 0.95,
                match_highlights: ["Use the MCP-specific client."]
              }
            ]
          });
        });
      }
    });

    const result = await handler(toolRequest({ query: "server wiring", limit: 3 }));

    expect(loadedConfigs).toHaveLength(1);
    expect(loadedConfigs[0].config_path).toBe(configPath);
    expect(requests[0].url).toBe(
      "https://apigcp.trynia.ai/v2/contexts/semantic-search?q=server+wiring&limit=3&include_highlights=true"
    );
    expect(textOf(result)).toContain("Remembered decision");
    expect(textOf(result)).toContain("1. Use the MCP-specific client.");
    expect(result.isError).toBeUndefined();
  });

  it("returns config, argument, and search failures as tool errors", async () => {
    const config: NctxMcpConfig = {
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      project_name: "demo",
      version: "0.2.0",
      config_path: "/tmp/demo/.nctx/config.json"
    };

    const searchFailure = createCallToolHandler({
      loadConfig: () => config,
      makeClient: () => ({
        async searchContexts() {
          throw new Error("NCtx memory search failed (401 Unauthorized): Invalid API key");
        }
      }),
      readConfigMtimeMs: () => 1
    });

    await expect(searchFailure(toolRequest({ query: " " }))).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "nctx_memory requires a query." }]
    });
    await expect(searchFailure(toolRequest({ query: "key issue" }))).resolves.toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "NCtx memory search failed (401 Unauthorized): Invalid API key"
        }
      ]
    });

    const missingConfig = createCallToolHandler({
      loadConfig: () => {
        throw new Error("NCtx config not found. Run nctx init first.");
      }
    });
    await expect(missingConfig(toolRequest({ query: "anything" }))).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "NCtx config not found. Run nctx init first." }]
    });
  });

  it("caches the MCP client until cwd or config mtime changes", async () => {
    const config: NctxMcpConfig = {
      mode: "direct",
      nia_api_key: "nia_test_user_key_that_is_long_enough",
      nia_base_url: "https://apigcp.trynia.ai/v2",
      project_name: "demo",
      version: "0.2.0",
      config_path: "/tmp/demo/.nctx/config.json"
    };
    const client: NctxMemoryClient = {
      searchContexts: vi.fn(async () => [])
    };
    let mtime = 1;
    const loadConfig = vi.fn(() => config);
    const makeClient = vi.fn(() => client);
    const handler = createCallToolHandler({
      cwd: () => "/tmp/demo/subdir",
      loadConfig,
      makeClient,
      readConfigMtimeMs: () => mtime
    });

    await handler(toolRequest({ query: "first" }));
    await handler(toolRequest({ query: "second" }));
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledTimes(1);

    mtime = 2;
    await handler(toolRequest({ query: "third" }));
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it("keeps unknown tools as protocol-level errors", async () => {
    const handler = createCallToolHandler();

    await expect(handler(toolRequest({ query: "x" }, "other_tool"))).rejects.toMatchObject({
      code: ErrorCode.InvalidParams
    });
    await expect(handler(toolRequest({ query: "x" }, "other_tool"))).rejects.toThrow("Unknown tool: other_tool");
  });
});

function toolRequest(args: unknown, name = "nctx_memory"): CallToolRequest {
  return {
    method: "tools/call",
    params: {
      name,
      arguments: args as Record<string, unknown>
    }
  };
}

function textOf(result: CallToolResult): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text tool result");
  return content.text;
}
