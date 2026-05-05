import { statSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequest,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { makeClient, type MemorySearchMode, type NctxMemoryClient } from "./client.js";
import { loadConfig, type NctxMcpConfig } from "./config.js";
import { formatResults } from "./format.js";

const MEMORY_TOOL_NAME = "nctx_memory";

type ConfigLoader = (cwd: string) => NctxMcpConfig;
type ClientFactory = (config: NctxMcpConfig) => NctxMemoryClient;
type CwdProvider = () => string;
type ConfigMtimeReader = (configPath: string) => number | null;

export interface McpServerOptions {
  cwd?: CwdProvider;
  loadConfig?: ConfigLoader;
  makeClient?: ClientFactory;
  readConfigMtimeMs?: ConfigMtimeReader;
}

type CachedClient = {
  cwd: string;
  configPath: string;
  configMtimeMs: number | null;
  client: NctxMemoryClient;
};

type MemoryArgs = {
  query: string;
  limit: number;
  mode: MemorySearchMode;
};

export function createMcpServer(options: McpServerOptions = {}): Server {
  const server = new Server(
    { name: "nctx", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  const callTool = createCallToolHandler(options);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: MEMORY_TOOL_NAME,
        description:
          "Search past Claude Code session memories for this project. Use when the user references prior work, asks where we left off, or past decisions/gotchas/patterns would help.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language description of what to find" },
            limit: { type: "number", default: 5 },
            mode: { type: "string", enum: ["semantic", "text"], default: "semantic" }
          },
          required: ["query"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, callTool);
  return server;
}

export function createCallToolHandler(options: McpServerOptions = {}) {
  const getClient = createCachedClientResolver(options);

  return async (request: CallToolRequest): Promise<CallToolResult> => {
    if (request.params.name !== MEMORY_TOOL_NAME) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }

    const args = parseMemoryArgs(request.params.arguments);
    if (!args.ok) return toolError(args.error);

    try {
      const client = getClient();
      const results = await client.searchContexts(args.value.query, args.value.limit, args.value.mode);
      return toolText(formatResults(results));
    } catch (error) {
      return toolError(errorMessage(error));
    }
  };
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

function createCachedClientResolver(options: McpServerOptions): () => NctxMemoryClient {
  const cwd = options.cwd ?? (() => process.cwd());
  const load = options.loadConfig ?? loadConfig;
  const create = options.makeClient ?? makeClient;
  const readConfigMtimeMs = options.readConfigMtimeMs ?? defaultReadConfigMtimeMs;
  let cached: CachedClient | null = null;

  return () => {
    const currentCwd = cwd();
    const cachedMtime = cached ? readConfigMtimeMs(cached.configPath) : null;
    if (
      cached &&
      cached.cwd === currentCwd &&
      cachedMtime !== null &&
      cachedMtime === cached.configMtimeMs
    ) {
      return cached.client;
    }

    const config = load(currentCwd);
    const client = create(config);
    cached = {
      cwd: currentCwd,
      configPath: config.config_path,
      configMtimeMs: readConfigMtimeMs(config.config_path),
      client
    };
    return client;
  };
}

function parseMemoryArgs(args: unknown): { ok: true; value: MemoryArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: `${MEMORY_TOOL_NAME} requires an arguments object.` };
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, error: `${MEMORY_TOOL_NAME} requires a query.` };

  const limit = args.limit === undefined ? 5 : args.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return { ok: false, error: `${MEMORY_TOOL_NAME} limit must be a finite number.` };
  }

  const mode = args.mode === undefined ? "semantic" : args.mode;
  if (mode !== "semantic" && mode !== "text") {
    return { ok: false, error: `${MEMORY_TOOL_NAME} mode must be either "semantic" or "text".` };
  }

  return { ok: true, value: { query, limit, mode } };
}

function toolText(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }]
  };
}

function toolError(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultReadConfigMtimeMs(configPath: string): number | null {
  try {
    return statSync(configPath).mtimeMs;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
