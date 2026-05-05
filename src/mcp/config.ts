import { readFileSync } from "node:fs";
import { findConfigPath } from "../config/load.js";

export interface NctxMcpConfig {
  mode: "hosted";
  install_token: string;
  proxy_url: string;
  project_name?: string;
  version?: string;
  config_path: string;
}

type JsonObject = Record<string, unknown>;
export { findConfigPath };

export function loadConfig(projectDir = process.cwd()): NctxMcpConfig {
  const configPath = findConfigPath(projectDir);
  if (!configPath) {
    throw new Error(
      "NCtx config not found. Run `nctx init` from this project before using nctx_memory."
    );
  }

  const parsed = parseConfig(readFileSync(configPath, "utf8"), configPath);
  if (parsed.mode !== "hosted") {
    throw new Error(`Unsupported NCtx mode ${String(parsed.mode)}. v4 MCP retrieval supports hosted mode only.`);
  }

  const installToken = readRequiredString(parsed, "install_token", configPath);
  const proxyUrl = validateProxyUrl(readRequiredString(parsed, "proxy_url", configPath), configPath);

  return {
    mode: "hosted",
    install_token: installToken,
    proxy_url: proxyUrl,
    project_name: readOptionalString(parsed, "project_name"),
    version: readOptionalString(parsed, "version"),
    config_path: configPath
  };
}

function parseConfig(raw: string, configPath: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      throw new Error("config must be a JSON object");
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read NCtx config at ${configPath}: ${detail}`);
  }
}

function readRequiredString(config: JsonObject, key: string, configPath: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required ${key} in ${configPath}`);
  }
  return value.trim();
}

function readOptionalString(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProxyUrl(proxyUrl: string, configPath: string): string {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new Error(`Invalid proxy_url in ${configPath}: ${proxyUrl}`);
  }

  if (url.protocol === "https:") return proxyUrl;
  if (url.protocol === "http:" && isAllowedPlaintextDevHost(url.hostname)) return proxyUrl;

  throw new Error(
    `Invalid proxy_url in ${configPath}: remote plaintext HTTP is not allowed (${proxyUrl}). Use https, localhost, or 127.0.0.1.`
  );
}

function isAllowedPlaintextDevHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
