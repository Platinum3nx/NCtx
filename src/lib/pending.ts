import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextDraft } from "../types.js";
import type { NiaClient } from "../nia/client.js";
import { ensureDir, pendingDir } from "./fs.js";

export type PendingContext = {
  id: string;
  draft: ContextDraft;
  memory_path?: string;
  last_error?: string;
  attempts?: number;
  created_at?: string;
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
  failed: Array<{ file_path: string; error: Error }>;
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
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
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
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return path;
}

export async function listPending(cwd: string): Promise<PendingContext[]> {
  const dir = pendingDir(cwd);
  try {
    const entries = await readdir(dir);
    const results: PendingContext[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as PendingContext;
      results.push(parsed);
    }
    return results;
  } catch {
    return [];
  }
}

export async function listPendingContexts(cwd: string): Promise<PendingContextFile[]> {
  const dir = pendingDir(cwd);
  try {
    const entries = await readdir(dir);
    const results: PendingContextFile[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const filePath = join(dir, entry);
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as PendingContext;
      results.push({ ...parsed, file_path: filePath });
    }
    return results;
  } catch {
    return [];
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
  const pending = (await listPendingContexts(cwd)).slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  const saved: DrainPendingResult["saved"] = [];
  const failed: DrainPendingResult["failed"] = [];

  for (const item of pending) {
    try {
      const response = await client.saveContext(item.draft);
      await removePendingContext(item.file_path);
      saved.push({ file_path: item.file_path, pending: item, response });
    } catch (error) {
      const next = {
        ...item,
        attempts: (item.attempts ?? 0) + 1,
        last_error: errorMessage(error)
      };
      const { file_path: _filePath, ...body } = next;
      await writeFile(item.file_path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      failed.push({ file_path: item.file_path, error: toError(error) });
    }
  }

  return { saved, failed };
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
