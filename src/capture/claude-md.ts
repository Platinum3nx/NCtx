import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readClaudeMd(cwd: string, maxBytes = 4096): string {
  const path = join(cwd, "CLAUDE.md");
  if (!existsSync(path)) return "";
  const bytes = readFileSync(path);
  return bytes.subarray(0, safeUtf8ByteCap(bytes, maxBytes)).toString("utf8");
}

function safeUtf8ByteCap(bytes: Buffer, maxBytes: number): number {
  if (maxBytes <= 0) return 0;
  let end = Math.min(maxBytes, bytes.length);
  if (end === bytes.length) return end;

  let start = end - 1;
  while (start >= 0 && isUtf8ContinuationByte(bytes[start])) start--;
  if (start < 0) return 0;

  const expectedLength = utf8SequenceLength(bytes[start]);
  if (expectedLength > 1 && end - start < expectedLength) end = start;
  return end;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(leadByte: number): number {
  if (leadByte < 0x80) return 1;
  if ((leadByte & 0xe0) === 0xc0) return 2;
  if ((leadByte & 0xf0) === 0xe0) return 3;
  if ((leadByte & 0xf8) === 0xf0) return 4;
  return 1;
}
