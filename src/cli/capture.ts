import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import YAML from "yaml";
import type { ContextDraft, HookInput, NctxConfig, Trigger } from "../types.js";
import { findProjectRoot, loadConfig } from "../config/load.js";
import { readClaudeMd } from "../capture/claude-md.js";
import { buildContextDrafts } from "../capture/contexts.js";
import { extractMemory } from "../capture/extract.js";
import { filterDuplicateDrafts } from "../capture/fingerprint.js";
import { backfillMemoryContextIds, writeMemoryFile } from "../capture/render.js";
import {
  defaultCaptureId,
  readSessionCursor,
  safeSessionFilePart,
  transcriptToText,
  writeSessionCursor
} from "../capture/transcript.js";
import { ensureDir, memoryDir, pendingDir, readJson, sessionsDir, spoolDir, writeJson } from "../lib/fs.js";
import { withFileLock } from "../lib/lock.js";
import { asErrorMessage, logError } from "../lib/log.js";
import { drainPendingContexts, queuePending, removePendingContext } from "../lib/pending.js";
import { makeClient } from "../nia/hosted.js";

const DEFAULT_STDIN_TIMEOUT_MS = 10_000;
const DEFAULT_DETACH_STDIN_TIMEOUT_MS = 1_000;

type CaptureSpool = {
  trigger: Trigger;
  raw_hook_input: string;
  created_at: string;
  session_id: string;
};

export async function runCapture(trigger: Trigger, inputStream: NodeJS.ReadableStream = process.stdin): Promise<void> {
  if (process.env.NCTX_INTERNAL === "1") return;

  let cwd = process.cwd();

  try {
    const input = parseHookInput(await readStdin(inputStream), trigger);
    const hookCwd = input.cwd || cwd;
    const projectRoot = findProjectRoot(hookCwd);
    if (!projectRoot) return;
    cwd = projectRoot;
    const config = await loadConfig(projectRoot);
    await withFileLock(sessionCaptureLockPath(cwd, input.session_id), async () => {
      const sinceLine = await readSessionCursor(cwd, input.session_id);
      const parsed = await transcriptToText(input.transcript_path, sinceLine);
      if (!parsed.text.trim()) {
        await writeSessionCursor(cwd, input.session_id, parsed.nextLine);
        return;
      }

      const claudeMd = await readClaudeMd(cwd);
      const priorCaptures = await priorSessionSummaries(cwd, input.session_id);
      const extraction = await extractMemory(parsed.text, claudeMd, priorCaptures);
      const captureId = defaultCaptureId(input.session_id);
      const { drafts, skippedDrafts } = buildContextDrafts(extraction, {
        captureId,
        projectName: config.project_name,
        sessionId: input.session_id,
        trigger,
        hookInput: input,
        toolActions: parsed.toolActions,
        nctxVersion: config.version
      });

      for (const skipped of skippedDrafts) {
        await logError(cwd, `Skipped low-signal ${skipped.memoryType} context: ${skipped.reason}`);
      }

      // Dedup: filter out drafts whose fingerprint matches any existing local memory
      const existingFingerprints = await readExistingFingerprints(cwd, input.session_id);
      const { toPublish, skipped: dedupSkipped } = filterDuplicateDrafts(drafts, existingFingerprints);
      for (const { draft, fingerprint } of dedupSkipped) {
        await logError(
          cwd,
          `Skipped duplicate ${draft.memory_type} context (fingerprint ${fingerprint} matches existing capture)`
        );
      }

      // If all drafts were skipped (quality gate + dedup), advance cursor and return without writing a file
      if (toPublish.length === 0) {
        await writeSessionCursor(cwd, input.session_id, parsed.nextLine);
        return;
      }

      const contextIds: Record<string, string> = {};
      const memoryPath = await writeMemoryFile(cwd, {
        captureId,
        sessionId: input.session_id,
        trigger,
        hookInput: input,
        projectName: config.project_name,
        extraction,
        drafts: toPublish,
        contextIds
      });

      await pushDrafts(cwd, config, toPublish, captureId, memoryPath, contextIds);
      await backfillMemoryContextIds(memoryPath, contextIds);
      await writeSessionCursor(cwd, input.session_id, parsed.nextLine);
    });
  } catch (err) {
    await logCaptureError(cwd, `Capture failed: ${asErrorMessage(err)}`, err);
  }
}

export async function runCaptureDetached(
  trigger: Trigger,
  inputStream: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  if (process.env.NCTX_INTERNAL === "1") return;

  let cwd = process.cwd();

  try {
    const raw = await readStdin(inputStream, detachStdinTimeoutMs());
    const input = parseHookInput(raw, trigger);
    const hookCwd = input.cwd || cwd;
    const projectRoot = findProjectRoot(hookCwd);
    if (!projectRoot) return;
    cwd = projectRoot;

    const spoolPath = await writeCaptureSpool(cwd, trigger, raw, input);
    spawnDetachedCapture(cwd, spoolPath);
  } catch (err) {
    await logCaptureError(cwd, `Detached capture handoff failed: ${asErrorMessage(err)}`, err);
  }
}

export async function runCaptureFromSpool(spoolPath: string): Promise<void> {
  let cwd = process.cwd();
  let shouldRemove = false;

  try {
    const spool = validateCaptureSpool(await readJson<unknown>(spoolPath));
    const input = parseHookInput(spool.raw_hook_input, spool.trigger);
    const projectRoot = findProjectRoot(input.cwd || cwd);
    if (projectRoot) cwd = projectRoot;

    await runCapture(spool.trigger, Readable.from([spool.raw_hook_input]));
    shouldRemove = true;
  } catch (err) {
    await logCaptureError(cwd, `Detached capture worker failed: ${asErrorMessage(err)}`, err);
  } finally {
    if (shouldRemove) {
      await unlink(spoolPath).catch((err) => logCaptureError(cwd, "Failed to remove capture spool file", err));
    }
  }
}

async function pushDrafts(
  cwd: string,
  config: NctxConfig,
  drafts: ContextDraft[],
  captureId: string,
  memoryPath: string,
  contextIds: Record<string, string>
): Promise<void> {
  if (!drafts.length) return;
  const client = makeClient(config);
  await drainPendingContexts(cwd, client)
    .then(async (result) => {
      for (const item of result.saved) {
        const path = item.pending.memory_path;
        if (path) {
          await backfillMemoryContextIds(path, {
            [item.pending.draft.memory_type]: item.response.id
          });
        }
        await removePendingContext(item.file_path);
      }
    })
    .catch((err) => logError(cwd, "Failed to drain pending contexts before capture push", err));
  for (const draft of drafts) {
    try {
      const saved = await client.saveContext(draft);
      contextIds[draft.memory_type] = saved.id;
    } catch (err) {
      await queuePending(cwd, captureId, draft, { memoryPath, error: err });
      await logError(cwd, `Queued failed ${draft.memory_type} context`, err);
    }
  }
}

function parseHookInput(raw: string, trigger: Trigger): HookInput {
  if (!raw.trim()) {
    throw new Error("nctx capture requires Claude Code hook JSON on stdin.");
  }
  const parsed = JSON.parse(raw) as HookInput;
  if (!parsed.session_id || !parsed.transcript_path) {
    throw new Error("Hook input missing session_id or transcript_path.");
  }
  if (!parsed.cwd) parsed.cwd = process.cwd();
  if (!parsed.hook_event_name) parsed.hook_event_name = trigger === "precompact" ? "PreCompact" : "SessionEnd";
  return parsed;
}

export async function readStdin(
  input: NodeJS.ReadableStream = process.stdin,
  timeoutMs = stdinTimeoutMs()
): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      if (err) reject(err);
      else resolve(value ?? "");
    };
    const onData = (chunk: Buffer | string) => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    const onEnd = () => finish(undefined, data);
    const onError = (err: Error) => finish(err);

    timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for hook JSON on stdin after ${timeoutMs}ms.`));
      destroyInput(input);
    }, timeoutMs);
    timer.unref?.();

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

function stdinTimeoutMs(): number {
  const raw = process.env.NCTX_CAPTURE_STDIN_TIMEOUT_MS;
  if (!raw) return DEFAULT_STDIN_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STDIN_TIMEOUT_MS;
}

function detachStdinTimeoutMs(): number {
  const raw = process.env.NCTX_DETACH_STDIN_TIMEOUT_MS;
  if (!raw) return DEFAULT_DETACH_STDIN_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DETACH_STDIN_TIMEOUT_MS;
}

function destroyInput(input: NodeJS.ReadableStream): void {
  const destroyable = input as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof destroyable.destroy === "function") destroyable.destroy();
}

function sessionCaptureLockPath(cwd: string, sessionId: string): string {
  return join(sessionsDir(cwd), `${safeSessionFilePart(sessionId)}.lock`);
}

async function writeCaptureSpool(cwd: string, trigger: Trigger, rawHookInput: string, input: HookInput): Promise<string> {
  const dir = spoolDir(cwd);
  await ensureDir(dir);
  const fileName = `${Date.now()}-${safeSessionFilePart(input.session_id)}-${randomUUID()}.json`;
  const path = join(dir, fileName);
  await writeJson(
    path,
    {
      trigger,
      raw_hook_input: rawHookInput,
      created_at: new Date().toISOString(),
      session_id: input.session_id
    } satisfies CaptureSpool,
    { mode: 0o600 }
  );
  return path;
}

function spawnDetachedCapture(cwd: string, spoolPath: string): void {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Unable to locate NCtx CLI entrypoint for detached capture.");

  const env: NodeJS.ProcessEnv = { ...process.env, NCTX_DETACHED_CAPTURE: "1" };
  delete env.NCTX_INTERNAL;

  const child = spawn(process.execPath, [...process.execArgv, entrypoint, "capture", "--from-spool", spoolPath], {
    cwd,
    detached: true,
    env,
    stdio: "ignore"
  });
  child.unref();
}

function validateCaptureSpool(value: unknown): CaptureSpool {
  if (!isRecord(value)) throw new Error("Capture spool must be a JSON object.");
  if (value.trigger !== "session-end" && value.trigger !== "precompact" && value.trigger !== "manual") {
    throw new Error("Capture spool has an invalid trigger.");
  }
  if (typeof value.raw_hook_input !== "string" || !value.raw_hook_input.trim()) {
    throw new Error("Capture spool missing raw hook input.");
  }
  if (typeof value.created_at !== "string" || !value.created_at.trim()) {
    throw new Error("Capture spool missing created_at.");
  }
  if (typeof value.session_id !== "string" || !value.session_id.trim()) {
    throw new Error("Capture spool missing session_id.");
  }
  return value as CaptureSpool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read summaries from prior same-session captures, but ONLY from memories
 * that have evidence of durable commitment (context_id or pending file).
 * This prevents orphaned local files (written but never pushed/queued)
 * from suppressing re-extraction on retry.
 */
async function priorSessionSummaries(cwd: string, sessionId: string): Promise<string[]> {
  const dir = memoryDir(cwd);
  const pDir = pendingDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: string[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".md"))) {
    try {
      const raw = await readFile(join(dir, entry), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
      if (!match) continue;
      const fm = YAML.parse(match[1]) as Record<string, unknown>;
      if (fm?.session_id !== sessionId || typeof fm?.summary !== "string") continue;

      // Only include summaries from durably committed memories
      if (!isDurablyCommitted(fm, pDir)) continue;

      summaries.push(fm.summary);
    } catch {
      // Skip unreadable files
    }
  }
  return summaries;
}

/**
 * A memory is durably committed if it has at least one context_id (pushed)
 * or a corresponding pending file (queued). Orphaned local files that were
 * written but never pushed/queued are NOT durably committed.
 */
async function isDurablyCommitted(fm: Record<string, unknown>, pDir: string): Promise<boolean> {
  // Check for any context_id
  if (
    typeof fm.context_ids === "object" &&
    fm.context_ids !== null &&
    !Array.isArray(fm.context_ids) &&
    Object.values(fm.context_ids as Record<string, unknown>).some(
      (v) => (typeof v === "string" && v.trim()) || (Array.isArray(v) && v.length > 0)
    )
  ) {
    return true;
  }

  // Check for a pending file
  const captureId = typeof fm.id === "string" ? fm.id : undefined;
  if (!captureId) return false;
  const safeId = captureId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  for (const memoryType of ["fact", "procedural", "episodic"]) {
    try {
      await stat(join(pDir, `${safeId}.${memoryType}.json`));
      return true;
    } catch {
      // No pending file for this type
    }
  }
  return false;
}

async function logCaptureError(cwd: string, message: string, err?: unknown): Promise<void> {
  try {
    await logError(cwd, message, err);
  } catch {
    // Capture hooks must never fail the host command because local logging failed.
  }
}

/**
 * Read fingerprints from existing memory files, but ONLY for memories that have
 * evidence of durable commitment — i.e., the draft was either:
 *   1. Successfully pushed to Nia (has a `context_id` for that memory type), OR
 *   2. Queued to pending (a `.nctx/pending/<id>.<type>.json` file exists).
 *
 * This prevents the "fingerprint dedup stranding" bug: if the process is killed
 * after `writeMemoryFile` but before `pushDrafts` saves or queues, the next
 * capture would see the fingerprint, skip the draft as duplicate, and the memory
 * would never reach Nia. By requiring durable evidence, such orphaned memory
 * files are eligible for re-capture.
 *
 * Cross-session dedup is still intentional: e.g., a PreCompact in session A and
 * a SessionEnd in session B may extract the same decision.
 */
async function readExistingFingerprints(cwd: string, _sessionId: string): Promise<Set<string>> {
  const fingerprints = new Set<string>();
  const dir = memoryDir(cwd);
  const pDir = pendingDir(cwd);

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // Directory may not exist yet on first capture
    return fingerprints;
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));
  for (const file of mdFiles) {
    try {
      const raw = await readFile(join(dir, file), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
      if (!match) continue;

      const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
      const fps = frontmatter.fingerprints as Record<string, string> | undefined;
      if (!fps || typeof fps !== "object") continue;

      const contextIds =
        typeof frontmatter.context_ids === "object" &&
        frontmatter.context_ids !== null &&
        !Array.isArray(frontmatter.context_ids)
          ? (frontmatter.context_ids as Record<string, unknown>)
          : {};

      const captureId = typeof frontmatter.id === "string" ? frontmatter.id : undefined;
      const safeId = captureId?.replace(/[^a-zA-Z0-9_.-]/g, "-");

      for (const [memoryType, fp] of Object.entries(fps)) {
        // 1. Already pushed — context_id exists for this memory type
        if (contextIds[memoryType]) {
          fingerprints.add(fp);
          continue;
        }

        // 2. Queued to pending — pending file exists for this capture+type
        if (safeId) {
          try {
            await stat(join(pDir, `${safeId}.${memoryType}.json`));
            fingerprints.add(fp);
          } catch {
            // No pending file — fingerprint is NOT durably committed, skip it
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return fingerprints;
}
