import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextDraft } from "../types.js";
import type { NiaClient } from "../nia/client.js";
import { ensureDir, pendingDir } from "./fs.js";
import { withFileLock } from "./lock.js";

export type PendingContext = {
  id: string;
  draft: ContextDraft;
  memory_path?: string;
  last_error?: string;
  attempts?: number;
  created_at?: string;
  saved_context_id?: string;
  saved_at?: string;
};

export type PendingContextFile = PendingContext & {
  file_path: string;
};

export type EnqueuePendingContextInput = {
  captureId: string;
  memoryType: ContextDraft["memory_type"];
  request: ContextDraft | (Partial<ContextDraft> & Pick<ContextDraft, "title" | "summary" | "content" | "memory_type">);
  error?: unknown;
};

export type DrainPendingResult = {
  saved: Array<{
    file_path: string;
    pending: PendingContextFile;
    response: Awaited<ReturnType<NiaClient["saveContext"]>>;
  }>;
  failed: Array<{ file_path: string; error: Error; pending?: PendingContextFile }>;
};

type PendingReadResult = {
  pending: PendingContextFile[];
  corrupt: Array<{ file_path: string; error: Error }>;
};

export async function queuePending(
  cwd: string,
  id: string,
  draft: ContextDraft,
  options: { memoryPath?: string; error?: unknown } = {}
): Promise<string> {
  const dir = pendingDir(cwd);
  await ensureDir(dir);
  const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const path = join(dir, `${safeId}.${draft.memory_type}.json`);
  const body: PendingContext = {
    id,
    draft,
    memory_path: options.memoryPath,
    last_error: options.error ? errorMessage(options.error) : undefined,
    attempts: 0,
    created_at: new Date().toISOString()
  };
  await writePendingFile(path, body);
  return path;
}

export async function enqueuePendingContext(
  cwd: string,
  input: EnqueuePendingContextInput
): Promise<string> {
  const draft = normalizeDraft(input.request, input.memoryType);
  const dir = pendingDir(cwd);
  await ensureDir(dir);
  const safeId = input.captureId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const path = join(dir, `${safeId}.${input.memoryType}.json`);
  const body: PendingContext = {
    id: input.captureId,
    draft,
    last_error: input.error ? errorMessage(input.error) : undefined,
    attempts: 0,
    created_at: new Date().toISOString()
  };
  await writePendingFile(path, body);
  return path;
}

export async function listPending(cwd: string): Promise<PendingContext[]> {
  return (await readPendingContextFiles(cwd)).pending.map(({ file_path: _filePath, ...pending }) => pending);
}

export async function listPendingContexts(cwd: string): Promise<PendingContextFile[]> {
  return (await readPendingContextFiles(cwd)).pending;
}

async function readPendingContextFiles(cwd: string): Promise<PendingReadResult> {
  const dir = pendingDir(cwd);
  try {
    const entries = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    const pending: PendingContextFile[] = [];
    const corrupt: PendingReadResult["corrupt"] = [];
    for (const entry of entries) {
      const filePath = join(dir, entry);
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as PendingContext;
        pending.push({ ...parsed, file_path: filePath });
      } catch (error) {
        corrupt.push({ file_path: filePath, error: toError(error) });
      }
    }
    return { pending, corrupt };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { pending: [], corrupt: [] };
    throw error;
  }
}

export async function removePending(cwd: string, pending: PendingContext): Promise<void> {
  const dir = pendingDir(cwd);
  const safeId = pending.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  await rm(join(dir, `${safeId}.${pending.draft.memory_type}.json`), { force: true });
}

export async function removePendingContext(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export async function drainPendingContexts(
  cwd: string,
  client: NiaClient,
  options: { limit?: number } = {}
): Promise<DrainPendingResult> {
  return withFileLock(join(pendingDir(cwd), ".drain.lock"), () => drainPendingContextsUnlocked(cwd, client, options));
}

async function drainPendingContextsUnlocked(
  cwd: string,
  client: NiaClient,
  options: { limit?: number } = {}
): Promise<DrainPendingResult> {
  const listed = await readPendingContextFiles(cwd);
  const pending = listed.pending.slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  const saved: DrainPendingResult["saved"] = [];
  const failed: DrainPendingResult["failed"] = [...listed.corrupt];

  for (const item of pending) {
    // If this item was already saved (e.g., process died before backfill+delete),
    // skip the saveContext call and surface it as saved so the caller can finish
    // backfill and delete.
    if (item.saved_context_id) {
      saved.push({
        file_path: item.file_path,
        pending: item,
        response: { id: item.saved_context_id } as Awaited<ReturnType<NiaClient["saveContext"]>>
      });
      continue;
    }
    try {
      const response = await client.saveContext(item.draft);
      // Mark as saved but don't delete yet — let the caller delete after backfill
      // to avoid losing the context_id if the process dies before backfill completes.
      const savedItem: PendingContext = {
        ...item,
        saved_context_id: response.id,
        saved_at: new Date().toISOString()
      };
      const { file_path: _, ...body } = savedItem as PendingContextFile;
      await writePendingFile(item.file_path, body);
      saved.push({ file_path: item.file_path, pending: item, response });
    } catch (error) {
      const next = {
        ...item,
        attempts: (item.attempts ?? 0) + 1,
        last_error: errorMessage(error)
      };
      const { file_path: _filePath, ...body } = next;
      await writePendingFile(item.file_path, body);
      failed.push({ file_path: item.file_path, error: toError(error), pending: item });
    }
  }

  return { saved, failed };
}

async function writePendingFile(path: string, body: PendingContext): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

function normalizeDraft(
  request: EnqueuePendingContextInput["request"],
  memoryType: ContextDraft["memory_type"]
): ContextDraft {
  return {
    tags: [],
    metadata: {},
    ...request,
    memory_type: memoryType
  } as ContextDraft;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
