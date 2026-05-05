import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registerHooks } from "../config/hooks.js";
import { registerMcpServer } from "../config/mcp-register.js";
import { createHostedConfig, ensureNctxDirs, saveConfig } from "../config/load.js";
import { ensureDir, memoryDir, nctxDir, pendingDir, sessionsDir } from "../lib/fs.js";
import { DEFAULT_PROXY_URL, PACKAGE_NAME, PACKAGE_SHARED_SECRET } from "../lib/constants.js";
import { registerHostedInstall } from "../nia/hosted.js";
import type { NctxConfig } from "../types.js";

type InitOptions = {
  proxyUrl?: string;
  packageSecret?: string;
  installToken?: string;
  projectName?: string;
  skipHooks?: boolean;
  skipMcp?: boolean;
  skipVerify?: boolean;
};

export async function runInit(cwd: string, options: InitOptions): Promise<void> {
  const proxyUrl = options.proxyUrl ?? process.env.NCTX_PROXY_URL ?? DEFAULT_PROXY_URL;
  const packageSecret =
    options.packageSecret ??
    process.env.NCTX_PACKAGE_SHARED_SECRET ??
    process.env.PACKAGE_SHARED_SECRET ??
    PACKAGE_SHARED_SECRET;

  await ensureNctxDirs(cwd);
  await ensureDir(nctxDir(cwd));
  await ensureDir(memoryDir(cwd));
  await ensureDir(pendingDir(cwd));
  await ensureDir(sessionsDir(cwd));

  const installToken = options.installToken ?? (await mintInstall(proxyUrl, packageSecret));
  const config: NctxConfig = createHostedConfig({
    installToken,
    proxyUrl,
    projectName: options.projectName ?? projectNameFromCwd(cwd),
    projectRoot: cwd
  });
  await saveConfig(cwd, config);
  if (!options.skipHooks) await registerHooks(cwd);
  if (!options.skipMcp) await registerMcpServer({ packageName: PACKAGE_NAME });
  await ensureGitignore(cwd);
}

async function mintInstall(proxyUrl: string, packageSecret: string): Promise<string> {
  return (await registerHostedInstall({ proxyUrl, packageSecret })).install_token;
}

async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) {
    await mkdir(cwd, { recursive: true });
    await appendFile(path, ".nctx/\n", "utf8");
    return;
  }
  const fs = await import("node:fs/promises");
  const existing = await fs.readFile(path, "utf8");
  if (!existing.split(/\r?\n/).includes(".nctx/")) {
    await appendFile(path, `${existing.endsWith("\n") ? "" : "\n"}.nctx/\n`, "utf8");
  }
}

function projectNameFromCwd(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
}
