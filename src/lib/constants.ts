export const PACKAGE_NAME = "@platinum3nx/nctx";
export const PACKAGE_VERSION = "0.1.0";

export const NCTX_DIRNAME = ".nctx";
export const CLAUDE_DIRNAME = ".claude";
export const CLAUDE_SETTINGS_FILENAME = "settings.json";

export const DEFAULT_PROXY_URL = "https://nctx.amalghan70.workers.dev";
export const PACKAGE_SHARED_SECRET = "nctx-public-beta-client-v1";
export const AGENT_SOURCE = "nctx-claude-code";

export const MEMORY_TYPES = ["fact", "procedural", "episodic", "scratchpad"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const NCTX_HOOK_TIMEOUT_SECONDS = 60;
export const NCTX_MCP_SERVER_NAME = "nctx";
