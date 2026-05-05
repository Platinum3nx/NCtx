import { test } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  capabilitiesFromHelp,
  extractWithClaude,
  getClaudeCapabilities,
  parseClaudeJsonOutput,
  warningsForCapabilities
} from "../../src/capture/extract.js";

const EXTRACTION = {
  summary: "ok",
  tags: ["stripe"],
  files_touched: ["src/webhook.ts"],
  decisions: [{ title: "Use Redis", rationale: "Stripe retries reuse event ids.", files: ["src/webhook.ts"] }],
  gotchas: [],
  patterns: [],
  state: { in_progress: null, next_steps: [], files: [] }
};

test("buildClaudeArgs uses feature-detected safe headless flags", () => {
  const caps = capabilitiesFromHelp("--tools\n--no-session-persistence\n--json-schema\n--model\n");
  const args = buildClaudeArgs({ type: "object" }, caps);

  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.equal(args.includes("--no-session-persistence"), true);
  assert.equal(args.includes("--json-schema"), true);
  assert.equal(args.includes("--model"), true);
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--bare-no"), false);
});

test("missing claude feature flags produce warnings and safe fallbacks", () => {
  const caps = capabilitiesFromHelp("--print\n");
  const args = buildClaudeArgs({ type: "object" }, caps);

  assert.deepEqual(args, ["-p", "--output-format", "json"]);
  assert.match(warningsForCapabilities(caps).join("\n"), /--tools/);
});

test("parseClaudeJsonOutput accepts structured_output and result JSON strings", () => {
  assert.deepEqual(
    parseClaudeJsonOutput(JSON.stringify({ structured_output: EXTRACTION })),
    EXTRACTION
  );
  assert.deepEqual(
    parseClaudeJsonOutput(JSON.stringify({ result: JSON.stringify(EXTRACTION) })),
    EXTRACTION
  );
});

test("parseClaudeJsonOutput rejects Claude wrapper metadata without extraction content", () => {
  assert.throws(
    () =>
      parseClaudeJsonOutput(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 100 },
          metadata: { summary: "not the extraction payload" }
        })
      ),
    /summary must be a string/
  );
});

test("getClaudeCapabilities reports missing Claude Code CLI clearly", () => {
  const missingClaude = join(mkdtempSync(join(tmpdir(), "nctx-missing-claude-")), "claude");
  assert.throws(
    () => getClaudeCapabilities(missingClaude),
    /Claude Code CLI is not installed or not on PATH/
  );
});

test("getClaudeCapabilities reports claude --help failures clearly", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nctx-help-failed-"));
  const claudePath = join(cwd, "fake-claude");
  writeFileSync(
    claudePath,
    `#!/bin/sh
echo "help exploded" >&2
exit 42
`,
    "utf8"
  );
  chmodSync(claudePath, 0o755);

  assert.throws(
    () => getClaudeCapabilities(claudePath),
    /Unable to run `.*fake-claude --help` to detect Claude Code capabilities\. exited 42: help exploded/
  );
});

test("extractWithClaude spawns claude with NCTX_INTERNAL=1 and normalizes output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nctx-extract-"));
  const argsPath = join(cwd, "args.txt");
  const promptPath = join(cwd, "prompt.txt");
  const claudePath = join(cwd, "fake-claude");
  writeFileSync(
    claudePath,
    `#!/bin/sh
if [ "$NCTX_INTERNAL" != "1" ]; then
  echo "missing internal guard" >&2
  exit 9
fi
printf '%s\\n' "$*" > "${argsPath}"
cat > "${promptPath}"
printf '%s\\n' '{"structured_output":{"summary":"Chose Redis webhook dedup","tags":["stripe"],"files_touched":["src/webhook.ts"],"decisions":[{"title":"Redis event dedup","rationale":"Stripe retries reuse event IDs","files":["src/webhook.ts"]}],"gotchas":[],"patterns":[],"state":{"in_progress":null,"next_steps":[],"files":[]}}}'
`,
    "utf8"
  );
  chmodSync(claudePath, 0o755);

  const extraction = await extractWithClaude("TRANSCRIPT", { type: "object" }, {
    claudePath,
    cwd,
    capabilities: {
      hasTools: true,
      hasNoSessionPersistence: true,
      hasJsonSchema: true,
      hasModel: true
    }
  });

  const args = readFileSync(argsPath, "utf8");
  assert.match(args, /-p --output-format json --json-schema/);
  assert.match(args, /--tools/);
  assert.match(args, /--no-session-persistence/);
  assert.match(args, /--model haiku/);
  assert.equal(readFileSync(promptPath, "utf8"), "TRANSCRIPT");
  assert.equal(extraction.summary, "Chose Redis webhook dedup");
  assert.equal(extraction.decisions[0]?.title, "Redis event dedup");
});
