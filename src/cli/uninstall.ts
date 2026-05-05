import { rm } from "node:fs/promises";
import { nctxDir } from "../lib/fs.js";
import { unregisterHooks } from "../config/hooks.js";
import { unregisterMcpServer } from "../config/mcp-register.js";

export async function runUninstall(cwd: string, removeData = false): Promise<void> {
  await unregisterHooks(cwd);
  await unregisterMcpServer();
  if (removeData) await rm(nctxDir(cwd), { recursive: true, force: true });
}

