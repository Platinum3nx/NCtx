import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock } from "../../src/lib/lock.js";

describe("withFileLock", () => {
  it("serializes work for the same lock path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nctx-lock-"));
    const lockPath = join(dir, "session.lock");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withFileLock(
      lockPath,
      async () => {
        events.push("first:start");
        firstStarted();
        await firstReleased;
        events.push("first:end");
      },
      { retryMs: 5, timeoutMs: 1_000 }
    );
    await firstHasLock;

    const second = withFileLock(
      lockPath,
      async () => {
        events.push("second");
      },
      { retryMs: 5, timeoutMs: 1_000 }
    );

    await sleep(30);
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
