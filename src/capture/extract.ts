import { execFileSync, spawn } from "node:child_process";
import type { ExtractionResult } from "../types.js";
import { EXTRACTION_SCHEMA, buildExtractionPrompt } from "./prompt.js";

export type ClaudeCapabilities = {
  hasTools: boolean;
  hasNoSessionPersistence: boolean;
  hasJsonSchema: boolean;
  hasModel: boolean;
};

export type ExtractOptions = {
  claudePath?: string;
  cwd?: string;
  capabilities?: ClaudeCapabilities;
};

let cachedCapabilities: ClaudeCapabilities | null = null;

export function getClaudeCapabilities(): ClaudeCapabilities {
  if (cachedCapabilities) return cachedCapabilities;
  const help = execFileSync("claude", ["--help"], { encoding: "utf8" });
  cachedCapabilities = {
    hasTools: help.includes("--tools"),
    hasNoSessionPersistence: help.includes("--no-session-persistence"),
    hasJsonSchema: help.includes("--json-schema"),
    hasModel: help.includes("--model")
  };
  return cachedCapabilities;
}

export function capabilitiesFromHelp(help: string): ClaudeCapabilities {
  return {
    hasTools: help.includes("--tools"),
    hasNoSessionPersistence: help.includes("--no-session-persistence"),
    hasJsonSchema: help.includes("--json-schema"),
    hasModel: help.includes("--model")
  };
}

export function warningsForCapabilities(caps: ClaudeCapabilities): string[] {
  const warnings: string[] = [];
  if (!caps.hasTools) warnings.push("Claude Code does not expose --tools; extraction cannot hard-disable tools.");
  if (!caps.hasJsonSchema) warnings.push("Claude Code does not expose --json-schema; extraction will parse JSON best-effort.");
  if (!caps.hasNoSessionPersistence) warnings.push("Claude Code does not expose --no-session-persistence; extraction may appear in session history.");
  if (!caps.hasModel) warnings.push("Claude Code does not expose --model; extraction will use the default model.");
  return warnings;
}

export function buildClaudeArgs(schema: object = EXTRACTION_SCHEMA, capabilities?: ClaudeCapabilities): string[] {
  const caps = capabilities ?? getClaudeCapabilities();
  const args = ["-p", "--output-format", "json"];

  if (caps.hasJsonSchema) args.push("--json-schema", JSON.stringify(schema));
  if (caps.hasTools) args.push("--tools", "");
  if (caps.hasNoSessionPersistence) args.push("--no-session-persistence");
  if (caps.hasModel) args.push("--model", "haiku");

  return args;
}

export async function extractMemory(transcript: string, claudeMd: string): Promise<ExtractionResult> {
  return extractWithClaude(buildExtractionPrompt(transcript, claudeMd), EXTRACTION_SCHEMA);
}

export function parseClaudeJsonOutput(stdout: string): any {
  const parsed = JSON.parse(stdout);
  const candidate = parsed.structured_output ?? parsed.result ?? parsed;
  return typeof candidate === "string" ? JSON.parse(candidate) : candidate;
}

export function extractWithClaude(fullPrompt: string, schema: object, options: ExtractOptions = {}): Promise<ExtractionResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(options.claudePath ?? "claude", buildClaudeArgs(schema, options.capabilities), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NCTX_INTERNAL: "1"
      }
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("claude -p extraction timed out"));
    }, 60_000);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(parseClaudeJsonOutput(stdout));
      } catch (err) {
        reject(new Error(`Bad JSON from claude -p: ${stdout.slice(0, 500)} (${String(err)})`));
      }
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}
