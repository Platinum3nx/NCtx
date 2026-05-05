import { runMcpServer } from "../mcp/server.js";

export async function runMcpCommand(): Promise<void> {
  await runMcpServer();
}
