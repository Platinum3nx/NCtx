import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeMd } from "../../src/capture/claude-md.js";

test("readClaudeMd returns empty string when project memory is absent", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nctx-claude-md-empty-"));
  assert.equal(readClaudeMd(cwd), "");
});

test("readClaudeMd caps CLAUDE.md content at the requested byte budget", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nctx-claude-md-"));
  writeFileSync(join(cwd, "CLAUDE.md"), `${"a".repeat(5000)}distinctive-tail`, "utf8");

  const content = readClaudeMd(cwd, 4096);

  assert.equal(Buffer.byteLength(content), 4096);
  assert.doesNotMatch(content, /distinctive-tail/);
});

test("readClaudeMd does not split multi-byte UTF-8 characters at the byte cap", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nctx-claude-md-utf8-"));
  writeFileSync(join(cwd, "CLAUDE.md"), "prefix 🧠 suffix", "utf8");

  const capInsideEmoji = Buffer.byteLength("prefix ", "utf8") + 1;
  const content = readClaudeMd(cwd, capInsideEmoji);

  assert.equal(content, "prefix ");
  assert.equal(content.includes("\uFFFD"), false);
  assert.ok(Buffer.byteLength(content, "utf8") <= capInsideEmoji);
});
