import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config/load.js";
import { makeClient } from "../nia/hosted.js";
import { formatResults } from "./format.js";

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "nctx", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "nctx_memory",
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "nctx_memory") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args = request.params.arguments as {
      query?: string;
      limit?: number;
      mode?: "semantic" | "text";
    };
    if (!args.query?.trim()) throw new Error("nctx_memory requires a query.");

    const config = await loadConfig(process.cwd());
    const client = makeClient(config);
    const results = await client.searchContexts(args.query, args.limit ?? 5, args.mode ?? "semantic");
    return {
      content: [
        {
          type: "text",
          text: formatResults(results)
        }
      ]
    };
  });

  await server.connect(new StdioServerTransport());
}

