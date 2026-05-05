import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MCP_NAME = "nctx";

export type McpScope = "local" | "project" | "user";

export type McpServerConfig = {
  type: "stdio";
  command: "nctx" | "npx";
  args: string[];
};

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

export async function getMcpStatus(cwd = process.cwd()): Promise<{
  registered: boolean;
  details: string;
}> {
  try {
    const { stdout } = await execFileAsync("claude", ["mcp", "list"], { cwd });
    return {
      registered: new RegExp(`\\b${MCP_NAME}\\b`).test(stdout),
      details: stdout.trim()
    };
  } catch (error) {
    return {
      registered: false,
      details: error instanceof Error ? error.message : String(error)
    };
  }
}
