# NCtx Beta Improvements

Potential improvements identified during full codebase review. Prioritized by impact on the core goal: making Claude remember past sessions effortlessly with zero user friction.

---

## HIGH VALUE — Retrieval Quality

### 1. Semantic + text search fallback in MCP tool

**Problem:** If semantic search returns empty (common in early usage with few memories or before Nia indexing completes), Claude shows "No memories found" even when relevant text-matched memories exist.

**Fix:** When mode is "semantic" and results are empty, automatically retry with "text" before returning nothing. ~5 lines in `src/mcp/client.ts` or `src/mcp/server.ts`.

**Impact:** Eliminates the "NCtx isn't working" perception for first-time users who have 1-2 memories that haven't been fully vector-indexed yet.

---

### 2. MCP tool description should encourage proactive use

**Problem:** Current description says "Use when the user references prior work, asks where we left off..." — this makes Claude wait for explicit prompts rather than proactively recalling context.

**Proposed description:**
```
Search past Claude Code session memories for this project. Call this proactively
at the start of any session involving files you haven't seen before, when the
user references prior work, or when past decisions/gotchas/patterns would help
avoid repeating mistakes. Semantic mode (default) finds conceptually related
memories. Text mode does keyword matching.
```

**Impact:** Claude calls `nctx_memory` early in sessions rather than only when explicitly asked, making memory feel automatic.

---

### 3. Retrieval should prefer recent episodic memories

**Problem:** When a user asks "where did we leave off", the most recent episodic memory is the definitive answer. Currently all memory types are returned with equal weight by score alone.

**Fix:** In the MCP formatter or client, sort/boost results so that episodic memories created within the last 7 days appear first when the query matches continuity patterns ("where did we leave off", "what was I working on", "continue", "resume").

**Impact:** The "continuity" use case — the product's most visible moment — becomes more reliable.

---

## MEDIUM VALUE — Extraction Quality

### 4. Deduplication across captures

**Problem:** Long sessions with multiple PreCompact events re-extract the same decisions/patterns each time, creating near-duplicate memories in Nia that dilute search quality.

**Fix options:**
- Before pushing a new fact/procedural context, check the last N local memory files for same-session captures with similar titles/content.
- Skip or merge rather than creating duplicates.
- Use a content hash or title similarity check.

**Impact:** Cleaner memory corpus, better signal-to-noise ratio in retrieval results over time.

---

### 5. Extraction prompt could include prior capture context

**Problem:** When PreCompact fires mid-session, the extractor doesn't know what was already captured earlier in the same session. This leads to repeated extraction of the same knowledge.

**Fix:** Read the session's existing memory file (if any via session cursor) and append a brief "Previously captured this session: [summary]" line to the extraction prompt. The extractor can then focus on truly new knowledge.

**Impact:** Reduced duplication, more efficient use of daily quota, better retrieval quality.

---

## MEDIUM VALUE — User Experience

### 6. `nctx status` command

**Problem:** Users have no quick way to verify NCtx is working day-to-day without running `doctor` (which probes the network) or manually checking `list`.

**Proposed output:**
```
NCtx status for project: aletheia
Last capture: 2 minutes ago (stripe-webhook-session)
Memories: 12 local, 11 pushed to Nia
Pending: 1 queued (will retry on next capture)
```

**Fix:** Build from existing local state — memory file count/dates from `.nctx/memories/`, pending count from `.nctx/pending/`, last cursor mtime from `.nctx/sessions/`.

**Impact:** Gives users confidence the system is working. Fast, local-only, no network calls.

---

### 7. First-session discoverability without touching CLAUDE.md

**Problem:** After `init`, Claude may not immediately discover the `nctx_memory` MCP tool if MCP registration lags or the session starts before the tool is loaded.

**Approach:** Do NOT auto-append to CLAUDE.md. That's too intrusive for a plugin whose promise is zero friction. Instead:
- Rely on improvement #2 (better MCP tool description) as the primary discoverability mechanism.
- MCP registration IS the discoverability layer — if Claude doesn't pick up the tool, that's a registration/description problem to solve at that layer.
- For users who want explicit visibility, offer an opt-in `nctx init --write-claude-md` flag that appends a brief note. Never the default.

**Impact:** Respects user ownership of CLAUDE.md while still solving discoverability through the correct abstraction (MCP).

---

## LOW VALUE — Polish & Robustness

### 8. Document `fetchNia` timeout-returns-Response pattern

**Problem:** In `worker/src/index.ts`, `fetchNia` returns a `json({...}, 504)` Response on abort rather than throwing. This is correct (downstream `!upstream.ok` handles it) but non-obvious to future maintainers.

**Fix:** Add a JSDoc comment explaining the design choice and why it's safe.

---

### 9. Transcript cursor tracks non-empty lines, not physical file positions

**Note:** The `nextLine` counter in `transcriptToText` only increments for non-empty lines (empty lines are `continue`'d before the increment at line 63-65). The session cursor therefore stores a count of non-empty lines processed, and on resume skips that many non-empty lines. This is internally consistent and correct for append-only JSONL files (which never have meaningful empty lines). No fix needed — this is just a documentation note for future maintainers.

---

### 10. Make `readClaudeMd` async

**Problem:** It's the only sync file read in the capture pipeline. While fine for one small file in a background hook, it prevents parallelizing `readClaudeMd` with `readSessionCursor`.

**Fix:** Convert to `readFile` (async) + handle ENOENT. Low priority since the file is always < 4KB.

---

## Future Considerations (Post-Beta)

### Memory quality scoring
Track which memories are actually retrieved and surfaced to users vs. never accessed. Over time, this could inform automatic pruning of low-signal memories.

### CLAUDE.md auto-suggestions
After accumulating N fact/procedural memories, suggest permanent additions to CLAUDE.md. This bridges the gap between ephemeral session memory and durable project documentation.

### Multi-project memory graph
A user working across related projects (e.g., frontend + backend) could benefit from cross-project memory with appropriate scoping. Would require tag-based project grouping in Nia.

### Memory consolidation
After N episodic memories accumulate for the same topic, consolidate them into a single updated fact/procedural memory and archive the originals. This keeps the corpus growing in quality rather than just size.

### Capture quality gate
Add a lightweight heuristic check on extraction results before pushing. If the extraction is purely generic ("we discussed code", "some changes were made"), skip the push entirely. Currently relies on the extraction prompt's "empty arrays are fine" instruction, but a programmatic gate would be more reliable.
