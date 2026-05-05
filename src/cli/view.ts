import { findMemoryFile } from "../lib/memory-files.js";

export interface ViewOptions {
  cwd?: string;
  json?: boolean;
}

export async function runView(id: string, options: ViewOptions): Promise<void> {
  const projectRoot = options.cwd ?? process.cwd();
  const file = await findMemoryFile(projectRoot, id);
  if (!file) {
    throw new Error(`No NCtx memory found for ${id}`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          id: file.id,
          file_path: file.file_path,
          frontmatter: file.frontmatter,
          body: file.body
        },
        null,
        2
      )
    );
    return;
  }

  console.log(file.raw);
}
