#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { PACKAGE_VERSION } from "../lib/constants.js";
import { runCapture } from "./capture.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runList, runView } from "./list.js";
import { runMcpCommand } from "./mcp.js";
import { runReindex } from "./reindex.js";
import { runUninstall } from "./uninstall.js";
import type { Trigger } from "../types.js";

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("nctx")
    .version(PACKAGE_VERSION)
    .command(
      "init",
      "Initialize NCtx in the current project",
      (builder) =>
        builder
          .option("proxy-url", { type: "string", describe: "Hosted Worker URL" })
          .option("package-secret", { type: "string", describe: "Package-level install guard secret" })
          .option("install-token", { type: "string", describe: "Use an existing hosted install token" })
          .option("project-name", { type: "string", describe: "Project name override" })
          .option("skip-hooks", { type: "boolean", default: false, describe: "Skip Claude hook registration" })
          .option("skip-mcp", { type: "boolean", default: false, describe: "Skip Claude MCP registration" }),
      async (argv) => {
        await runInit(process.cwd(), {
          proxyUrl: argv.proxyUrl,
          packageSecret: argv.packageSecret,
          installToken: argv.installToken,
          projectName: argv.projectName,
          skipHooks: argv.skipHooks,
          skipMcp: argv.skipMcp
        });
        console.log("OK NCtx initialized");
      }
    )
    .command(
      "capture",
      "Run capture from Claude Code hook JSON on stdin",
      (builder) =>
        builder.option("trigger", {
          type: "string",
          choices: ["session-end", "precompact", "manual"] as const,
          demandOption: true
        }),
      async (argv) => {
        await runCapture(argv.trigger as Trigger);
      }
    )
    .command("mcp", "Run NCtx MCP server on stdio", {}, async () => {
      await runMcpCommand();
    })
    .command(
      "doctor",
      "Check NCtx installation health",
      (builder) => builder.option("claude-flags", { type: "boolean", default: false }),
      async (argv) => {
        process.exitCode = await runDoctor(process.cwd(), { claudeFlagsOnly: argv.claudeFlags });
      }
    )
    .command("list", "List local memories", {}, async () => {
      await runList(process.cwd());
    })
    .command(
      "view <id>",
      "View a local memory by id or filename fragment",
      (builder) => builder.positional("id", { type: "string", demandOption: true }),
      async (argv) => {
        await runView(process.cwd(), String(argv.id));
      }
    )
    .command("reindex", "Push queued pending contexts", {}, async () => {
      await runReindex(process.cwd());
    })
    .command(
      "uninstall",
      "Remove NCtx hooks and MCP registration",
      (builder) => builder.option("remove-data", { type: "boolean", default: false }),
      async (argv) => {
        await runUninstall(process.cwd(), Boolean(argv.removeData));
        console.log("OK NCtx uninstalled");
      }
    )
    .demandCommand()
    .strict()
    .help()
    .parseAsync();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
