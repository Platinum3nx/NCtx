import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, nctxDir } from "./fs.js";

export async function logError(cwd: string, message: string, err?: unknown): Promise<void> {
  const dir = nctxDir(cwd);
  await ensureDir(dir);
  const detail = err instanceof Error ? `${err.stack ?? err.message}` : err ? JSON.stringify(err) : "";
  const line = `[${new Date().toISOString()}] ${message}${detail ? `\n${detail}` : ""}\n`;
  await appendFile(join(dir, "errors.log"), line, "utf8");
}

export function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function appendErrorLog(
  cwd: string,
  entry: { message: string; stack?: string; details?: unknown }
): Promise<void> {
  await logError(cwd, entry.message, entry.stack ?? entry.details);
}
