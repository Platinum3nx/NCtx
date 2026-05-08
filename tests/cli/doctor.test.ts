import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDirectNia } from "../../src/cli/doctor.js";
import { getMcpStatus, parseMcpListStatus } from "../../src/config/mcp-register.js";
import type { NctxConfig } from "../../src/types.js";

const roots: string[] = [];

const config: NctxConfig = {
  mode: "direct",
  nia_api_key: "nia_test_user_key_that_is_long_enough",
  nia_base_url: "https://apigcp.trynia.ai/v2",
  project_name: "demo",
  version: "0.1.0"
} as any;

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-doctor-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("doctor Nia checks", () => {
  it("runs a lightweight authenticated direct Nia project-scope probe", async () => {
    const requests: Request[] = [];

    const checks = await checkDirectNia(config, {
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          results: [
            {
              id: "ctx_1",
              agent_source: "nctx-claude-code",
              tags: ["project:demo"]
            }
          ]
        });
      }
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Nia reachable", true],
      ["Nia search response", true],
      ["Nia project result scope", true]
    ]);
    expect(requests).toHaveLength(1);
    const request = requests[0] as Request;
    expect(request.url).toBe(
      "https://apigcp.trynia.ai/v2/contexts/semantic-search?q=__nctx_doctor_probe__&limit=1&include_highlights=false"
    );
    expect(request.headers.get("Authorization")).toBe(`Bearer ${config.nia_api_key}`);
  });

  it("flags a live probe response that is not scoped to the direct project", async () => {
    const checks = await checkDirectNia(config, {
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "ctx_foreign",
              agent_source: "other-agent",
              tags: ["project:demo"]
            }
          ]
        })
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Nia reachable", true],
      ["Nia search response", true],
      ["Nia project result scope", false]
    ]);
  });

  it("does not claim project result scope when the probe returns no results", async () => {
    const checks = await checkDirectNia(config, {
      fetchImpl: async () => Response.json({ results: [] })
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Nia reachable", true],
      ["Nia search response", true]
    ]);
  });
});

describe("doctor MCP checks", () => {
  it("requires the nctx MCP entry to be present and connected", () => {
    expect(
      parseMcpListStatus(
        [
          "nia: pipx run --no-cache nia-mcp-server - \u2713 Connected",
          "nctx: npx -y @platinum3nx/nctx mcp - \u2713 Connected"
        ].join("\n")
      )
    ).toMatchObject({
      registered: true,
      toolRegistered: true,
      source: "claude"
    });

    expect(parseMcpListStatus("nia: pipx run --no-cache nia-mcp-server - \u2713 Connected")).toMatchObject({
      registered: false,
      toolRegistered: false
    });

    expect(
      parseMcpListStatus("plugin:nctx:nctx: node /plugin/dist/cli/index.js mcp - \u2717 Failed to connect")
    ).toMatchObject({
        registered: true,
        toolRegistered: false
      });
  });

  it("accepts plugin-supplied MCP config without requiring local Claude MCP registration", async () => {
    const root = await tempRoot();
    const pluginRoot = path.join(root, "plugin");
    const cliDir = path.join(pluginRoot, "dist", "cli");
    await mkdir(cliDir, { recursive: true });
    await writeFile(path.join(cliDir, "index.js"), "// stub", "utf8");
    await writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          nctx: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js", "mcp"]
          }
        }
      }),
      "utf8"
    );

    await expect(
      getMcpStatus(root, {
        pluginRoot,
        execFile: async () => {
          throw new Error("claude mcp list should not be needed in plugin mode");
        }
      })
    ).resolves.toMatchObject({
      registered: true,
      toolRegistered: true,
      source: "plugin"
    });
  });

  it("reports toolRegistered false when plugin MCP config points to a missing CLI entry point", async () => {
    const root = await tempRoot();
    const pluginRoot = path.join(root, "plugin");
    await mkdir(pluginRoot, { recursive: true });
    // Write .mcp.json but do NOT create the dist/cli/index.js file
    await writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          nctx: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js", "mcp"]
          }
        }
      }),
      "utf8"
    );

    const status = await getMcpStatus(root, {
      pluginRoot,
      execFile: async () => {
        throw new Error("claude mcp list should not be needed in plugin mode");
      }
    });

    expect(status).toMatchObject({
      registered: true,
      toolRegistered: false,
      source: "plugin"
    });
    expect(status.details).toContain("CLI entry point not found");
  });
});
