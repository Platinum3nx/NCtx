import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type WriteJsonOptions = {
  mode?: number;
};

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown, options: WriteJsonOptions = {}): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: options.mode
  });
  if (options.mode !== undefined) await chmod(path, options.mode);
}

export function nctxDir(cwd: string): string {
  return join(cwd, ".nctx");
}

export function memoryDir(cwd: string): string {
  return join(nctxDir(cwd), "memories");
}

export function pendingDir(cwd: string): string {
  return join(nctxDir(cwd), "pending");
}

export function spoolDir(cwd: string): string {
  return join(nctxDir(cwd), "spool");
}

export function sessionsDir(cwd: string): string {
  return join(nctxDir(cwd), "sessions");
}
