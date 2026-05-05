import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PACKAGE_NAME } from "../lib/constants.js";

type HookCommand = {
  type: "command";
  command: string;
  async: true;
  timeout: number;
};

type ClaudeSettings = {
  hooks?: Record<string, Array<{ hooks?: HookCommand[] }>>;
  [key: string]: unknown;
};

export type HookEventStatus = {
  event: "SessionEnd" | "PreCompact";
  registered: boolean;
  hasRecursionGuard: boolean;
  isAsync: boolean;
  timeoutSeconds: number | null;
  command: string | null;
};

export type HooksStatus = {
  settingsPath: string;
  exists: boolean;
  events: HookEventStatus[];
};

export type InspectHooksOptions = {
  pluginRoot?: string | null;
};

type HookInspection = {
  session: string[];
  precompact: string[];
  stop: string[];
};

const SESSION_COMMAND =
  `if [ "$NCTX_INTERNAL" = "1" ]; then exit 0; fi; npx -y ${PACKAGE_NAME} capture --trigger=session-end`;
const PRECOMPACT_COMMAND =
  `if [ "$NCTX_INTERNAL" = "1" ]; then exit 0; fi; npx -y ${PACKAGE_NAME} capture --trigger=precompact`;

export function claudeSettingsPath(cwd: string): string {
  return join(cwd, ".claude", "settings.json");
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, "utf8")) as ClaudeSettings;
}

function upsertHook(settings: ClaudeSettings, event: "SessionEnd" | "PreCompact", command: string): void {
  settings.hooks ??= {};
  const current = settings.hooks[event] ?? [];
  const withoutNctx = current
    .map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter((hook) => !hook.command.includes("nctx capture"))
    }))
    .filter((group) => (group.hooks ?? []).length > 0);

  withoutNctx.push({
    hooks: [
      {
        type: "command",
        command,
        async: true,
        timeout: 60
      }
    ]
  });
  settings.hooks[event] = withoutNctx;
}

export async function registerHooks(cwd: string): Promise<void> {
  const path = claudeSettingsPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const settings = await readSettings(path);
  upsertHook(settings, "SessionEnd", SESSION_COMMAND);
  upsertHook(settings, "PreCompact", PRECOMPACT_COMMAND);
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function unregisterHooks(cwd: string): Promise<void> {
  const path = claudeSettingsPath(cwd);
  if (!existsSync(path)) return;
  const settings = await readSettings(path);
  for (const event of ["SessionEnd", "PreCompact", "Stop"] as const) {
    const groups = settings.hooks?.[event] ?? [];
    const next = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => !hook.command.includes("nctx capture"))
      }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (settings.hooks && next.length) settings.hooks[event] = next;
    else if (settings.hooks) delete settings.hooks[event];
  }
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function inspectHooks(cwd: string, options: InspectHooksOptions = {}): Promise<{
  hasSessionEnd: boolean;
  hasPreCompact: boolean;
  hasRecursionGuard: boolean;
  hasObsoleteStop: boolean;
}> {
  const inspections: HookInspection[] = [];
  const projectPath = claudeSettingsPath(cwd);
  if (existsSync(projectPath)) {
    inspections.push(await inspectHookFile(projectPath));
  }

  const pluginRoot = options.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? null;
  if (pluginRoot) {
    const pluginPath = join(pluginRoot, "hooks", "hooks.json");
    if (existsSync(pluginPath)) {
      inspections.push(await inspectHookFile(pluginPath));
    }
  }

  const session = inspections.flatMap((inspection) => inspection.session);
  const precompact = inspections.flatMap((inspection) => inspection.precompact);
  const stop = inspections.flatMap((inspection) => inspection.stop);
  const captureCommands = [...session, ...precompact];
  return {
    hasSessionEnd: session.length > 0,
    hasPreCompact: precompact.length > 0,
    hasRecursionGuard: captureCommands.length > 0 && captureCommands.every((cmd) => cmd.includes("NCTX_INTERNAL")),
    hasObsoleteStop: stop.length > 0
  };
}

async function inspectHookFile(path: string): Promise<HookInspection> {
  const settings = await readSettings(path);
  const commands = (event: string) =>
    (settings.hooks?.[event] ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command)
      .filter((command): command is string => typeof command === "string" && isNctxCaptureCommand(command));

  return {
    session: commands("SessionEnd"),
    precompact: commands("PreCompact"),
    stop: commands("Stop")
  };
}

function isNctxCaptureCommand(command: string): boolean {
  return command.includes("capture") && (command.includes("nctx") || command.includes("dist/cli/index.js"));
}

export async function getHooksStatus(cwd: string): Promise<HooksStatus> {
  const path = claudeSettingsPath(cwd);
  if (!existsSync(path)) {
    return {
      settingsPath: path,
      exists: false,
      events: [
        emptyHookStatus("SessionEnd"),
        emptyHookStatus("PreCompact")
      ]
    };
  }

  const settings = await readSettings(path);
  return {
    settingsPath: path,
    exists: true,
    events: [
      inspectHookEvent(settings, "SessionEnd"),
      inspectHookEvent(settings, "PreCompact")
    ]
  };
}

function inspectHookEvent(settings: ClaudeSettings, event: "SessionEnd" | "PreCompact"): HookEventStatus {
  const hook = (settings.hooks?.[event] ?? [])
    .flatMap((group) => group.hooks ?? [])
    .find((candidate) => candidate.command.includes("nctx capture"));

  if (!hook) return emptyHookStatus(event);
  return {
    event,
    registered: true,
    hasRecursionGuard: hook.command.includes("NCTX_INTERNAL") && hook.command.includes("exit 0"),
    isAsync: hook.async === true,
    timeoutSeconds: typeof hook.timeout === "number" ? hook.timeout : null,
    command: hook.command
  };
}

function emptyHookStatus(event: "SessionEnd" | "PreCompact"): HookEventStatus {
  return {
    event,
    registered: false,
    hasRecursionGuard: false,
    isAsync: false,
    timeoutSeconds: null,
    command: null
  };
}
