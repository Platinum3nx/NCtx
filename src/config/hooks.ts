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

export async function inspectHooks(cwd: string): Promise<{
  hasSessionEnd: boolean;
  hasPreCompact: boolean;
  hasRecursionGuard: boolean;
  hasObsoleteStop: boolean;
}> {
  const path = claudeSettingsPath(cwd);
  if (!existsSync(path)) {
    return { hasSessionEnd: false, hasPreCompact: false, hasRecursionGuard: false, hasObsoleteStop: false };
  }
  const settings = await readSettings(path);
  const commands = (event: string) =>
    (settings.hooks?.[event] ?? []).flatMap((group) => group.hooks ?? []).map((hook) => hook.command);
  const session = commands("SessionEnd").filter((cmd) => cmd.includes("nctx capture"));
  const precompact = commands("PreCompact").filter((cmd) => cmd.includes("nctx capture"));
  const stop = commands("Stop").filter((cmd) => cmd.includes("nctx capture"));
  return {
    hasSessionEnd: session.length > 0,
    hasPreCompact: precompact.length > 0,
    hasRecursionGuard: [...session, ...precompact].every((cmd) => cmd.includes("NCTX_INTERNAL")),
    hasObsoleteStop: stop.length > 0
  };
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
