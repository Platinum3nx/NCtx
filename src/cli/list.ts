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

export async function runView(cwd: string, id: string): Promise<void> {
  const dir = memoryDir(cwd);
  const entries = (await readdir(dir).catch(() => [])).filter((entry) => entry.includes(id) && entry.endsWith(".md"));
  if (!entries.length) throw new Error(`No memory matched ${id}`);
  console.log(await readFile(join(dir, entries[0]), "utf8"));
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? (YAML.parse(match[1]) as Record<string, unknown>) : {};
}

