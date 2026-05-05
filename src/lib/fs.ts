import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

export function sessionsDir(cwd: string): string {
  return join(nctxDir(cwd), "sessions");
}

