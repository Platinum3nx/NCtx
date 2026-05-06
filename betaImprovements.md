# NCtx Beta Improvements

Potential improvements identified during full codebase review, revised after the hardening pass. Prioritized by impact on the core goal: making Claude Code automatically recover useful project context from Nia without flooding the session with stale, unsafe, or noisy memory.

---

## HIGH VALUE - Retrieval Quality

### 1. Verify semantic + text fallback quality under scoped retrieval

**Problem:** Semantic search can return empty while Nia is still indexing, and text search can recover exact local terms. The Worker now has a safe semantic-to-text fallback path, but the product still needs quality validation: fallback should improve continuity without mixing unrelated installs/projects or over-returning keyword noise.

**Revised fix:**
- Add tests and live beta checks for fallback behavior with install scope, project scope, and mixed memory types.
- Track whether fallback results are coming from text search in response metadata.
- Keep fallback on the Worker side so tag/project filtering remains centralized.
- Tune fallback to preserve result limits and avoid duplicate semantic/text results.

**Impact:** Makes "NCtx remembered this" reliable for first-session and recently captured memories while preserving the hosted isolation boundary.

---

### 2. Make MCP tool use proactive, but not chatty

**Problem:** The current tool description encourages Claude to call `nctx_memory` mainly when the user explicitly references prior work. That undersells automatic memory. But an overly broad "call at the start of everything" instruction would waste context and quota.

**Revised tool description direction:**

```text
Search past Claude Code session memories for this project. Use proactively for
nontrivial work when resuming a task, touching unfamiliar files, debugging a
previously seen failure, or before making architecture/design decisions. Prefer
focused queries tied to the user's current task. Do not call for tiny one-off
edits where prior context is unlikely to matter.
```

**Impact:** Memory feels automatic in the moments where it helps context optimization, without turning every session into a retrieval preamble.

---

### 3. Add continuity-aware reranking

**Problem:** "Where did we leave off?" is the product's most visible moment. Recent episodic memories are usually the right answer, but episodic memories are time-limited and may be absent. Blindly boosting episodic results can hide durable facts/procedures that explain the current state.

**Revised fix:**
- Detect continuity queries such as "where did we leave off", "continue", "resume", "what was I working on", and "next steps".
- Prefer recent episodic results when present.
- Backfill with recent fact/procedural memories for the same project/topic when episodic memories are absent or thin.
- Keep the formatted output compact: state, next steps, files, and linked decisions/patterns.

**Impact:** Improves the handoff experience without making memory type more important than relevance.

---

### 4. Format retrieval for context budgeting

**Problem:** The MCP formatter currently makes retrieved memory safe, but the next step is making it context-efficient. Nia should help Claude spend fewer tokens reaching useful project state, not dump long memory bodies into context.

**Fix:**
- Add a compact formatter mode for Claude-facing output:
  - why this memory matched
  - durable decision/pattern/state
  - files touched
  - short quoted excerpts only when highlights are useful
- Keep strict caps per memory and total response.
- Prefer summaries and highlights over full content unless the query asks for detail.

**Impact:** Turns Nia retrieval into context optimization, not just storage-backed search.

---

## HIGH VALUE - Memory Corpus Quality

### 5. Deduplicate with stable fingerprints, not fuzzy titles

**Problem:** Long sessions and repeated PreCompact events can produce near-duplicate memories. Naive title similarity is risky: it can drop distinct decisions that happen to sound similar, or keep duplicates with different wording.

**Revised fix:**
- Compute stable fingerprints per memory type from normalized content, capture id, session id, project, and durable item titles.
- Store fingerprints in local frontmatter and Nia metadata.
- Before saving, skip exact fingerprint matches already present locally.
- Optionally search Nia for same fingerprint when local metadata is missing.
- Keep episodic chronology when it represents new state, even if the topic overlaps.

**Impact:** Reduces retrieval noise and quota use while preserving real project history.

---

### 6. Feed prior same-session capture summaries into extraction

**Problem:** When PreCompact fires multiple times in one session, the extractor does not know what was already captured. It can re-save the same decisions/patterns, especially if the latest transcript window still contains earlier discussion.

**Revised fix:**
- Read prior same-session memory summaries/fingerprints, not full memory bodies.
- Add a small "Already captured this session" section to the extraction prompt.
- Instruct the extractor to emit only new durable knowledge or updated state.
- Keep the added prompt budget tiny.

**Impact:** Better extraction precision and cleaner Nia corpus without turning capture into a heavy merge workflow.

---

### 7. Promote capture quality gates

**Problem:** A bad memory can be worse than no memory because it pollutes future context. The prompt asks Claude to skip generic content, but a programmatic gate would be more reliable.

**Fix:**
- Reject memories with generic summaries like "discussed code" or empty file/topic signal.
- Require at least one concrete project-specific item for fact/procedural contexts.
- Allow episodic captures only when there is meaningful state, next step, or file signal.
- Log skipped captures locally for debugging.

**Impact:** Keeps the memory corpus high-signal, which is essential if retrieval is supposed to improve Claude's future context.

---

## MEDIUM VALUE - User Trust And Observability

### 8. Add `nctx status`

**Problem:** Users need a fast way to know whether automatic memory is working without running network-heavy `doctor` or manually inspecting files.

**Revised output:**

```text
NCtx status for project: aletheia
Mode: Claude Code plugin
Last capture: 2 minutes ago
Local memories: 12
Pushed contexts: 31
Pending: 1 queued, 0 corrupt
Config permissions: owner-only
Project root: /Users/me/projects/aletheia
```

**Fix:**
- Build from local state only.
- Resolve the initialized project root exactly like capture/reindex.
- Show plugin vs standalone mode when detectable.
- Include pending/corrupt pending counts and last cursor/memory timestamps.

**Impact:** Gives users confidence that invisible memory automation is actually working.

---

### 9. Improve first-session discoverability through plugin surfaces

**Problem:** After init, Claude may not immediately use memory unless the MCP description and skill instructions make the right behavior obvious. Writing to `CLAUDE.md` by default is too intrusive for a zero-friction plugin.

**Revised approach:**
- Do not auto-append to `CLAUDE.md`.
- Improve the MCP tool description and `skills/nctx/SKILL.md` together so Claude learns when retrieval is valuable.
- Make `doctor` and future `status` clearly report plugin-provided hooks/MCP.
- Offer an opt-in `nctx init --write-claude-md` only for users who want explicit project-visible instructions.

**Impact:** Preserves user ownership of project docs while improving automatic memory use through the right Claude Code surfaces.

---

## LOW VALUE - Polish And Maintainability

### 10. Document the `fetchNia` timeout Response pattern

**Problem:** In `worker/src/index.ts`, `fetchNia` returns a JSON `Response` on abort rather than throwing. This is intentional because upstream handling already checks `!response.ok`, but it is non-obvious.

**Fix:** Add a short JSDoc comment explaining the design choice.

---

### 11. Update transcript cursor documentation

**Problem:** The old cursor note said malformed lines were harmless because cursoring was internally consistent. After hardening, malformed final JSONL lines are deliberately not advanced past, so the note should document that behavior instead.

**Fix:** Document that the cursor advances only through successfully parsed non-empty JSONL records, so partially written final records can be recovered on the next capture.

---

### 12. Make `readClaudeMd` async

**Problem:** It is the only sync file read in the capture pipeline. This is acceptable for a small file in a background hook, but async IO would make the pipeline easier to parallelize later.

**Fix:** Convert to `readFile` plus `ENOENT` handling.

---

## Implementation Review Findings

These findings were identified after reviewing the fixes for the prior implementation review. This section tracks remaining implementation issues that still need follow-up.

**Status:** Follow-up required for Worker project-scoped text recall.

### Finding 1 - [P1] Project-scoped text recall still depends on capped overfetch

**Location:** `worker/src/isolation.ts:221-227`

The patch raises project-scoped text search to at least 15 upstream hits, but project filtering still happens only after Nia has returned that capped install-scoped page. If the first 15 install-scoped text hits belong to another project, the matching project hit at position 16 is still never seen, so the original false-negative class remains for text mode and semantic fallback.

---

## Future Considerations - Post Beta

### Memory quality scoring

Track which memories are retrieved and actually used. Over time, this could inform automatic pruning or consolidation of low-signal memories.

### CLAUDE.md auto-suggestions

After accumulating durable fact/procedural memories, suggest explicit additions to `CLAUDE.md`. This bridges session memory and permanent project documentation without silently editing user-owned files.

### Multi-project memory graph

A user working across related projects could benefit from controlled cross-project recall. This should be an explicit retrieval mode or project group, not an accidental result of token reuse.

### Memory consolidation

After many episodic memories accumulate for the same topic, consolidate them into updated fact/procedural memories while preserving enough chronology to understand current state.
