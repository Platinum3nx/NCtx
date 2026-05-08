# Beta Issues

Issues found during the full codebase review. They focus on issues that interfere with the project goal: a Claude Code plugin that provides automatic project memory by capturing, isolating, and retrieving Nia-backed context reliably.

**Status: BYOK DIRECT NIA IMPLEMENTED, VERIFIED, AND PUBLISHED AS `@platinum3nx/nctx@0.1.4`**

---

## BYOK Direct Nia Mode — Implemented

### Finding 0. Normal plugin use must be direct BYOK, not hosted Worker — FIXED

- Priority: P1 release prerequisite
- Files: `src/cli/init.ts`, `src/nia/direct.ts`, `src/nia/client.ts`, `src/mcp/client.ts`, `src/mcp/config.ts`, `src/cli/doctor.ts`, `src/cli/status.ts`, tests and docs.
- Behavior: `nctx init --plugin` accepts or prompts for a user Nia API key, writes direct-mode `.nctx/config.json`, rejects hosted Worker credentials in direct configs, saves/searches Nia directly with the user's bearer token, strips legacy hosted `install:*` data, and scopes retrieval to the configured project.
- Migration: Re-running init with a Nia key over an old hosted config removes `install_token`/`proxy_url`; `nctx reindex` drains existing local `.nctx/pending/` drafts and backfills direct Nia context IDs.
- Verification: `npm run typecheck`, `npm test`, `npm run build`, worker typecheck/tests, packed tarball `--version`, and packed tarball BYOK init smoke all pass.

### Finding 1. `0.1.4` npm publish is blocked by local npm auth — FIXED

- Priority: P1 release prerequisite
- File: local npm auth, not code.
- Status: The stale `~/.npmrc` token still fails, but the dedicated publish token in `~/.config/nctx/npm-publish-token.env` was used through a temporary npm userconfig. `npm publish --access public` succeeded.
- Verification: The public registry resolves `@platinum3nx/nctx@0.1.4` with integrity `sha512-4KOFlkJ0kXvokoVAshS3TmFlvJSizrimLwzUHT6UqqN4eklpD+jcPP13OEMwwPe+Loh/yhIwH8qYgBWuALr4Bg==`; fresh-directory `npx -y @platinum3nx/nctx@0.1.4 --version` prints `0.1.4`.

---

## Launch Readiness Review — Resolved

### Finding 1. Marketplace points to an unpublished npm artifact — FIXED

- Priority: P1 release prerequisite
- File: `.claude-plugin/marketplace.json`
- Fix: Version references are bumped to `0.1.4`, and `@platinum3nx/nctx@0.1.4` is now published on npm.
- Verification: `npm pack --json` produced `platinum3nx-nctx-0.1.4.tgz` with integrity `sha512-4KOFlkJ0kXvokoVAshS3TmFlvJSizrimLwzUHT6UqqN4eklpD+jcPP13OEMwwPe+Loh/yhIwH8qYgBWuALr4Bg==`, and the public registry now returns the same integrity for `@platinum3nx/nctx@0.1.4`.

---

### Finding 1. Plugin SessionEnd capture can exceed Claude Code's plugin hook budget — FIXED

- Priority: P1
- Files: `hooks/hooks.json`, `src/cli/capture.ts`, `src/cli/index.ts`, `src/config/hooks.ts`
- Fix: `SessionEnd` now uses a fast synchronous handoff: `capture --trigger=session-end --detach` reads the hook payload, writes a 0600 spool file under the initialized project, spawns a detached worker process with stdio ignored, and exits. The worker runs `capture --from-spool <path>` outside Claude Code's exit budget, removes the spool after processing, and uses the existing capture/pending/cursor durability pipeline.
- Verification: Direct built-CLI handoff returned in about 85ms, then the detached worker wrote the session cursor and left no spool file. A real Claude Code 2.1.79 `/exit` run against the built plugin logged the NCtx `SessionEnd` hook as `completed with status 0`, and the detached worker wrote `.nctx/sessions/<session>.pos`.

### Finding 2. Empty text fallback is treated as retrieval failure — FIXED

- Priority: P2
- File: `worker/src/index.ts`
- Fix: `safeTextFallback` now returns `unknown[] | null`, where an empty array means fallback succeeded with zero matches and `null` means fallback failed. `textFallbackOrError` now returns a 200 empty result set for successful empty fallback.
- Verification: Worker typecheck and Worker tests pass.

---

## Fix Review Findings — Resolved / Deferred

### Finding 1. Orphaned captures can still suppress retry extraction — VERIFIED FIXED

- Priority: P1
- File: `src/cli/capture.ts`
- Verification: `priorSessionSummaries` now filters same-session summaries through durable evidence (`context_ids` or matching pending files), so non-durable orphan files are not fed back into the extraction prompt as already captured context. `readExistingFingerprints` uses the same durable-evidence rule for memory-type dedupe.

### Finding 2. Plugin doctor still does not prove MCP can start — DEFERRED

- Priority: P2
- File: `src/config/mcp-register.ts`
- Why deferred: This is diagnostic hardening rather than the runtime path itself. The current bundle starts and a direct MCP `tools/list` handshake returns `nctx_memory`; doctor can be made stricter after beta without blocking capture or retrieval for users.

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
- Fix: Added `banner` with `createRequire` shim so bundled CJS code (yaml's `require("process")`) resolves Node built-ins correctly within the ESM bundle. `node dist/cli/index.js --version` now prints `0.1.4` without crashing.

### Finding 2. Fixed plugin artifact is not installable as a new version — FIXED

- Priority: P1
- Files: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/lib/constants.ts`
- Fix: All version references bumped from `0.1.2` to `0.1.4`. Ready for `npm publish`.

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
