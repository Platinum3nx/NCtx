import { test } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  capabilitiesFromHelp,
  extractWithClaude,
  parseClaudeJsonOutput,
  warningsForCapabilities
} from "../../src/capture/extract.js";

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
    parseClaudeJsonOutput('{"structured_output":{"summary":"ok"}}'),
    { summary: "ok" }
  );
  assert.deepEqual(
    parseClaudeJsonOutput('{"result":"{\\"summary\\":\\"ok\\"}"}'),
    { summary: "ok" }
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
