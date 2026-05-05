import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { NctxConfig } from "../types.js";
import { memoryDir, nctxDir, pendingDir, readJson, sessionsDir, writeJson, ensureDir } from "../lib/fs.js";

export type ConfigValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const FORBIDDEN_HOSTED_CONFIG_KEYS = new Set([
  "shared_secret",
  "nia_key",
  "nia_api_key",
  "install_id"
]);

export function configPath(cwd: string): string {
  return join(nctxDir(cwd), "config.json");
}

export function memoriesDir(cwd: string): string {
  return memoryDir(cwd);
}

export function pendingContextsDir(cwd: string): string {
  return pendingDir(cwd);
}

export function sessionsCursorDir(cwd: string): string {
  return sessionsDir(cwd);
}

export async function ensureNctxDirs(cwd: string): Promise<void> {
  await Promise.all([ensureDir(memoryDir(cwd)), ensureDir(pendingDir(cwd)), ensureDir(sessionsDir(cwd))]);
}

export function defaultProjectName(cwd: string): string {
  return basename(resolve(cwd)) || "project";
}

export function createHostedConfig(input: {
  installToken: string;
  proxyUrl: string;
  projectName?: string;
  projectRoot: string;
}): NctxConfig {
  return {
    mode: "hosted",
    install_token: input.installToken,
    proxy_url: input.proxyUrl.replace(/\/+$/, ""),
    project_name: input.projectName ?? defaultProjectName(input.projectRoot),
    version: "0.1.0"
  };
}

export async function loadConfig(cwd = process.cwd()): Promise<NctxConfig> {
  const path = configPath(cwd);
  if (!existsSync(path)) {
    throw new Error(`NCtx config not found at ${path}. Run nctx init first.`);
  }
  const config = await readJson<NctxConfig>(path);
  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(`Invalid NCtx config: ${validation.errors.join("; ")}`);
  }
  return config;
}

export async function tryLoadConfig(cwd = process.cwd()): Promise<NctxConfig | null> {
  try {
    return await loadConfig(cwd);
  } catch {
    return null;
  }
}

export async function saveConfig(cwd: string, config: NctxConfig): Promise<void> {
  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(`Invalid NCtx config: ${validation.errors.join("; ")}`);
  }
  await ensureNctxDirs(cwd);
  await writeJson(configPath(cwd), config);
}

export function validateConfig(value: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ["config must be a JSON object"], warnings };
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_HOSTED_CONFIG_KEYS.has(key)) {
      errors.push(`hosted config must not contain ${key}`);
    }
  }

  if (value.mode !== "hosted") {
    errors.push(`Unsupported NCtx mode: ${String(value.mode)}`);
  }
  if (typeof value.install_token !== "string" || value.install_token.length < 20) {
    errors.push("missing install_token or token is too short");
  }
  if (typeof value.proxy_url !== "string" || value.proxy_url.trim() === "") {
    errors.push("missing proxy_url");
  } else {
    try {
      const url = new URL(value.proxy_url);
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        warnings.push("proxy_url is not https");
      }
    } catch {
      errors.push("proxy_url must be a valid URL");
    }
  }
  if (typeof value.project_name !== "string" || !value.project_name.trim()) {
    errors.push("missing project_name");
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    errors.push("missing version");
  }

  return { ok: errors.length === 0, errors, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
