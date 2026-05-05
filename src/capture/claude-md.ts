import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readClaudeMd(cwd: string, maxBytes = 4096): string {
  const path = join(cwd, "CLAUDE.md");
  if (!existsSync(path)) return "";
  return readFileSync(path).subarray(0, maxBytes).toString("utf8");
}
