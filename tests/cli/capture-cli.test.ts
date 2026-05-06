import { spawn } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx");

describe("capture CLI exit behavior", () => {
  it("exits 0 for capture yargs errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nctx-cli-"));
    const result = await runCli(["capture"], { cwd });

    expect(result.code).toBe(0);
    await expect(readFile(join(cwd, ".nctx", "errors.log"), "utf8")).resolves.toContain(
      "Missing required argument: trigger"
    );
  });

  it("exits 0 and logs for capture handler errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nctx-cli-"));
    const result = await runCli(["capture", "--trigger=manual"], { cwd, stdin: "{" });

    expect(result.code).toBe(0);
    await expect(readFile(join(cwd, ".nctx", "errors.log"), "utf8")).resolves.toContain("Capture failed");
  });

  it("keeps non-capture yargs errors nonzero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nctx-cli-"));
    const result = await runCli(["not-a-command"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown argument: not-a-command");
  });
});

function runCli(args: string[], options: { cwd: string; stdin?: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxLoaderPath, join(process.cwd(), "src/cli/index.ts"), ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        NCTX_CAPTURE_STDIN_TIMEOUT_MS: "20"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}
