import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DirectNctxConfig, HostedNctxConfig, NctxConfig } from "../types.js";
import { memoryDir, nctxDir, pendingDir, readJson, sessionsDir, spoolDir, writeJson, ensureDir } from "../lib/fs.js";
import { DEFAULT_NIA_BASE_URL } from "../lib/constants.js";

export type ConfigValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const FORBIDDEN_DIRECT_CONFIG_KEYS = new Set([
  "shared_secret",
  "package_secret",
  "nia_key",
  "install_token",
  "install_id",
  "proxy_url"
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
  await Promise.all([
    ensureDir(memoryDir(cwd)),
    ensureDir(pendingDir(cwd)),
    ensureDir(spoolDir(cwd)),
    ensureDir(sessionsDir(cwd))
  ]);
}

export function defaultProjectName(cwd: string): string {
  return basename(resolve(cwd)) || "project";
}

export function createHostedConfig(input: {
  installToken: string;
  proxyUrl: string;
  projectName?: string;
  projectRoot: string;
}): HostedNctxConfig {
  return {
    mode: "hosted",
    install_token: input.installToken,
    proxy_url: input.proxyUrl.replace(/\/+$/, ""),
    project_name: input.projectName ?? defaultProjectName(input.projectRoot),
    version: "0.1.0"
  };
}

export function createDirectConfig(input: {
  niaApiKey: string;
  niaBaseUrl?: string;
  projectName?: string;
  projectRoot: string;
}): DirectNctxConfig {
  return {
    mode: "direct",
    nia_api_key: input.niaApiKey.trim(),
    nia_base_url: (input.niaBaseUrl ?? DEFAULT_NIA_BASE_URL).replace(/\/+$/, ""),
    project_name: input.projectName ?? defaultProjectName(input.projectRoot),
    version: "0.2.0"
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

  if (value.mode === "hosted") {
    errors.push("hosted config is no longer supported. Re-run `nctx init --plugin --nia-api-key <key>` to use BYOK direct mode.");
  } else if (value.mode === "byok") {
    errors.push("mode must be \"direct\". Re-run `nctx init --plugin --nia-api-key <key>` to refresh this config.");
  } else if (value.mode === "direct") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_DIRECT_CONFIG_KEYS.has(key)) {
        errors.push(`direct config must not contain ${key}`);
      }
    }
    validateDirectConfig(value, errors);
  } else {
    errors.push(`Unsupported NCtx mode: ${String(value.mode)}`);
  }

  if (typeof value.project_name !== "string" || !value.project_name.trim()) {
    errors.push("missing project_name");
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    errors.push("missing version");
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateDirectConfig(value: Record<string, unknown>, errors: string[]): void {
  if (typeof value.nia_api_key !== "string" || value.nia_api_key.trim().length < 8) {
    errors.push("missing nia_api_key or key is too short");
  }

  if (typeof value.nia_base_url !== "string" || value.nia_base_url.trim() === "") {
    errors.push("nia_base_url must be a valid URL");
  } else {
    validateServiceUrl(value.nia_base_url, "nia_base_url", errors);
  }
}

function validateServiceUrl(rawUrl: string, label: string, errors: string[]): void {
  try {
    const url = new URL(rawUrl);
    if (!isAllowedServiceUrl(url)) {
      errors.push(`${label} must use https except for localhost development`);
    }
  } catch {
    errors.push(`${label} must be a valid URL`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedServiceUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
