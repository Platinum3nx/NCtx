import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerHooks } from "../config/hooks.js";
import { registerMcpServer } from "../config/mcp-register.js";
import { createDirectConfig, ensureNctxDirs, findConfigPath, saveConfig, tryLoadConfig } from "../config/load.js";
import { ensureDir, memoryDir, nctxDir, pendingDir, sessionsDir } from "../lib/fs.js";
import { PACKAGE_NAME } from "../lib/constants.js";

type InitOptions = {
  niaApiKey?: string;
  niaBaseUrl?: string;
  projectName?: string;
  skipHooks?: boolean;
  skipMcp?: boolean;
  skipVerify?: boolean;
};

export type InitResult = {
  keyAction: "saved" | "reused" | "updated" | "migrated-to-direct";
};

export async function runInit(cwd: string, options: InitOptions): Promise<InitResult> {
  const existingConfig = await tryLoadConfig(cwd);
  const existingRaw = existingConfig ?? await readExistingConfigObject(cwd);

  await ensureNctxDirs(cwd);
  await ensureDir(nctxDir(cwd));
  await ensureDir(memoryDir(cwd));
  await ensureDir(pendingDir(cwd));
  await ensureDir(sessionsDir(cwd));

  const niaApiKey = await resolveNiaApiKey(options, existingConfig);
  const keyAction = keyActionFor(options.niaApiKey ?? process.env.NCTX_NIA_API_KEY ?? process.env.NIA_API_KEY, existingRaw);

  const config = createDirectConfig({
    niaApiKey,
    niaBaseUrl: options.niaBaseUrl ?? existingConfig?.nia_base_url ?? stringValue(existingRaw?.nia_base_url),
    projectName: options.projectName ?? existingConfig?.project_name ?? stringValue(existingRaw?.project_name) ?? projectNameFromCwd(cwd),
    projectRoot: cwd
  });
  await saveConfig(cwd, config);
  if (!options.skipHooks) await registerHooks(cwd);
  if (!options.skipMcp) await registerMcpServer({ packageName: PACKAGE_NAME });
  await ensureGitignore(cwd);
  return { keyAction };
}

async function resolveNiaApiKey(options: InitOptions, existingConfig: Awaited<ReturnType<typeof tryLoadConfig>>): Promise<string> {
  const explicit = firstNonBlank(options.niaApiKey, process.env.NCTX_NIA_API_KEY, process.env.NIA_API_KEY);
  if (explicit) return explicit;
  if (existingConfig?.nia_api_key) return existingConfig.nia_api_key;
  return promptForNiaApiKey();
}

function keyActionFor(explicitKey: string | undefined, existingRaw: Record<string, unknown> | null): InitResult["keyAction"] {
  if (existingRaw?.mode === "hosted") return "migrated-to-direct";
  if (!existingRaw) return "saved";
  return firstNonBlank(explicitKey) ? "updated" : "reused";
}

async function readExistingConfigObject(cwd: string): Promise<Record<string, unknown> | null> {
  const path = findConfigPath(cwd);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function promptForNiaApiKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Nia API key required. Set NCTX_NIA_API_KEY or pass --nia-api-key.");
  }

  const key = await readHiddenLine("Enter your Nia API key: ");
  if (!key.trim()) {
    throw new Error("Nia API key required. Set NCTX_NIA_API_KEY or pass --nia-api-key.");
  }
  return key.trim();
}

function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = "";
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Initialization cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdout.write(prompt);
    stdin.resume();
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.on("data", onData);
  });
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

function firstNonBlank(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value?.trim()) return value.trim();
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
