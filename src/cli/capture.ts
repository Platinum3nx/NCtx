import { join } from "node:path";
import type { ContextDraft, HookInput, Trigger } from "../types.js";
import { loadConfig } from "../config/load.js";
import { readClaudeMd } from "../capture/claude-md.js";
import { buildContextDrafts } from "../capture/contexts.js";
import { extractMemory } from "../capture/extract.js";
import { backfillMemoryContextIds, writeMemoryFile } from "../capture/render.js";
import {
  defaultCaptureId,
  readSessionCursor,
  safeSessionFilePart,
  transcriptToText,
  writeSessionCursor
} from "../capture/transcript.js";
import { sessionsDir } from "../lib/fs.js";
import { withFileLock } from "../lib/lock.js";
import { asErrorMessage, logError } from "../lib/log.js";
import { drainPendingContexts, queuePending } from "../lib/pending.js";
import { makeClient } from "../nia/hosted.js";

const DEFAULT_STDIN_TIMEOUT_MS = 10_000;

export async function runCapture(trigger: Trigger): Promise<void> {
  if (process.env.NCTX_INTERNAL === "1") return;

  let cwd = process.cwd();

  try {
    const input = parseHookInput(await readStdin(), trigger);
    cwd = input.cwd || cwd;
    await withFileLock(sessionCaptureLockPath(cwd, input.session_id), async () => {
      const sinceLine = await readSessionCursor(cwd, input.session_id);
      const parsed = await transcriptToText(input.transcript_path, sinceLine);
      if (!parsed.text.trim()) {
        await writeSessionCursor(cwd, input.session_id, parsed.nextLine);
        return;
      }

      const claudeMd = await readClaudeMd(cwd);
      const extraction = await extractMemory(parsed.text, claudeMd);
      const config = await loadConfig(cwd);
      const captureId = defaultCaptureId(input.session_id);
      const drafts = buildContextDrafts(extraction, {
        captureId,
        projectName: config.project_name,
        sessionId: input.session_id,
        trigger,
        hookInput: input,
        toolActions: parsed.toolActions,
        nctxVersion: config.version
      });

      const contextIds: Record<string, string> = {};
      const memoryPath = await writeMemoryFile(cwd, {
        captureId,
        sessionId: input.session_id,
        trigger,
        hookInput: input,
        projectName: config.project_name,
        extraction,
        drafts,
        contextIds
      });
      await writeSessionCursor(cwd, input.session_id, parsed.nextLine);
      await pushDrafts(cwd, drafts, captureId, memoryPath, contextIds);
      await backfillMemoryContextIds(memoryPath, contextIds);
    });
  } catch (err) {
    await logCaptureError(cwd, `Capture failed: ${asErrorMessage(err)}`, err);
  }
}

async function pushDrafts(
  cwd: string,
  drafts: ContextDraft[],
  captureId: string,
  memoryPath: string,
  contextIds: Record<string, string>
): Promise<void> {
  if (!drafts.length) return;
  const config = await loadConfig(cwd);
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

function destroyInput(input: NodeJS.ReadableStream): void {
  const destroyable = input as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof destroyable.destroy === "function") destroyable.destroy();
}

function sessionCaptureLockPath(cwd: string, sessionId: string): string {
  return join(sessionsDir(cwd), `${safeSessionFilePart(sessionId)}.lock`);
}

async function logCaptureError(cwd: string, message: string, err?: unknown): Promise<void> {
  try {
    await logError(cwd, message, err);
  } catch {
    // Capture hooks must never fail the host command because local logging failed.
  }
}
