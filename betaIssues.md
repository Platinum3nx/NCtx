# Beta Issues

Issues found during the full codebase review. They focus on issues that interfere with the project goal: a Claude Code plugin that provides automatic project memory by capturing, isolating, and retrieving Nia-backed context reliably.

**Status: OPEN FOLLOW-UP ISSUES FOUND** (verification still passes, but the latest fix review found two partial-fix gaps that can keep capture durability and plugin diagnostics from fully meeting the beta goal)

---

## Fix Review Findings — Open

### Finding 1. Orphaned captures can still suppress retry extraction

- Priority: P1
- File: `src/cli/capture.ts`
- Issue: `readExistingFingerprints` now ignores local memories without `context_ids` or pending files, but `priorSessionSummaries` still feeds those same non-durable local memories into the extraction prompt as "previously captured" from the same session.
- Impact: If the hook exits after `writeMemoryFile` but before the memory is saved or queued, the retry can be told not to re-extract the orphaned memory before the dedupe gate ever runs. Hosted Nia/MCP recall can still miss the memory.
- Suggested fix: Exclude non-durable memories from `priorSessionSummaries`, or mark and drain orphaned local memories explicitly so retry extraction is not suppressed by unpushed local files.

### Finding 2. Plugin doctor still does not prove MCP can start

- Priority: P2
- File: `src/config/mcp-register.ts`
- Issue: The plugin-mode doctor fix verifies that the configured CLI file exists, but it does not verify that the MCP server starts or can list the `nctx_memory` tool.
- Impact: A present but crashing `dist/cli/index.js` can still make `nctx doctor` report `toolRegistered: true`, leaving the automatic recall path broken while diagnostics look healthy.
- Suggested fix: Perform a lightweight MCP `tools/list` handshake against the configured plugin server, or reuse an actual `claude mcp list` status, before marking the plugin MCP tool registered.

---

## Full Review Findings — Resolved

### Finding 1. Local fingerprints can strand an unsaved capture — FIXED

- Priority: P1
- File: `src/cli/capture.ts`
- Fix: `readExistingFingerprints` now only includes a fingerprint in the dedup set when there is evidence of durable commitment for that memory type: either a `context_id` in the memory frontmatter (pushed to Nia) or a corresponding pending file in `.nctx/pending/` (queued for push). Fingerprints from memories that were written locally but not yet pushed or queued do not block dedup, allowing the next capture to retry.

### Finding 2. Text fallback can still crash semantic retrieval — FIXED

- Priority: P2
- File: `worker/src/index.ts`
- Fix: Wrapped the entire body of `safeTextFallback` in a try/catch that returns `[]` on any exception. Non-timeout fetch errors (DNS, TLS, network) no longer propagate up and crash the semantic search path. Two tests verify the fix.

### Finding 3. Pending retries are deleted before local backfill is durable — FIXED

- Priority: P2
- File: `src/lib/pending.ts`
- Fix: `drainPendingContexts` no longer deletes pending files after save. Instead, it marks them with `saved_context_id` and `saved_at`. The callers (`capture.ts` pushDrafts and `reindex.ts`) now delete pending files explicitly AFTER backfilling the `context_id` into the local memory file. A re-run of drain detects already-saved pending files and returns them without making another API call.

### Finding 4. Plugin-mode doctor can report MCP healthy without a working server — FIXED

- Priority: P2
- File: `src/config/mcp-register.ts`
- Fix: `getPluginMcpStatus` now verifies the configured CLI entry point exists on disk via `access()` after checking the config shape. If the binary is missing, doctor reports `toolRegistered: false` with a diagnostic message identifying the missing path.

## Full Review Findings — Deferred (Not Beta Blockers)

### Finding 5. Local `list` and `view` ignore the initialized project root — P3 DEFERRED

- Files: `src/cli/list.ts`, `src/cli/view.ts`
- Why deferred: `list` and `view` are manual inspection commands, not part of the automatic capture/retrieval pipeline. The core product (hooks → capture → Nia → MCP retrieval) uses `findProjectRoot` correctly. The gap only affects users who manually run `nctx list` from a monorepo subdirectory. Simple fix for a post-beta pass.

### Finding 6. Worker build tooling requires a higher Node version than the root package advertises — P3 DEFERRED

- Files: `package.json`, `worker/package.json`
- Why deferred: This affects only the developer deploying the Worker, not end users. The Worker is already deployed at `nctx.amalghan70.workers.dev`. Users never run `wrangler`. A documentation or engine-field update for a post-beta pass.

---

## Implementation Review Findings — Resolved

### Finding 1. Self-contained bundle still cannot start — FIXED

- Priority: P1
- File: `tsup.config.ts`
- Fix: Added `banner` with `createRequire` shim so bundled CJS code (yaml's `require("process")`) resolves Node built-ins correctly within the ESM bundle. `node dist/cli/index.js --version` now prints `0.1.3` without crashing.

### Finding 2. Fixed plugin artifact is not installable as a new version — FIXED

- Priority: P1
- Files: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/lib/constants.ts`
- Fix: All version references bumped from `0.1.2` to `0.1.3`. Ready for `npm publish`.

---

## Implementation Review Findings — Deferred (Not Beta Blockers)

These are real defense-in-depth gaps but do not affect any beta user under normal conditions. They require either a compromised upstream (Nia/Worker) or a Nia API behavior change that has never been observed.

### Finding 3. Semantic `contexts` envelope remains invisible to MCP — P3 DEFERRED

- File: `worker/src/isolation.ts`
- Why deferred: Nia's semantic search endpoint always returns `results`, never `contexts` (per PRD and live testing). The `contexts` envelope is from the text search endpoint. The defensive filter for `body.contexts` is applied but downstream prefers `body.results` when it exists. This is a theoretical gap only.

### Finding 4. Memory-type tags can still be evicted — P3 DEFERRED

- File: `src/capture/contexts.ts`
- Why deferred: Category tags (`decisions`, `gotchas`, `patterns`, `state`, `next-steps`) serve only one purpose — the Worker's `normalizeMemoryTypeFromTags` fallback. The `memory_type` field is set explicitly on every draft and preserved by Nia on save. Even if tags are evicted, memory type still works via the explicit field. The tags are a backup normalization, not the primary mechanism.

### Finding 5. Retrieved metadata is sanitized but still trusted — P3 DEFERRED

- File: `src/mcp/format.ts`
- Why deferred: `created_at` and `memory_type` are now sanitized (control chars stripped, capped at 100 chars). A single-line injection like "Ignore previous instructions" could survive sanitization but: (a) requires a compromised Nia API or Worker, (b) appears as `Date: <text>` which Claude is unlikely to follow as instructions, (c) the value comes from Nia's response which the Worker proxies without modification.

### Finding 6. Remote error strings still become trusted tool text — P3 DEFERRED

- File: `src/mcp/client.ts`
- Why deferred: Error detail is now sanitized (control chars replaced, capped at 200 chars) and appears inside an `isError: true` MCP response. Requires a compromised Worker to inject malicious content. Claude interprets `isError` responses as failures, not instructions.

---

## P1 — Fixed (Prior Round)

### 1. Plugin cache cannot execute bundled CLI — FIXED

- File: `tsup.config.ts`
- Fix: Added `noExternal: [/.*/]` + `banner` with `createRequire` shim. The built `dist/cli/index.js` is a self-contained 1.09 MB bundle that starts cleanly.

### 2. Cursor advances before current save is durable — FIXED

- File: `src/cli/capture.ts`
- Fix: `writeSessionCursor` moved to after `pushDrafts` and `backfillMemoryContextIds`. Cursor only advances after all drafts are pushed or queued.

### 3. Required project tags can be evicted — FIXED

- File: `src/capture/contexts.ts`
- Fix: Required tags (`project:<name>`, trigger, `nctx`) placed first before extraction tags, guaranteeing survival past the 30-tag cap.

### 4. Project-scoped text recall can still miss matches — DOCUMENTED LIMITATION

- File: `worker/src/isolation.ts`
- Status: Known design limitation. One-install-per-project model makes install-tag filtering sufficient. See `betaImprovements.md` Known Design Limitations.

## P2 — Fixed (Prior Round)

### 5. Semantic failures skip available text fallback — FIXED

- File: `worker/src/index.ts`
- Fix: `textFallbackOrError` tries text search when semantic fails before returning error.

### 6. Semantic filter ignores `contexts` envelopes — FIXED

- File: `worker/src/isolation.ts`
- Fix: Defensive filter added for `body.contexts` array.

### 7. Pending duplicates bypass fingerprint dedupe — FIXED

- File: `src/cli/capture.ts`
- Fix: `readExistingFingerprints` includes all local fingerprints regardless of push status.

### 8. MCP formatter trusts retrieved metadata — FIXED

- File: `src/mcp/format.ts`
- Fix: `sanitizeMeta` strips control chars, caps at 100 chars.

### 9. Remote error details become trusted tool text — FIXED

- File: `src/mcp/client.ts`
- Fix: `sanitizeErrorDetail` strips control chars, caps at 200 chars.

### 10. Proxy changes reuse incompatible tokens — FIXED

- File: `src/cli/init.ts`
- Fix: Detects proxy URL change and forces new token mint.
