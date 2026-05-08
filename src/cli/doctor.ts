import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectHooks } from "../config/hooks.js";
import { loadConfig } from "../config/load.js";
import { getMcpStatus } from "../config/mcp-register.js";
import { getClaudeCapabilities } from "../capture/extract.js";
import type { NctxConfig } from "../types.js";
import { AGENT_SOURCE } from "../lib/constants.js";

const NIA_PROBE_QUERY = "__nctx_doctor_probe__";
const DEFAULT_NIA_PROBE_TIMEOUT_MS = 5_000;

type DoctorCheck = [string, boolean, string?];
type LifecycleStatus = {
  hasSessionEnd: boolean;
  hasPreCompact: boolean;
  hasRecursionGuard: boolean;
  hasObsoleteStop: boolean;
};

export async function runDoctor(
  cwd: string,
  options: {
    claudeFlagsOnly?: boolean;
    workerLive?: boolean;
    fetchImpl?: typeof fetch;
    workerTimeoutMs?: number;
  } = {}
): Promise<number> {
  const checks: DoctorCheck[] = [];

  if (options.claudeFlagsOnly) {
    try {
      const caps = getClaudeCapabilities();
      const flagChecks: Array<[string, boolean]> = [
        ["--tools", caps.hasTools],
        ["--json-schema", caps.hasJsonSchema],
        ["--no-session-persistence", caps.hasNoSessionPersistence],
        ["--model", caps.hasModel]
      ];
      for (const [name, ok] of flagChecks) {
        console.log(`${ok ? "OK" : "FAIL"} ${name}: ${ok ? "supported" : "not found in claude --help"}`);
      }
      return flagChecks.every(([, ok]) => ok) ? 0 : 1;
    } catch (err) {
      console.log(`FAIL claude help - ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  let config: NctxConfig | null = null;
  try {
    config = await loadConfig(cwd);
    checks.push(["config", true]);
    checks.push(["Nia API key present", Boolean(config.nia_api_key)]);
    checks.push(["direct BYOK mode", config.mode === "direct"]);
  } catch (err) {
    checks.push(["config", false, err instanceof Error ? err.message : String(err)]);
  }

  if (config && options.workerLive !== false) {
    checks.push(
      ...(await checkDirectNia(config, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.workerTimeoutMs
      }))
    );
  }

  const hooks = mergeLifecycleStatus(await inspectHooks(cwd), await inspectPluginHooks());
  checks.push(["SessionEnd hook", hooks.hasSessionEnd]);
  checks.push(["PreCompact hook", hooks.hasPreCompact]);
  checks.push(["hook recursion guard", hooks.hasRecursionGuard]);
  checks.push(["no obsolete Stop hook", !hooks.hasObsoleteStop]);

  try {
    const caps = getClaudeCapabilities();
    checks.push(["claude --tools", caps.hasTools]);
    checks.push(["claude --json-schema", caps.hasJsonSchema]);
    checks.push(["claude --no-session-persistence", caps.hasNoSessionPersistence]);
    checks.push(["claude --model", caps.hasModel]);
  } catch (err) {
    checks.push(["claude help", false, err instanceof Error ? err.message : String(err)]);
  }

  try {
    await access(cwd);
    checks.push(["cwd accessible", true]);
  } catch {
    checks.push(["cwd accessible", false]);
  }

  const mcp = await getMcpStatus(cwd);
  checks.push(["nctx MCP entry", mcp.registered, mcp.registered ? undefined : mcp.details]);
  checks.push([
    "nctx MCP tool registration",
    mcp.toolRegistered,
    mcp.toolRegistered ? undefined : mcp.details
  ]);

  let failures = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failures += 1;
    console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  }
  return failures ? 1 : 0;
}

export async function checkDirectNia(
  config: NctxConfig,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<DoctorCheck[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NIA_PROBE_TIMEOUT_MS;
  const url = new URL(`${config.nia_base_url.replace(/\/+$/, "")}/contexts/semantic-search`);
  url.searchParams.set("q", NIA_PROBE_QUERY);
  url.searchParams.set("limit", "1");
  url.searchParams.set("include_highlights", "false");

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        headers: {
          Authorization: `Bearer ${config.nia_api_key}`
        }
      },
      timeoutMs
    );
    const checks: DoctorCheck[] = [["Nia reachable", true]];

    if (!response.ok) {
      checks.push(["Nia search response", false, await responseDetail(response)]);
      return checks;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      checks.push(["Nia search response", false, "Nia returned non-JSON search response"]);
      return checks;
    }

    if (!hasSearchResultsShape(body)) {
      checks.push([
        "Nia search response",
        false,
        "Nia search response did not include a results array"
      ]);
      return checks;
    }
    checks.push([
      "Nia search response",
      true
    ]);
    if (body.results.length === 0) return checks;

    const isolatedShape = hasProjectScopedSearchResults(body.results, projectTagFor(config.project_name));
    checks.push([
      "Nia project result scope",
      isolatedShape,
      isolatedShape ? undefined : "Nia search results were not scoped to this NCtx project"
    ]);
    return checks;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return [
      ["Nia reachable", false, detail],
      ["Nia search response", false, "skipped because Nia probe failed"]
    ];
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Nia probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(input, {
        ...init,
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function responseDetail(response: Response): Promise<string> {
  const text = await response.text();
  if (!text.trim()) return `HTTP ${response.status}`;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return `HTTP ${response.status}: ${parsed.error}`;
    }
  } catch {
    // Fall back to a short text snippet below.
  }

  return `HTTP ${response.status}: ${text.slice(0, 120)}`;
}

function hasSearchResultsShape(body: unknown): body is { results: unknown[] } {
  if (!isRecord(body) || !Array.isArray(body.results)) return false;
  return true;
}

function hasProjectScopedSearchResults(results: unknown[], projectTag: string): boolean {
  return results.every((result) => {
    if (!isRecord(result)) return false;
    return result.agent_source === AGENT_SOURCE && hasProjectTag(result.tags, projectTag);
  });
}

function hasProjectTag(tags: unknown, projectTag: string): boolean {
  return Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag === projectTag);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function inspectPluginHooks(pluginRoot = process.env.CLAUDE_PLUGIN_ROOT): Promise<LifecycleStatus> {
  if (!pluginRoot) return emptyLifecycleStatus();
  try {
    const raw = await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8");
    return inspectLifecycleObject(JSON.parse(raw));
  } catch {
    return emptyLifecycleStatus();
  }
}

function mergeLifecycleStatus(a: LifecycleStatus, b: LifecycleStatus): LifecycleStatus {
  const hasA = a.hasSessionEnd || a.hasPreCompact;
  const hasB = b.hasSessionEnd || b.hasPreCompact;
  const hasAnyNctxHook = hasA || hasB;
  return {
    hasSessionEnd: a.hasSessionEnd || b.hasSessionEnd,
    hasPreCompact: a.hasPreCompact || b.hasPreCompact,
    hasRecursionGuard: hasAnyNctxHook && (!hasA || a.hasRecursionGuard) && (!hasB || b.hasRecursionGuard),
    hasObsoleteStop: a.hasObsoleteStop || b.hasObsoleteStop
  };
}

function inspectLifecycleObject(value: unknown): LifecycleStatus {
  if (!isRecord(value) || !isRecord(value.hooks)) return emptyLifecycleStatus();
  const hooks = value.hooks;
  const commands = (event: string): string[] => {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [];
      return group.hooks.flatMap((hook) => (isRecord(hook) && typeof hook.command === "string" ? [hook.command] : []));
    });
  };
  const session = commands("SessionEnd").filter(isNctxCaptureCommand);
  const precompact = commands("PreCompact").filter(isNctxCaptureCommand);
  const stop = commands("Stop").filter(isNctxCaptureCommand);
  const active = [...session, ...precompact];
  return {
    hasSessionEnd: session.length > 0,
    hasPreCompact: precompact.length > 0,
    hasRecursionGuard: active.length > 0 && active.every((cmd) => cmd.includes("NCTX_INTERNAL")),
    hasObsoleteStop: stop.length > 0
  };
}

function isNctxCaptureCommand(command: string): boolean {
  return command.includes("capture") && (command.includes("nctx") || command.includes("dist/cli/index.js"));
}

function emptyLifecycleStatus(): LifecycleStatus {
  return { hasSessionEnd: false, hasPreCompact: false, hasRecursionGuard: false, hasObsoleteStop: false };
}

function projectTagFor(projectNameOrTag: string): string {
  const trimmed = projectNameOrTag.trim();
  const rawProject = trimmed.toLowerCase().startsWith("project:") ? trimmed.slice("project:".length) : trimmed;
  const normalized = rawProject.trim().toLowerCase().replace(/\s+/g, "-");
  return `project:${normalized || "project"}`;
}
