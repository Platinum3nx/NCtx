import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { memoryDir } from "../lib/fs.js";

export async function runList(cwd: string): Promise<void> {
  const dir = memoryDir(cwd);
  const entries = (await readdir(dir).catch(() => [])).filter((entry) => entry.endsWith(".md")).sort();
  for (const entry of entries) {
    const raw = await readFile(join(dir, entry), "utf8");
    const frontmatter = parseFrontmatter(raw);
    console.log(`${entry}\t${frontmatter.summary ?? ""}`);
  }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? (YAML.parse(match[1]) as Record<string, unknown>) : {};
}
