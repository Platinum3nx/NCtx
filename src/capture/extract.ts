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

const cachedCapabilities = new Map<string, ClaudeCapabilities>();

export function getClaudeCapabilities(claudePath = "claude"): ClaudeCapabilities {
  const cached = cachedCapabilities.get(claudePath);
  if (cached) return cached;
  let help: string;
  try {
    help = execFileSync(claudePath, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw claudeCapabilitiesError(error, claudePath);
  }
  const capabilities = capabilitiesFromHelp(help);
  cachedCapabilities.set(claudePath, capabilities);
  return capabilities;
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

export async function extractMemory(transcript: string, claudeMd: string, priorCaptures: string[] = []): Promise<ExtractionResult> {
  return extractWithClaude(buildExtractionPrompt({ transcriptText: transcript, claudeMd, priorCaptures }), EXTRACTION_SCHEMA);
}

export function parseClaudeJsonOutput(stdout: string): ExtractionResult {
  const parsed = JSON.parse(stdout);
  const candidate = unwrapClaudeJsonOutput(parsed);
  return normalizeExtractionResult(candidate);
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
      const killFallback = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 5_000);
      killFallback.unref();
      proc.on("close", () => clearTimeout(killFallback));
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
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(claudeSpawnError(err, options.claudePath ?? "claude"));
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

function unwrapClaudeJsonOutput(parsed: unknown): unknown {
  if (!isRecord(parsed)) return parsed;
  if ("structured_output" in parsed) return parseMaybeJson(parsed.structured_output, "structured_output");
  if ("result" in parsed) return parseMaybeJson(parsed.result, "result");
  return parsed;
}

function parseMaybeJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Claude ${field} was not valid JSON: ${String(error)}`);
  }
}

function normalizeExtractionResult(value: unknown): ExtractionResult {
  if (!isRecord(value)) {
    throw new Error("Claude extraction output must be a JSON object matching the NCtx extraction schema.");
  }

  return {
    summary: requiredString(value, "summary"),
    tags: requiredStringArray(value, "tags"),
    files_touched: requiredStringArray(value, "files_touched"),
    decisions: requiredRecordArray(value, "decisions").map((decision, index) => ({
      title: requiredString(decision, "title", `decisions[${index}].title`),
      rationale: requiredString(decision, "rationale", `decisions[${index}].rationale`),
      files: optionalStringArray(decision, "files", `decisions[${index}].files`)
    })),
    gotchas: requiredRecordArray(value, "gotchas").map((gotcha, index) => ({
      problem: requiredString(gotcha, "problem", `gotchas[${index}].problem`),
      cause: requiredString(gotcha, "cause", `gotchas[${index}].cause`),
      fix: requiredString(gotcha, "fix", `gotchas[${index}].fix`),
      files: optionalStringArray(gotcha, "files", `gotchas[${index}].files`)
    })),
    patterns: requiredRecordArray(value, "patterns").map((pattern, index) => ({
      pattern: requiredString(pattern, "pattern", `patterns[${index}].pattern`),
      rationale: requiredString(pattern, "rationale", `patterns[${index}].rationale`),
      files: optionalStringArray(pattern, "files", `patterns[${index}].files`)
    })),
    state: normalizeState(requiredRecord(value, "state"))
  };
}

function normalizeState(value: Record<string, unknown>): ExtractionResult["state"] {
  return {
    in_progress: optionalNullableString(value, "in_progress", "state.in_progress"),
    next_steps: optionalStringArray(value, "next_steps", "state.next_steps"),
    files: optionalStringArray(value, "files", "state.files")
  };
}

function requiredRecordArray(value: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
  const items = value[field];
  if (!Array.isArray(items)) throw new Error(`Claude extraction field ${field} must be an array.`);
  return items.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Claude extraction field ${field}[${index}] must be an object.`);
    return item;
  });
}

function requiredRecord(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const candidate = value[field];
  if (!isRecord(candidate)) throw new Error(`Claude extraction field ${field} must be an object.`);
  return candidate;
}

function requiredString(value: Record<string, unknown>, field: string, label = field): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`Claude extraction field ${label} must be a string.`);
  return candidate.trim();
}

function requiredStringArray(value: Record<string, unknown>, field: string, label = field): string[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`Claude extraction field ${label} must be an array of strings.`);
  return candidate.map((item, index) => {
    if (typeof item !== "string") throw new Error(`Claude extraction field ${label}[${index}] must be a string.`);
    return item.trim();
  }).filter(Boolean);
}

function optionalStringArray(value: Record<string, unknown>, field: string, label = field): string[] | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate)) throw new Error(`Claude extraction field ${label} must be an array of strings.`);
  return candidate.map((item, index) => {
    if (typeof item !== "string") throw new Error(`Claude extraction field ${label}[${index}] must be a string.`);
    return item.trim();
  }).filter(Boolean);
}

function optionalNullableString(value: Record<string, unknown>, field: string, label = field): string | null {
  const candidate = value[field];
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== "string") throw new Error(`Claude extraction field ${label} must be a string or null.`);
  return candidate.trim() || null;
}

function claudeCapabilitiesError(error: unknown, claudePath: string): Error {
  if (isNodeError(error) && error.code === "ENOENT") {
    return new Error(
      `Claude Code CLI is not installed or not on PATH. Install Claude Code or set up the "claude" command before running NCtx extraction.`
    );
  }

  const detail = commandFailureDetail(error);
  return new Error(`Unable to run \`${claudePath} --help\` to detect Claude Code capabilities.${detail}`);
}

function claudeSpawnError(error: NodeJS.ErrnoException, claudePath: string): Error {
  if (error.code === "ENOENT") {
    return new Error(
      `Claude Code CLI not found at "${claudePath}". Install Claude Code or set the correct claudePath before running NCtx extraction.`
    );
  }
  if (error.code === "EACCES") {
    return new Error(
      `Permission denied when spawning "${claudePath}". Check that the binary is executable.`
    );
  }
  return new Error(`Failed to spawn "${claudePath}": ${error.message}`);
}

function commandFailureDetail(error: unknown): string {
  if (!isRecord(error)) return ` ${String(error)}`;
  const status = typeof error.status === "number" ? ` exited ${error.status}` : " failed";
  const stderr = outputText(error.stderr);
  const stdout = outputText(error.stdout);
  const output = stderr || stdout;
  return output ? `${status}: ${output}` : `${status}.`;
}

function outputText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
