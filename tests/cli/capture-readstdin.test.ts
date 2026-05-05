import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdin } from "../../src/cli/capture.js";

describe("capture stdin", () => {
  it("returns data when stdin ends before the timeout", async () => {
    const stream = new PassThrough();
    const read = readStdin(stream, 100);

    stream.end('{"session_id":"sid"}');

    await expect(read).resolves.toBe('{"session_id":"sid"}');
  });

  it("times out when stdin never closes", async () => {
    const stream = new PassThrough();

    await expect(readStdin(stream, 5)).rejects.toThrow(/Timed out waiting for hook JSON on stdin/);
    stream.destroy();
  });
});
