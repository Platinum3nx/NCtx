import type { ContextDraft, HookInput, Trigger } from "../types.js";
import { loadConfig } from "../config/load.js";
import { readClaudeMd } from "../capture/claude-md.js";
import { buildContextDrafts } from "../capture/contexts.js";
import { extractMemory } from "../capture/extract.js";
import { backfillMemoryContextIds, writeMemoryFile } from "../capture/render.js";
import { defaultCaptureId, readSessionCursor, transcriptToText, writeSessionCursor } from "../capture/transcript.js";
import { asErrorMessage, logError } from "../lib/log.js";
import { drainPendingContexts, queuePending } from "../lib/pending.js";
import { makeClient } from "../nia/hosted.js";

export async function runCapture(trigger: Trigger): Promise<void> {
  if (process.env.NCTX_INTERNAL === "1") return;

  let hookInput: HookInput | null = null;
  let cwd = process.cwd();

  try {
    hookInput = parseHookInput(await readStdin(), trigger);
    cwd = hookInput.cwd || cwd;
    const sinceLine = await readSessionCursor(cwd, hookInput.session_id);
    const parsed = await transcriptToText(hookInput.transcript_path, sinceLine);
    if (!parsed.text.trim()) {
      await writeSessionCursor(cwd, hookInput.session_id, parsed.nextLine);
      return;
    }

    const claudeMd = await readClaudeMd(cwd);
    const extraction = await extractMemory(parsed.text, claudeMd);
    const config = await loadConfig(cwd);
    const captureId = defaultCaptureId(hookInput.session_id);
    const drafts = buildContextDrafts(extraction, {
      captureId,
      projectName: config.project_name,
      sessionId: hookInput.session_id,
      trigger,
      hookInput,
      toolActions: parsed.toolActions,
      nctxVersion: config.version
    });

    const contextIds: Record<string, string> = {};
    const memoryPath = await writeMemoryFile(cwd, {
      captureId,
      sessionId: hookInput.session_id,
      trigger,
      hookInput,
      projectName: config.project_name,
      extraction,
      drafts,
      contextIds
    });
    await pushDrafts(cwd, drafts, captureId, memoryPath, contextIds);
    await writeSessionCursor(cwd, hookInput.session_id, parsed.nextLine);
    await backfillMemoryContextIds(memoryPath, contextIds);
  } catch (err) {
    await logError(cwd, `Capture failed: ${asErrorMessage(err)}`, err);
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

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
