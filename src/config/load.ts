import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

export function findConfigPath(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    const candidate = configPath(current);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findProjectRoot(startDir: string): string | null {
  const path = findConfigPath(startDir);
  return path ? dirname(dirname(path)) : null;
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
  const path = findConfigPath(cwd);
  if (!path) {
    throw new Error(`NCtx config not found at ${configPath(cwd)} or any parent directory. Run nctx init first.`);
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
  await writeJson(configPath(cwd), config, { mode: 0o600 });
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
      if (!isAllowedProxyUrl(url)) {
        errors.push("proxy_url must use https except for localhost development");
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

function isAllowedProxyUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
