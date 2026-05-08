import { readFileSync } from "node:fs";
import { findConfigPath } from "../config/load.js";
import { DEFAULT_NIA_BASE_URL } from "../lib/constants.js";

export interface NctxMcpConfig {
  mode: "direct";
  nia_api_key: string;
  nia_base_url: string;
  project_name: string;
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
  if (parsed.mode !== "direct") {
    if (parsed.mode === "hosted") {
      throw new Error(
        `Hosted NCtx configs are no longer supported by nctx_memory. Re-run \`nctx init --plugin --nia-api-key <key>\` in ${configPath}.`
      );
    }
    throw new Error(`Unsupported NCtx mode ${String(parsed.mode)}. NCtx MCP retrieval supports direct BYOK mode only.`);
  }

  if ("install_token" in parsed || "proxy_url" in parsed) {
    throw new Error(`direct mode must not contain hosted Worker credentials in ${configPath}`);
  }

  const niaApiKey = readRequiredString(parsed, "nia_api_key", configPath);
  const niaBaseUrl = validateServiceUrl(readOptionalString(parsed, "nia_base_url") ?? DEFAULT_NIA_BASE_URL, "nia_base_url", configPath);
  const projectName = readRequiredString(parsed, "project_name", configPath);

  return {
    mode: "direct",
    nia_api_key: niaApiKey,
    nia_base_url: niaBaseUrl,
    project_name: projectName,
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

function validateServiceUrl(rawUrl: string, label: string, configPath: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${label} in ${configPath}: ${rawUrl}`);
  }

  if (url.protocol === "https:") return rawUrl.replace(/\/+$/, "");
  if (url.protocol === "http:" && isAllowedPlaintextDevHost(url.hostname)) return rawUrl.replace(/\/+$/, "");

  throw new Error(
    `Invalid ${label} in ${configPath}: remote plaintext HTTP is not allowed (${rawUrl}). Use https, localhost, or 127.0.0.1.`
  );
}

function isAllowedPlaintextDevHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
