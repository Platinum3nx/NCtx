# NCtx - Product Requirements Document (v4, full reference + audit fixes)

> Empirical isolation test status: PASSED for tag-based text search isolation. Two contexts saved with `tags: ["install:aaa", "project:test"]` and `tags: ["install:bbb", "project:test"]`; `GET /v2/contexts/search?q=test&tags=install:aaa` returned only Alpha, and `GET /v2/contexts/search?q=test&tags=install:bbb` returned only Bravo. `workspace_override` is not used in v4 because live tests showed Nia ignores it on `POST /v2/contexts`.

> This PRD is intentionally self-contained. A reader (human or LLM) with no prior context should be able to build NCtx from this document alone. All Nia API endpoints, Claude Code hook formats, session JSONL handling, headless-mode CLI specs, Cloudflare Worker isolation logic, Durable Object rate limiting, and MCP server shape are inlined or precisely referenced.

---

## Changelog from v3

1. Replaced workspace-based isolation with tag-based isolation: Worker injects `install:<install_id>` tags and enforces search isolation.
2. Replaced the per-turn `Stop` hook with the once-per-session `SessionEnd` hook; kept `PreCompact`.
3. Added a mandatory `NCTX_INTERNAL=1` recursion guard for hook-launched `claude -p` extraction.
4. Moved hosted Worker runtime to Workers Paid ($5/month), using Durable Objects for atomic daily counters and Rate Limiting bindings for short-window throttling.
5. Corrected Claude Code print-mode flags: use `--tools ""`, remove nonexistent `--bare-no`, feature-detect `--no-session-persistence`, and use `haiku` by default.
6. Hardened the session JSONL parser for real Claude Code event types and added a compact tool action ledger.
7. Split each capture into separate Nia contexts by memory type: `fact`, `procedural`, and `episodic`; `scratchpad` remains reserved.
8. Updated Nia semantic-search response handling to prefer `relevance_score` and `match_highlights`, while tolerating legacy `score` and `highlights`.
9. Added `CLAUDE.md` reading as existing memory so extraction can avoid duplicating project instructions.
10. Removed direct-to-Nia mode from the MVP build; v4 beta is hosted-only through the enterprise Nia key.

---

## 0. Background context

### What problem are we solving?

Claude Code has a large but finite context window. When a coding session approaches that limit, Claude Code automatically compacts - summarizing older content to free space - and detail is lost. Each new session also starts with a fresh context: previous decisions, debugging journeys, and patterns that emerged during work do not carry forward unless the user manually edits them into `CLAUDE.md`. The result is that long-running projects accumulate session-derived knowledge (architectural decisions, bugs fixed, conventions adopted) that gets repeatedly forgotten and re-explained.

### What is Nia?

Nia (by Nozomio Labs, YC Summer 2025) is an API-layer context augmentation service for AI agents. It indexes external corpora - repositories, docs, papers, packages - and exposes them via REST API and an MCP server. Its core primitive is retrieval against indexed knowledge. Among Nia's offerings is a Context Sharing API (`/v2/contexts`) designed for cross-agent memory: agents can save structured contexts with summaries, tags, metadata, and memory types, then search them later. NCtx uses this Context Sharing API.

### What is NCtx?

NCtx is a Claude Code plugin that auto-captures session-derived knowledge (decisions, gotchas, patterns, current state) at session-end and pre-compaction events, structures it into discrete Nia contexts, and stores them through Nia's Context Sharing API. In future sessions on the same project, an MCP tool lets Claude retrieve relevant past contexts. The product is a capture pipeline that produces a corpus Nia indexes and serves; indexing and retrieval are entirely Nia's.

### Why does this matter to Nozomio?

Nia's existing examples (Cursor, Claude Code, OpenCode plugins) primarily consume external knowledge. NCtx feeds Nia agent-derived knowledge - the kind that only exists after work has happened. It demonstrates an underexplored category of Nia usage and drives recurring API traffic per active install.

---

## 1. Glossary

| Term | Definition |
|---|---|
| Claude Code (CC) | Anthropic's CLI-based coding agent. Documentation: https://code.claude.com/docs |
| MCP | Model Context Protocol. The interface Claude Code uses to call external tools. An MCP server is a process that exposes tools to CC. |
| Hook | A user-defined shell command CC runs at lifecycle events. Receives JSON via stdin. |
| `SessionEnd` hook | Claude Code lifecycle hook that fires once when a session terminates. NCtx uses it for final session capture. |
| `PreCompact` hook | Claude Code lifecycle hook that fires before context compaction. NCtx uses it to save memories before lossy summarization. |
| Headless mode | Running CC non-interactively via `claude -p` / `claude --print`. Returns text or JSON. |
| Compaction | CC's automatic summarization of older conversation when context fills up. Lossy by design. |
| Session JSONL | Append-only log of session events, stored at `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. |
| Tool action ledger | Compact NCtx-derived footer listing tool actions and touched files without embedding tool outputs. |
| CLAUDE.md | A markdown file at the project root. Loaded into context at session start. NCtx also reads it as existing memory to avoid duplicate extraction. |
| Context (Nia) | A discrete saved memory entry in Nia: title, summary, content, tags, memory type, metadata, and optional file references. Indexed for search. |
| Memory type (Nia) | One of `scratchpad` (1hr TTL), `episodic` (7d TTL), `fact` (permanent), `procedural` (permanent). |
| Install token | High-entropy per-install bearer token minted by the Worker. It authenticates exactly one NCtx install. |
| Install ID | Opaque server-side install identifier minted by the Worker. NCtx uses `install:<install_id>` tags for tenant isolation in Nia. |
| Hosted mode | Required beta mode where requests proxy through the NCtx Cloudflare Worker, which injects the enterprise Nia key and enforces per-install isolation. |
| Worker | Cloudflare Workers - serverless functions running at the edge. NCtx uses Workers Paid ($5/month), KV, Durable Objects, and Rate Limiting bindings. |
| Durable Object | Cloudflare stateful object used by NCtx for atomic per-install daily counters. |

---

## 2. One-liner

A Claude Code plugin that auto-captures session-derived knowledge and indexes it through Nia's Context Sharing API, so future sessions remember decisions, gotchas, patterns, and recent state from past work - installable in 30 seconds with no Nia signup, powered by a hosted Cloudflare Worker proxy during the 2-month enterprise-key beta.

---

## 3. Goals & non-goals

### Goals

1. Solve cross-session memory loss for solo developers using Claude Code on long-running projects.
2. Maximize adoption friction reduction during the remaining 2-month Nia enterprise-key window - install requires zero account creation.
3. Demonstrate a novel use of Nia's Context Sharing API.
4. Operate at low fixed infrastructure cost - one Cloudflare Worker on Workers Paid, approximately $5/month plus near-zero expected usage costs at beta scale.
5. Enforce hosted-mode tenant isolation so one install can only access contexts tagged with its server-side `install:<install_id>`.
6. Keep local memory files re-pushable so the product can survive Worker/Nia interruptions or a later post-beta migration.

### Non-goals

- Multi-user / team features.
- Web dashboard, GUI, or admin panel.
- User authentication, accounts, billing, or team admin.
- Programmatic memory editing/merging beyond local reindexing.
- Support for other agents (Cursor, Codex, Windsurf) in v1.
- Direct-to-Nia mode in the main beta build. It may be added after the hosted beta if the enterprise key window ends or users ask for self-hosted/direct operation.
- Custom embedding/retrieval (Nia owns this).
- Storing user code on NCtx infrastructure. The Worker is stateless with respect to content; only install-token mappings and rate counters are stored.

---

## 4. User experience

### 4.1 Hosted mode (default and only v4 mode)

```bash
$ cd ~/projects/aletheia
$ npx -y @arjunmalghan/nctx init

NCtx - persistent memory for Claude Code sessions

OK Detected Claude Code installation
OK Detected project: aletheia
OK Registered hosted install with NCtx beta proxy
OK Stored install token in .nctx/config.json
OK Registered hooks (SessionEnd, PreCompact) in .claude/settings.json
OK Registered MCP server (nctx_memory)
OK Created .nctx/ directory
OK Verified proxy connectivity and install tag isolation

Mode: hosted (using NCtx beta proxy - no Nia signup needed)
Daily quota: 500 calls per install

Just keep using Claude Code normally. Memories will accumulate
in .nctx/memories/ and become queryable in future sessions.

Run `nctx doctor` to verify the install.
```

The install token is a high-entropy bearer token scoped to one server-side install ID. It is stored locally and must not be committed. If leaked, it exposes only that install's memories, not the enterprise Nia account or other installs.

### 4.2 Daily use

User does nothing differently. Use Claude Code as normal. Behind the scenes:

- `PreCompact` fires before compaction and captures knowledge before lossy summarization.
- `SessionEnd` fires once when a session terminates and captures the final session state.

NCtx never registers a per-turn capture hook. That is deliberate: per-turn capture burns quota and produces repetitive memories.

### 4.3 Retrieval

In a new session, user types: "Where did we leave off on the dispute letter generator?"

Claude calls `nctx_memory(query="dispute letter generator state")` -> MCP server queries the Worker -> Worker searches Nia and returns only contexts tagged with this install's `install:<install_id>` tag -> Claude responds with continuity.

### 4.4 Visible artifacts

```text
.nctx/
|-- config.json           # hosted mode, project name, install token, proxy URL
|-- memories/             # local copy of every extracted capture (markdown)
|   |-- 2026-05-04T14-32-stripe-webhook-session.md
|   `-- ...
|-- pending/              # queued context writes when proxy/Nia is unreachable
|-- sessions/             # per-session line cursors for incremental capture
|   `-- 00893aaf-19fa-41d2-8238-13269b9b3ca0.pos
`-- errors.log            # extraction, parsing, or push failures
```

---

## 5. Architecture

### 5.1 Hosted mode

```text
+------------------------------------------------------------------+
| User's machine                                                   |
|                                                                  |
|  +----------------+         +--------------------------+         |
|  | CC hooks       | stdin   | nctx capture (Node)     |         |
|  | SessionEnd /   +-------->|                          |         |
|  | PreCompact     | JSON    | 1. Recursion guard       |         |
|  +----------------+         | 2. Read transcript_path  |         |
|                             | 3. Parse JSONL + ledger  |         |
|                             | 4. Read CLAUDE.md <=4KB  |         |
|                             | 5. claude -p extracts    |         |
|                             |    with NCTX_INTERNAL=1  |         |
|                             | 6. Write .md locally     |         |
|                             | 7. POST typed contexts   |         |
|                             |    to Worker with        |         |
|                             |    bearer install token  |         |
|                             +------------+-------------+         |
|                                          |                       |
|  +--------------------+                  |                       |
|  | nctx MCP server    | search query     |                       |
|  | (Node, started by  +--------+         |                       |
|  | Claude Code)       |        |         |                       |
|  +--------------------+        |         |                       |
+-------------------------------+---------+-----------------------+
                                |         |
                   +------------v---------v----------+
                   | Cloudflare Worker (NCtx infra) |
                   | https://nctx.<you>.workers.dev |
                   |                                |
                   | - POST /installs mints token   |
                   |   and install_id               |
                   | - Validates bearer token       |
                   | - KV maps token hash ->        |
                   |   install_id                   |
                   | - Strips spoofed install tags  |
                   | - Injects install:<install_id> |
                   |   tag on save                  |
                   | - Forces agent_source          |
                   |   nctx-claude-code             |
                   | - Adds metadata.install_id     |
                   | - Semantic search over-fetches |
                   |   then post-filters by tag     |
                   | - Text search injects tags     |
                   |   param for server filtering   |
                   | - Durable Object daily caps    |
                   | - Rate Limiting binding        |
                   | - Injects enterprise Nia key   |
                   +------------+-------------------+
                                |
                   +------------v-------------------+
                   | Nia API                        |
                   | https://apigcp.trynia.ai/v2    |
                   |                                |
                   | POST /contexts                 |
                   | GET /contexts/semantic-search  |
                   | GET /contexts/search           |
                   +--------------------------------+
```

The Worker never exposes unrestricted list/read endpoints in hosted mode. It only allows:

- `POST /installs`
- `POST /contexts`
- `GET /contexts/semantic-search`
- `GET /contexts/search`

It never forwards `GET /contexts`.

### 5.2 Critical architectural choices

- Extraction runs through `claude -p`, inheriting the user's existing Claude Code auth. No separate Anthropic key is required. Do not use `--bare`.
- Extraction disables tools with `--tools ""` and sets `NCTX_INTERNAL=1` so NCtx hooks no-op during extraction.
- Use Nia's Context Sharing API, not custom sources. The `/v2/contexts` endpoint is purpose-built for saved memories.
- Hosted isolation uses server-injected tags, not workspaces. Live testing showed `workspace_override` is ignored on `POST /v2/contexts`; live testing also showed `GET /v2/contexts/search?q=test&tags=install:<id>` filters correctly.
- The Worker treats all caller-supplied `install:*` tags as untrusted. It strips them and injects the server-resolved install tag.
- Semantic search has no verified server-side tag filter. The Worker over-fetches, post-filters by `install:<install_id>` and `agent_source`, then truncates.
- Text search has verified server-side tag filtering. The Worker rewrites `tags=install:<install_id>` and forwards to `/contexts/search`.
- Hosted mode relies on per-install bearer tokens. The package-level shared secret, if retained, is only a low-grade abuse guard for install minting and is never the privacy boundary.
- All durable user-visible state is local files under `.nctx/`. If the Worker or Nia changes, data is intact and re-pushable.
- MCP server runs locally, started by Claude Code via the registered command. There is no remote MCP server.
- Worker stores no user content. It stores token-hash -> install-id mappings in KV and daily counters in Durable Objects.

---

## 6. Data model

### 6.1 Memory file format (local, in `.nctx/memories/`)

One capture writes one local markdown file containing all extracted categories. That local file may correspond to up to three Nia contexts in v4 (`fact`, `procedural`, `episodic`) and up to four once `scratchpad` emission is added later.

```markdown
---
id: 2026-05-04T14-32-00-stripe-webhook-session
context_ids:
  fact: ctx_fact_abc123
  procedural: ctx_proc_def456
  episodic: ctx_epi_ghi789
session_id: 00893aaf-19fa-41d2-8238-13269b9b3ca0
date: 2026-05-04T14:32:00Z
trigger: session-end                 # "session-end" or "precompact"
session_end_reason: exit             # omitted for precompact
project: aletheia
files_touched:
  - src/api/stripe/webhook.ts
  - src/lib/stripe/retry.ts
tags: [stripe, webhooks, decisions, project:aletheia]
memory_types: [fact, procedural, episodic]
summary: Chose idempotent webhook handler with Redis-backed dedup
---

## Decision: Idempotent webhook handling

We chose to implement idempotency via Redis dedup keyed on Stripe event ID,
rather than relying solely on signature verification, because Stripe retries
the same event multiple times on transient failures and we were double-charging
analyses.

**Files:** `src/api/stripe/webhook.ts`, `src/lib/stripe/retry.ts`

## Gotcha: Stripe sends events out of order

Discovered that `payment_intent.succeeded` can arrive before
`payment_intent.created` under load. Fixed by treating events as
order-independent and using event timestamps for state reconciliation.

## Pattern: Webhook handlers are idempotent and order-independent

New webhook handlers should validate the signature, deduplicate by provider
event ID, and reconcile using event timestamps instead of assuming arrival order.

## State

In progress: webhook signature rotation handling.
Next: failure-mode tests for retry exhaustion.
```

The local file does not store the server-side install ID. The install ID is intentionally known only to the Worker. The Worker injects `install:<install_id>` into Nia tags during save.

### 6.2 Mapping extraction categories to Nia memory types

Nia's Context Sharing API supports four memory types:

| NCtx category | Nia memory_type | TTL | Emitted in v4? | Rationale |
|---|---|---:|---|---|
| Decisions + gotchas | `fact` | permanent | Yes | Architectural choices and bug knowledge should not expire. |
| Patterns | `procedural` | permanent | Yes | "How we do things here" is durable operating knowledge. |
| Current state / next steps | `episodic` | 7 days | Yes | Work-in-progress is useful for near-term continuity but should not fossilize. |
| Scratch notes | `scratchpad` | 1 hour | No | Reserved for a future high-frequency capture mode. |

Each capture can emit:

- Zero contexts if no durable knowledge was found.
- One `fact` context if decisions or gotchas exist.
- One `procedural` context if patterns exist.
- One `episodic` context if `state.in_progress` or `state.next_steps` exists.

Empty categories produce no Nia context. Do not push placeholder contexts to satisfy a shape.

Each emitted context includes common metadata supplied by the CLI. The Worker adds `metadata.install_id` before forwarding to Nia.

```json
{
  "metadata": {
    "nctx_version": "0.1.0",
    "session_id": "00893aaf-...",
    "project_name": "aletheia",
    "trigger": "session-end",
    "session_end_reason": "exit",
    "capture_id": "2026-05-04T14-32-00-stripe-webhook-session",
    "files_touched": ["src/api/stripe/webhook.ts"],
    "install_id": "server-injected"
  }
}
```

### 6.3 Config file - hosted mode

`.nctx/config.json`:

```json
{
  "mode": "hosted",
  "install_token": "nctx_it_E4y...32-byte-base64url-token...",
  "proxy_url": "https://nctx.<your-subdomain>.workers.dev",
  "project_name": "aletheia",
  "version": "0.1.0"
}
```

The hosted CLI does not store a `shared_secret`, Nia key, or install ID. Any package-level guard remains an implementation constant and is not a security boundary. The Worker derives install identity server-side from the install token hash.

### 6.4 Post-beta direct mode

Direct-to-Nia mode is intentionally out of scope for the v4 beta build. The hosted Worker owns Nia authentication and install-tag enforcement for every install. If the enterprise key window ends before a longer-term hosted arrangement exists, a future PRD can add a direct mode that reuses the local `.nctx/memories/` files and re-pushes them to a user-owned Nia account.

---

## 7. Reference & implementation details

This section contains everything a fresh builder needs that is not in their prior knowledge.

### 7.1 Claude Code hooks

Documentation: https://code.claude.com/docs/en/hooks

Claude Code docs classify `SessionEnd` as once per session and `Stop` as once per turn. NCtx must not use per-turn capture. NCtx registers:

- `SessionEnd`: final session capture.
- `PreCompact`: pre-compaction capture.

Hooks are configured in `.claude/settings.json`. NCtx uses command hooks with `async: true`, an explicit timeout, and an inline recursion guard:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "if [ \"$NCTX_INTERNAL\" = \"1\" ]; then exit 0; fi; npx -y @arjunmalghan/nctx capture --trigger=session-end",
            "async": true,
            "timeout": 60
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "if [ \"$NCTX_INTERNAL\" = \"1\" ]; then exit 0; fi; npx -y @arjunmalghan/nctx capture --trigger=precompact",
            "async": true,
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

`async: true` tells CC to launch the hook in the background. The capture process can take 5-20 seconds and must not block the user. `timeout: 60` keeps SessionEnd from being constrained by the shorter default SessionEnd budget.

The recursion guard is mandatory in two places:

1. The hook command checks `NCTX_INTERNAL=1` and exits `0`.
2. `nctx capture` itself checks `process.env.NCTX_INTERNAL === "1"` at startup and exits `0` before reading stdin or spawning Claude.

This double guard prevents infinite recursion when capture invokes `claude -p`, because Claude Code may load hooks while running headless.

**Common hook input fields:**

```json
{
  "session_id": "00893aaf-19fa-41d2-8238-13269b9b3ca0",
  "transcript_path": "/Users/arjun/.claude/projects/-Users-arjun-projects-aletheia/00893aaf-....jsonl",
  "cwd": "/Users/arjun/projects/aletheia",
  "permission_mode": "default",
  "hook_event_name": "SessionEnd"
}
```

For `SessionEnd`, Claude Code includes `reason` in addition to the common fields:

```json
{
  "session_id": "00893aaf-19fa-41d2-8238-13269b9b3ca0",
  "transcript_path": "/Users/arjun/.claude/projects/-Users-arjun-projects-aletheia/00893aaf-....jsonl",
  "cwd": "/Users/arjun/projects/aletheia",
  "permission_mode": "default",
  "hook_event_name": "SessionEnd",
  "reason": "exit"
}
```

NCtx must accept `exit`, `sigint`, and `error` because those are the expected high-level termination reasons for this product. Current Claude Code docs also list values such as `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, and `other`. Treat `reason` as an opaque string, store it in metadata, and never hard-code an exhaustive enum.

For `PreCompact`:

```json
{
  "session_id": "...",
  "transcript_path": "/Users/.../...jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "PreCompact",
  "trigger": "auto",
  "custom_instructions": ""
}
```

**Capture script reads stdin like this (Node):**

```typescript
import { stdin } from "node:process";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data;
}

if (process.env.NCTX_INTERNAL === "1") {
  process.exit(0);
}

const hookInput = JSON.parse(await readStdin());
const transcriptPath = hookInput.transcript_path;
const sessionId = hookInput.session_id;
const cwd = hookInput.cwd;
```

**Exit codes & control:**

- Exit `0`: success, normal flow.
- Exit `2`: blocking error. NCtx must not use this.
- Other non-zero: non-blocking warning.

NCtx capture always exits `0` even on internal failure. Errors go to `.nctx/errors.log`.

### 7.2 Session JSONL format and robust parsing

Location: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`

The encoding replaces `/` with `-`. Example: `/Users/arjun/projects/aletheia` -> `-Users-arjun-projects-aletheia`.

Real session JSONL includes many event types, including:

- `user`
- `assistant`
- `system`
- `progress`
- `queue-operation`
- `file-history-snapshot`
- `last-prompt`

Assistant content arrays can contain `text`, `thinking`, and `tool_use` blocks. User content can be a string or an array; array entries are often `tool_result` blocks that may contain large tool outputs. NCtx must keep conversation text, drop tool outputs, and extract only a compact ledger from tool use.

Pseudocode:

```typescript
type ToolAction = {
  tool: string;
  file_path?: string;
  operation?: string;
};

function transcriptToText(jsonlPath: string, sinceLine = 0): {
  text: string;
  nextLine: number;
  toolActions: ToolAction[];
} {
  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  const relevantLines = lines.slice(sinceLine);
  const turns: string[] = [];
  const toolActions: ToolAction[] = [];

  for (const line of relevantLines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "user") {
      const content = event.message?.content;
      if (typeof content === "string" && content.trim()) {
        turns.push(`USER: ${content}`);
      } else if (Array.isArray(content)) {
        const textBlocks = content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text.trim())
          .filter(Boolean);
        if (textBlocks.length) turns.push(`USER: ${textBlocks.join("\n")}`);
        // Drop tool_result entries entirely. They may contain full file contents.
      }
      continue;
    }

    if (event.type === "assistant") {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;

      const textBlocks: string[] = [];
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          textBlocks.push(block.text.trim());
        } else if (block?.type === "tool_use") {
          const action = toolUseToLedgerEntry(block);
          if (action) toolActions.push(action);
          // Drop raw tool input from the main transcript.
        }
        // Drop thinking blocks.
      }

      if (textBlocks.length) turns.push(`ASSISTANT: ${textBlocks.join("\n")}`);
      continue;
    }

    // Skip system, progress, queue-operation, file-history-snapshot,
    // last-prompt, and all unknown event types.
  }

  const ledger = renderToolActionLedger(toolActions);
  return {
    text: [turns.join("\n\n"), ledger].filter(Boolean).join("\n\n"),
    nextLine: lines.length,
    toolActions
  };
}

function toolUseToLedgerEntry(block: any): ToolAction | null {
  const tool = block.name || block.tool_name;
  const input = block.input || {};
  if (!tool) return null;

  const filePath =
    input.file_path ||
    input.path ||
    input.notebook_path ||
    input.old_path ||
    input.new_path;

  let operation = "tool";
  if (/^(Read|Grep|Glob|LS)$/.test(tool)) operation = "read";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) operation = "edit";
  if (tool === "Bash") operation = "command";

  return {
    tool,
    file_path: typeof filePath === "string" ? filePath : undefined,
    operation
  };
}

function renderToolActionLedger(actions: ToolAction[]): string {
  const compact = dedupeToolActions(actions).slice(0, 200);
  if (!compact.length) return "";
  return [
    "TOOL ACTION LEDGER (compact; tool outputs omitted):",
    ...compact.map((a) =>
      `- ${a.tool}${a.operation ? ` (${a.operation})` : ""}` +
      `${a.file_path ? `: ${a.file_path}` : ""}`
    )
  ].join("\n");
}
```

**Tracking incremental position:** store per-session pointers at `.nctx/sessions/<session_id>.pos`. Each file stores the last processed line number for that session. Do not use one global `last_session.txt`; concurrent sessions in the same project can race.

### 7.3 `claude -p` headless mode

Documentation: https://code.claude.com/docs/en/headless and https://code.claude.com/docs/en/cli-reference

NCtx invokes `claude -p` to extract structured memory from a transcript. Critical flags:

| Flag | Purpose |
|---|---|
| `-p` / `--print` | Headless mode. NCtx writes the full extraction prompt to stdin. |
| `--output-format json` | Returns JSON with a `result` field and, when structured output succeeds, a structured output field. |
| `--json-schema '<schema>'` | Requests output matching a JSON schema. |
| `--tools ""` | Disables all tools. This is the correct no-tools flag. |
| `--no-session-persistence` | Prevents extraction runs from polluting the user's session list, when available. |
| `--model haiku` | Uses the Haiku alias for fast/cheap extraction. Pinning a full model string is preferred for stability after beta validation. |
| no `--bare` | Inherits the user's existing CC auth via OAuth/keychain. |

Do not use `--allowedTools ""` to disable tools. That flag controls automatic approval of allowed tools; it is not the same as making no tools available. Do not use `--bare-no`; it does not exist.

Flag availability varies by Claude Code version. On startup, `nctx capture` should call `claude --help` once, cache the supported flags for the process, and build args defensively:

```typescript
import { execFileSync, spawn } from "node:child_process";

function getClaudeCapabilities(): {
  hasTools: boolean;
  hasNoSessionPersistence: boolean;
  hasJsonSchema: boolean;
  hasModel: boolean;
} {
  const help = execFileSync("claude", ["--help"], { encoding: "utf8" });
  return {
    hasTools: help.includes("--tools"),
    hasNoSessionPersistence: help.includes("--no-session-persistence"),
    hasJsonSchema: help.includes("--json-schema"),
    hasModel: help.includes("--model")
  };
}

function buildClaudeArgs(schema: object): string[] {
  const caps = getClaudeCapabilities();
  const args = ["-p", "--output-format", "json"];

  if (caps.hasJsonSchema) args.push("--json-schema", JSON.stringify(schema));
  if (caps.hasTools) args.push("--tools", "");
  if (caps.hasNoSessionPersistence) args.push("--no-session-persistence");
  if (caps.hasModel) args.push("--model", "haiku");

  return args;
}

function extractWithClaude(fullPrompt: string, schema: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", buildClaudeArgs(schema), {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NCTX_INTERNAL: "1"
      }
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("claude -p extraction timed out"));
    }, 60_000);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(new Error(`claude -p exited ${code}: ${stderr}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.structured_output ?? JSON.parse(parsed.result));
      } catch {
        reject(new Error(`Bad JSON from claude -p: ${stdout.slice(0, 500)}`));
      }
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}
```

If a flag is missing, the script should continue with the best safe fallback and log a warning to `.nctx/errors.log`. Missing `--tools` should be treated as a doctor warning because extraction could theoretically call tools, even though the prompt tells it not to.

### 7.4 The extraction prompt and schema

Before extraction, NCtx reads the project root `CLAUDE.md` if it exists, caps it at 4KB, and passes it as existing memory. The extractor is instructed not to duplicate it verbatim.

```typescript
function readClaudeMd(cwd: string): string {
  const path = join(cwd, "CLAUDE.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").slice(0, 4096);
}
```

**The prompt:**

```text
You are analyzing a Claude Code session to extract durable knowledge that should
survive into future sessions on this project.

Existing project memory from CLAUDE.md is provided below. Do not duplicate this
content verbatim in the extracted memories. Only extract new, session-derived
knowledge or project-specific refinements not already captured there.

<CLAUDE_MD>
[CLAUDE.md content, max 4KB, may be empty]
</CLAUDE_MD>

The transcript below contains user messages and assistant responses. Tool
outputs have been omitted. A compact tool action ledger is included at the end
so you can cite files touched without seeing their full contents.

Extract ONLY things a future session on this same codebase would benefit from
knowing. Skip generic AI advice.

Categories to extract:
- DECISIONS: Architectural or design choices made, with rationale
- GOTCHAS: Bugs encountered, root causes, fixes
- PATTERNS: Conventions established, code patterns adopted
- STATE: Current work-in-progress and immediate next steps

Rules:
- Empty arrays are fine - only include real durable knowledge.
- Prefer specificity ("we use Zod for runtime validation of API payloads")
  over generality ("we validate things").
- Cite filenames where applicable.
- Do not copy sentences from CLAUDE.md into the output.
- If the session was purely exploratory with no durable outcomes, return all
  empty arrays and a summary noting the exploration.

Output ONLY valid JSON matching the provided schema.

Transcript:
[TRANSCRIPT INSERTED HERE]
```

**The JSON schema passed via `--json-schema`:**

```json
{
  "type": "object",
  "required": ["summary", "tags", "files_touched", "decisions", "gotchas", "patterns", "state"],
  "properties": {
    "summary": {"type": "string", "maxLength": 200},
    "tags": {"type": "array", "items": {"type": "string"}},
    "files_touched": {"type": "array", "items": {"type": "string"}},
    "decisions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "rationale"],
        "properties": {
          "title": {"type": "string"},
          "rationale": {"type": "string"},
          "files": {"type": "array", "items": {"type": "string"}}
        }
      }
    },
    "gotchas": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["problem", "cause", "fix"],
        "properties": {
          "problem": {"type": "string"},
          "cause": {"type": "string"},
          "fix": {"type": "string"},
          "files": {"type": "array", "items": {"type": "string"}}
        }
      }
    },
    "patterns": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["pattern", "rationale"],
        "properties": {
          "pattern": {"type": "string"},
          "rationale": {"type": "string"},
          "files": {"type": "array", "items": {"type": "string"}}
        }
      }
    },
    "state": {
      "type": "object",
      "properties": {
        "in_progress": {"type": ["string", "null"]},
        "next_steps": {"type": "array", "items": {"type": "string"}},
        "files": {"type": "array", "items": {"type": "string"}}
      }
    }
  }
}
```

### 7.5 Nia API - Context Sharing endpoints

Base URL: `https://apigcp.trynia.ai/v2`
Auth: `Authorization: Bearer <api_key>` header
Docs:

- Save context: https://docs.trynia.ai/api-reference/context-sharing/save-context
- Text search: `GET /v2/contexts/search`
- Semantic search: https://docs.trynia.ai/api-reference/context-sharing/semantic-search-contexts

#### Save context - `POST /v2/contexts`

Request body for a `fact` context as the Worker forwards it:

```json
{
  "title": "Stripe webhook decisions and gotchas",
  "summary": "Chose Redis-backed dedup and handled out-of-order Stripe events",
  "content": "## Decision: ...\n\n## Gotcha: ...",
  "agent_source": "nctx-claude-code",
  "tags": ["stripe", "webhooks", "decisions", "project:aletheia", "install:6d6500d2-3feb-4baf-9939-6cccf2aabb1b"],
  "memory_type": "fact",
  "metadata": {
    "nctx_version": "0.1.0",
    "install_id": "6d6500d2-3feb-4baf-9939-6cccf2aabb1b",
    "session_id": "00893aaf-...",
    "project_name": "aletheia",
    "trigger": "session-end",
    "session_end_reason": "exit",
    "capture_id": "2026-05-04T14-32-00-stripe-webhook-session",
    "files_touched": ["src/api/stripe/webhook.ts"]
  },
  "edited_files": [
    {
      "file_path": "src/api/stripe/webhook.ts",
      "operation": "edited",
      "changes_description": "Touched during the captured Claude Code session."
    }
  ]
}
```

Field constraints:

- `title`: 1-200 chars, required.
- `summary`: 10-1000 chars, required.
- `content`: minimum 50 chars, required.
- `agent_source`: required. The Worker always forces `"nctx-claude-code"`.
- `memory_type`: `scratchpad`, `episodic`, `fact`, or `procedural`. NCtx always sends it.
- `ttl_seconds`: optional custom TTL. NCtx does not set it in v4; it uses Nia defaults for the selected memory type.
- `tags`: searchable strings for categorization and install isolation. The Worker strips caller-supplied `install:*` tags and injects exactly one server-side install tag.
- `metadata.install_id`: defense-in-depth audit field added by the Worker.
- `edited_files`: optional structured list of files modified. Live validation shows each entry must include `file_path`, `operation`, and `changes_description`.

Do not use `workspace_override`. Live testing showed Nia ignores it on `POST /v2/contexts`.

Response:

```json
{
  "id": "ctx_abc123",
  "user_id": "...",
  "organization_id": "...",
  "title": "...",
  "summary": "...",
  "content": "...",
  "tags": ["..."],
  "agent_source": "nctx-claude-code",
  "created_at": "2026-05-04T14:32:00Z",
  "updated_at": "2026-05-04T14:32:00Z",
  "metadata": {},
  "edited_files": [],
  "memory_type": "fact",
  "expires_at": null,
  "lineage": {}
}
```

Save returned IDs into the local memory file frontmatter under `context_ids.<memory_type>`.

#### Text search - `GET /v2/contexts/search`

Query params used by NCtx:

- `q` (required): text query.
- `tags` (required when called through Worker): the Worker forcibly sets `tags=install:<install_id>`.

Empirical result:

- `GET /v2/contexts/search?q=test&tags=install:aaa` returned only the Alpha context tagged `install:aaa`.
- `GET /v2/contexts/search?q=test&tags=install:bbb` returned only the Bravo context tagged `install:bbb`.

Current response shape observed in live testing:

```json
{
  "contexts": [
    {
      "id": "970f8de4-de3e-4437-9a03-a9a29a171c2c",
      "title": "NCtx tag isolation Alpha 1777946392",
      "summary": "Alpha context for empirical NCtx tag isolation test",
      "content": "Alpha test context...",
      "tags": ["install:aaa", "project:test"],
      "agent_source": "nctx-test",
      "created_at": "2026-05-05T01:59:52.399000",
      "metadata": {},
      "memory_type": "fact",
      "expires_at": null
    }
  ],
  "search_query": "test",
  "total_results": 1
}
```

The Worker returns this response unchanged after rewriting the `tags` query param.

#### Semantic search - `GET /v2/contexts/semantic-search`

Query params:

- `q` (required, string): semantic query.
- `limit` (optional, 1-100, default 20): number of results requested by caller.
- `include_highlights` (optional, default true): include match highlights.

Nia semantic search has no verified tag filter in v4. The Worker handles install isolation by:

1. Reading caller `limit` (default 5).
2. Forwarding to Nia with `limit * 10`, capped at 100.
3. Filtering returned results to entries whose `tags` include `install:<install_id>` and whose `agent_source === "nctx-claude-code"`.
4. Normalizing `memory_type` from NCtx category tags (`decisions`/`gotchas` -> `fact`, `patterns` -> `procedural`, `state`/`next-steps` -> `episodic`) because live semantic-search responses can return the default `episodic` value even when text search and save responses preserve the typed memory.
5. Truncating filtered results back to caller limit.
6. Returning the same response shape with `results` replaced and `search_metadata.total_results` updated to the filtered count when present.

Current documented response shape:

```json
{
  "results": [
    {
      "id": "ctx_abc123",
      "title": "Stripe webhook decisions and gotchas",
      "summary": "...",
      "content": "...",
      "tags": ["stripe", "webhooks", "install:6d6500d2-..."],
      "agent_source": "nctx-claude-code",
      "memory_type": "fact",
      "created_at": "2026-05-04T14:32:00Z",
      "metadata": {},
      "edited_files": [],
      "relevance_score": 0.87,
      "match_metadata": {
        "search_type": "hybrid",
        "vector_score": 0.82,
        "rank": 1
      },
      "match_highlights": ["..."]
    }
  ],
  "search_query": "stripe webhook idempotency",
  "search_metadata": {
    "search_type": "semantic",
    "total_results": 5,
    "vector_matches": 4,
    "mongodb_matches": 1
  },
  "suggestions": {
    "related_tags": [],
    "tips": []
  }
}
```

Defensive parsing:

```typescript
function normalizeSearchResult(r: any) {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    content: r.content,
    tags: r.tags ?? [],
    agent_source: r.agent_source,
    memory_type: r.memory_type,
    created_at: r.created_at,
    metadata: r.metadata ?? {},
    edited_files: r.edited_files ?? [],
    score: r.relevance_score ?? r.score ?? null,
    highlights: r.match_highlights ?? r.highlights ?? [],
    match_metadata: r.match_metadata ?? {}
  };
}
```

The MCP formatter must use the normalized `score` and `highlights` fields so it works across documented and legacy response shapes.

### 7.6 Cloudflare Worker proxy

Stack:

- TypeScript Worker.
- Workers Paid plan: $5/month minimum; expected beta traffic stays inside included usage, so usage costs should be approximately $0.
- KV namespace for install-token-hash -> install-id mapping. Write-once at init, read-many thereafter.
- Durable Object class for atomic per-install daily counters.
- Rate Limiting binding for short-window throttling against scraping and token-mint spam.

KV is not used for per-request counters. Workers KV Free allows only 1,000 writes/day, so counter writes would exhaust it quickly.

#### `worker/wrangler.toml`

```toml
name = "nctx"
main = "src/index.ts"
compatibility_date = "2026-05-04"

[[kv_namespaces]]
binding = "INSTALLS"
id = "<filled-in-after-wrangler-kv-create>"

[[durable_objects.bindings]]
name = "INSTALL_COUNTER"
class_name = "InstallCounter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["InstallCounter"]

[[ratelimits]]
name = "IP_RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 120
  period = 60

# Secrets are NOT in this file - set via:
#   wrangler secret put NIA_API_KEY
#   wrangler secret put PACKAGE_SHARED_SECRET
```

`PACKAGE_SHARED_SECRET` is optional defense-in-depth for `POST /installs`. It is embedded in the npm package and therefore extractable; it must never be treated as the privacy boundary. The install token is the real tenant credential.

#### `worker/src/index.ts`

```typescript
import { DurableObject } from "cloudflare:workers";

export interface Env {
  NIA_API_KEY: string;
  PACKAGE_SHARED_SECRET: string;
  INSTALLS: KVNamespace;
  INSTALL_COUNTER: DurableObjectNamespace<InstallCounter>;
  IP_RATE_LIMITER: RateLimit;
}

const NIA_BASE = "https://apigcp.trynia.ai/v2";
const PER_INSTALL_DAILY_CAP = 500;
const TOKEN_PREFIX = "nctx_it_";
const AGENT_SOURCE = "nctx-claude-code";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64url(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function installForToken(env: Env, token: string): Promise<{
  tokenHash: string;
  installId: string;
  installTag: string;
} | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 40) {
    return null;
  }
  const tokenHash = await sha256Hex(token);
  const installId = await env.INSTALLS.get(`install:${tokenHash}`);
  return installId
    ? { tokenHash, installId, installTag: `install:${installId}` }
    : null;
}

function sanitizeAndInjectTags(input: unknown, installTag: string): string[] {
  const existing = Array.isArray(input) ? input : [];
  const clean = existing
    .filter((tag): tag is string => typeof tag === "string")
    .filter((tag) => !tag.startsWith("install:"));
  return [...new Set([...clean, installTag])];
}

function isOwnedByInstall(result: any, installTag: string): boolean {
  return Array.isArray(result?.tags) &&
    result.tags.includes(installTag) &&
    result.agent_source === AGENT_SOURCE;
}

export class InstallCounter extends DurableObject<Env> {
  async incrementAndCheck(cap: number): Promise<{
    allowed: boolean;
    count: number;
    remaining: number;
  }> {
    const today = new Date().toISOString().slice(0, 10);
    const state =
      (await this.ctx.storage.get<{ date: string; count: number }>("daily")) ??
      { date: today, count: 0 };

    const count = state.date === today ? state.count : 0;
    if (count >= cap) {
      return { allowed: false, count, remaining: 0 };
    }

    const next = count + 1;
    await this.ctx.storage.put("daily", { date: today, count: next });
    return { allowed: true, count: next, remaining: Math.max(0, cap - next) };
  }
}

async function checkDailyCap(env: Env, tokenHash: string): Promise<Response | null> {
  const id = env.INSTALL_COUNTER.idFromName(tokenHash);
  const stub = env.INSTALL_COUNTER.get(id);
  const result = await stub.incrementAndCheck(PER_INSTALL_DAILY_CAP);
  if (!result.allowed) {
    return json({ error: "Rate limited", cap: PER_INSTALL_DAILY_CAP }, 429);
  }
  return null;
}

async function checkIpRateLimit(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const path = new URL(request.url).pathname;
  const { success } = await env.IP_RATE_LIMITER.limit({ key: `${ip}:${path}` });
  if (!success) return json({ error: "Too many requests" }, 429);
  return null;
}

async function registerInstall(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("x-nctx-package-secret") !== env.PACKAGE_SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const token = mintToken();
  const tokenHash = await sha256Hex(token);
  const installId = crypto.randomUUID();

  // Logical mapping is install_token -> install_id, stored by token hash
  // so raw tokens are not recoverable from KV.
  await env.INSTALLS.put(`install:${tokenHash}`, installId, {
    metadata: { created_at: new Date().toISOString() }
  });

  return json({ install_token: token });
}

async function forwardSave(request: Request, env: Env, install: { installId: string; installTag: string }): Promise<Response> {
  const body = await request.json<any>();

  body.tags = sanitizeAndInjectTags(body.tags, install.installTag);
  body.agent_source = AGENT_SOURCE;
  body.metadata = {
    ...(body.metadata ?? {}),
    install_id: install.installId
  };

  const upstream = await fetch(`${NIA_BASE}/contexts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NIA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
  });
}

async function forwardSemanticSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  if (!query.trim()) return json({ error: "Missing search query" }, 400);

  const requestedLimit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 5)));
  const upstreamLimit = Math.min(100, requestedLimit * 10);

  const upstreamUrl = new URL(`${NIA_BASE}/contexts/semantic-search`);
  upstreamUrl.searchParams.set("q", query);
  upstreamUrl.searchParams.set("limit", String(upstreamLimit));
  upstreamUrl.searchParams.set("include_highlights", url.searchParams.get("include_highlights") || "true");

  const upstream = await fetch(upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });

  const body = await upstream.json<any>();
  const filtered = (body.results ?? [])
    .filter((r: any) => isOwnedByInstall(r, installTag))
    .slice(0, requestedLimit);

  body.results = filtered;
  if (body.search_metadata) {
    body.search_metadata.total_results = filtered.length;
  }

  return json(body, upstream.status);
}

async function forwardTextSearch(request: Request, env: Env, installTag: string): Promise<Response> {
  const url = new URL(request.url);
  const upstreamUrl = new URL(`${NIA_BASE}/contexts/search`);
  for (const [key, value] of url.searchParams) {
    if (key !== "tags") upstreamUrl.searchParams.append(key, value);
  }
  upstreamUrl.searchParams.set("tags", installTag);

  const upstream = await fetch(upstreamUrl, {
    headers: { Authorization: `Bearer ${env.NIA_API_KEY}` }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rateLimited = await checkIpRateLimit(request, env);
    if (rateLimited) return rateLimited;

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/installs") {
      return registerInstall(request, env);
    }

    const token = bearerToken(request);
    if (!token) return json({ error: "Missing bearer token" }, 401);

    const install = await installForToken(env, token);
    if (!install) return json({ error: "Invalid install token" }, 401);

    const capResponse = await checkDailyCap(env, install.tokenHash);
    if (capResponse) return capResponse;

    if (request.method === "POST" && url.pathname === "/contexts") {
      return forwardSave(request, env, install);
    }

    if (request.method === "GET" && url.pathname === "/contexts/semantic-search") {
      return forwardSemanticSearch(request, env, install.installTag);
    }

    if (request.method === "GET" && url.pathname === "/contexts/search") {
      return forwardTextSearch(request, env, install.installTag);
    }

    return json({ error: "Not found" }, 404);
  }
} satisfies ExportedHandler<Env>;
```

No unrestricted `GET /contexts` endpoint is exposed.

#### Deploy commands

```bash
cd worker
npm install
npx wrangler kv namespace create INSTALLS
# Copy the returned ID into wrangler.toml under [[kv_namespaces]]

npx wrangler secret put NIA_API_KEY
# Paste enterprise nk_... key

npx wrangler secret put PACKAGE_SHARED_SECRET
# Paste a long random string (e.g. openssl rand -hex 32)

npx wrangler deploy
# Outputs: https://nctx.<your-subdomain>.workers.dev
```

#### Test the deployed Worker

```bash
WORKER=https://nctx.<your-subdomain>.workers.dev
PACKAGE_SECRET=<package-shared-secret>

# Mint install A
A=$(curl -sS -X POST "$WORKER/installs" \
  -H "x-nctx-package-secret: $PACKAGE_SECRET" | jq -r .install_token)

# Mint install B
B=$(curl -sS -X POST "$WORKER/installs" \
  -H "x-nctx-package-secret: $PACKAGE_SECRET" | jq -r .install_token)

# Save a context under install A. Spoofed install tag should be stripped.
curl -X POST "$WORKER/contexts" \
  -H "Authorization: Bearer $A" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test memory from install A",
    "summary": "Verifying hosted tag isolation through the Worker",
    "content": "This is a longer body with at least fifty characters of content so it passes Nia validation.",
    "agent_source": "malicious-agent-source",
    "tags": ["test", "project:nctx-self", "install:attacker-controlled"],
    "memory_type": "fact"
  }'

# Text search with install A should find it.
curl -G "$WORKER/contexts/search" \
  -H "Authorization: Bearer $A" \
  --data-urlencode "q=hosted tag isolation"

# Text search with install B should not find install A's context.
curl -G "$WORKER/contexts/search" \
  -H "Authorization: Bearer $B" \
  --data-urlencode "q=hosted tag isolation"

# Semantic search with install A may find it after indexing.
curl -G "$WORKER/contexts/semantic-search" \
  -H "Authorization: Bearer $A" \
  --data-urlencode "q=hosted tag isolation"

# Unrestricted listing must not exist.
curl -i "$WORKER/contexts" -H "Authorization: Bearer $A"
# Expected: 404
```

### 7.7 MCP server registration

Documentation: https://code.claude.com/docs/en/mcp

NCtx ships an MCP server that Claude Code launches as a subprocess. Registration during `nctx init`:

```bash
# Local-scope registration via Claude CLI. This loads only for the current
# project path but is stored privately in ~/.claude.json, not committed.
claude mcp add-json --scope local "nctx" '{"type":"stdio","command":"npx","args":["-y","@arjunmalghan/nctx","mcp"]}'

# If a user explicitly wants a shared project .mcp.json, use:
claude mcp add-json --scope project "nctx" '{"type":"stdio","command":"npx","args":["-y","@arjunmalghan/nctx","mcp"]}'
```

Manual `.mcp.json` project-scoped format:

```json
{
  "mcpServers": {
    "nctx": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@arjunmalghan/nctx", "mcp"]
    }
  }
}
```

The MCP server uses the official `@modelcontextprotocol/sdk` TypeScript SDK. Pin the SDK version in `package.json` and update intentionally; the SDK evolves.

Skeleton:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "nctx", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "nctx_memory",
    description: "Search past session memories for this project. Use when the user references prior work, asks where we left off, or when context from past sessions would help answer accurately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language description of what to find" },
        limit: { type: "number", default: 5 },
        mode: { type: "string", enum: ["semantic", "text"], default: "semantic" }
      },
      required: ["query"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "nctx_memory") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }

  const { query, limit = 5, mode = "semantic" } = req.params.arguments as {
    query: string;
    limit?: number;
    mode?: "semantic" | "text";
  };

  const config = loadConfig(process.cwd());
  const client = makeClient(config);
  const results = await client.searchContexts(query, limit, mode);

  return {
    content: [{
      type: "text",
      text: formatResults(results.map(normalizeSearchResult))
    }]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

`formatResults` must include title, summary, date, memory type, top tags, file paths, normalized score, and highlights when available. It must not assume `score` or `highlights` are the raw Nia field names.

### 7.8 NPM package structure

```text
nctx/
|-- package.json
|-- tsconfig.json
|-- tsup.config.ts
|-- README.md
|-- LICENSE
|-- src/
|   |-- cli/
|   |   |-- index.ts
|   |   |-- init.ts
|   |   |-- capture.ts
|   |   |-- doctor.ts
|   |   |-- list.ts
|   |   |-- view.ts
|   |   |-- reindex.ts
|   |   `-- uninstall.ts
|   |-- mcp/
|   |   `-- server.ts
|   |-- nia/
|   |   |-- client.ts
|   |   `-- hosted.ts
|   |-- capture/
|   |   |-- transcript.ts
|   |   |-- extract.ts
|   |   |-- prompt.ts
|   |   |-- claude-md.ts
|   |   |-- render.ts
|   |   `-- contexts.ts
|   |-- config/
|   |   |-- load.ts
|   |   |-- hooks.ts
|   |   `-- mcp-register.ts
|   `-- lib/
|       |-- log.ts
|       |-- lock.ts
|       `-- pending.ts
`-- worker/
    |-- package.json
    |-- wrangler.toml
    |-- tsconfig.json
    `-- src/
        `-- index.ts
```

### 7.9 `package.json` template (root)

```json
{
  "name": "@arjunmalghan/nctx",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "nctx": "./dist/cli/index.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "yaml": "^2.6.0",
    "yargs": "^17.7.2"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260504.1",
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^4.36.0"
  }
}
```

Use latest compatible patch versions during implementation, but pin major/minor versions for the MCP SDK and Wrangler once tests pass. The Rate Limiting binding requires Wrangler 4.36.0 or later.

### 7.10 End-to-end walkthrough (what success looks like)

Scenario: Fresh hosted install on Aletheia project, run a session, recall in a future session.

```bash
# Day 1, 2:00 PM - Install
$ cd ~/projects/aletheia
$ npx -y @arjunmalghan/nctx init
[interactive output as in section 4.1]

# During init:
# 1. CLI POSTs /installs to Worker with package-level guard header.
# 2. Worker mints install_token and install_id.
# 3. Worker stores token_hash -> install_id in KV.
# 4. CLI stores only install_token in .nctx/config.json.
# 5. CLI registers SessionEnd and PreCompact hooks with recursion guards.
# 6. CLI registers local MCP server.

# Day 1, 2:05 PM - Use Claude Code normally
$ claude
> Help me make the Stripe webhook handler idempotent
... [user works for 30 minutes, makes decisions, hits a bug, fixes it]
> /exit

# Behind the scenes:
# 1. SessionEnd hook fires once, runs:
#      npx -y @arjunmalghan/nctx capture --trigger=session-end
# 2. nctx capture confirms NCTX_INTERNAL is not set.
# 3. Hook input provides transcript_path, session_id, cwd, and reason.
# 4. Parser reads only new JSONL lines for this session.
# 5. Parser keeps user/assistant text, drops tool outputs/thinking, appends tool action ledger.
# 6. Capture reads CLAUDE.md up to 4KB.
# 7. Capture invokes claude -p with:
#      --output-format json
#      --json-schema ...
#      --tools ""
#      --no-session-persistence when available
#      --model haiku
#      env NCTX_INTERNAL=1
# 8. Extractor returns structured decisions/gotchas/patterns/state.
# 9. Capture writes .nctx/memories/2026-05-04T14-32-00-stripe-webhook-session.md.
# 10. Capture creates up to three Nia context requests:
#      fact: decisions + gotchas
#      procedural: patterns
#      episodic: current state + next steps
# 11. Hosted client POSTs each request to Worker with:
#      Authorization: Bearer <install_token>
# 12. Worker validates token, finds install_id, checks Durable Object daily cap,
#     strips spoofed install tags, injects install:<install_id>, forces
#     agent_source=nctx-claude-code, adds metadata.install_id, and forwards to Nia.
# 13. Nia returns context IDs; local frontmatter is updated.
# 14. .nctx/sessions/<sid>.pos is updated to the last processed JSONL line.

$ ls .nctx/memories/
2026-05-04T14-32-00-stripe-webhook-session.md

# Day 3 - New session, recall past work
$ cd ~/projects/aletheia
$ claude
> Where did we leave off on Stripe?

# Claude calls nctx_memory:
#   nctx_memory({ query: "Stripe webhook current state and next steps" })
# MCP server:
#   1. Reads .nctx/config.json
#   2. GETs /contexts/semantic-search?q=... through Worker
#   3. Worker over-fetches from Nia, filters to this install tag and agent source,
#      and returns only this install's memories
#   4. MCP formats normalized results with scores/highlights/file paths

# Claude responds:
"Based on past sessions: On May 4 you implemented idempotent webhook handling
using Redis dedup keyed on Stripe event IDs (src/api/stripe/webhook.ts). You
also discovered Stripe sends events out of order under load and switched to
timestamp-based reconciliation. The durable pattern is that webhook handlers
must be idempotent and order-independent. The most recent episodic state said
signature rotation handling was in progress, with failure-mode tests next."
```

If that final response works, the product is done. Everything else is polish.

---

## 8. Components - quick reference

| Component | Role |
|---|---|
| `nctx init` | Set up `.nctx/`, register hosted install, register hooks + MCP, verify connectivity. |
| `nctx capture` | Run by `SessionEnd` and `PreCompact` hooks. Parse transcript, extract via `claude -p`, write local md, push typed contexts to Nia through Worker. |
| `nctx mcp` | MCP server run by Claude Code. Exposes `nctx_memory` tool. |
| `nctx doctor` | Verify config, hooks, MCP registration, Claude flag support, recursion guard, network, and hosted tag isolation. |
| `nctx list` / `view` | Browse local memories. |
| `nctx reindex` | Re-push all local memories, preserving memory-type splitting. |
| `nctx uninstall` | Reverse `init` cleanly. |
| `worker/` | Cloudflare Worker proxy, install-token minting, tag injection/filtering, Durable Object counters. |

---

## 9. Phases with explicit acceptance tests

### Phase 0 - Foundations

**Tasks:**

- npm package skeleton (use `tsup` to bundle; CLI entry at `dist/cli/index.js` with shebang).
- Cloudflare account on Workers Paid plan ($5/month).
- `wrangler` 4.36.0 or later installed and logged in.
- `wrangler kv namespace create INSTALLS` - copy ID into `wrangler.toml`.
- Durable Object binding and migration configured for `InstallCounter`.
- Rate Limiting binding configured in `wrangler.toml`.
- Read this PRD's Reference section end-to-end before writing code.

**Acceptance tests:**

1. `npx tsx src/cli/index.ts --version` prints version.
2. `claude -p "say hi" --output-format json` returns JSON using the user's existing Claude Code auth.
3. `npx tsx src/cli/index.ts doctor --claude-flags` reports support status for `--tools`, `--json-schema`, `--no-session-persistence`, and `--model`.
4. `NCTX_INTERNAL=1 npx tsx src/cli/index.ts capture --trigger=session-end` exits `0`, creates no memory file, reads no transcript, and does not spawn `claude`.
5. Live Nia save probe: `POST /v2/contexts` with valid `title`, `summary`, `content`, `tags`, `agent_source`, and `memory_type` returns 200 with a context ID.
6. Live Nia tag-filter probe: save Alpha with `tags:["install:aaa","project:test"]`; save Bravo with `tags:["install:bbb","project:test"]`; `GET /contexts/search?q=test&tags=install:aaa` returns only Alpha; `GET /contexts/search?q=test&tags=install:bbb` returns only Bravo.
7. Live Nia semantic probe: unfiltered semantic search using a unique query returns both Alpha and Bravo after indexing.
8. `wrangler whoami` shows you are logged in.
9. `npx wrangler deploy --dry-run` validates KV, Durable Object migration, and Rate Limiting binding configuration.

---

### Phase 1 - Capture pipeline (local files only)

**Tasks:**

- Implement `src/capture/transcript.ts` - robust JSONL parser, tool ledger, per-session cursors.
- Implement `src/capture/claude-md.ts` - read project `CLAUDE.md` capped at 4KB.
- Implement `src/capture/extract.ts` - spawn `claude -p` with feature-detected flags, `--tools ""`, and `NCTX_INTERNAL=1`.
- Implement `src/capture/render.ts` - extracted JSON -> markdown with frontmatter.
- Implement `src/capture/contexts.ts` - extraction -> typed Nia context drafts, but do not push yet.
- Implement `src/cli/capture.ts` - orchestrates stdin hook input -> parse -> extract -> render -> local file.
- Hook into `SessionEnd` and `PreCompact` via temporary local registration.

**Acceptance tests:**

1. Manual run:
   `echo '{"session_id":"sid","transcript_path":"/path/to/sample.jsonl","cwd":"/tmp/test","hook_event_name":"SessionEnd","reason":"other"}' | nctx capture --trigger=session-end`
   produces a markdown file in `/tmp/test/.nctx/memories/`.
2. Sample JSONL containing `system`, `progress`, assistant `thinking`, assistant `tool_use`, user `tool_result`, and normal text produces transcript text without tool outputs and with a compact tool action ledger.
3. A project with `CLAUDE.md` containing a distinctive sentence does not reproduce that sentence verbatim in extracted memories.
4. End-to-end real CC session: after `/exit`, exactly one SessionEnd capture file appears within 20 seconds.
5. Pre-compaction real/session simulation: `PreCompact` capture works and stores `trigger: precompact`.
6. Quality gate: read three resulting memory files. Each contains at least one specific, actionable, non-generic statement. If not, stop and iterate the extraction prompt before continuing.

This is the most important phase. The product cannot succeed if extraction produces noise.

---

### Phase 2 - Cloudflare Worker

**Tasks:**

- Implement `worker/src/index.ts` per section 7.6.
- Configure `wrangler.toml` with KV, Durable Object binding/migration, and Rate Limiting binding.
- Configure secrets: `NIA_API_KEY`, `PACKAGE_SHARED_SECRET`.
- Deploy via `wrangler deploy`.

**Acceptance tests:**

1. `POST $WORKER/installs` with valid `x-nctx-package-secret` returns an `install_token`.
2. `POST $WORKER/installs` without valid package secret returns 401.
3. `POST $WORKER/contexts` without bearer token returns 401.
4. `POST $WORKER/contexts` with invalid bearer token returns 401.
5. `POST $WORKER/contexts` with valid bearer token, spoofed `install:*` tag, and malicious `agent_source` saves with only Worker-injected install tag and `agent_source: "nctx-claude-code"`.
6. `GET $WORKER/contexts/search` with valid token injects `tags=install:<install_id>` and returns only that install's contexts.
7. `GET $WORKER/contexts/semantic-search` with valid token post-filters results to that install's tag and `agent_source`.
8. Unrestricted `GET $WORKER/contexts` returns 404.
9. Cross-install isolation: save a unique memory with install A; searching the same query with install A finds it, while searching with install B does not.
10. Set `PER_INSTALL_DAILY_CAP=3`, redeploy, fire 4 context requests with the same token - the 4th returns 429.
11. Temporarily set the Rate Limiting binding low and verify repeated requests from one key return 429.

---

### Phase 3 - Nia integration in NCtx

**Tasks:**

- `src/nia/client.ts` - abstract interface (`saveContext`, `searchContexts`).
- `src/nia/hosted.ts` - uses `Authorization: Bearer <install_token>`, hits Worker, never sets trusted install tags.
- Factory function: `makeClient(config)` returns the hosted client. Any non-hosted config is a doctor error in v4.
- `src/cli/init.ts` - interactive setup; hosted mode calls `POST /installs` and stores the returned install token.
- Capture pipeline: after writing local md, call `client.saveContext(...)` for each non-empty memory-type context, store returned IDs in frontmatter.
- Pending queue: if any save fails, write each failed context request to `.nctx/pending/<capture-id>.<memory-type>.json`; drain on next successful network call.

**Acceptance tests:**

1. `nctx init` hosted creates valid `.nctx/config.json` with `install_token`, not `shared_secret`, Nia key, or install ID.
2. Hosted capture after a real session writes a memory file and populates one or more `context_ids` by memory type.
3. A session with decisions/gotchas and state creates at least one `fact` context and one `episodic` context.
4. A session with patterns creates a `procedural` context.
5. Empty categories produce no placeholder Nia contexts.
6. Same contexts appear in the enterprise Nia account with the Worker-injected `install:<install_id>` tag and `agent_source: "nctx-claude-code"`.
7. With Worker URL temporarily wrong, capture fails gracefully, local memory file still writes, pending queue contains failed context requests, `errors.log` updates, and the CC session is not blocked.

---

### Phase 4 - MCP server + retrieval

**Tasks:**

- Implement `src/mcp/server.ts` per section 7.7.
- Add MCP registration to `nctx init` (idempotent).
- Tool returns formatted text excerpts: title, summary, date, memory type, score, highlights, tags, file paths.
- Search uses Worker-scoped retrieval:
  - Semantic mode over-fetches and post-filters.
  - Text mode injects verified `tags=install:<install_id>` filter.

**Acceptance tests:**

1. `nctx mcp` run manually starts and accepts MCP protocol on stdio.
2. After `nctx init`, `claude mcp list` shows `nctx`.
3. In a fresh CC session in a project with prior memories, ask "where did we leave off on X?" - Claude calls `nctx_memory` and uses the result.
4. Retrieval respects install scope: memories from a different hosted install do not appear.
5. MCP formatting works against both current Nia response fields (`relevance_score`, `match_highlights`) and legacy fields (`score`, `highlights`) using unit fixtures.

---

### Phase 5 - Packaging & polish

**Tasks:**

- Publish `nctx` to npm (build via `tsup`, includes `dist/`).
- Implement `nctx doctor`: checks config validity, hook registration, recursion guard, Claude flag support, MCP registration, Worker reachability, and hosted tag isolation.
- Implement `nctx list` and `nctx view <id>`.
- Implement `nctx reindex` preserving memory type splitting.
- Implement `nctx uninstall` - removes hooks entries, MCP entry, optionally `.nctx/`.
- Write README with: 30-second pitch, install command, hosted beta explanation, install-token privacy model, tag-based isolation model, proxy stores no content, link to source.
- Add `LICENSE` (MIT) and `worker/README.md` with Workers Paid, KV, Durable Object, Rate Limiting, and secret setup instructions.

**Acceptance tests:**

1. Stranger can `npx -y @arjunmalghan/nctx init` and reach a working hosted install without consulting anything beyond the README.
2. `nctx doctor` correctly detects: missing config, missing hooks, missing recursion guard, missing MCP entry, unsupported Claude flags, Worker unreachable, and Worker isolation failure.
3. `nctx uninstall` removes all NCtx artifacts cleanly; a CC session afterward shows no NCtx hooks/MCP.

---

### Phase 6 - Pitch artifact

**Tasks:**

- Record 60-second Loom: install -> CC session -> recall in next session.
- Capture the A/B comparison: same query against (a) raw session JSONL pushed to Nia as a folder source, (b) NCtx-extracted typed memories. Screenshot the delta in result quality.
- Write 1-paragraph DM to Arlan @ Nozomio: link to npm, link to Loom, framing as Nia-complementary.

**Acceptance tests:**

1. Loom is under 90 seconds.
2. The A/B comparison clearly shows that extraction adds signal.
3. Worker analytics show real Nia API traffic from test installs.
4. Hosted isolation demo shows install A cannot retrieve install B's memory.

---

## 10. Open questions to resolve in Phase 0

1. **Does `claude -p` without `--bare` work from inside a hook subshell on target machines?** It should inherit the user's Claude Code auth. Test with a trivial hook that runs `claude -p "say hi" --output-format json` and writes the result to a temp file. If it fails with auth errors, fallback is to require user-provided `ANTHROPIC_API_KEY` or document the minimum Claude Code auth setup.

2. **Which Claude Code flags exist on the minimum supported version?** Current versions support `--tools`, `--json-schema`, `--no-session-persistence`, and `--model`, but CLI behavior evolves. Feature-detect at runtime and pin a minimum version in README after testing.

3. **What exact `SessionEnd.reason` values are observed in real target versions?** Current docs list `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, and `other`; older/local builds may emit `exit`, `sigint`, or `error`. Treat the value as opaque and store it.

4. **How big do real session transcripts get after tool-output stripping?** Likely 5K-50K tokens of user/assistant text plus a small ledger. If a session is genuinely massive, truncate oldest transcript text to a configurable ceiling while keeping recent state and the ledger.

5. **Does semantic search post-filtering retrieve enough same-install results?** The Worker over-fetches by 10x to overcome dilution. If relevant memories are frequently missed, default MCP retrieval can combine semantic search with `/contexts/search` fallback.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Extraction prompt produces low-quality memories | Phase 1 quality gate is non-negotiable. Iterate prompt until output passes gut-check before advancing. |
| Capture recursively invokes itself through `claude -p` | Double guard: hook shell command exits when `NCTX_INTERNAL=1`, and `nctx capture` itself no-ops under the same env var. |
| Wrong hook causes repeated capture | Use `SessionEnd`, not per-turn hooks. Doctor verifies hook names and fails if obsolete capture hooks are present. |
| Nia API changes break integration | All Nia calls isolated in `src/nia/` and Worker forwarding functions. Use defensive response parsing and smoke-test save/search in Phase 0. |
| Nia changes tag filter semantics or removes tag support | Worker logic is isolated in one module. If tag filtering changes, swap to a new server-side primitive or require Nia support before hosted mode continues. |
| Semantic search dilution hides same-install results | Worker over-fetches by 10x and post-filters. MCP can fall back to text search when semantic results are empty. |
| `claude -p` flags vary by version | Feature-detect `claude --help`, log warnings, and make `doctor` surface unsupported safety flags. |
| `claude -p` slow / blocks session end | `async: true` hooks, explicit hook timeout, 60s extraction timeout, hook always exits 0. |
| User runs `init` twice | All config writes idempotent. Existing hosted token is reused unless user passes `--rotate-token`. |
| Memory files leak sensitive code | README recommends `.nctx/` in `.gitignore`; `nctx init` adds it automatically when safe. Parser drops tool outputs and stores only extracted summaries locally. |
| Install token leaked from one user's machine | Leak exposes only that install's tagged contexts. Other installs and the enterprise account remain isolated. Add `nctx rotate-token` later if needed. |
| Worker abused at scale | Rate Limiting binding for short-window throttling, Durable Object daily caps per install, Cloudflare DDoS protection, Worker analytics. |
| Worker billing exceeds expected usage | Workers Paid plan is $5/month with included usage. Durable Objects and KV stay low at beta scale. Monitor Cloudflare usage and lower caps if needed. |
| Cloudflare Worker outage | Pending queue retries on next successful call. User session never blocks. Local memory files remain intact. |
| Enterprise Nia key window expires | Pause new hosted installs or negotiate extension/partnership. Local memory files remain re-pushable if a future direct/self-hosted mode is added. |
| Nia rate-limits enterprise key globally | Worker's per-install daily cap reduces risk. If hit, hosted users degrade to queued writes; ship hotfix lowering caps or pausing new installs. |

---

## 12. Success criteria

**Technical:**

- Hosted-mode install to first retrieval: under 60 seconds for a new user, excluding the user's actual coding session.
- Capture latency: under 20 seconds in the background; never blocks Claude Code interaction.
- Retrieval latency: under 2 seconds end-to-end for typical projects.
- Hosted isolation: install A cannot retrieve install B's memories through Worker text search or semantic search.
- Worker uptime tracks Cloudflare's.
- Infrastructure cost: Workers Paid plan at $5/month, with approximately $0 usage cost at expected beta scale.

**Strategic:**

- Working artifact DM-able to Arlan in a single message.
- A/B comparison visibly shows extraction adds signal.
- Worker analytics show real Nia API traffic from isolated test installs.
- Pitch frames NCtx as Nia-complementary.
- 2-month enterprise-key window converts to: (a) Nozomio partnership conversation, (b) extended hosted beta, or (c) clean shutdown with local memory export - all acceptable.

---

## 13. What "done" looks like for the 3-hour build

Realistic scope: Phases 0 -> 4 with a rough README. Polish (Phase 5) and pitch artifact (Phase 6) likely slip to a second session.

| Phase | Time | Outcome |
|---|---:|---|
| 0 | 30 min | Skeletons in place, Claude/Nia/Cloudflare systems verified, recursion guard proven, Nia tag filtering verified. |
| 1 | 75 min | Capture pipeline producing good local memory files with robust JSONL parsing and CLAUDE.md dedupe. |
| 2 | 40 min | Worker deployed with install tokens, install tag injection/filtering, Durable Object caps, and isolation curl-tested. |
| 3 | 35 min | NCtx talks to Worker; typed memories appear in Nia with correct memory types and install tags. |
| 4 | 20 min | MCP retrieval works in a real CC session with Worker-scoped search. |

If extraction quality (Phase 1) has not passed the gut-check after 75 minutes, stop and iterate the prompt. A working pipeline producing useless memories is worse than nothing. A polished MCP wrapper around great memories is the entire pitch.

---

## 14. External documentation references

| Topic | URL |
|---|---|
| Claude Code overview | https://code.claude.com/docs |
| Claude Code hooks reference | https://code.claude.com/docs/en/hooks |
| Claude Code headless / programmatic usage | https://code.claude.com/docs/en/headless |
| Claude Code CLI reference | https://code.claude.com/docs/en/cli-reference |
| Claude Code MCP | https://code.claude.com/docs/en/mcp |
| Nia API guide | https://docs.trynia.ai/api-guide |
| Nia Context Sharing - save | https://docs.trynia.ai/api-reference/context-sharing/save-context |
| Nia Context Sharing - semantic search | https://docs.trynia.ai/api-reference/context-sharing/semantic-search-contexts |
| Nia full API index | https://docs.trynia.ai/llms.txt |
| Cloudflare Workers pricing | https://developers.cloudflare.com/workers/platform/pricing/ |
| Cloudflare Workers KV | https://developers.cloudflare.com/kv/ |
| Cloudflare Durable Objects | https://developers.cloudflare.com/durable-objects/ |
| Cloudflare Rate Limiting binding | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Cloudflare Wrangler configuration | https://developers.cloudflare.com/workers/wrangler/configuration/ |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk |
