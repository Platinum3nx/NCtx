import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectHooks } from "../config/hooks.js";
import { loadConfig } from "../config/load.js";
import { getMcpStatus } from "../config/mcp-register.js";
import { getClaudeCapabilities } from "../capture/extract.js";
import type { NctxConfig } from "../types.js";

const WORKER_PROBE_QUERY = "__nctx_doctor_probe__";
const DEFAULT_WORKER_PROBE_TIMEOUT_MS = 5_000;
const EXPECTED_AGENT_SOURCE = "nctx-claude-code";

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
    checks.push(["install token present", Boolean(config.install_token)]);
    checks.push(["hosted mode", config.mode === "hosted"]);
  } catch (err) {
    checks.push(["config", false, err instanceof Error ? err.message : String(err)]);
  }

  if (config && options.workerLive !== false) {
    checks.push(
      ...(await checkHostedWorker(config, {
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

export async function checkHostedWorker(
  config: NctxConfig,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<DoctorCheck[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_PROBE_TIMEOUT_MS;
  const url = new URL(`${config.proxy_url.replace(/\/+$/, "")}/contexts/semantic-search`);
  url.searchParams.set("q", WORKER_PROBE_QUERY);
  url.searchParams.set("limit", "1");
  url.searchParams.set("include_highlights", "false");

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        headers: {
          Authorization: `Bearer ${config.install_token}`
        }
      },
      timeoutMs
    );
    const checks: DoctorCheck[] = [["Worker reachable", true]];

    if (!response.ok) {
      checks.push(["hosted search response", false, await responseDetail(response)]);
      return checks;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      checks.push(["hosted search response", false, "Worker returned non-JSON search response"]);
      return checks;
    }

    if (!hasSearchResultsShape(body)) {
      checks.push([
        "hosted search response",
        false,
        "Worker search response did not include a results array"
      ]);
      return checks;
    }
    checks.push([
      "hosted search response",
      true
    ]);
    if (body.results.length === 0) return checks;

    const isolatedShape = hasIsolatedSearchResults(body.results);
    checks.push([
      "hosted result isolation",
      isolatedShape,
      isolatedShape ? undefined : "Worker search results were not isolated to this hosted install"
    ]);
    return checks;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return [
      ["Worker reachable", false, detail],
      ["hosted search response", false, "skipped because Worker probe failed"]
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
      reject(new Error(`Worker probe timed out after ${timeoutMs}ms`));
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

function hasIsolatedSearchResults(results: unknown[]): boolean {
  return results.every((result) => {
    if (!isRecord(result)) return false;
    return result.agent_source === EXPECTED_AGENT_SOURCE && hasInstallTag(result.tags);
  });
}

function hasInstallTag(tags: unknown): boolean {
  return Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.startsWith("install:"));
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
