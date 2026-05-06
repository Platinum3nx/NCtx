import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configPath, findProjectRoot, tryLoadConfig, memoriesDir, pendingContextsDir } from "../config/load.js";
import { listMemoryFiles } from "../lib/memory-files.js";

export async function runStatus(cwd: string): Promise<void> {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    console.log("NCtx is not initialized in this project or any parent directory.");
    return;
  }

  const config = await tryLoadConfig(projectRoot);
  const projectName = config?.project_name ?? "unknown";

  const memDir = memoriesDir(projectRoot);
  const pendDir = pendingContextsDir(projectRoot);

  // Count .md files in memories/
  const memoryFiles = await safeReaddir(memDir);
  const mdFiles = memoryFiles.filter((f) => f.endsWith(".md"));
  const memoryCount = mdFiles.length;

  // Read pending directory
  const pendingFiles = await safeReaddir(pendDir);

  // Find most recent mtime from memories/ files
  let lastCaptureTime: Date | null = null;
  for (const file of mdFiles) {
    try {
      const s = await stat(join(memDir, file));
      if (!lastCaptureTime || s.mtime > lastCaptureTime) {
        lastCaptureTime = s.mtime;
      }
    } catch {
      // skip files we can't stat
    }
  }

  // Count pushed contexts: sum context_ids entries across memory frontmatter
  let pushedCount = 0;
  try {
    const memories = await listMemoryFiles(projectRoot);
    for (const memory of memories) {
      const contextIds = memory.frontmatter.context_ids;
      if (typeof contextIds === "object" && contextIds !== null && !Array.isArray(contextIds)) {
        for (const value of Object.values(contextIds as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim()) {
            pushedCount += 1;
          } else if (Array.isArray(value)) {
            pushedCount += value.filter(v => typeof v === "string" && v.trim()).length;
          }
        }
      }
    }
  } catch {
    // If we can't read memories, pushed count stays 0
  }

  // Detect mode
  const isPlugin = Boolean(process.env.CLAUDE_PLUGIN_ROOT);
  const mode = isPlugin ? "hosted (plugin)" : "hosted (standalone CLI)";

  // Format last capture time
  const lastCapture = lastCaptureTime ? formatRelativeTime(lastCaptureTime) : "never";

  // Check config.json permissions
  let configPerms = "unknown";
  try {
    const cfgPath = configPath(projectRoot);
    const cfgStat = await stat(cfgPath);
    const mode_bits = cfgStat.mode & 0o777;
    configPerms = mode_bits === 0o600 ? "owner-only" : "WARNING - readable by others";
  } catch {
    configPerms = "missing";
  }

  // Count valid and corrupt pending files in one pass
  const jsonPendingFiles = pendingFiles.filter((f) => f.endsWith(".json"));
  let validPendingCount = 0;
  let corruptCount = 0;
  for (const file of jsonPendingFiles) {
    try {
      const content = await readFile(join(pendDir, file), "utf8");
      JSON.parse(content);
      validPendingCount++;
    } catch {
      corruptCount++;
    }
  }

  const pendingStatus = corruptCount > 0
    ? `Pending: ${validPendingCount} queued, ${corruptCount} corrupt`
    : `Pending: ${validPendingCount} queued`;

  console.log(
    [
      `NCtx status for project: ${projectName}`,
      `Mode: ${mode}`,
      `Last capture: ${lastCapture}`,
      `Local memories: ${memoryCount}`,
      `Pushed contexts: ${pushedCount}`,
      pendingStatus,
      `Config permissions: ${configPerms}`,
      `Project root: ${projectRoot}`
    ].join("\n")
  );
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
