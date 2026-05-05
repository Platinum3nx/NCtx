import { constants } from "node:fs";
import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "./fs.js";

export type FileLockOptions = {
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
};

const DEFAULT_RETRY_MS = 50;
const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const release = await acquireFileLock(path, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function acquireFileLock(path: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const startedAt = Date.now();

  await ensureDir(dirname(path));

  while (true) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${token}\n${new Date().toISOString()}\n`, "utf8");
      await handle.close();
      return async () => {
        await releaseFileLock(path, token);
      };
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") throw err;

      if (await removeStaleLock(path, staleMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out acquiring lock ${path}`);
      }
      await sleep(retryMs);
    }
  }
}

async function releaseFileLock(path: string, token: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.split("\n", 1)[0] !== token) return;
    await rm(path, { force: true });
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") throw err;
  }
}

async function removeStaleLock(path: string, staleMs: number): Promise<boolean> {
  if (staleMs <= 0) return false;
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs < staleMs) return false;
    await rm(path, { force: true });
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return true;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
