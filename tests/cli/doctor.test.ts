import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHostedWorker } from "../../src/cli/doctor.js";
import { getMcpStatus, parseMcpListStatus } from "../../src/config/mcp-register.js";
import type { NctxConfig } from "../../src/types.js";

const roots: string[] = [];

const config: NctxConfig = {
  mode: "hosted",
  install_token: "nctx_it_test_token_that_is_long_enough",
  proxy_url: "https://worker.example/",
  project_name: "demo",
  version: "0.1.0"
};

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nctx-doctor-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("doctor Worker checks", () => {
  it("runs a lightweight authenticated Worker isolation probe", async () => {
    const requests: Request[] = [];

    const checks = await checkHostedWorker(config, {
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          results: [
            {
              id: "ctx_1",
              agent_source: "nctx-claude-code",
              tags: ["install:server"]
            }
          ]
        });
      }
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Worker reachable", true],
      ["hosted search response", true],
      ["hosted result isolation", true]
    ]);
    expect(requests).toHaveLength(1);
    const request = requests[0] as Request;
    expect(request.url).toBe(
      "https://worker.example/contexts/semantic-search?q=__nctx_doctor_probe__&limit=1&include_highlights=false"
    );
    expect(request.headers.get("Authorization")).toBe(`Bearer ${config.install_token}`);
  });

  it("flags a live probe response that is not isolated to the hosted agent source", async () => {
    const checks = await checkHostedWorker(config, {
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "ctx_foreign",
              agent_source: "other-agent",
              tags: ["install:server"]
            }
          ]
        })
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Worker reachable", true],
      ["hosted search response", true],
      ["hosted result isolation", false]
    ]);
  });

  it("does not claim hosted result isolation when the probe returns no results", async () => {
    const checks = await checkHostedWorker(config, {
      fetchImpl: async () => Response.json({ results: [] })
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Worker reachable", true],
      ["hosted search response", true]
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
    await mkdir(pluginRoot, { recursive: true });
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
});
