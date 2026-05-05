import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MCP_NAME = "nctx";
const MCP_TOOL_NAME = "nctx_memory";

export type McpScope = "local" | "project" | "user";

export type McpServerConfig = {
  type: "stdio";
  command: "nctx" | "npx";
  args: string[];
};

export type McpStatus = {
  registered: boolean;
  toolRegistered: boolean;
  source: "claude" | "plugin" | "none";
  details: string;
};

type ExecFileAsync = (
  file: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<{ stdout: string; stderr: string }>;

export function mcpServerConfig(packageName?: string): McpServerConfig {
  if (packageName) {
    return {
      type: "stdio",
      command: "npx",
      args: ["-y", packageName, "mcp"]
    };
  }
  return {
    type: "stdio",
    command: "nctx",
    args: ["mcp"]
  };
}

export async function registerMcpServer(options: {
  scope?: McpScope;
  packageName?: string;
} = {}): Promise<void> {
  const payload = JSON.stringify(mcpServerConfig(options.packageName));
  await execFileAsync("claude", ["mcp", "add-json", "--scope", options.scope ?? "local", MCP_NAME, payload]);
}

export async function unregisterMcpServer(options: { scope?: McpScope } = {}): Promise<void> {
  try {
    await execFileAsync("claude", ["mcp", "remove", "--scope", options.scope ?? "local", MCP_NAME]);
  } catch {
    // Idempotent uninstall: absence is success.
  }
}

export async function getMcpStatus(
  cwd = process.cwd(),
  options: { execFile?: ExecFileAsync; pluginRoot?: string | null } = {}
): Promise<McpStatus> {
  const pluginRoot = options.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? null;
  if (pluginRoot) {
    return getPluginMcpStatus(pluginRoot);
  }

  const run = options.execFile ?? runExecFile;
  try {
    const { stdout } = await run("claude", ["mcp", "list"], { cwd });
    return parseMcpListStatus(stdout);
  } catch (error) {
    return {
      registered: false,
      toolRegistered: false,
      source: "none",
      details: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runExecFile(
  file: string,
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
}

export function parseMcpListStatus(stdout: string): McpStatus {
  const details = stdout.trim();
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^(?:plugin:[^:\s]+:)?nctx(?::|\s)/.test(line.trim()));
  if (start === -1) {
    return {
      registered: false,
      toolRegistered: false,
      source: "none",
      details
    };
  }

  const blockLines = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    blockLines.push(line);
  }
  const block = blockLines.join("\n").trim();
  const connected = /\bConnected\b/.test(block) && !/Failed to connect/i.test(block);
  const hasTool = new RegExp(`\\b${MCP_TOOL_NAME}\\b`).test(block);

  return {
    registered: true,
    toolRegistered: connected || hasTool,
    source: "claude",
    details: block || details
  };
}

async function getPluginMcpStatus(pluginRoot: string): Promise<McpStatus> {
  const configPath = join(pluginRoot, ".mcp.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const server = isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers[MCP_NAME] : null;
    if (!isRecord(server)) {
      return missingPluginMcp(`Plugin MCP config has no ${MCP_NAME} server at ${configPath}`);
    }

    const args = Array.isArray(server.args) ? server.args : [];
    const hasMcpArg = args.some((arg) => arg === "mcp");
    const command = typeof server.command === "string" ? server.command : "";
    const configured = command.length > 0 && hasMcpArg;
    return {
      registered: configured,
      toolRegistered: configured,
      source: configured ? "plugin" : "none",
      details: configured
        ? `Plugin MCP config provides ${MCP_NAME} from ${configPath}`
        : `Plugin MCP config at ${configPath} does not run the ${MCP_NAME} MCP command`
    };
  } catch (error) {
    return missingPluginMcp(error instanceof Error ? error.message : String(error));
  }
}

function missingPluginMcp(details: string): McpStatus {
  return {
    registered: false,
    toolRegistered: false,
    source: "none",
    details
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
