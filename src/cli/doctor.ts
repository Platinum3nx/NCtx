import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectHooks } from "../config/hooks.js";
import { loadConfig } from "../config/load.js";
import { getClaudeCapabilities } from "../capture/extract.js";

const execFileAsync = promisify(execFile);

export async function runDoctor(
  cwd: string,
  options: { claudeFlagsOnly?: boolean } = {}
): Promise<number> {
  const checks: Array<[string, boolean, string?]> = [];

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

  try {
    const config = await loadConfig(cwd);
    checks.push(["config", true]);
    checks.push(["install token present", Boolean(config.install_token)]);
    checks.push(["hosted mode", config.mode === "hosted"]);
  } catch (err) {
    checks.push(["config", false, err instanceof Error ? err.message : String(err)]);
  }

  const hooks = await inspectHooks(cwd);
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

  try {
    await execFileAsync("claude", ["mcp", "list"]);
    checks.push(["claude mcp command", true]);
  } catch (err) {
    checks.push(["claude mcp command", false, err instanceof Error ? err.message : String(err)]);
  }

  let failures = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failures += 1;
    console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  }
  return failures ? 1 : 0;
}
