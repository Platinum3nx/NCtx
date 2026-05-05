# NCtx — Product Requirements Document (v3, full reference)

> This PRD is intentionally self-contained. A reader (human or LLM) with no prior context should be able to build NCtx from this document alone. All Nia API endpoints, Claude Code hook formats, session JSONL structure, headless-mode CLI specs, and Cloudflare Worker code are inlined or precisely referenced.

---

## 0. Background context

### What problem are we solving?

Claude Code has a 200K-token context window. When a coding session approaches that limit, Claude Code automatically *compacts* — summarizing older content to free space — and detail is lost. Each new session also starts with a fresh context: previous decisions, debugging journeys, and patterns that emerged during work do not carry forward unless the user manually edits them into `CLAUDE.md`. The result is that long-running projects accumulate session-derived knowledge (architectural decisions, bugs fixed, conventions adopted) that gets repeatedly forgotten and re-explained.

### What is Nia?

Nia (by Nozomio Labs, YC Summer 2025) is an API-layer "context augmentation" service for AI agents. It indexes external corpora — repositories, docs, papers, packages — and exposes them via REST API and an MCP server. Its core primitive is *retrieval against indexed knowledge*. Among Nia's offerings is a **Context Sharing API** (`/v2/contexts`) explicitly designed for cross-agent memory: agents can save structured "contexts" with summaries and tags, then semantically search them later. This API is what NCtx uses.

### What is NCtx?

NCtx is a Claude Code plugin that auto-captures session-derived knowledge (decisions, gotchas, patterns, current state) at session-end and pre-compaction events, structures it into discrete "context" entries, and stores them via Nia's Context Sharing API. In future sessions on the same project, an MCP tool lets Claude semantically retrieve relevant past contexts. The product is a **capture pipeline** that produces a corpus Nia indexes and serves; the indexing/retrieval is entirely Nia's.

### Why does this matter to Nozomio?

Nia's existing examples (Cursor, Claude Code, OpenCode plugins) all consume external knowledge. None of them feed Nia *agent-derived* knowledge — the kind that only exists after work has happened. NCtx is the first product to use Nia's Context Sharing primitive for that purpose, applied to the most popular agent (Claude Code). It demonstrates an underexplored category of Nia usage and drives recurring API traffic per active install.

---

## 1. Glossary

| Term | Definition |
|---|---|
| **Claude Code (CC)** | Anthropic's CLI-based coding agent. Documentation: https://code.claude.com/docs |
| **MCP** | Model Context Protocol. The interface Claude Code uses to call external tools. An "MCP server" is a process that exposes tools to CC. |
| **Hook** | A user-defined shell command CC runs at lifecycle events (Stop, PreCompact, etc.). Receives JSON via stdin. |
| **Headless mode** | Running CC non-interactively via `claude -p "<prompt>"`. Returns text or JSON. |
| **Compaction** | CC's automatic summarization of older conversation when context fills up. Lossy by design. |
| **Session JSONL** | Append-only log of every event in a CC session, stored at `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. |
| **CLAUDE.md** | A markdown file at the project root. Loaded into context at every session start. The user's manual cross-session memory. |
| **Context (Nia)** | A discrete saved memory entry in Nia: title, summary, content, tags, memory type. Indexed for semantic search. |
| **Memory type (Nia)** | One of `scratchpad` (1hr TTL), `episodic` (7d TTL), `fact` (permanent), `procedural` (permanent). |
| **BYOK** | Bring Your Own Key. User supplies their own Nia API key. |
| **Hosted mode** | Default install mode where requests proxy through your Cloudflare Worker, which injects your enterprise Nia key. |
| **Worker** | Cloudflare Workers — serverless functions running at the edge. Free tier: 100K requests/day. |

---

## 2. One-liner

A Claude Code plugin that auto-captures session-derived knowledge and indexes it through Nia's Context Sharing API, so future sessions remember decisions, gotchas, and patterns from past work — installable in 30 seconds with no Nia signup, powered by a hosted Cloudflare Worker proxy during the 3-month beta.

---

## 3. Goals & non-goals

### Goals

1. Solve cross-session memory loss for solo developers using Claude Code on long-running projects.
2. Maximize adoption friction reduction during the 3-month Nia enterprise window — install requires zero account creation.
3. Demonstrate a novel use of Nia's Context Sharing API.
4. Operate at near-zero infrastructure cost — one Cloudflare Worker, no servers, no databases, no user accounts.
5. Plan for graceful degradation — BYOK exists from day one.

### Non-goals

- Multi-user / team features.
- Web dashboard, GUI, or admin panel.
- User authentication, accounts, billing.
- Programmatic memory editing/merging.
- Support for other agents (Cursor, Codex, Windsurf) in v1.
- Custom embedding/retrieval (Nia owns this).
- Storing user code on your infrastructure (Worker is stateless).

---

## 4. User experience

### 4.1 Hosted mode (default)

```bash
$ cd ~/projects/aletheia
$ npx @yourname/nctx init

NCtx — persistent memory for Claude Code sessions

✓ Detected Claude Code installation
✓ Detected project: aletheia
✓ Generated install ID: 7a3f1c2e-9b4d-4e8a-bf12-c8a91f4d2e6b
✓ Registered hooks (Stop, PreCompact) in .claude/settings.json
✓ Registered MCP server (nctx_memory)
✓ Created .nctx/ directory
✓ Verified proxy connectivity

Mode: hosted (using NCtx beta proxy — no API key needed)
Daily quota: 500 calls

Just keep using Claude Code normally. Memories will accumulate
in .nctx/memories/ and become queryable in future sessions.

Run `nctx doctor` to verify the install.
```

### 4.2 BYOK mode (opt-in)

```bash
$ npx @yourname/nctx init --byok

NCtx — persistent memory for Claude Code sessions (BYOK)

? Paste your Nia API key (get one at https://app.trynia.ai): nk_***
✓ Verified Nia API key
✓ ...
Mode: byok
```

### 4.3 Daily use

User does nothing differently. Use Claude Code as normal. Behind the scenes, hooks fire on session end and pre-compaction; memories accumulate.

### 4.4 Retrieval

In a new session, user types: *"Where did we leave off on the dispute letter generator?"*

Claude calls `nctx_memory(query="dispute letter generator state")` → MCP server queries Nia → Nia returns top semantically-matched contexts → Claude responds with continuity.

### 4.5 Visible artifacts

```
.nctx/
├── config.json           # install ID, mode, project name
├── memories/             # local copy of every captured memory (markdown)
│   ├── 2026-05-04T14-32-stripe-webhook-decision.md
│   └── ...
├── pending/              # queued writes when proxy/Nia is unreachable
├── last_session.txt      # pointer for incremental capture
└── errors.log            # extraction or push failures
```

---

## 5. Architecture

### 5.1 Hosted mode

```
┌──────────────────────────────────────────────────────────────────┐
│ User's machine                                                   │
│                                                                  │
│  ┌────────────────┐         ┌──────────────────────────┐         │
│  │  CC hooks      │ stdin   │  nctx capture (Node)     │         │
│  │  (Stop /       ├────────▶│                          │         │
│  │  PreCompact)   │  JSON   │  1. Read transcript_path │         │
│  └────────────────┘         │  2. claude -p extracts   │         │
│                             │  3. Write .md locally    │         │
│                             │  4. POST to Worker       │         │
│                             └──────────┬───────────────┘         │
│                                        │                         │
│  ┌────────────────────┐                │                         │
│  │ nctx mcp server    │ search query   │                         │
│  │ (Node, started by  ├──────┐         │                         │
│  │ Claude Code)       │      │         │                         │
│  └────────────────────┘      │         │                         │
└──────────────────────────────┼─────────┼─────────────────────────┘
                               │         │
                  ┌────────────▼─────────▼───────────┐
                  │  Cloudflare Worker (your infra)  │
                  │  https://nctx.<you>.workers.dev  │
                  │                                  │
                  │  - Validates SHARED_SECRET       │
                  │  - Validates install ID format   │
                  │  - Path allowlist                │
                  │  - Per-install rate limits (KV)  │
                  │  - Global daily cap              │
                  │  - Injects Authorization header  │
                  │  - Forwards to Nia               │
                  └────────────┬─────────────────────┘
                               │
                  ┌────────────▼─────────────────────┐
                  │  Nia API                         │
                  │  https://apigcp.trynia.ai/v2     │
                  │                                  │
                  │  POST /contexts (save memory)    │
                  │  GET /contexts/semantic-search   │
                  └──────────────────────────────────┘
```

### 5.2 BYOK mode

```
hooks → nctx capture ──────────────────────┐
MCP → nctx_memory tool ────────────────────┤
                                           │  Bearer: user's nk_...
                                           ▼
                                ┌──────────────────────────────┐
                                │  https://apigcp.trynia.ai/v2 │
                                └──────────────────────────────┘
```

### 5.3 Critical architectural choices

- **Extraction runs through `claude -p`**, inheriting the user's existing CC auth. No separate Anthropic key needed. Run *without* `--bare` so OAuth/keychain auth is picked up.
- **Use Nia's Context Sharing API, not custom sources.** The `/v2/contexts` endpoint is purpose-built for cross-agent saved memories. Each NCtx capture creates one context. Project scoping uses tags + `workspace_filter`.
- **All durable state is local files** under `.nctx/`. If the Worker, Nia, or BYOK key changes, data is intact and re-pushable.
- **MCP server runs locally**, started by Claude Code via the registered command. No remote MCP server.
- **Worker is stateless** except for ephemeral KV counters. It does not store user content.

---

## 6. Data model

### 6.1 Memory file format (local, in `.nctx/memories/`)

```markdown
---
id: 2026-05-04T14-32-00-stripe-webhook-decision
context_id: ctx_abc123        # populated after successful Nia push
session_id: 00893aaf-19fa-41d2-8238-13269b9b3ca0
date: 2026-05-04T14:32:00Z
trigger: stop                 # "stop" or "precompact"
project: aletheia
files_touched:
  - src/api/stripe/webhook.ts
  - src/lib/stripe/retry.ts
tags: [stripe, webhooks, decisions, aletheia]
memory_type: fact             # scratchpad | episodic | fact | procedural
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

## State

In progress: webhook signature rotation handling. Next: failure-mode tests.
```

### 6.2 Mapping memory types to Nia's `memory_type` enum

Nia's Context Sharing API supports four memory types (with TTLs):

| NCtx category | Nia memory_type | TTL | Rationale |
|---|---|---|---|
| Decisions | `fact` | permanent | Architectural choices should never expire |
| Gotchas | `fact` | permanent | Bug knowledge stays valuable indefinitely |
| Patterns | `procedural` | permanent | "How we do things here" is permanent |
| State (WIP) | `episodic` | 7 days | Current work-in-progress is short-lived |

A single capture may produce multiple Nia contexts if it spans categories with different memory types. Practical default: **one capture = one Nia context with `memory_type: fact`** containing all extracted categories in the body. Optimization for later: split into multiple contexts if the extraction reveals multiple distinct memory types.

### 6.3 Config file — hosted mode

`.nctx/config.json`:

```json
{
  "mode": "hosted",
  "install_id": "7a3f1c2e-9b4d-4e8a-bf12-c8a91f4d2e6b",
  "proxy_url": "https://nctx.<your-subdomain>.workers.dev",
  "project_name": "aletheia",
  "shared_secret": "nctx_pk_<embedded-in-package-version>",
  "version": "0.1.0"
}
```

### 6.4 Config file — BYOK mode

```json
{
  "mode": "byok",
  "nia_api_key": "nk_...",
  "project_name": "aletheia",
  "version": "0.1.0"
}
```

---

## 7. Reference & implementation details

This section contains everything a fresh builder needs that isn't in their prior knowledge.

### 7.1 Claude Code hooks

**Documentation:** https://code.claude.com/docs/en/hooks

Hooks are configured in `.claude/settings.json`. NCtx registers two:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx @yourname/nctx capture --trigger=stop",
            "async": true
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx @yourname/nctx capture --trigger=precompact",
            "async": true
          }
        ]
      }
    ]
  }
}
```

`async: true` is critical — it tells CC not to block on the hook. NCtx capture takes 5-10 seconds (claude -p extraction) and we never want to delay the user.

**Hook input (received via stdin as JSON):**

For `Stop`:
```json
{
  "session_id": "00893aaf-19fa-41d2-8238-13269b9b3ca0",
  "transcript_path": "/Users/arjun/.claude/projects/-Users-arjun-projects-aletheia/00893aaf-....jsonl",
  "cwd": "/Users/arjun/projects/aletheia",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

For `PreCompact`:
```json
{
  "session_id": "...",
  "transcript_path": "/Users/.../...jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PreCompact",
  "trigger": "auto",            // "manual" or "auto"
  "custom_instructions": ""     // populated for manual /compact
}
```

**Capture script reads stdin like this (Node):**

```typescript
import { stdin } from "process";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data;
}

const hookInput = JSON.parse(await readStdin());
const transcriptPath = hookInput.transcript_path;
const sessionId = hookInput.session_id;
const cwd = hookInput.cwd;
```

**Exit codes & control:**
- Exit `0`: success, normal flow.
- Exit `2`: blocking error (don't use this in NCtx — we never want to block the user).
- Other non-zero: non-blocking warning.

NCtx capture **always exits 0** even on internal failure. Errors go to `.nctx/errors.log`.

### 7.2 Session JSONL format

**Location:** `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`

The encoding replaces `/` with `-`. Example: `/Users/arjun/projects/aletheia` → `-Users-arjun-projects-aletheia`.

Each line is one JSON event. Common types:

```jsonl
{"type":"user","message":{"role":"user","content":"Fix the auth bug"},"timestamp":"2026-05-04T14:30:00Z","uuid":"u1","parentUuid":null}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll investigate."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/.../auth.ts"}}]},"timestamp":"2026-05-04T14:30:05Z","uuid":"a1","parentUuid":"u1"}
{"type":"tool_result","tool_use_id":"tu1","content":"... file contents ...","timestamp":"2026-05-04T14:30:06Z","uuid":"r1","parentUuid":"a1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Found the issue..."}]},"timestamp":"2026-05-04T14:30:08Z","uuid":"a2","parentUuid":"r1"}
```

**For NCtx capture, the simplest approach is to read the entire JSONL, extract user messages and assistant text content, drop tool inputs/outputs, and feed the result to extraction.** Tool noise is what poisons the extraction; trim it out before sending to `claude -p`.

Pseudocode:

```typescript
function transcriptToText(jsonlPath: string, sinceLine: number = 0): string {
  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  const relevantLines = lines.slice(sinceLine);
  const turns: string[] = [];
  for (const line of relevantLines) {
    const event = JSON.parse(line);
    if (event.type === "user" && typeof event.message?.content === "string") {
      turns.push(`USER: ${event.message.content}`);
    } else if (event.type === "assistant") {
      const textBlocks = (event.message?.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text);
      if (textBlocks.length) turns.push(`ASSISTANT: ${textBlocks.join("\n")}`);
    }
  }
  return turns.join("\n\n");
}
```

**Tracking incremental position:** `.nctx/last_session.txt` stores `<session_id>:<last_line_processed>`. On each capture, only process lines added since last run.

### 7.3 `claude -p` headless mode

**Documentation:** https://code.claude.com/docs/en/headless

NCtx invokes `claude -p` to extract structured memory from a transcript. Critical flags:

| Flag | Purpose |
|---|---|
| `-p "<prompt>"` | Headless mode with given prompt |
| `--output-format json` | Returns `{result, session_id, total_cost_usd, ...}` JSON |
| `--json-schema '<schema>'` | Forces output to match a JSON schema (lands in `structured_output` field) |
| `--allowedTools ""` | Empty allowlist — no tool use, just text generation |
| `--model claude-haiku-4-5` | Use Haiku for fast/cheap extraction |
| (no `--bare`) | Inherits the user's existing CC auth via OAuth/keychain |

**Important:** Do NOT use `--bare`. Bare mode skips OAuth/keychain and requires `ANTHROPIC_API_KEY`. Without `--bare`, CC reuses the user's existing auth so NCtx never needs its own key.

**Invocation pattern:**

```typescript
import { spawn } from "node:child_process";

function extractWithClaude(transcript: string, schema: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      EXTRACTION_PROMPT,
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--allowedTools", "",
      "--model", "claude-haiku-4-5",
    ];
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${stderr}`));
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.structured_output);
      } catch (e) {
        reject(new Error(`Bad JSON from claude -p: ${stdout.slice(0, 500)}`));
      }
    });
    proc.stdin.write(transcript);
    proc.stdin.end();
  });
}
```

**Timeout handling:** Wrap in a 60-second timeout. If `claude -p` hangs, kill the process and exit 0 from the hook (never block the user).

### 7.4 The extraction prompt and schema

**The prompt (NCtx's most important piece — iterate until output is good):**

```
You are analyzing a Claude Code session to extract durable knowledge that should
survive into future sessions on this project.

The transcript below contains user messages and assistant responses (tool noise
already stripped). Extract ONLY things a future session on this same codebase
would benefit from knowing. Skip generic AI advice and content already in CLAUDE.md.

Categories to extract:
- DECISIONS: Architectural or design choices made, with rationale
- GOTCHAS: Bugs encountered, root causes, fixes
- PATTERNS: Conventions established, code patterns adopted
- STATE: Current work-in-progress and immediate next steps

Rules:
- Empty arrays are fine — only include real durable knowledge.
- Prefer specificity ("we use Zod for runtime validation of API payloads")
  over generality ("we validate things").
- Cite filenames where applicable.
- If the session was purely exploratory with no durable outcomes, return all
  empty arrays and a summary noting the exploration.

Output ONLY valid JSON matching the provided schema.

Transcript:
[TRANSCRIPT INSERTED HERE]
```

**The JSON schema (passed via `--json-schema`):**

```json
{
  "type": "object",
  "required": ["summary", "tags", "files_touched", "decisions", "gotchas", "patterns", "state"],
  "properties": {
    "summary": {
      "type": "string",
      "maxLength": 200,
      "description": "One-sentence description of the session, under 15 words"
    },
    "tags": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Short kebab-case tags"
    },
    "files_touched": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Relative file paths"
    },
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
          "fix": {"type": "string"}
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
          "rationale": {"type": "string"}
        }
      }
    },
    "state": {
      "type": "object",
      "properties": {
        "in_progress": {"type": ["string", "null"]},
        "next_steps": {"type": "array", "items": {"type": "string"}}
      }
    }
  }
}
```

### 7.5 Nia API — Context Sharing endpoints (the only ones NCtx uses)

**Base URL:** `https://apigcp.trynia.ai/v2`
**Auth:** `Authorization: Bearer <api_key>` header
**Docs:** https://docs.trynia.ai/api-reference/context-sharing/save-context.md

#### Save context — `POST /v2/contexts`

Request body:

```json
{
  "title": "Stripe webhook idempotency decision",
  "summary": "Chose Redis-backed dedup over signature-only verification due to retry double-charging issue",
  "content": "## Decision: ...\n\n## Gotcha: ...\n\n## State: ...",
  "agent_source": "claude-code",
  "tags": ["stripe", "webhooks", "decisions", "project:aletheia"],
  "memory_type": "fact",
  "metadata": {
    "nctx_install_id": "7a3f1c2e-...",
    "session_id": "00893aaf-...",
    "trigger": "stop",
    "files_touched": ["src/api/stripe/webhook.ts"]
  }
}
```

Field constraints:
- `title`: 1–200 chars, required
- `summary`: 10–1000 chars, required
- `content`: minimum 50 chars, required
- `agent_source`: required (use `"claude-code"`)
- `memory_type`: one of `scratchpad` (1hr), `episodic` (7d), `fact` (permanent), `procedural` (permanent). Default `episodic`.
- `tags`: array of strings. Use `project:<name>` for project scoping.

Response:

```json
{
  "id": "ctx_abc123",
  "user_id": "...",
  "title": "...",
  "content": "...",
  "tags": [...],
  "memory_type": "fact",
  "created_at": "2026-05-04T14:32:00Z",
  ...
}
```

Save the returned `id` into the local memory file's frontmatter as `context_id`.

#### Semantic search — `GET /v2/contexts/semantic-search`

Query params:
- `q` (required, string): search query
- `limit` (optional, 1–100, default 20): number of results
- `include_highlights` (optional, default true): include match highlights
- `workspace_filter` (optional, string): filter by workspace name — **NCtx does not use this**; we filter via tags client-side or by re-querying

Response:

```json
{
  "results": [
    {
      "id": "ctx_abc123",
      "title": "Stripe webhook idempotency decision",
      "summary": "...",
      "content": "...",
      "tags": [...],
      "memory_type": "fact",
      "created_at": "2026-05-04T14:32:00Z",
      "score": 0.87,
      "highlights": ["..."]
    },
    ...
  ],
  "search_query": "stripe webhook idempotency",
  "search_metadata": {
    "search_type": "semantic",
    "total_results": 5,
    "vector_matches": 4,
    "mongodb_matches": 1
  }
}
```

**NCtx filters results client-side by tag** (`project:<name>`) since the API doesn't expose a tag filter on this endpoint. If results across all projects pollute retrieval too much, consider augmenting `q` with the project tag (e.g., `q="stripe webhook project:aletheia"`).

### 7.6 Cloudflare Worker proxy

**Stack:** TypeScript Worker + KV namespace for rate-limit counters.

**File: `worker/wrangler.toml`**

```toml
name = "nctx"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "USAGE"
id = "<filled-in-after-wrangler-kv-create>"

# Secrets are NOT in this file — set via:
#   wrangler secret put NIA_API_KEY
#   wrangler secret put SHARED_SECRET
```

**File: `worker/src/index.ts`**

```typescript
export interface Env {
  NIA_API_KEY: string;
  SHARED_SECRET: string;
  USAGE: KVNamespace;
}

const NIA_BASE = "https://apigcp.trynia.ai/v2";
const PER_INSTALL_DAILY_CAP = 500;
const GLOBAL_DAILY_CAP = 50000;
const KV_TTL = 90000; // 25 hours

const ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/contexts$/ },
  { method: "GET",  pattern: /^\/contexts\/semantic-search/ },
  { method: "GET",  pattern: /^\/contexts$/ },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Validate shared secret
    if (request.headers.get("x-nctx-secret") !== env.SHARED_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Validate install ID format
    const installId = request.headers.get("x-nctx-install-id") || "";
    if (!/^[a-f0-9-]{36}$/.test(installId)) {
      return new Response("Bad install ID", { status: 400 });
    }

    // 3. Optional: check ban list
    const banned = await env.USAGE.get(`ban:${installId}`);
    if (banned) return new Response("Banned", { status: 403 });

    // 4. Path allowlist
    const ok = ALLOWED.some(
      (rule) => rule.method === request.method && rule.pattern.test(url.pathname)
    );
    if (!ok) return new Response("Not found", { status: 404 });

    // 5. Rate limits
    const today = new Date().toISOString().slice(0, 10);
    const installKey = `i:${installId}:${today}`;
    const globalKey = `g:${today}`;

    const [installCount, globalCount] = await Promise.all([
      env.USAGE.get(installKey).then((v) => parseInt(v || "0")),
      env.USAGE.get(globalKey).then((v) => parseInt(v || "0")),
    ]);

    if (installCount >= PER_INSTALL_DAILY_CAP) {
      return new Response("Rate limited", { status: 429 });
    }
    if (globalCount >= GLOBAL_DAILY_CAP) {
      return new Response("Service capacity reached", { status: 503 });
    }

    // 6. Forward to Nia
    const niaUrl = NIA_BASE + url.pathname + url.search;
    const upstream = await fetch(niaUrl, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${env.NIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: request.method !== "GET" ? await request.text() : undefined,
    });

    // 7. Increment counters (best-effort)
    await Promise.all([
      env.USAGE.put(installKey, String(installCount + 1), { expirationTtl: KV_TTL }),
      env.USAGE.put(globalKey, String(globalCount + 1), { expirationTtl: KV_TTL }),
    ]);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  },
};
```

**Deploy commands:**

```bash
cd worker
npm install
npx wrangler kv namespace create USAGE
# Copy the returned ID into wrangler.toml under [[kv_namespaces]]

npx wrangler secret put NIA_API_KEY
# Paste enterprise nk_... key

npx wrangler secret put SHARED_SECRET
# Paste a long random string (e.g. `openssl rand -hex 32`)

npx wrangler deploy
# Outputs: https://nctx.<your-subdomain>.workers.dev
```

**Test the deployed Worker:**

```bash
WORKER=https://nctx.<your-subdomain>.workers.dev
SECRET=<your-shared-secret>
INSTALL=$(uuidgen | tr '[:upper:]' '[:lower:]')

# Save a test context
curl -X POST "$WORKER/contexts" \
  -H "x-nctx-secret: $SECRET" \
  -H "x-nctx-install-id: $INSTALL" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test memory from NCtx",
    "summary": "Verifying Worker proxy + Nia Context Sharing API are wired up correctly end to end",
    "content": "This is a longer body with at least fifty characters of content so it passes Nia validation.",
    "agent_source": "claude-code",
    "tags": ["test", "project:nctx-self"],
    "memory_type": "fact"
  }'

# Search for it
curl -G "$WORKER/contexts/semantic-search" \
  -H "x-nctx-secret: $SECRET" \
  -H "x-nctx-install-id: $INSTALL" \
  --data-urlencode "q=NCtx wiring test"
```

### 7.7 MCP server registration

**Documentation:** https://code.claude.com/docs/en/mcp

NCtx ships an MCP server that Claude Code launches as a subprocess. Registration during `nctx init`:

```bash
# Approach 1: claude CLI
claude mcp add-json "nctx" '{"command":"npx","args":["-y","@yourname/nctx","mcp"]}'

# Approach 2: manual edit of ~/.claude.json or .mcp.json
```

**Manual `.mcp.json` (project-scoped) format:**

```json
{
  "mcpServers": {
    "nctx": {
      "command": "npx",
      "args": ["-y", "@yourname/nctx", "mcp"]
    }
  }
}
```

The MCP server uses the official `@modelcontextprotocol/sdk` TypeScript SDK. Skeleton:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "nctx", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "nctx_memory",
    description: "Search past session memories for this project. Use when the user references prior work, asks 'where did we leave off', or when context from past sessions would help answer accurately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language description of what to find" },
        limit: { type: "number", default: 5 }
      },
      required: ["query"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "nctx_memory") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  const { query, limit = 5 } = req.params.arguments as { query: string; limit?: number };

  // Read .nctx/config.json from cwd, instantiate NiaClient, call search
  const config = loadConfig();
  const client = makeClient(config);
  const results = await client.searchContexts(query, limit, `project:${config.project_name}`);

  return {
    content: [{
      type: "text",
      text: formatResults(results)
    }]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 7.8 NPM package structure

```
@yourname/nctx/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
├── LICENSE
├── src/
│   ├── cli/
│   │   ├── index.ts              # main CLI entry, sub-command dispatch
│   │   ├── init.ts
│   │   ├── capture.ts
│   │   ├── doctor.ts
│   │   ├── list.ts
│   │   ├── view.ts
│   │   ├── reindex.ts
│   │   └── uninstall.ts
│   ├── mcp/
│   │   └── server.ts             # MCP server (run by `nctx mcp`)
│   ├── nia/
│   │   ├── client.ts             # NiaClient interface
│   │   ├── hosted.ts             # HostedNiaClient (proxy)
│   │   └── direct.ts             # DirectNiaClient (BYOK)
│   ├── capture/
│   │   ├── transcript.ts         # JSONL parsing, incremental delta
│   │   ├── extract.ts            # claude -p invocation
│   │   ├── prompt.ts             # extraction prompt + schema constants
│   │   └── render.ts             # JSON → markdown frontmatter
│   ├── config/
│   │   ├── load.ts               # read .nctx/config.json
│   │   ├── hooks.ts              # idempotent merge with .claude/settings.json
│   │   └── mcp-register.ts       # call `claude mcp add-json` or merge .mcp.json
│   └── lib/
│       ├── log.ts                # write to .nctx/errors.log
│       ├── lock.ts               # simple file lock for concurrent sessions
│       └── pending.ts            # queue + drain failed pushes
└── worker/
    ├── package.json
    ├── wrangler.toml
    ├── tsconfig.json
    └── src/
        └── index.ts              # the Worker code shown in 7.6
```

### 7.9 `package.json` template (root)

```json
{
  "name": "@yourname/nctx",
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
    "@modelcontextprotocol/sdk": "^1.0.0",
    "yaml": "^2.6.0",
    "yargs": "^17.7.2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

### 7.10 End-to-end walkthrough (what success looks like)

**Scenario:** Fresh install on Aletheia project, run a session, recall in a future session.

```bash
# Day 1, 2:00 PM — Install
$ cd ~/projects/aletheia
$ npx @yourname/nctx init
[interactive output as in section 4.1]

# Day 1, 2:05 PM — Use Claude Code normally
$ claude
> Help me make the Stripe webhook handler idempotent
... [user works for 30 minutes, makes decisions, hits a bug, fixes it]
> /exit

# Behind the scenes (within 10s of /exit):
# 1. Stop hook fires, runs `npx @yourname/nctx capture --trigger=stop`
# 2. Hook reads transcript_path from stdin
# 3. Reads ~/.claude/projects/-Users-arjun-projects-aletheia/<sid>.jsonl
# 4. Filters to user/assistant text (drops tool noise) → ~3K token transcript
# 5. Pipes transcript to `claude -p ... --output-format json --json-schema ...`
# 6. claude -p returns structured JSON within ~5s
# 7. Renders to markdown, writes .nctx/memories/2026-05-04T14-32-stripe-webhook.md
# 8. POSTs to https://nctx.<sub>.workers.dev/contexts → Worker → Nia
# 9. Nia returns ctx_abc123, frontmatter updated with context_id
# 10. .nctx/last_session.txt updated to <sid>:42 (last line processed)

$ ls .nctx/memories/
2026-05-04T14-32-00-stripe-webhook-idempotency.md

$ cat .nctx/memories/2026-05-04T14-32-00-stripe-webhook-idempotency.md
[as in section 6.1]

# Day 3 — New session, recall past work
$ cd ~/projects/aletheia
$ claude
> Where did we leave off on Stripe?

# Claude calls nctx_memory tool:
#   nctx_memory({ query: "Stripe webhook current state and next steps" })
# MCP server (running as subprocess of CC):
#   1. Reads .nctx/config.json
#   2. GET https://nctx.<sub>.workers.dev/contexts/semantic-search?q=...
#   3. Filters results to tags containing "project:aletheia"
#   4. Formats top 3 results as text excerpts
# Claude responds:
"Based on past sessions: On May 4 you implemented idempotent webhook handling
using Redis dedup keyed on Stripe event IDs (src/api/stripe/webhook.ts). You
also discovered Stripe sends events out of order under load and switched to
timestamp-based reconciliation. Currently in progress: webhook signature
rotation handling. Next step was failure-mode tests for retry exhaustion."
```

If that final response works, **the product is done**. Everything else is polish.

---

## 8. Components — quick reference (full detail in Reference section above)

| Component | Role |
|---|---|
| `nctx init` | Set up `.nctx/`, generate install ID, register hooks + MCP, verify connectivity |
| `nctx capture` | Run by hooks. Read transcript, extract via `claude -p`, write local md, push to Nia |
| `nctx mcp` | MCP server run by Claude Code. Exposes `nctx_memory` tool |
| `nctx doctor` | Verify config, hooks, MCP registration, network |
| `nctx list` / `view` | Browse local memories |
| `nctx reindex` | Re-push all local memories (for recovery or initial bootstrap) |
| `nctx uninstall` | Reverse `init` cleanly |
| `worker/` | Cloudflare Worker proxy (hosted mode only) |

---

## 9. Phases with explicit acceptance tests

### Phase 0 — Foundations

**Tasks:**
- npm package skeleton (use `tsup` to bundle; CLI entry at `dist/cli/index.js` with shebang)
- Cloudflare account + `wrangler` CLI installed and logged in
- `wrangler kv namespace create USAGE` — copy ID into `wrangler.toml`
- Read this PRD's Reference section end-to-end before writing code

**Acceptance tests:**
1. `npx tsx src/cli/index.ts --version` prints version (CLI loads without error)
2. `claude -p "say hi" --output-format json --bare-no` returns `{"result":"hi", ...}` (or similar)
3. `curl https://apigcp.trynia.ai/v2/contexts -H "Authorization: Bearer <enterprise_key>" -d '{...minimal valid body...}'` returns 200 with a context ID
4. `wrangler whoami` shows you logged in

---

### Phase 1 — Capture pipeline (local files only)

**Tasks:**
- Implement `src/capture/transcript.ts` — read JSONL, parse, filter to user/assistant text, return string
- Implement `src/capture/extract.ts` — spawn `claude -p` with prompt + schema, parse JSON output
- Implement `src/capture/render.ts` — JSON → markdown with frontmatter
- Implement `src/cli/capture.ts` — orchestrates: read stdin hook input → read transcript → extract → render → write file
- Hook into `Stop` and `PreCompact` via temporary local registration

**Acceptance tests:**
1. **Manual run:** `echo '{"session_id":"sid","transcript_path":"/path/to/sample.jsonl","cwd":"/tmp/test","hook_event_name":"Stop"}' | nctx capture --trigger=stop` produces a markdown file in `/tmp/test/.nctx/memories/`
2. **End-to-end:** Have a real CC session in a test project (with hooks registered manually). After /exit, a memory file appears in `.nctx/memories/` within 15 seconds
3. **Quality gate:** Read three resulting memory files. Each contains at least one specific, actionable, non-generic statement. If not — STOP and iterate the extraction prompt before continuing

**This is the most important phase. The product cannot succeed if extraction produces noise. Spend the most time here.**

---

### Phase 2 — Cloudflare Worker

**Tasks:**
- `worker/src/index.ts` per section 7.6
- `wrangler.toml`, secrets configured, KV bound
- Deploy via `wrangler deploy`

**Acceptance tests:**
1. `curl -X POST $WORKER/contexts` (with valid headers + body) returns 200 with Nia's response body
2. `curl -X POST $WORKER/contexts` without `x-nctx-secret` returns 401
3. `curl -X POST $WORKER/contexts` with secret but bad install ID returns 400
4. `curl -X POST $WORKER/contexts/something-not-allowed` returns 404
5. Set `PER_INSTALL_DAILY_CAP=3`, redeploy, fire 4 requests with same install ID — 4th returns 429
6. Search just-saved context: `curl -G $WORKER/contexts/semantic-search --data-urlencode "q=..."` returns it

---

### Phase 3 — Nia integration in NCtx

**Tasks:**
- `src/nia/client.ts` — abstract interface (`saveContext`, `searchContexts`)
- `src/nia/hosted.ts` — adds `x-nctx-secret` and `x-nctx-install-id` headers, hits Worker URL
- `src/nia/direct.ts` — adds `Authorization: Bearer <key>`, hits Nia directly
- Factory function: `makeClient(config)` returns the right one based on `config.mode`
- `src/cli/init.ts` — interactive setup
- Capture pipeline: after writing local md, call `client.saveContext(...)`, store returned `id` in frontmatter
- Pending queue: if save fails, write to `.nctx/pending/<filename>.json`; drain on next successful save

**Acceptance tests:**
1. `nctx init` (hosted mode) creates valid `.nctx/config.json`, registers hooks, prints success
2. After init, run a session — memory file appears AND has `context_id` populated in frontmatter
3. Same context appears in your enterprise Nia account (verify via `curl` with enterprise key)
4. `nctx init --byok` with a test Nia key works analogously, context appears in that test account
5. With Worker URL temporarily wrong, capture fails gracefully, memory file still written, pending queue contains the failed push, errors.log updated, **CC session not blocked**

---

### Phase 4 — MCP server + retrieval

**Tasks:**
- `src/mcp/server.ts` per section 7.7
- Add MCP registration to `nctx init` (idempotent)
- Tool returns formatted text excerpts: title, summary, date, top tags, file paths

**Acceptance tests:**
1. `nctx mcp` (run manually) starts and accepts MCP protocol on stdio
2. After `nctx init`, `claude mcp list` shows `nctx`
3. In a fresh CC session in a project with prior memories, ask "where did we leave off on X?" — Claude calls `nctx_memory` and uses the result in its answer
4. Retrieval respects project scope: memories from a different project don't leak in

---

### Phase 5 — Packaging & polish

**Tasks:**
- Publish `@yourname/nctx` to npm (build via `tsup`, includes `dist/`)
- Implement `nctx doctor`: checks config validity, hooks present, MCP registered, Worker reachable (or Nia reachable in BYOK)
- Implement `nctx list` and `nctx view <id>`
- Implement `nctx uninstall` — removes hooks entries, MCP entry, optionally `.nctx/`
- Write README with: 30-second pitch, animated GIF, install command, hosted-vs-BYOK explanation, transparency about the proxy storing nothing, link to source
- Add `LICENSE` (MIT) and `worker/README.md` (deploy instructions for self-hosters)

**Acceptance tests:**
1. Stranger can `npx @yourname/nctx init` and reach a working install without consulting anything beyond the README
2. `nctx doctor` correctly detects: missing config, missing hooks, missing MCP entry, Worker unreachable
3. `nctx uninstall` removes all NCtx artifacts cleanly; CC session afterward shows no NCtx hooks/MCP

---

### Phase 6 — Pitch artifact

**Tasks:**
- Record 60-second Loom: install → CC session → recall in next session
- Capture the A/B comparison: same query against (a) raw session JSONL pushed to Nia as a folder source, (b) NCtx-extracted memories. Screenshot the delta in result quality
- Write 1-paragraph DM to Arlan @ Nozomio: link to npm, link to Loom, framing as Nia-complementary

**Acceptance tests:**
1. Loom is under 90 seconds
2. The A/B comparison is visually clear that extraction adds signal
3. Worker analytics show real Nia API traffic from your test installs

---

## 10. Open questions to resolve in Phase 0

1. **Does `claude -p` (without `--bare`) work from inside a hook subshell?** The hook runs in the user's environment with their auth available. `claude -p` should pick up the same OAuth/keychain credentials. **Test:** trivial echo hook that runs `claude -p "say hi" --output-format json` and writes the result to a file. Trigger it with a real session, check the file. If it fails with auth errors, the fallback is to require `ANTHROPIC_API_KEY` env var (still BYOK-friendly since user already has CC working).

2. **Does Nia's semantic search support filtering by exact tag match?** The endpoint accepts `workspace_filter` but not `tag_filter`. NCtx will filter client-side initially. If retrieval pollution becomes a problem with many projects, contact Nia about adding tag filters or use `metadata` field for scoping.

3. **What does CC do when multiple `Stop` hooks fire concurrently** (e.g., user runs two sessions in same project)? Concurrent file writes to `.nctx/memories/` are fine (filenames are timestamped + unique). The race is on `.nctx/last_session.txt`. **Solution:** track per-session pointers — `.nctx/sessions/<sid>.pos` — instead of a global pointer.

4. **How big do real session transcripts get?** Likely 5K–50K tokens of user/assistant text after stripping tool noise. Haiku 4.5 has 200K context, fine. If a session is genuinely massive, truncate to last 30K tokens.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Extraction prompt produces low-quality memories | **Phase 1 quality gate is non-negotiable.** Iterate prompt until output passes gut-check before advancing |
| Nia API changes break integration | All Nia calls isolated in `src/nia/`. Pin to v2. Worker allowlist easy to update |
| `claude -p` slow / blocks session end | `async: true` on hooks. 60s timeout in capture. Hook always exits 0 |
| User runs `init` twice | All config writes idempotent (read → merge → write) |
| Memory files leak sensitive code | README recommends `.nctx/` in `.gitignore`. Optional: `nctx init` adds it automatically |
| Shared secret leaked from npm package | Per-install rate limit + global cap make abuse economically unattractive. Ban-by-install-ID via KV. Rotate secret in minor version if needed |
| Worker abused at scale | Cloudflare DDoS protection + rate limits. Monitor analytics. Cap costs Worker can incur |
| Cloudflare Worker outage | Pending queue retries on next successful call. User session never blocked |
| 3-month enterprise window expires | Default flips to BYOK. Existing hosted users get migration prompt. No code changes — just config |
| Nia rate-limits enterprise key globally | Worker's global cap prevents this. If hit, hosted users degrade to queued writes; ship hotfix flipping default to BYOK |

---

## 12. Success criteria

**Technical:**
- Hosted-mode install to first retrieval: under 60 seconds for a new user
- Capture latency: under 10 seconds, non-blocking
- Retrieval latency: under 2 seconds end-to-end
- Worker uptime tracks Cloudflare's
- Zero infrastructure cost during beta (Cloudflare free tier)

**Strategic:**
- Working artifact DM-able to Arlan in a single message
- A/B comparison visibly shows extraction adds signal
- Worker analytics show real Nia API traffic
- Pitch frames NCtx as Nia-complementary
- 3-month window converts to: (a) Nozomio partnership conversation, (b) sustained BYOK userbase, or (c) clean shutdown — all acceptable

---

## 13. What "done" looks like for the 3-hour build

Realistic scope: Phases 0 → 4 with a rough README. Polish (Phase 5) and pitch artifact (Phase 6) likely slip to a second session.

| Phase | Time | Outcome |
|---|---|---|
| 0 | 30 min | Skeletons in place, all three external systems verified working |
| 1 | 75 min | Capture pipeline producing good memory files locally |
| 2 | 30 min | Worker deployed and curl-tested |
| 3 | 30 min | NCtx talks to Worker; memories appear in Nia |
| 4 | 15 min | MCP retrieval works in a real CC session |

If extraction quality (Phase 1) hasn't passed the gut-check after 75 minutes, **stop, iterate the prompt**, and accept that you may not finish Phase 4 in this session. A working pipeline producing useless memories is worse than nothing. A polished MCP wrapper around great memories is the entire pitch.

---

## 14. External documentation references

| Topic | URL |
|---|---|
| Claude Code overview | https://code.claude.com/docs |
| Claude Code hooks reference | https://code.claude.com/docs/en/hooks |
| Claude Code headless mode | https://code.claude.com/docs/en/headless |
| Claude Code MCP | https://code.claude.com/docs/en/mcp |
| Nia API guide | https://docs.trynia.ai/api-guide |
| Nia Context Sharing — save | https://docs.trynia.ai/api-reference/context-sharing/save-context |
| Nia Context Sharing — search | https://docs.trynia.ai/api-reference/context-sharing/semantic-search-contexts |
| Nia full API index | https://docs.trynia.ai/llms.txt |
| Cloudflare Workers | https://developers.cloudflare.com/workers |
| Cloudflare Workers KV | https://developers.cloudflare.com/kv |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk |
