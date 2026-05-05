import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("npm packaging", () => {
  it("builds dist before npm pack and publish lifecycles", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts.prepack).toBe("npm run build");
  });
});
