#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { PACKAGE_VERSION } from "../lib/constants.js";
import { runCapture, runCaptureDetached, runCaptureFromSpool } from "./capture.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runList } from "./list.js";
import { runMcpCommand } from "./mcp.js";
import { runReindex } from "./reindex.js";
import { runStatus } from "./status.js";
import { runUninstall } from "./uninstall.js";
import { runView } from "./view.js";
import type { Trigger } from "../types.js";
import { asErrorMessage, logError } from "../lib/log.js";

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("nctx")
    .version(PACKAGE_VERSION)
    .command(
      "init",
      "Initialize NCtx in the current project",
      (builder) =>
        builder
          .option("nia-api-key", { type: "string", describe: "Your Nia API key. Defaults to NCTX_NIA_API_KEY or NIA_API_KEY." })
          .option("nia-base-url", { type: "string", describe: "Nia API base URL" })
          .option("project-name", { type: "string", describe: "Project name override" })
          .option("plugin", {
            type: "boolean",
            default: false,
            describe: "Initialize project config only; hooks and MCP are provided by the Claude Code plugin"
          })
          .option("skip-hooks", { type: "boolean", default: false, describe: "Skip Claude hook registration" })
          .option("skip-mcp", { type: "boolean", default: false, describe: "Skip Claude MCP registration" }),
      async (argv) => {
        const skipHooks = argv.skipHooks || argv.plugin;
        const skipMcp = argv.skipMcp || argv.plugin;
        const result = await runInit(process.cwd(), {
          niaApiKey: argv.niaApiKey,
          niaBaseUrl: argv.niaBaseUrl,
          projectName: argv.projectName,
          skipHooks,
          skipMcp
        });
        console.log(
          [
            "OK NCtx initialized",
            `Mode: ${argv.plugin ? "Claude Code plugin" : "standalone CLI"}`,
            `Config: .nctx/config.json`,
            `Hooks: ${skipHooks ? "provided by plugin or skipped" : "registered in .claude/settings.json"}`,
            `MCP: ${skipMcp ? "provided by plugin or skipped" : "registered with Claude Code"}`,
            `Nia key: ${result.keyAction}`
          ].join("\n")
        );
      }
    )
    .command(
      "capture",
      "Run capture from Claude Code hook JSON on stdin",
      (builder) =>
        builder
          .option("trigger", {
            type: "string",
            choices: ["session-end", "precompact", "manual"] as const
          })
          .option("detach", {
            type: "boolean",
            default: false,
            describe: "Queue hook input and spawn detached capture worker"
          })
          .option("from-spool", {
            type: "string",
            describe: "Run capture from a detached hook spool file"
          }),
      async (argv) => {
        if (argv.fromSpool) {
          await runCaptureFromSpool(String(argv.fromSpool));
          return;
        }
        if (!argv.trigger) throw new Error("Missing required argument: trigger");
        const trigger = argv.trigger as Trigger;
        if (argv.detach) await runCaptureDetached(trigger);
        else await runCapture(trigger);
      }
    )
    .command("mcp", "Run NCtx MCP server on stdio", {}, async () => {
      await runMcpCommand();
    })
    .command(
      "doctor",
      "Check NCtx installation health",
      (builder) =>
        builder
          .option("claude-flags", { type: "boolean", default: false })
          .option("worker-live", {
            type: "boolean",
            default: true,
            describe: "Run a lightweight Nia reachability probe"
          }),
      async (argv) => {
        process.exitCode = await runDoctor(process.cwd(), {
          claudeFlagsOnly: argv.claudeFlags,
          workerLive: argv.workerLive
        });
      }
    )
    .command("list", "List local memories", {}, async () => {
      await runList(process.cwd());
    })
    .command("status", "Show NCtx capture status for this project", {}, async () => {
      await runStatus(process.cwd());
    })
    .command(
      "view <id>",
      "View a local memory by id or filename fragment",
      (builder) =>
        builder
          .positional("id", { type: "string", demandOption: true })
          .option("json", { type: "boolean", default: false, describe: "Print parsed memory JSON" }),
      async (argv) => {
        await runView(String(argv.id), { cwd: process.cwd(), json: Boolean(argv.json) });
      }
    )
    .command("reindex", "Drain pending writes and re-push local memories", {}, async () => {
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
    .exitProcess(false)
    .help()
    .parseAsync();
}

main().catch(async (err) => {
  if (isCaptureInvocation(hideBin(process.argv))) {
    process.exitCode = 0;
    try {
      await logError(process.cwd(), `Capture CLI failed: ${asErrorMessage(err)}`, err);
    } catch {
      // Capture hooks must never fail the host command because local logging failed.
    }
    return;
  }

  console.error(asErrorMessage(err));
  process.exitCode = 1;
});

function isCaptureInvocation(args: string[]): boolean {
  return args.find((arg) => !arg.startsWith("-")) === "capture";
}
